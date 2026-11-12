//! `ensure_daemon()` — first-call auto-spawn used by every business
//! subcommand.
//!
//! Flow (per design §3.1):
//! 1. Verify the daemon over IPC and return its discovery info.
//! 2. Only if no endpoint is listening and auto-start is enabled, spawn
//!    the daemon directly through the shared background startup path,
//!    inheriting `BSK_HOME` if set, and poll for verified IPC readiness until
//!    [`SPAWN_DEADLINE`] elapses.
//! 3. If polling times out, return an error with hints.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};

use crate::cli::daemon::StartArgs;
use crate::daemon::info::{self as daemon_info, DaemonInfo};
use crate::daemon::probe::{self, PROBE_TIMEOUT, Probe};
use crate::daemon::start::start_background;
use crate::daemon::start_error::DaemonStartFailure;

/// Maximum time to wait for an auto-spawned daemon to become ready.
pub const SPAWN_DEADLINE: Duration = Duration::from_millis(3_000);

/// Tracks an unverified optimistic `sock_path` discovered directly from
/// `daemon.json` so `business_rpc` can fall back to `ensure_daemon()` if the
/// very first socket `connect()` fails before any request bytes are written.
static OPTIMISTIC_CANDIDATE_SOCK: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Maps a stale optimistic `sock_path` to the fresh `sock_path` started by
/// connect-time auto-spawn so multi-RPC commands in the same process reuse it.
static REDIRECTED_SOCK: Mutex<Option<(PathBuf, PathBuf)>> = Mutex::new(None);

/// Explicit opt-out for clients using a daemon managed by their host.
/// All other values preserve the default automatic startup behavior.
pub(crate) fn auto_start_enabled() -> bool {
    std::env::var_os("BSK_AUTO_START").as_deref() != Some(std::ffi::OsStr::new("0"))
}

pub(crate) fn mark_optimistic_candidate(sock: &Path) {
    *OPTIMISTIC_CANDIDATE_SOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner()) = Some(sock.to_path_buf());
}

pub(crate) fn take_optimistic_candidate(sock: &Path) -> bool {
    let mut guard = OPTIMISTIC_CANDIDATE_SOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if guard.as_deref() == Some(sock) {
        *guard = None;
        true
    } else {
        false
    }
}

pub(crate) fn record_redirected_sock(stale: &Path, fresh: &Path) {
    if stale != fresh {
        *REDIRECTED_SOCK.lock().unwrap_or_else(|p| p.into_inner()) =
            Some((stale.to_path_buf(), fresh.to_path_buf()));
    }
}

pub(crate) fn resolve_effective_sock(sock: &Path) -> PathBuf {
    REDIRECTED_SOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .filter(|(stale, _)| stale == sock)
        .map(|(_, fresh)| fresh.clone())
        .unwrap_or_else(|| sock.to_path_buf())
}

#[cfg(unix)]
fn optimistic_endpoint_present(sock_path: &Path) -> bool {
    sock_path.exists()
}

#[cfg(not(unix))]
fn optimistic_endpoint_present(sock_path: &Path) -> bool {
    !sock_path.as_os_str().is_empty()
}

/// Optimistic single-UDS fast path for business CLI commands:
/// When `daemon.json` exists, carries `protocol_version`, and its `sock_path`
/// exists on disk, validate protocol compatibility directly from `daemon.json`
/// without opening a separate `system.status` probe socket. If the subsequent
/// first `connect()` in `business_rpc` fails with `NotFound` /
/// `ConnectionRefused` (before writing any bytes), `business_rpc` falls back
/// to [`ensure_daemon_with_protocol`].
pub fn ensure_daemon_optimistic() -> Result<DaemonInfo> {
    let (info, protocol) = ensure_daemon_optimistic_with_protocol()?;
    super::business_rpc::check_daemon_protocol(&protocol)?;
    Ok(info)
}

pub(crate) fn ensure_daemon_optimistic_with_protocol() -> Result<(DaemonInfo, String)> {
    if let Ok(Some(info)) = daemon_info::read()
        && let Some(protocol) = info.protocol_version.clone()
        && optimistic_endpoint_present(&info.sock_path)
    {
        super::protocol::record_daemon_protocol(&info.sock_path, &protocol);
        mark_optimistic_candidate(&info.sock_path);
        return Ok((info, protocol));
    }
    ensure_daemon_with_protocol()
}

/// Return verified discovery info, starting a daemon only when its discovery
/// file or IPC listener is absent and auto-start is enabled.
/// Preserved for management commands (`status`, `doctor`, `daemon ensure`) that
/// require an immediate live probe without sending a follow-up business RPC.
pub fn ensure_daemon() -> Result<DaemonInfo> {
    let (info, protocol) = ensure_daemon_with_protocol()?;
    super::business_rpc::check_daemon_protocol(&protocol)?;
    Ok(info)
}

/// Same discovery and startup as [`ensure_daemon`], also returning the
/// daemon's protocol version so long-lived callers can check features per call.
pub(crate) fn ensure_daemon_with_protocol() -> Result<(DaemonInfo, String)> {
    let deadline = Instant::now() + SPAWN_DEADLINE;
    if let Probe::Ready(daemon) = probe::probe(PROBE_TIMEOUT)? {
        super::protocol::record_daemon_protocol(
            &daemon.info.sock_path,
            &daemon.status.protocol_version,
        );
        return Ok((daemon.info, daemon.status.protocol_version));
    }
    ensure!(auto_start_enabled(), DaemonStartFailure::AutoStartDisabled);
    let info = start_background(&StartArgs::default(), deadline)
        .context("automatic daemon startup failed")?;
    // A daemon this process just started runs this binary's protocol.
    let protocol = crate::daemon::state::PROTOCOL_VERSION.to_string();
    super::protocol::record_daemon_protocol(&info.sock_path, &protocol);
    Ok((info, protocol))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::paths::{BSK_HOME_ENV, ensure_bsk_home, test_env_lock};
    use tempfile::TempDir;

    #[test]
    fn optimistic_fastpath_reads_daemon_json_and_protocol_without_ipc_probe() {
        let _lock = test_env_lock();
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("bsk-home");
        unsafe {
            std::env::set_var(BSK_HOME_ENV, &home);
        }

        ensure_bsk_home().unwrap();
        let sock = home.join("run").join("daemon.sock");
        // Create placeholder endpoint file without binding any IPC listener:
        // `probe()` would fail/spawn here, proving `ensure_daemon_optimistic`
        // succeeds in 0 IPC round-trips purely from `daemon.json`.
        std::fs::write(&sock, b"").unwrap();
        let expected = DaemonInfo::now(std::process::id(), sock.clone(), 52999, "0.5.0")
            .with_protocol_version(crate::daemon::state::PROTOCOL_VERSION);
        daemon_info::write(&expected).unwrap();

        let (resolved, protocol) = ensure_daemon_optimistic_with_protocol().unwrap();
        assert_eq!(resolved.sock_path, sock);
        assert_eq!(protocol, crate::daemon::state::PROTOCOL_VERSION);
        assert!(take_optimistic_candidate(&sock));
        assert!(!take_optimistic_candidate(&sock));

        let fresh = home.join("run").join("fresh.sock");
        record_redirected_sock(&sock, &fresh);
        assert_eq!(resolve_effective_sock(&sock), fresh);

        unsafe {
            std::env::remove_var(BSK_HOME_ENV);
        }
    }
}
