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

use super::abort::AbortToken;
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

/// Once a forwarded request is cancelled, keep the session queue busy while
/// the extension finishes handler-side compensation. This is deliberately
/// bounded so a wedged extension cannot pin the session forever.
pub const CANCEL_CLEANUP_TIMEOUT: Duration = Duration::from_secs(2);

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
    /// and observes `cancel.cancelled()` while awaiting the WS response.
    /// A forwarded cancel keeps the worker busy until the extension's
    /// final response arrives or the bounded cleanup timeout expires.
    ///
    /// `None` for daemon-internal callers that do not flow through an
    /// IPC request id (e.g. `session.stop`'s queued teardown call —
    /// those already carry their own bespoke retry / abort path).
    pub inflight: Option<Arc<ToolInflightEntry>>,
    /// Cancellation token for session-lifecycle work registered in the
    /// daemon-local abort registry. Unlike `inflight`, lifecycle callers
    /// forward their own WS cancel after the request has been queued.
    pub lifecycle_cancel: Option<AbortToken>,
    /// How long cancellation keeps the worker busy while the extension
    /// finishes compensation. Session teardown uses its full RPC budget
    /// so daemon state is reconciled even after the CLI exits.
    pub cancel_cleanup_timeout: Duration,
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

    #[cfg(test)]
    fn force_busy_for_tests(&self, sid: &SessionId, busy: bool) {
        let guard = self.queues.lock().expect("tool queue registry poisoned");
        let entry = guard.get(sid).expect("queue must exist");
        entry.state.lock().expect("queue state poisoned").busy = busy;
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
        self.sessions.touch(sid);
        let outcome = dispatch_with_sender(
            sender,
            state,
            sid.clone(),
            method,
            params,
            timeout,
            false,
            inflight,
            None,
            CANCEL_CLEANUP_TIMEOUT,
        )
        .await;
        // A long-running request may outlive the idle threshold. Touching
        // after completion prevents the reaper from immediately closing it;
        // while it is running, session.stop observes SessionBusy and retries
        // on a later sweep rather than interrupting the tool.
        self.sessions.touch(sid);
        outcome
    }

    /// Forward a tool RPC to the extension without taking the
    /// per-session busy lock. Used by `tool.record_stop` so a second
    /// CLI can finish an in-flight `tool.record_await` (extension
    /// dispatch already runs concurrent `void dispatch(msg)` handlers).
    pub async fn dispatch_unlocked(
        &self,
        sid: &SessionId,
        method: Method,
        params: Value,
        timeout: Duration,
        inflight: Option<Arc<ToolInflightEntry>>,
    ) -> Result<Value, DispatchError> {
        {
            let guard = self.queues.lock().expect("tool queue registry poisoned");
            let Some(entry) = guard.get(sid) else {
                return Err(DispatchError::SessionNotFound);
            };
            if !entry.accepting {
                return Err(DispatchError::SessionStopping);
            }
        }
        let (respond_tx, _respond_rx) = oneshot::channel();
        let job = ToolJob {
            method,
            params,
            timeout,
            respond: respond_tx,
            inflight,
            lifecycle_cancel: None,
            cancel_cleanup_timeout: CANCEL_CLEANUP_TIMEOUT,
            session_id: sid.clone(),
        };
        match forward_one(sid, &self.browsers, &self.sessions, &job).await {
            Ok(v) => Ok(v),
            Err(err) => Err(DispatchError::Rpc(err)),
        }
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
        cancel: Option<AbortToken>,
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
            cancel,
            timeout,
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
    lifecycle_cancel: Option<AbortToken>,
    cancel_cleanup_timeout: Duration,
) -> Result<Value, DispatchError> {
    let effect_aware_transfer = is_effect_aware_transfer(&method);
    let (respond_tx, respond_rx) = oneshot::channel();
    let job = ToolJob {
        method,
        params,
        timeout,
        respond: respond_tx,
        inflight,
        lifecycle_cancel,
        cancel_cleanup_timeout,
        session_id,
    };
    let lifecycle_cancellable = job.lifecycle_cancel.is_some();
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
    // Lifecycle teardown and effect-aware transfers both keep the worker busy
    // for bounded compensation after their original deadline. Keep the outer
    // waiter alive for the same grace period so it cannot abandon reconciliation.
    let response_grace = if lifecycle_cancellable || effect_aware_transfer {
        cancel_cleanup_timeout
    } else {
        Duration::ZERO
    };
    let waited = tokio::time::timeout(
        timeout
            .saturating_add(response_grace)
            .saturating_add(Duration::from_secs(1)),
        respond_rx,
    )
    .await;
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
    if job
        .inflight
        .as_ref()
        .is_some_and(|entry| entry.is_cancelled())
        || job
            .lifecycle_cancel
            .as_ref()
            .is_some_and(AbortToken::is_cancelled)
    {
        return Err(cancelled_error(
            job.inflight.as_deref(),
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
            // Daemon-internal callers do not carry a tool-inflight entry.
            // Session lifecycle jobs instead use the abort-registry token
            // below; other internal callers keep the plain send path.
            if job
                .lifecycle_cancel
                .as_ref()
                .is_some_and(AbortToken::is_cancelled)
            {
                client.pending.lock().unwrap().cancel(&rpc_id);
                return Err(cancelled_error(
                    None,
                    "session lifecycle cancelled before forwarding",
                ));
            }
            if client.sink.send(request).is_err() {
                client.pending.lock().unwrap().cancel(&rpc_id);
                return Err(RpcError {
                    code: ErrorCode::ProtocolError,
                    message: "browser sink closed before request was queued".into(),
                    data: None,
                });
            }
            job.lifecycle_cancel.clone()
        }
    };
    let forward_lifecycle_cancel = || {
        if job.lifecycle_cancel.is_none() {
            return;
        }
        let cancel = Frame::Request(RequestFrame {
            id: format!("cancel-{rpc_id}"),
            method: Method::Cancel,
            params: Some(serde_json::json!({ "rpc_id": rpc_id })),
        });
        if let Err(err) = client.sink.send(cancel) {
            warn!(%rpc_id, ?err, "failed to forward session lifecycle cancel");
        }
    };
    let on_abort: Option<&(dyn Fn() + Sync)> = job
        .lifecycle_cancel
        .as_ref()
        .map(|_| &forward_lifecycle_cancel as &(dyn Fn() + Sync));
    let send_deadline_cancel = || {
        client
            .sink
            .send(Frame::Request(RequestFrame {
                id: format!("deadline-cancel-{rpc_id}"),
                method: Method::Cancel,
                params: Some(serde_json::json!({ "rpc_id": rpc_id })),
            }))
            .is_ok()
    };
    let deadline_cancel: Option<&(dyn Fn() -> bool + Sync)> =
        is_effect_aware_transfer(&job.method).then_some(&send_deadline_cancel);
    let waited = await_with_optional_cancel(
        job.timeout,
        job.cancel_cleanup_timeout,
        waiter,
        cancel_token.as_ref(),
        on_abort,
        deadline_cancel,
    )
    .await;
    let response = match waited {
        WaitOutcome::Response(resp) => resp,
        WaitOutcome::CancelledAfterResponse(resp) => {
            if job.method == Method::ToolSessionStop
                && let ResponseBody::Ok(value) = &resp.body
            {
                // Teardown crossed its final irreversible boundary before
                // the cancel landed. Commit the real extension result so the
                // daemon does not retain a session whose window is gone.
                return Ok(value.clone());
            }
            // File transfer commits are irreversible. A late cancel cannot
            // overwrite a confirmed success, and an unknown transfer effect
            // must remain explicit so callers do not retry or release upload
            // staging as though nothing happened.
            if is_effect_aware_transfer(&job.method) {
                match &resp.body {
                    ResponseBody::Ok(_) => resp,
                    ResponseBody::Err(err)
                        if transfer_effect(err) == Some("unknown")
                            || transfer_effect(err) == Some("committed") =>
                    {
                        return Err(err.clone());
                    }
                    ResponseBody::Err(err)
                        if !matches!(err.code, ErrorCode::Cancelled | ErrorCode::UserAborted) =>
                    {
                        return Err(err.clone());
                    }
                    ResponseBody::Err(_) => {
                        return Err(cancelled_error(
                            job.inflight.as_deref(),
                            "tool dispatch cancelled after extension cleanup",
                        ));
                    }
                }
            } else {
                // For ordinary tools cancellation keeps the existing verdict,
                // while non-cancel errors still expose compensation failures.
                if let ResponseBody::Err(err) = resp.body
                    && !matches!(err.code, ErrorCode::Cancelled | ErrorCode::UserAborted)
                {
                    return Err(err);
                }
                return Err(cancelled_error(
                    job.inflight.as_deref(),
                    "tool dispatch cancelled after extension cleanup",
                ));
            }
        }
        WaitOutcome::TimedOutAfterResponse(resp) => match resp.body {
            ResponseBody::Ok(value)
                if job.method == Method::ToolSessionStop
                    || is_effect_aware_transfer(&job.method) =>
            {
                // The close crossed its irreversible boundary during the
                // timeout cleanup grace, or the transfer committed before its
                // deadline cancel settled. Preserve the irreversible result.
                return Ok(value);
            }
            ResponseBody::Err(err)
                if !matches!(err.code, ErrorCode::Cancelled | ErrorCode::UserAborted) =>
            {
                return Err(err);
            }
            ResponseBody::Err(err) if is_effect_aware_transfer(&job.method) => {
                return Err(timed_out_transfer_error(&err));
            }
            _ => {
                return Err(RpcError {
                    code: ErrorCode::Timeout,
                    message: format!("tool RPC timed out after {:?}", job.timeout),
                    data: None,
                });
            }
        },
        WaitOutcome::CleanupTimeout => {
            client.pending.lock().unwrap().cancel(&rpc_id);
            if is_effect_aware_transfer(&job.method) {
                return Err(unknown_transfer_error(
                    ErrorCode::Timeout,
                    "cancelled file transfer did not confirm its outcome before cleanup timed out",
                    "cleanup",
                    true,
                ));
            }
            return Err(RpcError {
                code: ErrorCode::Timeout,
                message: format!(
                    "cancelled tool did not finish cleanup within {:?}",
                    job.cancel_cleanup_timeout
                ),
                data: Some(serde_json::json!({ "reason": "cancel_cleanup_timeout" })),
            });
        }
        WaitOutcome::TimeoutCleanupFailed => {
            client.pending.lock().unwrap().cancel(&rpc_id);
            return Err(unknown_transfer_error(
                ErrorCode::Timeout,
                "file transfer timed out and cleanup could not be confirmed",
                "cleanup",
                true,
            ));
        }
        WaitOutcome::WaiterClosed => {
            client.pending.lock().unwrap().cancel(&rpc_id);
            if is_effect_aware_transfer(&job.method) {
                return Err(unknown_transfer_error(
                    ErrorCode::ProtocolError,
                    "file transfer transport closed after dispatch; outcome is unknown",
                    "transport",
                    false,
                ));
            }
            return Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: "transport closed mid-call".into(),
                data: None,
            });
        }
        WaitOutcome::Timeout => {
            client.pending.lock().unwrap().cancel(&rpc_id);
            if is_effect_aware_transfer(&job.method) {
                return Err(unknown_transfer_error(
                    ErrorCode::Timeout,
                    "file transfer timed out after dispatch; outcome is unknown",
                    "transport",
                    false,
                ));
            }
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

fn is_effect_aware_transfer(method: &Method) -> bool {
    matches!(method, Method::ToolUpload | Method::ToolDownload)
}

fn transfer_effect(err: &RpcError) -> Option<&str> {
    err.data.as_ref()?.get("effect_state")?.as_str()
}

fn unknown_transfer_error(
    code: ErrorCode,
    message: impl Into<String>,
    phase: &str,
    cleanup_failed: bool,
) -> RpcError {
    let mut data = serde_json::json!({
        "reason": "transfer_outcome_unknown",
        "effect_state": "unknown",
        "phase": phase,
    });
    if cleanup_failed {
        data["cleanup_state"] = serde_json::json!("failed");
    }
    RpcError {
        code,
        message: message.into(),
        data: Some(data),
    }
}

fn timed_out_transfer_error(err: &RpcError) -> RpcError {
    let data = err.data.as_ref();
    RpcError {
        code: ErrorCode::Timeout,
        message: "file transfer timed out after dispatch".into(),
        data: Some(serde_json::json!({
            "reason": "transfer_timeout",
            "effect_state": data
                .and_then(|value| value.get("effect_state"))
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            "phase": data
                .and_then(|value| value.get("phase"))
                .and_then(Value::as_str)
                .unwrap_or("cleanup"),
            "cleanup_state": data
                .and_then(|value| value.get("cleanup_state"))
                .and_then(Value::as_str)
                .unwrap_or("complete"),
        })),
    }
}

#[derive(Debug)]
enum WaitOutcome {
    Response(bsk_protocol::ResponseFrame),
    CancelledAfterResponse(bsk_protocol::ResponseFrame),
    TimedOutAfterResponse(bsk_protocol::ResponseFrame),
    CleanupTimeout,
    TimeoutCleanupFailed,
    WaiterClosed,
    Timeout,
}

async fn await_with_optional_cancel(
    timeout: Duration,
    cleanup_timeout: Duration,
    mut waiter: oneshot::Receiver<bsk_protocol::ResponseFrame>,
    cancel: Option<&super::abort::AbortToken>,
    on_abort: Option<&(dyn Fn() + Sync)>,
    on_deadline: Option<&(dyn Fn() -> bool + Sync)>,
) -> WaitOutcome {
    match cancel {
        Some(token) => {
            let deadline = tokio::time::sleep(timeout);
            tokio::pin!(deadline);
            tokio::select! {
                // Cancel keeps same-tick priority, but it no longer drops the
                // waiter. The worker remains busy until the extension replies
                // after compensation or the cleanup deadline expires.
                biased;
                _ = token.cancelled() => {
                    if let Some(on_abort) = on_abort {
                        on_abort();
                    }
                    match tokio::time::timeout(cleanup_timeout, &mut waiter).await {
                        Ok(Ok(resp)) => WaitOutcome::CancelledAfterResponse(resp),
                        Ok(Err(_)) => WaitOutcome::WaiterClosed,
                        Err(_) => WaitOutcome::CleanupTimeout,
                    }
                },
                outcome = &mut waiter => match outcome {
                    Ok(resp) => WaitOutcome::Response(resp),
                    Err(_) => WaitOutcome::WaiterClosed,
                },
                _ = &mut deadline => {
                    if let Some(send_cancel) = on_deadline {
                        return if send_cancel() {
                            match tokio::time::timeout(cleanup_timeout, &mut waiter).await {
                                Ok(Ok(resp)) => WaitOutcome::TimedOutAfterResponse(resp),
                                Ok(Err(_)) | Err(_) => WaitOutcome::TimeoutCleanupFailed,
                            }
                        } else {
                            WaitOutcome::TimeoutCleanupFailed
                        };
                    }
                    let Some(on_abort) = on_abort else {
                        return WaitOutcome::Timeout;
                    };
                    on_abort();
                    match tokio::time::timeout(cleanup_timeout, &mut waiter).await {
                        Ok(Ok(resp)) => WaitOutcome::TimedOutAfterResponse(resp),
                        Ok(Err(_)) => WaitOutcome::WaiterClosed,
                        Err(_) => WaitOutcome::CleanupTimeout,
                    }
                },
            }
        }
        None => match tokio::time::timeout(timeout, &mut waiter).await {
            Ok(Ok(resp)) => WaitOutcome::Response(resp),
            Ok(Err(_)) => WaitOutcome::WaiterClosed,
            Err(_) => match on_deadline {
                Some(send_cancel) if send_cancel() => {
                    match tokio::time::timeout(cleanup_timeout, &mut waiter).await {
                        Ok(Ok(resp)) => WaitOutcome::TimedOutAfterResponse(resp),
                        Ok(Err(_)) | Err(_) => WaitOutcome::TimeoutCleanupFailed,
                    }
                }
                Some(_) => WaitOutcome::TimeoutCleanupFailed,
                None => WaitOutcome::Timeout,
            },
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

        let outcome = await_with_optional_cancel(
            Duration::from_secs(10),
            Duration::from_secs(1),
            rx,
            Some(&token),
            None,
            None,
        )
        .await;
        assert!(
            matches!(outcome, WaitOutcome::CancelledAfterResponse(_)),
            "expected cancellation to win while retaining the ready response"
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

        let outcome = await_with_optional_cancel(
            Duration::from_secs(10),
            Duration::from_secs(1),
            rx,
            Some(&token),
            None,
            None,
        )
        .await;
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
        let outcome = await_with_optional_cancel(
            Duration::from_secs(10),
            Duration::from_secs(1),
            rx,
            None,
            None,
            None,
        )
        .await;
        assert!(matches!(outcome, WaitOutcome::Response(_)));
    }

    #[tokio::test]
    async fn cancelled_waiter_stays_pending_until_cleanup_response_arrives() {
        let token = AbortToken::new();
        let (tx, rx) = oneshot::channel();
        token.cancel();
        let pending = tokio::spawn(async move {
            await_with_optional_cancel(
                Duration::from_secs(10),
                Duration::from_secs(1),
                rx,
                Some(&token),
                None,
                None,
            )
            .await
        });

        tokio::task::yield_now().await;
        assert!(!pending.is_finished());
        tx.send(dummy_response()).unwrap();
        assert!(matches!(
            pending.await.unwrap(),
            WaitOutcome::CancelledAfterResponse(_)
        ));
    }

    #[tokio::test]
    async fn cancelled_waiter_releases_after_cleanup_timeout() {
        let token = AbortToken::new();
        let (_tx, rx) = oneshot::channel();
        token.cancel();
        let outcome = await_with_optional_cancel(
            Duration::from_secs(10),
            Duration::from_millis(10),
            rx,
            Some(&token),
            None,
            None,
        )
        .await;
        assert!(matches!(outcome, WaitOutcome::CleanupTimeout));
    }

    #[tokio::test]
    async fn lifecycle_timeout_forwards_abort_and_waits_for_cleanup_response() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let token = AbortToken::new();
        let (tx, rx) = oneshot::channel();
        let abort_forwarded = AtomicBool::new(false);
        let forward_abort = || abort_forwarded.store(true, Ordering::SeqCst);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            tx.send(dummy_response()).unwrap();
        });

        let outcome = await_with_optional_cancel(
            Duration::from_millis(5),
            Duration::from_millis(100),
            rx,
            Some(&token),
            Some(&forward_abort),
            None,
        )
        .await;

        assert!(abort_forwarded.load(Ordering::SeqCst));
        assert!(matches!(outcome, WaitOutcome::TimedOutAfterResponse(_)));
    }

    #[tokio::test]
    async fn transfer_deadline_sends_cancel_and_waits_for_cleanup_response() {
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            tx.send(dummy_response()).unwrap();
        });
        let send_cancel = || true;
        let outcome = await_with_optional_cancel(
            Duration::from_millis(1),
            Duration::from_secs(1),
            rx,
            None,
            None,
            Some(&send_cancel),
        )
        .await;
        assert!(matches!(outcome, WaitOutcome::TimedOutAfterResponse(_)));
    }

    #[tokio::test]
    async fn transfer_deadline_is_unknown_when_cancel_cannot_be_sent() {
        let (_tx, rx) = oneshot::channel();
        let send_cancel = || false;
        let outcome = await_with_optional_cancel(
            Duration::from_millis(1),
            Duration::from_secs(1),
            rx,
            None,
            None,
            Some(&send_cancel),
        )
        .await;
        assert!(matches!(outcome, WaitOutcome::TimeoutCleanupFailed));
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
            lifecycle_cancel: None,
            cancel_cleanup_timeout: CANCEL_CLEANUP_TIMEOUT,
            session_id: SessionId("sess-A".into()),
        };
        assert_eq!(job.session_id.0, "sess-A");
    }
}

