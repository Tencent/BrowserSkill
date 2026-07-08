//! Per-session serial dispatch queue for `tool.*` RPCs (design §5,
//! plan M6.5).
//!
//! Every active session owns one [`SessionQueue`] backed by an
//! `mpsc::channel(QUEUE_CAPACITY)` and a worker task. The worker pulls
//! one job at a time, forwards it to the owning extension over WS,
//! awaits the response, and only then handles the next job. This keeps
//! the extension-side ref-store / debugger session from racing under
//! concurrent agent tool calls.
//!
//! Lifecycle:
//! * [`ToolQueueRegistry::spawn`] is called from `start_session`
//!   after the daemon and extension agree on a fresh session id.
//! * [`ToolQueueRegistry::remove`] is called from `stop_session` /
//!   `purge_browser` / `forget_session`. Dropping the sender closes
//!   the channel and the worker exits cleanly.
//! * Cancel is wired through
//!   [`super::inflight::ToolInflightRegistry::cancel_session`] (see
//!   the "Session-wide cancel and queued jobs" section below); the
//!   worker's pre-flight check in `forward_one` short-circuits any
//!   already-cancelled job without a WS round-trip.
//!
//! ## Session-wide cancel and queued jobs
//!
//! [`super::inflight::ToolInflightRegistry::cancel_session`] flips the
//! cancel flag on every inflight entry for a session in O(N). Queued
//! [`ToolJob`]s whose `inflight` entry is now cancelled remain in the
//! worker's mpsc channel until pulled, but the worker's pre-flight
//! check in `forward_one` short-circuits them with `UserAborted` (or
//! `Cancelled`, depending on the recorded `CancelReason`) without any
//! WS round-trip. Per-session [`QUEUE_CAPACITY`] is 64 so the worst-case
//! drain is microseconds — adding a registry-side drain method would
//! force reaching into the mpsc receiver from outside the worker,
//! which tokio mpsc does not support, so we deliberately skip it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bsk_protocol::{ErrorCode, Frame, Method, RequestFrame, ResponseBody, RpcError, RpcId};
use rand::Rng;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, warn};

use super::browsers::BrowserRegistry;
use super::inflight::{PromoteOutcome, ToolInflightEntry};
use super::sessions::{SessionId, SessionRegistry};

/// Bounded queue capacity per session. Picked per design §5 ("tokio
/// mpsc channel(64)"). A queue overflowing this many in-flight jobs
/// is treated as backpressure and surfaced to the caller via
/// [`DispatchError::QueueFull`].
pub const QUEUE_CAPACITY: usize = 64;

/// Default per-tool RPC timeout. Real callers should pass an
/// explicit value through [`ToolJob::timeout`]; this constant exists
/// so tests can default it.
pub const DEFAULT_TOOL_TIMEOUT: Duration = Duration::from_secs(30);

/// Job submitted into a session queue. Carries everything the worker
/// needs to forward one RPC and one oneshot to deliver the answer.
pub struct ToolJob {
    pub method: Method,
    pub params: Value,
    pub timeout: Duration,
    pub respond: oneshot::Sender<Result<Value, RpcError>>,
    /// Inflight handle pre-registered by the IPC handler before the
    /// job entered the queue (review C2). Holds the cancel token plus
    /// the queued/forwarded state machine; the worker checks it on
    /// pre-flight (so a cancel arriving while the job was still
    /// queued short-circuits without ever touching the extension)
    /// and selects on `cancel.cancelled()` while awaiting the WS
    /// response (so a cancel arriving mid-flight unblocks the worker
    /// the same way the WS-side cancel frame already did).
    ///
    /// `None` for daemon-internal callers that do not flow through an
    /// IPC request id (e.g. `session.stop`'s queued teardown call —
    /// those already carry their own bespoke retry / abort path).
    pub inflight: Option<Arc<ToolInflightEntry>>,
    /// Owning session — used by `ToolInflightRegistry::cancel_session`
    /// to drain queued jobs that have not yet been promoted to
    /// "forwarded". Worker callers also have access to it via the
    /// task argument; carrying it on the job lets the registry
    /// short-circuit queued jobs without needing a back-channel.
    pub session_id: SessionId,
}

