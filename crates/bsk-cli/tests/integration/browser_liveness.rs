//! Integration coverage for the daemon's browser-liveness reaper
//! (`spawn_browser_liveness_reaper`).
//!
//! These drive the *task* — not just the `stale_browsers` predicate —
//! by spinning up a real daemon with a sub-second liveness window and
//! observing that a silent, heartbeat-capable browser (and its sessions)
//! get dropped, while a legacy browser that never heartbeated is left
//! alone (backward-compat guard).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use bsk::daemon::browsers::{
    BrowserClient, BrowserId, BrowserSink, Liveness, Pending, next_browser_generation,
};
use bsk::daemon::sessions::{Session, SessionId};
use bsk::daemon::{self, DaemonConfig};
use tokio::sync::mpsc;

/// Build a registry client. `heartbeat_seen` opts it in to reaping and
/// `idle_secs` back-dates its `last_seen` so it looks silent immediately.
fn fake_client(id: &str, heartbeat_seen: bool, idle_secs: u64) -> std::sync::Arc<BrowserClient> {
    let (tx, _rx) = mpsc::unbounded_channel::<bsk_protocol::Frame>();
    let liveness = Liveness::default();
    if heartbeat_seen {
        liveness.mark_heartbeat_seen();
    }
    liveness.__backdate_for_tests(Duration::from_secs(idle_secs));
    std::sync::Arc::new(BrowserClient {
        id: BrowserId(id.into()),
        browser_name: "chrome".into(),
        browser_version: "131.0".into(),
        extension_version: "0.1.4".into(),
        extension_protocol_version: bsk::daemon::state::PROTOCOL_VERSION.into(),
        label: String::new(),
        sink: BrowserSink { tx },
        pending: Mutex::new(Pending::default()),
        generation: next_browser_generation(),
        connected_at_ms: 0,
        version_skew: false,
        liveness,
    })
}

fn fake_session(session_id: &str, browser_id: &str) -> Session {
    Session {
        controller: None,
        interaction: None,

        id: SessionId(session_id.into()),
        browser_id: BrowserId(browser_id.into()),
        agent_window_id: None,
        created_at_ms: 0,
    }
}

async fn spawn_reaping_daemon() -> (daemon::DaemonHandle, tempfile::TempDir) {
    // Tiny window so the reaper acts within the test's lifetime.
    let temp = tempfile::tempdir().unwrap();
    let config = DaemonConfig::new(0)
        .with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal)
        .with_browser_liveness(Duration::from_millis(150), Duration::from_millis(25));
    let handle = daemon::run_with_state(
        std::sync::Arc::new(bsk::daemon::DaemonState::new_isolated(config, temp.path())),
        None,
    )
    .await
    .unwrap();
    (handle, temp)
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
    let (handle, _temp) = spawn_reaping_daemon().await;
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
    let (handle, _temp) = spawn_reaping_daemon().await;
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

#[tokio::test]
async fn reaper_eviction_closes_live_ws_connection_and_settles_pending_waiters() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let (handle, _temp) = spawn_reaping_daemon().await;
    let state = handle.state();

    let mut request = format!("ws://{}/", handle.ws_addr())
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
            .parse()
            .unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    ws.send(Message::Text(
        serde_json::json!({
            "id": "hs-1",
            "method": "system.handshake",
            "params": {
                "client": bsk_protocol::EXTENSION_CLIENT_ID,
                "version": "0.5.0",
                "protocol_version": bsk::daemon::state::PROTOCOL_VERSION,
                "instance_id": "deadpeer",
                "label": "Silent peer",
                "browser": { "name": "chrome", "version": "136.0" }
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let hs_reply = ws.next().await.unwrap().unwrap();
    assert!(matches!(hs_reply, Message::Text(_)));

    // Opt this connection into liveness reaping with a heartbeat, then go silent.
    ws.send(Message::Text(
        serde_json::json!({ "event": "system.heartbeat", "payload": {} }).to_string(),
    ))
    .await
    .unwrap();
    assert!(
        wait_until(
            || state
                .browsers
                .get(&BrowserId("deadpeer".into()))
                .is_some_and(|c| c.has_heartbeat()),
            Duration::from_secs(2),
        )
        .await,
        "heartbeat must be observed before going silent"
    );

    // Register a pending RPC waiter on the live client; eviction must wake it
    // immediately instead of letting callers hang until timeout.
    let client = state
        .browsers
        .get(&BrowserId("deadpeer".into()))
        .expect("connected browser");
    let waiter = client
        .pending
        .lock()
        .unwrap()
        .register("inflight-req".into())
        .unwrap();
    drop(client);

    // Waiter settles immediately when the reaper calls `client.close()`.
    assert!(
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("pending waiter must settle on eviction")
            .is_err(),
        "eviction must close pending waiters with transport closed"
    );

    // And the server-side `drive_connection` task exits and closes the real WS!
    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(msg) = ws.next().await {
            match msg {
                Ok(Message::Close(_)) | Err(_) => return true,
                Ok(_) => {}
            }
        }
        true
    })
    .await
    .unwrap_or(false);
    assert!(
        closed,
        "reaper eviction must wake drive_connection and close the underlying WS"
    );

    handle.shutdown().await;
}

#[tokio::test]
async fn ws_shutdown_cancels_inflight_handshake_and_prevents_late_registration() {
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let (handle, _temp) = spawn_reaping_daemon().await;
    let state = handle.state();

    // Complete TCP + HTTP WS upgrade with a valid Origin, then pause BEFORE
    // sending `system.handshake` so the server task is parked mid-handshake.
    let mut request = format!("ws://{}/", handle.ws_addr())
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .parse()
            .unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();

    // Give the server task a moment to enter the post-upgrade handshake wait.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Shut down the daemon while the socket is still mid-handshake: shutdown
    // must abort the in-flight task promptly (well under the 5 s handshake
    // timeout) and must not allow a late `system.handshake` to register after
    // `WsHandle` exits.
    let started = Instant::now();
    let shutdown_task = tokio::spawn(async move { handle.shutdown().await });
    let _ = ws
        .send(Message::Text(
            serde_json::json!({
                "id": "late-hs",
                "method": "system.handshake",
                "params": {
                    "instance_id": "latepeer",
                    "version": "0.1.0",
                    "protocol_version": bsk_protocol::PROTOCOL_VERSION,
                    "browser": { "name": "Chrome", "version": "130" }
                }
            })
            .to_string(),
        ))
        .await;
    tokio::time::timeout(Duration::from_secs(2), shutdown_task)
        .await
        .expect("daemon shutdown must cancel in-flight WS handshakes promptly")
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "shutdown waited too long for in-flight WS handshake: {:?}",
        started.elapsed()
    );
    assert!(
        state.browsers.snapshot().is_empty(),
        "no browser may remain registered after WsHandle shutdown returns"
    );
}
