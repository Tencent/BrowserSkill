//! `bsk diagnostics export` — write a redacted diagnostics bundle for
//! issue reports.
//!
//! The extension's debug page is unreachable for agents (it lives on a
//! `chrome-extension://` URL the Agent Window sandbox refuses to
//! observe), so export what the CLI can see instead: the daemon log
//! tail, daemon status, the `bsk doctor` checks and active sessions.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::json;

use crate::cli::doctor::{self, CheckResult};
use crate::cli::error::CliError;
use crate::cli::logs;
use crate::daemon::probe::{self, Probe};
use crate::daemon::state::PROTOCOL_VERSION;

/// Default number of trailing daemon-log lines to include.
const DEFAULT_LOG_LINES: usize = 500;

/// Hard cap on exported log bytes so a chatty daemon cannot produce an
/// unbounded archive.
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;

/// Keys whose values become `[REDACTED]`. Matched case-insensitively on
/// identifier boundaries, in both JSON (`"token": "…"`) and shell-style
/// (`token=…`) spellings.
const SENSITIVE_KEYS: &[&str] = &[
    "authorization",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "api_key",
    "apikey",
    "secret",
    "password",
    "passwd",
    "cookie",
    "set-cookie",
    "session_secret",
];

/// Credential headers carry one value to the end of the line
/// (`Authorization: Bearer <token>`), not a whitespace-delimited token.
const LINE_VALUE_KEYS: &[&str] = &["authorization"];

const REDACTED: &str = "[REDACTED]";

#[derive(Debug, Clone, clap::Args)]
pub struct DiagnosticsExportArgs {
    /// Write the archive to this path (default `bsk-diagnostics-<unix-ms>.zip`).
    #[arg(long)]
    pub out: Option<PathBuf>,

    /// Number of trailing daemon-log lines to include (default 500).
    #[arg(long, default_value_t = DEFAULT_LOG_LINES)]
    pub log_lines: usize,
}

#[derive(Debug, Clone, clap::Subcommand)]
pub enum DiagnosticsSub {
    /// Export a redacted diagnostics bundle (daemon log, status, doctor).
    Export(DiagnosticsExportArgs),
}

#[derive(Debug, Clone, clap::Args)]
pub struct DiagnosticsCmd {
    #[command(subcommand)]
    pub sub: DiagnosticsSub,
}

pub fn dispatch(cmd: DiagnosticsCmd, json: bool) -> Result<(), CliError> {
    match cmd.sub {
        DiagnosticsSub::Export(args) => {
            let out = export(args).map_err(CliError::Local)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({ "path": out.display().to_string() }))
                        .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
                );
            } else {
                println!("wrote {}", out.display());
            }
            Ok(())
        }
    }
}

/// Everything the bundle contains, gathered from the local machine.
struct Collected {
    doctor: Vec<CheckResult>,
    daemon: Option<serde_json::Value>,
    status: Option<serde_json::Value>,
    sessions: Option<serde_json::Value>,
    log_text: String,
    notes: Vec<String>,
}

fn export(args: DiagnosticsExportArgs) -> Result<PathBuf> {
    let collected = collect(&args);
    let out = args
        .out
        .unwrap_or_else(|| PathBuf::from(format!("bsk-diagnostics-{}.zip", now_ms())));
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
    }
    write_bundle(&collected, &out)?;
    Ok(out)
}

