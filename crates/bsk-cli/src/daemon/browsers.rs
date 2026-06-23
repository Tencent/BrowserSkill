//! In-memory table of connected extension clients.
//!
//! Each WS connection that completes the handshake registers a
//! [`BrowserClient`] keyed by its `instance_id` (treated as the public
//! BrowserId). Reconnects re-use the same id and replace the previous
//! entry so `bsk status` shows a single row per physical browser.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::Result;
use bsk_protocol::{Frame, RpcId};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

use bsk_protocol::system::BrowserStatusEntry;

/// After a daemon cold start the MV3 service worker may take several
/// seconds to wake, discover the WS port, and finish `system.handshake`.
/// `session.start` polls the registry for up to this long before
/// returning `no_browser_connected`.
pub const EXTENSION_CONNECT_WAIT: Duration = Duration::from_secs(5);

const EXTENSION_CONNECT_POLL: Duration = Duration::from_millis(50);

/// Process-wide monotonic counter for [`BrowserClient::generation`]. Used
/// by the reconnect-race guard: when an old WS task tears down it only
/// removes itself from the registry if the registry's current
/// `Arc<BrowserClient>` matches the same generation (review M4/M5 round
/// 2 Important #1).
static NEXT_BROWSER_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub fn next_browser_generation() -> u64 {
    NEXT_BROWSER_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Logical identifier of a connected extension.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BrowserId(pub String);

impl fmt::Display for BrowserId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Outbound channel handle used to push frames to a specific extension.
#[derive(Debug, Clone)]
pub struct BrowserSink {
    pub tx: mpsc::UnboundedSender<Frame>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("browser sink closed")]
pub struct BrowserSinkClosed;

impl BrowserSink {
    pub fn send(&self, frame: Frame) -> Result<(), BrowserSinkClosed> {
        self.tx.send(frame).map_err(|_| BrowserSinkClosed)
    }
}

/// Pending in-flight RPCs that the daemon is awaiting a response for from
/// a specific browser, keyed by the request's `id`.
#[derive(Debug, Default)]
pub struct Pending {
    waiters: HashMap<RpcId, oneshot::Sender<bsk_protocol::ResponseFrame>>,
}

impl Pending {
    pub fn register(&mut self, id: RpcId) -> oneshot::Receiver<bsk_protocol::ResponseFrame> {
        let (tx, rx) = oneshot::channel();
        self.waiters.insert(id, tx);
        rx
    }

    pub fn resolve(&mut self, frame: bsk_protocol::ResponseFrame) -> bool {
        if let Some(tx) = self.waiters.remove(&frame.id) {
            let _ = tx.send(frame);
            true
        } else {
            false
        }
    }

    /// Drop a registered waiter without delivering a response. Used on
    /// caller-side error/timeout paths so the `HashMap` does not
    /// accumulate stale entries (review M4/M5 I1). The corresponding
    /// `oneshot::Sender` is dropped, which closes its receiver so any
    /// still-pending caller observes a `TransportClosed`-style error.
    pub fn cancel(&mut self, id: &RpcId) {
        self.waiters.remove(id);
    }
}

#[derive(Debug)]
pub struct BrowserClient {
    /// Logical identifier (the extension's self-allocated stable short id
    /// from `chrome.storage.local.bsk_instance_id`, NOT the Chromium
    /// extension id which only flows through the Origin allow-list).
    pub id: BrowserId,
    pub browser_name: String,
    pub browser_version: String,
    pub extension_version: String,
    /// `protocol_version` from the extension handshake.
    pub extension_protocol_version: String,
    pub label: String,
    pub sink: BrowserSink,
    pub pending: Mutex<Pending>,
    /// Monotonic counter assigned at registration time. A reconnect
    /// inserts a new `BrowserClient` under the same `id`; the old WS
    /// driver task only removes itself if the current entry still has
    /// the same generation, otherwise the new connection has taken
    /// over and we leave it alone.
    pub generation: u64,
    /// Unix epoch milliseconds when the registration completed (i.e.
    /// when the WS handshake landed and this client took its slot in
    /// the registry). Surfaces in `BrowserStatusEntry::connected_at_ms`
    /// so `bsk browsers` and the M10.1 `multiple_browsers_online`
    /// error.data can render a stable "online since" hint.
    pub connected_at_ms: i64,
    /// `true` when the peer's `protocol_version` differs from ours
    /// (same major, minor drift). Set during WS handshake (M10.4).
    pub version_skew: bool,
}

impl BrowserClient {
    pub fn status_entry(&self, session_count: u32) -> BrowserStatusEntry {
        BrowserStatusEntry {
            instance_id: self.id.0.clone(),
            browser_name: self.browser_name.clone(),
            browser_version: self.browser_version.clone(),
            extension_version: self.extension_version.clone(),
            label: self.label.clone(),
            session_count,
            connected_at_ms: self.connected_at_ms,
            version_skew: self.version_skew,
            extension_protocol_version: self.extension_protocol_version.clone(),
        }
    }
}

#[derive(Debug, Default)]
pub struct BrowserRegistry {
    inner: Mutex<HashMap<BrowserId, std::sync::Arc<BrowserClient>>>,
}

impl BrowserRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn insert(&self, client: std::sync::Arc<BrowserClient>) {
        let mut guard = self.inner.lock().expect("browser registry poisoned");
        if let Some(prev) = guard.get(&client.id) {
            tracing::info!(
                id = %client.id,
                old_generation = prev.generation,
                new_generation = client.generation,
                "browser reconnect: replacing previous registration"
            );
        }
        guard.insert(client.id.clone(), client);
    }

    pub fn remove(&self, id: &BrowserId) -> Option<std::sync::Arc<BrowserClient>> {
        self.inner
            .lock()
            .expect("browser registry poisoned")
            .remove(id)
    }

    /// Drop the entry for `id` only if the current registered
    /// [`BrowserClient`] still matches `generation`. Used by WS
    /// drivers on cleanup to avoid clobbering a reconnect that already
    /// took over the same `id` while the old socket was tearing down
    /// (review M4/M5 round 2 Important #1). Returns the removed entry
    /// when a removal actually happened.
    pub fn remove_if_generation_matches(
        &self,
        id: &BrowserId,
        generation: u64,
    ) -> Option<std::sync::Arc<BrowserClient>> {
        let mut guard = self.inner.lock().expect("browser registry poisoned");
        match guard.get(id) {
            Some(current) if current.generation == generation => guard.remove(id),
            _ => None,
        }
    }

    pub fn get(&self, id: &BrowserId) -> Option<std::sync::Arc<BrowserClient>> {
        self.inner
            .lock()
            .expect("browser registry poisoned")
            .get(id)
            .cloned()
    }

    pub fn snapshot(&self) -> Vec<std::sync::Arc<BrowserClient>> {
        let guard = self.inner.lock().expect("browser registry poisoned");
        guard.values().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("browser registry poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Poll until at least one browser is registered or `connect_wait` elapses.
    /// Returns immediately when the registry is already non-empty.
    pub async fn wait_for_any_connected(&self, connect_wait: Duration) {
        if connect_wait.is_zero() || !self.is_empty() {
            return;
        }
        let deadline = Instant::now() + connect_wait;
        loop {
            if !self.is_empty() {
                return;
            }
            if Instant::now() >= deadline {
                return;
            }
            tokio::time::sleep(EXTENSION_CONNECT_POLL).await;
        }
    }

    /// Pick the only connected browser when exactly one is online, or
    /// match a specific id / label when supplied. Returns an error code
    /// aligned with §4.5.
    ///
    /// Lookup precedence when `requested` is `Some(value)`:
    /// 1. Exact `instance_id` match — returns immediately. Instance ids
    ///    are opaque hex strings allocated by the extension; collisions
    ///    with a user label are vanishingly unlikely but if both
    ///    matched we still prefer the id (M10.1).
    /// 2. Exact, case-sensitive `label` match against non-empty labels.
    ///    A single match returns that client; multiple matches surface
    ///    [`SelectError::AmbiguousLabel`] so the CLI can prompt the
    ///    user to disambiguate by `instance_id`.
    /// 3. Otherwise [`SelectError::NotFound`].
    pub fn select(
        &self,
        requested: Option<&str>,
    ) -> Result<std::sync::Arc<BrowserClient>, SelectError> {
        let guard = self.inner.lock().expect("browser registry poisoned");
        match requested {
            Some(needle) if !needle.is_empty() => {
                if let Some(client) = guard.get(&BrowserId(needle.to_string())) {
                    return Ok(client.clone());
                }
                let label_matches: Vec<std::sync::Arc<BrowserClient>> = guard
                    .values()
                    .filter(|c| !c.label.is_empty() && c.label == needle)
                    .cloned()
                    .collect();
                match label_matches.len() {
                    0 => Err(SelectError::NotFound),
                    1 => Ok(label_matches.into_iter().next().unwrap()),
                    _ => Err(SelectError::AmbiguousLabel {
                        label: needle.to_string(),
                        instance_ids: label_matches.into_iter().map(|c| c.id.0.clone()).collect(),
                    }),
                }
            }
            Some(_) | None => {
                let mut iter = guard.values();
                let Some(first) = iter.next() else {
                    return Err(SelectError::NoBrowserConnected);
                };
                if iter.next().is_some() {
                    return Err(SelectError::MultipleBrowsersOnline);
                }
                Ok(first.clone())
            }
        }
    }

    /// Like [`BrowserRegistry::select`] but retries while no matching
    /// browser is registered yet, so a freshly started daemon can wait
    /// for the extension to finish its WS handshake.
    pub async fn select_with_connect_wait(
        &self,
        requested: Option<&str>,
        connect_wait: Duration,
    ) -> Result<std::sync::Arc<BrowserClient>, SelectError> {
        let deadline = Instant::now() + connect_wait;
        loop {
            match self.select(requested) {
                Ok(client) => return Ok(client),
                Err(SelectError::NoBrowserConnected) => {
                    if Instant::now() >= deadline {
                        return self.select(requested);
                    }
                    tokio::time::sleep(EXTENSION_CONNECT_POLL).await;
                }
                // Only wait for a missing selector while no browser has
                // registered yet (cold start). If other browsers are
                // already online, an unknown id/label is a real miss.
                Err(SelectError::NotFound) if self.is_empty() => {
                    if Instant::now() >= deadline {
                        return self.select(requested);
                    }
                    tokio::time::sleep(EXTENSION_CONNECT_POLL).await;
                }
                Err(err) => return Err(err),
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectError {
    NoBrowserConnected,
    MultipleBrowsersOnline,
    NotFound,
    /// The supplied label matches more than one connected browser.
    /// The CLI rendering layer surfaces the candidate `instance_ids`
    /// so the user can rerun with an unambiguous selector.
    AmbiguousLabel {
        label: String,
        instance_ids: Vec<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_client(id: &str, label: &str) -> std::sync::Arc<BrowserClient> {
        let (tx, _rx) = mpsc::unbounded_channel::<Frame>();
        std::sync::Arc::new(BrowserClient {
            id: BrowserId(id.into()),
            browser_name: "chrome".into(),
            browser_version: "131".into(),
            extension_version: "0.1.0-dev.0".into(),
            extension_protocol_version: "1.0".into(),
            label: label.into(),
            sink: BrowserSink { tx },
            pending: Mutex::new(Pending::default()),
            generation: next_browser_generation(),
            connected_at_ms: 0,
            version_skew: false,
        })
    }

    #[test]
    fn select_none_with_zero_browsers_is_no_browser_connected() {
        let reg = BrowserRegistry::new();
        match reg.select(None) {
            Err(SelectError::NoBrowserConnected) => {}
            other => panic!("expected NoBrowserConnected, got {other:?}"),
        }
    }

    #[test]
    fn select_none_with_two_browsers_is_multiple() {
        let reg = BrowserRegistry::new();
        reg.insert(fake_client("a", ""));
        reg.insert(fake_client("b", ""));
        match reg.select(None) {
            Err(SelectError::MultipleBrowsersOnline) => {}
            other => panic!("expected MultipleBrowsersOnline, got {other:?}"),
        }
    }

    #[test]
    fn select_by_instance_id_returns_match() {
        let reg = BrowserRegistry::new();
        reg.insert(fake_client("alpha", "Personal"));
        reg.insert(fake_client("beta", "Work"));
        let picked = reg.select(Some("alpha")).expect("alpha should match");
        assert_eq!(picked.id, BrowserId("alpha".into()));
    }

    #[test]
    fn select_by_unique_label_returns_match() {
        let reg = BrowserRegistry::new();
        reg.insert(fake_client("alpha", "Personal"));
        reg.insert(fake_client("beta", "Work"));
        let picked = reg.select(Some("Work")).expect("Work label should match");
        assert_eq!(picked.id, BrowserId("beta".into()));
    }

    #[test]
    fn select_by_unknown_string_is_not_found() {
        let reg = BrowserRegistry::new();
        reg.insert(fake_client("alpha", "Personal"));
        match reg.select(Some("nope")) {
            Err(SelectError::NotFound) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn select_by_ambiguous_label_lists_candidates() {
        let reg = BrowserRegistry::new();
        reg.insert(fake_client("alpha", "Shared"));
        reg.insert(fake_client("beta", "Shared"));
        match reg.select(Some("Shared")) {
            Err(SelectError::AmbiguousLabel {
                label,
                instance_ids,
            }) => {
                assert_eq!(label, "Shared");
                assert_eq!(instance_ids.len(), 2);
                let set: std::collections::HashSet<&str> =
                    instance_ids.iter().map(String::as_str).collect();
                assert!(set.contains("alpha"));
                assert!(set.contains("beta"));
            }
            other => panic!("expected AmbiguousLabel, got {other:?}"),
        }
    }

    #[test]
    fn select_prefers_instance_id_over_label_when_both_match() {
        let reg = BrowserRegistry::new();
        reg.insert(fake_client("alpha", "alpha"));
        reg.insert(fake_client("beta", "alpha"));
        // Even though "alpha" also occurs as label on beta, the
        // exact instance_id match wins so the user always gets the
        // browser they pointed at directly.
        let picked = reg.select(Some("alpha")).expect("instance id wins");
        assert_eq!(picked.id, BrowserId("alpha".into()));
    }

    #[test]
    fn select_ignores_empty_labels() {
        let reg = BrowserRegistry::new();
        reg.insert(fake_client("alpha", ""));
        reg.insert(fake_client("beta", ""));
        match reg.select(Some("")) {
            Err(SelectError::MultipleBrowsersOnline) => {}
            other => panic!("expected MultipleBrowsersOnline for empty needle, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn select_with_connect_wait_times_out_when_no_browser_arrives() {
        let reg = BrowserRegistry::new();
        let started = Instant::now();
        match reg
            .select_with_connect_wait(None, Duration::from_millis(120))
            .await
        {
            Err(SelectError::NoBrowserConnected) => {}
            other => panic!("expected NoBrowserConnected, got {other:?}"),
        }
        assert!(
            started.elapsed() >= Duration::from_millis(100),
            "should wait before failing"
        );
    }

    #[tokio::test]
    async fn select_with_connect_wait_succeeds_when_browser_registers_late() {
        let reg = std::sync::Arc::new(BrowserRegistry::new());
        let reg_bg = reg.clone();
        let waiter = tokio::spawn(async move {
            reg_bg
                .select_with_connect_wait(None, Duration::from_millis(500))
                .await
        });
        tokio::time::sleep(Duration::from_millis(80)).await;
        reg.insert(fake_client("late", ""));
        let picked = waiter.await.expect("join").expect("browser should appear");
        assert_eq!(picked.id, BrowserId("late".into()));
    }

    #[tokio::test]
    async fn select_with_connect_wait_does_not_wait_on_multiple_browsers() {
        let reg = BrowserRegistry::new();
        reg.insert(fake_client("a", ""));
        reg.insert(fake_client("b", ""));
        let started = Instant::now();
        match reg
            .select_with_connect_wait(None, Duration::from_secs(1))
            .await
        {
            Err(SelectError::MultipleBrowsersOnline) => {}
            other => panic!("expected MultipleBrowsersOnline, got {other:?}"),
        }
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "ambiguous selection should fail immediately"
        );
    }

    #[tokio::test]
    async fn select_with_connect_wait_waits_for_requested_instance_id() {
        let reg = std::sync::Arc::new(BrowserRegistry::new());
        let reg_bg = reg.clone();
        let waiter = tokio::spawn(async move {
            reg_bg
                .select_with_connect_wait(Some("target"), Duration::from_millis(500))
                .await
        });
        tokio::time::sleep(Duration::from_millis(80)).await;
        reg.insert(fake_client("target", "Work"));
        reg.insert(fake_client("other", "Work"));
        let picked = waiter.await.expect("join").expect("target should appear");
        assert_eq!(picked.id, BrowserId("target".into()));
    }

    #[tokio::test]
    async fn select_with_connect_wait_does_not_wait_on_not_found_when_browsers_online() {
        let reg = BrowserRegistry::new();
        reg.insert(fake_client("alpha", "Personal"));
        let started = Instant::now();
        match reg
            .select_with_connect_wait(Some("missing"), Duration::from_secs(1))
            .await
        {
            Err(SelectError::NotFound) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "unknown selector with browsers online should fail immediately"
        );
    }

    #[tokio::test]
    async fn wait_for_any_connected_returns_when_browser_registers_late() {
        let reg = std::sync::Arc::new(BrowserRegistry::new());
        let reg_bg = reg.clone();
        let waiter = tokio::spawn(async move {
            reg_bg
                .wait_for_any_connected(Duration::from_millis(500))
                .await;
        });
        tokio::time::sleep(Duration::from_millis(80)).await;
        reg.insert(fake_client("late", ""));
        waiter.await.expect("join");
        assert_eq!(reg.len(), 1);
    }

    #[tokio::test]
    async fn wait_for_any_connected_skips_when_already_populated() {
        let reg = BrowserRegistry::new();
        reg.insert(fake_client("a", ""));
        let started = Instant::now();
        reg.wait_for_any_connected(Duration::from_secs(1)).await;
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "should return immediately when browsers already connected"
        );
    }
}