/// Errors surfaced by [`ToolQueueRegistry::dispatch`].
#[derive(Debug, thiserror::Error)]
pub enum DispatchError {
    /// Session id does not have a queue (either never started or was
    /// stopped concurrently with this dispatch).
    #[error("session not registered or already stopped")]
    SessionNotFound,
    /// Session is draining for `session.stop`; new tool calls must not
    /// enter behind the queued stop request.
    #[error("session is stopping")]
    SessionStopping,
    /// Session already has an active tool RPC; callers must wait for it
    /// to finish (or cancel it) before submitting another command.
    #[error("session already has an unfinished command")]
    SessionBusy,
    /// Queue is at [`QUEUE_CAPACITY`] outstanding jobs.
    #[error("session queue is full")]
    QueueFull,
    /// Worker exited before responding (typically because the session
    /// was stopped mid-flight).
    #[error("session queue closed before response")]
    QueueClosed,
    /// Daemon-side timeout waiting for the worker to respond.
    #[error("dispatch timed out waiting for worker reply")]
    Timeout,
    /// Worker forwarded the request to the extension and got a
    /// structured error back (or synthesised one from a transport
    /// failure).
    #[error("rpc failed: {0:?}")]
    Rpc(RpcError),
}

impl DispatchError {
    /// Convert this dispatch outcome into a structured [`RpcError`]
    /// suitable for sending back over the IPC line.
    pub fn into_rpc(self) -> RpcError {
        match self {
            DispatchError::SessionNotFound => RpcError {
                code: ErrorCode::NotFound,
                message: "session not registered or already stopped".into(),
                data: None,
            },
            DispatchError::SessionStopping => RpcError {
                code: ErrorCode::Timeout,
                message: "session is stopping".into(),
                data: None,
            },
            DispatchError::SessionBusy => session_busy_rpc(),
            DispatchError::QueueFull => RpcError {
                code: ErrorCode::ProtocolError,
                message: "per-session queue overflow; retry shortly".into(),
                data: None,
            },
            DispatchError::QueueClosed => RpcError {
                code: ErrorCode::ProtocolError,
                message: "session queue closed mid-call".into(),
                data: None,
            },
            DispatchError::Timeout => RpcError {
                code: ErrorCode::Timeout,
                message: "tool dispatch timed out".into(),
                data: None,
            },
            DispatchError::Rpc(err) => err,
        }
    }
}

/// Per-session dispatch state shared between the registry and worker.
#[derive(Debug, Default)]
struct QueueState {
    busy: bool,
}

fn session_busy_rpc() -> RpcError {
    RpcError {
        code: ErrorCode::Timeout,
        message: "session already has an unfinished command".into(),
        data: Some(serde_json::json!({ "reason": crate::rpc_reason::SESSION_BUSY })),
    }
}

fn clear_busy(state: &Mutex<QueueState>) {
    let mut guard = state.lock().expect("queue state poisoned");
    guard.busy = false;
}

#[derive(Debug)]
struct QueueEntry {
    sender: mpsc::Sender<ToolJob>,
    accepting: bool,
    state: Arc<Mutex<QueueState>>,
}

/// Registry mapping `SessionId` → per-session queue + worker.
pub struct ToolQueueRegistry {
    queues: Mutex<HashMap<SessionId, QueueEntry>>,
    browsers: Arc<BrowserRegistry>,
    sessions: Arc<SessionRegistry>,
}

impl std::fmt::Debug for ToolQueueRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolQueueRegistry")
            .field("len", &self.len())
            .finish()
    }
}

impl ToolQueueRegistry {
    pub fn new(browsers: Arc<BrowserRegistry>, sessions: Arc<SessionRegistry>) -> Self {
        Self {
            queues: Mutex::new(HashMap::new()),
            browsers,
            sessions,
        }
    }

