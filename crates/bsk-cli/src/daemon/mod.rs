//! Daemon runtime: long-lived background process exposing IPC + WS.

pub mod abort;
pub mod browsers;
mod cancel_forward;
pub mod inflight;
pub mod info;
pub mod ipc;
pub mod lockfile;
pub mod paths;
pub mod queue;
pub mod session_interrupt;
pub mod sessions;
pub mod start;
pub mod state;
pub mod ws;

pub use start::{DaemonConfig, run_foreground};
pub use state::{DaemonHandle, DaemonState};

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

/// Default WebSocket port (design §3.2). Override via `--port`.
pub const DEFAULT_WS_PORT: u16 = 52800;

/// Test/embed entry point used by M4/M5 integration tests and the
/// experimental `bsk daemon start --foreground` flag. Spins up the WS
/// server (always) and the IPC server (if `ipc_socket.is_some()`),
/// returning a [`DaemonHandle`] the caller can drive directly.
///
/// Note: this path intentionally bypasses M2's lockfile / daemon.json
/// machinery — use [`run_foreground`] for the real daemon lifecycle.
pub async fn run(
    config: DaemonConfig,
    ipc_socket: Option<PathBuf>,
) -> anyhow::Result<DaemonHandle> {
    let ws_port = config.ws_port;
    let state = Arc::new(DaemonState::new(config));
    let ws_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), ws_port);
    let ws_handle = ws::WsServer::new(Arc::clone(&state)).bind(ws_addr).await?;
    let ipc_handle = match ipc_socket {
        Some(path) => Some(ipc::IpcServer::new(Arc::clone(&state)).bind(path).await?),
        None => None,
    };
    let session_idle_task = start::spawn_session_idle_reaper(Arc::clone(&state));
    let browser_liveness_task = start::spawn_browser_liveness_reaper(Arc::clone(&state));
    // Ensure WS/IPC accept loops have polled `shutdown.notified()` before any
    // caller can invoke `DaemonHandle::shutdown()` — `Notify::notify_waiters()`
    // drops wakeups when nothing is registered yet, which otherwise hangs
    // shutdown forever (hit by tests that connect/shutdown immediately).
    tokio::task::yield_now().await;
    Ok(DaemonHandle::new(
        state,
        ws_handle,
        ipc_handle,
        session_idle_task,
        browser_liveness_task,
    ))
}
