//! `bsk session start|stop|list` — session lifecycle commands (M5).
//!
//! Each subcommand auto-spawns the daemon (via [`ensure_daemon`]) and
//! issues a typed RPC over the JSON-line IPC transport. Output is
//! human-readable by default; pass the global `--json` flag to get
//! structured JSON instead.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::system::{BrowserStatusEntry, SessionStatusEntry};
use bsk_protocol::tools::ReturnFailure;
use bsk_protocol::{ErrorCode, Method};
use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};

use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{self, CliError, Format, RenderExtras};
use crate::daemon::browsers::EXTENSION_CONNECT_WAIT;

const SESSION_STOP_IPC_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// IPC read budget for `session.start`. The daemon holds this RPC open
/// while it polls for the extension to (re)connect for up to
/// [`EXTENSION_CONNECT_WAIT`], so the CLI-side timeout must exceed that
/// window plus scheduling slack — otherwise the CLI would give up and
/// surface a spurious timeout before the daemon ever answers.
const SESSION_START_IPC_TIMEOUT: Duration =
    EXTENSION_CONNECT_WAIT.saturating_add(Duration::from_secs(10));

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
    /// Inspect, claim, or cancel a recoverable start request.
    Request(SessionRequestArgs),
    /// Renew or release sessions owned by an ephemeral client.
    Lease(SessionLeaseArgs),
}

#[derive(Debug, Clone, Args)]
pub struct SessionStartArgs {
    /// Create session tabs in the last-focused user window (local only).
    #[arg(long, conflicts_with_all = ["width", "height", "current_tab", "tab_id"])]
    pub in_window: bool,
    /// Reuse the active tab in the last-focused normal user window.
    #[arg(long, conflicts_with_all = ["in_window", "tab_id", "width", "height", "no_focus"])]
    pub current_tab: bool,
    /// Reuse a specific existing Chrome tab without moving or closing it.
    #[arg(long, conflicts_with_all = ["in_window", "current_tab", "width", "height", "no_focus"])]
    pub tab_id: Option<i64>,
    /// Deprecated compatibility flag. Automation settings in the extension take precedence.
    #[arg(long)]
    pub unattended: bool,
    /// Recoverable request token: <expiry-unix-ms>:<UUID>. Valid for at most ten minutes.
    #[arg(long)]
    pub request_id: Option<String>,
    /// Optional task name displayed in local operation history.
    #[arg(long)]
    pub name: Option<String>,
    /// Target browser instance ID or unique label. Always set this when
    /// a specific browser profile is required.
    #[arg(long)]
    pub browser: Option<String>,

    /// Agent Window outer width in CSS pixels (100..=7680). Both
    /// `--width` and `--height` must be given to take effect.
    #[arg(long, value_parser = window_size)]
    pub width: Option<u32>,

    /// Agent Window outer height in CSS pixels (100..=7680). Both
    /// `--width` and `--height` must be given to take effect.
    #[arg(long, value_parser = window_size)]
    pub height: Option<u32>,

    /// Start without stealing focus (an inactive tab with --in-window).
    #[arg(long)]
    pub no_focus: bool,

    /// Stop after the owner lease expires (the standalone CLI does not renew it).
    #[arg(long)]
    pub ephemeral: bool,
    /// Stable lifecycle owner token (advanced clients).
    #[arg(long, hide = true)]
    pub owner_id: Option<String>,
    /// Diagnostic owner type shown by `session list`.
    #[arg(long, hide = true)]
    pub owner_kind: Option<String>,
    /// Owner lease duration in milliseconds; also enables ephemeral mode.
    #[arg(long, value_parser = lease_ttl)]
    pub lease_ttl_ms: Option<u64>,
}

/// Parse a `--width` / `--height` Agent Window dimension (CSS pixels).
fn window_size(s: &str) -> Result<u32, String> {
    let value: u32 = s
        .parse()
        .map_err(|_| format!("invalid window dimension {s:?}: expected a positive integer"))?;
    if (100..=7680).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "window dimension {value} out of range (100..=7680)"
        ))
    }
}

