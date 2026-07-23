//! `bsk session start|stop|list` — session lifecycle commands (M5).
//!
//! Each subcommand auto-spawns the daemon (via [`ensure_daemon`]) and
//! issues a typed RPC over the JSON-line IPC transport. Output is
//! human-readable by default; pass the global `--json` flag to get
//! structured JSON instead.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::system::{BrowserListParams, BrowserStatusEntry, SessionStatusEntry};
use bsk_protocol::tools::ReturnFailure;
use bsk_protocol::{ErrorCode, Method};
use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};

use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{self, CliError, Format, RenderExtras};
use crate::cli::launch_browser;

const SESSION_STOP_IPC_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// `bsk session …` subcommand tree.
#[derive(Debug, Clone, Args)]
pub struct SessionCmd {
    #[command(subcommand)]
    pub sub: SessionSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum SessionSub {
    /// Start a new session against the (single) connected browser.
    Start(SessionStartArgs),
    /// Stop a single session, or all sessions with `--all`.
    Stop(SessionStopArgs),
    /// List active sessions.
    List,
}

#[derive(Debug, Clone, Args)]
pub struct SessionStartArgs {
    /// Target browser instance id (only required when multiple browsers
    /// are connected).
    #[arg(long)]
    pub browser: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct SessionStopArgs {
    /// Session id to stop (omit when `--all` is set).
    #[arg(value_name = "SESSION_ID")]
    pub session_id: Option<String>,

    /// Stop every active session.
    #[arg(long)]
    pub all: bool,
}

#[derive(Debug, Serialize)]
struct StartParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_instance_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StartReply {
    session_id: String,
    browser_instance_id: String,
    #[serde(default)]
    agent_window_id: Option<i64>,
}

#[derive(Debug, Serialize)]
struct StopParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    all: bool,
}

#[derive(Debug, Deserialize)]
struct StopReply {
    stopped: Vec<String>,
    #[serde(default)]
    failed: Vec<StopFailure>,
    #[serde(default)]
    returned_tab_ids: Vec<i64>,
    #[serde(default)]
    return_failures: Vec<ReturnFailure>,
}

#[derive(Debug, Deserialize, Serialize)]
struct StopFailure {
    session_id: String,
    code: ErrorCode,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ListReply {
    sessions: Vec<SessionStatusEntry>,
}

pub fn dispatch(cmd: SessionCmd, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    match cmd.sub {
        SessionSub::Start(args) => {
            run_skill_sync_for_session_start(format);
            run_start(info.sock_path, args, format)
        }
        SessionSub::Stop(args) => run_stop(info.sock_path, args, format),
        SessionSub::List => run_list(info.sock_path, format),
    }
}

fn run_start(sock: PathBuf, args: SessionStartArgs, format: Format) -> Result<(), CliError> {
    let first: Result<StartReply, CliError> = call(
        sock.clone(),
        Method::SessionStart,
        Some(StartParams {
            browser_instance_id: args.browser.clone(),
        }),
        Duration::from_secs(30),
    );
    let reply = match first {
        Ok(reply) => reply,
        Err(err) => {
            if err.code() == Some(ErrorCode::NoBrowserConnected) {
                // The daemon sees no connected browser. Most often the
                // browser process simply isn't running, so the extension
                // never had a chance to connect. Try to bring it up, wait
                // for the extension to reconnect, then retry once.
                eprintln!(
                    "BrowserSkill: no browser is connected — launching your browser so the extension can connect …"
                );
                match retry_after_launch(sock, &args) {
                    Some(reply) => reply,
                    None => return Err(handle_start_error(err, format)),
                }
            } else {
                return Err(handle_start_error(err, format));
            }
        }
    };
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "session_id": reply.session_id,
                    "browser_instance_id": reply.browser_instance_id,
                    "agent_window_id": reply.agent_window_id,
                }))
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            println!("{}", reply.session_id);
        }
    }
    Ok(())
}

/// On `no_browser_connected`, try to bring the browser process up (so an
/// installed extension can connect), wait for it to appear, then retry
/// `session.start` once. Returns the reply on success, or `None` if the
/// browser could not be launched or the retry still failed — in which case
/// the caller surfaces the usual install hint.
fn retry_after_launch(sock: PathBuf, args: &SessionStartArgs) -> Option<StartReply> {
    if launch_browser::attempt_launch_browser().is_err() {
        return None;
    }
    if !wait_for_browser_connection(&sock) {
        return None;
    }
    call::<_, StartReply>(
        sock,
        Method::SessionStart,
        Some(StartParams {
            browser_instance_id: args.browser.clone(),
        }),
        Duration::from_secs(30),
    )
    .ok()
}

