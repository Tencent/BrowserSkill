//! Handing a running daemon over to one started from a newly installed
//! executable.
//!
//! The outgoing daemon spawns its replacement while it still serves, then
//! releases the daemon lock, IPC endpoint and port but keeps running. It exits
//! only once a daemon other than itself answers status requests on the IPC
//! endpoint. If the replacement exits or is not ready in time, the outgoing
//! daemon puts the previous executable back, takes the lock again and resumes
//! serving on the same port. Browsers reconnect across the gap either way.

use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tracing::{error, info, warn};

use super::DaemonChild;
use crate::cli::update::Installed;
use crate::cli::update::state::{Recovery, UpdateLock, UpdateRecord};
use crate::daemon::lockfile::{self, DaemonLock};
use crate::daemon::paths;
use crate::daemon::probe::{self, PROBE_TIMEOUT, Probe};

/// How long the outgoing daemon waits for its replacement to answer.
pub(super) const HANDOVER_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a replacement waits for its predecessor to release the lock. It
/// starts counting before the predecessor has shut down, and is well above
/// [`HANDOVER_TIMEOUT`], so the predecessor decides when a handover failed.
pub(super) const REPLACEMENT_LOCK_WAIT: Duration = Duration::from_secs(60);
/// How long the outgoing daemon tries to take the lock back after a failure.
const RECLAIM_WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(50);
const FAILURE_REPORT_LIMIT: usize = 4096;

/// A replacement that has been spawned and waits for the daemon lock.
pub(crate) struct Pending {
    pub(super) child: DaemonChild,
    pub(super) child_pid: u32,
    pub(super) installed: Installed,
    pub(super) record: UpdateRecord,
    pub(super) _update_lock: UpdateLock,
}

pub(super) enum Finished {
    /// Another daemon serves, or none can; this process exits.
    Exit,
    /// The handover failed and this process serves again under the lock.
    Resume(DaemonLock),
}

/// Complete a handover once this process has stopped serving and released
/// the daemon lock.
pub(super) fn finish(mut pending: Pending) -> Finished {
    match wait_for_replacement(&mut pending.child, pending.child_pid, HANDOVER_TIMEOUT) {
        Ok((pid, version)) => {
            info!(pid, %version, "replacement daemon is serving; exiting");
            pending.record.succeed(Some((pid, version)));
            pending.installed.discard();
            Finished::Exit
        }
        Err(err) => {
            warn!(
                error = %format_args!("{err:#}"),
                "handover failed; restoring the previous executable"
            );
            recover(pending, &err)
        }
    }
}

/// Put the previous executable back and serve again. Restoring comes first,
/// so a daemon another client starts meanwhile runs the previous version too.
fn recover(pending: Pending, err: &anyhow::Error) -> Finished {
    let Pending {
        installed,
        mut record,
        ..
    } = pending;
    let restored = installed.restore();
    if let Err(restore) = &restored {
        error!(error = %format_args!("{restore:#}"), "could not restore the previous bsk executable");
    }
    let lock = match reclaim_lock() {
        Ok(lock) => lock,
        Err(lock_err) => {
            error!(error = %format_args!("{lock_err:#}"), "could not take the daemon lock back");
            None
        }
    };
    let daemon_serving = lock.is_some() || serving_daemon(std::process::id()).is_some();
    let recovery = match restored {
        Ok(()) => Recovery::Restored { daemon_serving },
        Err(_) => installed.restore_failed(),
    };
    record.fail(err, recovery);
    match lock {
        Some(lock) => {
            info!("resuming service with the previous version");
            Finished::Resume(lock)
        }
        None if daemon_serving => {
            info!("another daemon is serving; exiting");
            Finished::Exit
        }
        None => {
            error!("no daemon is serving after the failed handover; run `bsk daemon start`");
            Finished::Exit
        }
    }
}

/// Stop a replacement that has not taken over, and put the previous
/// executable back, when this daemon stops for another reason first.
pub(super) fn abandon(mut pending: Pending, reason: &str) {
    stop(&mut pending.child);
    let err = anyhow::anyhow!("handover abandoned: {reason}");
    let recovery = pending.installed.roll_back(|| Recovery::Restored {
        daemon_serving: false,
    });
    pending.record.fail(&err, recovery);
}