    pub fn len(&self) -> usize {
        self.queues
            .lock()
            .expect("tool queue registry poisoned")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether `sid`'s queue is still accepting new tool dispatches.
    pub fn is_accepting(&self, sid: &SessionId) -> bool {
        let guard = self.queues.lock().expect("tool queue registry poisoned");
        guard.get(sid).is_some_and(|entry| entry.accepting)
    }

    /// Spawn the worker task for a session id. Idempotent: spawning the
    /// same id twice replaces the previous queue (the previous worker
    /// closes when its sender drops).
    pub fn spawn(&self, sid: SessionId) {
        let (tx, rx) = mpsc::channel::<ToolJob>(QUEUE_CAPACITY);
        let state = Arc::new(Mutex::new(QueueState::default()));
        let previous = self
            .queues
            .lock()
            .expect("tool queue registry poisoned")
            .insert(
                sid.clone(),
                QueueEntry {
                    sender: tx,
                    accepting: true,
                    state: Arc::clone(&state),
                },
            );
        if previous.is_some() {
            warn!(
                session = %sid,
                "tool queue respawned; previous worker will drain remaining jobs and exit"
            );
        }
        let browsers = Arc::clone(&self.browsers);
        let sessions = Arc::clone(&self.sessions);
        tokio::spawn(async move {
            run_worker(sid, rx, state, browsers, sessions).await;
        });
    }

    /// Drop the sender for `sid`. The worker observes the closed
    /// channel and exits after finishing any job already taken from
    /// the queue. Returns `true` if a queue was actually removed.
    pub fn remove(&self, sid: &SessionId) -> bool {
        self.queues
            .lock()
            .expect("tool queue registry poisoned")
            .remove(sid)
            .is_some()
    }

    /// Re-open a queue that was marked closing by `session.stop` when
    /// the extension reports that teardown could not safely complete.
    pub fn reopen(&self, sid: &SessionId) -> bool {
        let mut guard = self.queues.lock().expect("tool queue registry poisoned");
        let Some(entry) = guard.get_mut(sid) else {
            return false;
        };
        entry.accepting = true;
        true
    }

    /// Submit a job into `sid`'s queue and await the worker's response.
    /// The wait is bounded by `job.timeout + 1s` so a worker stuck on
    /// `pending.register()` cannot pin the caller forever.
    pub async fn dispatch(
        &self,
        sid: &SessionId,
        method: Method,
        params: Value,
        timeout: Duration,
        inflight: Option<Arc<ToolInflightEntry>>,
    ) -> Result<Value, DispatchError> {
        let (sender, state) = {
            let guard = self.queues.lock().expect("tool queue registry poisoned");
            let Some(entry) = guard.get(sid) else {
                return Err(DispatchError::SessionNotFound);
            };
            if !entry.accepting {
                return Err(DispatchError::SessionStopping);
            }
            let mut queue_state = entry.state.lock().expect("queue state poisoned");
            if queue_state.busy {
                return Err(DispatchError::SessionBusy);
            }
            queue_state.busy = true;
            (entry.sender.clone(), Arc::clone(&entry.state))
        };
        dispatch_with_sender(
            sender,
            state,
            sid.clone(),
            method,
            params,
            timeout,
            false,
            inflight,
        )
        .await
    }

    /// Stop accepting new jobs for `sid`, enqueue one final control RPC,
    /// and wait for it behind any already-queued tools. Used by
    /// `session.stop` so extension teardown cannot race an in-flight
    /// `snapshot` / `get_html` call for the same session.
    pub async fn dispatch_after_closing(
        &self,
        sid: &SessionId,
        method: Method,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, DispatchError> {
        let (sender, state) = {
            let mut guard = self.queues.lock().expect("tool queue registry poisoned");
            let Some(entry) = guard.get_mut(sid) else {
                return Err(DispatchError::SessionNotFound);
            };
            if !entry.accepting {
                return Err(DispatchError::SessionStopping);
            }
            let mut queue_state = entry.state.lock().expect("queue state poisoned");
            if queue_state.busy {
                return Err(DispatchError::SessionBusy);
            }
            queue_state.busy = true;
            entry.accepting = false;
            (entry.sender.clone(), Arc::clone(&entry.state))
        };
        dispatch_with_sender(
            sender,
            state,
            sid.clone(),
            method,
            params,
            timeout,
            true,
            None,
        )
        .await
    }
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_with_sender(
    sender: mpsc::Sender<ToolJob>,
    state: Arc<Mutex<QueueState>>,
    session_id: SessionId,
    method: Method,
    params: Value,
    timeout: Duration,
    wait_for_capacity: bool,
    inflight: Option<Arc<ToolInflightEntry>>,
) -> Result<Value, DispatchError> {
    let (respond_tx, respond_rx) = oneshot::channel();
    let job = ToolJob {
        method,
        params,
        timeout,
        respond: respond_tx,
        inflight,
        session_id,
    };
    if wait_for_capacity {
        let waited = tokio::time::timeout(
            timeout.saturating_add(Duration::from_secs(1)),
            sender.send(job),
        )
        .await;
        match waited {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {
                clear_busy(&state);
                return Err(DispatchError::QueueClosed);
            }
            Err(_) => {
                clear_busy(&state);
                return Err(DispatchError::Timeout);
            }
        }
    } else if let Err(send_err) = sender.try_send(job) {
        clear_busy(&state);
        return Err(match send_err {
            mpsc::error::TrySendError::Full(_) => DispatchError::QueueFull,
            mpsc::error::TrySendError::Closed(_) => DispatchError::QueueClosed,
        });
    }
    let waited =
        tokio::time::timeout(timeout.saturating_add(Duration::from_secs(1)), respond_rx).await;
    match waited {
        Ok(Ok(Ok(v))) => Ok(v),
        Ok(Ok(Err(rpc))) => Err(DispatchError::Rpc(rpc)),
        Ok(Err(_)) => Err(DispatchError::QueueClosed),
        Err(_) => Err(DispatchError::Timeout),
    }
}

async fn run_worker(
    sid: SessionId,
    mut rx: mpsc::Receiver<ToolJob>,
    state: Arc<Mutex<QueueState>>,
    browsers: Arc<BrowserRegistry>,
    sessions: Arc<SessionRegistry>,
) {
    debug!(session = %sid, "tool queue worker started");
    while let Some(job) = rx.recv().await {
        let result = forward_one(&sid, &browsers, &sessions, &job).await;
        clear_busy(&state);
        let _ = job.respond.send(result);
    }
    debug!(session = %sid, "tool queue worker exiting");
}

/// Forward a single [`ToolJob`] over WS to the extension that owns the
/// session and decode the structured response.
async fn forward_one(
    sid: &SessionId,
    browsers: &Arc<BrowserRegistry>,
    sessions: &Arc<SessionRegistry>,
    job: &ToolJob,
) -> Result<Value, RpcError> {
    // Pre-flight: a cancel that landed while this job was still in
    // the per-session channel must short-circuit before any session
    // / browser resolution work, and before any WS frame leaves the
    // daemon (review C2). We keep the `tokio::select!` later so
    // cancels arriving mid-WS-hop also unblock the worker.
    if let Some(entry) = job.inflight.as_ref()
        && entry.is_cancelled()
    {
        return Err(cancelled_error(
            Some(entry),
            "tool dispatch cancelled before forwarding",
        ));
    }
    let Some(session) = sessions.get(sid) else {
        return Err(RpcError {
            code: ErrorCode::NotFound,
            message: format!("session {sid} no longer exists"),
            data: None,
        });
    };
    let Some(client) = browsers.get(&session.browser_id) else {
        return Err(RpcError {
            code: ErrorCode::NotFound,
            message: "owning browser is no longer connected".into(),
            data: None,
        });
    };
    let rpc_id = next_rpc_id("tool");
    let waiter = {
        let mut pending = client.pending.lock().unwrap();
        pending.register(rpc_id.clone())
    };
    let request = Frame::Request(RequestFrame {
        id: rpc_id.clone(),
        method: job.method.clone(),
        params: Some(job.params.clone()),
    });
    // Promote the inflight entry to "forwarded" AND push the WS
    // request frame to the sink inside the same critical section
    // (review round 2 C1). The closure runs while the entry's inner
    // lock is held, so a concurrent `cancel` either:
    //   * acquires the lock first → `cancelled` is set → the closure
    //     never runs → no WS frame escapes the daemon;
    //   * acquires the lock AFTER this dispatch → snapshot is
    //     Some/Some → the cancel caller forwards a WS cancel frame,
    //     which is enqueued strictly behind the request we just
    //     pushed, preserving the "request-before-cancel" wire order.
    let cancel_token = match job.inflight.as_ref() {
        Some(entry) => {
            let outcome =
                entry.promote_to_forwarded_with(session.browser_id.clone(), rpc_id.clone(), || {
                    client.sink.send(request).is_ok()
                });
            match outcome {
                PromoteOutcome::Promoted => Some(entry.cancel_token()),
                PromoteOutcome::Cancelled => {
                    client.pending.lock().unwrap().cancel(&rpc_id);
                    return Err(cancelled_error(
                        Some(entry),
                        "tool dispatch cancelled before forwarding",
                    ));
                }
                PromoteOutcome::SendFailed => {
                    client.pending.lock().unwrap().cancel(&rpc_id);
                    return Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: "browser sink closed before request was queued".into(),
                        data: None,
                    });
                }
            }
        }
        None => {
            // Daemon-internal callers (e.g. queued session.stop drain)
            // don't carry an inflight entry; they cannot be cancelled
            // through the IPC `cancel` surface, so a plain sink send
            // is sufficient and keeps the existing transport-error
            // behaviour.
            if client.sink.send(request).is_err() {
                client.pending.lock().unwrap().cancel(&rpc_id);
                return Err(RpcError {
                    code: ErrorCode::ProtocolError,
                    message: "browser sink closed before request was queued".into(),
                    data: None,
                });
            }
            None
        }
    };
    let waited = await_with_optional_cancel(job.timeout, waiter, cancel_token.as_ref()).await;
    let response = match waited {
        WaitOutcome::Response(resp) => resp,
        WaitOutcome::Cancelled => {
            // Drop the WS waiter so a late extension reply is dropped
            // cleanly (otherwise pending.resolve would log a stale
            // entry). The CLI caller will get a synthesised
            // `cancelled` here even if the extension never answers.
            client.pending.lock().unwrap().cancel(&rpc_id);
            return Err(cancelled_error(
                job.inflight.as_deref(),
                "tool dispatch cancelled mid-flight",
            ));
        }
        WaitOutcome::WaiterClosed => {
            client.pending.lock().unwrap().cancel(&rpc_id);
            return Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: "transport closed mid-call".into(),
                data: None,
            });
        }
        WaitOutcome::Timeout => {
            client.pending.lock().unwrap().cancel(&rpc_id);
            return Err(RpcError {
                code: ErrorCode::Timeout,
                message: format!("tool RPC timed out after {:?}", job.timeout),
                data: None,
            });
        }
    };
    match response.body {
        ResponseBody::Ok(v) => Ok(v),
        ResponseBody::Err(err) => Err(err),
    }
}

