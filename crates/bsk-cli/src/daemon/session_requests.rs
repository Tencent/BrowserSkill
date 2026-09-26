//! Recoverable start operations. The caller knows the token before any browser
//! side effect; IPC delivery is never proof of ownership or cleanup.
//!
//! Tokens contain an admission deadline and a UUID. Expired tokens cannot start
//! again, so terminal tombstones can be collected without resurrecting delayed
//! requests. Unclaimed starts are cancelled at that deadline. Ordinary sessions
//! and claimed requests retain the existing session idle policy.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bsk_protocol::{ErrorCode, ResponseBody, RpcError};
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, watch};

use super::sessions::{Session, SessionId, stop_session};
use super::state::DaemonState;

const MAX_ADMISSION_MS: u64 = 10 * 60 * 1000;
const MAX_REQUESTS: usize = 8192;

#[derive(Debug, Default)]
pub struct SessionRequests(Mutex<HashMap<String, Arc<StartRequest>>>);

#[derive(Debug)]
struct StartRequest {
    id: String,
    expires: u64,
    params: Mutex<Value>,
    started: AtomicBool,
    data: Mutex<RequestData>,
    finished: watch::Sender<bool>,
    cleanup: AsyncMutex<()>,
    reaping: AtomicBool,
}

#[derive(Debug, Default)]
struct RequestData {
    cancelled: bool,
    claimed: bool,
    closed: bool,
    session: Option<Session>,
    result: Option<ResponseBody>,
    cleanup_error: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn error(code: ErrorCode, message: impl Into<String>) -> ResponseBody {
    ResponseBody::Err(RpcError {
        code,
        message: message.into(),
        data: None,
    })
}

fn token_expiry(id: &str) -> Option<u64> {
    let (expiry, nonce) = id.split_once(':')?;
    uuid::Uuid::parse_str(nonce).ok()?;
    expiry.parse().ok()
}

impl StartRequest {
    fn new(id: String, expires: u64, params: Value, cancelled: bool) -> Self {
        Self {
            id,
            expires,
            params: Mutex::new(params),
            started: AtomicBool::new(false),
            data: Mutex::new(RequestData {
                cancelled,
                closed: cancelled,
                ..Default::default()
            }),
            finished: watch::channel(cancelled).0,
            cleanup: AsyncMutex::new(()),
            reaping: AtomicBool::new(false),
        }
    }

    fn rpc_id(&self) -> String {
        format!("session-request:{}", self.id)
    }

