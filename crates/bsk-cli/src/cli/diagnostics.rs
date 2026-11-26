//! Read-only CLI/daemon diagnostics. All ZIP entries pass through `write_entry`.

mod redact;

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::Subcommand;
use serde_json::{Value, json};
use zip::{ZipWriter, write::SimpleFileOptions};

use super::error::{CliError, Format};
use super::{atomic_output, doctor, logs};
use crate::daemon::{start::is_daily_daemon_log_name, state::PROTOCOL_VERSION};

const LOG_BYTES: usize = 4 * 1024 * 1024;
const LOG_LINES: usize = 500;
const OUTPUT_HINT: &str = "choose a new --output filename in an existing writable directory";

#[derive(Debug, Subcommand)]
pub enum DiagnosticsCmd {
    /// Write a redacted diagnostics ZIP without starting or repairing BrowserSkill.
    Export {
        /// Path to a new file in an existing directory.
        #[arg(long, value_name = "FILE")]
        output: PathBuf,
    },
}

pub fn dispatch(cmd: DiagnosticsCmd, format: Format) -> Result<(), CliError> {
    let DiagnosticsCmd::Export { output } = cmd;
    atomic_output::preflight_destination_with_hint(&output, OUTPUT_HINT)?;
    let bytes = export(&output).map_err(|err| CliError::file_validation(err, OUTPUT_HINT))?;
    match format {
        Format::Human => println!("Wrote {} ({bytes} bytes)", output.display()),
        Format::Json => println!(
            "{}",
            json!({"path": output.to_string_lossy(), "bytes": bytes})
        ),
    }
    Ok(())
}

fn export(output: &Path) -> Result<u64> {
    // Reject even a dangling symlink before probing the daemon. The final
    // no-clobber persist also protects against a concurrent writer.
    match output.symlink_metadata() {
        Ok(_) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("output already exists: {}", output.display()),
            )
            .into());
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(err).with_context(|| format!("inspect output {}", output.display()));
        }
    }
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temp =
        tempfile::NamedTempFile::new_in(parent).context("create temporary diagnostics ZIP")?;
    let mut bundle = Bundle {
        zip: ZipWriter::new(temp),
        redactor: redact::Redactor::default(),
    };
    let (checks, status) = doctor::passive_snapshot();
    let mut notes = String::from(
        "BrowserSkill CLI and daemon diagnostics\nSession summaries and logs cover the whole daemon. Review before sharing.\n",
    );
    let metadata = json!({
        "cli_version": env!("CARGO_PKG_VERSION"),
        "protocol_version": PROTOCOL_VERSION,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "collected_at_epoch_secs": super::update::now_epoch_secs(),
    });
    bundle.write_entry("metadata.json", Entry::Json(metadata))?;
    bundle.write_entry("doctor.json", Entry::Json(serde_json::to_value(checks)?))?;
    if status.is_none() {
        notes.push_str("status.json: live status and session summaries unavailable. See the daemon running check in doctor.json for the reason.\n");
    }
    bundle.write_entry("status.json", Entry::Json(serde_json::to_value(status)?))?;

    match log_tail() {
        Ok(Some((raw, truncated))) => {
            let shortened = bundle.write_entry("daemon-log.txt", Entry::Log(&raw))?;
            if truncated || shortened {
                notes.push_str("daemon-log.txt: truncated to the latest complete lines within 500 lines and 4 MiB.\n");
            }
        }
        Ok(None) => notes.push_str("daemon-log.txt unavailable: no daemon log file found.\n"),
        Err(err) => notes.push_str(&format!("daemon-log.txt unavailable: {err:#}\n")),
    }
    bundle.write_entry("README.txt", Entry::Text(&notes))?;
    let temp = bundle.zip.finish()?;
    temp.as_file().sync_all().context("sync diagnostics ZIP")?;
    let bytes = temp.as_file().metadata()?.len();
    temp.persist_noclobber(output)
        .map_err(|err| err.error)
        .with_context(|| format!("save diagnostics ZIP to {}", output.display()))?;
    Ok(bytes)
}

enum Entry<'a> {
    Json(Value),
    Text(&'a str),
    Log(&'a str),
}

struct Bundle {
    zip: ZipWriter<tempfile::NamedTempFile>,
    redactor: redact::Redactor,
}

impl Bundle {
    /// Redact before encoding or limiting the output. A partially retained log
    /// line could begin in the middle of a credential, so drop whole lines only.
    fn write_entry(&mut self, name: &str, entry: Entry<'_>) -> Result<bool> {
        let mut truncated = false;
        let content = match entry {
            Entry::Json(mut value) => {
                self.redactor.json(&mut value);
                serde_json::to_string_pretty(&value)?
            }
            Entry::Text(raw) => self.redactor.text(raw),
            Entry::Log(raw) => {
                let mut clean = self.redactor.text(raw);
                if clean.len() > LOG_BYTES {
                    let boundary = clean.len() - LOG_BYTES;
                    let start = after_newline(clean.as_bytes(), boundary - 1);
                    clean.drain(..start);
                    truncated = true;
                }
                clean
            }
        };
        self.zip.start_file(name, SimpleFileOptions::default())?;
        self.zip.write_all(content.as_bytes())?;
        Ok(truncated)
    }
}

/// Read one bounded snapshot of the newest regular daemon log. An appended
/// record belongs to a later export. Inspect one byte before the window to
/// distinguish an exact line boundary from a partial first line.
fn log_tail() -> Result<Option<(String, bool)>> {
    let Some(path) =
        logs::latest_matching_log(|name| name == "daemon.log" || is_daily_daemon_log_name(name))?
    else {
        return Ok(None);
    };
    let mut file = File::open(&path).with_context(|| format!("open {}", path.display()))?;
    let len = file.seek(SeekFrom::End(0))?;
    let size = len.min(LOG_BYTES as u64 + 1);
    file.seek(SeekFrom::Start(len - size))?;
    let mut bytes = vec![0; size as usize];
    file.read_exact(&mut bytes)
        .with_context(|| format!("read {}", path.display()))?;
    let mut truncated = bytes.len() > LOG_BYTES;
    let start = if truncated {
        after_newline(&bytes, 0)
    } else {
        0
    };
    let text = String::from_utf8_lossy(&bytes[start..]);
    let keep: usize = text
        .split_inclusive('\n')
        .rev()
        .take(LOG_LINES)
        .map(str::len)
        .sum();
    truncated |= keep < text.len();
    let mut tail = &text[text.len() - keep..];
    // At a cutoff, indented lines may continue a credential header whose
    // name is in the omitted prefix.
    while truncated && tail.starts_with([' ', '\t']) {
        tail = &tail[after_newline(tail.as_bytes(), 0)..];
    }
    Ok(Some((tail.to_owned(), truncated)))
}

fn after_newline(bytes: &[u8], from: usize) -> usize {
    bytes[from..]
        .iter()
        .position(|&b| b == b'\n')
        .map_or(bytes.len(), |i| from + i + 1)
}
