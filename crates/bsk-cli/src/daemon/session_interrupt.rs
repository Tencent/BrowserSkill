//! Per-session transient control state: the one-shot "pending interrupt"
//! marker and the user-takeover ("held") flag.
//!
//! ## Pending interrupt
//!
//! Holds a single-use marker per `SessionId` indicating that the
//! user has clicked the agent-window mask's stop button. The next
//! browser-input-dispatching `tool.*` call for that session is rejected
//! with `ErrorCode::UserAborted`; passive reads and session-lifecycle
//! RPCs pass through transparently and do not consume the marker.
//!
//! The marker is single-use and has no expiry: it sits in the
//! registry until consumed by an input-dispatching call, dropped by a
//! `session.control_returned` (see below), or until the session is
//! torn down. This lets the user's interrupt survive an LLM
//! thinking phase of arbitrary length — the v1 time-window
//! mechanism dropped interrupts whenever the LLM took longer to
//! respond than the window allowed.
//!
//! When the takeover handshake sets *both* states, the return event
//! must clear *both*: `wait_control` already told the agent control is
//! back, so leaving the one-shot marker behind would reject the agent's
//! very next input tool once with a spurious "pending user interrupt".
//!
//! ## User takeover ("held")
//!
//! A session also carries a *control* state: `agent` (default) or
//! `user`. The extension emits `session.control_taken` when the user
//! presses "接管/Take over" and `session.control_returned` when they
//! press "交还/Return to agent".
//!
//! While a session is held, every interrupt-gated `tool.*` call is
//! rejected with `ErrorCode::UserAborted` **without consuming** the
//! held flag: the rejection repeats until control actually returns.
//! The flag is cleared only by an explicit `session.control_returned`,
//! or by session teardown (stop / window close / browser disconnect) —
//! all of which funnel through [`SessionInterruptRegistry::drop_session`].
//!
//! `session.control_returned` also stores a *return receipt* (the
//! user's note + how long they held control) which
//! `session.wait_control` consumes exactly once so the note is
//! delivered to the agent a single time. `session.status` can still
//! read the receipt until it is consumed.
//!
//! Both states live in one registry, under one mutex, so a single
//! `drop_session` call covers every teardown route. Waiters park on a
//! per-session [`tokio::sync::watch`] channel — the mutex is never held
//! across an `.await`.
//!
//! Independent of `SessionRegistry` because this is transient runtime
//! control state, not a session lifecycle attribute.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use bsk_protocol::SessionControl;
use bsk_protocol::system::SessionReturnReceipt;
use tokio::sync::watch;

use super::sessions::SessionId;

/// Non-consuming view of a session's takeover state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlSnapshot {
    pub control: SessionControl,
    pub pending_interrupt: bool,
    /// How long the user has held control, in milliseconds. `None` while
    /// control is `agent`.
    pub held_for_ms: Option<u64>,
    /// Most recent return receipt until it is consumed by
    /// [`SessionInterruptRegistry::consume_return`].
    pub last_return: Option<SessionReturnReceipt>,
}

/// One session's control bookkeeping.
struct ControlState {
    /// Epoch milliseconds at which the user took over, while held.
    held_since_ms: Option<u64>,
    /// Receipt from the latest return, until consumed.
    last_return: Option<SessionReturnReceipt>,
    /// Monotonic counter bumped on every change so waiters wake up. The
    /// value itself is meaningless; only "did it change" matters.
    version: u64,
    /// Broadcast channel used to wake `wait_control` waiters.
    signal: watch::Sender<u64>,
}

impl ControlState {
    fn new() -> Self {
        let (signal, _rx) = watch::channel(0);
        Self {
            held_since_ms: None,
            last_return: None,
            version: 0,
            signal,
        }
    }

    fn bump(&mut self) {
        self.version = self.version.wrapping_add(1);
        // A send failure only means no waiter is currently subscribed.
        let _ = self.signal.send(self.version);
    }
}

#[derive(Default)]
struct Inner {
    pending: HashSet<SessionId>,
    control: HashMap<SessionId, ControlState>,
}

/// Atomic result of probing the control state for a waiter.
enum PollOutcome {
    Released(SessionReturnReceipt),
    AlreadyAgent,
    StillHeld { held_for_ms: u64 },
}