    fn snapshot(&self, state: &DaemonState) -> Value {
        let mut data = self.data.lock().unwrap();
        if data.result.is_some()
            && data
                .session
                .as_ref()
                .is_some_and(|s| !same_session(state, s))
        {
            data.session = None;
            data.closed = true;
        }
        let phase = if data.closed {
            "closed"
        } else if data.cleanup_error.is_some() {
            "cleanup_failed"
        } else if data.cancelled {
            "cancelling"
        } else if !self.started.load(Ordering::SeqCst) {
            "prepared"
        } else if data.result.is_none() {
            "starting"
        } else if matches!(data.result, Some(ResponseBody::Err(_))) {
            "failed"
        } else if data.claimed {
            "active"
        } else {
            "ready"
        };
        json!({
            "request_id": self.id, "state": phase,
            "session": data.session.as_ref().map(|session| state.sessions.status_entry(session)),
            "cleanup_error": data.cleanup_error,
        })
    }
}

fn same_session(state: &DaemonState, session: &Session) -> bool {
    state.sessions.get(&session.id).is_some_and(|current| {
        current.browser_id == session.browser_id
            && current.created_at_ms == session.created_at_ms
            && current.agent_window_id == session.agent_window_id
    })
}

pub(super) async fn start(
    state: &Arc<DaemonState>,
    rpc_id: String,
    mut params: Value,
) -> ResponseBody {
    let Some(id) = params
        .get("request_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return error(ErrorCode::InvalidParams, "request_id is required");
    };
    let Some(expires) = token_expiry(&id) else {
        return error(
            ErrorCode::InvalidParams,
            "request_id must be <expiry-unix-ms>:<UUID>",
        );
    };
    let now = now_ms();
    if expires <= now || expires > now.saturating_add(MAX_ADMISSION_MS) {
        return error(
            ErrorCode::InvalidParams,
            "request expired or admission deadline exceeds ten minutes; use a new request_id",
        );
    }
    params.as_object_mut().unwrap().remove("request_id");
    let (entry, fresh) = {
        let requests = state.session_requests.0.lock().unwrap();
        let Some(entry) = requests.get(&id) else {
            return error(
                ErrorCode::InvalidParams,
                "request is not prepared or the daemon restarted; prepare a new request before starting",
            );
        };
        let cancelled = entry.data.lock().unwrap().cancelled;
        let fresh = !cancelled && !entry.started.swap(true, Ordering::SeqCst);
        let mut original = entry.params.lock().unwrap();
        if fresh {
            *original = params.clone();
        } else if !cancelled && *original != params {
            return error(
                ErrorCode::InvalidParams,
                "request_id already used with different start parameters",
            );
        }
        (entry.clone(), fresh)
    };
    if fresh {
        let state = state.clone();
        let entry = entry.clone();
        // Owned by the daemon, not the IPC reader or a plugin process.
        tokio::spawn(async move {
            let cancelled = entry.data.lock().unwrap().cancelled;
            let result = if cancelled {
                error(ErrorCode::Cancelled, "start request cancelled")
            } else {
                match super::ipc::handle_session_start(&state, entry.rpc_id(), params, true).await {
                    Ok(value) => ResponseBody::Ok(value),
                    Err(err) => ResponseBody::Err(err),
                }
            };
            {
                let mut data = entry.data.lock().unwrap();
                let session_id = match &result {
                    ResponseBody::Ok(value) => value.get("session_id").and_then(Value::as_str),
                    ResponseBody::Err(err) => err
                        .data
                        .as_ref()
                        .and_then(|v| v.get("session_id"))
                        .and_then(Value::as_str),
                };
                data.session = session_id.and_then(|id| state.sessions.get(&SessionId(id.into())));
                if matches!(result, ResponseBody::Err(_)) {
                    data.cancelled = true;
                }
                data.result = Some(result);
            }
            entry.finished.send_replace(true);
            if entry.data.lock().unwrap().cancelled {
                cleanup(&state, &entry).await;
            }
        });
    }
    let guard = match state.abort_registry.register(rpc_id) {
        Ok(guard) => guard,
        Err(_) => return error(ErrorCode::InvalidParams, "duplicate start RPC id"),
    };
    let mut finished = entry.finished.subscribe();
    tokio::select! {
        _ = async { let _ = finished.wait_for(|done| *done).await; } => {},
        _ = guard.token().cancelled() => { cancel(state, &entry).await; },
    }
    entry.snapshot(state);
    let data = entry.data.lock().unwrap();
    if let Some(ResponseBody::Err(err)) = &data.result {
        return ResponseBody::Err(err.clone());
    }
    if data.cancelled || data.closed {
        error(
            ErrorCode::Cancelled,
            "start request cancelled; inspect session request for cleanup status",
        )
    } else {
        data.result
            .clone()
            .unwrap_or_else(|| error(ErrorCode::Cancelled, "start request cancelled"))
    }
}

pub(super) async fn operate(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
    let Some(id) = params.get("request_id").and_then(Value::as_str) else {
        return error(ErrorCode::InvalidParams, "request_id is required");
    };
    let Some(expires) = token_expiry(id) else {
        return error(ErrorCode::InvalidParams, "invalid request_id");
    };
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("status");
    if !matches!(action, "status" | "prepare" | "cancel" | "claim") {
        return error(
            ErrorCode::InvalidParams,
            "action must be status, prepare, cancel, or claim",
        );
    }
    let entry = {
        let mut requests = state.session_requests.0.lock().unwrap();
        if let Some(entry) = requests.get(id) {
            Some(entry.clone())
        } else if matches!(action, "prepare" | "cancel") && expires > now_ms() {
            if expires > now_ms().saturating_add(MAX_ADMISSION_MS) || requests.len() >= MAX_REQUESTS
            {
                return error(
                    ErrorCode::InvalidParams,
                    "cannot reserve cancellation tombstone",
                );
            }
            // Cancellation before start is terminal, not a no-op.
            let entry = Arc::new(StartRequest::new(
                id.into(),
                expires,
                Value::Null,
                action == "cancel",
            ));
            requests.insert(id.into(), entry.clone());
            Some(entry)
        } else {
            None
        }
    };
    let Some(entry) = entry else {
        return if action == "claim" {
            error(ErrorCode::NotFound, "start request not found")
        } else {
            ResponseBody::Ok(
                json!({"request_id": id, "state": if expires <= now_ms() {"closed"} else {"unknown"}, "session": null}),
            )
        };
    };
    if action == "cancel" {
        cancel(state, &entry).await;
    }
    if action == "claim" {
        let mut data = entry.data.lock().unwrap();
        if data.cancelled
            || data.closed
            || (entry.expires <= now_ms() && !data.claimed)
            || !matches!(data.result, Some(ResponseBody::Ok(_)))
            || !data
                .session
                .as_ref()
                .is_some_and(|s| same_session(state, s))
        {
            return error(ErrorCode::Cancelled, "start request cannot be claimed");
        }
        data.claimed = true;
    }
    ResponseBody::Ok(entry.snapshot(state))
}

async fn cancel(state: &Arc<DaemonState>, entry: &Arc<StartRequest>) {
    {
        let mut data = entry.data.lock().unwrap();
        data.cancelled = true;
        if !entry.started.load(Ordering::SeqCst) {
            data.closed = true;
            entry.finished.send_replace(true);
        }
    }
    state.abort_registry.cancel(&entry.rpc_id());
    let mut finished = entry.finished.subscribe();
    if tokio::time::timeout(Duration::from_secs(5), finished.wait_for(|done| *done))
        .await
        .is_ok()
    {
        cleanup(state, entry).await;
    }
    // If start is still settling its worker will perform cleanup itself.
}

async fn cleanup(state: &Arc<DaemonState>, entry: &StartRequest) {
    let _serial = entry.cleanup.lock().await;
    let session = entry.data.lock().unwrap().session.clone();
    let result = match session {
        Some(session) if same_session(state, &session) => stop_session(
            &state.browsers,
            &state.sessions,
            &state.tool_queues,
            &state.session_interrupts,
            &session.id,
            Duration::from_secs(10),
            None,
        )
        .await
        .map(|_| state.transfers.release_session(&session.id.0))
        .map_err(|err| err.to_string()),
        _ => Ok(()),
    };
    let mut data = entry.data.lock().unwrap();
    match result {
        Ok(()) => {
            data.closed = true;
            data.session = None;
            data.cleanup_error = None;
        }
        Err(err) => {
            data.cleanup_error = Some(err);
        }
    }
}

/// Shares the daemon's existing reaper. Failed cleanup remains retryable, and a
/// dead caller cannot keep an unclaimed request alive by losing its reply.
pub(super) fn reap(state: &Arc<DaemonState>) {
    let now = now_ms();
    let entries: Vec<_> = state
        .session_requests
        .0
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect();
    for entry in entries {
        entry.snapshot(state);
        let (closed, needs_cleanup) = {
            let data = entry.data.lock().unwrap();
            (
                data.closed,
                !data.closed && (data.cancelled || (!data.claimed && entry.expires <= now)),
            )
        };
        if closed && entry.expires <= now {
            state.session_requests.0.lock().unwrap().remove(&entry.id);
        } else if needs_cleanup && !entry.reaping.swap(true, Ordering::SeqCst) {
            let state = state.clone();
            tokio::spawn(async move {
                cancel(&state, &entry).await;
                entry.reaping.store(false, Ordering::SeqCst);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::start::DaemonConfig;
    use super::*;

    fn state() -> Arc<DaemonState> {
        Arc::new(DaemonState::new(DaemonConfig::new(0)))
    }
    fn id(expires: u64) -> String {
        format!("{expires}:{}", uuid::Uuid::new_v4())
    }
    fn value(body: ResponseBody) -> Value {
        match body {
            ResponseBody::Ok(v) => v,
            _ => panic!("{body:?}"),
        }
    }

    #[tokio::test]
    async fn cancelled_before_prepare_cannot_be_resurrected() {
        let state = state();
        let id = id(now_ms() + 60_000);
        assert_eq!(
            value(operate(&state, json!({"request_id": id, "action":"cancel"})).await)["state"],
            "closed"
        );
        assert_eq!(
            value(operate(&state, json!({"request_id": id, "action":"prepare"})).await)["state"],
            "closed"
        );
        assert!(matches!(
            start(&state, "late".into(), json!({"request_id":id})).await,
            ResponseBody::Err(RpcError {
                code: ErrorCode::Cancelled,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn daemon_restart_cannot_accept_an_old_prepared_start() {
        let old = state();
        let id = id(now_ms() + 60_000);
        assert_eq!(
            value(operate(&old, json!({"request_id":id,"action":"prepare"})).await)["state"],
            "prepared"
        );
        let new = state();
        assert!(matches!(
            start(&new, "late".into(), json!({"request_id":id})).await,
            ResponseBody::Err(RpcError {
                code: ErrorCode::InvalidParams,
                ..
            })
        ));
        assert!(new.sessions.is_empty());
    }

    #[tokio::test]
    async fn expired_unclaimed_requests_are_cancelled_and_tombstones_can_be_collected() {
        let state = state();
        let expires = now_ms() - 1;
        let id = id(expires);
        let entry = Arc::new(StartRequest::new(id.clone(), expires, Value::Null, false));
        state
            .session_requests
            .0
            .lock()
            .unwrap()
            .insert(id.clone(), entry.clone());
        reap(&state);
        tokio::task::yield_now().await;
        assert_eq!(entry.snapshot(&state)["state"], "closed");
        reap(&state);
        assert!(!state.session_requests.0.lock().unwrap().contains_key(&id));
        assert!(matches!(
            start(&state, "late".into(), json!({"request_id":id})).await,
            ResponseBody::Err(_)
        ));
    }

    #[tokio::test]
    async fn malformed_and_far_future_tokens_never_allocate_requests() {
        let state = state();
        for id in [
            "anything".to_string(),
            id(now_ms() + MAX_ADMISSION_MS + 60_000),
        ] {
            assert!(matches!(
                operate(&state, json!({"request_id":id,"action":"prepare"})).await,
                ResponseBody::Err(_)
            ));
            assert!(matches!(
                start(&state, "bad".into(), json!({"request_id":id})).await,
                ResponseBody::Err(_)
            ));
        }
        assert!(state.session_requests.0.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
mod ownership_tests {
    use super::super::{browsers::BrowserId, start::DaemonConfig};
    use super::*;

    fn session(id: &str, window: i64) -> Session {
        Session {
            container_mode: None,
            id: SessionId(id.into()),
            browser_id: BrowserId("browser".into()),
            agent_window_id: Some(window),
            created_at_ms: window,
            interaction: None,
        }
    }

    #[tokio::test]
    async fn lease_reaps_ready_requests_but_keeps_claimed_sessions() {
        let state = Arc::new(DaemonState::new(DaemonConfig::new(0)));
        let mut entries = Vec::new();
        for claimed in [false, true] {
            let session = session(
                if claimed { "live" } else { "lost" },
                if claimed { 2 } else { 1 },
            );
            state.sessions.insert(session.clone());
            let expires = now_ms() - 1;
            let id = format!("{expires}:{}", uuid::Uuid::new_v4());
            let entry = Arc::new(StartRequest::new(id.clone(), expires, Value::Null, false));
            entry.started.store(true, Ordering::SeqCst);
            entry.finished.send_replace(true);
            {
                let mut data = entry.data.lock().unwrap();
                data.claimed = claimed;
                data.session = Some(session);
                data.result = Some(ResponseBody::Ok(json!({})));
            }
            state
                .session_requests
                .0
                .lock()
                .unwrap()
                .insert(id, entry.clone());
            entries.push(entry);
        }
        reap(&state);
        tokio::task::yield_now().await;
        assert!(entries[0].data.lock().unwrap().cancelled);
        // No browser connected in this unit test: preserve ownership and retry.
        assert_eq!(entries[0].snapshot(&state)["state"], "cleanup_failed");
        assert!(!entries[1].data.lock().unwrap().cancelled);
        assert_eq!(entries[1].snapshot(&state)["state"], "active");
    }

    #[tokio::test]
    async fn stale_request_never_closes_a_reused_short_session_id() {
        let state = Arc::new(DaemonState::new(DaemonConfig::new(0)));
        let expires = now_ms() + 60_000;
        let id = format!("{expires}:{}", uuid::Uuid::new_v4());
        let entry = Arc::new(StartRequest::new(id.clone(), expires, Value::Null, false));
        entry.started.store(true, Ordering::SeqCst);
        entry.finished.send_replace(true);
        {
            let mut data = entry.data.lock().unwrap();
            data.session = Some(session("same", 1));
            data.result = Some(ResponseBody::Ok(json!({})));
        }
        state.sessions.insert(session("same", 2));
        state
            .session_requests
            .0
            .lock()
            .unwrap()
            .insert(id.clone(), entry.clone());
        cancel(&state, &entry).await;
        assert_eq!(entry.snapshot(&state)["state"], "closed");
        assert_eq!(
            state
                .sessions
                .get(&SessionId("same".into()))
                .unwrap()
                .agent_window_id,
            Some(2)
        );
    }
}
