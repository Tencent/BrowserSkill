//! `bsk doctor` — guided diagnostics + repair hints.

use std::time::Duration;

use anyhow::Result;
use bsk_protocol::StatusResult;
use console::style;
use serde::Serialize;

use crate::cli::browser_wait::doctor_browser_connect_wait;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::status::{self, Output};
use crate::daemon::info::{self, DaemonInfo};
use crate::daemon::paths;
use crate::daemon::state::PROTOCOL_VERSION;

/// Chrome Web Store listing for the browser-skill extension.
const EXTENSION_STORE_URL: &str =
    "https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi";

/// Status of a single doctor check. `Ok` / `Fail` are the legacy two
/// states; `NotApplicable` (review M2) is reported as "N/A" in human
/// output and as `"status": "na"` in `--json` output, so a check that
/// has nothing to compare against (e.g. browsers protocol-compat with
/// zero connected browsers) does not falsely report green.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    #[default]
    Ok,
    Fail,
    /// The check could not run because its precondition is absent.
    /// Treated as informational and never flips an exit code.
    #[serde(rename = "na")]
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CheckResult {
    pub name: String,
    /// Pre-M2 boolean status, retained for backwards-compatible JSON
    /// consumers. `true` means the check passed or was not applicable
    /// (i.e. nothing flips the overall doctor verdict red); `false`
    /// means the check actively failed. New consumers should read the
    /// `status` field below for the tri-state (`ok` / `fail` / `na`)
    /// distinction — the legacy boolean intentionally collapses
    /// `ok` and `na` so a doctor run that includes an N/A check does
    /// not regress for callers that still consult `ok` only.
    pub ok: bool,
    /// Tri-state status (review M2): `ok` / `fail` / `na`.
    #[serde(default)]
    pub status: CheckStatus,
    pub detail: String,
    /// User-facing repair hint (only meaningful when `status` is
    /// `Fail`).
    pub hint: Option<String>,
}

impl CheckResult {
    fn ok(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ok: true,
            status: CheckStatus::Ok,
            detail: detail.into(),
            hint: None,
        }
    }

    fn fail(name: impl Into<String>, detail: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ok: false,
            status: CheckStatus::Fail,
            detail: detail.into(),
            hint: Some(hint.into()),
        }
    }

    fn na(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            // `ok = false` would falsely flip a green-build check
            // into a red one; `ok = true` is misleading because we
            // never actually ran the check. We deliberately surface
            // `true` here so legacy boolean readers do not fail the
            // overall doctor run, and rely on `status = "na"` to
            // communicate the truth to newer consumers (review M2).
            ok: true,
            status: CheckStatus::NotApplicable,
            detail: detail.into(),
            hint: None,
        }
    }
}

pub fn run(output: Output) -> Result<Vec<CheckResult>> {
    let state = resolve_daemon_state(output);
    let checks = collect_checks(state);
    match output {
        Output::Human => render_human(&checks),
        Output::Json => render_json(&checks)?,
    }
    Ok(checks)
}

/// Whether the rendered doctor report contains an active failure.
/// `NotApplicable` remains informational and must not change the exit code.
pub fn has_failures(checks: &[CheckResult]) -> bool {
    checks.iter().any(|check| check.status == CheckStatus::Fail)
}

/// Ensure the daemon is reachable and give the browser extension time to
/// connect before checks run. Returns a single [`DaemonState`] snapshot
/// for check evaluation.
fn resolve_daemon_state(output: Output) -> DaemonState {
    let mut state = current_state(Duration::ZERO);

    if matches!(state, DaemonState::Missing | DaemonState::StaleDead(_)) && ensure_daemon().is_err()
    {
        return current_state(Duration::ZERO);
    }

    if matches!(state, DaemonState::Missing | DaemonState::StaleDead(_)) {
        state = current_state(Duration::ZERO);
    }

    let wait = if needs_browser_wait(&state) {
        doctor_browser_connect_wait()
    } else {
        Duration::ZERO
    };

    if wait > Duration::ZERO && output == Output::Human {
        eprintln!("waiting for browser extension to connect…");
    }

    if wait.is_zero() {
        state
    } else {
        current_state(wait)
    }
}

