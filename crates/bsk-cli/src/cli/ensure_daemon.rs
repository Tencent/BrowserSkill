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

use std::time::{Duration, Instant};

use anyhow::{Context, Result, ensure};

use crate::cli::daemon::StartArgs;
use crate::daemon::info::DaemonInfo;
use crate::daemon::probe::{self, PROBE_TIMEOUT, Probe};
use crate::daemon::start::start_background;

/// Maximum time to wait for an auto-spawned daemon to become ready.
pub const SPAWN_DEADLINE: Duration = Duration::from_millis(3_000);

/// Explicit opt-out for clients using a daemon managed by their host.
/// All other values preserve the default automatic startup behavior.
pub(crate) fn auto_start_enabled() -> bool {
    std::env::var_os("BSK_AUTO_START").as_deref() != Some(std::ffi::OsStr::new("0"))
}

pub(crate) const AUTO_START_DISABLED_HINT: &str = "automatic daemon startup is disabled (BSK_AUTO_START=0); \
    run `bsk daemon start` in the owning host environment with the same BSK_HOME, then retry";

/// Return verified discovery info, starting a daemon only when its discovery
/// file or IPC listener is absent and auto-start is enabled.
pub fn ensure_daemon() -> Result<DaemonInfo> {
    let deadline = Instant::now() + SPAWN_DEADLINE;
    if let Probe::Ready(daemon) = probe::probe(PROBE_TIMEOUT)? {
        return Ok(daemon.info);
    }
    ensure!(auto_start_enabled(), AUTO_START_DISABLED_HINT);
    start_background(&StartArgs::default(), deadline).context("automatic daemon startup failed")
}
