//! `bsk wait-for-navigation` (M9.2) and `bsk wait-ms` (M9.3) — the two
//! "timing helper" CLI commands. `wait-for-navigation` hops through
//! the extension via the session queue; `wait-ms` is answered entirely
//! by the daemon (no extension involvement; no session needed).
//!
//! `bsk wait-for-element` is the element-level counterpart of
//! `wait-for-navigation`: one RPC that answers "is `#mask` hidden yet?"
//! instead of a caller-side `evaluate` + `wait-ms` polling loop. The
//! re-checking runs inside the extension (`apps/extension/src/tools/waits.ts`),
//! reducing caller round trips and providing shared state semantics. It does
//! not guarantee lower latency or bypass throttling of the page's own work.
//!
//! A `wait-for-element` timeout is **reported, not raised**: the result
//! carries the evidence (`attached` / `visible`) so the caller can tell
//! "it never appeared" from "it is there but still hidden". Exit code
//! stays 0 and the reason goes to stderr, exactly like
//! `wait-for-navigation`'s `reached: "timeout"`.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{
    ElementState, WaitForElementParams, WaitForElementResult, WaitForNavigationParams,
    WaitForNavigationResult, WaitMsParams, WaitMsResult,
};
use clap::{Args, ValueEnum};

use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::interaction::split_target;
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
// bsk wait-for-element (element state)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum CliElementState {
    Visible,
    Hidden,
    Attached,
    Detached,
}

impl CliElementState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Visible => "visible",
            Self::Hidden => "hidden",
            Self::Attached => "attached",
            Self::Detached => "detached",
        }
    }
}

impl From<CliElementState> for ElementState {
    fn from(value: CliElementState) -> Self {
        match value {
            CliElementState::Visible => Self::Visible,
            CliElementState::Hidden => Self::Hidden,
            CliElementState::Attached => Self::Attached,
            CliElementState::Detached => Self::Detached,
        }
    }
}

#[derive(Debug, Clone, Args)]
pub struct WaitForElementArgs {
    /// Snapshot/observe ref (`@e3`, `e3`) or CSS selector.
    #[arg(value_name = "TARGET")]
    pub target: Option<String>,

    #[arg(long = "ref")]
    pub ref_: Option<String>,

    #[arg(long = "selector")]
    pub selector: Option<String>,

    /// State to wait for: `visible`, `hidden`, `attached`, `detached`.
    /// `hidden` means absent or not visible; `detached` requires absence.
    #[arg(long, value_enum, default_value_t = CliElementState::Visible)]
    pub state: CliElementState,

    /// Inspection budget (default 10s, max 5m). Timeout returns satisfied=false, exit 0.
    #[arg(long, default_value = "10s", value_parser = parse_timeout_ms)]
    pub timeout: u32,

    /// Poll interval (16..=2000ms, default 100ms); shortened near the deadline.
    #[arg(long = "poll-ms", default_value = "100")]
    pub poll_ms: u32,

    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,
}

