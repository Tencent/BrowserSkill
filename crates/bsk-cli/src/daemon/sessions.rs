//! In-memory session registry shared by the WS server (extension peer) and
//! IPC server (CLI peer). Minimal scope: enough for `bsk session start`,
//! `bsk session stop`, `bsk session list` and the matching
//! `tool.session_start` / `tool.session_stop` round-trips.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use bsk_protocol::system::{BrowserStatusEntry, SessionStatusEntry};
use bsk_protocol::tools::{
    SessionStartParams, SessionStartResult, SessionStopParams, SessionStopResult,
};
use bsk_protocol::{ErrorCode, Frame, Method, RequestFrame, ResponseBody, RpcError, RpcId};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio::time::{Duration, timeout};

use super::abort::AbortToken;
use super::browsers::{BrowserClient, BrowserId, BrowserRegistry, SelectError};
use super::queue::{CANCEL_CLEANUP_TIMEOUT, DispatchError, ToolQueueRegistry};
use super::session_interrupt::SessionInterruptRegistry;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl SessionId {
    /// Generate a random 4-letter lowercase id (§5).
    pub fn random() -> Self {
        let mut rng = rand::thread_rng();
        let s: String = (0..4)
            .map(|_| {
                let n: u32 = rng.gen_range(0..26);
                char::from_u32(b'a' as u32 + n).unwrap()
            })
            .collect();
        SessionId(s)
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone)]
pub struct Session {
    pub id: SessionId,
    pub browser_id: BrowserId,
    pub agent_window_id: Option<i64>,
    pub created_at_ms: i64,
}

impl Session {
    pub fn status_entry(&self) -> SessionStatusEntry {
        SessionStatusEntry {
            session_id: self.id.0.clone(),
            browser_instance_id: self.browser_id.0.clone(),
            agent_window_id: self.agent_window_id,
            created_at_ms: self.created_at_ms,
        }
    }
}