#[derive(Debug)]
enum WaitOutcome {
    Response(bsk_protocol::ResponseFrame),
    Cancelled,
    WaiterClosed,
    Timeout,
}

async fn await_with_optional_cancel(
    timeout: Duration,
    waiter: oneshot::Receiver<bsk_protocol::ResponseFrame>,
    cancel: Option<&super::abort::AbortToken>,
) -> WaitOutcome {
    match cancel {
        // Cancel wins if both ready: when a cancel notification and
        // the extension's response are both observable on the same
        // tokio tick, `biased;` polls `token.cancelled()` first and
        // resolves the whole `select!` to `WaitOutcome::Cancelled`.
        // The already-arrived tool result is intentionally dropped.
        //
        // This extends design §4.6 — which only specifies "CLI sends
        // `cancel` on SIGINT and waits for the extension's
        // `cancelled` reply (≤ 2s before forced exit)" — by pinning
        // the same-tick race to a single, observable verdict.
        // Without `biased;`, an extension racing a fast successful
        // reply against a cancel notification could occasionally
        // resolve as `ok` even though the caller had already moved on
        // to compensation logic, leaving the agent trusting state the
        // daemon had just been asked to roll back. Picking
        // cancel-wins keeps the external observation rule simple
        // ("once a cancel is in flight, the in-flight RPC's verdict
        // is `cancelled`") and matches what the CLI / agent already
        // assumes after firing SIGINT. Round 3 M1 / round 4 M2
        // nail-down.
        Some(token) => tokio::select! {
            biased;
            _ = token.cancelled() => WaitOutcome::Cancelled,
            outcome = tokio::time::timeout(timeout, waiter) => match outcome {
                Ok(Ok(resp)) => WaitOutcome::Response(resp),
                Ok(Err(_)) => WaitOutcome::WaiterClosed,
                Err(_) => WaitOutcome::Timeout,
            },
        },
        None => match tokio::time::timeout(timeout, waiter).await {
            Ok(Ok(resp)) => WaitOutcome::Response(resp),
            Ok(Err(_)) => WaitOutcome::WaiterClosed,
            Err(_) => WaitOutcome::Timeout,
        },
    }
}

