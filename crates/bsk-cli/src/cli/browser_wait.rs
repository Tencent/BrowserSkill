//! Shared browser-connect wait durations for status/doctor/browsers commands.

use std::time::Duration;

use crate::daemon::browsers::EXTENSION_CONNECT_WAIT;

/// Default wait passed to daemon status/list RPCs when the registry is empty.
pub const DEFAULT_BROWSER_CONNECT_WAIT: Duration = EXTENSION_CONNECT_WAIT;
/// Keep CLI-side waits aligned with the daemon's IPC clamp so a bad env value
/// cannot inflate read timeouts after the daemon has already returned.
const MAX_BROWSER_CONNECT_WAIT: Duration = Duration::from_secs(60);

/// Browser wait for `bsk status` / `bsk browsers`. Override in tests via
/// `BSK_BROWSER_WAIT_MS`.
pub fn browser_connect_wait() -> Duration {
    wait_from_env("BSK_BROWSER_WAIT_MS").unwrap_or(DEFAULT_BROWSER_CONNECT_WAIT)
}

/// Browser wait for `bsk doctor`. Falls back to [`browser_connect_wait`] when
/// `BSK_DOCTOR_BROWSER_WAIT_MS` is unset so tests can shorten only doctor.
pub fn doctor_browser_connect_wait() -> Duration {
    wait_from_env("BSK_DOCTOR_BROWSER_WAIT_MS").unwrap_or_else(browser_connect_wait)
}

/// Encodes a wait duration for protocol params. A zero duration preserves the
/// legacy immediate-snapshot semantics.
pub fn wait_for_browser_ms(wait: Duration) -> Option<u64> {
    let wait = clamp_browser_wait(wait);
    if wait.is_zero() {
        None
    } else {
        Some(wait.as_millis() as u64)
    }
}

/// IPC call budget: the command's normal timeout, or browser wait plus
/// scheduling slack when a wait is requested.
pub fn browser_query_ipc_timeout(wait: Duration, default_timeout: Duration) -> Duration {
    let wait = clamp_browser_wait(wait);
    if wait.is_zero() {
        default_timeout
    } else {
        wait.saturating_add(Duration::from_secs(2))
    }
}

fn wait_from_env(key: &str) -> Option<Duration> {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|ms| clamp_browser_wait(Duration::from_millis(ms)))
}

fn clamp_browser_wait(wait: Duration) -> Duration {
    wait.min(MAX_BROWSER_CONNECT_WAIT)
}
