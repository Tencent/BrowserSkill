//! Integration coverage for the daemon's browser-liveness reaper
//! (`spawn_browser_liveness_reaper`).
//!
//! These drive the *task* — not just the `stale_browsers` predicate —
//! by spinning up a real daemon with a sub-second liveness window and
//! observing that a silent, heartbeat-capable browser (and its sessions)
//! get dropped, while a legacy browser that never heartbeated is left
//! alone (backward-compat guard).

use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use bsk::daemon::browsers::{
    BrowserClient, BrowserId, BrowserSink, Pending, next_browser_generation,
};
use bsk::daemon::sessions::{Session, SessionId};
use bsk::daemon::{self, DaemonConfig};
use tokio::sync::mpsc;

/// Build a registry client. `heartbeat_seen` opts it in to reaping and
/// `idle_secs` back-dates its `last_seen` so it looks silent immediately.
fn fake_client(id: &str, heartbeat_seen: bool, idle_secs: u64) -> std::sync::Arc<BrowserClient> {
    let (tx, _rx) = mpsc::unbounded_channel::<bsk_protocol::Frame>();
    std::sync::Arc::new(BrowserClient {
        id: BrowserId(id.into()),
        browser_name: "chrome".into(),
        browser_version: "131.0".into(),
        extension_version: "0.1.4".into(),
        extension_protocol_version: "1.0".into(),
        label: String::new(),
        sink: BrowserSink { tx },
        pending: Mutex::new(Pending::default()),
        generation: next_browser_generation(),
        connected_at_ms: 0,
        version_skew: false,
        last_seen: Mutex::new(Instant::now() - Duration::from_secs(idle_secs)),
        heartbeat_seen: AtomicBool::new(heartbeat_seen),
    })
}

fn fake_session(session_id: &str, browser_id: &str) -> Session {
    Session {
        id: SessionId(session_id.into()),
        browser_id: BrowserId(browser_id.into()),
        agent_window_id: None,
        created_at_ms: 0,
    }
}

async fn spawn_reaping_daemon() -> daemon::DaemonHandle {
    // Tiny window so the reaper acts within the test's lifetime.
    let config = DaemonConfig::new(0)
        .with_browser_liveness(Duration::from_millis(150), Duration::from_millis(25));
    daemon::run(config, None).await.unwrap()
}

async fn wait_until<F: Fn() -> bool>(pred: F, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if pred() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    pred()
}

#[tokio::test]
async fn reaper_drops_silent_heartbeat_browser_and_purges_its_sessions() {
    let handle = spawn_reaping_daemon().await;
    let state = handle.state();

    state.browsers.insert(fake_client("hb", true, 10));
    state.sessions.insert(fake_session("sess", "hb"));
    assert_eq!(state.browsers.len(), 1);
    assert_eq!(state.sessions.count_for_browser(&BrowserId("hb".into())), 1);

    let dropped = wait_until(
        || state.browsers.get(&BrowserId("hb".into())).is_none(),
        Duration::from_secs(2),
    )
    .await;
    assert!(dropped, "silent heartbeat-capable browser should be reaped");

    // The reaper also tears down the browser's sessions.
    assert!(
        wait_until(|| state.sessions.is_empty(), Duration::from_secs(1)).await,
        "reaping a browser must purge its sessions"
    );

    handle.shutdown().await;
}

#[tokio::test]
async fn reaper_leaves_legacy_browser_without_heartbeat_alone() {
    let handle = spawn_reaping_daemon().await;
    let state = handle.state();

    // Silent far past the window, but never heartbeated → must survive.
    state.browsers.insert(fake_client("legacy", false, 600));

    // Give the reaper several scan cycles to (wrongly) act.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        state.browsers.get(&BrowserId("legacy".into())).is_some(),
        "a browser that never heartbeated must not be reaped on silence"
    );

    handle.shutdown().await;
}