/// Map an inflight entry's recorded [`CancelReason`] to the right
/// IPC error code + message. Per-RPC `cancel` keeps the legacy
/// `Cancelled`; session-wide `cancel_session` surfaces `UserAborted`
/// with a user-facing message so CLI peers can render "interrupted by
/// user" distinctly from generic cancellations (e.g. `tool.wait_ms`'s
/// own cancel path).
///
/// `entry` may be `None` for daemon-internal callers that have no
/// inflight registration (e.g. the queued `session.stop` drain) or
/// when a cancel surfaces from a path that does not go through
/// [`super::inflight::ToolInflightRegistry::cancel`]; in both cases
/// the result falls back to the legacy `Cancelled` code with
/// `default_msg`.
fn cancelled_error(entry: Option<&ToolInflightEntry>, default_msg: &str) -> RpcError {
    use super::inflight::CancelReason;
    let (code, message) = match entry.and_then(|e| e.cancel_reason()) {
        Some(CancelReason::UserAborted) => (
            ErrorCode::UserAborted,
            "tool dispatch interrupted by user".to_string(),
        ),
        Some(CancelReason::Cancelled) | None => (ErrorCode::Cancelled, default_msg.to_string()),
    };
    RpcError {
        code,
        message,
        data: None,
    }
}

