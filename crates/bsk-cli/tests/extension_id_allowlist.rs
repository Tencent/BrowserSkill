//! Integration: a pinned extension allow-list narrows the local
//! WebSocket endpoint from "any well-formed `chrome-extension://`
//! origin" to exactly the ids the operator listed.
//!
//! The Origin gate is a shape check, not an identity check: a side-loaded
//! extension has a perfectly valid MV3 origin, so without a pinned list it
//! only has to guess the loopback port to reach the daemon (review M4/M5
//! I8). These tests pin the behaviour of the fix and of the unpinned
//! default it must not regress.

use bsk::daemon::{self, DaemonConfig};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;

/// 32 characters drawn from `a`–`p`, the shape Chrome gives MV3 ids.
const ALLOWED_ID: &str = "abcdefghijklmnopabcdefghijklmnop";
/// Same shape, different id — stands in for a side-loaded extension.
const OTHER_ID: &str = "ponmlkjihgfedcbaponmlkjihgfedcba";

async fn spawn_pinned_daemon() -> daemon::DaemonHandle {
    let config = DaemonConfig::new(0).with_allowed_extension_ids([ALLOWED_ID]);
    daemon::run(config, None).await.unwrap()
}

/// Attempt a raw WebSocket upgrade with `origin` and report whether the
/// daemon let it through. Returns `true` when the upgrade succeeded.
async fn upgrade_accepted(addr: std::net::SocketAddr, origin: &str) -> bool {
    let url = format!("ws://{addr}/");
    let request = Request::builder()
        .method("GET")
        .uri(&url)
        .header("Host", addr.to_string())
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header("Origin", origin)
        .body(())
        .unwrap();
    tokio_tungstenite::connect_async(request).await.is_ok()
}

#[tokio::test]
async fn pinned_allowlist_admits_the_listed_extension() {
    let handle = spawn_pinned_daemon().await;
    let origin = format!("chrome-extension://{ALLOWED_ID}");
    assert!(
        upgrade_accepted(handle.ws_addr(), &origin).await,
        "the pinned extension must still be able to connect"
    );
    handle.shutdown().await;
}

#[tokio::test]
async fn pinned_allowlist_rejects_a_different_well_formed_extension() {
    let handle = spawn_pinned_daemon().await;
    let origin = format!("chrome-extension://{OTHER_ID}");
    assert!(
        !upgrade_accepted(handle.ws_addr(), &origin).await,
        "an extension whose id is not pinned must not reach the daemon"
    );
    handle.shutdown().await;
}

#[tokio::test]
async fn pinned_allowlist_still_rejects_non_extension_origins() {
    let handle = spawn_pinned_daemon().await;
    assert!(!upgrade_accepted(handle.ws_addr(), "https://evil.example").await);
    handle.shutdown().await;
}

#[tokio::test]
async fn unpinned_daemon_keeps_accepting_any_extension_origin() {
    // Regression guard: the default must stay permissive, otherwise
    // upgrading the CLI would strand every existing installation until
    // the operator discovers the new flag.
    let handle = daemon::run(DaemonConfig::new(0), None).await.unwrap();
    let origin = format!("chrome-extension://{OTHER_ID}");
    assert!(
        upgrade_accepted(handle.ws_addr(), &origin).await,
        "an unpinned daemon must keep the historic behaviour"
    );
    handle.shutdown().await;
}