#[cfg(test)]
mod dispatch_unlocked_tests {
    use super::*;
    use crate::daemon::browsers::BrowserRegistry;
    use crate::daemon::sessions::{SessionId, SessionRegistry};
    use bsk_protocol::Method;
    use serde_json::json;
    use std::sync::Arc;

    #[tokio::test]
    async fn unlocked_dispatch_skips_session_busy_gate() {
        let browsers = Arc::new(BrowserRegistry::new());
        let sessions = Arc::new(SessionRegistry::new());
        let queues = ToolQueueRegistry::new(browsers, sessions);
        let sid = SessionId("s-record".into());
        queues.spawn(sid.clone());
        queues.force_busy_for_tests(&sid, true);

        let busy = queues
            .dispatch(
                &sid,
                Method::ToolTabList,
                json!({ "session_id": "s-record" }),
                Duration::from_secs(1),
                None,
            )
            .await;
        assert!(matches!(busy, Err(DispatchError::SessionBusy)));

        let unlocked = queues
            .dispatch_unlocked(
                &sid,
                Method::ToolRecordStop,
                json!({ "session_id": "s-record" }),
                Duration::from_secs(1),
                None,
            )
            .await;
        assert!(
            !matches!(unlocked, Err(DispatchError::SessionBusy)),
            "record_stop must not be rejected as SessionBusy; got {unlocked:?}"
        );
        // No session row → forward_one returns NotFound as Rpc.
        assert!(matches!(unlocked, Err(DispatchError::Rpc(_))));
    }
}