fn lease_ttl(s: &str) -> Result<u64, String> {
    let value: u64 = s
        .parse()
        .map_err(|_| format!("invalid lease duration {s:?}: expected milliseconds"))?;
    if (10_000..=600_000).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "lease duration {value} out of range (10000..=600000)"
        ))
    }
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

#[derive(Debug, Clone, Args)]
pub struct SessionRequestArgs {
    pub request_id: String,
    #[arg(long, conflicts_with_all = ["claim", "prepare"])]
    pub cancel: bool,
    #[arg(long, conflicts_with = "claim")]
    pub prepare: bool,
    #[arg(long)]
    pub claim: bool,
}

#[derive(Debug, Clone, Args)]
pub struct SessionLeaseArgs {
    #[arg(long)]
    pub owner: String,
    #[arg(long, default_value_t = 60_000, value_parser = lease_ttl)]
    pub ttl_ms: u64,
    #[arg(long)]
    pub release: bool,
}

#[derive(Debug, Serialize)]
struct StartParams {
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    in_window: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    current_tab: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    browser_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    focused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lease_ttl_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct StartReply {
    #[serde(default)]
    pub container_mode: Option<String>,
    #[serde(default)]
    pub interaction: Option<bsk_protocol::tools::InteractionPolicy>,
    pub session_id: String,
    pub browser_instance_id: String,
    #[serde(default)]
    pub agent_window_id: Option<i64>,
}

fn start_reply_json(reply: &StartReply, owner_id: Option<&str>) -> serde_json::Value {
    let mut output = serde_json::json!({
        "session_id": &reply.session_id,
        "browser_instance_id": &reply.browser_instance_id,
        "agent_window_id": &reply.agent_window_id,
        "container_mode": &reply.container_mode,
        "interaction": &reply.interaction,
    });
    if let Some(owner_id) = owner_id {
        output["owner_id"] = serde_json::Value::String(owner_id.into());
    }
    output
}

#[derive(Debug, Serialize)]
struct StopParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    all: bool,
}

