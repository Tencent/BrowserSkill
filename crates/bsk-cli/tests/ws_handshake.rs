//! M4.4 integration: spin up the minimal daemon, connect a fake extension
//! over WebSocket, verify the Origin allow-list and `system.handshake`
//! registration logic.

use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::{BrowserPeerInfo, Method, RequestFrame, ResponseBody, ResponseFrame};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

pub const TEST_EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop"; // 32 chars in a-p

pub async fn spawn_daemon() -> daemon::DaemonHandle {
    // Bind to any free TCP port.
    let port = 0;

    let config = DaemonConfig::new(port);
    daemon::run(config, None).await.unwrap()
}

pub async fn connect_ext(
    addr: std::net::SocketAddr,
    origin: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
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
    let (ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .expect("ws connect");
    ws
}

pub async fn send_handshake(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    instance_id: &str,
) -> HandshakeResult {
    let params = HandshakeParams {
        client: "browser-skill-extension".into(),
        version: "0.1.0-dev.0".parse().unwrap(),
        protocol_version: "1.0".into(),
        instance_id: instance_id.into(),
        browser: BrowserPeerInfo {
            name: "chrome".into(),
            version: "131.0".into(),
        },
        min_compatible_peer: Some("0.1.0-dev.0".parse().unwrap()),
        min_compatible_protocol: Some("1.0".into()),
        label: "Test Chrome".into(),
    };
    let req = RequestFrame {
        id: "hs-1".into(),
        method: Method::SystemHandshake,
        params: Some(serde_json::to_value(params).unwrap()),
    };
    ws.send(Message::Text(serde_json::to_string(&req).unwrap()))
        .await
        .unwrap();

    let msg = ws.next().await.unwrap().unwrap();
    let text = match msg {
        Message::Text(t) => t,
        _ => panic!("expected text frame"),
    };
    let resp: ResponseFrame = serde_json::from_str(&text).unwrap();
    match resp.body {
        ResponseBody::Ok(v) => serde_json::from_value(v).unwrap(),
        ResponseBody::Err(e) => panic!("handshake rejected: {e:?}"),
    }
}

#[tokio::test]
async fn ws_handshake_registers_browser_in_state() {
    let handle = spawn_daemon().await;
    let origin = format!("chrome-extension://{TEST_EXT_ID}");
    let mut ws = connect_ext(handle.ws_addr(), &origin).await;
    let result = send_handshake(&mut ws, TEST_EXT_ID).await;
    assert_eq!(result.server, "browser-skill-daemon");
    assert_eq!(result.protocol_version, "1.0");

    let state = handle.state();
    let browsers = state.browsers.snapshot();
    assert_eq!(browsers.len(), 1);
    assert_eq!(browsers[0].id.0, TEST_EXT_ID);
    assert_eq!(browsers[0].browser_name, "chrome");
    assert_eq!(browsers[0].label, "Test Chrome");

    let _ = ws.close(None).await;
    handle.shutdown().await;
}

#[tokio::test]
async fn ws_handshake_rejects_disallowed_origin() {
    let handle = spawn_daemon().await;
    let bad_origin = "https://evil.example";
    let url = format!("ws://{}/", handle.ws_addr());
    let req = Request::builder()
        .method("GET")
        .uri(&url)
        .header("Host", handle.ws_addr().to_string())
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header("Origin", bad_origin)
        .body(())
        .unwrap();
    let res = tokio_tungstenite::connect_async(req).await;
    assert!(res.is_err(), "expected connect to fail (got Ok)");
    handle.shutdown().await;
}

#[tokio::test]
async fn ws_handshake_first_frame_timeout_closes_silent_client() {
    let handle = spawn_daemon().await;
    let origin = format!("chrome-extension://{TEST_EXT_ID}");
    let mut ws = connect_ext(handle.ws_addr(), &origin).await;
    // Don't send anything. The daemon must close us within ~5s rather
    // than parking the task forever (review M4/M5 round 3 I-R3-1).
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut received_close = false;
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(500), ws.next()).await {
            Ok(Some(Ok(Message::Close(_)))) => {
                received_close = true;
                break;
            }
            Ok(None) | Err(_) => {
                continue;
            }
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(_))) => {
                received_close = true;
                break;
            }
        }
    }
    assert!(
        received_close,
        "daemon should close a silent client within the handshake timeout"
    );
    handle.shutdown().await;
}

#[tokio::test]
async fn ws_kicks_non_handshake_first_frame() {
    let handle = spawn_daemon().await;
    let origin = format!("chrome-extension://{TEST_EXT_ID}");
    let mut ws = connect_ext(handle.ws_addr(), &origin).await;
    let bad = RequestFrame {
        id: "1".into(),
        method: Method::ToolTabList,
        params: Some(serde_json::json!({"session_id":"foo"})),
    };
    ws.send(Message::Text(serde_json::to_string(&bad).unwrap()))
        .await
        .unwrap();
    let resp = ws.next().await.unwrap().unwrap();
    let text = match resp {
        Message::Text(t) => t,
        other => panic!("expected text frame, got {other:?}"),
    };
    let resp: ResponseFrame = serde_json::from_str(&text).unwrap();
    match resp.body {
        ResponseBody::Err(e) => {
            assert_eq!(e.code, bsk_protocol::ErrorCode::ProtocolError);
        }
        _ => panic!("expected error body"),
    }
    handle.shutdown().await;
}
