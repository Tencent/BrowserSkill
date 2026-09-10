//! `ensure_daemon()` — first-call auto-spawn used by every business
//! subcommand.
//!
//! Flow (per design §3.1):
//! 1. Verify the daemon over IPC and return its discovery info.
//! 2. Only if no endpoint is listening and auto-start is enabled, spawn
//!    `bsk daemon start` (the same binary), inheriting
//!    `BSK_HOME` if set, and poll for verified IPC readiness until
//!    [`SPAWN_DEADLINE`] elapses.
//! 3. If polling times out, return an error with hints.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, ensure};

use crate::daemon::info::DaemonInfo;
use crate::daemon::probe::{self, PROBE_TIMEOUT, Probe};

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
    if let Probe::Ready(daemon) = probe::probe(PROBE_TIMEOUT)? {
        return Ok(daemon.info);
    }
    ensure!(auto_start_enabled(), AUTO_START_DISABLED_HINT);
    spawn_daemon()?;
    probe::wait_for_ready(SPAWN_DEADLINE)
        .map(|daemon| daemon.info)
        .with_context(|| "auto-spawned daemon failed to become ready in time")
}

fn spawn_daemon() -> Result<()> {
    let exe = bsk_executable()?;
    let mut cmd = Command::new(exe);
    cmd.arg("daemon")
        .arg("start")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // The child re-uses inherited env (BSK_HOME etc), so tests that set
    // a temp home work transparently.
    let output = cmd
        .output()
        .context("spawn `bsk daemon start` for auto-spawn")?;
    if !output.status.success() {
        return Err(anyhow::anyhow!(
            "`bsk daemon start` exited with status {:?}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn bsk_executable() -> Result<PathBuf> {
    std::env::current_exe().context("locate current executable for auto-spawn")
}
