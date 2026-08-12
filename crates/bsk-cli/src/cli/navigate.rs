//! `bsk navigate` + `bsk navigate-back / -forward` + `bsk reload` (M7
//! navigation tools). All four are thin clap wrappers around the
//! matching `tool.navigate*` / `tool.reload` IPC calls. The
//! human-readable output is one line per result — the JSON path
//! emits the full bsk-protocol payload.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{
    NavigateBackParams, NavigateBackResult, NavigateForwardParams, NavigateForwardResult,
    NavigateParams, NavigateResult, ReloadParams, ReloadResult, WaitUntil,
};
use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;

use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum CliWaitUntil {
    #[value(name = "load")]
    Load,
    #[value(name = "domcontentloaded")]
    DomContentLoaded,
    #[value(name = "networkidle")]
    NetworkIdle,
    #[value(name = "commit")]
    Commit,
}

impl From<CliWaitUntil> for WaitUntil {
    fn from(v: CliWaitUntil) -> Self {
        match v {
            CliWaitUntil::Load => WaitUntil::Load,
            CliWaitUntil::DomContentLoaded => WaitUntil::DomContentLoaded,
            CliWaitUntil::NetworkIdle => WaitUntil::NetworkIdle,
            CliWaitUntil::Commit => WaitUntil::Commit,
        }
    }
}

/// Parse a short duration string into milliseconds. Accepts a bare
/// integer (interpreted as milliseconds), or a value with one of the
/// suffixes `ms`, `s`, `m`. Keeps us off the `humantime` crate so the
/// CLI deps stay minimal.
pub(crate) fn parse_timeout_ms(arg: &str) -> Result<u32, String> {
    let arg = arg.trim();
    if arg.is_empty() {
        return Err("empty timeout".into());
    }
    let (num_str, suffix) = if let Some(stripped) = arg.strip_suffix("ms") {
        (stripped, "ms")
    } else if let Some(stripped) = arg.strip_suffix('s') {
        (stripped, "s")
    } else if let Some(stripped) = arg.strip_suffix('m') {
        (stripped, "m")
    } else {
        (arg, "ms")
    };
    let n: u64 = num_str
        .trim()
        .parse()
        .map_err(|_| format!("invalid timeout '{arg}': expected number"))?;
    let ms = match suffix {
        "ms" => n,
        "s" => n.saturating_mul(1_000),
        "m" => n.saturating_mul(60_000),
        _ => unreachable!(),
    };
    if ms == 0 {
        return Err(format!(
            "invalid timeout '{arg}': must be greater than zero"
        ));
    }
    u32::try_from(ms).map_err(|_| format!("timeout '{arg}' too large for u32 ms"))
}

#[derive(Debug, Clone, Args)]
#[command(args_conflicts_with_subcommands = true, subcommand_negates_reqs = true)]
pub struct NavigateCommand {
    #[command(subcommand)]
    pub command: Option<NavigateCmd>,

    #[command(flatten)]
    pub args: NavigateArgs,
}

#[derive(Debug, Clone, Subcommand)]
pub enum NavigateCmd {
    /// Step back in history one entry.
    Back(NavigateHistoryArgs),
    /// Step forward in history one entry.
    Forward(NavigateHistoryArgs),
}

#[derive(Debug, Clone, Args)]
pub struct NavigateArgs {
    /// Destination URL.
    pub url: Option<String>,

    /// Session id (must be active).
    #[arg(long)]
    pub session: Option<String>,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Lifecycle phase to wait for. Defaults to `load`.
    #[arg(long = "wait-until", value_enum, default_value_t = CliWaitUntil::Load)]
    pub wait_until: CliWaitUntil,

    /// Hard timeout (default 30s). Accepts `30s`, `1m`, `1500ms`.
    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

#[derive(Debug, Clone, Args)]
pub struct NavigateHistoryArgs {
    #[arg(long)]
    pub session: String,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    #[arg(long = "wait-until", value_enum, default_value_t = CliWaitUntil::Load)]
    pub wait_until: CliWaitUntil,

    #[arg(long, default_value = "15s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

#[derive(Debug, Clone, Args)]
pub struct ReloadArgs {
    #[arg(long)]
    pub session: String,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    #[arg(long = "wait-until", value_enum, default_value_t = CliWaitUntil::Load)]
    pub wait_until: CliWaitUntil,

    #[arg(long, default_value = "15s", value_parser = parse_timeout_ms)]
    pub timeout: u32,

