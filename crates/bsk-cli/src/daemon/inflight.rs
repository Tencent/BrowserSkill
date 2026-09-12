//! Per-rpc-id state machine for `tool.*` RPCs that the daemon is
//! tracking on behalf of an IPC caller.
//!
//! Every business `tool.*` RPC the IPC handler accepts gets one entry
//! here, registered *before* the per-session queue takes over. Entries
//! cover the full lifetime of an in-flight tool call:
//!
//! 1. **Queued** — registered in the IPC handler immediately on
//!    request arrival; `browser_id` and `ws_rpc_id` are `None` because
//!    the per-session worker has not yet dequeued the job.
//! 2. **Forwarded** — the worker has resolved the owning browser and
//!    allocated a WS-side correlation id, and is now awaiting the
//!    extension's response.
//! 3. **Done** — the IPC response has been written; the
//!    [`InflightGuard`] returned at registration drops, removing the
//!    entry.
//!
//! Each entry owns a shared [`AbortToken`] so cancellation is uniform
//! across both phases (review C2):
//!
//! * `handle_cancel` trips the token on a queued entry → the worker's
//!   pre-flight observes it and short-circuits with `cancelled` before
//!   any WS frame leaves the daemon.
//! * `handle_cancel` trips the token on a forwarded entry → the
//!   worker's `tokio::select!` returns `cancelled` immediately, AND
//!   `handle_cancel` separately pushes a WS-side `cancel { rpc_id }`
//!   frame so the extension's dispatcher can abort its
//!   `AbortController`.
//!
//! Daemon-local cancellable runners (`tool.wait_ms`) keep their own
//! [`super::abort::AbortRegistry`] — the cancel handler tries the
//! local registry first and only falls through to this WS-forwarding
//! layer when no local token answers.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use bsk_protocol::RpcId;

use super::abort::AbortToken;
use super::browsers::BrowserId;
use super::sessions::SessionId;

/// Process-wide test hook (review round 2 C1). When non-zero,
/// [`ToolInflightEntry::promote_to_forwarded_with`] sleeps for this
/// many milliseconds *before* acquiring the entry's inner lock,
/// widening the precise race window the pre-fix code suffered from:
/// the old `promote_to_forwarded` read the cancel flag (an atomic)
/// outside the inner lock and only acquired the lock to commit the
/// `Queued → Forwarded` writes. A concurrent `cancel` could lock the
/// inner Mutex between those two steps, snapshot None/None, trip the
/// AbortToken, and return — making the IPC handler skip the WS cancel
/// forward. The worker would then commit the promotion and emit the
/// WS request anyway, so the side-effecting tool ran at the extension
/// while the CLI got `cancelled`.
///
/// With the hook armed, tests can deterministically reproduce a
/// concurrent cancel landing in that exact window. After the fix the
/// cancelled check now lives INSIDE the lock, so cancel-during-delay
/// wins the lock race, sets the flag, and `promote_to_forwarded_with`
/// — once it finally acquires the lock — returns
/// [`PromoteOutcome::Cancelled`] without invoking `dispatch`.
///
/// Production reads the atomic once per promotion — negligible
/// overhead — and a value of `0` (the default) is a no-op.
static PROMOTE_DELAY_MS: AtomicU64 = AtomicU64::new(0);

/// Test-only hook used by both unit and integration tests under this
/// crate to widen the promote critical section. Marked `#[doc(hidden)]`
/// so it stays invisible to library consumers but reachable from
/// `tests/cancel_forwarding.rs`. Always reset to `0` after use — the
/// hook is process-wide.
#[doc(hidden)]
pub fn __set_promote_delay_for_tests(delay: Duration) {
    PROMOTE_DELAY_MS.store(delay.as_millis() as u64, Ordering::SeqCst);
}

/// Why an entry was cancelled. Stored alongside the cancelled flag
/// so the worker's pre-flight + select can map to the right error
/// code (per-rpc `cancel` keeps the legacy `Cancelled`; session-wide
/// `cancel_session` surfaces `UserAborted`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    Cancelled,
    UserAborted,
}