/// Why [`SessionInterruptRegistry::wait_for_release`] returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitControlResolution {
    /// The user returned control while we waited; carries the consumed
    /// return receipt.
    Released(SessionReturnReceipt),
    /// Control was already `agent` (or a racing waiter consumed the
    /// receipt first).
    AlreadyAgent,
    /// The wait expired with control still held by the user.
    TimedOut { held_for_ms: u64 },
    /// The session disappeared before/while waiting.
    SessionGone,
}

#[derive(Default)]
pub struct SessionInterruptRegistry {
    inner: Mutex<Inner>,
}

impl std::fmt::Debug for SessionInterruptRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (pending, control) = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            (guard.pending.len(), guard.control.len())
        };
        f.debug_struct("SessionInterruptRegistry")
            .field("pending", &pending)
            .field("control", &control)
            .finish()
    }
}

impl SessionInterruptRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // ----- one-shot pending interrupt (unchanged semantics) -----

    /// Mark `sid` as having a pending interrupt. Idempotent —
    /// repeated marks are a no-op (the marker is a single-use flag,
    /// not a counter).
    pub fn mark(&self, sid: &SessionId) {
        self.lock().pending.insert(sid.clone());
    }

    /// Whether `sid` currently has a pending interrupt marker.
    pub fn is_pending(&self, sid: &SessionId) -> bool {
        self.lock().pending.contains(sid)
    }

    /// Probe + consume. If `sid` has a pending interrupt, remove it
    /// and return `true`. Otherwise return `false` without
    /// modifying the registry.
    ///
    /// Single-use semantics: once consumed by one call, subsequent
    /// `try_consume` calls for the same session return `false`
    /// until the session is marked again.
    pub fn try_consume(&self, sid: &SessionId) -> bool {
        self.lock().pending.remove(sid)
    }

    // ----- user takeover ("held") -----

    /// Mark `sid` as held by the user. Idempotent: a repeated
    /// `control_taken` (e.g. an extension retry) keeps the original
    /// hold start so `held_for_ms` does not reset.
    pub fn take_control(&self, sid: &SessionId) {
        let mut guard = self.lock();
        let entry = guard
            .control
            .entry(sid.clone())
            .or_insert_with(ControlState::new);
        if entry.held_since_ms.is_none() {
            entry.held_since_ms = Some(now_ms());
        }
        entry.bump();
    }

    /// Whether the user currently holds control of `sid`.
    pub fn is_held(&self, sid: &SessionId) -> bool {
        self.lock()
            .control
            .get(sid)
            .is_some_and(|entry| entry.held_since_ms.is_some())
    }

    /// Return control to the agent and record the return receipt.
    ///
    /// Also drops the legacy one-shot "pending interrupt" marker for
    /// `sid`: a takeover sets both states, so returning must clear both,
    /// otherwise the next input tool after the return is rejected once
    /// with "pending user interrupt" even though `wait_control` already
    /// told the agent control is back. The standalone Stop/interrupt flow
    /// (a bare [`SessionInterruptRegistry::mark`] with no takeover) is
    /// unaffected — it never reaches this method.
    ///
    /// Returns `true` when the session was actually held. Returning from
    /// a session that was not held still stores a receipt with
    /// `held_ms = 0` so a `control_returned` that races (or predates) the
    /// daemon's view of the takeover never loses the user's note.
    /// Wakes every `wait_control` waiter.
    pub fn release_control(&self, sid: &SessionId, note: Option<String>) -> bool {
        let now = now_ms();
        let mut guard = self.lock();
        guard.pending.remove(sid);
        let entry = guard
            .control
            .entry(sid.clone())
            .or_insert_with(ControlState::new);
        let held_since = entry.held_since_ms.take();
        let was_held = held_since.is_some();
        let held_ms = held_since
            .map(|start| now.saturating_sub(start))
            .unwrap_or(0);
        entry.last_return = Some(SessionReturnReceipt {
            note: note.unwrap_or_default(),
            held_ms,
            returned_at: format_rfc3339_ms(now),
        });
        entry.bump();
        was_held
    }

    /// Non-consuming read used by `session.status`.
    pub fn snapshot(&self, sid: &SessionId) -> ControlSnapshot {
        let guard = self.lock();
        let Some(entry) = guard.control.get(sid) else {
            return ControlSnapshot {
                control: SessionControl::Agent,
                pending_interrupt: guard.pending.contains(sid),
                held_for_ms: None,
                last_return: None,
            };
        };
        ControlSnapshot {
            control: control_of(entry),
            pending_interrupt: guard.pending.contains(sid),
            held_for_ms: entry
                .held_since_ms
                .map(|start| now_ms().saturating_sub(start)),
            last_return: entry.last_return.clone(),
        }
    }

    /// Take the last return receipt, if any. Single-use: the second call
    /// returns `None` until the user returns control again. Used by
    /// `session.wait_control` so the note is delivered exactly once.
    pub fn consume_return(&self, sid: &SessionId) -> Option<SessionReturnReceipt> {
        self.lock()
            .control
            .get_mut(sid)
            .and_then(|entry| entry.last_return.take())
    }

    /// Subscribe to control changes for `sid`, creating the bookkeeping
    /// entry when it does not exist yet (so a waiter that starts while
    /// the session is `agent` still observes a later takeover).
    fn signal_for(&self, sid: &SessionId) -> watch::Receiver<u64> {
        let mut guard = self.lock();
        guard
            .control
            .entry(sid.clone())
            .or_insert_with(ControlState::new)
            .signal
            .subscribe()
    }

    /// Atomically read the state and, when control is `agent`, consume
    /// the return receipt so exactly one waiter sees `Released`.
    fn poll_control(&self, sid: &SessionId) -> PollOutcome {
        let mut guard = self.lock();
        let Some(entry) = guard.control.get_mut(sid) else {
            return PollOutcome::AlreadyAgent;
        };
        if entry.held_since_ms.is_some() {
            let held_for_ms = entry
                .held_since_ms
                .map(|start| now_ms().saturating_sub(start))
                .unwrap_or(0);
            return PollOutcome::StillHeld { held_for_ms };
        }
        match entry.last_return.take() {
            Some(receipt) => PollOutcome::Released(receipt),
            None => PollOutcome::AlreadyAgent,
        }
    }

    /// Block until control returns to `agent`, `deadline` passes, or
    /// `session_exists()` reports the session gone.
    ///
    /// The registry mutex is only held for short, synchronous probes —
    /// waiting happens on the per-session watch channel, so a
    /// long-blocked `session.wait_control` never blocks other sessions'
    /// tool dispatch or status reads.
    pub async fn wait_for_release(
        &self,
        sid: &SessionId,
        deadline: tokio::time::Instant,
        session_exists: impl Fn() -> bool,
    ) -> WaitControlResolution {
        if !session_exists() {
            return WaitControlResolution::SessionGone;
        }
        let mut rx = self.signal_for(sid);
        loop {
            match self.poll_control(sid) {
                PollOutcome::Released(receipt) => {
                    return WaitControlResolution::Released(receipt);
                }
                PollOutcome::AlreadyAgent => return WaitControlResolution::AlreadyAgent,
                PollOutcome::StillHeld { .. } => {}
            }
            if !session_exists() {
                return WaitControlResolution::SessionGone;
            }
            // Scope the borrowed `changed` future so the receiver can be
            // re-subscribed after a sender-dropped wake-up.
            let signal_result = {
                let changed = rx.changed();
                tokio::pin!(changed);
                let sleep = tokio::time::sleep_until(deadline);
                tokio::pin!(sleep);
                tokio::select! {
                    result = &mut changed => Some(result),
                    _ = &mut sleep => None,
                }
            };
            match signal_result {
                Some(Ok(())) => {}
                Some(Err(_)) => {
                    // The sender was dropped: `drop_session` removed the
                    // entry (session torn down) or nobody ever owned it.
                    // Re-check existence before giving up so a release
                    // that raced teardown still wins.
                    if !session_exists() {
                        return WaitControlResolution::SessionGone;
                    }
                    rx = self.signal_for(sid);
                }
                None => {
                    // Re-probe once: a release may have landed at the
                    // deadline and must not be reported as a timeout.
                    return match self.poll_control(sid) {
                        PollOutcome::Released(receipt) => WaitControlResolution::Released(receipt),
                        PollOutcome::AlreadyAgent => WaitControlResolution::AlreadyAgent,
                        PollOutcome::StillHeld { held_for_ms } => {
                            WaitControlResolution::TimedOut { held_for_ms }
                        }
                    };
                }
            }
        }
    }

    /// Drop every entry for `sid`. **Every** session-teardown path MUST
    /// call this so neither a hot interrupt marker nor a held/receipt
    /// state leaks into the registry indefinitely, and so waiters parked
    /// on the control channel are woken (the sender is dropped). Current
    /// call sites:
    ///
    /// * `stop_session` (session.stop RPC + idle reaper)
    /// * `forget_session` (extension closed the agent window)
    /// * `purge_browser` cascade (browser disconnect — see `daemon/ws.rs`)
    /// * browser liveness reap (see `daemon/start.rs`)
    ///
    /// If a future code path adds another teardown route, add the
    /// `drop_session` call there too — there is no static check
    /// enforcing this.
    pub fn drop_session(&self, sid: &SessionId) {
        let mut guard = self.lock();
        guard.pending.remove(sid);
        guard.control.remove(sid);
    }

    #[cfg(test)]
    pub(crate) fn inner_pending_len(&self) -> usize {
        self.lock().pending.len()
    }

    #[cfg(test)]
    pub(crate) fn inner_control_len(&self) -> usize {
        self.lock().control.len()
    }

    #[cfg(test)]
    pub(crate) fn force_held_since(&self, sid: &SessionId, held_since_ms: u64) {
        let mut guard = self.lock();
        let entry = guard
            .control
            .entry(sid.clone())
            .or_insert_with(ControlState::new);
        entry.held_since_ms = Some(held_since_ms);
    }
}