pub fn dispatch_wait_for_element(args: WaitForElementArgs, format: Format) -> Result<(), CliError> {
    let (ref_, selector) = split_target(args.target, args.ref_, args.selector)?;
    // Validate here so a bad flag fails locally instead of spending a daemon
    // round trip; the extension applies the same bounds.
    if !(16..=2_000).contains(&args.poll_ms) {
        return Err(CliError::Local(anyhow::anyhow!(
            "--poll-ms must be in 16..=2000"
        )));
    }
    if !(1..=300_000).contains(&args.timeout) {
        return Err(CliError::Local(anyhow::anyhow!(
            "--timeout must be in 1ms..=5m"
        )));
    }
    let state: ElementState = args.state.into();
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = WaitForElementParams {
        session_id: args.session,
        ref_,
        selector,
        state,
        tab_id: args.tab_id,
        timeout_ms: Some(args.timeout),
        poll_ms: Some(args.poll_ms),
    };
    let reply: WaitForElementResult = crate::cli::business_rpc::call(
        info.sock_path,
        "wait-for-element",
        Method::ToolWaitForElement,
        Some(params),
        ipc_timeout(args.timeout),
    )?;
    match format {
        Format::Json => println!(
            "{}",
            serde_json::to_string_pretty(&reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
        ),
        Format::Human => {
            let target =
                format_used_target(reply.used_ref.as_deref(), reply.used_selector.as_deref());
            println!(
                "wait-for-element ok tab={} target={target} state={} satisfied={} attached={} visible={} elapsed_ms={}",
                reply.tab_id,
                state.as_str(),
                reply.satisfied,
                format_observed(reply.attached),
                format_observed(reply.visible),
                reply.elapsed_ms
            );
            if !reply.satisfied {
                eprintln!(
                    "warning: {target} did not become {} within {}ms (attached={}, visible={})",
                    state.as_str(),
                    args.timeout,
                    format_observed(reply.attached),
                    format_observed(reply.visible)
                );
            }
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn format_observed(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "true",
        Some(false) => "false",
        None => "unknown",
    }
}

fn format_used_target(used_ref: Option<&str>, used_selector: Option<&str>) -> String {
    used_ref
        .map(|r| format!("@{r}"))
        .or_else(|| used_selector.map(str::to_string))
        .unwrap_or_else(|| "?".into())
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
    use clap::Parser;

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

    #[test]
    fn cli_state_maps_onto_the_wire_enum() {
        for (cli, wire, wire_name) in [
            (CliElementState::Visible, ElementState::Visible, "visible"),
            (CliElementState::Hidden, ElementState::Hidden, "hidden"),
            (
                CliElementState::Attached,
                ElementState::Attached,
                "attached",
            ),
            (
                CliElementState::Detached,
                ElementState::Detached,
                "detached",
            ),
        ] {
            let mapped: ElementState = cli.into();
            assert_eq!(mapped, wire);
            assert_eq!(cli.as_str(), wire_name);
            assert_eq!(mapped.as_str(), wire_name);
        }
    }

    /// `--state` defaults to `visible` and the timeout grammar is the same
    /// one the other wait commands accept.
    #[test]
    fn parses_state_and_durations() {
        let cli = crate::cli::Cli::try_parse_from([
            "bsk",
            "wait-for-element",
            "#mask",
            "--session",
            "s1",
        ])
        .unwrap();
        let crate::cli::Command::WaitForElement(args) = cli.command else {
            panic!("expected wait-for");
        };
        assert_eq!(args.state, CliElementState::Visible);
        assert_eq!(args.timeout, 10_000);
        assert_eq!(args.poll_ms, 100);
        assert_eq!(args.target.as_deref(), Some("#mask"));

        let cli = crate::cli::Cli::try_parse_from([
            "bsk",
            "wait-for-element",
            "--selector",
            ".el-loading-mask",
            "--state",
            "detached",
            "--timeout",
            "1500ms",
            "--poll-ms",
            "50",
            "--session",
            "s1",
        ])
        .unwrap();
        let crate::cli::Command::WaitForElement(args) = cli.command else {
            panic!("expected wait-for");
        };
        assert_eq!(args.state, CliElementState::Detached);
        assert_eq!(args.timeout, 1_500);
        assert_eq!(args.poll_ms, 50);
        assert_eq!(args.selector.as_deref(), Some(".el-loading-mask"));
    }

    /// Bad flags must fail before a daemon is spawned.
    #[test]
    fn dispatch_rejects_bad_flags_before_starting_a_daemon() {
        for argv in [
            // 目标一个都没给
            vec!["bsk", "wait-for-element", "--session", "s1"],
            // 目标给了两个
            vec![
                "bsk",
                "wait-for-element",
                "#a",
                "--selector",
                "#b",
                "--session",
                "s1",
            ],
            // poll 为 0
            vec![
                "bsk",
                "wait-for-element",
                "#a",
                "--poll-ms",
                "0",
                "--session",
                "s1",
            ],
        ] {
            let cli = crate::cli::Cli::try_parse_from(argv.clone()).unwrap();
            let crate::cli::Command::WaitForElement(args) = cli.command else {
                panic!("expected wait-for for {argv:?}");
            };
            assert!(
                matches!(
                    dispatch_wait_for_element(args, Format::Json),
                    Err(CliError::Local(_))
                ),
                "{argv:?} should have failed locally"
            );
        }
    }
    #[test]
    fn dispatch_rejects_out_of_range_element_wait_budgets_locally() {
        for (flag, value) in [
            ("--poll-ms", "15"),
            ("--poll-ms", "2001"),
            ("--timeout", "301s"),
        ] {
            let cli = crate::cli::Cli::try_parse_from([
                "bsk",
                "wait-for-element",
                "#target",
                "--session",
                "s1",
                flag,
                value,
            ])
            .unwrap();
            let crate::cli::Command::WaitForElement(args) = cli.command else {
                panic!("expected element wait");
            };
            assert!(matches!(
                dispatch_wait_for_element(args, Format::Json),
                Err(CliError::Local(_))
            ));
        }
        assert_eq!(format_observed(None), "unknown");
        assert_eq!(format_observed(Some(false)), "false");
    }
}
