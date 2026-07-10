//! M10.4: end-to-end coverage for the daemon WS handshake's
//! version-compatibility decision tree (Reject / Skew / Ok).

use std::path::PathBuf;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::{HandshakeParams, HandshakeResult, StatusResult};
use bsk_protocol::{BrowserPeerInfo, ErrorCode, Method, RequestFrame, ResponseBody, ResponseFrame};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

const TEST_EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

fn tempfile_path(prefix: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    let mut rng = rand::thread_rng();
    let suffix: String = (0..8)
        .map(|_| char::from_digit(rng.gen_range(0..16), 16).unwrap())
        .collect();
    p.push(format!("{prefix}-{}-{suffix}.sock", std::process::id()));
    p
}

async fn spawn_daemon() -> (daemon::DaemonHandle, PathBuf) {
    let port = 0;

    let config = DaemonConfig::new(port);
    let sock = tempfile_path("bsk-test-handshake");
    let handle = daemon::run(config, Some(sock.clone())).await.unwrap();
    (handle, sock)
}

async fn open_ws(
    addr: std::net::SocketAddr,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let origin = format!("chrome-extension://{TEST_EXT_ID}");
    let url = format!("ws://{addr}/");
    let req = Request::builder()
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
    let (ws, _resp) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws
}

async fn send_handshake(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    protocol_version: &str,
    app_version: &str,
) -> ResponseFrame {
    send_handshake_with_floors(ws, protocol_version, app_version, None, None).await
}

async fn send_handshake_with_floors(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    protocol_version: &str,
    app_version: &str,
    peer_min_compatible_peer: Option<&str>,
    peer_min_compatible_protocol: Option<&str>,
) -> ResponseFrame {
    let params = HandshakeParams {
        client: "browser-skill-extension".into(),
        version: app_version.parse().unwrap(),
        protocol_version: protocol_version.into(),
        instance_id: TEST_EXT_ID.into(),
        browser: BrowserPeerInfo {
            name: "chrome".into(),
            version: "131.0".into(),
        },
        label: "Test".into(),
        min_compatible_peer: peer_min_compatible_peer.map(|s| s.parse().unwrap()),
        min_compatible_protocol: peer_min_compatible_protocol.map(String::from),
    };
    let req = RequestFrame {
        id: "hs".into(),
        method: Method::SystemHandshake,
        params: Some(serde_json::to_value(params).unwrap()),
    };
    ws.send(Message::Text(serde_json::to_string(&req).unwrap()))
        .await
        .unwrap();
    let resp = ws.next().await.unwrap().unwrap();
    let text = match resp {
        Message::Text(t) => t,
        Message::Close(_) => panic!("connection closed before reply"),
        other => panic!("unexpected ws frame {other:?}"),
    };
    serde_json::from_str(&text).unwrap()
}

#[tokio::test]
async fn handshake_ok_when_protocol_matches() {
    let (handle, _sock) = spawn_daemon().await;
    let mut ws = open_ws(handle.ws_addr()).await;
    let resp = send_handshake(&mut ws, "1.0", env!("CARGO_PKG_VERSION")).await;
    let result: HandshakeResult = match resp.body {
        ResponseBody::Ok(v) => serde_json::from_value(v).unwrap(),
        ResponseBody::Err(e) => panic!("expected ok handshake, got {e:?}"),
    };
    assert_eq!(result.protocol_version, "1.0");
    assert_eq!(
        result
            .min_compatible_peer
            .as_ref()
            .map(ToString::to_string)
            .as_deref(),
        Some("0.0.0")
    );
    assert_eq!(
        result.min_compatible_protocol.as_deref(),
        Some("1.0"),
        "daemon must advertise protocol floor for new extensions"
    );
    handle.shutdown().await;
}

#[tokio::test]
async fn handshake_ok_when_app_versions_differ_but_protocol_matches() {
    let (handle, _sock) = spawn_daemon().await;
    let mut ws = open_ws(handle.ws_addr()).await;
    let resp =
        send_handshake_with_floors(&mut ws, "1.0", "9.9.9", Some("0.0.0"), Some("1.0")).await;
    match resp.body {
        ResponseBody::Ok(_) => {}
        other => panic!("expected ok when protocol matches, got {other:?}"),
    }
    handle.shutdown().await;
}

#[tokio::test]
async fn handshake_skew_when_protocol_minor_differs() {
    let (handle, _sock) = spawn_daemon().await;
    let mut ws = open_ws(handle.ws_addr()).await;
    let resp = send_handshake_with_floors(
        &mut ws,
        "1.1",
        env!("CARGO_PKG_VERSION"),
        Some("0.0.0"),
        Some("1.0"),
    )
    .await;
    match resp.body {
        ResponseBody::Ok(_) => {}
        other => panic!("minor protocol drift should warn-but-allow, got {other:?}"),
    }
    let state = handle.state();
    let client = state
        .browsers
        .get(&bsk::daemon::browsers::BrowserId(TEST_EXT_ID.into()))
        .expect("browser registered");
    assert!(client.version_skew);
    handle.shutdown().await;
}