#[derive(Debug, Default)]
pub struct SessionRegistry {
    inner: Mutex<HashMap<SessionId, Session>>,
    /// Operational metadata kept outside the public `Session` wire/domain
    /// shape so idle enforcement does not break external struct users.
    last_activity: Mutex<HashMap<SessionId, Instant>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> Vec<Session> {
        self.inner
            .lock()
            .expect("session registry poisoned")
            .values()
            .cloned()
            .collect()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("session registry poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn count_for_browser(&self, browser_id: &BrowserId) -> u32 {
        self.inner
            .lock()
            .expect("session registry poisoned")
            .values()
            .filter(|s| &s.browser_id == browser_id)
            .count() as u32
    }

    pub fn insert(&self, session: Session) {
        let session_id = session.id.clone();
        let mut sessions = self.inner.lock().expect("session registry poisoned");
        sessions.insert(session_id.clone(), session);
        self.last_activity
            .lock()
            .expect("session activity registry poisoned")
            .insert(session_id, Instant::now());
    }

    /// Reserve a fresh, collision-free [`SessionId`] under the registry
    /// lock by inserting a placeholder [`Session`]. Returns `None`
    /// after `max_attempts` failed random draws so callers can surface
    /// a deterministic error instead of looping forever.
    ///
    /// The 4-letter id space is `26^4 = 456_976`; with even a small
    /// number of live sessions the birthday probability of a collision
    /// is not negligible. Without this reservation the subsequent
    /// `insert` would silently overwrite a live session, leaking its
    /// `agent_window_id` and dropping its CLI mapping (review M4/M5 C1).
    ///
    /// Pair every successful reservation with [`SessionRegistry::commit_reservation`]
    /// or [`SessionRegistry::cancel_reservation`] so placeholders never
    /// leak when the extension round-trip fails.
    pub fn reserve_id(
        &self,
        browser_id: BrowserId,
        max_attempts: u32,
        now_ms_fn: impl Fn() -> i64,
    ) -> Option<SessionId> {
        let mut guard = self.inner.lock().expect("session registry poisoned");
        for _ in 0..max_attempts {
            let candidate = SessionId::random();
            if guard.contains_key(&candidate) {
                continue;
            }
            guard.insert(
                candidate.clone(),
                Session {
                    id: candidate.clone(),
                    browser_id: browser_id.clone(),
                    agent_window_id: None,
                    created_at_ms: now_ms_fn(),
                },
            );
            self.last_activity
                .lock()
                .expect("session activity registry poisoned")
                .insert(candidate.clone(), Instant::now());
            return Some(candidate);
        }
        None
    }

    /// Replace a previously [`reserve_id`](Self::reserve_id) placeholder
    /// with the real `agent_window_id` returned by the extension.
    /// Returns the resulting [`Session`] for callers that want to echo
    /// it back.
    pub fn commit_reservation(
        &self,
        session_id: &SessionId,
        agent_window_id: Option<i64>,
    ) -> Option<Session> {
        let mut guard = self.inner.lock().expect("session registry poisoned");
        let session = guard.get_mut(session_id)?;
        session.agent_window_id = agent_window_id;
        Some(session.clone())
    }

    /// Drop a placeholder reservation, used on extension error/timeout
    /// paths so failed reservations do not accumulate.
    pub fn cancel_reservation(&self, session_id: &SessionId) {
        self.inner
            .lock()
            .expect("session registry poisoned")
            .remove(session_id);
        self.last_activity
            .lock()
            .expect("session activity registry poisoned")
            .remove(session_id);
    }

    pub fn remove(&self, id: &SessionId) -> Option<Session> {
        let removed = self
            .inner
            .lock()
            .expect("session registry poisoned")
            .remove(id);
        self.last_activity
            .lock()
            .expect("session activity registry poisoned")
            .remove(id);
        removed
    }

    pub fn get(&self, id: &SessionId) -> Option<Session> {
        self.inner
            .lock()
            .expect("session registry poisoned")
            .get(id)
            .cloned()
    }

    /// Record accepted or completed tool activity for a live session.
    pub fn touch(&self, id: &SessionId) -> bool {
        if !self
            .inner
            .lock()
            .expect("session registry poisoned")
            .contains_key(id)
        {
            return false;
        }
        self.last_activity
            .lock()
            .expect("session activity registry poisoned")
            .insert(id.clone(), Instant::now());
        true
    }

    /// Return sessions whose last tool activity is at least `idle_for`
    /// old. The caller supplies `now` to keep boundary tests deterministic.
    pub fn idle_ids_at(&self, idle_for: Duration, now: Instant) -> Vec<SessionId> {
        let sessions = self.inner.lock().expect("session registry poisoned");
        let activity = self
            .last_activity
            .lock()
            .expect("session activity registry poisoned");
        sessions
            .values()
            .filter(|session| {
                activity
                    .get(&session.id)
                    .is_some_and(|last| now.saturating_duration_since(*last) >= idle_for)
            })
            .map(|session| session.id.clone())
            .collect()
    }

    /// Drop all sessions owned by `browser_id` (e.g. on disconnect).
    pub fn purge_browser(&self, browser_id: &BrowserId) -> Vec<Session> {
        let mut guard = self.inner.lock().expect("session registry poisoned");
        let drained: Vec<Session> = guard
            .values()
            .filter(|s| &s.browser_id == browser_id)
            .cloned()
            .collect();
        for s in &drained {
            guard.remove(&s.id);
        }
        let mut activity = self
            .last_activity
            .lock()
            .expect("session activity registry poisoned");
        for session in &drained {
            activity.remove(&session.id);
        }
        drained
    }

    pub fn ids_for_browser(&self, browser_id: &BrowserId) -> Vec<SessionId> {
        self.inner
            .lock()
            .expect("session registry poisoned")
            .values()
            .filter(|s| &s.browser_id == browser_id)
            .map(|s| s.id.clone())
            .collect()
    }
}

/// Build a deterministic snapshot of every connected browser so the
/// CLI can render the error data table without re-querying the daemon.
/// Sorted by `connected_at_ms` ascending so the oldest connection
/// shows up first (matches the `bsk browsers` output order).
pub fn snapshot_status_entries(
    registry: &BrowserRegistry,
    sessions: &SessionRegistry,
) -> Vec<BrowserStatusEntry> {
    let mut entries: Vec<BrowserStatusEntry> = registry
        .snapshot()
        .into_iter()
        .map(|c| {
            let count = sessions.count_for_browser(&c.id);
            c.status_entry(count)
        })
        .collect();
    entries.sort_by(|a, b| {
        a.connected_at_ms
            .cmp(&b.connected_at_ms)
            .then_with(|| a.instance_id.cmp(&b.instance_id))
    });
    entries
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn next_rpc_id(prefix: &str) -> RpcId {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let s: String = (0..8)
        .map(|_| {
            let n: u32 = rng.gen_range(0..16);
            char::from_digit(n, 16).unwrap()
        })
        .collect();
    format!("{prefix}-{s}")
}

#[derive(Debug, thiserror::Error)]
pub enum StartSessionError {
    #[error("no browser is currently connected")]
    NoBrowserConnected,
    #[error("more than one browser is online — pass --browser <id-or-label>")]
    MultipleBrowsersOnline {
        /// Snapshot of all currently connected browsers, attached to
        /// the daemon's structured error so the CLI can render a list
        /// hint instead of asking the user to run `bsk browsers` again
        /// (M10.1).
        browsers: Vec<BrowserStatusEntry>,
    },
    #[error("requested browser is not connected")]
    BrowserNotFound,
    #[error("label '{label}' matches {} connected browsers", instance_ids.len())]
    AmbiguousBrowserLabel {
        label: String,
        instance_ids: Vec<String>,
    },
    #[error("could not allocate a fresh session id after many tries")]
    IdExhausted,
    #[error("session creation timed out waiting for extension")]
    Timeout,
    #[error("session creation was cancelled")]
    Cancelled,
    #[error("session creation cancellation cleanup failed for {session_id}: {message}")]
    CleanupFailed {
        session_id: SessionId,
        agent_window_id: Option<i64>,
        message: String,
    },
    #[error("extension rejected tool.session_start: {0:?}")]
    ExtensionError(RpcError),
    #[error("transport closed while waiting for extension response")]
    TransportClosed,
}

impl StartSessionError {
    pub fn code(&self) -> &'static str {
        match self {
            StartSessionError::NoBrowserConnected => "no_browser_connected",
            StartSessionError::MultipleBrowsersOnline { .. } => "multiple_browsers_online",
            StartSessionError::BrowserNotFound => "not_found",
            StartSessionError::AmbiguousBrowserLabel { .. } => "invalid_params",
            StartSessionError::IdExhausted => "protocol_error",
            StartSessionError::Timeout => "timeout",
            StartSessionError::Cancelled => "cancelled",
            StartSessionError::CleanupFailed { .. } => "protocol_error",
            StartSessionError::TransportClosed => "protocol_error",
            StartSessionError::ExtensionError(err) => match err.code {
                bsk_protocol::ErrorCode::Timeout => "timeout",
                bsk_protocol::ErrorCode::Cancelled => "cancelled",
                _ => "protocol_error",
            },
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StopSessionError {
    #[error("session is not registered")]
    NotFound,
    #[error("session stop is already in progress")]
    Stopping,
    #[error("session already has an unfinished command")]
    SessionBusy,
    #[error("owning browser is no longer connected")]
    BrowserGone,
    #[error("session stop timed out waiting for extension")]
    Timeout,
    #[error("extension rejected tool.session_stop: {0:?}")]
    ExtensionError(RpcError),
    #[error("failed to return borrowed tabs during session stop")]
    ReturnFailures(SessionStopResult),
    #[error("transport closed while waiting for extension response")]
    TransportClosed,
}

/// Cap on collision-retry attempts when picking a fresh [`SessionId`].
/// 64 random draws against the 26⁴ id space caps the probability of a
/// false `IdExhausted` failure at well below 10⁻¹⁵ even with thousands
/// of live sessions.
const SESSION_ID_MAX_RESERVE_ATTEMPTS: u32 = 64;

/// Agent Window creation hints forwarded to the extension on
/// `tool.session_start`. `None` fields keep the extension-side defaults
/// (focused window, browser-chosen size).
#[derive(Debug, Default, Clone, Copy)]
pub struct AgentWindowOptions {
    /// Optional outer size as `(width, height)` CSS pixels.
    pub size: Option<(u32, u32)>,
    /// Optional focus hint (`None` = extension default: focused).
    pub focused: Option<bool>,
}

/// Ask the chosen browser to create a fresh Agent Window for a brand-new
/// session id, registering the result on success.
///
/// On success the matching per-session dispatch queue (M6.5,
/// design §5) is also spawned so that subsequent `tool.*` RPCs serialise
/// against this session's Agent Window / ref-store.
#[allow(clippy::too_many_arguments)]
pub async fn start_session(
    registry: &Arc<BrowserRegistry>,
    sessions: &Arc<SessionRegistry>,
    queues: &Arc<ToolQueueRegistry>,
    requested: Option<&str>,
    window: AgentWindowOptions,
    connect_wait: Duration,
    timeout_dur: Duration,
    cancel: Option<AbortToken>,
) -> Result<Session, StartSessionError> {
    let selection = registry.select_with_connect_wait(requested, connect_wait);
    tokio::pin!(selection);
    let selected = match cancel.as_ref() {
        Some(token) => tokio::select! {
            biased;
            _ = token.cancelled() => return Err(StartSessionError::Cancelled),
            selected = &mut selection => selected,
        },
        None => selection.await,
    };
    let client: Arc<BrowserClient> = selected.map_err(|e| match e {
        SelectError::NoBrowserConnected => StartSessionError::NoBrowserConnected,
        SelectError::MultipleBrowsersOnline => StartSessionError::MultipleBrowsersOnline {
            browsers: snapshot_status_entries(registry, sessions),
        },
        SelectError::NotFound => StartSessionError::BrowserNotFound,
        SelectError::AmbiguousLabel {
            label,
            instance_ids,
        } => StartSessionError::AmbiguousBrowserLabel {
            label,
            instance_ids,
        },
    })?;
    let session_id = sessions
        .reserve_id(client.id.clone(), SESSION_ID_MAX_RESERVE_ATTEMPTS, now_ms)
        .ok_or(StartSessionError::IdExhausted)?;
    let params = SessionStartParams {
        session_id: session_id.0.clone(),
        browser_instance_id: Some(client.id.0.clone()),
        width: window.size.map(|(width, _)| width),
        height: window.size.map(|(_, height)| height),
        focused: window.focused,
    };
    let rpc_id = next_rpc_id("sess-start");
    let request = RequestFrame {
        id: rpc_id.clone(),
        method: bsk_protocol::Method::ToolSessionStart,
        params: Some(serde_json::to_value(&params).unwrap()),
    };
    let waiter = {
        let mut pending = client.pending.lock().unwrap();
        pending.register(rpc_id.clone())
    };
    if cancel.as_ref().is_some_and(AbortToken::is_cancelled) {
        sessions.cancel_reservation(&session_id);
        client.pending.lock().unwrap().cancel(&rpc_id);
        return Err(StartSessionError::Cancelled);
    }
    if client.sink.send(Frame::Request(request)).is_err() {
        sessions.cancel_reservation(&session_id);
        client.pending.lock().unwrap().cancel(&rpc_id);
        return Err(StartSessionError::TransportClosed);
    }
    let mut waiter = waiter;
    enum StartWaitOutcome {
        Response(bsk_protocol::ResponseFrame),
        WaiterClosed,
        Cancelled,
        Timeout,
    }
    let wait_outcome = match cancel.as_ref() {
        Some(token) => {
            let deadline = tokio::time::sleep(timeout_dur);
            tokio::pin!(deadline);
            tokio::select! {
                biased;
                _ = token.cancelled() => StartWaitOutcome::Cancelled,
                response = &mut waiter => match response {
                    Ok(response) => StartWaitOutcome::Response(response),
                    Err(_) => StartWaitOutcome::WaiterClosed,
                },
                _ = &mut deadline => StartWaitOutcome::Timeout,
            }
        }
        None => match timeout(timeout_dur, &mut waiter).await {
            Ok(Ok(response)) => StartWaitOutcome::Response(response),
            Ok(Err(_)) => StartWaitOutcome::WaiterClosed,
            Err(_) => StartWaitOutcome::Timeout,
        },
    };
    let response = match wait_outcome {
        StartWaitOutcome::Response(response) => response,
        StartWaitOutcome::WaiterClosed => {
            sessions.cancel_reservation(&session_id);
            client.pending.lock().unwrap().cancel(&rpc_id);
            return Err(StartSessionError::TransportClosed);
        }
        StartWaitOutcome::Cancelled => {
            return Err(finish_aborted_start(
                &client,
                sessions,
                &session_id,
                &rpc_id,
                waiter,
                StartAbortReason::Cancelled,
            )
            .await);
        }
        StartWaitOutcome::Timeout => {
            return Err(finish_aborted_start(
                &client,
                sessions,
                &session_id,
                &rpc_id,
                waiter,
                StartAbortReason::Timeout,
            )
            .await);
        }
    };
    let agent_window_id = match response.body {
        ResponseBody::Ok(v) => match serde_json::from_value::<SessionStartResult>(v) {
            Ok(parsed) => parsed.agent_window_id,
            Err(_) => {
                sessions.cancel_reservation(&session_id);
                return Err(StartSessionError::ExtensionError(RpcError {
                    code: bsk_protocol::ErrorCode::ProtocolError,
                    message: "invalid tool.session_start payload".into(),
                    data: None,
                }));
            }
        },
        ResponseBody::Err(err) => {
            sessions.cancel_reservation(&session_id);
            return Err(StartSessionError::ExtensionError(err));
        }
    };
    let session = sessions
        .commit_reservation(&session_id, agent_window_id)
        .ok_or_else(|| {
            StartSessionError::ExtensionError(RpcError {
                code: bsk_protocol::ErrorCode::ProtocolError,
                message: "session reservation vanished before commit".into(),
                data: None,
            })
        })?;
    // Spawn the per-session serial dispatch queue *after* commit so a
    // failed extension round-trip never leaks an orphan worker
    // (review M6.5).
    queues.spawn(session_id.clone());
    Ok(session)
}

#[derive(Clone, Copy)]
enum StartAbortReason {
    Cancelled,
    Timeout,
}

impl StartAbortReason {
    fn error(self) -> StartSessionError {
        match self {
            Self::Cancelled => StartSessionError::Cancelled,
            Self::Timeout => StartSessionError::Timeout,
        }
    }
}

async fn finish_aborted_start(
    client: &Arc<BrowserClient>,
    sessions: &Arc<SessionRegistry>,
    session_id: &SessionId,
    rpc_id: &RpcId,
    mut waiter: tokio::sync::oneshot::Receiver<bsk_protocol::ResponseFrame>,
    reason: StartAbortReason,
) -> StartSessionError {
    sessions.cancel_reservation(session_id);
    let cancel = Frame::Request(RequestFrame {
        id: format!("cancel-{rpc_id}"),
        method: Method::Cancel,
        params: Some(serde_json::json!({ "rpc_id": rpc_id })),
    });
    if client.sink.send(cancel).is_err() {
        client.pending.lock().unwrap().cancel(rpc_id);
        return StartSessionError::TransportClosed;
    }

    match timeout(CANCEL_CLEANUP_TIMEOUT, &mut waiter).await {
        Ok(Ok(response)) => match response.body {
            ResponseBody::Err(err)
                if matches!(err.code, ErrorCode::Cancelled | ErrorCode::UserAborted) =>
            {
                reason.error()
            }
            ResponseBody::Err(err) => StartSessionError::ExtensionError(err),
            ResponseBody::Ok(value) => {
                let agent_window_id = serde_json::from_value::<SessionStartResult>(value)
                    .ok()
                    .and_then(|result| result.agent_window_id);
                match rollback_extension_session(client, session_id).await {
                    Ok(()) => reason.error(),
                    Err(message) => StartSessionError::CleanupFailed {
                        session_id: session_id.clone(),
                        agent_window_id,
                        message,
                    },
                }
            }
        },
        Ok(Err(_)) => {
            client.pending.lock().unwrap().cancel(rpc_id);
            StartSessionError::TransportClosed
        }
        Err(_) => {
            // The cancel frame is already queued behind session_start. Even
            // if chrome.windows.create is still blocked, the extension will
            // observe the aborted signal and compensate before replying.
            client.pending.lock().unwrap().cancel(rpc_id);
            reason.error()
        }
    }
}

async fn rollback_extension_session(
    client: &Arc<BrowserClient>,
    session_id: &SessionId,
) -> Result<(), String> {
    let rollback_id = next_rpc_id("sess-start-rollback");
    let waiter = {
        let mut pending = client.pending.lock().unwrap();
        pending.register(rollback_id.clone())
    };
    let request = RequestFrame {
        id: rollback_id.clone(),
        method: Method::ToolSessionStop,
        params: Some(
            serde_json::to_value(SessionStopParams {
                session_id: session_id.0.clone(),
            })
            .expect("serialize session_start rollback params"),
        ),
    };
    if client.sink.send(Frame::Request(request)).is_err() {
        client.pending.lock().unwrap().cancel(&rollback_id);
        return Err("browser disconnected before rollback was queued".into());
    }
    let response = match timeout(CANCEL_CLEANUP_TIMEOUT, waiter).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => return Err("browser disconnected during rollback".into()),
        Err(_) => {
            client.pending.lock().unwrap().cancel(&rollback_id);
            return Err(format!(
                "extension did not finish rollback within {CANCEL_CLEANUP_TIMEOUT:?}"
            ));
        }
    };
    match response.body {
        ResponseBody::Ok(value) => {
            let result: SessionStopResult = serde_json::from_value(value)
                .map_err(|err| format!("invalid rollback response: {err}"))?;
            if result.return_failures.is_empty() {
                Ok(())
            } else {
                Err("rollback reported borrowed-tab return failures".into())
            }
        }
        ResponseBody::Err(err) if err.code == ErrorCode::NotFound => Ok(()),
        ResponseBody::Err(err) => Err(format!("rollback failed: {} ({:?})", err.message, err.code)),
    }
}

/// Tear down a single session id (round-trips `tool.session_stop` to the
/// owning extension and unregisters on success). Also tears down the
/// per-session dispatch queue so the worker task exits.
pub async fn stop_session(
    registry: &Arc<BrowserRegistry>,
    sessions: &Arc<SessionRegistry>,
    queues: &Arc<ToolQueueRegistry>,
    interrupts: &Arc<SessionInterruptRegistry>,
    session_id: &SessionId,
    timeout_dur: Duration,
    cancel: Option<AbortToken>,
) -> Result<SessionStopResult, StopSessionError> {
    let session = sessions.get(session_id).ok_or(StopSessionError::NotFound)?;
    if registry.get(&session.browser_id).is_none() {
        return Err(StopSessionError::BrowserGone);
    }

    let params = serde_json::to_value(SessionStopParams {
        session_id: session_id.0.clone(),
    })
    .unwrap();
    // Internal callers (idle reaping and shutdown) do not have a CLI-owned
    // token, but still need timeout-driven WS cancellation so a late window
    // close cannot leave daemon state pointing at a vanished session.
    let lifecycle_cancel = Some(cancel.unwrap_or_default());
    match queues
        .dispatch_after_closing(
            session_id,
            bsk_protocol::Method::ToolSessionStop,
            params,
            timeout_dur,
            lifecycle_cancel,
        )
        .await
    {
        Ok(value) => {
            let result = serde_json::from_value::<SessionStopResult>(value).map_err(|_| {
                StopSessionError::ExtensionError(RpcError {
                    code: bsk_protocol::ErrorCode::ProtocolError,
                    message: "invalid tool.session_stop payload".into(),
                    data: None,
                })
            })?;
            if !result.return_failures.is_empty() {
                queues.reopen(session_id);
                return Err(StopSessionError::ReturnFailures(result));
            }
            sessions.remove(session_id);
            drop_session_local(queues, interrupts, session_id);
            Ok(result)
        }
        Err(DispatchError::Rpc(err)) => {
            // A legacy extension or an unusual reconnect race may still
            // leave a daemon session after the extension's in-memory
            // SessionManager has reset and now answers `not_found`.
            // Treat that as an authoritative signal that the session is
            // already gone and reconcile our local state instead of
            // leaving an orphan row visible to `bsk session list`
            // (review M4/M5 round 3 I-R3-2).
            if matches!(err.code, bsk_protocol::ErrorCode::NotFound) {
                if sessions.remove(session_id).is_some() {
                    tracing::info!(
                        session = %session_id,
                        "session forgotten locally; extension reported not_found (likely SW restart)"
                    );
                }
                drop_session_local(queues, interrupts, session_id);
                return Ok(SessionStopResult::default());
            }
            if err.code == bsk_protocol::ErrorCode::Timeout {
                queues.reopen(session_id);
                return Err(StopSessionError::Timeout);
            }
            queues.reopen(session_id);
            Err(StopSessionError::ExtensionError(err))
        }
        Err(DispatchError::SessionNotFound) => Err(StopSessionError::NotFound),
        Err(DispatchError::SessionStopping) => Err(StopSessionError::Stopping),
        Err(DispatchError::SessionBusy) => Err(StopSessionError::SessionBusy),
        Err(DispatchError::Timeout) => {
            queues.reopen(session_id);
            Err(StopSessionError::Timeout)
        }
        Err(DispatchError::QueueClosed | DispatchError::QueueFull) => {
            queues.reopen(session_id);
            Err(StopSessionError::TransportClosed)
        }
    }
}

/// Drop a session locally (no round-trip) — used when the extension has
/// already torn down its side (e.g. window closed by user). Also drops
/// the queue so the worker exits.
pub fn forget_session(
    sessions: &Arc<SessionRegistry>,
    queues: &Arc<ToolQueueRegistry>,
    interrupts: &Arc<SessionInterruptRegistry>,
    session_id: &SessionId,
) -> bool {
    let removed = sessions.remove(session_id).is_some();
    if removed {
        drop_session_local(queues, interrupts, session_id);
    }
    removed
}

/// Tear down the per-session dispatch queue and any pending
/// user-interrupt marker. Always called immediately after
/// `sessions.remove` (or after the extension confirmed the session
/// is gone), so the queue worker exits and a stale interrupt does
/// not leak across a session id reuse.
fn drop_session_local(
    queues: &Arc<ToolQueueRegistry>,
    interrupts: &Arc<SessionInterruptRegistry>,
    session_id: &SessionId,
) {
    queues.remove(session_id);
    interrupts.drop_session(session_id);
}