fn needs_browser_wait(state: &DaemonState) -> bool {
    match state {
        DaemonState::Verified { status } => status.browsers.is_empty(),
        _ => false,
    }
}

/// What the disk + IPC says about a possibly-running daemon. Threaded
/// through every check so they share one snapshot.
enum DaemonState {
    /// No `daemon.json` at all.
    Missing,
    /// `daemon.json` exists but reading it failed.
    ReadError(String),
    /// `daemon.json` exists but its pid is not alive on this host.
    StaleDead(DaemonInfo),
    /// `daemon.json` exists, pid is alive, but IPC didn't answer.
    IpcUnreachable(DaemonInfo, String),
    /// `daemon.json` exists, IPC answered, but the pid reported by
    /// `system.status` does not match the pid recorded on disk. This
    /// usually means a stale `daemon.json` left over from a previous
    /// daemon points at a sock that now belongs to a different daemon.
    PidMismatch {
        info: DaemonInfo,
        status: StatusResult,
    },
    /// Everything lines up: pid alive + IPC answered + pid matches.
    Verified { status: StatusResult },
}

impl DaemonState {
    fn status(&self) -> Option<&StatusResult> {
        match self {
            DaemonState::Verified { status, .. } | DaemonState::PidMismatch { status, .. } => {
                Some(status)
            }
            _ => None,
        }
    }
}

fn collect_checks(state: DaemonState) -> Vec<CheckResult> {
    vec![
        check_home_writable(),
        check_skill_up_to_date(),
        check_daemon_running(&state),
        check_version_compatible(state.status()),
        check_extension_connected(state.status()),
        check_browsers_protocol_compatible(state.status()),
    ]
}

fn current_state(browser_wait: Duration) -> DaemonState {
    let info = match info::read() {
        Ok(Some(info)) => info,
        Ok(None) => return DaemonState::Missing,
        Err(err) => return DaemonState::ReadError(format!("{err:#}")),
    };
    if !crate::daemon::lockfile::pid_alive(info.pid) {
        return DaemonState::StaleDead(info);
    }
    match status::query_sock_with_wait(info.sock_path.clone(), browser_wait) {
        Ok(status) => {
            if status.pid == info.pid {
                DaemonState::Verified { status }
            } else {
                DaemonState::PidMismatch { info, status }
            }
        }
        Err(err) => DaemonState::IpcUnreachable(info, format!("{err}")),
    }
}

fn check_home_writable() -> CheckResult {
    let name = "bsk home writable";
    match paths::ensure_bsk_home() {
        Ok(home) => CheckResult::ok(name, home.display().to_string()),
        Err(err) => CheckResult::fail(
            name,
            format!("{err:#}"),
            "ensure $HOME or $BSK_HOME is writable",
        ),
    }
}

fn check_skill_up_to_date() -> CheckResult {
    let name = "agent skill up to date";
    let home = match crate::skill_install::harness::home_dir() {
        Ok(home) => home,
        Err(err) => {
            return CheckResult::fail(
                name,
                format!("cannot resolve $HOME: {err}"),
                "ensure $HOME is set",
            );
        }
    };
    let report = crate::skill_install::sync::sync_installed_skills(&home);

    if !report.errors.is_empty() {
        let detail = report
            .errors
            .iter()
            .map(|(h, msg)| format!("{}: {msg}", h.cli_name()))
            .collect::<Vec<_>>()
            .join("; ");
        return CheckResult::fail(
            name,
            detail,
            "re-run `bsk install-skill --force --harness <id>` for the failing harness",
        );
    }

    if !report.updated.is_empty() {
        let names = report
            .updated
            .iter()
            .map(|h| h.cli_name())
            .collect::<Vec<_>>()
            .join(", ");
        return CheckResult::ok(
            name,
            format!("synced {} harness(es): {names}", report.updated.len()),
        );
    }

    if !report.up_to_date.is_empty() {
        return CheckResult::ok(
            name,
            format!("up to date in {} harness(es)", report.up_to_date.len()),
        );
    }

    CheckResult::na(name, "no agent skill installed")
}

