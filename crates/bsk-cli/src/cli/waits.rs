//! `bsk wait-for-navigation` (M9.2) and `bsk wait-ms` (M9.3) — the two
//! "timing helper" CLI commands. `wait-for-navigation` hops through
//! the extension via the session queue; `wait-ms` is answered entirely
//! by the daemon (no extension involvement; no session needed).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{
    WaitForNavigationParams, WaitForNavigationResult, WaitMsParams, WaitMsResult,
};
use clap::Args;

use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::navigate::{CliWaitUntil, parse_timeout_ms};

// ---------------------------------------------------------------------------
// bsk wait-for-navigation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Args)]
pub struct WaitForNavigationArgs {
    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Lifecycle phase to wait on. Defaults to `load`.
    #[arg(long = "wait-until", value_enum, default_value_t = CliWaitUntil::Load)]
    pub wait_until: CliWaitUntil,

    /// Hard timeout (default 30s). Accepts `30s`, `1m`, `1500ms`.
    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

pub fn dispatch_wait_for_navigation(
    args: WaitForNavigationArgs,
    format: Format,
) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = WaitForNavigationParams {
        session_id: args.session,
        tab_id: args.tab_id,
        wait_until: Some(args.wait_until.into()),
        timeout_ms: Some(args.timeout),
    };
    let reply = call_wait_for_navigation(info.sock_path, params, args.timeout)?;
    render_wait_for_navigation(&reply, format)
}

fn call_wait_for_navigation(
    sock: PathBuf,
    params: WaitForNavigationParams,
    timeout_ms: u32,
) -> Result<WaitForNavigationResult, CliError> {
    crate::cli::business_rpc::call::<WaitForNavigationParams, WaitForNavigationResult>(
        sock,
        "wait-nav",
        Method::ToolWaitForNavigation,
        Some(params),
        ipc_timeout(timeout_ms),
    )
}

fn render_wait_for_navigation(
    reply: &WaitForNavigationResult,
    format: Format,
) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            println!("tab={} reached={}", reply.tab_id, reply.reached.as_str());
            if reply.reached.as_str() == "timeout"
                && let Some(text) = &reply.error_text
            {
                eprintln!("warning: {text}");
            }
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// bsk wait-ms
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Args)]
pub struct WaitMsArgs {
    /// Duration to wait. Accepts `30s`, `1m`, `1500ms`, or a bare
    /// integer (interpreted as milliseconds).
    #[arg(value_parser = parse_duration_ms)]
    pub duration: u64,
}

/// Parse the same short-duration grammar as `--timeout` flags but
/// return a `u64` of milliseconds (no upper-bound check; the daemon
/// enforces the 5-minute cap so the CLI mirrors only the input
/// grammar).
fn parse_duration_ms(arg: &str) -> Result<u64, String> {
    let arg = arg.trim();
    if arg.is_empty() {
        return Err("empty duration".into());
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
        .map_err(|_| format!("invalid duration '{arg}': expected non-negative integer"))?;
    let ms = match suffix {
        "ms" => n,
        "s" => n.saturating_mul(1_000),
        "m" => n.saturating_mul(60_000),
        _ => unreachable!(),
    };
    Ok(ms)
}

pub fn dispatch_wait_ms(args: WaitMsArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = WaitMsParams {
        duration_ms: args.duration,
    };
    let reply = call_wait_ms(info.sock_path, params, args.duration)?;
    render_wait_ms(&reply, format)
}

fn call_wait_ms(
    sock: PathBuf,
    params: WaitMsParams,
    duration_ms: u64,
) -> Result<WaitMsResult, CliError> {
    // IPC budget: requested duration + 15s of slack so the client
    // doesn't tear the connection down before the daemon's sleep
    // resolves.
    let timeout = Duration::from_millis(duration_ms)
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(30));
    crate::cli::business_rpc::call::<WaitMsParams, WaitMsResult>(
        sock,
        "wait-ms",
        Method::ToolWaitMs,
        Some(params),
        timeout,
    )
}

fn render_wait_ms(reply: &WaitMsResult, format: Format) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            println!("waited_ms={}", reply.waited_ms);
        }
    }
    Ok(())
}

fn ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms))
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(u64::from(timeout_ms / 1_000) + 15))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_duration_strings() {
        assert_eq!(parse_duration_ms("0").unwrap(), 0);
        assert_eq!(parse_duration_ms("0ms").unwrap(), 0);
        assert_eq!(parse_duration_ms("500").unwrap(), 500);
        assert_eq!(parse_duration_ms("30s").unwrap(), 30_000);
        assert_eq!(parse_duration_ms("500ms").unwrap(), 500);
        assert_eq!(parse_duration_ms("1m").unwrap(), 60_000);
        assert!(parse_duration_ms("nope").is_err());
        assert!(parse_duration_ms("").is_err());
        assert!(parse_duration_ms("-1").is_err());
    }
}