fn next_rpc_id(prefix: &str) -> RpcId {
    let mut rng = rand::thread_rng();
    let s: String = (0..8)
        .map(|_| char::from_digit(rng.gen_range(0..16), 16).unwrap())
        .collect();
    format!("{prefix}-{s}")
}

#[cfg(test)]
mod await_with_optional_cancel_tests {
    //! Regression tests for the `biased;` select! in
    //! [`await_with_optional_cancel`] (review round 3 M1).
    //!
    //! These tests exist to lock the documented semantics — "cancel
    //! wins when both arms are ready on the same tick" — so a future
    //! contributor cannot accidentally flip the priority by either
    //! removing `biased;` or reordering the arms. The flip would be
    //! silent at compile time but would mean a fast extension reply
    //! racing a cancel could still be reported as `ok` to the agent.

    use std::time::Duration;

    use super::*;
    use crate::daemon::abort::AbortToken;
    use bsk_protocol::{ResponseBody, ResponseFrame};

    fn dummy_response() -> ResponseFrame {
        ResponseFrame {
            id: "rpc-test".to_string(),
            body: ResponseBody::Ok(serde_json::json!({"ok": true})),
        }
    }

    #[tokio::test]
    async fn cancel_wins_when_both_response_and_cancel_are_ready() {
        // Pre-cancel the token AND pre-send the response so both
        // futures are immediately Ready at the first poll. With
        // `biased;` selecting cancel first, the verdict MUST be
        // Cancelled — the already-arrived tool result is dropped on
        // the floor per the documented contract.
        let token = AbortToken::new();
        token.cancel();
        let (tx, rx) = oneshot::channel();
        tx.send(dummy_response()).unwrap();

        let outcome = await_with_optional_cancel(Duration::from_secs(10), rx, Some(&token)).await;
        assert!(
            matches!(outcome, WaitOutcome::Cancelled),
            "expected Cancelled when both arms are ready under biased; (got something else)"
        );
    }