/// Mutable state inside [`ToolInflightEntry`]. Behind a `Mutex` so
/// `handle_cancel` and the queue worker can transition `Queued →
/// Forwarded` and observe each other atomically.
///
/// Review round 2 C1: the cancel flag itself now lives here so the
/// cancel decision and the queued/forwarded decision share the SAME
/// critical section — fixing the race where `cancel` could see
/// `browser_id == None` (queued) while a concurrent `promote_to_forwarded`
/// went on to commit `Some` immediately afterwards and emit the WS
/// request.
#[derive(Debug, Clone)]
struct InflightInner {
    /// Owning browser, set by the worker before forwarding the WS
    /// request. `None` while still queued.
    browser_id: Option<BrowserId>,
    /// WS-side correlation id allocated by the worker. `None` until
    /// the worker is about to forward the request frame.
    ws_rpc_id: Option<RpcId>,
    /// Canonical cancelled state. Reads/writes happen under the
    /// surrounding `Mutex`; the per-entry [`AbortToken`] mirrors this
    /// flag so async `select!` waiters have a non-blocking signal.
    cancelled: bool,
    /// Reason the entry was cancelled, recorded the FIRST time
    /// cancellation lands. First-reason-wins: a per-RPC `cancel` that
    /// arrives before a session-wide `cancel_session` keeps the entry
    /// labelled `Cancelled`, so a tool already explicitly cancelled
    /// (e.g. by `tool.wait_ms`'s own cancel path) does not get
    /// retroactively relabelled when the user clicks stop.
    cancel_reason: Option<CancelReason>,
    /// Session that owns this RPC. Set at registration time and
    /// never mutated. Used by `cancel_session` to drain every
    /// inflight entry for one session in a single sweep.
    session_id: SessionId,
}

impl InflightInner {
    fn new(session_id: SessionId) -> Self {
        Self {
            browser_id: None,
            ws_rpc_id: None,
            cancelled: false,
            cancel_reason: None,
            session_id,
        }
    }
}

/// Snapshot of an entry's view used by `handle_cancel` to decide
/// whether a WS-side cancel frame must be forwarded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InflightSnapshot {
    pub browser_id: Option<BrowserId>,
    pub ws_rpc_id: Option<RpcId>,
}

/// Outcome of [`ToolInflightEntry::promote_to_forwarded_with`].
///
/// Distinguishes "cancel already won the race, dispatch never ran"
/// (`Cancelled`) from "we tried to dispatch but the sink was closed"
/// (`SendFailed`). The former is a normal cancellation result; the
/// latter is a transport-level error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromoteOutcome {
    /// Entry was successfully promoted to forwarded AND the caller's
    /// dispatch closure reported success (i.e. the WS request frame
    /// reached the sink).
    Promoted,
    /// A `cancel` already tripped this entry before we could promote
    /// it. The dispatch closure was NOT invoked, so no WS request
    /// frame left the daemon. This is the C1 invariant: cancel-before-
    /// promote MUST short-circuit before any side-effecting frame is
    /// emitted to the extension.
    Cancelled,
    /// The dispatch closure reported failure (e.g. WS sink closed).
    /// The inflight entry's queued state has been restored so a
    /// subsequent `cancel` cannot mistake it for forwarded and emit a
    /// stale WS cancel frame.
    SendFailed,
}

/// One entry in the inflight-tool table.
#[derive(Debug)]
pub struct ToolInflightEntry {
    cancel: AbortToken,
    inner: Mutex<InflightInner>,
}

impl ToolInflightEntry {
    fn new(session_id: SessionId) -> Arc<Self> {
        Arc::new(Self {
            cancel: AbortToken::new(),
            inner: Mutex::new(InflightInner::new(session_id)),
        })
    }

    pub fn cancel_token(&self) -> AbortToken {
        self.cancel.clone()
    }

    /// Cheap, lock-free hint that the entry has been cancelled. Useful
    /// as a pre-flight short-circuit (worker checks it before doing
    /// session / browser resolution) but **not** authoritative — the
    /// canonical decision happens inside
    /// [`Self::promote_to_forwarded_with`] under the inner lock so a
    /// stale `false` here cannot let a cancelled request escape to the
    /// extension.
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// Reason recorded when this entry was cancelled, or `None` if no
    /// cancel has landed yet. First-reason-wins (see
    /// [`Self::cancel_and_snapshot`]).
    pub fn cancel_reason(&self) -> Option<CancelReason> {
        self.inner
            .lock()
            .expect("ToolInflightEntry poisoned")
            .cancel_reason
    }

