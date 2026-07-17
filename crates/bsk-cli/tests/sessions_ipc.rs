//! M5.1 integration: spin up the minimal daemon + IPC, connect a fake
//! extension over WebSocket, and exercise the session.start/stop round-
//! trip through `IpcClient`.

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::{HandshakeParams, HandshakeResult, StatusResult};
use bsk_protocol::tools::{SessionStartParams, SessionStartResult, SessionStopParams};
use bsk_protocol::{BrowserPeerInfo, Frame, Method, RequestFrame, ResponseBody, ResponseFrame};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

use support::{wait_for_browser_count, wait_for_no_sessions, wait_for_session_count};

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
    spawn_daemon_with_connect_wait(bsk::daemon::browsers::EXTENSION_CONNECT_WAIT).await
}

async fn spawn_daemon_with_connect_wait(connect_wait: Duration) -> (daemon::DaemonHandle, PathBuf) {
    let port = 0;

    let config = DaemonConfig::new(port).with_extension_connect_wait(connect_wait);
    let sock = tempfile_path("bsk-test-ipc");
    let handle = daemon::run(config, Some(sock.clone())).await.unwrap();
    (handle, sock)
}

async fn spawn_daemon_with_session_idle(session_idle: Duration) -> (daemon::DaemonHandle, PathBuf) {
    let port = 0;

    let mut config = DaemonConfig::new(port);
    config.session_idle = session_idle;
    let sock = tempfile_path("bsk-test-ipc");
    let handle = daemon::run(config, Some(sock.clone())).await.unwrap();
    (handle, sock)
}