#[tokio::test]
async fn handshake_rejected_on_protocol_major_mismatch() {
    let (handle, _sock) = spawn_daemon().await;
    let mut ws = open_ws(handle.ws_addr()).await;
    let resp = send_handshake(&mut ws, "2.0", env!("CARGO_PKG_VERSION")).await;
    match resp.body {
        ResponseBody::Err(e) => {
            assert_eq!(e.code, ErrorCode::VersionTooOld);
            assert!(e.message.contains("protocol major mismatch"));
            assert!(e.data.is_some(), "reject must carry structured data");
        }
        other => panic!("expected reject, got {other:?}"),
    }
    handle.shutdown().await;
}

#[tokio::test]
async fn handshake_rejected_when_peer_protocol_major_is_below_daemon() {
    // Protocol "0.9" is below daemon major 1 — rejects before minor/floor checks.
    let (handle, _sock) = spawn_daemon().await;
    let mut ws = open_ws(handle.ws_addr()).await;
    let resp = send_handshake(&mut ws, "0.9", env!("CARGO_PKG_VERSION")).await;
    match resp.body {
        ResponseBody::Err(e) => {
            assert_eq!(e.code, ErrorCode::VersionTooOld);
            assert!(
                e.message.contains("protocol major mismatch"),
                "message: {}",
                e.message
            );
        }
        other => panic!("expected reject, got {other:?}"),
    }
    handle.shutdown().await;
}

#[tokio::test]
async fn handshake_legacy_ext_without_protocol_floor_still_ok() {
    let (handle, _sock) = spawn_daemon().await;
    let mut ws = open_ws(handle.ws_addr()).await;
    let resp = send_handshake_with_floors(
        &mut ws,
        "1.0",
        env!("CARGO_PKG_VERSION"),
        Some("0.1.0"),
        None,
    )
    .await;
    match resp.body {
        ResponseBody::Ok(_) => {}
        other => panic!("legacy ext (no min_compatible_protocol) should connect, got {other:?}"),
    }
    handle.shutdown().await;
}

#[tokio::test]
async fn status_surfaces_version_skew_for_skewed_browser() {
    use std::sync::Mutex;
    use tokio::sync::mpsc;
    let (handle, sock) = spawn_daemon().await;
    let state = handle.state();
    let (tx, _rx) = mpsc::unbounded_channel::<bsk_protocol::Frame>();
    let client = std::sync::Arc::new(bsk::daemon::browsers::BrowserClient {
        id: bsk::daemon::browsers::BrowserId("skew-only-test".into()),
        browser_name: "chrome".into(),
        browser_version: "131.0".into(),
        extension_version: "9.9.9".into(),
        extension_protocol_version: "1.1".into(),
        label: "Older".into(),
        sink: bsk::daemon::browsers::BrowserSink { tx },
        pending: Mutex::new(bsk::daemon::browsers::Pending::default()),
        generation: bsk::daemon::browsers::next_browser_generation(),
        connected_at_ms: 0,
        version_skew: true,
    });
    state.browsers.insert(client);

    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let status: StatusResult = ipc
        .call::<(), _>(
            "status-1",
            Method::SystemStatus,
            None,
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .unwrap();
    let skew = status
        .version_skew_browsers
        .iter()
        .find(|s| s.instance_id == "skew-only-test")
        .expect("status must list our skew client");
    assert_eq!(skew.client_protocol_version, "1.1");
    assert_eq!(skew.server_protocol_version, "1.0");
    assert_eq!(skew.client_version, "9.9.9");
    let entry = status
        .browsers
        .iter()
        .find(|b| b.instance_id == "skew-only-test")
        .expect("status must include the skewed browser");
    assert!(entry.version_skew, "BrowserStatusEntry must carry the flag");
    handle.shutdown().await;
}

#[tokio::test]
async fn handshake_rejects_when_local_below_peer_min_compatible_protocol() {
    let (handle, _sock) = spawn_daemon().await;
    let mut ws = open_ws(handle.ws_addr()).await;
    let resp = send_handshake_with_floors(
        &mut ws,
        "1.0",
        env!("CARGO_PKG_VERSION"),
        Some("0.0.0"),
        Some("99.0.0"),
    )
    .await;
    match resp.body {
        ResponseBody::Err(e) => {
            assert_eq!(e.code, ErrorCode::VersionTooOld);
            assert!(
                e.message.contains("local protocol")
                    && e.message.contains("min_compatible_protocol"),
                "reject reason: {}",
                e.message
            );
        }
        other => panic!("expected reject, got {other:?}"),
    }
    handle.shutdown().await;
}