    /// Atomically attempt the `Queued → Forwarded` transition AND emit
    /// the corresponding WS request frame (review round 2 C1).
    ///
    /// `dispatch` is invoked *while holding* the entry's inner lock —
    /// the same lock a concurrent `cancel` must acquire before
    /// snapshotting or tripping the entry. This gives us two
    /// guaranteed serialisations:
    ///
    /// * **cancel-first**: cancel acquires the lock, sets `cancelled =
    ///   true`, releases. The subsequent `promote_to_forwarded_with`
    ///   acquires the lock, observes `cancelled`, returns
    ///   [`PromoteOutcome::Cancelled`] without running `dispatch` — so
    ///   no WS request frame ever leaves the daemon.
    /// * **promote-first**: this method commits the
    ///   `browser_id`/`ws_rpc_id` writes *and* runs `dispatch` (which
    ///   pushes the request frame to the sink) under the same lock.
    ///   The subsequent `cancel` then sees `Some/Some` under the lock
    ///   and the caller forwards a WS cancel frame. Because the
    ///   request is already on the sink, the cancel frame is queued
    ///   strictly *after* the request — preserving the
    ///   "request-before-cancel" wire order any reasonable extension
    ///   dispatcher needs.
    ///
    /// `dispatch` returns `true` on success or `false` if the WS sink
    /// failed; on failure the queued state is restored so the entry
    /// looks queued to any future `cancel` and the caller surfaces a
    /// transport-closed error to the IPC peer.
    pub fn promote_to_forwarded_with<F>(
        &self,
        browser_id: BrowserId,
        ws_rpc_id: RpcId,
        dispatch: F,
    ) -> PromoteOutcome
    where
        F: FnOnce() -> bool,
    {
        // Test-only: sleep BEFORE acquiring the lock to widen the
        // exact pre-fix race window. The pre-fix `promote_to_forwarded`
        // checked the cancel atomic, then locked the inner Mutex, so
        // a cancel landing between those two steps could trip the
        // AbortToken without `promote` ever knowing. With this hook
        // armed, concurrent cancels easily slip in during the sleep
        // and acquire the inner lock first — the post-fix lock-checked
        // cancelled flag then forces `promote` to return `Cancelled`.
        let delay_ms = PROMOTE_DELAY_MS.load(Ordering::SeqCst);
        if delay_ms > 0 {
            std::thread::sleep(Duration::from_millis(delay_ms));
        }
        let mut guard = self.inner.lock().expect("ToolInflightEntry poisoned");
        if guard.cancelled {
            return PromoteOutcome::Cancelled;
        }
        guard.browser_id = Some(browser_id);
        guard.ws_rpc_id = Some(ws_rpc_id);
        if dispatch() {
            PromoteOutcome::Promoted
        } else {
            guard.browser_id = None;
            guard.ws_rpc_id = None;
            PromoteOutcome::SendFailed
        }
    }

    /// Cancel this entry under the inner lock and return a snapshot of
    /// the queued/forwarded state observed *at the moment of cancel*.
    ///
    /// Holding the lock across both the snapshot AND the cancel flag
    /// write is what closes the C1 race: any concurrent
    /// `promote_to_forwarded_with` is forced to serialise against this
    /// critical section, so its outcome is one of the two consistent
    /// states described on [`Self::promote_to_forwarded_with`].
    ///
    /// `reason` records why the entry was cancelled. The FIRST reason
    /// to land wins: a subsequent cancel (e.g. session-wide
    /// `cancel_session` racing a per-RPC `cancel`) does NOT relabel an
    /// already-cancelled entry. This matters because per-RPC cancels
    /// can come from internal callers (`tool.wait_ms`, future bespoke
    /// cancellation paths) that have nothing to do with the user's
    /// stop button — they should not be reframed as `UserAborted`
    /// just because a session sweep happens to land second.
    fn cancel_and_snapshot(&self, reason: CancelReason) -> InflightSnapshot {
        let mut guard = self.inner.lock().expect("ToolInflightEntry poisoned");
        guard.cancelled = true;
        guard.cancel_reason.get_or_insert(reason);
        let snap = InflightSnapshot {
            browser_id: guard.browser_id.clone(),
            ws_rpc_id: guard.ws_rpc_id.clone(),
        };
        // Trip the AbortToken under the same lock so that any
        // subsequent `is_cancelled()` reader observes the cancel as
        // soon as we release the inner Mutex. `AbortToken::cancel` only
        // flips an atomic and pings `Notify::notify_waiters`; neither
        // call blocks or acquires another lock, so doing this under
        // the inner lock is deadlock-free.
        self.cancel.cancel();
        snap
    }

    pub fn snapshot(&self) -> InflightSnapshot {
        let guard = self.inner.lock().expect("ToolInflightEntry poisoned");
        InflightSnapshot {
            browser_id: guard.browser_id.clone(),
            ws_rpc_id: guard.ws_rpc_id.clone(),
        }
    }
}

/// Process-wide registry of every IPC-tracked `tool.*` RPC, keyed by
/// the CLI-side wire `rpc_id`.
#[derive(Default)]
pub struct ToolInflightRegistry {
    inner: Mutex<HashMap<RpcId, Arc<ToolInflightEntry>>>,
}

impl std::fmt::Debug for ToolInflightRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolInflightRegistry")
            .field("len", &self.len())
            .finish()
    }
}

