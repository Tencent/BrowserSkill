//! Daemon-wide shared state: config, browser registry, session registry.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bsk_protocol::tools::SessionStopResult;
use tokio::task::JoinHandle;

use super::abort::{AbortRegistry, AbortToken};
use super::browsers::{BrowserId, BrowserRegistry};
use super::file_transfer::TransferRegistry;
use super::inflight::{CancelReason, ToolInflightRegistry};
use super::ipc::{IpcHandle, RecordSessionStop};
use super::queue::ToolQueueRegistry;
use super::session_interrupt::SessionInterruptRegistry;
use super::sessions::{SessionId, SessionRegistry, StopSessionError, send_session_stop};
use super::start::DaemonConfig;
use super::ws::WsHandle;

pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");
pub use bsk_protocol::catalog::{MIN_COMPATIBLE_PROTOCOL, PROTOCOL_VERSION};
pub const SERVER_NAME: &str = "browser-skill-daemon";

#[derive(Debug)]
pub struct DaemonState {
    pub audit: Arc<super::audit::AuditStore>,
    pub config: DaemonConfig,
    pub local_auth: Arc<super::local_auth::LocalAuth>,
    last_unpaired_attempt:
        std::sync::Mutex<Option<(std::time::Instant, bsk_protocol::system::UnpairedAttempt)>>,
    pub browsers: Arc<BrowserRegistry>,
    pub sessions: Arc<SessionRegistry>,
    pub(super) record_session_stops: Mutex<HashMap<SessionId, RecordSessionStop>>,
    pub session_requests: super::session_requests::SessionRequests,
    /// Per-session serial dispatch queues for `tool.*` RPCs (M6.5,
    /// design §5). Populated by `start_session`, drained by
    /// `stop_session` / browser disconnect.
    pub tool_queues: Arc<ToolQueueRegistry>,
    /// Per-rpc-id cancellation tokens for daemon-side long-runners
    /// (`tool.wait_ms` plus `session.*` lifecycle calls). The CLI's
    /// `cancel { rpc_id }` consults this registry first.
    pub abort_registry: Arc<AbortRegistry>,
    /// Tracks `tool.*` RPCs that have been forwarded to an extension
    /// over WS but have not yet received a response. Indexed by the
    /// CLI-side wire `rpc_id` so a peer `cancel { rpc_id }` can be
    /// translated into a WS-side cancel frame addressed to the
    /// matching browser (M10.2).
    pub tool_inflight: Arc<ToolInflightRegistry>,
    pub dialog_operations: Arc<super::dialog_operations::DialogOperations>,
    /// Per-session "pending interrupt" signal. The WS event handler
    /// `mark`s the session when the user clicks the agent-window
    /// mask's stop button; the IPC tool-dispatch handler
    /// `try_consume`s on the way in so the next browser-input-dispatching
    /// tool call is rejected with `UserAborted`. Independent of
    /// `SessionRegistry` because the signal is a transient runtime
    /// control state.
    pub session_interrupts: Arc<SessionInterruptRegistry>,
    /// Operation-scoped local file staging. The extension only sees paths
    /// minted here; agent-facing RPCs use opaque transfer ids.
    pub transfers: Arc<TransferRegistry>,
    /// What each live session did, for recipe drafts. Metadata only, in memory.
    pub run_logs: super::run_log::RunLogs,
    /// Caller-scoped implicit session bindings, short `cN`/`oN` tokens, and `last_vom`.
    pub scopes: super::scopes::ImplicitScopeRegistry,
    /// `<3ms` write-ahead intent ledger guarding against blind replay (`RM-03`).
    pub intent_wal: super::intent_wal::IntentWal,
}

impl DaemonState {
    /// Single authoritative session teardown entry point across the daemon.
    ///
    /// Reconciles all 12 session-associated state tables (`sessions`,
    /// `record_session_stops`, `session_requests`, `tool_queues`,
    /// `abort_registry`, `tool_inflight`, `dialog_operations`,
    /// `session_interrupts`, `transfers`, `run_logs`, `scopes`, and
    /// `intent_wal`) and returns `true` when `session_id` was live in
    /// [`SessionRegistry`] at teardown time.
    pub fn teardown_session(&self, session_id: &SessionId, reason: &'static str) -> bool {
        if reason == bsk_protocol::RpcErrorReason::UserMovedTab.as_str() {
            let snapshots = self
                .tool_inflight
                .cancel_session_with_reason(session_id, CancelReason::UserMovedTab);
            for snap in snapshots {
                if let (Some(browser_id), Some(ws_rpc_id)) = (snap.browser_id, snap.ws_rpc_id)
                    && let Err(err) = super::cancel_forward::forward_cancel_to_browser(
                        self,
                        &browser_id,
                        &ws_rpc_id,
                    )
                {
                    tracing::warn!(
                        %browser_id,
                        %ws_rpc_id,
                        %err,
                        "failed to forward session cancellation to extension"
                    );
                }
            }
        }
        let removed = self.sessions.teardown(session_id, reason);
        self.record_session_stops
            .lock()
            .unwrap()
            .retain(|id, stop| id != session_id || stop.result.borrow().is_none());
        for rpc_id in self.session_requests.on_session_ended(session_id) {
            self.abort_registry.cancel(&rpc_id);
        }
        self.tool_queues.remove(session_id);
        self.dialog_operations.remove_session(&session_id.0);
        self.session_interrupts.drop_session(session_id);
        self.transfers.release_session(&session_id.0);
        self.run_logs.remove_session(&session_id.0);
        self.scopes.on_session_ended(session_id, reason);
        self.intent_wal.on_session_ended(session_id);
        removed
    }