#[derive(Debug, Deserialize)]
pub struct StopReply {
    pub stopped: Vec<String>,
    #[serde(default)]
    pub failed: Vec<StopFailure>,
    #[serde(default)]
    pub returned_tab_ids: Vec<i64>,
    #[serde(default)]
    pub return_failures: Vec<ReturnFailure>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct StopFailure {
    pub session_id: String,
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct ListReply {
    sessions: Vec<SessionStatusEntry>,
}

pub fn dispatch(cmd: SessionCmd, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    match cmd.sub {
        SessionSub::Start(args) => {
            // Embedded clients use their own tool instructions. Keep recoverable
            // lifecycle requests free of unrelated harness filesystem writes.
            if args.request_id.is_none() {
                run_skill_sync_for_session_start(format);
            }
            run_start(info.sock_path, args, format)
        }
        SessionSub::Stop(args) => run_stop(info.sock_path, args, format),
        SessionSub::List => run_list(info.sock_path, format),
        SessionSub::Request(args) => {
            let action = if args.prepare {
                "prepare"
            } else if args.cancel {
                "cancel"
            } else if args.claim {
                "claim"
            } else {
                "status"
            };
            let reply: serde_json::Value = call(
                info.sock_path,
                Method::SessionRequest,
                Some(serde_json::json!({"request_id": args.request_id, "action": action})),
                Duration::from_secs(40),
            )?;
            println!(
                "{}",
                serde_json::to_string_pretty(&reply).context("encode request status")?
            );
            Ok(())
        }
        SessionSub::Lease(args) => {
            let reply: serde_json::Value = call(
                info.sock_path,
                if args.release {
                    Method::SessionOwnerRelease
                } else {
                    Method::SessionLeaseRenew
                },
                Some(serde_json::json!({
                    "owner_id": args.owner,
                    "lease_ttl_ms": args.ttl_ms,
                })),
                SESSION_STOP_IPC_TIMEOUT,
            )?;
            println!(
                "{}",
                serde_json::to_string_pretty(&reply).context("encode lease result")?
            );
            Ok(())
        }
    }
}

fn run_start(sock: PathBuf, args: SessionStartArgs, format: Format) -> Result<(), CliError> {
    if args.unattended {
        crate::cli::interaction_policy::warn_legacy_override("--unattended");
    }
    if args.width.is_some() != args.height.is_some() {
        return Err(CliError::Local(anyhow::anyhow!(
            "--width and --height must be given together"
        )));
    }
    // The daemon may hold `session.start` open for up to
    // `EXTENSION_CONNECT_WAIT` while a just-woken service worker
    // reconnects. Let the user know we are waiting rather than hung —
    // but only if it actually takes a moment, so the common (already
    // connected) fast path stays silent. Human output only; the hint
    // goes to stderr so it never contaminates the session id on stdout.
    let waited = Arc::new(AtomicBool::new(false));
    if matches!(format, Format::Human) {
        let waited = Arc::clone(&waited);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(750));
            if !waited.swap(true, Ordering::SeqCst) {
                eprintln!("waiting for browser extension to connect…");
            }
        });
    }
    let ephemeral = args.ephemeral
        || args.owner_id.is_some()
        || args.owner_kind.is_some()
        || args.lease_ttl_ms.is_some();
    let lease_ttl_ms = args.lease_ttl_ms.unwrap_or(60_000);
    let owner_id = ephemeral.then(|| {
        args.owner_id
            .unwrap_or_else(|| format!("cli:{}:{}", std::process::id(), uuid::Uuid::new_v4()))
    });
    let owner_kind = ephemeral.then(|| args.owner_kind.unwrap_or_else(|| "cli".into()));
    let displayed_owner_id = owner_id.clone();
    let result = start_session(
        sock,
        SessionStartOptions {
            in_window: args.in_window,
            current_tab: args.current_tab,
            tab_id: args.tab_id,
            name: args.name,
            request_id: args.request_id,
            browser: args.browser,
            width: args.width,
            height: args.height,
            focused: args.no_focus.then_some(false),
            owner_id,
            owner_kind,
            lease_ttl_ms: ephemeral.then_some(lease_ttl_ms),
        },
    );
    waited.store(true, Ordering::SeqCst);
    match result {
        Ok(reply) => match format {
            Format::Json => {
                let output = start_reply_json(&reply, displayed_owner_id.as_deref());
                println!(
                    "{}",
                    serde_json::to_string_pretty(&output)
                        .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
                );
            }
            Format::Human => {
                println!("{}", reply.session_id);
                if let Some(owner_id) = displayed_owner_id {
                    eprintln!(
                        "ephemeral owner: {owner_id} (standalone CLI lease is not renewed automatically)"
                    );
                }
            }
        },
        Err(err) => return Err(handle_start_error(err, format)),
    }
    Ok(())
}

/// Options for [`start_session`]: browser selection plus Agent Window
/// creation hints. `None` fields keep the extension-side defaults
/// (focused window, browser-chosen size).
#[derive(Debug, Default, Clone)]
pub struct SessionStartOptions {
    pub request_id: Option<String>,
    pub in_window: bool,
    pub current_tab: bool,
    pub tab_id: Option<i64>,
    pub name: Option<String>,
    pub browser: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub focused: Option<bool>,
    pub owner_id: Option<String>,
    pub owner_kind: Option<String>,
    pub lease_ttl_ms: Option<u64>,
}