/// Reply shape for `browser.list` (mirrors the daemon's private
/// `BrowserListResult`); only the `browsers` field is needed here.
#[derive(Debug, Deserialize)]
struct BrowserListReply {
    browsers: Vec<BrowserStatusEntry>,
}

/// Block (via the daemon's browser-list wait) until a browser connects, or
/// the launch wait window elapses.
fn wait_for_browser_connection(sock: &Path) -> bool {
    let wait = launch_browser::POST_LAUNCH_CONNECT_WAIT;
    let params = BrowserListParams {
        wait_for_browser_ms: Some(wait.as_millis() as u64),
    };
    let timeout = wait + Duration::from_secs(5);
    match call::<_, BrowserListReply>(
        sock.to_path_buf(),
        Method::BrowserList,
        Some(params),
        timeout,
    ) {
        Ok(result) => !result.browsers.is_empty(),
        Err(_) => false,
    }
}

/// Render a `session.start` failure (review I3).
///
/// The previous implementation hand-rolled `eprintln!("error: ...")`
/// plus a self-written hint and returned [`CliError::Rendered`] so
/// the centralised renderer would skip those errors entirely — which
/// is the very thing review I3 flagged as breaking the "single source
/// of truth" property of `render_error`.
///
/// Now we always go through [`error::render_with_extras`] so the
/// summary, hint, exit code, and `details:` line all come from the
/// central table; we only contribute the structured "extras section"
/// (the connected-browsers table for `multiple_browsers_online`, the
/// candidate `instance_ids` bullet list for `invalid_params`
/// ambiguous-label) via the [`RenderExtras`] hook. In `--json` mode
/// the structured payload still rides inside `error.data` so script
/// consumers can read it without parsing prose.
fn handle_start_error(err: CliError, format: Format) -> CliError {
    if matches!(format, Format::Json) {
        return err;
    }
    let CliError::Rpc { code, message, .. } = &err else {
        return err;
    };
    let extras = StartExtras::new(&err);
    let _ = error::render_with_extras(&err, format, Some(&extras));
    CliError::Rendered {
        code: *code,
        message: message.clone(),
    }
}

/// [`RenderExtras`] adapter that turns a `session.start` `CliError`
/// into the structured "extras section" for human-mode rendering. No
/// summary / hint logic lives here — those come from the centralised
/// `render_error` table (review I3).
pub(crate) struct StartExtras<'a> {
    err: &'a CliError,
}

impl<'a> StartExtras<'a> {
    pub(crate) fn new(err: &'a CliError) -> Self {
        Self { err }
    }
}

impl RenderExtras for StartExtras<'_> {
    fn write_extras(&self, out: &mut dyn std::io::Write) -> std::io::Result<()> {
        let CliError::Rpc { code, data, .. } = self.err else {
            return Ok(());
        };
        match code {
            ErrorCode::MultipleBrowsersOnline => {
                let browsers = parse_browsers_data(data.as_ref());
                if browsers.is_empty() {
                    return Ok(());
                }
                writeln!(out, "connected browsers:")?;
                write_browser_table(out, &browsers)
            }
            ErrorCode::InvalidParams => {
                let Some(data) = data.as_ref() else {
                    return Ok(());
                };
                let Some(label) = data.get("label").and_then(|v| v.as_str()) else {
                    return Ok(());
                };
                let Some(ids) = data.get("instance_ids").and_then(|v| v.as_array()) else {
                    return Ok(());
                };
                writeln!(out, "label \"{label}\" matches multiple online browsers:")?;
                for id in ids.iter().filter_map(|v| v.as_str()) {
                    writeln!(out, "  - {id}")?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

fn parse_browsers_data(value: Option<&serde_json::Value>) -> Vec<BrowserStatusEntry> {
    let Some(v) = value else {
        return Vec::new();
    };
    let Some(arr) = v.get("browsers").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| serde_json::from_value::<BrowserStatusEntry>(item.clone()).ok())
        .collect()
}

fn write_browser_table(
    out: &mut dyn std::io::Write,
    browsers: &[BrowserStatusEntry],
) -> std::io::Result<()> {
    let rows: Vec<[String; 4]> = browsers
        .iter()
        .map(|b| {
            [
                b.instance_id.clone(),
                format!("{} {}", b.browser_name, b.browser_version),
                if b.label.is_empty() {
                    "-".into()
                } else {
                    b.label.clone()
                },
                b.session_count.to_string(),
            ]
        })
        .collect();
    let headers = ["INSTANCE", "BROWSER", "LABEL", "SESSIONS"];
    let widths: [usize; 4] = std::array::from_fn(|i| {
        rows.iter()
            .map(|r| r[i].len())
            .max()
            .unwrap_or(0)
            .max(headers[i].len())
    });
    writeln!(
        out,
        "  {:<w0$}  {:<w1$}  {:<w2$}  {}",
        headers[0],
        headers[1],
        headers[2],
        headers[3],
        w0 = widths[0],
        w1 = widths[1],
        w2 = widths[2],
    )?;
    for r in &rows {
        writeln!(
            out,
            "  {:<w0$}  {:<w1$}  {:<w2$}  {}",
            r[0],
            r[1],
            r[2],
            r[3],
            w0 = widths[0],
            w1 = widths[1],
            w2 = widths[2],
        )?;
    }
    Ok(())
}

fn run_stop(sock: PathBuf, args: SessionStopArgs, format: Format) -> Result<(), CliError> {
    if !args.all && args.session_id.is_none() {
        return Err(CliError::Local(anyhow::anyhow!(
            "session stop requires SESSION_ID or --all"
        )));
    }
    let reply: StopReply = call(
        sock,
        Method::SessionStop,
        Some(StopParams {
            session_id: args.session_id,
            all: args.all,
        }),
        SESSION_STOP_IPC_TIMEOUT,
    )?;
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "stopped": reply.stopped,
                    "failed": reply.failed,
                    "returned_tab_ids": reply.returned_tab_ids,
                    "return_failures": reply.return_failures,
                }))
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            for id in &reply.stopped {
                println!("stopped {id}");
            }
            if !reply.returned_tab_ids.is_empty() {
                println!("returned borrowed tabs: {:?}", reply.returned_tab_ids);
            }
            for failure in &reply.return_failures {
                eprintln!(
                    "failed to return borrowed tab {}: {:?} - {}",
                    failure.tab_id, failure.code, failure.message
                );
            }
            for failure in &reply.failed {
                eprintln!(
                    "failed to stop {}: {:?} - {}",
                    failure.session_id, failure.code, failure.message
                );
            }
        }
    }
    if !reply.failed.is_empty() {
        let code = reply
            .failed
            .first()
            .map(|failure| failure.code)
            .unwrap_or(ErrorCode::ProtocolError);
        return Err(CliError::Rendered {
            code,
            message: format!("failed to stop {} session(s)", reply.failed.len()),
        });
    }
    Ok(())
}

