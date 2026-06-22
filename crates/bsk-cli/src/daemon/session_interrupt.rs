//! Per-session "pending interrupt" message.
//!
//! Holds a single-use marker per `SessionId` indicating that the
//! user has clicked the agent-window mask's stop button. The next
//! mutating `tool.*` call for that session is rejected with
//! `ErrorCode::UserAborted`; read-only tools and session-lifecycle
//! RPCs pass through transparently and do not consume the marker.
//!
//! The marker is single-use and has no expiry: it sits in the
//! registry until consumed by a mutating call or until the session
//! is torn down. This lets the user's interrupt survive an LLM
//! thinking phase of arbitrary length — the v1 time-window
//! mechanism dropped interrupts whenever the LLM took longer to
//! respond than the window allowed.
//!
//! Independent of `SessionRegistry` because the signal is a
//! transient runtime control state, not a session lifecycle
//! attribute.

use std::collections::HashSet;
use std::sync::Mutex;

use super::sessions::SessionId;

#[derive(Default)]
pub struct SessionInterruptRegistry {
    inner: Mutex<HashSet<SessionId>>,
}

impl std::fmt::Debug for SessionInterruptRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let len = self.inner.lock().map(|g| g.len()).unwrap_or(0);
        f.debug_struct("SessionInterruptRegistry")
            .field("len", &len)
            .finish()
    }
}

impl SessionInterruptRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark `sid` as having a pending interrupt. Idempotent —
    /// repeated marks are a no-op (the marker is a single-use flag,
    /// not a counter).
    pub fn mark(&self, sid: &SessionId) {
        let mut guard = self.inner.lock().expect("session_interrupt poisoned");
        guard.insert(sid.clone());
    }

    /// Whether `sid` currently has a pending interrupt marker.
    pub fn is_pending(&self, sid: &SessionId) -> bool {
        let guard = self.inner.lock().expect("session_interrupt poisoned");
        guard.contains(sid)
    }

    /// Probe + consume. If `sid` has a pending interrupt, remove it
    /// and return `true`. Otherwise return `false` without
    /// modifying the registry.
    ///
    /// Single-use semantics: once consumed by one call, subsequent
    /// `try_consume` calls for the same session return `false`
    /// until the session is marked again.
    pub fn try_consume(&self, sid: &SessionId) -> bool {
        let mut guard = self.inner.lock().expect("session_interrupt poisoned");
        guard.remove(sid)
    }

    /// Drop any pending entry for `sid`. **Every** session-teardown
    /// path MUST call this so a session torn down while a signal
    /// was hot does not leak the entry into the registry
    /// indefinitely. Current call sites:
    ///
    /// * `stop_session` (session.stop RPC)
    /// * `forget_session` (extension closed the agent window)
    /// * `purge_browser` cascade (browser disconnect — see
    ///   `daemon/ws.rs`)
    ///
    /// If a future code path adds a fourth teardown route, add the
    /// `drop_session` call there too — there is no static check
    /// enforcing this.
    pub fn drop_session(&self, sid: &SessionId) {
        let mut guard = self.inner.lock().expect("session_interrupt poisoned");
        guard.remove(sid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sid(s: &str) -> SessionId {
        SessionId(s.to_string())
    }

    #[test]
    fn new_registry_is_empty() {
        let reg = SessionInterruptRegistry::new();
        assert!(reg.inner.lock().unwrap().is_empty());
    }

    #[test]
    fn mark_inserts_an_entry() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        assert!(reg.inner.lock().unwrap().contains(&sid("A")));
    }

    #[test]
    fn mark_is_idempotent_per_session() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("A"));
        assert_eq!(reg.inner.lock().unwrap().len(), 1);
    }

    #[test]
    fn mark_distinguishes_sessions() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("B"));
        assert_eq!(reg.inner.lock().unwrap().len(), 2);
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
        assert!(reg.inner.lock().unwrap().is_empty());
    }

    #[test]
    fn try_consume_after_mark_returns_true_and_removes() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        assert!(reg.try_consume(&sid("A")));
        assert!(!reg.inner.lock().unwrap().contains(&sid("A")));
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
        assert!(reg.inner.lock().unwrap().contains(&sid("B")));
    }

    #[test]
    fn drop_session_clears_pending_entry() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.drop_session(&sid("A"));
        assert!(!reg.inner.lock().unwrap().contains(&sid("A")));
    }

    #[test]
    fn drop_session_on_unknown_session_is_noop() {
        let reg = SessionInterruptRegistry::new();
        reg.drop_session(&sid("ghost"));
        assert!(reg.inner.lock().unwrap().is_empty());
    }

    #[test]
    fn drop_session_does_not_affect_other_sessions() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.mark(&sid("B"));
        reg.drop_session(&sid("A"));
        assert!(!reg.inner.lock().unwrap().contains(&sid("A")));
        assert!(reg.inner.lock().unwrap().contains(&sid("B")));
    }

    #[test]
    fn drop_session_after_mark_makes_subsequent_try_consume_return_false() {
        let reg = SessionInterruptRegistry::new();
        reg.mark(&sid("A"));
        reg.drop_session(&sid("A"));
        assert!(!reg.try_consume(&sid("A")));
    }
}