    /// Round-trip `tool.session_stop` to the owning extension and, on success,
    /// atomically finalize all daemon session state through
    /// [`Self::teardown_session`] with `reason`.
    pub async fn stop_session_with_reason(
        &self,
        session_id: &SessionId,
        reason: &'static str,
        timeout_dur: Duration,
        cancel: Option<AbortToken>,
    ) -> Result<SessionStopResult, StopSessionError> {
        let (result, graceful_audit) = send_session_stop(
            &self.browsers,
            &self.sessions,
            &self.tool_queues,
            session_id,
            timeout_dur,
            cancel,
        )
        .await?;
        if graceful_audit {
            self.sessions.mark_graceful_audit_end(session_id);
        }
        self.teardown_session(session_id, reason);
        Ok(result)
    }

    /// Forget every session owned by `browser_id` through [`Self::teardown_session`].
    ///
    /// Shared by every browser-driven purge (maintainer review of
    /// issue #465): the reconnect-time stale purge, the ordinary socket
    /// cleanup, and the liveness-timeout reaper.
    pub fn purge_sessions_of_browser(
        &self,
        browser_id: &BrowserId,
        end_reason: &'static str,
        note: &'static str,
    ) {
        for session_id in self.sessions.ids_for_browser(browser_id) {
            if self.teardown_session(&session_id, end_reason) {
                tracing::debug!(session = %session_id, note);
            }
        }
    }
}

impl DaemonState {
    pub fn record_unpaired(&self, version: Option<&str>) {
        let extension_version = version
            .and_then(|v| semver::Version::parse(v).ok())
            .map(|v| v.to_string());
        let at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .expect("current timestamp");
        *self.last_unpaired_attempt.lock().unwrap() = Some((
            std::time::Instant::now(),
            bsk_protocol::system::UnpairedAttempt {
                at,
                extension_version,
            },
        ));
    }
    pub fn recent_unpaired(&self) -> Option<bsk_protocol::system::UnpairedAttempt> {
        if self.local_auth.mode().accepts_legacy() {
            return None;
        }
        self.last_unpaired_attempt
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(when, _)| when.elapsed() < std::time::Duration::from_secs(300))
            .map(|(_, attempt)| attempt.clone())
    }
    pub fn local_auth_status(&self) -> Option<bsk_protocol::system::LocalAuthStatus> {
        if self.config.server.is_some() {
            return None;
        }
        Some(bsk_protocol::system::LocalAuthStatus {
            mode: serde_json::to_value(self.local_auth.mode())
                .expect("local policy")
                .as_str()
                .unwrap()
                .into(),
            paired_devices: self
                .local_auth
                .store
                .devices()
                .iter()
                .filter(|d| d.status == super::local_auth::store::DeviceStatus::Active)
                .count(),
            last_unpaired_attempt: self.recent_unpaired(),
        })
    }
    pub fn new(config: DaemonConfig) -> Self {
        if crate::cli::human_loop::legacy_help_override_requested() {
            crate::cli::interaction_policy::warn_legacy_override("BSK_REQUEST_HELP=off");
        }
        let browsers = Arc::new(BrowserRegistry::new());
        let audit = Arc::new(super::audit::AuditStore::new(
            super::paths::bsk_home().ok().map(|path| path.join("audit")),
        ));
        let sessions = Arc::new(SessionRegistry::with_audit(Arc::clone(&audit)));
        let tool_inflight = Arc::new(ToolInflightRegistry::new());
        let tool_queues = Arc::new(ToolQueueRegistry::new(
            Arc::clone(&browsers),
            Arc::clone(&sessions),
        ));
        let abort_registry = Arc::new(AbortRegistry::new());
        let session_interrupts = Arc::new(SessionInterruptRegistry::new());
        let transfers = Arc::new(TransferRegistry::new().expect("initialise transfer staging"));
        Self {
            audit,
            local_auth: Arc::new(super::local_auth::LocalAuth::memory(config.local_auth)),
            last_unpaired_attempt: Default::default(),
            config,
            browsers,
            sessions,
            record_session_stops: Default::default(),
            session_requests: Default::default(),
            tool_queues,
            abort_registry,
            tool_inflight,
            dialog_operations: Default::default(),
            session_interrupts,
            transfers,
            run_logs: Default::default(),
            scopes: Default::default(),
            intent_wal: super::intent_wal::IntentWal::new(super::paths::intent_ledger_path().ok()),
        }
    }
}

/// Test-only handle returned by [`super::run`].
pub struct DaemonHandle {
    state: Arc<DaemonState>,
    ws: WsHandle,
    ipc: Option<IpcHandle>,
    session_idle_task: JoinHandle<()>,
    browser_liveness_task: JoinHandle<()>,
}

impl DaemonHandle {
    pub(crate) fn new(
        state: Arc<DaemonState>,
        ws: WsHandle,
        ipc: Option<IpcHandle>,
        session_idle_task: JoinHandle<()>,
        browser_liveness_task: JoinHandle<()>,
    ) -> Self {
        Self {
            state,
            ws,
            ipc,
            session_idle_task,
            browser_liveness_task,
        }
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
        self.session_idle_task.abort();
        let _ = await_join(self.session_idle_task).await;
        self.browser_liveness_task.abort();
        let _ = await_join(self.browser_liveness_task).await;
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