/// Start a session and open the Agent Window. Used by `session start` and `record start`.
pub fn start_session(sock: PathBuf, opts: SessionStartOptions) -> Result<StartReply, CliError> {
    if opts.in_window || opts.current_tab || opts.tab_id.is_some() || opts.owner_id.is_some() {
        let status: bsk_protocol::StatusResult = call(
            sock.clone(),
            Method::SystemStatus,
            None::<serde_json::Value>,
            Duration::from_secs(10),
        )?;
        if (opts.in_window || opts.current_tab || opts.tab_id.is_some())
            && !bsk_protocol::tools::session::supports_shared_window(&status.protocol_version)
        {
            if !opts.in_window {
                return Err(CliError::from_rpc(bsk_protocol::RpcError {
                    code: bsk_protocol::ErrorCode::Unsupported,
                    message:
                        "Existing-tab sessions require daemon protocol 1.5; restart or update the daemon"
                            .into(),
                    data: Some(serde_json::json!({
                        "reason": "unsupported_feature", "component": "daemon",
                        "required_protocol": "1.5", "actual_protocol": status.protocol_version,
                    })),
                }));
            }
            return Err(CliError::from_rpc(bsk_protocol::RpcError {
                code: bsk_protocol::ErrorCode::Unsupported,
                message:
                    "Shared sessions require daemon protocol 1.4; restart or update the daemon"
                        .into(),
                data: Some(serde_json::json!({
                    "reason": "unsupported_feature", "component": "daemon",
                    "required_protocol": "1.4", "actual_protocol": status.protocol_version,
                })),
            }));
        }
        if (opts.current_tab || opts.tab_id.is_some())
            && !bsk_protocol::tools::session::supports_existing_tab(&status.protocol_version)
        {
            return Err(CliError::from_rpc(bsk_protocol::RpcError {
                code: bsk_protocol::ErrorCode::Unsupported,
                message:
                    "Existing-tab sessions require daemon protocol 1.5; restart or update the daemon"
                        .into(),
                data: Some(serde_json::json!({
                    "reason": "unsupported_feature", "component": "daemon",
                    "required_protocol": "1.5", "actual_protocol": status.protocol_version,
                })),
                }));
        }
        if opts.owner_id.is_some()
            && !bsk_protocol::tools::session::supports_session_lease(&status.protocol_version)
        {
            return Err(CliError::from_rpc(bsk_protocol::RpcError {
                code: bsk_protocol::ErrorCode::Unsupported,
                message:
                    "Ephemeral sessions require daemon protocol 1.5; restart or update the daemon"
                        .into(),
                data: Some(serde_json::json!({
                    "reason": "unsupported_feature", "component": "daemon",
                    "required_protocol": "1.5", "actual_protocol": status.protocol_version,
                })),
            }));
        }
    }
    call(
        sock,
        if opts.request_id.is_some() {
            Method::SessionStartTracked
        } else {
            Method::SessionStart
        },
        Some(StartParams {
            in_window: opts.in_window,
            current_tab: opts.current_tab,
            tab_id: opts.tab_id,
            request_id: opts.request_id,
            task_name: opts.name,
            browser_instance_id: opts.browser,
            width: opts.width,
            height: opts.height,
            focused: opts.focused,
            owner_id: opts.owner_id,
            owner_kind: opts.owner_kind,
            lease_ttl_ms: opts.lease_ttl_ms,
        }),
        SESSION_START_IPC_TIMEOUT,
    )
}

/// Stop a single session by id.
pub fn stop_session(sock: PathBuf, session_id: &str) -> Result<StopReply, CliError> {
    call(
        sock,
        Method::SessionStop,
        Some(StopParams {
            session_id: Some(session_id.to_string()),
            all: false,
        }),
        SESSION_STOP_IPC_TIMEOUT,
    )
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
            print!("{}", format_human_session_list(&reply.sessions));
        }
    }
    Ok(())
}

