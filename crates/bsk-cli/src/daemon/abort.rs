//! Per-RPC cancellation tokens for the daemon side (M9.3 scaffold).
//!
//! Long-running daemon-side handlers (currently `tool.wait_ms`)
//! register an [`AbortToken`] in this registry keyed by their wire
//! `rpc_id` before they start sleeping. A subsequent `cancel
//! { rpc_id }` RPC looks the token up and trips it — the original
//! handler then short-circuits and returns `ErrorCode::Cancelled`.
//!
//! M10.2 will wire CLI `SIGINT → cancel { rpc_id }` on top of this
//! registry. M9 leaves the interface stable so M10 only needs to add
//! the signal-handler side.
//!
//! Implementation note: we deliberately avoid `tokio_util` to keep
//! the workspace dep set tight. `Notify` + an atomic flag give us the
//! same `.cancel()` / `.cancelled()` surface a `CancellationToken`
//! would.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use bsk_protocol::RpcId;
use tokio::sync::Notify;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AbortRegisterError {
    DuplicateRpcId(RpcId),
}

#[derive(Default)]
pub struct AbortRegistry {
    tokens: Mutex<HashMap<RpcId, AbortToken>>,
}

impl std::fmt::Debug for AbortRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AbortRegistry")
            .field("len", &self.len())
            .finish()
    }
}

impl AbortRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.tokens.lock().expect("AbortRegistry poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn contains(&self, rpc_id: &RpcId) -> bool {
        self.tokens
            .lock()
            .expect("AbortRegistry poisoned")
            .contains_key(rpc_id)
    }

    /// Allocate a fresh token, register it under `rpc_id`, and return
    /// a [`AbortGuard`] that drops the registry entry on drop. The
    /// handler should hold this guard for the lifetime of the
    /// cancellable work — dropping it auto-cleans the registry even
    /// on panic.
    pub fn register(self: &Arc<Self>, rpc_id: RpcId) -> Result<AbortGuard, AbortRegisterError> {
        let token = AbortToken::new();
        {
            let mut guard = self.tokens.lock().expect("AbortRegistry poisoned");
            if guard.contains_key(&rpc_id) {
                return Err(AbortRegisterError::DuplicateRpcId(rpc_id));
            }
            guard.insert(rpc_id.clone(), token.clone());
        }
        Ok(AbortGuard {
            registry: Arc::clone(self),
            rpc_id,
            token,
        })
    }

    /// Cancel the token registered under `rpc_id`, if any. Returns
    /// `true` when a token was found and tripped, `false` otherwise.
    pub fn cancel(&self, rpc_id: &RpcId) -> bool {
        let guard = self.tokens.lock().expect("AbortRegistry poisoned");
        if let Some(token) = guard.get(rpc_id) {
            token.cancel();
            true
        } else {
            false
        }
    }

    fn unregister(&self, rpc_id: &RpcId, token: &AbortToken) {
        let mut guard = self.tokens.lock().expect("AbortRegistry poisoned");
        let should_remove = guard
            .get(rpc_id)
            .is_some_and(|current| current.ptr_eq(token));
        if should_remove {
            guard.remove(rpc_id);
        }
    }
}

/// RAII wrapper around a registered token. Dropping the guard
/// removes the entry from the registry; the underlying [`AbortToken`]
/// stays alive (cloned into the handler) and can still observe a
/// `cancel()` already in flight.
#[must_use = "dropping AbortGuard immediately unregisters cancellation for this RPC"]
pub struct AbortGuard {
    registry: Arc<AbortRegistry>,
    rpc_id: RpcId,
    token: AbortToken,
}

impl AbortGuard {
    pub fn token(&self) -> &AbortToken {
        &self.token
    }
}

impl Drop for AbortGuard {
    fn drop(&mut self) {
        self.registry.unregister(&self.rpc_id, &self.token);
    }
}

#[derive(Clone, Default)]
pub struct AbortToken {
    inner: Arc<AbortInner>,
}

impl std::fmt::Debug for AbortToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AbortToken")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

struct AbortInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Default for AbortInner {
    fn default() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }
}

impl AbortToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        // Order matters: flip the flag first so any future `await`
        // sees the cancelled state even if `notify_waiters` races
        // with a registration that hasn't yet polled `notified()`.
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    fn ptr_eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    /// Resolve as soon as `.cancel()` is called (or immediately if
    /// the token is already cancelled).
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let notified = self.inner.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn cancel_propagates_through_token() {
        let token = AbortToken::new();
        assert!(!token.is_cancelled());
        let t2 = token.clone();
        let task = tokio::spawn(async move {
            t2.cancelled().await;
            true
        });
        token.cancel();
        let res = tokio::time::timeout(Duration::from_millis(200), task)
            .await
            .expect("task should complete")
            .unwrap();
        assert!(res);
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn cancel_before_await_resolves_immediately() {
        let token = AbortToken::new();
        token.cancel();
        let res = tokio::time::timeout(Duration::from_millis(50), token.cancelled()).await;
        assert!(res.is_ok());
    }

    #[tokio::test]
    async fn registry_cancels_by_rpc_id() {
        let reg = Arc::new(AbortRegistry::new());
        let guard = reg.register("rpc-1".into()).expect("register rpc-1");
        let token = guard.token().clone();
        assert_eq!(reg.len(), 1);
        assert!(reg.cancel(&"rpc-1".to_string()));
        assert!(token.is_cancelled());
        drop(guard);
        assert!(reg.is_empty());
    }

    #[tokio::test]
    async fn cancel_unknown_id_is_noop() {
        let reg = Arc::new(AbortRegistry::new());
        assert!(!reg.cancel(&"missing".to_string()));
    }

    #[tokio::test]
    async fn drop_guard_removes_entry() {
        let reg = Arc::new(AbortRegistry::new());
        let guard = reg.register("rpc-1".into()).expect("register rpc-1");
        assert_eq!(reg.len(), 1);
        drop(guard);
        assert_eq!(reg.len(), 0);
    }

    #[tokio::test]
    async fn duplicate_rpc_id_is_rejected_without_replacing_original_token() {
        let reg = Arc::new(AbortRegistry::new());
        let first = reg.register("rpc-1".into()).expect("first register");
        let first_token = first.token().clone();

        let duplicate = reg.register("rpc-1".into());

        assert!(duplicate.is_err());
        assert_eq!(reg.len(), 1);
        assert!(reg.cancel(&"rpc-1".to_string()));
        assert!(first_token.is_cancelled());
        drop(first);
        assert!(reg.is_empty());
    }
}
