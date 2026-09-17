//! Live end-to-end proof that the daemon's local WS server pins itself to
//! the first connecting extension origin and rejects any other one, closing
//! the gap `daemon::ws::origin_allowed`'s own doc comment used to describe:
//! any extension-shaped origin (not just the real BrowserSkill extension)
//! passed that check.

use std::sync::Arc;
use std::time::Duration;

use bsk::daemon::extension_pin::ExtensionPinStore;
use bsk::daemon::ws::WsServer;
use bsk::daemon::{DaemonConfig, DaemonState};
use futures_util::StreamExt;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const EXT_A: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EXT_B: &str = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// Complete the WS opening handshake (which only checks `origin_allowed`'s
/// *shape* rule) and then read the next frame, which is where the pin check
/// actually rejects a mismatched origin -- as a server-initiated Close, not
/// as an HTTP-level upgrade failure. `Ok(true)` means the server accepted
/// the origin (kept the socket open long enough to matter); `Ok(false)`
/// means it closed the connection right after upgrade.
async fn try_connect(addr: std::net::SocketAddr, origin: &str) -> bool {
    let mut request = format!("ws://{addr}/").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", origin.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("ws opening handshake (shape check) should always succeed for a valid origin");
    match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
        // Server closed the socket right after upgrade: rejected.
        Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))) => false,
        Ok(Some(Err(_))) | Ok(None) => false,
        // Anything else (no immediate close, e.g. the connection stays open
        // waiting for our system.handshake) means the pin check let it through.
        Ok(Some(Ok(_))) => true,
        Err(_) => true,
    }
}

#[tokio::test]
async fn second_different_extension_origin_is_rejected_after_the_first_pins() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let temp = tempfile::tempdir().unwrap();
        let mut state = DaemonState::new(DaemonConfig::new(0));
        state.extension_pin = Arc::new(ExtensionPinStore::new(Some(temp.path().to_path_buf())));
        let state = Arc::new(state);
        let server = WsServer::new(Arc::clone(&state))
            .bind("127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();

        // Nothing pinned yet: EXT_A completes the upgrade and becomes the pin.
        assert!(
            try_connect(server.local_addr, EXT_A).await,
            "first extension (unpinned state) should be accepted"
        );
        assert_eq!(
            state.extension_pin.get().unwrap().as_deref(),
            Some(EXT_A),
            "the first successful connection must have pinned its origin"
        );

        // EXT_B is shaped exactly like a valid extension origin -- before the
        // fix, `origin_allowed` alone gated this and EXT_B would also be
        // accepted. It must now be rejected because it isn't the pinned one.
        assert!(
            !try_connect(server.local_addr, EXT_B).await,
            "a second, different extension origin must be rejected once a pin exists"
        );

        // The legitimate, pinned extension can still reconnect freely.
        assert!(
            try_connect(server.local_addr, EXT_A).await,
            "the pinned extension must still be able to reconnect"
        );
    })
    .await
    .expect("test timed out");
}
