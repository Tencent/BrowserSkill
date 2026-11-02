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
use crate::cli::update::state::{Recovery, UpdateRecord};
use crate::daemon::info::DaemonInfo;
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
    /// The WS port this daemon serves, which the replacement must serve too.
    pub(super) port: u16,
    /// Holds the update lock until the handover is confirmed or undone.
    pub(super) installed: Installed,
    pub(super) record: UpdateRecord,
}

pub(super) enum Finished {
    /// Another daemon serves, or none can; this process exits.
    Exit,
    /// The handover failed and this process serves again under the lock, on
    /// `port`, the one it served before. `record` says so, and is confirmed
    /// once serving has resumed.
    Resume {
        lock: DaemonLock,
        record: Box<UpdateRecord>,
        port: u16,
    },
}

/// The daemon a waiter accepts as serving.
pub(crate) struct Expected<'a> {
    /// The WS port browsers connect to; `None` accepts any.
    pub(crate) port: Option<u16>,
    pub(crate) version: &'a str,
}

/// What one status probe found, judged against [`Expected`].
pub(super) enum Found {
    Serving(DaemonInfo),
    /// A daemon answers, but not the expected one.
    Other(String),
    Nothing,
}

/// Complete a handover once this process has stopped serving and released
/// the daemon lock.
pub(super) fn finish(mut pending: Pending) -> Finished {
    let own_pid = std::process::id();
    let target = pending.record.target_version.clone();
    let expected = Expected {
        port: Some(pending.port),
        version: &target,
    };
    let waited = wait_until_serving(
        &mut pending.child,
        pending.child_pid,
        HANDOVER_TIMEOUT,
        || observe(Some(own_pid), &expected),
    );
    match waited {
        Ok(daemon) => {
            info!(pid = daemon.pid, version = %daemon.version, "replacement daemon is serving; exiting");
            pending.record.succeed(Some((daemon.pid, daemon.version)));
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
/// The record claims a serving daemon only for one that already serves the
/// original port; a resumed one confirms it after publishing `daemon.json`.
fn recover(pending: Pending, err: &anyhow::Error) -> Finished {
    let Pending {
        installed,
        mut record,
        port,
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
    let daemon_serving = lock.is_none() && serving_on(port);
    record.fail(
        err,
        match restored {
            Ok(()) => Recovery::Restored { daemon_serving },
            Err(_) => installed.restore_failed(),
        },
    );
    match lock {
        Some(lock) => {
            info!("resuming service with the previous version");
            Finished::Resume {
                lock,
                record: Box::new(record),
                port,
            }
        }
        None if daemon_serving => {
            info!("another daemon serves the port; exiting");
            Finished::Exit
        }
        None => {
            error!("no daemon serves the port after the failed handover; run `bsk daemon start`");
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

/// Wait until `observe` finds the expected daemon serving, failing as soon as
/// `child` exits or `timeout` passes; a child still running then is stopped
/// and reaped, so it releases whatever it holds. Another client may start
/// the expected daemon meanwhile, which counts; one that answers with another
/// version or port does not, and is named in the error.
pub(super) fn wait_until_serving(
    child: &mut DaemonChild,
    child_pid: u32,
    timeout: Duration,
    mut observe: impl FnMut() -> Found,
) -> Result<DaemonInfo> {
    let deadline = Instant::now() + timeout;
    let mut other = None;
    let mut look = |other: &mut Option<String>| match observe() {
        Found::Serving(daemon) => Some(daemon),
        Found::Other(found) => {
            *other = Some(found);
            None
        }
        Found::Nothing => None,
    };
    loop {
        if let Some(daemon) = look(&mut other) {
            return Ok(daemon);
        }
        if let Some(status) = child.try_wait().context("check the new daemon")? {
            if let Some(daemon) = look(&mut other) {
                return Ok(daemon);
            }
            anyhow::bail!(
                "the new daemon (pid {child_pid}) exited with {status} before it was ready{}{}",
                startup_failure(child_pid),
                describe_other(other.as_deref())
            );
        }
        if Instant::now() >= deadline {
            stop(child);
            anyhow::bail!(
                "the new daemon (pid {child_pid}) was not ready within {timeout:?} and was stopped{}{}",
                startup_failure(child_pid),
                describe_other(other.as_deref())
            );
        }
        std::thread::sleep(POLL);
    }
}

fn describe_other(other: Option<&str>) -> String {
    other.map_or_else(String::new, |other| {
        format!("; meanwhile a different daemon answered: {other}")
    })
}

/// Probe the IPC endpoint once. `exclude` is a daemon that never counts,
/// such as the one handing over.
pub(super) fn observe(exclude: Option<u32>, expected: &Expected<'_>) -> Found {
    match probe::probe(PROBE_TIMEOUT) {
        Ok(Probe::Ready(daemon)) if Some(daemon.status.pid) != exclude => judge(
            daemon.status.pid,
            &daemon.status.daemon_version,
            daemon.status.ws_port,
            expected,
        )
        .map_or_else(Found::Other, |()| Found::Serving(daemon.info)),
        _ => Found::Nothing,
    }
}

/// Whether a daemon answering as `pid`, `version` on `port` is the expected
/// one; if not, a description of what answered instead.
fn judge(pid: u32, version: &str, port: u16, expected: &Expected<'_>) -> Result<(), String> {
    let port_matches = expected.port.is_none_or(|expected| expected == port);
    if version == expected.version && port_matches {
        return Ok(());
    }
    Err(format!(
        "pid {pid}, bsk {version} on port {port}, expected bsk {}{}",
        expected.version,
        expected
            .port
            .map(|port| format!(" on port {port}"))
            .unwrap_or_default()
    ))
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

/// Whether some daemon other than this process serves `port`.
fn serving_on(port: u16) -> bool {
    matches!(
        probe::probe(PROBE_TIMEOUT),
        Ok(Probe::Ready(daemon))
            if daemon.status.pid != std::process::id() && daemon.status.ws_port == port
    )
}

/// `None` when another process keeps the lock: either it serves already, or
/// it stays stuck and this process cannot serve either.
fn reclaim_lock() -> Result<Option<DaemonLock>> {
    let deadline = Instant::now() + RECLAIM_WAIT;
    loop {
        match lockfile::acquire() {
            Ok(lock) => return Ok(Some(lock)),
            Err(err) if err.is::<lockfile::AlreadyLocked>() => {
                if Instant::now() >= deadline {
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

#[cfg(test)]
mod judge_tests {
    use super::*;

    #[test]
    fn only_the_expected_version_on_the_expected_port_counts() {
        let expected = Expected {
            port: Some(52719),
            version: "999.0.0",
        };
        assert!(judge(7, "999.0.0", 52719, &expected).is_ok());
        let other = judge(7, "0.3.1", 52720, &expected).unwrap_err();
        assert_eq!(
            other,
            "pid 7, bsk 0.3.1 on port 52720, expected bsk 999.0.0 on port 52719"
        );
        assert!(
            judge(7, "0.3.1", 52719, &expected).is_err(),
            "wrong version"
        );
        assert!(judge(7, "999.0.0", 52800, &expected).is_err(), "wrong port");

        let any_port = Expected {
            port: None,
            version: "999.0.0",
        };
        assert!(judge(7, "999.0.0", 40000, &any_port).is_ok());
    }
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

    fn serving(pid: u32) -> DaemonInfo {
        DaemonInfo::now(pid, "sock".into(), 52719, "999.0.0")
    }

    #[test]
    fn the_expected_daemon_counts_even_when_another_client_started_it() {
        let mut child = spawn("sleep 30");
        let pid = child.id();
        let mut probes = 0;

        let daemon = wait_until_serving(&mut child, pid, Duration::from_secs(10), || {
            probes += 1;
            if probes < 3 {
                Found::Nothing
            } else {
                Found::Serving(serving(4242))
            }
        })
        .unwrap();

        assert_eq!(daemon.pid, 4242);
        stop(&mut child);
    }

    #[test]
    fn a_different_daemon_answering_is_not_a_successful_handover() {
        isolated(
            concat!(
                module_path!(),
                "::a_different_daemon_answering_is_not_a_successful_handover"
            ),
            || {
                let mut child = spawn("sleep 0.3; exit 1");
                let pid = child.id();

                let error = wait_until_serving(&mut child, pid, Duration::from_secs(10), || {
                    Found::Other(
                        "pid 9, bsk 0.3.1 on port 52720, expected bsk 999.0.0 on port 52719".into(),
                    )
                })
                .unwrap_err();

                let error = format!("{error:#}");
                assert!(error.contains("exited with"), "{error}");
                assert!(
                    error.contains("a different daemon answered: pid 9, bsk 0.3.1 on port 52720"),
                    "{error}"
                );
            },
        );
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
                    wait_until_serving(&mut child, pid, Duration::from_secs(10), || Found::Nothing)
                        .unwrap_err();

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

                let error = wait_until_serving(&mut child, pid, Duration::from_millis(300), || {
                    Found::Nothing
                })
                .unwrap_err();

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
