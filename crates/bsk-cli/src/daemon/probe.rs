//! Read-only daemon discovery. IPC proves availability; a PID is meaningful
//! only in the namespace that reported it. Only a missing endpoint permits
//! auto-start; access errors, timeouts and invalid replies must remain errors.

use std::io::ErrorKind;
use std::time::Duration;

use anyhow::{Context, Result};
use bsk_protocol::{Method, StatusParams, StatusResult};

use super::info::{self, DaemonInfo};
use crate::ipc_client::Client;

pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

pub(crate) enum Probe {
    /// No discovery file, or its endpoint has no listener. This does not
    /// authorize removing files: startup/cleanup must still acquire the lock.
    Absent(Option<DaemonInfo>),
    Ready(Box<VerifiedDaemon>),
}

pub(crate) struct VerifiedDaemon {
    pub info: DaemonInfo,
    pub status: StatusResult,
    pub client: Client,
}

#[derive(Debug, thiserror::Error)]
enum DiscoveryRace {
    #[error(
        "daemon.json pid {expected} does not match IPC daemon pid {actual}; retry after daemon startup completes"
    )]
    PidMismatch { expected: u32, actual: u32 },
    #[error("daemon discovery changed during verification; retry after daemon startup completes")]
    Changed,
}

impl VerifiedDaemon {
    /// File/RPC PID agreement does not authorize signaling that number in
    /// this namespace. Check the kernel's view of the connected peer as well.
    pub fn require_local_pid(&self) -> Result<u32> {
        let peer_pid = self
            .client
            .peer_pid()
            .context("read daemon IPC peer identity")?;
        let pid = self.info.pid;
        anyhow::ensure!(
            pid > 0 && peer_pid == Some(pid),
            "cannot verify local daemon process {pid} (IPC peer pid {peer_pid:?}); refusing to signal it; manage the daemon from its host"
        );
        Ok(pid)
    }
}

pub(crate) fn probe(timeout: Duration) -> Result<Probe> {
    probe_with_params(timeout, StatusParams::default())
}

pub(crate) fn probe_with_params(timeout: Duration, params: StatusParams) -> Result<Probe> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build runtime for daemon discovery")?
        .block_on(probe_async(timeout, params))
}

pub(crate) async fn probe_async(timeout: Duration, params: StatusParams) -> Result<Probe> {
    // Covers connect (including a busy Windows pipe), RPC write/read and the
    // single metadata-race retry together, rather than resetting each budget.
    tokio::time::timeout(timeout, async {
        for attempt in 0..2 {
            let Some(info) = info::read().context("read daemon discovery file")? else {
                return Ok(Probe::Absent(None));
            };
            let result = query(&info, &params, timeout).await;
            let unchanged = super::info::read()?.as_ref() == Some(&info);
            let mismatch = result
                .as_ref()
                .ok()
                .and_then(|reply| reply.as_ref())
                .filter(|(_, status)| status.pid != info.pid)
                .map(|(_, status)| status.pid);
            if unchanged && mismatch.is_none() {
                return match result? {
                    Some((client, status)) => Ok(Probe::Ready(Box::new(VerifiedDaemon {
                        info,
                        status,
                        client,
                    }))),
                    None => Ok(Probe::Absent(Some(info))),
                };
            }
            if attempt == 0 {
                // A replacement may have bound the endpoint just before
                // publishing its metadata. Re-read; never accept a mismatch.
                tokio::time::sleep(Duration::from_millis(25)).await;
                continue;
            }
            if let Some(actual_pid) = mismatch {
                return Err(DiscoveryRace::PidMismatch {
                    expected: info.pid,
                    actual: actual_pid,
                }
                .into());
            }
            return Err(DiscoveryRace::Changed.into());
        }
        unreachable!("the final attempt always returns")
    })
    .await
    .with_context(|| {
        format!("daemon IPC probe timed out after {timeout:?}; existing daemon may be unresponsive")
    })?
}

