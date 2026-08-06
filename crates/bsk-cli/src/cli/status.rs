//! `bsk status` — auto-spawn the daemon, query `system.status`, render.

use std::time::Duration;

use anyhow::Context;
use bsk_protocol::{Method, StatusParams, StatusResult};

use crate::cli::browser_wait::{
    browser_connect_wait, browser_query_ipc_timeout, wait_for_browser_ms,
};
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::CliError;

/// Chrome Web Store listing for the browser-skill extension. Mirrors the
/// same constant in `cli::doctor` — they must stay in sync so a single
/// `bsk status` / `bsk doctor` run steers an LLM to the same place.
const EXTENSION_STORE_URL: &str =
    "https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi";

/// Repair hint appended after the `browsers connected` row when zero
/// browsers are online. Mirrors the ACTION/FALLBACK decision tree of
/// `ErrorCode::NoBrowserConnected` in `cli::render_error` and the
/// `extension connected` check in `cli::doctor` (issue #40) so an LLM
/// driving `bsk status` is steered to launch a browser itself, fall
/// back to asking the user only when it genuinely cannot spawn GUI
/// apps, and reach for the Web Store URL only as a last-resort
/// "no Chromium installed on this host" path.
const NO_BROWSER_HINT: &str = "BrowserSkill does not launch browsers itself. \
Launch a supported Chromium browser (Chrome / Chromium / Edge / Brave) so the extension can connect — \
quit and relaunch any stale one whose extension popup is not green. \
macOS: `open -a \"Google Chrome\"` (or Chromium / \"Microsoft Edge\" / \"Brave Browser\"); \
Linux: `google-chrome &` (or chromium / microsoft-edge / brave-browser &); \
Windows: `start chrome` (or start chromium / start msedge / start brave). \
Then `bsk status` / `bsk browsers` and retry. \
FALLBACK — only if you genuinely CANNOT launch applications (sandboxed, no GUI spawn, or no shell/OS access): \
- Can detect processes but cannot launch: detect which browsers are running and report state; ask user to open a supported browser and confirm extension is connected (popup green); retry after they confirm. \
- Cannot detect processes at all: ask user to confirm a supported Chromium browser is started and the extension is connected (popup green); retry. \
If no supported Chromium browser is installed on this host at all, install one and the browser-skill extension from {URL}.";

/// Output format selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Output {
    Human,
    Json,
}

/// Run `bsk status`. Returns the result so callers (tests, doctor) can
/// reuse it.
pub fn run(output: Output) -> Result<StatusResult, CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let wait = browser_connect_wait();
    let result = query_sock_with_wait(info.sock_path, wait)?;
    match output {
        Output::Human => render_human(&result),
        Output::Json => render_json(&result).map_err(CliError::Local)?,
    }
    Ok(result)
}

pub(crate) fn query_sock_with_wait(
    sock: std::path::PathBuf,
    wait: Duration,
) -> Result<StatusResult, CliError> {
    let params = StatusParams {
        wait_for_browser_ms: wait_for_browser_ms(wait),
    };
    let timeout = browser_query_ipc_timeout(wait, Duration::from_secs(2));
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build tokio runtime for status")
        .map_err(CliError::Local)?;
    rt.block_on(async move {
        let mut client = crate::ipc_client::Client::connect_path(sock).await?;
        let outcome = client
            .call::<_, StatusResult>(Method::SystemStatus, &params, timeout)
            .await?;
        outcome.map_err(CliError::from_rpc)
    })
}

fn render_human(s: &StatusResult) {
    if !s.version_skew_browsers.is_empty() {
        // Emit the version-skew banner first so it's the first thing
        // a user sees on `bsk status`. Yellow text via the bare ANSI
        // escape; clipped automatically when stdout is not a TTY by
        // most terminals' colour policy. We do not pull in `console`
        // / `owo-colors` for this milestone — keeping the dependency
        // surface minimal.
        let yellow = "\x1b[33m";
        let bold = "\x1b[1m";
        let reset = "\x1b[0m";
        eprintln!(
            "{bold}{yellow}warning:{reset} {} browser(s) have protocol version drift from the daemon{reset}",
            s.version_skew_browsers.len()
        );
        for skew in &s.version_skew_browsers {
            let label = if skew.label.is_empty() {
                "-".to_string()
            } else {
                skew.label.clone()
            };
            eprintln!(
                "  {} ({}) — protocol ext {} vs daemon {} (app ext v{}, daemon v{}) — please align protocol versions",
                skew.instance_id,
                label,
                display_protocol(&skew.client_protocol_version),
                display_protocol(&skew.server_protocol_version),
                skew.client_version,
                skew.server_version
            );
        }
    }
    let rows: [(&str, String); 8] = [
        ("daemon version", s.daemon_version.clone()),
        ("protocol version", s.protocol_version.clone()),
        ("pid", s.pid.to_string()),
        ("uptime", format_uptime(s.uptime_secs)),
        ("WS port", s.ws_port.to_string()),
        ("sock", s.sock_path.clone()),
        ("browsers connected", s.browsers.len().to_string()),
        ("active sessions", s.sessions.len().to_string()),
    ];
    let label_width = rows.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
    for (key, value) in &rows {
        println!("{key:<label_width$}  {value}");
    }
    if s.browsers.is_empty() {
        // Mirrors the FAIL hint in `cli::doctor` so the first thing
        // an LLM reaches for after a failed session start (`bsk
        // status` → 0 browsers) sees the same ACTION / FALLBACK tree.
        // Written to stderr so `--json` consumers and stdout-parsing
        // agents ignore it.
        eprintln!();
        let hint = NO_BROWSER_HINT.replace("{URL}", EXTENSION_STORE_URL);
        eprintln!("hint: {hint}");
    }
}

fn render_json(s: &StatusResult) -> anyhow::Result<()> {
    let json = serde_json::to_string_pretty(s).context("encode status as JSON")?;
    println!("{json}");
    Ok(())
}

fn format_uptime(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m {:02}s", secs / 60, secs % 60)
    } else {
        format!(
            "{}h {:02}m {:02}s",
            secs / 3600,
            (secs % 3600) / 60,
            secs % 60
        )
    }
}

fn display_protocol(value: &str) -> &str {
    if value.is_empty() { "unknown" } else { value }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_uptime_under_minute() {
        assert_eq!(format_uptime(5), "5s");
    }

    #[test]
    fn format_uptime_minutes() {
        assert_eq!(format_uptime(125), "2m 05s");
    }

    #[test]
    fn format_uptime_hours() {
        assert_eq!(format_uptime(3725), "1h 02m 05s");
    }

    #[test]
    fn display_protocol_uses_unknown_for_legacy_empty_values() {
        assert_eq!(display_protocol(""), "unknown");
        assert_eq!(display_protocol("1.0"), "1.0");
    }
}