async fn connect_ext(
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

async fn handshake_as_ext(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> HandshakeResult {
    let params = HandshakeParams {
        client: "browser-skill-extension".into(),
        version: "0.1.0-dev.0".parse().unwrap(),
        protocol_version: "1.0".into(),
        instance_id: TEST_EXT_ID.into(),
        browser: BrowserPeerInfo {
            name: "chrome".into(),
            version: "131.0".into(),
        },
        min_compatible_peer: Some("0.1.0-dev.0".parse().unwrap()),
        min_compatible_protocol: Some("1.0".into()),
        label: "Test".into(),
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
        _ => panic!(),
    };
    let resp: ResponseFrame = serde_json::from_str(&text).unwrap();
    match resp.body {
        ResponseBody::Ok(v) => serde_json::from_value(v).unwrap(),
        ResponseBody::Err(e) => panic!("handshake rejected: {e:?}"),
    }
}

#[tokio::test]
async fn session_start_stop_round_trip_via_ipc() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    // Spawn a fake extension responder that handles tool.session_start
    // and tool.session_stop. The Arc<Mutex<...>> is necessary because
    // tokio_tungstenite::WebSocketStream is !Sync but the outer task and
    // the IPC client thread both need to drive the same socket.
    let ws = Arc::new(tokio::sync::Mutex::new(ws));
    let ws_clone = Arc::clone(&ws);
    let responder = tokio::spawn(async move {
        loop {
            let next = {
                let mut g = ws_clone.lock().await;
                g.next().await
            };
            let msg = match next {
                Some(Ok(m)) => m,
                _ => break,
            };
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };
            let frame: Frame = serde_json::from_str(&text).unwrap();
            if let Frame::Request(req) = frame {
                let reply = match req.method {
                    Method::ToolSessionStart => {
                        let _: SessionStartParams =
                            serde_json::from_value(req.params.clone().unwrap()).unwrap();
                        let result = SessionStartResult {
                            agent_window_id: Some(4242),
                        };
                        ResponseFrame {
                            id: req.id,
                            body: ResponseBody::Ok(serde_json::to_value(result).unwrap()),
                        }
                    }
                    Method::ToolSessionStop => {
                        let _: SessionStopParams =
                            serde_json::from_value(req.params.clone().unwrap()).unwrap();
                        ResponseFrame {
                            id: req.id,
                            body: ResponseBody::Ok(serde_json::json!({})),
                        }
                    }
                    _ => continue,
                };
                let mut g = ws_clone.lock().await;
                g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                    .await
                    .unwrap();
            }
        }
    });

    let mut ipc = IpcClient::connect(&sock).await.unwrap();

    #[derive(serde::Serialize)]
    struct StartParams {
        browser_instance_id: Option<String>,
    }
    #[derive(serde::Deserialize, Debug)]
    struct StartReply {
        session_id: String,
        browser_instance_id: String,
        agent_window_id: Option<i64>,
    }

    let start: StartReply = ipc
        .call(
            "s-1",
            Method::SessionStart,
            Some(StartParams {
                browser_instance_id: None,
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("session.start returned error");
    assert_eq!(start.session_id.len(), 4);
    assert!(start.session_id.chars().all(|c| c.is_ascii_lowercase()));
    assert_eq!(start.browser_instance_id, TEST_EXT_ID);
    assert_eq!(start.agent_window_id, Some(4242));

    // status should reflect 1 session
    let status: StatusResult = ipc
        .call::<(), _>("s-2", Method::SystemStatus, None, Duration::from_secs(2))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.sessions.len(), 1);
    assert_eq!(status.browsers[0].session_count, 1);

    #[derive(serde::Serialize)]
    struct StopParams {
        session_id: Option<String>,
        all: bool,
    }
    #[derive(serde::Deserialize, Debug)]
    struct StopReply {
        stopped: Vec<String>,
    }
    let stop: StopReply = ipc
        .call(
            "s-3",
            Method::SessionStop,
            Some(StopParams {
                session_id: Some(start.session_id.clone()),
                all: false,
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("session.stop returned error");
    assert_eq!(stop.stopped, vec![start.session_id]);

    let status_after: StatusResult = ipc
        .call::<(), _>("s-4", Method::SystemStatus, None, Duration::from_secs(2))
        .await
        .unwrap()
        .unwrap();
    assert!(status_after.sessions.is_empty());
    assert_eq!(status_after.browsers[0].session_count, 0);

    responder.abort();
    handle.shutdown().await;
}

#[tokio::test]
async fn session_idle_timeout_stops_and_unregisters_session() {
    let (handle, _sock) = spawn_daemon_with_session_idle(Duration::from_millis(50)).await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let state = handle.state();
    let session_id = bsk::daemon::sessions::SessionId("idle".into());
    state.sessions.insert(bsk::daemon::sessions::Session {
        id: session_id.clone(),
        browser_id: bsk::daemon::browsers::BrowserId(TEST_EXT_ID.into()),
        agent_window_id: Some(7),
        created_at_ms: 0,
    });
    state.tool_queues.spawn(session_id);

    let request = tokio::time::timeout(Duration::from_secs(1), ws.next())
        .await
        .expect("idle reaper did not contact extension")
        .expect("extension socket closed")
        .expect("extension socket failed");
    let Message::Text(text) = request else {
        panic!("expected text request");
    };
    let request: RequestFrame = serde_json::from_str(&text).unwrap();
    assert_eq!(request.method, Method::ToolSessionStop);
    ws.send(Message::Text(
        serde_json::to_string(&ResponseFrame {
            id: request.id,
            body: ResponseBody::Ok(
                serde_json::to_value(bsk_protocol::tools::SessionStopResult::default()).unwrap(),
            ),
        })
        .unwrap(),
    ))
    .await
    .unwrap();

    wait_for_no_sessions(&state).await;
    handle.shutdown().await;
}

#[tokio::test]
async fn session_start_errors_without_browser() {
    let (handle, sock) = spawn_daemon_with_connect_wait(Duration::ZERO).await;
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let result: Result<serde_json::Value, bsk_protocol::RpcError> = ipc
        .call::<(), _>("s-1", Method::SessionStart, None, Duration::from_secs(2))
        .await
        .unwrap();
    let err = result.expect_err("expected no_browser_connected error");
    assert_eq!(err.code, bsk_protocol::ErrorCode::NoBrowserConnected);
    handle.shutdown().await;
}

#[tokio::test]
async fn session_start_waits_for_late_extension_handshake() {
    let (handle, sock) = spawn_daemon_with_connect_wait(Duration::from_millis(500)).await;
    let ws_addr = handle.ws_addr();

    let sock_for_ipc = sock.clone();
    let start_task = tokio::spawn(async move {
        let mut ipc = IpcClient::connect(&sock_for_ipc).await.unwrap();
        ipc.call::<(), serde_json::Value>(
            "s-late",
            Method::SessionStart,
            None,
            Duration::from_secs(5),
        )
        .await
        .unwrap()
    });

    let ws = Arc::new(tokio::sync::Mutex::new(connect_ext(ws_addr).await));
    let ws_clone = Arc::clone(&ws);
    let responder = tokio::spawn(async move {
        loop {
            let next = {
                let mut g = ws_clone.lock().await;
                g.next().await
            };
            let msg = match next {
                Some(Ok(m)) => m,
                _ => break,
            };
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };
            let frame: Frame = serde_json::from_str(&text).unwrap();
            let Frame::Request(req) = frame else {
                continue;
            };
            if req.method != Method::ToolSessionStart {
                continue;
            }
            let result = SessionStartResult {
                agent_window_id: Some(4242),
            };
            let resp = Frame::Response(ResponseFrame {
                id: req.id,
                body: ResponseBody::Ok(serde_json::to_value(result).unwrap()),
            });
            let mut g = ws_clone.lock().await;
            g.send(Message::Text(serde_json::to_string(&resp).unwrap()))
                .await
                .unwrap();
            break;
        }
    });

    {
        let mut g = ws.lock().await;
        let _ = handshake_as_ext(&mut g).await;
    }

    start_task
        .await
        .expect("join")
        .expect("session.start should succeed after extension connects");
    responder.abort();
    handle.shutdown().await;
}

/// Connect a second WebSocket extension with a distinct instance id /
/// label / origin so the daemon's registry sees two browsers.
async fn connect_second_ext(
    addr: std::net::SocketAddr,
    instance_id: &str,
    label: &str,
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
        .header(
            "Origin",
            "chrome-extension://abcdefghijklmnoppmnolkjihgfedcba".to_string(),
        )
        .body(())
        .unwrap();
    let (mut b, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    let params = HandshakeParams {
        client: "browser-skill-extension".into(),
        version: "0.1.0-dev.0".parse().unwrap(),
        protocol_version: "1.0".into(),
        instance_id: instance_id.into(),
        browser: BrowserPeerInfo {
            name: "edge".into(),
            version: "130".into(),
        },
        min_compatible_peer: Some("0.1.0-dev.0".parse().unwrap()),
        min_compatible_protocol: Some("1.0".into()),
        label: label.into(),
    };
    let hs = RequestFrame {
        id: "hs".into(),
        method: Method::SystemHandshake,
        params: Some(serde_json::to_value(params).unwrap()),
    };
    b.send(Message::Text(serde_json::to_string(&hs).unwrap()))
        .await
        .unwrap();
    let _ = b.next().await.unwrap();
    b
}

#[tokio::test]
async fn session_start_errors_with_multiple_browsers() {
    let (handle, sock) = spawn_daemon().await;
    let mut a = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut a).await;
    let _b = connect_second_ext(handle.ws_addr(), "second-browser", "Edge").await;
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let result: Result<serde_json::Value, bsk_protocol::RpcError> = ipc
        .call::<(), _>("s-1", Method::SessionStart, None, Duration::from_secs(2))
        .await
        .unwrap();
    let err = result.expect_err("expected multiple_browsers_online");
    assert_eq!(err.code, bsk_protocol::ErrorCode::MultipleBrowsersOnline);
    let data = err
        .data
        .as_ref()
        .expect("multiple_browsers_online must include browser list in error.data");
    let browsers = data
        .get("browsers")
        .and_then(|v| v.as_array())
        .expect("error.data.browsers should be an array");
    assert_eq!(browsers.len(), 2);
    let entries: Vec<bsk_protocol::system::BrowserStatusEntry> = browsers
        .iter()
        .map(|v| serde_json::from_value(v.clone()).unwrap())
        .collect();
    let ids: std::collections::HashSet<&str> =
        entries.iter().map(|e| e.instance_id.as_str()).collect();
    assert!(ids.contains(TEST_EXT_ID));
    assert!(ids.contains("second-browser"));

    handle.shutdown().await;
}

#[tokio::test]
async fn session_start_with_browser_instance_id_picks_target() {
    let (handle, sock) = spawn_daemon().await;
    let mut a = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut a).await;
    let b = connect_second_ext(handle.ws_addr(), "second-browser", "Edge").await;
    // Spawn a fake responder for ext A only — we expect daemon to
    // route session.start to the requested instance id, NOT to ext B.
    let a = Arc::new(tokio::sync::Mutex::new(a));
    let a_clone = Arc::clone(&a);
    let responder = tokio::spawn(async move {
        loop {
            let next = {
                let mut g = a_clone.lock().await;
                g.next().await
            };
            let msg = match next {
                Some(Ok(m)) => m,
                _ => break,
            };
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };
            let frame: Frame = serde_json::from_str(&text).unwrap();
            if let Frame::Request(req) = frame
                && req.method == Method::ToolSessionStart
            {
                let result = SessionStartResult {
                    agent_window_id: Some(123),
                };
                let reply = ResponseFrame {
                    id: req.id,
                    body: ResponseBody::Ok(serde_json::to_value(result).unwrap()),
                };
                let mut g = a_clone.lock().await;
                g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                    .await
                    .unwrap();
            }
        }
    });

    #[derive(serde::Serialize)]
    struct StartParams {
        browser_instance_id: Option<String>,
    }
    #[derive(serde::Deserialize, Debug)]
    struct StartReply {
        #[allow(dead_code)]
        session_id: String,
        browser_instance_id: String,
        agent_window_id: Option<i64>,
    }

    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let reply: StartReply = ipc
        .call(
            "s-pick",
            Method::SessionStart,
            Some(StartParams {
                browser_instance_id: Some(TEST_EXT_ID.into()),
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("session.start must succeed when --browser is unambiguous");
    assert_eq!(reply.browser_instance_id, TEST_EXT_ID);
    assert_eq!(reply.agent_window_id, Some(123));

    drop(b);
    responder.abort();
    handle.shutdown().await;
}

#[tokio::test]
async fn session_start_with_unknown_label_returns_not_found() {
    let (handle, sock) = spawn_daemon().await;
    let mut a = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut a).await;
    let _b = connect_second_ext(handle.ws_addr(), "second-browser", "Edge").await;
    #[derive(serde::Serialize)]
    struct StartParams {
        browser_instance_id: Option<String>,
    }
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let result: Result<serde_json::Value, bsk_protocol::RpcError> = ipc
        .call(
            "s-miss",
            Method::SessionStart,
            Some(StartParams {
                browser_instance_id: Some("does-not-exist".into()),
            }),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    let err = result.expect_err("expected not_found");
    assert_eq!(err.code, bsk_protocol::ErrorCode::NotFound);
    handle.shutdown().await;
}

#[tokio::test]
async fn session_start_label_match_picks_target() {
    let (handle, sock) = spawn_daemon().await;
    let mut a = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut a).await;
    // Test label is "Test" (set via handshake_as_ext) on ext A; ext B has "Edge".
    let _b = connect_second_ext(handle.ws_addr(), "second-browser", "Edge").await;
    // Fake responder for ext A only — same drill as the instance_id test.
    let a = Arc::new(tokio::sync::Mutex::new(a));
    let a_clone = Arc::clone(&a);
    let responder = tokio::spawn(async move {
        loop {
            let next = {
                let mut g = a_clone.lock().await;
                g.next().await
            };
            let msg = match next {
                Some(Ok(m)) => m,
                _ => break,
            };
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };
            let frame: Frame = serde_json::from_str(&text).unwrap();
            if let Frame::Request(req) = frame
                && req.method == Method::ToolSessionStart
            {
                let result = SessionStartResult {
                    agent_window_id: Some(456),
                };
                let reply = ResponseFrame {
                    id: req.id,
                    body: ResponseBody::Ok(serde_json::to_value(result).unwrap()),
                };
                let mut g = a_clone.lock().await;
                g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                    .await
                    .unwrap();
            }
        }
    });

    #[derive(serde::Serialize)]
    struct StartParams {
        browser_instance_id: Option<String>,
    }
    #[derive(serde::Deserialize, Debug)]
    struct StartReply {
        browser_instance_id: String,
    }

    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let reply: StartReply = ipc
        .call(
            "s-label",
            Method::SessionStart,
            Some(StartParams {
                browser_instance_id: Some("Test".into()),
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("session.start must succeed for unique label match");
    assert_eq!(reply.browser_instance_id, TEST_EXT_ID);

    responder.abort();
    handle.shutdown().await;
}

#[tokio::test]
async fn session_start_ambiguous_label_returns_invalid_params() {
    let (handle, sock) = spawn_daemon().await;
    let mut a = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut a).await;
    // Both browsers share the label "Shared" — the daemon must
    // surface `invalid_params` with the ambiguous instance ids in
    // error.data.
    let _b = connect_second_ext(handle.ws_addr(), "second-browser", "Test").await;
    #[derive(serde::Serialize)]
    struct StartParams {
        browser_instance_id: Option<String>,
    }
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let result: Result<serde_json::Value, bsk_protocol::RpcError> = ipc
        .call(
            "s-amb",
            Method::SessionStart,
            Some(StartParams {
                browser_instance_id: Some("Test".into()),
            }),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    let err = result.expect_err("expected ambiguous label invalid_params");
    assert_eq!(err.code, bsk_protocol::ErrorCode::InvalidParams);
    let data = err.data.as_ref().expect("ambiguous label must carry data");
    let label = data.get("label").and_then(|v| v.as_str()).unwrap();
    let ids = data
        .get("instance_ids")
        .and_then(|v| v.as_array())
        .expect("instance_ids array");
    assert_eq!(label, "Test");
    assert_eq!(ids.len(), 2);
    handle.shutdown().await;
}

#[tokio::test]
async fn session_window_closed_event_purges_session() {
    let (handle, _sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let state = handle.state();
    let session = bsk::daemon::sessions::Session {
        id: bsk::daemon::sessions::SessionId("zzzz".into()),
        browser_id: bsk::daemon::browsers::BrowserId(TEST_EXT_ID.into()),
        agent_window_id: Some(7),
        created_at_ms: 0,
    };
    state.sessions.insert(session);
    assert_eq!(state.sessions.len(), 1);

    // Send `session.window_closed` event from the fake extension.
    let event = bsk_protocol::EventFrame {
        event: bsk_protocol::EventKind::SessionWindowClosed,
        payload: serde_json::json!({
            "session_id": "zzzz",
            "reason": "user_closed_window",
        }),
    };
    ws.send(Message::Text(
        serde_json::to_string(&bsk_protocol::Frame::Event(event)).unwrap(),
    ))
    .await
    .unwrap();

    wait_for_no_sessions(&state).await;

    let _ = ws.close(None).await;
    handle.shutdown().await;
}

#[tokio::test]
async fn browser_disconnect_purges_sessions() {
    let (handle, _sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    // Manually inject a session bound to this browser to simulate the
    // post-start state without bothering with the round-trip.
    let state = handle.state();
    let session = bsk::daemon::sessions::Session {
        id: bsk::daemon::sessions::SessionId("zzzz".into()),
        browser_id: bsk::daemon::browsers::BrowserId(TEST_EXT_ID.into()),
        agent_window_id: Some(7),
        created_at_ms: 0,
    };
    state.sessions.insert(session);
    assert_eq!(state.sessions.len(), 1);

    let _ = ws.close(None).await;
    drop(ws);
    wait_for_no_sessions(&state).await;

    handle.shutdown().await;
}

#[tokio::test]
async fn session_stop_self_heals_when_extension_reports_not_found() {
    // After an extension SW restart the daemon still owns the session
    // entry (Round 2 generation-guard) but the extension's
    // SessionManager is reset and answers `not_found`. Stop must
    // reconcile local state so `session.list` does not show an orphan
    // (review M4/M5 round 3 I-R3-2).

    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    // Inject a session bound to this browser (mimics surviving SW
    // restart from the daemon's point of view).
    let state = handle.state();
    let session = bsk::daemon::sessions::Session {
        id: bsk::daemon::sessions::SessionId("yyyy".into()),
        browser_id: bsk::daemon::browsers::BrowserId(TEST_EXT_ID.into()),
        agent_window_id: Some(99),
        created_at_ms: 1,
    };
    state.sessions.insert(session);
    state
        .tool_queues
        .spawn(bsk::daemon::sessions::SessionId("yyyy".into()));
    assert_eq!(state.sessions.len(), 1);

    // Fake extension: always reply not_found to tool.session_stop.
    let ws = Arc::new(tokio::sync::Mutex::new(ws));
    let ws_clone = Arc::clone(&ws);
    let responder = tokio::spawn(async move {
        loop {
            let next = {
                let mut g = ws_clone.lock().await;
                g.next().await
            };
            let msg = match next {
                Some(Ok(m)) => m,
                _ => break,
            };
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };
            let frame: Frame = match serde_json::from_str(&text) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if let Frame::Request(req) = frame
                && req.method == Method::ToolSessionStop
            {
                let reply = ResponseFrame {
                    id: req.id,
                    body: ResponseBody::Err(bsk_protocol::RpcError {
                        code: bsk_protocol::ErrorCode::NotFound,
                        message: "session unknown to extension".into(),
                        data: None,
                    }),
                };
                let mut g = ws_clone.lock().await;
                g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                    .await
                    .unwrap();
            }
        }
    });

    #[derive(serde::Serialize)]
    struct StopParams {
        session_id: Option<String>,
        all: bool,
    }
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let result: Result<serde_json::Value, bsk_protocol::RpcError> = ipc
        .call(
            "s-1",
            Method::SessionStop,
            Some(StopParams {
                session_id: Some("yyyy".into()),
                all: false,
            }),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
    assert!(
        result.is_ok(),
        "stop must succeed when extension reports not_found (orphan reconciliation), got {result:?}"
    );
    assert_eq!(
        state.sessions.len(),
        0,
        "session must be forgotten locally after extension not_found"
    );

    responder.abort();
    handle.shutdown().await;
}

#[tokio::test]
async fn reconnect_with_same_instance_id_does_not_clobber_new_browser() {
    // Spawn a daemon, connect ext A, register a session bound to it,
    // then connect ext B reusing the same instance_id (mimics a SW
    // restart / WS reconnect under MV3). When the OLD WS task tears
    // down, the generation guard MUST keep the new entry + its
    // session in the registry. Without the guard the stale cleanup
    // path would call browsers.remove() + sessions.purge_browser()
    // and the daemon would silently drop the live session.

    let (handle, _sock) = spawn_daemon().await;
    let mut ws_a = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws_a).await;
    let state = handle.state();
    // Pretend ext A registered a real session.
    let session = bsk::daemon::sessions::Session {
        id: bsk::daemon::sessions::SessionId("xxxx".into()),
        browser_id: bsk::daemon::browsers::BrowserId(TEST_EXT_ID.into()),
        agent_window_id: Some(11),
        created_at_ms: 1,
    };
    state.sessions.insert(session);
    assert_eq!(state.sessions.len(), 1);

    // Open a second WS that reuses TEST_EXT_ID.
    let mut ws_b = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws_b).await;
    // Registry now holds the newer generation under the same id.
    assert_eq!(state.browsers.len(), 1);

    // Tear down ext A only; the cleanup path will run but must
    // observe that the registered generation no longer matches and
    // leave the new entry + session alone.
    let _ = ws_a.close(None).await;
    drop(ws_a);
    wait_for_browser_count(&state, 1).await;
    wait_for_session_count(&state, 1).await;

    assert_eq!(
        state.browsers.len(),
        1,
        "new browser entry must survive old cleanup"
    );
    assert_eq!(
        state.sessions.len(),
        1,
        "session must survive old browser cleanup"
    );

    let _ = ws_b.close(None).await;
    handle.shutdown().await;
}

#[tokio::test]
async fn reserve_id_loops_until_vacant_and_caps_attempts() {
    // Pre-fill the registry with a known id and verify reserve_id
    // honours the existing placeholder rather than overwriting it.
    let registry = std::sync::Arc::new(bsk::daemon::sessions::SessionRegistry::new());
    let browser = bsk::daemon::browsers::BrowserId("collision-browser".into());

    // Reserve once so the registry holds a placeholder; the returned id
    // is random so we cannot assert its value, but we can assert that a
    // second reservation never produces the same id.
    let first = registry
        .reserve_id(browser.clone(), 64, || 1)
        .expect("first reservation should succeed");
    let second = registry
        .reserve_id(browser.clone(), 64, || 2)
        .expect("second reservation should succeed");
    assert_ne!(first, second, "reserve_id must avoid collisions");
    assert_eq!(registry.len(), 2);

    // A capped attempts budget of 0 surfaces the IdExhausted condition.
    let exhausted = registry.reserve_id(browser, 0, || 3);
    assert!(exhausted.is_none(), "0-attempt budget should bail out");

    // Cancelling makes the slot vacant again.
    registry.cancel_reservation(&first);
    assert_eq!(registry.len(), 1);
}