fn run_list(sock: PathBuf, format: Format) -> Result<(), CliError> {
    let reply: ListReply = call::<(), _>(sock, Method::SessionList, None, Duration::from_secs(5))?;
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply.sessions)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            if reply.sessions.is_empty() {
                println!("(no active sessions)");
                return Ok(());
            }
            let headers = ("SESSION", "BROWSER", "AGENT WINDOW");
            let session_w = reply
                .sessions
                .iter()
                .map(|s| s.session_id.len())
                .max()
                .unwrap_or(0)
                .max(headers.0.len());
            let browser_w = reply
                .sessions
                .iter()
                .map(|s| s.browser_instance_id.len())
                .max()
                .unwrap_or(0)
                .max(headers.1.len());
            println!(
                "{:<session_w$}  {:<browser_w$}  {}",
                headers.0, headers.1, headers.2,
            );
            for s in &reply.sessions {
                let window = s
                    .agent_window_id
                    .map(|w| w.to_string())
                    .unwrap_or_else(|| "-".into());
                println!(
                    "{:<session_w$}  {:<browser_w$}  {}",
                    s.session_id, s.browser_instance_id, window,
                );
            }
        }
    }
    Ok(())
}

fn call<P, R>(
    sock: PathBuf,
    method: Method,
    params: Option<P>,
    timeout: Duration,
) -> Result<R, CliError>
where
    P: serde::Serialize + Send + 'static,
    R: serde::de::DeserializeOwned + Send + 'static,
{
    crate::cli::business_rpc::call::<P, R>(sock, "session", method, params, timeout)
}

/// Best-effort: bring installed agent skills up to date with the
/// bundled `SKILL.md`. Runs on every `bsk session start` because that
/// is the user's main "I'm about to use browser-skill" entry point.
///
/// Errors are logged via `tracing::warn!` and never block the session.
/// Per-harness `up_to_date` outcomes intentionally produce no output.
/// In `Format::Json` mode the user-facing `≈ skill updated …` line is
/// suppressed to keep stderr machine-quiet for harnesses parsing it.
fn run_skill_sync_for_session_start(format: Format) {
    let home = match crate::skill_install::harness::home_dir() {
        Ok(home) => home,
        Err(err) => {
            tracing::warn!(error = %err, "skill sync skipped: cannot resolve $HOME");
            return;
        }
    };
    let report = crate::skill_install::sync::sync_installed_skills(&home);
    if matches!(format, Format::Human) {
        for harness in &report.updated {
            eprintln!("≈ skill updated for {}", harness.cli_name());
        }
    }
    for (harness, msg) in &report.errors {
        tracing::warn!(harness = harness.cli_name(), error = %msg, "skill sync failed");
    }
}