fn check_daemon_running(state: &DaemonState) -> CheckResult {
    let name = "daemon running";
    match state {
        DaemonState::Verified { status, .. } => CheckResult::ok(
            name,
            format!(
                "pid {} at ws://127.0.0.1:{} (sock {})",
                status.pid, status.ws_port, status.sock_path
            ),
        ),
        DaemonState::Missing => CheckResult::fail(
            name,
            "daemon.json not found",
            "run `bsk daemon start` or any `bsk` command (daemon is auto-spawned)",
        ),
        DaemonState::ReadError(err) => CheckResult::fail(
            name,
            format!("could not read daemon.json: {err}"),
            "check permissions on ~/.bsk",
        ),
        DaemonState::StaleDead(info) => CheckResult::fail(
            name,
            format!("daemon.json is stale (pid {} does not exist)", info.pid),
            "run `bsk daemon start` (or delete ~/.bsk/daemon.json)",
        ),
        DaemonState::IpcUnreachable(info, err) => CheckResult::fail(
            name,
            format!("pid {} is alive but IPC is unreachable: {err}", info.pid),
            "run `bsk daemon restart`, then check `bsk logs`",
        ),
        DaemonState::PidMismatch { info, status } => CheckResult::fail(
            name,
            format!(
                "daemon.json records pid {} but system.status returned pid {}",
                info.pid, status.pid
            ),
            "daemon.json is stale; run `bsk daemon stop && bsk status` to reset",
        ),
    }
}

fn check_version_compatible(status: Option<&StatusResult>) -> CheckResult {
    let name = "protocol compatible";
    let Some(status) = status else {
        return CheckResult::fail(name, "daemon status unavailable", "start the daemon first");
    };
    let ok = status.protocol_version == PROTOCOL_VERSION;
    if ok {
        CheckResult::ok(
            name,
            format!(
                "daemon protocol {} (app {})",
                status.protocol_version, status.daemon_version
            ),
        )
    } else {
        CheckResult::fail(
            name,
            format!(
                "daemon protocol {} (expected {}), app {}",
                status.protocol_version, PROTOCOL_VERSION, status.daemon_version
            ),
            "upgrade or restart bsk so CLI and daemon speak the same protocol version",
        )
    }
}

