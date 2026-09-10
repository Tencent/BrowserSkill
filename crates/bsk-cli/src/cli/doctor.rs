//! `bsk doctor` — guided diagnostics + repair hints.

use std::time::Duration;

use anyhow::Result;
use bsk_protocol::StatusResult;
use console::style;
use serde::Serialize;

use crate::cli::browser_wait::{
    browser_query_ipc_timeout, doctor_browser_connect_wait, wait_for_browser_ms,
};
use crate::cli::ensure_daemon::{AUTO_START_DISABLED_HINT, auto_start_enabled, ensure_daemon};
use crate::cli::status::Output;
use crate::daemon::info::DaemonInfo;
use crate::daemon::paths;
use crate::daemon::probe::{self, Probe};
use crate::daemon::state::PROTOCOL_VERSION;

/// Chrome Web Store listing for the browser-skill extension.
const EXTENSION_STORE_URL: &str =
    "https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi";

/// Edge Add-ons listing for the browser-skill extension.
const EXTENSION_STORE_URL_EDGE: &str = "https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg";

/// Store listings highlighted in repair hints, in the order they appear.
const EXTENSION_STORE_URLS: [&str; 2] = [EXTENSION_STORE_URL, EXTENSION_STORE_URL_EDGE];

/// A warning needs attention but does not fail the overall health check.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    #[default]
    Ok,
    Fail,
    #[serde(rename = "warn")]
    Warning,
    /// The check could not run because its precondition is absent.
    /// Treated as informational and never flips an exit code.
    #[serde(rename = "na")]
    NotApplicable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CheckResult {
    pub name: String,
    /// Backwards-compatible verdict: only a failure is false. Read `status`
    /// to distinguish a warning or a check that is not applicable.
    pub ok: bool,
    /// `ok`, `fail`, `warn`, or `na`.
    #[serde(default)]
    pub status: CheckStatus,
    pub detail: String,
    /// Actionable guidance for a failure or warning.
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

    fn warn(name: impl Into<String>, detail: impl Into<String>, hint: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ok: true,
            status: CheckStatus::Warning,
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
/// Warnings and `NotApplicable` remain informational and do not change the exit code.
pub fn has_failures(checks: &[CheckResult]) -> bool {
    checks.iter().any(|check| check.status == CheckStatus::Fail)
}

/// Ensure the daemon is reachable and give the browser extension time to
/// connect before checks run. Returns a single [`DaemonState`] snapshot
/// for check evaluation.
fn resolve_daemon_state(output: Output) -> DaemonState {
    let mut state = current_state(Duration::ZERO);

    if matches!(state, DaemonState::Missing | DaemonState::NoListener(_)) && auto_start_enabled() {
        if let Err(err) = ensure_daemon() {
            return DaemonState::ProbeError(format!("{err:#}"));
        }
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
        DaemonState::Verified { status, .. } => status.browsers.is_empty(),
        _ => false,
    }
}

/// What the disk + IPC says about a possibly-running daemon. Threaded
/// through every check so they share one snapshot.
enum DaemonState {
    Missing,
    NoListener(DaemonInfo),
    ProbeError(String),
    Verified {
        status: StatusResult,
        local_identity_error: Option<String>,
    },
}

impl DaemonState {
    fn status(&self) -> Option<&StatusResult> {
        match self {
            DaemonState::Verified { status, .. } => Some(status),
            _ => None,
        }
    }
}

fn collect_checks(state: DaemonState) -> Vec<CheckResult> {
    vec![
        check_home_writable(),
        check_skill_up_to_date(),
        check_daemon_running(&state),
        check_daemon_management(&state),
        check_version_compatible(state.status()),
        check_extension_connected(state.status()),
        check_browsers_protocol_compatible(state.status()),
    ]
}

fn current_state(browser_wait: Duration) -> DaemonState {
    let params = bsk_protocol::StatusParams {
        wait_for_browser_ms: wait_for_browser_ms(browser_wait),
    };
    let timeout = browser_query_ipc_timeout(browser_wait, Duration::from_secs(2));
    match probe::probe_with_params(timeout, params) {
        Ok(Probe::Ready(daemon)) => DaemonState::Verified {
            local_identity_error: daemon
                .require_local_pid()
                .err()
                .map(|err| format!("{err:#}")),
            status: daemon.status,
        },
        Ok(Probe::Absent(Some(info))) => DaemonState::NoListener(info),
        Ok(Probe::Absent(None)) => DaemonState::Missing,
        Err(err) => DaemonState::ProbeError(format!("{err:#}")),
    }
}

fn check_home_writable() -> CheckResult {
    let name = "bsk home writable";
    match paths::ensure_bsk_home() {
        Ok(home) => CheckResult::ok(name, home.display().to_string()),
        Err(err) => CheckResult::fail(name, format!("{err:#}"), paths::BSK_HOME_HINT),
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

    skill_check_from_report(&report)
}

fn skill_check_from_report(report: &crate::skill_install::sync::SyncReport) -> CheckResult {
    let name = "agent skill up to date";
    let mut details = Vec::new();
    for (label, harnesses) in [
        ("synced", &report.updated),
        ("up to date", &report.up_to_date),
        (
            "custom skill preserved (automatic updates disabled) in",
            &report.protected,
        ),
        ("busy, sync deferred in", &report.busy),
    ] {
        if !harnesses.is_empty() {
            let names = harnesses
                .iter()
                .map(|h| h.cli_name())
                .collect::<Vec<_>>()
                .join(", ");
            details.push(format!("{label}: {names}"));
        }
    }
    let mut hints = Vec::new();
    for (harness, reason) in &report.paused {
        let id = harness.cli_name();
        details.push(format!(
            "automatic updates paused for {id}: {}; content preserved",
            reason.description()
        ));
        hints.push(format!(
            "{id}: keep your instructions with `bsk install-skill --harness {id} --source <existing-SKILL.md> --force`, or restore the bundled skill with `bsk install-skill --harness {id} --force` (overwrites existing instructions)"
        ));
    }
    for (harness, message) in &report.errors {
        details.push(format!("sync failed for {}: {message}", harness.cli_name()));
    }
    let detail = details.join("; ");

    if !report.errors.is_empty() {
        hints.insert(
            0,
            "check filesystem access for the failing harness, then re-run `bsk doctor`".into(),
        );
        CheckResult::fail(name, detail, hints.join("; "))
    } else if !report.paused.is_empty() {
        CheckResult::warn(name, detail, hints.join("; "))
    } else if !report.updated.is_empty() || !report.up_to_date.is_empty() {
        CheckResult::ok(name, detail)
    } else if !details.is_empty() {
        CheckResult::na(name, detail)
    } else {
        CheckResult::na(name, "no agent skill installed")
    }
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
            if auto_start_enabled() {
                "run `bsk daemon start` or any `bsk` command (daemon is auto-spawned)"
            } else {
                AUTO_START_DISABLED_HINT
            },
        ),
        DaemonState::NoListener(info) => CheckResult::fail(
            name,
            format!(
                "no daemon listening at {} (recorded pid {})",
                info.sock_path.display(),
                info.pid
            ),
            if auto_start_enabled() {
                "run `bsk daemon start`; check `bsk logs` if startup fails"
            } else {
                AUTO_START_DISABLED_HINT
            },
        ),
        DaemonState::ProbeError(err) => CheckResult::fail(
            name,
            err.clone(),
            "check daemon IPC permissions and `bsk logs`; keep existing runtime files",
        ),
    }
}

fn check_daemon_management(state: &DaemonState) -> CheckResult {
    let name = "daemon local process identity";
    match state {
        DaemonState::Verified {
            local_identity_error: Some(err),
            ..
        } => CheckResult::warn(
            name,
            format!("IPC is available, but local process identity is unverified: {err}"),
            "the daemon may be in another PID namespace, or IPC peer identity may be unavailable; browser commands can use IPC; run daemon management commands in the owning host environment",
        ),
        DaemonState::Verified { .. } => {
            CheckResult::ok(name, "IPC peer PID matches daemon identity")
        }
        _ => CheckResult::na(name, "daemon IPC is unavailable"),
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

/// `bsk doctor` check: connected browsers should speak a protocol the
/// daemon accepts. A different protocol string is still a live
/// connection — report Ok so agents keep working. The detail is an
/// upgrade reminder, not a blocker.
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
    CheckResult::ok(
        name,
        format!(
            "{} browser(s) report a different protocol version (still usable — continue, and upgrade soon): {stale}",
            status.version_skew_browsers.len()
        ),
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
            format!(
                "install the extension from {EXTENSION_STORE_URL} (Chrome) \
                 or {EXTENSION_STORE_URL_EDGE} (Edge) and load it in the browser"
            ),
        )
    }
}

/// Highlight known URLs in repair hints for terminal output. Plain
/// text is preserved in `--json` and in stored [`CheckResult::hint`].
fn style_hint(hint: &str) -> String {
    let mut styled = hint.to_string();
    for url in EXTENSION_STORE_URLS {
        if !styled.contains(url) {
            continue;
        }
        styled = styled.replace(url, &style(url).cyan().bold().underlined().to_string());
    }
    styled
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
            CheckStatus::Warning => "WARN",
            CheckStatus::NotApplicable => "N/A ",
        };
        let detail = match (&c.hint, c.status) {
            (Some(h), CheckStatus::Fail | CheckStatus::Warning) => {
                format!("{} — hint: {}", c.detail, style_hint(h))
            }
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
    fn unverified_local_identity_warns_without_failing_usable_ipc() {
        let state = DaemonState::Verified {
            status: fake_status(Vec::new(), Vec::new()),
            local_identity_error: Some("peer identity is unavailable".into()),
        };
        let running = check_daemon_running(&state);
        let management = check_daemon_management(&state);
        assert_eq!(running.status, CheckStatus::Ok);
        assert_eq!(management.status, CheckStatus::Warning);
        assert!(management.detail.contains("IPC is available"));
        assert!(!has_failures(&[running, management]));
    }

    #[test]
    fn skill_check_reports_protected_harnesses_with_managed_results() {
        use crate::skill_install::{HarnessId, sync::SyncReport};
        for updated in [true, false] {
            let mut report = SyncReport {
                protected: vec![HarnessId::Cursor],
                ..Default::default()
            };
            if updated {
                report.updated.push(HarnessId::ClaudeCode);
            } else {
                report.up_to_date.push(HarnessId::ClaudeCode);
            }
            let check = skill_check_from_report(&report);
            assert_eq!(check.status, CheckStatus::Ok);
            assert!(check.detail.contains("claude-code"));
            assert!(
                check
                    .detail
                    .contains("preserved (automatic updates disabled) in: cursor")
            );
            let json = serde_json::to_value(&check).unwrap();
            assert_eq!(json["status"], "ok");
            assert!(
                json["detail"]
                    .as_str()
                    .unwrap()
                    .contains("preserved (automatic updates disabled) in: cursor")
            );
        }
    }

    #[test]
    fn skill_check_keeps_all_outcomes_when_another_harness_fails() {
        use crate::skill_install::{HarnessId, sync::SyncReport};
        let check = skill_check_from_report(&SyncReport {
            updated: vec![HarnessId::ClaudeCode],
            up_to_date: vec![HarnessId::PiAgent],
            protected: vec![HarnessId::Cursor],
            busy: vec![HarnessId::Hermes],
            errors: vec![(HarnessId::Workbuddy, "permission denied".into())],
            paused: Vec::new(),
        });
        assert_eq!(check.status, CheckStatus::Fail);
        for text in [
            "synced: claude-code",
            "up to date: pi",
            "preserved (automatic updates disabled) in: cursor",
            "sync deferred in: hermes",
            "workbuddy: permission denied",
        ] {
            assert!(check.detail.contains(text), "{}", check.detail);
        }
        assert!(!check.hint.unwrap().contains("--force"));
    }

    #[test]
    fn paused_skills_warn_with_actions_even_alongside_successful_updates() {
        use crate::skill_install::{
            HarnessId,
            sync::{PauseReason, SyncReport},
        };
        for reason in [
            PauseReason::Untracked,
            PauseReason::MissingBaseline,
            PauseReason::LocalChanges,
            PauseReason::InvalidMarker,
        ] {
            for updated in [false, true] {
                let mut report = SyncReport {
                    paused: vec![(HarnessId::Cursor, reason)],
                    ..Default::default()
                };
                if updated {
                    report.updated.push(HarnessId::ClaudeCode);
                }
                let check = skill_check_from_report(&report);
                assert_eq!(check.status, CheckStatus::Warning);
                assert!(check.detail.contains("automatic updates paused for cursor"));
                assert!(check.detail.contains(reason.description()));
                if updated {
                    assert!(check.detail.contains("synced: claude-code"));
                }
                assert!(!has_failures(std::slice::from_ref(&check)));
                let json = serde_json::to_value(&check).unwrap();
                assert_eq!(json["status"], "warn");
                assert_eq!(json["ok"], true);
                let hint = json["hint"].as_str().unwrap();
                assert!(hint.contains("--harness cursor --source <existing-SKILL.md> --force"));
                assert!(hint.contains("--harness cursor --force"));
                assert!(hint.contains("overwrites existing instructions"));
                // An I/O failure takes precedence without hiding paused installations.
                report
                    .errors
                    .push((HarnessId::PiAgent, "permission denied".into()));
                let failed = skill_check_from_report(&report);
                assert_eq!(failed.status, CheckStatus::Fail);
                assert!(
                    failed
                        .detail
                        .contains("automatic updates paused for cursor")
                );
                assert!(failed.hint.as_ref().unwrap().contains("--harness cursor"));
                assert!(has_failures(&[failed]));
            }
        }
    }

    #[test]
    fn protected_or_busy_skills_are_informational() {
        use crate::skill_install::{HarnessId, sync::SyncReport};
        for report in [
            SyncReport {
                protected: vec![HarnessId::Cursor],
                ..Default::default()
            },
            SyncReport {
                busy: vec![HarnessId::Cursor],
                ..Default::default()
            },
        ] {
            let check = skill_check_from_report(&report);
            assert_eq!(check.status, CheckStatus::NotApplicable);
            assert!(check.detail.contains("cursor"));
            assert!(!has_failures(std::slice::from_ref(&check)));
            assert_eq!(serde_json::to_value(&check).unwrap()["status"], "na");
        }
        let empty = skill_check_from_report(&SyncReport::default());
        assert_eq!(empty.status, CheckStatus::NotApplicable);
        assert_eq!(empty.detail, "no agent skill installed");
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
        assert!(
            hint.contains(EXTENSION_STORE_URL_EDGE),
            "hint should include Edge Add-ons URL: {hint}"
        );
    }

    #[test]
    fn style_hint_preserves_every_store_url() {
        let hint = check_extension_connected(Some(&fake_status(Vec::new(), Vec::new())))
            .hint
            .expect("extension disconnected should include a hint");
        let styled = style_hint(&hint);
        // Whether or not the terminal accepts colors, styling must never drop or
        // mangle a URL the user has to click.
        for url in EXTENSION_STORE_URLS {
            assert!(
                styled.contains(url),
                "styled hint should still contain {url}: {styled}"
            );
        }
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
    fn browsers_check_reports_ok_when_skew_present() {
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
        assert_eq!(check.status, CheckStatus::Ok);
        assert!(check.detail.contains("alpha"));
        assert!(
            check
                .detail
                .contains("still usable — continue, and upgrade soon")
        );
        assert!(
            check.hint.is_none(),
            "a protocol-version note must not hint to stop"
        );
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
        assert_eq!(check.status, CheckStatus::Ok);
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