impl ToolInflightRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("tool inflight poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Register a fresh entry under `cli_rpc_id`. Returns a
    /// [`InflightGuard`] whose `Drop` impl auto-removes the entry, plus
    /// a strong handle the caller can pass to the queue worker.
    ///
    /// `cli_rpc_id` collisions are rejected (`Err`) so a buggy caller
    /// double-registering the same id cannot accidentally trip the
    /// previous entry's cancel token.
    pub fn register(
        self: &Arc<Self>,
        cli_rpc_id: RpcId,
        session_id: SessionId,
    ) -> Result<InflightGuard, InflightRegisterError> {
        let entry = ToolInflightEntry::new(session_id);
        {
            let mut guard = self.inner.lock().expect("tool inflight poisoned");
            if guard.contains_key(&cli_rpc_id) {
                return Err(InflightRegisterError::DuplicateRpcId(cli_rpc_id));
            }
            guard.insert(cli_rpc_id.clone(), Arc::clone(&entry));
        }
        Ok(InflightGuard {
            registry: Arc::clone(self),
            cli_rpc_id,
            entry,
        })
    }

    /// Look up an entry without removing it.
    pub fn get(&self, cli_rpc_id: &RpcId) -> Option<Arc<ToolInflightEntry>> {
        self.inner
            .lock()
            .expect("tool inflight poisoned")
            .get(cli_rpc_id)
            .cloned()
    }

    /// Trip the cancel flag on the entry indexed by `cli_rpc_id` and
    /// return the queued/forwarded snapshot observed under the entry's
    /// inner lock (review round 2 C1). The caller uses the snapshot
    /// to decide whether to forward a WS-side cancel frame:
    ///
    /// * `Some` with `browser_id` / `ws_rpc_id` populated → the worker
    ///   has already promoted the entry and the request frame is in
    ///   the sink; forward a WS cancel.
    /// * `Some` with both fields `None` → still queued; the worker
    ///   will observe `cancelled` next time it acquires the inner
    ///   lock inside `promote_to_forwarded_with` and short-circuit
    ///   before sending the request frame.
    ///
    /// Returns `None` only when no entry exists for `cli_rpc_id`.
    ///
    /// The entry stays in the registry until the original handler
    /// drops its [`InflightGuard`], so a same-tick second cancel is a
    /// no-op (the flag is idempotent).
    pub fn cancel(&self, cli_rpc_id: &RpcId) -> Option<InflightSnapshot> {
        let entry = self
            .inner
            .lock()
            .expect("tool inflight poisoned")
            .get(cli_rpc_id)
            .cloned()?;
        Some(entry.cancel_and_snapshot(CancelReason::Cancelled))
    }

    /// Trip every entry whose owning session matches `sid` and return
    /// the snapshot observed for each, in unspecified order. Each
    /// returned snapshot follows the same semantics as
    /// [`Self::cancel`]: `ws_rpc_id == Some` means the worker has
    /// already forwarded the request and the caller must push a WS
    /// cancel; `ws_rpc_id == None` means the worker will short-circuit
    /// in its next pre-flight.
    pub fn cancel_session(&self, sid: &SessionId) -> Vec<InflightSnapshot> {
        // Snapshot the entries we want to cancel under the registry
        // lock, then trip each one outside the registry lock so a
        // concurrent unregister (driven by Drop on InflightGuard) can
        // proceed while we're still walking. Each per-entry cancel
        // takes the entry's own inner Mutex, which is the one that
        // serialises against `promote_to_forwarded_with`.
        let to_cancel: Vec<Arc<ToolInflightEntry>> = {
            let guard = self.inner.lock().expect("tool inflight poisoned");
            guard
                .values()
                .filter(|entry| {
                    let inner = entry.inner.lock().expect("ToolInflightEntry poisoned");
                    &inner.session_id == sid
                })
                .cloned()
                .collect()
        };
        to_cancel
            .into_iter()
            .map(|entry| entry.cancel_and_snapshot(CancelReason::UserAborted))
            .collect()
    }

    fn unregister(&self, cli_rpc_id: &RpcId, entry: &Arc<ToolInflightEntry>) {
        let mut guard = self.inner.lock().expect("tool inflight poisoned");
        let should_remove = guard
            .get(cli_rpc_id)
            .is_some_and(|current| Arc::ptr_eq(current, entry));
        if should_remove {
            guard.remove(cli_rpc_id);
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InflightRegisterError {
    #[error("duplicate cli_rpc_id: {0}")]
    DuplicateRpcId(RpcId),
}

/// RAII handle returned by [`ToolInflightRegistry::register`]. Drop it
/// to remove the entry from the registry; clone the underlying
/// `Arc<ToolInflightEntry>` via [`InflightGuard::entry`] before
/// dropping if a downstream task needs to keep observing the cancel
/// token.
#[must_use = "dropping InflightGuard immediately unregisters cancellation for this rpc"]
pub struct InflightGuard {
    registry: Arc<ToolInflightRegistry>,
    cli_rpc_id: RpcId,
    entry: Arc<ToolInflightEntry>,
}

impl InflightGuard {
    pub fn entry(&self) -> Arc<ToolInflightEntry> {
        Arc::clone(&self.entry)
    }

    pub fn cli_rpc_id(&self) -> &RpcId {
        &self.cli_rpc_id
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.registry.unregister(&self.cli_rpc_id, &self.entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::sessions::SessionId;
    use std::sync::atomic::AtomicBool;

    fn sid(s: &str) -> SessionId {
        SessionId(s.to_string())
    }

    /// RAII guard that serialises any unit test poking the
    /// process-wide `PROMOTE_DELAY_MS` hook so parallel `cargo test`
    /// runs cannot interfere. Resets the hook to `0` on drop.
    struct PromoteDelayHook {
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl PromoteDelayHook {
        fn enable(delay: Duration) -> Self {
            static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let _lock = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
            __set_promote_delay_for_tests(delay);
            Self { _lock }
        }
    }

    impl Drop for PromoteDelayHook {
        fn drop(&mut self) {
            __set_promote_delay_for_tests(Duration::from_millis(0));
        }
    }

    fn always_succeed() -> impl FnOnce() -> bool {
        || true
    }

    #[test]
    fn register_and_drop_round_trip() {
        let reg = Arc::new(ToolInflightRegistry::new());
        assert!(reg.is_empty());
        let guard = reg
            .register("cli-1".into(), sid("test"))
            .expect("register cli-1");
        assert_eq!(reg.len(), 1);
        let snap = guard.entry().snapshot();
        assert_eq!(snap.browser_id, None);
        assert_eq!(snap.ws_rpc_id, None);
        drop(guard);
        assert!(reg.is_empty());
    }

    #[test]
    fn duplicate_register_is_rejected() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let _first = reg.register("cli-1".into(), sid("test")).unwrap();
        let dup = reg.register("cli-1".into(), sid("test"));
        assert!(matches!(
            dup,
            Err(InflightRegisterError::DuplicateRpcId(id)) if id == "cli-1"
        ));
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn promote_to_forwarded_records_browser_and_ws_id() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let guard = reg.register("cli-1".into(), sid("test")).unwrap();
        let entry = guard.entry();
        let outcome = entry.promote_to_forwarded_with(
            BrowserId("alpha".into()),
            "tool-001".into(),
            always_succeed(),
        );
        assert_eq!(outcome, PromoteOutcome::Promoted);
        let snap = reg
            .get(&"cli-1".to_string())
            .expect("entry still present")
            .snapshot();
        assert_eq!(snap.browser_id, Some(BrowserId("alpha".into())));
        assert_eq!(snap.ws_rpc_id, Some("tool-001".into()));
    }

    #[test]
    fn cancel_queued_entry_trips_token_without_browser_or_ws_id() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let guard = reg.register("cli-q".into(), sid("test")).unwrap();
        let entry = guard.entry();
        let snap = reg
            .cancel(&"cli-q".to_string())
            .expect("cancel returns snapshot");
        assert_eq!(snap.browser_id, None);
        assert_eq!(snap.ws_rpc_id, None);
        assert!(entry.is_cancelled(), "queued cancel must trip token");
    }

    #[test]
    fn cancel_forwarded_entry_returns_browser_and_ws_id() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let guard = reg.register("cli-fwd".into(), sid("test")).unwrap();
        let outcome = guard.entry().promote_to_forwarded_with(
            BrowserId("alpha".into()),
            "tool-007".into(),
            always_succeed(),
        );
        assert_eq!(outcome, PromoteOutcome::Promoted);
        let snap = reg.cancel(&"cli-fwd".to_string()).unwrap();
        assert_eq!(snap.browser_id, Some(BrowserId("alpha".into())));
        assert_eq!(snap.ws_rpc_id, Some("tool-007".into()));
        assert!(guard.entry().is_cancelled());
    }

    #[test]
    fn promote_after_cancel_returns_cancelled_without_invoking_dispatch() {
        // Race A (cancel-first): cancel acquires the inner lock before
        // promote even starts. promote must observe the cancel under
        // the same lock and NEVER invoke the dispatch closure — that
        // closure is what would push the WS request frame to the sink
        // in the production caller, so any side effect after cancel
        // is a regression.
        let reg = Arc::new(ToolInflightRegistry::new());
        let guard = reg.register("cli-x".into(), sid("test")).unwrap();
        let _ = reg.cancel(&"cli-x".to_string()).unwrap();
        let dispatched = AtomicBool::new(false);
        let outcome = guard.entry().promote_to_forwarded_with(
            BrowserId("alpha".into()),
            "ws-1".into(),
            || {
                dispatched.store(true, Ordering::SeqCst);
                true
            },
        );
        assert_eq!(outcome, PromoteOutcome::Cancelled);
        assert!(
            !dispatched.load(Ordering::SeqCst),
            "dispatch must not run when cancel won the race (review round 2 C1)"
        );
        // And the cancelled entry's queued snapshot stays None/None,
        // so a duplicate cancel does not invent a stale ws_rpc_id.
        assert_eq!(guard.entry().snapshot().browser_id, None);
        assert_eq!(guard.entry().snapshot().ws_rpc_id, None);
    }

    #[test]
    fn promote_send_failed_rolls_back_so_late_cancel_sees_queued_state() {
        // SendFailed must restore browser_id/ws_rpc_id to None so a
        // later `cancel` does NOT forward a WS cancel for a request
        // that was never put on the sink.
        let reg = Arc::new(ToolInflightRegistry::new());
        let guard = reg.register("cli-sf".into(), sid("test")).unwrap();
        let entry = guard.entry();
        let outcome =
            entry.promote_to_forwarded_with(BrowserId("alpha".into()), "ws-sf".into(), || false);
        assert_eq!(outcome, PromoteOutcome::SendFailed);
        assert_eq!(entry.snapshot().browser_id, None);
        assert_eq!(entry.snapshot().ws_rpc_id, None);
        // Cancel after a failed dispatch sees the queued state — the
        // production caller therefore does not synthesise a WS cancel.
        let snap = reg.cancel(&"cli-sf".to_string()).unwrap();
        assert_eq!(snap.browser_id, None);
        assert_eq!(snap.ws_rpc_id, None);
    }

    #[test]
    fn cancel_unknown_id_returns_none() {
        let reg = Arc::new(ToolInflightRegistry::new());
        assert_eq!(reg.cancel(&"missing".to_string()), None);
    }

    #[tokio::test]
    async fn cancel_token_resolves_pending_await() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let guard = reg.register("cli-await".into(), sid("test")).unwrap();
        let token = guard.entry().cancel_token();
        let waiter = tokio::spawn(async move {
            token.cancelled().await;
            true
        });
        let _ = reg.cancel(&"cli-await".to_string()).unwrap();
        let v = tokio::time::timeout(std::time::Duration::from_millis(200), waiter)
            .await
            .expect("cancel must propagate")
            .unwrap();
        assert!(v);
    }

    /// Race B: the worker enters `promote_to_forwarded_with`, grabs
    /// the inner lock, and begins running the dispatch closure (which
    /// in production pushes the WS request frame to the sink). A
    /// concurrent `cancel` *must* serialise on the inner lock and only
    /// observe the state after the dispatch closure finishes. The
    /// snapshot it returns therefore has `browser_id`/`ws_rpc_id`
    /// populated and the caller forwards a WS cancel — strictly AFTER
    /// the request frame is already in the sink (FIFO).
    ///
    /// Pre-fix, `cancel` and `promote_to_forwarded` did not share a
    /// critical section: cancel could read the snapshot as None/None
    /// (queued) and trip the AbortToken between the `is_cancelled()`
    /// check at the start of the old `promote_to_forwarded` and the
    /// subsequent write to `inner`, letting the WS request frame
    /// escape with a stale "queued" cancel verdict.
    #[test]
    fn concurrent_cancel_during_promote_serialises_via_inner_lock() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let reg = Arc::new(ToolInflightRegistry::new());
        let guard = reg.register("cli-r".into(), sid("test")).unwrap();
        let entry = guard.entry();

        let dispatch_started = Arc::new(AtomicBool::new(false));
        let release_dispatch = Arc::new(AtomicBool::new(false));

        let entry_clone = Arc::clone(&entry);
        let started = Arc::clone(&dispatch_started);
        let release = Arc::clone(&release_dispatch);
        let promote_handle = std::thread::spawn(move || {
            entry_clone.promote_to_forwarded_with(
                BrowserId("alpha".into()),
                "ws-r".into(),
                move || {
                    started.store(true, Ordering::SeqCst);
                    while !release.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    true
                },
            )
        });

        // Spin until the dispatch closure begins. Once it does, the
        // inner Mutex is held and any cancel will block on it.
        while !dispatch_started.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(2));
        }

        let reg_clone = Arc::clone(&reg);
        let cancel_handle = std::thread::spawn(move || reg_clone.cancel(&"cli-r".to_string()));

        // Give the cancel thread a chance to attempt the lock. It MUST
        // still be blocked: the dispatch closure has the inner Mutex.
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            !cancel_handle.is_finished(),
            "cancel must block on the inner lock while promote holds it (round 2 C1)"
        );

        // Release the dispatch closure so the lock becomes available.
        release_dispatch.store(true, Ordering::SeqCst);

        let promote_outcome = promote_handle.join().unwrap();
        let cancel_snap = cancel_handle.join().unwrap().unwrap();

        assert_eq!(promote_outcome, PromoteOutcome::Promoted);
        // The snapshot reflects the post-promotion state — proving the
        // cancel observed the lock-protected critical section in full,
        // not a partial "queued" view.
        assert_eq!(cancel_snap.browser_id, Some(BrowserId("alpha".into())));
        assert_eq!(cancel_snap.ws_rpc_id, Some("ws-r".into()));
    }

    /// Race C: the original C1 race — `cancel` acquires the inner
    /// lock during the window where the pre-fix `promote_to_forwarded`
    /// had read the cancel atomic but had not yet acquired the lock.
    /// `__set_promote_delay_for_tests` sleeps EXACTLY in that window
    /// (before the lock), so a `cancel` invoked just before promote
    /// re-acquires the lock is guaranteed to land first. The fix's
    /// in-lock `cancelled` check then trips `Cancelled` and the
    /// dispatch closure never runs — proving the pre-fix interleaving
    /// can no longer let a queued cancel race past a still-pending
    /// promotion.
    #[test]
    fn cancel_first_wins_under_promote_delay_hook() {
        let _hook = PromoteDelayHook::enable(Duration::from_millis(80));

        let reg = Arc::new(ToolInflightRegistry::new());
        let guard = reg.register("cli-d".into(), sid("test")).unwrap();
        let entry = guard.entry();

        // Pre-cancel so the very first `cancelled` check inside the
        // lock observes a tripped flag. The dispatch closure must not
        // run, regardless of the hook's sleep.
        let _ = reg.cancel(&"cli-d".to_string()).unwrap();

        let dispatched = AtomicBool::new(false);
        let outcome =
            entry.promote_to_forwarded_with(BrowserId("alpha".into()), "ws-d".into(), || {
                dispatched.store(true, Ordering::SeqCst);
                true
            });
        assert_eq!(outcome, PromoteOutcome::Cancelled);
        assert!(!dispatched.load(Ordering::SeqCst));
    }

    /// Race C, end-to-end variant: rather than pre-cancelling, spawn a
    /// concurrent cancel that lands DURING the hook's pre-lock sleep.
    /// This is the most direct reproduction of the pre-fix bug:
    /// without the lock-checked cancelled flag, the worker thread
    /// (sleeping pre-lock) would wake up, acquire the lock, and write
    /// `Some/Some` AFTER the cancel had already snapshotted None/None
    /// and tripped the AbortToken — and the dispatch closure would
    /// run, emitting a WS request the IPC peer was told had been
    /// cancelled.
    ///
    /// Post-fix, the cancel thread acquires the inner Mutex first
    /// (during the sleep), sets `cancelled = true`, releases; the
    /// worker thread then locks, observes `cancelled`, returns
    /// `Cancelled`, and the dispatch closure never runs.
    #[test]
    fn concurrent_cancel_during_pre_lock_sleep_blocks_dispatch() {
        let _hook = PromoteDelayHook::enable(Duration::from_millis(120));

        let reg = Arc::new(ToolInflightRegistry::new());
        let guard = reg.register("cli-cd".into(), sid("test")).unwrap();
        let entry = guard.entry();

        let dispatched = Arc::new(AtomicBool::new(false));
        let dispatched_clone = Arc::clone(&dispatched);
        let entry_clone = Arc::clone(&entry);
        let worker = std::thread::spawn(move || {
            entry_clone.promote_to_forwarded_with(
                BrowserId("alpha".into()),
                "ws-cd".into(),
                move || {
                    dispatched_clone.store(true, Ordering::SeqCst);
                    true
                },
            )
        });

        // Fire the concurrent cancel ~30ms into the 120ms pre-lock
        // sleep, so the cancel thread definitely acquires the inner
        // Mutex first.
        std::thread::sleep(Duration::from_millis(30));
        let snap = reg.cancel(&"cli-cd".to_string()).unwrap();
        // Cancel snapshotted BEFORE promote committed → queued state.
        assert_eq!(snap.browser_id, None);
        assert_eq!(snap.ws_rpc_id, None);

        let outcome = worker.join().unwrap();
        assert_eq!(outcome, PromoteOutcome::Cancelled);
        assert!(
            !dispatched.load(Ordering::SeqCst),
            "concurrent cancel during pre-lock sleep must block the dispatch closure (round 2 C1)"
        );
    }

    /// Same race as `concurrent_cancel_during_pre_lock_sleep_blocks_dispatch`,
    /// but driven through the session-wide `cancel_session` path. Pins
    /// that the broadened cancel still serialises correctly with a
    /// concurrent `promote_to_forwarded_with` — if a future refactor
    /// diverges `cancel_session` from the per-RPC `cancel` primitive,
    /// this regression catches it.
    #[test]
    fn concurrent_cancel_session_during_pre_lock_sleep_blocks_dispatch() {
        let _hook = PromoteDelayHook::enable(Duration::from_millis(120));

        let reg = Arc::new(ToolInflightRegistry::new());
        let session = sid("session-cs");
        let guard = reg.register("cli-cs".into(), session.clone()).unwrap();
        let entry = guard.entry();

        let dispatched = Arc::new(AtomicBool::new(false));
        let dispatched_clone = Arc::clone(&dispatched);
        let entry_clone = Arc::clone(&entry);
        let worker = std::thread::spawn(move || {
            entry_clone.promote_to_forwarded_with(
                BrowserId("alpha".into()),
                "ws-cs".into(),
                move || {
                    dispatched_clone.store(true, Ordering::SeqCst);
                    true
                },
            )
        });

        // Fire the concurrent session-wide cancel ~30ms into the 120ms
        // pre-lock sleep so the cancel thread definitely acquires the
        // inner Mutex first.
        std::thread::sleep(Duration::from_millis(30));
        let snaps = reg.cancel_session(&session);
        assert_eq!(
            snaps.len(),
            1,
            "session-wide cancel must hit the only entry"
        );
        assert_eq!(snaps[0].browser_id, None);
        assert_eq!(snaps[0].ws_rpc_id, None);

        let outcome = worker.join().unwrap();
        assert_eq!(outcome, PromoteOutcome::Cancelled);
        assert!(
            !dispatched.load(Ordering::SeqCst),
            "concurrent cancel_session during pre-lock sleep must block the dispatch closure"
        );
    }

    #[test]
    fn cancel_session_trips_all_entries_for_one_session_only() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let sid_a = SessionId("A".into());
        let sid_b = SessionId("B".into());

        let g_a1 = reg.register("a1".into(), sid_a.clone()).unwrap();
        let g_a2 = reg.register("a2".into(), sid_a.clone()).unwrap();
        let g_b1 = reg.register("b1".into(), sid_b.clone()).unwrap();

        let snaps = reg.cancel_session(&sid_a);
        assert_eq!(snaps.len(), 2);
        assert!(g_a1.entry().is_cancelled());
        assert!(g_a2.entry().is_cancelled());
        assert!(
            !g_b1.entry().is_cancelled(),
            "session B must not be cancelled"
        );
    }

    #[test]
    fn cancel_session_with_no_matches_returns_empty() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let _g = reg.register("x".into(), SessionId("A".into())).unwrap();
        let snaps = reg.cancel_session(&SessionId("ghost".into()));
        assert!(snaps.is_empty());
    }

    #[test]
    fn cancel_session_marks_entries_with_user_aborted_reason() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let sid_s = SessionId("S".into());
        let g = reg.register("r".into(), sid_s.clone()).unwrap();
        reg.cancel_session(&sid_s);
        assert_eq!(g.entry().cancel_reason(), Some(CancelReason::UserAborted));
    }

    #[test]
    fn per_rpc_cancel_marks_entries_with_cancelled_reason() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let g = reg.register("r".into(), SessionId("S".into())).unwrap();
        reg.cancel(&"r".to_string()).unwrap();
        assert_eq!(g.entry().cancel_reason(), Some(CancelReason::Cancelled));
    }

    /// First-reason-wins: a per-RPC `cancel` that lands first must NOT
    /// be retroactively relabelled by a subsequent session-wide
    /// `cancel_session`. A regression that swapped `get_or_insert` for
    /// `= Some(reason)` would flip this to `UserAborted` — this test
    /// guards against that. Plan motivation: "a tool that was already
    /// explicitly cancelled by a tool-level cancel shouldn't be
    /// retroactively relabelled when the user clicks stop."
    #[test]
    fn per_rpc_cancel_then_session_cancel_keeps_cancelled_reason() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let session = sid("S");
        let g = reg.register("r".into(), session.clone()).unwrap();

        let _ = reg.cancel(&"r".to_string()).unwrap();
        assert_eq!(g.entry().cancel_reason(), Some(CancelReason::Cancelled));

        // Subsequent session-wide cancel must NOT overwrite the recorded
        // reason — the entry was already explicitly cancelled.
        let _ = reg.cancel_session(&session);
        assert_eq!(
            g.entry().cancel_reason(),
            Some(CancelReason::Cancelled),
            "session-wide cancel must not relabel an already-cancelled entry"
        );
    }

    /// Symmetric counterpart of the test above: a session-wide cancel
    /// that lands first must NOT be downgraded to `Cancelled` by a
    /// subsequent per-RPC `cancel`.
    #[test]
    fn session_cancel_then_per_rpc_cancel_keeps_user_aborted_reason() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let session = sid("S");
        let g = reg.register("r".into(), session.clone()).unwrap();

        let _ = reg.cancel_session(&session);
        assert_eq!(g.entry().cancel_reason(), Some(CancelReason::UserAborted));

        let _ = reg.cancel(&"r".to_string()).unwrap();
        assert_eq!(
            g.entry().cancel_reason(),
            Some(CancelReason::UserAborted),
            "per-RPC cancel must not downgrade an already user-aborted entry"
        );
    }

    #[test]
    fn cancel_reason_is_none_before_any_cancel() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let g = reg.register("r".into(), SessionId("S".into())).unwrap();
        assert_eq!(g.entry().cancel_reason(), None);
    }

    #[test]
    fn cancel_session_returns_snapshots_for_each_entry() {
        let reg = Arc::new(ToolInflightRegistry::new());
        let sid = SessionId("S".into());
        let g1 = reg.register("r1".into(), sid.clone()).unwrap();
        let _ = g1.entry().promote_to_forwarded_with(
            BrowserId("alpha".into()),
            "ws-r1".into(),
            always_succeed(),
        );
        let _g2 = reg.register("r2".into(), sid.clone()).unwrap();

        let snaps = reg.cancel_session(&sid);
        let forwarded = snaps.iter().filter(|s| s.ws_rpc_id.is_some()).count();
        let queued = snaps.iter().filter(|s| s.ws_rpc_id.is_none()).count();
        assert_eq!(forwarded, 1);
        assert_eq!(queued, 1);
    }
}