async fn query(
    info: &DaemonInfo,
    params: &StatusParams,
    timeout: Duration,
) -> Result<Option<(Client, StatusResult)>> {
    let mut client = match Client::connect_path(info.sock_path.clone()).await {
        Ok(client) => client,
        Err(err) if endpoint_absent(&err) => return Ok(None),
        Err(err) => return Err(err.context("connect to existing daemon")),
    };
    let status = client
        .call::<_, StatusResult>(Method::SystemStatus, params, timeout)
        .await
        .context("query existing daemon status")?
        .map_err(|err| {
            anyhow::anyhow!(
                "daemon verification RPC failed: {} ({:?})",
                err.message,
                err.code
            )
        })?;
    Ok(Some((client, status)))
}

fn endpoint_absent(err: &anyhow::Error) -> bool {
    err.downcast_ref::<std::io::Error>().is_some_and(|err| {
        matches!(
            err.kind(),
            ErrorKind::NotFound | ErrorKind::ConnectionRefused
        )
    })
}

/// After spawning, tolerate timeouts and discovery races until the caller's
/// deadline. This only probes: it never authorizes another spawn. Permission
/// and protocol errors remain terminal, just as they are during discovery.
pub(crate) fn wait_for_ready(timeout: Duration) -> Result<Box<VerifiedDaemon>> {
    let deadline = std::time::Instant::now() + timeout;
    let mut last_error = None;
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            let message =
                format!("daemon failed to become ready within {timeout:?}; check `bsk logs`");
            return Err(match last_error {
                Some(err) => anyhow::Error::context(err, message),
                None => anyhow::anyhow!(message),
            });
        }
        match probe(remaining.min(PROBE_TIMEOUT)) {
            Ok(Probe::Ready(daemon)) => return Ok(daemon),
            Ok(Probe::Absent(_)) => {}
            Err(err) if retryable_during_startup(&err) => last_error = Some(err),
            Err(err) => return Err(err),
        }
        std::thread::sleep(
            Duration::from_millis(25)
                .min(deadline.saturating_duration_since(std::time::Instant::now())),
        );
    }
}

fn retryable_during_startup(err: &anyhow::Error) -> bool {
    err.is::<DiscoveryRace>()
        || err.is::<tokio::time::error::Elapsed>()
        || err
            .downcast_ref::<std::io::Error>()
            .is_some_and(|err| err.kind() == ErrorKind::TimedOut)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_missing_or_refused_connections_allow_startup() {
        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::TimedOut,
            ErrorKind::WouldBlock,
            ErrorKind::ConnectionReset,
            ErrorKind::InvalidData,
        ] {
            let err = anyhow::Error::new(std::io::Error::from(kind)).context("connect IPC");
            assert!(!endpoint_absent(&err), "{kind:?} must not permit startup");
        }
        for kind in [ErrorKind::NotFound, ErrorKind::ConnectionRefused] {
            let err = anyhow::Error::new(std::io::Error::from(kind)).context("connect IPC");
            assert!(endpoint_absent(&err));
        }
    }

    #[test]
    fn startup_retries_only_timeouts_and_discovery_races() {
        for err in [
            anyhow::Error::new(DiscoveryRace::Changed),
            DiscoveryRace::PidMismatch {
                expected: 1,
                actual: 2,
            }
            .into(),
            std::io::Error::from(ErrorKind::TimedOut).into(),
        ] {
            assert!(retryable_during_startup(&err.context("probe")));
        }
        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::InvalidData,
            ErrorKind::ConnectionReset,
        ] {
            assert!(!retryable_during_startup(
                &std::io::Error::from(kind).into()
            ));
        }
        assert!(!retryable_during_startup(&anyhow::anyhow!("timed out")));
    }
}

#[cfg(all(test, unix))]
#[path = "probe_tests.rs"]
mod readiness_tests;