fn control_of(entry: &ControlState) -> SessionControl {
    if entry.held_since_ms.is_some() {
        SessionControl::User
    } else {
        SessionControl::Agent
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Format an epoch-millisecond timestamp as RFC 3339 UTC
/// (`2021-01-01T00:00:00.000Z`).
///
/// Hand-rolled because the daemon deliberately keeps its dependency
/// surface small and no date-time crate is in the graph. The civil-date
/// conversion is Howard Hinnant's `days_from_civil` inverse, valid for
/// the whole proleptic Gregorian range we can represent in `i64` ms.
fn format_rfc3339_ms(ms: u64) -> String {
    let secs = (ms / 1_000) as i64;
    let millis = ms % 1_000;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (hour, minute, second) = (sod / 3_600, (sod % 3_600) / 60, sod % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sid(s: &str) -> SessionId {
        SessionId(s.to_string())
    }

    fn held_ms_for_test(reg: &SessionInterruptRegistry, s: &SessionId) -> u64 {
        reg.snapshot(s).held_for_ms.unwrap_or(0)
    }

    #[test]
    fn new_registry_is_empty() {
        let reg = SessionInterruptRegistry::new();
        assert_eq!(reg.inner_pending_len(), 0);
        assert_eq!(reg.inner_control_len(), 0);
    }

    #[test]
    fn mark_inserts_an_entry() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        assert!(reg.is_pending(&sid("A")));
    }

    #[test]
    fn mark_is_idempotent_per_session() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("A"));
        assert_eq!(reg.inner_pending_len(), 1);
    }

    #[test]
    fn mark_distinguishes_sessions() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("B"));
        assert_eq!(reg.inner_pending_len(), 2);
    }

    #[test]
    fn is_pending_reflects_mark_without_consuming() {
        let reg = SessionInterruptRegistry::new();
        assert!(!reg.is_pending(&sid("A")));
        reg.mark(&sid("A"));
        assert!(reg.is_pending(&sid("A")));
        assert!(reg.try_consume(&sid("A")));
        assert!(!reg.is_pending(&sid("A")));
    }

    #[test]
    fn try_consume_on_unmarked_session_returns_false() {
        let reg = SessionInterruptRegistry::new();
        assert!(!reg.try_consume(&sid("ghost")));
        assert_eq!(reg.inner_pending_len(), 0);
    }

    #[test]
    fn try_consume_after_mark_returns_true_and_removes() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        assert!(reg.try_consume(&sid("A")));
        assert!(!reg.is_pending(&sid("A")));
    }

    #[test]
    fn try_consume_is_single_use() {
        // Two consecutive consumes: only the first wins.
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        assert!(reg.try_consume(&sid("A")));
        assert!(!reg.try_consume(&sid("A")));
    }

    #[test]
    fn try_consume_does_not_affect_other_sessions() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("B"));
        assert!(reg.try_consume(&sid("A")));
        assert!(reg.is_pending(&sid("B")));
    }

    #[test]
    fn drop_session_clears_pending_entry() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.drop_session(&sid("A"));
        assert!(!reg.is_pending(&sid("A")));
    }

    #[test]
    fn drop_session_on_unknown_session_is_noop() {
        let reg = SessionInterruptRegistry::new();
        reg.drop_session(&sid("ghost"));
        assert_eq!(reg.inner_pending_len(), 0);
    }

    #[test]
    fn drop_session_does_not_affect_other_sessions() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("B"));
        reg.drop_session(&sid("A"));
        assert!(!reg.is_pending(&sid("A")));
        assert!(reg.is_pending(&sid("B")));
    }

    #[test]
    fn drop_session_after_mark_makes_subsequent_try_consume_return_false() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.drop_session(&sid("A"));
        assert!(!reg.try_consume(&sid("A")));
    }

    // ----- takeover lifecycle -----

    #[test]
    fn control_defaults_to_agent() {
        let reg = SessionInterruptRegistry::new();
        let snap = reg.snapshot(&sid("A"));
        assert_eq!(snap.control, SessionControl::Agent);
        assert!(!snap.pending_interrupt);
        assert!(snap.held_for_ms.is_none());
        assert!(snap.last_return.is_none());
        assert!(!reg.is_held(&sid("A")));
    }

    #[test]
    fn take_control_holds_session_and_is_idempotent() {
        let reg = SessionInterruptRegistry::new();
        reg.take_control(&sid("A"));
        assert!(reg.is_held(&sid("A")));
        assert_eq!(reg.snapshot(&sid("A")).control, SessionControl::User);
        // A repeated take must not reset the hold clock (no observable
        // way to inject a clock here, so assert the entry count instead).
        reg.take_control(&sid("A"));
        assert_eq!(reg.inner_control_len(), 1);
        assert!(reg.is_held(&sid("A")));
    }

    #[test]
    fn release_control_clears_held_and_records_receipt() {
        let reg = SessionInterruptRegistry::new();
        // Backdate the hold start so `held_ms` is a deterministic ~5000ms.
        reg.force_held_since(&sid("A"), now_ms().saturating_sub(5_000));
        let was_held = reg.release_control(&sid("A"), Some("filled the form".into()));
        assert!(was_held, "release on a held session reports was_held");
        let snap = reg.snapshot(&sid("A"));
        assert_eq!(snap.control, SessionControl::Agent);
        assert!(snap.held_for_ms.is_none());
        let receipt = snap.last_return.expect("receipt recorded");
        assert_eq!(receipt.note, "filled the form");
        assert!(
            (4_900..=6_000).contains(&receipt.held_ms),
            "held_ms should reflect the ~5s hold, got {}",
            receipt.held_ms
        );
        assert_eq!(held_ms_for_test(&reg, &sid("A")), 0);
        assert!(receipt.returned_at.ends_with('Z'));
    }

    #[test]
    fn release_control_without_hold_stores_empty_receipt() {
        let reg = SessionInterruptRegistry::new();
        let was_held = reg.release_control(&sid("A"), None);
        assert!(!was_held);
        let receipt = reg.snapshot(&sid("A")).last_return.expect("receipt");
        assert_eq!(receipt.note, "");
        assert_eq!(receipt.held_ms, 0);
    }

    #[test]
    fn held_state_is_not_consumed_by_repeated_reads_or_teardown_free_probes() {
        // The IPC gate must NOT be able to clear the flag: it only
        // consults `is_held`. Simulate many rejected dispatches.
        let reg = SessionInterruptRegistry::new();
        reg.take_control(&sid("A"));
        for _ in 0..5 {
            assert!(reg.is_held(&sid("A")));
        }
        assert!(reg.is_held(&sid("A")));
    }

    #[test]
    fn consume_return_is_single_use() {
        let reg = SessionInterruptRegistry::new();
        reg.take_control(&sid("A"));
        reg.release_control(&sid("A"), Some("done".into()));
        let first = reg.consume_return(&sid("A")).expect("first consume wins");
        assert_eq!(first.note, "done");
        assert!(
            reg.consume_return(&sid("A")).is_none(),
            "second consume must be empty"
        );
        // `status` no longer shows the receipt once consumed.
        assert!(reg.snapshot(&sid("A")).last_return.is_none());
    }

    #[test]
    fn drop_session_clears_held_and_receipt() {
        let reg = SessionInterruptRegistry::new();
        reg.take_control(&sid("A"));
        reg.release_control(&sid("A"), Some("done".into()));
        reg.drop_session(&sid("A"));
        let snap = reg.snapshot(&sid("A"));
        assert_eq!(snap.control, SessionControl::Agent);
        assert!(snap.last_return.is_none());
        assert!(snap.held_for_ms.is_none());
        assert_eq!(reg.inner_control_len(), 0);
    }

    #[test]
    fn drop_session_clears_held_for_other_sessions_only() {
        let reg = SessionInterruptRegistry::new();
        reg.take_control(&sid("A"));
        reg.take_control(&sid("B"));
        reg.drop_session(&sid("A"));
        assert!(!reg.is_held(&sid("A")));
        assert!(reg.is_held(&sid("B")));
    }

    #[test]
    fn one_shot_mark_still_works_alongside_held_state() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.take_control(&sid("A"));
        assert!(reg.try_consume(&sid("A")), "mark survives a takeover");
        assert!(!reg.try_consume(&sid("A")));
        assert!(reg.is_held(&sid("A")), "held is independent of the marker");
    }

    #[test]
    fn release_control_also_drops_the_one_shot_marker() {
        // The takeover handshake sets both states; returning control must
        // clear both, otherwise the agent's next input tool is rejected
        // once with "pending user interrupt" right after `wait_control`
        // told it control is back.
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.take_control(&sid("A"));
        reg.release_control(&sid("A"), Some("done".into()));
        assert!(!reg.is_pending(&sid("A")), "marker dropped on return");
        assert!(!reg.is_held(&sid("A")), "hold cleared on return");
        assert!(!reg.try_consume(&sid("A")), "nothing left to consume");
        assert_eq!(reg.inner_pending_len(), 0);
    }

    #[test]
    fn release_control_leaves_other_sessions_pending_marker_alone() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("B"));
        reg.take_control(&sid("A"));
        reg.release_control(&sid("A"), None);
        assert!(!reg.is_pending(&sid("A")));
        assert!(
            reg.is_pending(&sid("B")),
            "a return must not clear another session's marker"
        );
    }

    #[test]
    fn release_control_without_hold_still_drops_a_stray_marker() {
        // `control_returned` may arrive after a standalone Stop marked the
        // session (or before the daemon saw the takeover); the return is
        // still the user handing control back, so the marker must go.
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        let was_held = reg.release_control(&sid("A"), None);
        assert!(!was_held);
        assert!(!reg.is_pending(&sid("A")));
        assert!(!reg.try_consume(&sid("A")));
    }

    #[test]
    fn standalone_interrupt_marker_survives_without_a_return() {
        // The Stop/interrupt flow (mark without take_control) must keep its
        // one-shot semantics: nothing but a dispatch or teardown clears it.
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        assert!(reg.is_pending(&sid("A")));
        assert!(reg.try_consume(&sid("A")));
        assert!(!reg.try_consume(&sid("A")));
    }

    // ----- wait_control -----

    #[tokio::test]
    async fn wait_returns_already_agent_without_receipt() {
        let reg = SessionInterruptRegistry::new();
        let resolution = reg
            .wait_for_release(
                &sid("A"),
                tokio::time::Instant::now() + std::time::Duration::from_millis(200),
                || true,
            )
            .await;
        assert_eq!(resolution, WaitControlResolution::AlreadyAgent);
    }

    #[tokio::test]
    async fn wait_returns_session_gone_when_session_missing() {
        let reg = SessionInterruptRegistry::new();
        let resolution = reg
            .wait_for_release(
                &sid("A"),
                tokio::time::Instant::now() + std::time::Duration::from_millis(200),
                || false,
            )
            .await;
        assert_eq!(resolution, WaitControlResolution::SessionGone);
    }

    #[tokio::test]
    async fn wait_released_path_returns_the_receipt_once() {
        let reg = std::sync::Arc::new(SessionInterruptRegistry::new());
        reg.take_control(&sid("A"));
        let reg_for_release = std::sync::Arc::clone(&reg);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            reg_for_release.release_control(&sid("A"), Some("handled login".into()));
        });
        let resolution = reg
            .wait_for_release(
                &sid("A"),
                tokio::time::Instant::now() + std::time::Duration::from_secs(2),
                || true,
            )
            .await;
        match resolution {
            WaitControlResolution::Released(receipt) => {
                assert_eq!(receipt.note, "handled login");
                assert!(receipt.held_ms <= 2_000);
            }
            other => panic!("expected released, got {other:?}"),
        }
        // A second wait sees no receipt.
        let second = reg
            .wait_for_release(
                &sid("A"),
                tokio::time::Instant::now() + std::time::Duration::from_millis(100),
                || true,
            )
            .await;
        assert_eq!(second, WaitControlResolution::AlreadyAgent);
    }

    #[tokio::test]
    async fn wait_times_out_while_held_and_reports_hold_duration() {
        let reg = SessionInterruptRegistry::new();
        reg.force_held_since(&sid("A"), now_ms().saturating_sub(1_500));
        let resolution = reg
            .wait_for_release(
                &sid("A"),
                tokio::time::Instant::now() + std::time::Duration::from_millis(50),
                || true,
            )
            .await;
        match resolution {
            WaitControlResolution::TimedOut { held_for_ms } => {
                assert!(
                    held_for_ms >= 1_500,
                    "expected ~1.5s hold, got {held_for_ms}"
                );
            }
            other => panic!("expected timed_out, got {other:?}"),
        }
        assert!(reg.is_held(&sid("A")), "timeout must not clear the hold");
    }

    #[tokio::test]
    async fn wait_wakes_on_drop_session() {
        let reg = std::sync::Arc::new(SessionInterruptRegistry::new());
        reg.take_control(&sid("A"));
        let reg_for_drop = std::sync::Arc::clone(&reg);
        // The session is "alive" until the drop happens.
        let alive = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let alive_for_drop = std::sync::Arc::clone(&alive);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            alive_for_drop.store(false, std::sync::atomic::Ordering::SeqCst);
            reg_for_drop.drop_session(&sid("A"));
        });
        let resolution = reg
            .wait_for_release(
                &sid("A"),
                tokio::time::Instant::now() + std::time::Duration::from_secs(2),
                || alive.load(std::sync::atomic::Ordering::SeqCst),
            )
            .await;
        assert_eq!(resolution, WaitControlResolution::SessionGone);
    }

    #[tokio::test]
    async fn wait_does_not_block_other_registry_users() {
        // A waiter must not hold the registry mutex: while one call is
        // parked, another thread can still read/consume state.
        let reg = std::sync::Arc::new(SessionInterruptRegistry::new());
        reg.take_control(&sid("A"));
        let waiter = {
            let reg = std::sync::Arc::clone(&reg);
            tokio::spawn(async move {
                reg.wait_for_release(
                    &sid("A"),
                    tokio::time::Instant::now() + std::time::Duration::from_millis(300),
                    || true,
                )
                .await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        // These would deadlock if the waiter held the mutex across await.
        assert!(reg.is_held(&sid("A")));
        assert_eq!(reg.snapshot(&sid("A")).control, SessionControl::User);
        assert_eq!(reg.inner_control_len(), 1);
        let _ = waiter.await.unwrap();
    }

    #[test]
    fn rfc3339_epoch_formats_as_utc() {
        assert_eq!(format_rfc3339_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            format_rfc3339_ms(1_609_459_200_000),
            "2021-01-01T00:00:00.000Z"
        );
        assert_eq!(
            format_rfc3339_ms(1_609_459_200_123),
            "2021-01-01T00:00:00.123Z"
        );
        // Leap day boundary.
        assert_eq!(
            format_rfc3339_ms(1_582_934_400_000),
            "2020-02-29T00:00:00.000Z"
        );
    }
}