/// Wait until a daemon other than this process answers, failing as soon as
/// the replacement exits or `timeout` passes. Returns the serving daemon's
/// pid and version.
pub(super) fn wait_for_replacement(
    child: &mut DaemonChild,
    child_pid: u32,
    timeout: Duration,
) -> Result<(u32, String)> {
    let own_pid = std::process::id();
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(serving) = serving_daemon(own_pid) {
            return Ok(serving);
        }
        if let Some(status) = child.try_wait().context("check the replacement daemon")? {
            // Another client may have started a daemon from the new binary.
            if let Some(serving) = serving_daemon(own_pid) {
                return Ok(serving);
            }
            anyhow::bail!(
                "the replacement daemon (pid {child_pid}) exited with {status} before it was ready{}",
                startup_failure(child_pid)
            );
        }
        if Instant::now() >= deadline {
            stop(child);
            anyhow::bail!(
                "the replacement daemon (pid {child_pid}) was not ready within {timeout:?} and was stopped{}",
                startup_failure(child_pid)
            );
        }
        std::thread::sleep(POLL);
    }
}

/// A replacement that fails to start leaves the reason for its predecessor,
/// which reports it in the update record.
pub(super) fn report_startup_failure(err: &anyhow::Error) {
    if let Ok(path) = paths::replacement_failure_path(std::process::id()) {
        let _ = std::fs::write(path, format!("{err:#}"));
    }
}

/// `": <reason>"` from a replacement's startup failure report, if it left one.
fn startup_failure(pid: u32) -> String {
    let Ok(path) = paths::replacement_failure_path(pid) else {
        return String::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return String::new();
    };
    let _ = std::fs::remove_file(&path);
    let reason = String::from_utf8_lossy(&bytes[..bytes.len().min(FAILURE_REPORT_LIMIT)]);
    match reason.trim() {
        "" => String::new(),
        reason => format!(": {reason}"),
    }
}

fn serving_daemon(own_pid: u32) -> Option<(u32, String)> {
    match probe::probe(PROBE_TIMEOUT) {
        Ok(Probe::Ready(daemon)) if daemon.status.pid != own_pid => {
            Some((daemon.status.pid, daemon.status.daemon_version))
        }
        _ => None,
    }
}

/// `None` when another process keeps the lock: either it serves already, or
/// it stays stuck and this process cannot serve either.
fn reclaim_lock() -> Result<Option<DaemonLock>> {
    let deadline = Instant::now() + RECLAIM_WAIT;
    loop {
        match lockfile::acquire() {
            Ok(lock) => return Ok(Some(lock)),
            Err(err) if err.is::<lockfile::AlreadyLocked>() => {
                if Instant::now() >= deadline || serving_daemon(std::process::id()).is_some() {
                    return Ok(None);
                }
                std::thread::sleep(POLL);
            }
            Err(err) => return Err(err),
        }
    }
}

fn stop(child: &mut DaemonChild) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::daemon::test_support::isolated;

    fn spawn(script: &str) -> DaemonChild {
        std::process::Command::new("/bin/sh")
            .args(["-c", script])
            .spawn()
            .unwrap()
    }

    #[test]
    fn a_replacement_that_exits_early_fails_with_its_reported_reason() {
        isolated(
            concat!(
                module_path!(),
                "::a_replacement_that_exits_early_fails_with_its_reported_reason"
            ),
            || {
                paths::ensure_bsk_home().unwrap();
                let mut child = spawn("sleep 0.2; exit 3");
                let pid = child.id();
                let report = paths::replacement_failure_path(pid).unwrap();
                std::fs::write(&report, "bind WS server: address in use").unwrap();

                let error =
                    wait_for_replacement(&mut child, pid, Duration::from_secs(10)).unwrap_err();

                let error = format!("{error:#}");
                assert!(error.contains(&format!("pid {pid}")), "{error}");
                assert!(error.contains("before it was ready"), "{error}");
                assert!(error.contains("address in use"), "{error}");
                assert!(!report.exists(), "the report is consumed");
            },
        );
    }

    #[test]
    fn a_replacement_that_never_becomes_ready_is_stopped() {
        isolated(
            concat!(
                module_path!(),
                "::a_replacement_that_never_becomes_ready_is_stopped"
            ),
            || {
                paths::ensure_bsk_home().unwrap();
                let mut child = spawn("sleep 30");
                let pid = child.id();
                let started = Instant::now();

                let error =
                    wait_for_replacement(&mut child, pid, Duration::from_millis(300)).unwrap_err();

                assert!(started.elapsed() < Duration::from_secs(10));
                let error = format!("{error:#}");
                assert!(error.contains("was not ready within"), "{error}");
                assert!(
                    child.try_wait().unwrap().is_some(),
                    "the replacement must not linger and take over later"
                );
            },
        );
    }
}