    /// Bypass the HTTP cache when reloading (CDP `Page.reload(ignoreCache=true)`).
    #[arg(long)]
    pub hard: bool,
}

pub fn dispatch_navigate_command(args: NavigateCommand, format: Format) -> Result<(), CliError> {
    match args.command {
        Some(NavigateCmd::Back(args)) => dispatch_navigate_back(args, format),
        Some(NavigateCmd::Forward(args)) => dispatch_navigate_forward(args, format),
        None => dispatch_navigate(args.args, format),
    }
}

pub fn dispatch_navigate(args: NavigateArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let Some(url) = args.url.clone() else {
        return Err(CliError::Local(anyhow::anyhow!("navigate requires a url")));
    };
    let Some(session) = args.session.clone() else {
        return Err(CliError::Local(anyhow::anyhow!(
            "navigate requires --session <session-id>"
        )));
    };
    let params = NavigateParams {
        session_id: session,
        url,
        tab_id: args.tab_id,
        wait_until: Some(args.wait_until.into()),
        timeout_ms: Some(args.timeout),
    };
    let reply: NavigateResult = call(
        info.sock_path,
        Method::ToolNavigate,
        params,
        "navigate-1",
        args.timeout,
    )?;
    render_navigate(&reply, format)
}

pub fn dispatch_navigate_back(args: NavigateHistoryArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = NavigateBackParams {
        session_id: args.session.clone(),
        tab_id: args.tab_id,
        wait_until: Some(args.wait_until.into()),
        timeout_ms: Some(args.timeout),
    };
    let reply: NavigateBackResult = call(
        info.sock_path,
        Method::ToolNavigateBack,
        params,
        "navigate-back-1",
        args.timeout,
    )?;
    render_history(&OwnedHistoryView::from(reply), "navigate-back", format)
}

pub fn dispatch_navigate_forward(
    args: NavigateHistoryArgs,
    format: Format,
) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = NavigateForwardParams {
        session_id: args.session.clone(),
        tab_id: args.tab_id,
        wait_until: Some(args.wait_until.into()),
        timeout_ms: Some(args.timeout),
    };
    let reply: NavigateForwardResult = call(
        info.sock_path,
        Method::ToolNavigateForward,
        params,
        "navigate-forward-1",
        args.timeout,
    )?;
    render_history(&OwnedHistoryView::from(reply), "navigate-forward", format)
}

pub fn dispatch_reload(args: ReloadArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = ReloadParams {
        session_id: args.session.clone(),
        tab_id: args.tab_id,
        wait_until: Some(args.wait_until.into()),
        timeout_ms: Some(args.timeout),
        hard: if args.hard { Some(true) } else { None },
    };
    let reply: ReloadResult = call(
        info.sock_path,
        Method::ToolReload,
        params,
        "reload-1",
        args.timeout,
    )?;
    render_history(&OwnedHistoryView::from(reply), "reload", format)
}

fn call<P, R>(
    sock: PathBuf,
    method: Method,
    params: P,
    id: &'static str,
    timeout_ms: u32,
) -> Result<R, CliError>
where
    P: serde::Serialize + Send + 'static,
    R: serde::de::DeserializeOwned + Send + 'static,
{
    crate::cli::business_rpc::call::<P, R>(
        sock,
        id,
        method,
        Some(params),
        navigate_ipc_timeout(timeout_ms),
    )
}

/// Use the global tool IPC timeout but extend it so a long navigation
/// (e.g. networkidle on a slow page) doesn't trip the IPC layer before
/// the daemon's own timeout fires.
fn navigate_ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms))
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(u64::from(timeout_ms / 1_000) + 15))
}

fn render_navigate(reply: &NavigateResult, format: Format) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            println!("tab={} reached={}", reply.tab_id, reply.reached);
            if let Some(final_url) = &reply.final_url {
                println!("url={final_url}");
            }
            if reply.reached == "timeout"
                && let Some(text) = &reply.error_text
            {
                eprintln!("warning: {text}");
            }
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn render_history(
    view: &OwnedHistoryView,
    label: &'static str,
    format: Format,
) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(view)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            println!("{label}: tab={} reached={}", view.tab_id, view.reached);
            if let Some(p) = &view.previous_url {
                println!("previous_url={p}");
            }
            if let Some(f) = &view.final_url {
                println!("final_url={f}");
            }
            if view.reached == "timeout"
                && let Some(text) = &view.error_text
            {
                eprintln!("warning: {text}");
            }
            print_dialog_summaries(&view.dialogs);
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct OwnedHistoryView {
    tab_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    final_url: Option<String>,
    reached: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_text: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    dialogs: Vec<bsk_protocol::tools::JavaScriptDialogInfo>,
}

impl From<NavigateBackResult> for OwnedHistoryView {
    fn from(r: NavigateBackResult) -> Self {
        Self {
            tab_id: r.tab_id,
            previous_url: r.previous_url,
            final_url: r.final_url,
            reached: r.reached,
            error_text: r.error_text,
            dialogs: r.dialogs,
        }
    }
}

impl From<NavigateForwardResult> for OwnedHistoryView {
    fn from(r: NavigateForwardResult) -> Self {
        Self {
            tab_id: r.tab_id,
            previous_url: r.previous_url,
            final_url: r.final_url,
            reached: r.reached,
            error_text: r.error_text,
            dialogs: r.dialogs,
        }
    }
}

impl From<ReloadResult> for OwnedHistoryView {
    fn from(r: ReloadResult) -> Self {
        Self {
            tab_id: r.tab_id,
            previous_url: r.previous_url,
            final_url: r.final_url,
            reached: r.reached,
            error_text: r.error_text,
            dialogs: r.dialogs,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_short_duration_strings() {
        assert_eq!(parse_timeout_ms("30s").unwrap(), 30_000);
        assert_eq!(parse_timeout_ms("250ms").unwrap(), 250);
        assert_eq!(parse_timeout_ms("1m").unwrap(), 60_000);
        assert_eq!(parse_timeout_ms("5").unwrap(), 5); // bare number = milliseconds
        assert_eq!(parse_timeout_ms("5s").unwrap(), 5_000);
        assert!(parse_timeout_ms("0").is_err());
        assert!(parse_timeout_ms("0ms").is_err());
        assert!(parse_timeout_ms("-1").is_err());
        assert!(parse_timeout_ms("1h").is_err());
        assert!(parse_timeout_ms("1d").is_err());
        assert!(parse_timeout_ms("nope").is_err());
        assert!(parse_timeout_ms("").is_err());
    }

    #[test]
    fn cli_wait_until_matches_protocol_enum() {
        assert_eq!(WaitUntil::Load, CliWaitUntil::Load.into());
        assert_eq!(WaitUntil::Commit, CliWaitUntil::Commit.into());
    }

    #[test]
    fn navigate_ipc_timeout_tracks_user_timeout_with_grace() {
        assert_eq!(
            navigate_ipc_timeout(60_000),
            Duration::from_secs(60) + Duration::from_secs(15)
        );
    }
}