#[cfg(test)]
mod i3_tests {
    use super::*;
    use crate::cli::error::render_human_to_string;
    use bsk_protocol::RpcError;

    /// Review I3 contract: the centralised `summary:` and `hint:` lines
    /// come from `render_error::info_for(MultipleBrowsersOnline)` and
    /// only the structured browsers table is rendered by the
    /// `StartExtras` hook.
    #[test]
    fn multiple_browsers_extras_render_table_between_summary_and_hint() {
        let data = serde_json::json!({
            "browsers": [
                {
                    "instance_id": "alpha",
                    "browser_name": "chrome",
                    "browser_version": "131",
                    "extension_version": "0.1.0-dev.0",
                    "label": "Personal",
                    "session_count": 0_u32,
                    "connected_at_ms": 1_i64,
                    "version_skew": false,
                },
                {
                    "instance_id": "beta",
                    "browser_name": "edge",
                    "browser_version": "130",
                    "extension_version": "0.1.0-dev.0",
                    "label": "",
                    "session_count": 1_u32,
                    "connected_at_ms": 2_i64,
                    "version_skew": false,
                },
            ]
        });
        let cli = CliError::from_rpc(RpcError {
            code: ErrorCode::MultipleBrowsersOnline,
            message: "more than one browser is online".into(),
            data: Some(data),
        });
        let extras = StartExtras::new(&cli);
        let stderr = render_human_to_string(&cli, Some(&extras));
        // Order assertions: `error:` (centralised summary), then the
        // browsers table (caller extras), then `hint:` (centralised),
        // then `details:` (raw daemon message).
        let summary_idx = stderr
            .find("error:")
            .expect("centralised summary line missing");
        let table_idx = stderr
            .find("connected browsers:")
            .expect("extras section missing");
        let alpha_idx = stderr
            .find("alpha")
            .expect("alpha row must appear in the extras table");
        let hint_idx = stderr.find("hint:").expect("centralised hint missing");
        assert!(
            summary_idx < table_idx && table_idx < alpha_idx && alpha_idx < hint_idx,
            "stderr order must be summary → extras → hint, got:\n{stderr}"
        );
        // The summary text comes from the centralised `render_error`
        // table (now in English), not the daemon's raw message.
        assert!(
            stderr.contains("error: multiple browsers are online"),
            "centralised summary missing: {stderr}"
        );
        // The extras table includes both browsers.
        assert!(stderr.contains("alpha"));
        assert!(stderr.contains("beta"));
        assert!(stderr.contains("INSTANCE"));
        // Centralised hint advertises `--browser <instance_id-or-label>`.
        assert!(stderr.contains("--browser <instance_id-or-label>"));
        // The raw daemon message lives on a `details:` line.
        assert!(stderr.contains("details: more than one browser is online"));
    }

    /// Review I3: ambiguous-label `invalid_params` errors render the
    /// candidate `instance_id` bullet list in the extras section,
    /// while the centralised summary/hint still come from the
    /// `render_error` table.
    #[test]
    fn ambiguous_label_extras_render_instance_ids_between_summary_and_hint() {
        let data = serde_json::json!({
            "label": "Personal",
            "instance_ids": ["alpha", "beta"],
        });
        let cli = CliError::from_rpc(RpcError {
            code: ErrorCode::InvalidParams,
            message: "label 'Personal' matches 2 connected browsers".into(),
            data: Some(data),
        });
        let extras = StartExtras::new(&cli);
        let stderr = render_human_to_string(&cli, Some(&extras));
        assert!(stderr.contains("error: invalid command parameters"));
        assert!(
            stderr.contains("label \"Personal\" matches multiple online browsers:"),
            "extras must list candidate matches"
        );
        assert!(stderr.contains("- alpha"));
        assert!(stderr.contains("- beta"));
        assert!(stderr.contains("hint: check your command arguments"));
    }

    /// Errors that don't carry structured data still flow through the
    /// centralised renderer; the extras hook just emits nothing.
    #[test]
    fn extras_emit_nothing_for_codes_without_structured_data() {
        let cli = CliError::from_rpc(RpcError {
            code: ErrorCode::NotFound,
            message: "requested browser is not connected".into(),
            data: None,
        });
        let extras = StartExtras::new(&cli);
        let stderr = render_human_to_string(&cli, Some(&extras));
        assert!(stderr.contains("error: requested resource does not exist"));
        assert!(!stderr.contains("connected browsers:"));
        assert!(!stderr.contains("matches multiple online browsers"));
        assert!(stderr.contains("hint:"));
        assert!(stderr.contains("details: requested browser is not connected"));
    }
}