/// `bsk doctor` check: every connected browser should use the same
/// protocol version as the daemon. Minor protocol drift is accepted by
/// the daemon but flagged here so the user can see who needs updating
/// (M10.4).
///
/// Review M2 (round-1 minor): when no browsers are connected, the
/// check has nothing to compare against, so it now reports
/// [`CheckStatus::NotApplicable`] ("N/A") instead of falsely turning
/// green.
fn check_browsers_protocol_compatible(status: Option<&StatusResult>) -> CheckResult {
    let name = "browser protocol compatible";
    let Some(status) = status else {
        return CheckResult::fail(
            name,
            "daemon status unavailable",
            "start the daemon and load the extension first",
        );
    };
    if status.browsers.is_empty() {
        return CheckResult::na(name, "no browsers online, nothing to compare");
    }
    if status.version_skew_browsers.is_empty() {
        return CheckResult::ok(
            name,
            format!(
                "all {} online browser(s) are compatible with the daemon",
                status.browsers.len()
            ),
        );
    }
    let stale = status
        .version_skew_browsers
        .iter()
        .map(|s| {
            format!(
                "{} (protocol ext {} vs daemon {}, app ext v{} / daemon v{})",
                s.instance_id,
                display_protocol(&s.client_protocol_version),
                display_protocol(&s.server_protocol_version),
                s.client_version,
                s.server_version
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    CheckResult::fail(
        name,
        format!(
            "{} browser(s) have protocol minor drift from the daemon: {stale}",
            status.version_skew_browsers.len()
        ),
        "upgrade the browser-skill extension or bsk CLI so both sides use the same protocol version",
    )
}

fn display_protocol(value: &str) -> &str {
    if value.is_empty() { "unknown" } else { value }
}

fn check_extension_connected(status: Option<&StatusResult>) -> CheckResult {
    let name = "extension connected";
    let Some(status) = status else {
        return CheckResult::fail(
            name,
            "daemon status unavailable",
            "start the daemon and load the extension first",
        );
    };
    let browsers = status.browsers.len();
    if browsers > 0 {
        CheckResult::ok(name, format!("{} browser(s) connected", browsers))
    } else {
        CheckResult::fail(
            name,
            "0 browsers connected",
            format!("install the extension from {EXTENSION_STORE_URL} and load it in Chromium"),
        )
    }
}

/// Highlight known URLs in repair hints for terminal output. Plain
/// text is preserved in `--json` and in stored [`CheckResult::hint`].
fn style_hint(hint: &str) -> String {
    if !hint.contains(EXTENSION_STORE_URL) {
        return hint.to_string();
    }
    hint.replace(
        EXTENSION_STORE_URL,
        &style(EXTENSION_STORE_URL)
            .cyan()
            .bold()
            .underlined()
            .to_string(),
    )
}

fn render_human(checks: &[CheckResult]) {
    let name_width = checks
        .iter()
        .map(|c| c.name.chars().count())
        .max()
        .unwrap_or(0);
    for c in checks {
        let mark = match c.status {
            CheckStatus::Ok => "ok  ",
            CheckStatus::Fail => "FAIL",
            CheckStatus::NotApplicable => "N/A ",
        };
        let detail = match (&c.hint, c.status) {
            (Some(h), CheckStatus::Fail) => format!("{} — hint: {}", c.detail, style_hint(h)),
            _ => c.detail.clone(),
        };
        let name = &c.name;
        // Use chars().count() for padding (names are now ASCII).
        let pad = name_width.saturating_sub(name.chars().count());
        let padding = " ".repeat(pad);
        println!("{mark}  {name}{padding}  {detail}");
    }
}

fn render_json(checks: &[CheckResult]) -> Result<()> {
    let json = serde_json::to_string_pretty(checks)?;
    println!("{json}");
    Ok(())
}

#[cfg(test)]
mod m2_tests {
    use super::*;
    use bsk_protocol::StatusResult;
    use bsk_protocol::system::{BrowserStatusEntry, VersionSkewEntry};

    fn fake_status(browsers: Vec<BrowserStatusEntry>, skew: Vec<VersionSkewEntry>) -> StatusResult {
        StatusResult {
            daemon_version: env!("CARGO_PKG_VERSION").into(),
            protocol_version: "1.0".into(),
            pid: 1,
            uptime_secs: 0,
            ws_port: 0,
            sock_path: "/tmp/bsk.sock".into(),
            browsers,
            sessions: Vec::new(),
            version_skew_browsers: skew,
        }
    }

    #[test]
    fn extension_check_includes_store_url_when_no_browser_connected() {
        let status = fake_status(Vec::new(), Vec::new());
        let check = check_extension_connected(Some(&status));
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(check.detail.contains("0 browsers connected"));
        let hint = check
            .hint
            .expect("extension disconnected should include a hint");
        assert!(
            hint.contains(EXTENSION_STORE_URL),
            "hint should include Chrome Web Store URL: {hint}"
        );
    }

    #[test]
    fn only_active_failures_make_doctor_unsuccessful() {
        let healthy = vec![
            CheckResult::ok("ok", "ready"),
            CheckResult::na("optional", "not connected"),
        ];
        assert!(!has_failures(&healthy));

        let unhealthy = vec![
            CheckResult::ok("ok", "ready"),
            CheckResult::fail("broken", "not ready", "repair it"),
        ];
        assert!(has_failures(&unhealthy));
    }

    #[test]
    fn browsers_check_reports_na_when_no_browser_connected() {
        // Review M2: 0 browsers means there is nothing to compare
        // against; the check must surface `N/A`, not a false-positive
        // green.
        let status = fake_status(Vec::new(), Vec::new());
        let check = check_browsers_protocol_compatible(Some(&status));
        assert_eq!(check.status, CheckStatus::NotApplicable);
        assert!(check.detail.contains("no browsers online"));
        assert!(check.hint.is_none(), "N/A checks should not surface a hint");
    }

    #[test]
    fn browsers_check_reports_ok_when_all_compatible() {
        let status = fake_status(
            vec![BrowserStatusEntry {
                instance_id: "alpha".into(),
                browser_name: "chrome".into(),
                browser_version: "131".into(),
                extension_version: "0.1.0-dev.0".into(),
                label: "Personal".into(),
                session_count: 0,
                connected_at_ms: 1,
                version_skew: false,
                extension_protocol_version: "1.0".into(),
            }],
            Vec::new(),
        );
        let check = check_browsers_protocol_compatible(Some(&status));
        assert_eq!(check.status, CheckStatus::Ok);
        assert!(check.detail.contains("compatible with the daemon"));
    }

    #[test]
    fn browsers_check_reports_fail_when_skew_present() {
        let status = fake_status(
            vec![BrowserStatusEntry {
                instance_id: "alpha".into(),
                browser_name: "chrome".into(),
                browser_version: "131".into(),
                extension_version: "0.0.9".into(),
                label: "Personal".into(),
                session_count: 0,
                connected_at_ms: 1,
                version_skew: true,
                extension_protocol_version: "1.1".into(),
            }],
            vec![VersionSkewEntry {
                instance_id: "alpha".into(),
                browser_name: "chrome".into(),
                label: "Personal".into(),
                server_version: env!("CARGO_PKG_VERSION").into(),
                client_version: "0.0.9".into(),
                server_protocol_version: "1.0".into(),
                client_protocol_version: "1.1".into(),
            }],
        );
        let check = check_browsers_protocol_compatible(Some(&status));
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(check.detail.contains("alpha"));
        assert!(check.hint.is_some());
    }

    #[test]
    fn browsers_check_reports_unknown_protocol_for_legacy_skew_payloads() {
        let status = fake_status(
            vec![BrowserStatusEntry {
                instance_id: "legacy".into(),
                browser_name: "chrome".into(),
                browser_version: "131".into(),
                extension_version: "0.0.9".into(),
                label: "Legacy".into(),
                session_count: 0,
                connected_at_ms: 1,
                version_skew: true,
                extension_protocol_version: String::new(),
            }],
            vec![VersionSkewEntry {
                instance_id: "legacy".into(),
                browser_name: "chrome".into(),
                label: "Legacy".into(),
                server_version: env!("CARGO_PKG_VERSION").into(),
                client_version: "0.0.9".into(),
                server_protocol_version: String::new(),
                client_protocol_version: String::new(),
            }],
        );
        let check = check_browsers_protocol_compatible(Some(&status));
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(
            check
                .detail
                .contains("protocol ext unknown vs daemon unknown")
        );
    }

    /// `--json` consumers must see the tri-state literal `na`. We
    /// also keep `ok = true` for the N/A case so legacy boolean
    /// readers do not blow up — they just lose the distinction.
    #[test]
    fn na_check_serialises_with_status_na_and_legacy_ok_true() {
        let check = CheckResult::na("test", "nothing to check");
        let json = serde_json::to_value(&check).unwrap();
        assert_eq!(json["status"], serde_json::json!("na"));
        assert_eq!(json["ok"], serde_json::json!(true));
        assert_eq!(json["hint"], serde_json::Value::Null);
    }

    #[test]
    fn fail_check_serialises_with_status_fail_and_legacy_ok_false() {
        let check = CheckResult::fail("test", "broken", "please fix");
        let json = serde_json::to_value(&check).unwrap();
        assert_eq!(json["status"], serde_json::json!("fail"));
        assert_eq!(json["ok"], serde_json::json!(false));
        assert_eq!(json["hint"], serde_json::json!("please fix"));
    }
}
