//! Daemon-wide shared state: config, browser registry, session registry.

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::task::JoinHandle;

use super::abort::AbortRegistry;
use super::browsers::BrowserRegistry;
use super::inflight::ToolInflightRegistry;
use super::ipc::IpcHandle;
use super::queue::ToolQueueRegistry;
use super::session_interrupt::SessionInterruptRegistry;
use super::sessions::SessionRegistry;
use super::start::DaemonConfig;
use super::ws::WsHandle;

pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL_VERSION: &str = "1.0";
/// Lowest **protocol** version peers must speak (e.g. `"1.0"`).
pub const MIN_COMPATIBLE_PROTOCOL: &str = "1.0";
/// Legacy app-semver floor used only when `HandshakeResult.min_compatible_peer`
/// is emitted for old extensions. New code ignores this on read.
pub const LEGACY_MIN_COMPATIBLE_PEER: &str = "0.0.0";
pub const SERVER_NAME: &str = "browser-skill-daemon";

#[derive(Debug)]
pub struct DaemonState {
    pub config: DaemonConfig,
    pub browsers: Arc<BrowserRegistry>,
    pub sessions: Arc<SessionRegistry>,
    /// Per-session serial dispatch queues for `tool.*` RPCs (M6.5,
    /// design §5). Populated by `start_session`, drained by
    /// `stop_session` / browser disconnect.
    pub tool_queues: Arc<ToolQueueRegistry>,
    /// Per-rpc-id cancellation tokens for daemon-side long-runners
    /// (M9.3 — currently only `tool.wait_ms`). The CLI's `cancel
    /// { rpc_id }` consults this registry first.
    pub abort_registry: Arc<AbortRegistry>,
    /// Tracks `tool.*` RPCs that have been forwarded to an extension
    /// over WS but have not yet received a response. Indexed by the
    /// CLI-side wire `rpc_id` so a peer `cancel { rpc_id }` can be
    /// translated into a WS-side cancel frame addressed to the
    /// matching browser (M10.2).
    pub tool_inflight: Arc<ToolInflightRegistry>,
    /// Per-session "pending interrupt" signal. The WS event handler
    /// `mark`s the session when the user clicks the agent-window
    /// mask's stop button; the IPC tool-dispatch handler
    /// `try_consume`s on the way in so the next mutating tool call
    /// is rejected with `UserAborted`. Independent of
    /// `SessionRegistry` because the signal is a transient runtime
    /// control state.
    pub session_interrupts: Arc<SessionInterruptRegistry>,
}

impl DaemonState {
    pub fn new(config: DaemonConfig) -> Self {
        let browsers = Arc::new(BrowserRegistry::new());
        let sessions = Arc::new(SessionRegistry::new());
        let tool_inflight = Arc::new(ToolInflightRegistry::new());
        let tool_queues = Arc::new(ToolQueueRegistry::new(
            Arc::clone(&browsers),
            Arc::clone(&sessions),
        ));
        let abort_registry = Arc::new(AbortRegistry::new());
        let session_interrupts = Arc::new(SessionInterruptRegistry::new());
        Self {
            config,
            browsers,
            sessions,
            tool_queues,
            abort_registry,
            tool_inflight,
            session_interrupts,
        }
    }
}

/// Test-only handle returned by [`super::run`].
pub struct DaemonHandle {
    state: Arc<DaemonState>,
    ws: WsHandle,
    ipc: Option<IpcHandle>,
}

impl DaemonHandle {
    pub(crate) fn new(state: Arc<DaemonState>, ws: WsHandle, ipc: Option<IpcHandle>) -> Self {
        Self { state, ws, ipc }
    }

    pub fn state(&self) -> Arc<DaemonState> {
        Arc::clone(&self.state)
    }

    pub fn ws_addr(&self) -> SocketAddr {
        self.ws.local_addr
    }

    pub fn ipc_handle(&self) -> Option<&IpcHandle> {
        self.ipc.as_ref()
    }

    /// Stop the WS server (and IPC if running). Returns once both join
    /// handles complete.
    pub async fn shutdown(self) {
        self.ws.shutdown.notify_waiters();
        let _ = await_join(self.ws.task).await;
        if let Some(ipc) = self.ipc {
            ipc.shutdown.notify_waiters();
            let _ = await_join(ipc.task).await;
        }
    }
}

pub(crate) async fn await_join<T>(handle: JoinHandle<T>) -> anyhow::Result<()> {
    match handle.await {
        Ok(_) => Ok(()),
        Err(err) if err.is_cancelled() => Ok(()),
        Err(err) => Err(err.into()),
    }
}