fn format_human_session_list(sessions: &[SessionStatusEntry]) -> String {
    use std::fmt::Write as _;

    if sessions.is_empty() {
        return "(no active sessions)\n".into();
    }
    let headers = ("SESSION", "BROWSER", "WINDOW / MODE", "OWNER", "LIFECYCLE");
    let session_w = sessions
        .iter()
        .map(|s| s.session_id.len())
        .max()
        .unwrap_or(0)
        .max(headers.0.len());
    let browser_w = sessions
        .iter()
        .map(|s| s.browser_instance_id.len())
        .max()
        .unwrap_or(0)
        .max(headers.1.len());
    let owners: Vec<String> = sessions
        .iter()
        .map(|s| match (&s.owner_kind, &s.owner_id) {
            (Some(kind), Some(id)) if id.starts_with(&format!("{kind}:")) => id.clone(),
            (Some(kind), Some(id)) => format!("{kind}:{id}"),
            (_, Some(id)) => id.clone(),
            _ => "-".into(),
        })
        .collect();
    let owner_w = owners
        .iter()
        .map(String::len)
        .max()
        .unwrap_or(0)
        .max(headers.3.len());
    let mut output = String::new();
    writeln!(
        output,
        "{:<session_w$}  {:<browser_w$}  {:<20}  {:<owner_w$}  {}",
        headers.0, headers.1, headers.2, headers.3, headers.4,
    )
    .expect("write session-list header");
    for (s, owner) in sessions.iter().zip(owners) {
        let window = s
            .agent_window_id
            .map(|w| w.to_string())
            .unwrap_or_else(|| "-".into());
        let lifecycle = format!(
            "{}/{}{}",
            s.lifecycle_mode.as_deref().unwrap_or("persistent"),
            s.lifecycle_state.as_deref().unwrap_or("active"),
            s.lease_expires_at_ms
                .map(|expires| format!(" expires={expires}"))
                .unwrap_or_default(),
        );
        writeln!(
            output,
            "{:<session_w$}  {:<browser_w$}  {:<20}  {:<owner_w$}  {}",
            s.session_id,
            s.browser_instance_id,
            format!(
                "{window} / {}",
                s.container_mode.as_deref().unwrap_or("window")
            ),
            owner,
            lifecycle,
        )
        .expect("write session-list row");
    }
    output
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
        for (harness, reason) in &report.paused {
            eprintln!(
                "! skill auto-update paused for {}: {}; run `bsk doctor` for options",
                harness.cli_name(),
                reason.description()
            );
        }
    }
    for (harness, msg) in &report.errors {
        tracing::warn!(harness = harness.cli_name(), error = %msg, "skill sync failed");
    }
}

#[cfg(test)]
mod start_params_tests {
    use super::*;

    #[test]
    fn start_params_send_task_name_without_policy_overrides() {
        for task_name in [None, Some("Check settings".to_string())] {
            let params = StartParams {
                in_window: false,
                current_tab: false,
                tab_id: None,
                request_id: None,
                task_name: task_name.clone(),
                browser_instance_id: None,
                width: None,
                height: None,
                focused: None,
                owner_id: None,
                owner_kind: None,
                lease_ttl_ms: None,
            };
            let expected = task_name.map_or_else(
                || serde_json::json!({}),
                |name| serde_json::json!({"task_name": name}),
            );
            assert_eq!(serde_json::to_value(params).unwrap(), expected);
        }
    }

    #[test]
    fn start_json_only_includes_owner_for_ephemeral_sessions() {
        let reply = StartReply {
            container_mode: Some("window".into()),
            interaction: None,
            session_id: "aa11".into(),
            browser_instance_id: "chrome-main".into(),
            agent_window_id: Some(42),
        };

        assert!(start_reply_json(&reply, None).get("owner_id").is_none());
        assert_eq!(
            start_reply_json(&reply, Some("cli:123:token"))["owner_id"],
            "cli:123:token"
        );
    }

    #[test]
    fn human_session_list_renders_owner_and_lifecycle_columns() {
        let sessions = vec![
            serde_json::from_value::<SessionStatusEntry>(serde_json::json!({
                "session_id": "aa11",
                "browser_instance_id": "chrome-main",
                "agent_window_id": 42,
                "container_mode": "existing_tab",
                "created_at_ms": 1,
                "owner_id": "dsh:123:token",
                "owner_kind": "dsh",
                "lifecycle_mode": "lease",
                "lifecycle_state": "active",
                "lease_expires_at_ms": 9999
            }))
            .unwrap(),
            serde_json::from_value::<SessionStatusEntry>(serde_json::json!({
                "session_id": "bb22",
                "browser_instance_id": "chrome-main",
                "created_at_ms": 2
            }))
            .unwrap(),
        ];

        let output = format_human_session_list(&sessions);
        assert!(output.contains("SESSION"));
        assert!(output.contains("OWNER"));
        assert!(output.contains("LIFECYCLE"));
        assert!(output.contains("42 / existing_tab"));
        assert!(output.contains("dsh:123:token"));
        assert!(output.contains("lease/active expires=9999"));
        assert!(output.contains("persistent/active"));
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