/// Best-effort collection: every source works even when the daemon or
/// log file is absent, and records a note about what is missing.
fn collect(args: &DiagnosticsExportArgs) -> Collected {
    let doctor = doctor::checks().unwrap_or_default();

    let mut notes = Vec::new();
    let (daemon, status, sessions) = match probe::probe(std::time::Duration::from_secs(2)) {
        Ok(Probe::Ready(daemon)) => {
            let status = serde_json::to_value(&daemon.status).ok();
            let sock = daemon.info.sock_path.clone();
            let sessions: Option<serde_json::Value> =
                match crate::cli::business_rpc::call::<(), serde_json::Value>(
                    sock,
                    "diagnostics",
                    bsk_protocol::Method::SessionList,
                    None,
                    std::time::Duration::from_secs(5),
                ) {
                    Ok(value) => Some(value),
                    Err(err) => {
                        notes.push(format!("session list unavailable: {err}"));
                        None
                    }
                };
            (serde_json::to_value(&daemon.info).ok(), status, sessions)
        }
        Ok(Probe::Absent(_)) => {
            notes.push("daemon is not running; start it with `bsk daemon start`".to_string());
            (None, None, None)
        }
        Err(err) => {
            notes.push(format!("daemon probe failed: {err:#}"));
            (None, None, None)
        }
    };

    let (log_text, log_note) = match logs::latest_log_file() {
        Ok(Some(path)) => match tail_log(&path, args.log_lines) {
            Ok(text) => (text, None),
            Err(err) => (String::new(), Some(format!("log read failed: {err:#}"))),
        },
        Ok(None) => (String::new(), Some("no daemon log file found".to_string())),
        Err(err) => (
            String::new(),
            Some(format!("log directory unreadable: {err:#}")),
        ),
    };
    if let Some(note) = log_note {
        notes.push(note);
    }

    Collected {
        doctor,
        daemon,
        status,
        sessions,
        log_text,
        notes,
    }
}

/// Read up to the trailing `lines` lines (or [`MAX_LOG_BYTES`],
/// whichever is smaller) of `path`.
fn tail_log(path: &Path, lines: usize) -> Result<String> {
    let mut file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let len = file.metadata()?.len();
    let want = (MAX_LOG_BYTES + 64 * 1024).min(len);
    file.seek(SeekFrom::Start(len - want))?;
    let mut buf = Vec::new();
    file.take(want).read_to_end(&mut buf)?;
    let text = String::from_utf8_lossy(&buf);
    let mut kept: Vec<&str> = text.lines().collect();
    let start = kept.len().saturating_sub(lines);
    kept.drain(0..start);
    Ok(kept.join("\n"))
}