    #[tokio::test]
    async fn response_returned_when_cancel_never_fires() {
        // Sanity: with no cancel signal in flight, the response path
        // still works. Catches accidentally swapping the arms (which
        // would make the cancel arm starve the response forever).
        let token = AbortToken::new();
        let (tx, rx) = oneshot::channel();
        tx.send(dummy_response()).unwrap();

        let outcome = await_with_optional_cancel(Duration::from_secs(10), rx, Some(&token)).await;
        match outcome {
            WaitOutcome::Response(frame) => {
                assert!(matches!(frame.body, ResponseBody::Ok(_)));
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn no_cancel_token_still_returns_response() {
        let (tx, rx) = oneshot::channel();
        tx.send(dummy_response()).unwrap();
        let outcome = await_with_optional_cancel(Duration::from_secs(10), rx, None).await;
        assert!(matches!(outcome, WaitOutcome::Response(_)));
    }
}

#[cfg(test)]
mod forward_one_cancel_reason_tests {
    //! Pin that [`cancelled_error`] maps the recorded cancel
    //! reason on an inflight entry to the right IPC error code: a
    //! session-wide `cancel_session` surfaces `UserAborted`, while a
    //! per-RPC `cancel` keeps the legacy `Cancelled`.
    //!
    //! A full `forward_one` integration test would need a live
    //! `BrowserRegistry` + `SessionRegistry` harness; the mapping
    //! helper itself is the only new behaviour added in Task 5, so we
    //! test it directly here. The pre-flight short-circuit (which
    //! calls this helper) is already covered indirectly by the
    //! existing `cancel_*` integration tests in the queue test
    //! suite.
    use super::*;
    use crate::daemon::inflight::{CancelReason, ToolInflightRegistry};
    use crate::daemon::sessions::SessionId;
    use std::sync::Arc;

    #[tokio::test]
    async fn pre_flight_cancel_with_user_aborted_reason_yields_user_aborted_code() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let sid_s = SessionId("S".into());
        let g = reg.register("r".into(), sid_s.clone()).unwrap();
        // Cancel the entry with UserAborted before any worker runs.
        reg.cancel_session(&sid_s);
        assert_eq!(g.entry().cancel_reason(), Some(CancelReason::UserAborted));
        let err = super::cancelled_error(Some(&g.entry()), "fallback");
        assert_eq!(err.code, ErrorCode::UserAborted);
        assert_eq!(err.message, "tool dispatch interrupted by user");
    }

    #[tokio::test]
    async fn pre_flight_cancel_with_cancelled_reason_yields_cancelled_code() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let g = reg.register("r".into(), SessionId("S".into())).unwrap();
        reg.cancel(&"r".to_string()).unwrap();
        assert_eq!(g.entry().cancel_reason(), Some(CancelReason::Cancelled));
        let err = super::cancelled_error(Some(&g.entry()), "fallback msg");
        assert_eq!(err.code, ErrorCode::Cancelled);
        assert_eq!(err.message, "fallback msg");
    }
}

#[cfg(test)]
mod tool_job_session_id_tests {
    use super::*;
    use crate::daemon::sessions::SessionId;
    use bsk_protocol::Method;
    use tokio::sync::oneshot;

    #[test]
    fn tool_job_carries_session_id() {
        let (tx, _rx) = oneshot::channel();
        let job = ToolJob {
            method: Method::ToolTabList,
            params: serde_json::json!({}),
            timeout: Duration::from_secs(1),
            respond: tx,
            inflight: None,
            session_id: SessionId("sess-A".into()),
        };
        assert_eq!(job.session_id.0, "sess-A");
    }
}
