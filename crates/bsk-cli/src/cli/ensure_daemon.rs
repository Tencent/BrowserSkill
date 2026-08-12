//! `ensure_daemon()` — first-call auto-spawn used by every business
//! subcommand.
//!
//! Flow (per design §3.1):
//! 1. Read `daemon.json`. If the recorded pid is alive, return its info.
//! 2. Otherwise spawn `bsk daemon start` (the same binary), inheriting
//!    `BSK_HOME` if set, and poll `daemon.json` for a live pid until
//!    [`SPAWN_DEADLINE`] elapses.
//! 3. If polling times out, return an error with hints.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bsk_protocol::{Method, StatusParams, StatusResult};

use crate::daemon::info::{self, DaemonInfo};

/// Maximum time to wait for an auto-spawned daemon to become ready.
pub const SPAWN_DEADLINE: Duration = Duration::from_millis(3_000);

/// Read `daemon.json` if it's valid; spawn the daemon otherwise. Returns
/// the connection handle the caller should use.
pub fn ensure_daemon() -> Result<DaemonInfo> {
    if let Some(running) = read_verified()? {
        return Ok(running);
    }
    spawn_daemon()?;
    wait_for_ready(SPAWN_DEADLINE)
        .with_context(|| "auto-spawned daemon failed to become ready in time")
}

fn spawn_daemon() -> Result<()> {
    let exe = bsk_executable()?;
    let mut cmd = Command::new(exe);
    cmd.arg("daemon")
        .arg("start")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // The child re-uses inherited env (BSK_HOME etc), so tests that set
    // a temp home work transparently.
    let status = cmd
        .status()
        .context("spawn `bsk daemon start` for auto-spawn")?;
    if !status.success() {
        return Err(anyhow::anyhow!(
            "`bsk daemon start` exited with status {status:?}"
        ));
    }
    Ok(())
}

fn wait_for_ready(timeout: Duration) -> Result<DaemonInfo> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(info) = read_verified()? {
            return Ok(info);
        }
        if Instant::now() >= deadline {
            return Err(anyhow::anyhow!(
                "no valid daemon.json after {timeout:?}; check `bsk logs`"
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn read_verified() -> Result<Option<DaemonInfo>> {
    let Some(info) = info::read_valid()? else {
        return Ok(None);
    };
    match verify_daemon(&info, Duration::from_millis(500)) {
        Ok(status) if status.pid == info.pid => Ok(Some(info)),
        Ok(_) | Err(_) => Ok(None),
    }
}

fn verify_daemon(info: &DaemonInfo, timeout: Duration) -> Result<StatusResult> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build tokio runtime for daemon verification")?;
    rt.block_on(async {
        let mut client = crate::ipc_client::Client::connect_path(info.sock_path.clone()).await?;
        let outcome = client
            .call::<_, StatusResult>(Method::SystemStatus, &StatusParams::default(), timeout)
            .await?;
        outcome.map_err(|err| {
            anyhow::anyhow!(
                "daemon verification RPC failed: {} ({:?})",
                err.message,
                err.code
            )
        })
    })
}

fn bsk_executable() -> Result<PathBuf> {
    std::env::current_exe().context("locate current executable for auto-spawn")
}