fn write_bundle(collected: &Collected, out: &Path) -> Result<()> {
    let file = File::create(out).with_context(|| format!("create {}", out.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    let write_json = |zip: &mut zip::ZipWriter<File>, name: &str, value: &serde_json::Value| {
        zip.start_file(name, options)
            .with_context(|| format!("write {name}"))?;
        serde_json::to_writer_pretty(&mut *zip, value).with_context(|| format!("encode {name}"))?;
        zip.write_all(b"\n")?;
        Result::<()>::Ok(())
    };

    write_json(
        &mut zip,
        "metadata.json",
        &json!({
            "bsk_version": env!("CARGO_PKG_VERSION"),
            "protocol_version": PROTOCOL_VERSION,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "generated_at_ms": now_ms(),
        }),
    )?;
    write_json(
        &mut zip,
        "doctor.json",
        &json!({ "checks": collected.doctor }),
    )?;
    write_json(
        &mut zip,
        "status.json",
        &json!({
            "daemon": collected.daemon,
            "status": collected.status,
            "sessions": collected.sessions,
        }),
    )?;
    if !collected.log_text.is_empty() {
        zip.start_file("daemon-log.txt", options)?;
        zip.write_all(redact_text(&collected.log_text).as_bytes())?;
    }

    let mut readme = String::from(
        "# BrowserSkill diagnostics bundle\n\n\
         Collected by `bsk diagnostics export`. Share this file when filing or\n\
         answering a BrowserSkill issue.\n\n\
         Files: `metadata.json` (versions, platform), `doctor.json` (health\n\
         checks with repair hints), `status.json` (daemon info, status and\n\
         active sessions — null when no daemon is running), `daemon-log.txt`\n\
         (trailing log lines).\n",
    );
    if !collected.notes.is_empty() {
        readme.push_str("\nMissing parts:\n");
        for note in &collected.notes {
            readme.push_str(&format!("- {note}\n"));
        }
    }
    readme.push_str(
        "\nRedaction: values of credential keys (token, cookie, authorization,\n\
         password, …) were replaced with `[REDACTED]` before writing this\n\
         bundle. Raw credentials that appear without a key (for example a\n\
         token embedded in a URL) are not covered — review `daemon-log.txt`\n\
         before sharing.\n\
         \n\
         Limitation: the extension's own debug page is behind a\n\
         `chrome-extension://` URL the Agent Window sandbox never observes,\n\
         so it is not part of this bundle. Re-run after reproducing the\n\
         problem so the log covers it.\n",
    );
    zip.start_file("README.md", options)?;
    zip.write_all(readme.as_bytes())?;

    zip.finish().context("finish zip archive")?;
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Replace credential values with `[REDACTED]`, line by line.
///
/// Conservative by design: only known-sensitive keys are touched, so
/// ordinary log lines (URLs, session ids, tab ids) pass through
/// unchanged.
pub(crate) fn redact_text(input: &str) -> String {
    input
        .lines()
        .map(|line| {
            SENSITIVE_KEYS
                .iter()
                .fold(line.to_string(), |line, key| redact_key(&line, key))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Byte span of a sensitive value's *content* starting at or after
/// `start` (surrounding quotes excluded, so JSON stays well-formed).
/// Returns an empty span when no value follows.
fn value_span(text: &str, start: usize) -> (usize, usize) {
    let rest = &text[start..];
    if let Some(after_quote) = rest.strip_prefix('"') {
        return match after_quote.find('"') {
            Some(close) => (start + 1, start + 1 + close),
            None => (start + 1, text.len()),
        };
    }
    let ws = rest
        .find(|c: char| !c.is_whitespace())
        .unwrap_or(rest.len());
    let value_start = start + ws;
    let end = match text[value_start..]
        .find(|c: char| c == ',' || c == ';' || c == '"' || c == '\'' || c.is_whitespace())
    {
        Some(end) => value_start + end,
        None => text.len(),
    };
    (value_start, end)
}

fn redact_key(line: &str, key: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let lower = line.to_ascii_lowercase();
    let mut idx = 0;
    while idx < line.len() {
        let Some(found) = lower[idx..].find(key) else {
            break;
        };
        let key_start = idx + found;
        let key_end = key_start + key.len();
        // Identifier boundaries: a key embedded in a longer word
        // (`secretive`, `set_cookie_v2`) is not a sensitive key.
        let boundary_before = !matches!(
            line.as_bytes().get(key_start.wrapping_sub(1)),
            Some(b) if b.is_ascii_alphanumeric() || *b == b'_'
        );
        let boundary_after = !matches!(
            line.as_bytes().get(key_end),
            Some(b) if b.is_ascii_alphanumeric() || *b == b'_'
        );
        if boundary_before && boundary_after {
            if let Some(rel) = lower[key_end..].find([':', '=']) {
                let (vs, ve) = value_span(line, key_end + rel + 1);
                // Credential headers (`Authorization: Bearer …`) run to
                // the end of the line unless quoted.
                let quoted = line[key_end + rel + 1..].trim_start().starts_with('"');
                let ve = if !quoted && LINE_VALUE_KEYS.contains(&key) {
                    line.len()
                } else {
                    ve
                };
                if ve > vs && !line[vs..ve].contains(REDACTED) {
                    out.push_str(&line[idx..vs]);
                    out.push_str(REDACTED);
                    idx = ve;
                    continue;
                }
            }
        }
        // Not a sensitive hit: copy the key through and keep scanning.
        out.push_str(&line[idx..key_end]);
        idx = key_end;
    }
    out.push_str(&line[idx..]);
    out
}
