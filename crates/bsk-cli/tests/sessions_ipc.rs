//! M5.1 integration: spin up the minimal daemon + IPC, connect a fake
//! extension over WebSocket, and exercise the session.start/stop round-
//! trip through `IpcClient`.

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::cancel::{CancelParams, CancelResult};
use bsk_protocol::system::{HandshakeParams, HandshakeResult, StatusResult};
use bsk_protocol::tools::{
    SessionStartParams, SessionStartResult, SessionStopParams, SessionStopResult,
};
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, Frame, Method, RequestFrame, ResponseBody, ResponseFrame, RpcError,
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

use support::{wait_for_browser_count, wait_for_no_sessions};

const TEST_EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

#[tokio::test]
async fn shared_session_rejects_legacy_extension_before_start_request() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    handshake_with_protocol(&mut ws, "1.3").await;
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let result = ipc
        .call::<_, serde_json::Value>(
            "shared-old",
            Method::SessionStart,
            Some(serde_json::json!({"in_window":true})),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
    assert_eq!(result.unwrap_err().code, ErrorCode::Unsupported);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), next_extension_request(&mut ws))
            .await
            .is_err()
    );
    handle.shutdown().await;
}

#[tokio::test]
async fn shared_mode_round_trips_and_tabs_closed_removes_only_its_session() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    handshake_as_ext(&mut ws).await;
    let ext = tokio::spawn(async move {
        let mut ids = Vec::new();
        for _ in 0..2 {
            let req = next_extension_request(&mut ws).await;
            assert_eq!(req.method, Method::ToolSessionStart);
            let params: SessionStartParams = serde_json::from_value(req.params.unwrap()).unwrap();
            assert!(params.in_window);
            ids.push(params.session_id);
            send_extension_response(
                &mut ws,
                ResponseFrame {
                    id: req.id,
                    body: ResponseBody::Ok(
                        serde_json::json!({"agent_window_id":10,"container_mode":"in_window"}),
                    ),
                },
            )
            .await;
        }
        ws.send(Message::Text(serde_json::json!({"event":"session.tabs_closed","payload":{"session_id":ids[0],"reason":"no_controlled_tabs"}}).to_string())).await.unwrap();
        ws
    });
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let mut starts = Vec::new();
    for id in ["shared-a", "shared-b"] {
        let result: serde_json::Value = ipc
            .call(
                id,
                Method::SessionStart,
                Some(serde_json::json!({"in_window":true})),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["container_mode"], "in_window");
        starts.push(result);
    }
    let _ws = ext.await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let status: StatusResult = ipc
                .call::<(), _>(
                    "shared-status",
                    Method::SystemStatus,
                    None,
                    Duration::from_secs(2),
                )
                .await
                .unwrap()
                .unwrap();
            if status.sessions.len() == 1 {
                assert_eq!(
                    status.sessions[0].session_id,
                    starts[1]["session_id"].as_str().unwrap()
                );
                assert_eq!(
                    status.sessions[0].container_mode.as_deref(),
                    Some("in_window")
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    handle.shutdown().await;
}

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn tempfile_path(prefix: &str) -> PathBuf {
    support::ipc_endpoint(prefix)
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

async fn connect_ext(addr: std::net::SocketAddr) -> TestWs {
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

async fn handshake_as_ext(ws: &mut TestWs) -> HandshakeResult {
    handshake_with_protocol(ws, bsk::daemon::state::PROTOCOL_VERSION).await
}

async fn handshake_with_protocol(ws: &mut TestWs, protocol: &str) -> HandshakeResult {
    let params = HandshakeParams {
        client: "browser-skill-extension".into(),
        version: "0.1.0-dev.0".parse().unwrap(),
        protocol_version: protocol.into(),
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

async fn next_extension_request(ws: &mut TestWs) -> RequestFrame {
    loop {
        let message = ws.next().await.expect("daemon closed websocket").unwrap();
        match message {
            Message::Text(text) => match serde_json::from_str::<Frame>(&text).unwrap() {
                Frame::Request(request) => return request,
                Frame::Response(_) | Frame::Event(_) => continue,
            },
            Message::Ping(payload) => ws.send(Message::Pong(payload)).await.unwrap(),
            Message::Close(_) => panic!("daemon closed websocket before sending request"),
            _ => {}
        }
    }
}

async fn send_extension_response(ws: &mut TestWs, response: ResponseFrame) {
    ws.send(Message::Text(serde_json::to_string(&response).unwrap()))
        .await
        .unwrap();
}

async fn acknowledge_extension_cancel(ws: &mut TestWs, cancel: RequestFrame, target_rpc_id: &str) {
    assert_eq!(cancel.method, Method::Cancel);
    let params: CancelParams = serde_json::from_value(cancel.params.unwrap()).unwrap();
    assert_eq!(params.rpc_id, target_rpc_id);
    send_extension_response(
        ws,
        ResponseFrame {
            id: cancel.id,
            body: ResponseBody::Ok(serde_json::to_value(CancelResult { cancelled: true }).unwrap()),
        },
    )
    .await;
}

async fn respond_to_aborted_start(
    ws: &mut TestWs,
    start_seen: Option<tokio::sync::oneshot::Sender<()>>,
    agent_window_id: i64,
) {
    let start = next_extension_request(ws).await;
    assert_eq!(start.method, Method::ToolSessionStart);
    let params: SessionStartParams = serde_json::from_value(start.params.clone().unwrap()).unwrap();
    if let Some(start_seen) = start_seen {
        start_seen.send(()).unwrap();
    }

    let cancel = next_extension_request(ws).await;
    acknowledge_extension_cancel(ws, cancel, &start.id).await;

    // Model the hardest race: chrome.windows.create completed just as
    // cancellation arrived, so the extension's original call succeeds.
    send_extension_response(
        ws,
        ResponseFrame {
            id: start.id,
            body: ResponseBody::Ok(
                serde_json::to_value(SessionStartResult {
                    container_mode: None,
                    interaction: None,
                    agent_window_id: Some(agent_window_id),
                })
                .unwrap(),
            ),
        },
    )
    .await;

    let rollback = next_extension_request(ws).await;
    assert_eq!(rollback.method, Method::ToolSessionStop);
    let rollback_params: SessionStopParams =
        serde_json::from_value(rollback.params.unwrap()).unwrap();
    assert_eq!(rollback_params.session_id, params.session_id);
    send_extension_response(
        ws,
        ResponseFrame {
            id: rollback.id,
            body: ResponseBody::Ok(serde_json::to_value(SessionStopResult::default()).unwrap()),
        },
    )
    .await;
}

async fn respond_to_aborted_stop(
    ws: &mut TestWs,
    stop_seen: Option<tokio::sync::oneshot::Sender<()>>,
) {
    let start = next_extension_request(ws).await;
    assert_eq!(start.method, Method::ToolSessionStart);
    send_extension_response(
        ws,
        ResponseFrame {
            id: start.id,
            body: ResponseBody::Ok(
                serde_json::to_value(SessionStartResult {
                    container_mode: None,
                    interaction: None,
                    agent_window_id: Some(4242),
                })
                .unwrap(),
            ),
        },
    )
    .await;

    let stop = next_extension_request(ws).await;
    assert_eq!(stop.method, Method::ToolSessionStop);
    if let Some(stop_seen) = stop_seen {
        stop_seen.send(()).unwrap();
    }
    let cancel = next_extension_request(ws).await;
    acknowledge_extension_cancel(ws, cancel, &stop.id).await;
    send_extension_response(
        ws,
        ResponseFrame {
            id: stop.id,
            body: ResponseBody::Err(RpcError {
                code: ErrorCode::Cancelled,
                message: "session_stop aborted before window close".into(),
                data: None,
            }),
        },
    )
    .await;
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
                        let params: SessionStartParams =
                            serde_json::from_value(req.params.clone().unwrap()).unwrap();
                        assert_eq!(params.focused, Some(false));
                        let result = SessionStartResult {
                            container_mode: None,
                            interaction: None,
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
        focused: Option<bool>,
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
                focused: Some(false),
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
async fn cancelling_session_start_rolls_back_a_late_extension_success() {
    const START_RPC_ID: &str = "session-start-cancel";

    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (start_seen_tx, start_seen_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();

    let responder = tokio::spawn(async move {
        respond_to_aborted_start(&mut ws, Some(start_seen_tx), 4242).await;
        let _ = release_rx.await;
    });

    let mut start_ipc = IpcClient::connect(&sock).await.unwrap();
    let start_call = tokio::spawn(async move {
        let outcome: Result<serde_json::Value, RpcError> = start_ipc
            .call_with_id(
                START_RPC_ID.to_string(),
                Method::SessionStart,
                Some(serde_json::json!({ "focused": false })),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        outcome
    });

    start_seen_rx.await.unwrap();
    let mut cancel_ipc = IpcClient::connect(&sock).await.unwrap();
    let cancel: CancelResult = cancel_ipc
        .call(
            "cancel-start",
            Method::Cancel,
            Some(CancelParams {
                rpc_id: START_RPC_ID.to_string(),
            }),
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(cancel.cancelled);

    let start_error = start_call.await.unwrap().unwrap_err();
    assert_eq!(start_error.code, ErrorCode::Cancelled);

    let mut status_ipc = IpcClient::connect(&sock).await.unwrap();
    let status: StatusResult = status_ipc
        .call::<(), _>(
            "status-after-start-cancel",
            Method::SystemStatus,
            None,
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(status.sessions.is_empty());
    assert_eq!(status.browsers[0].session_count, 0);

    let _ = release_tx.send(());
    responder.await.unwrap();
    handle.shutdown().await;
}

#[tokio::test]
async fn timing_out_session_start_rolls_back_a_late_extension_success() {
    let (handle, _sock) = spawn_daemon().await;
    let state = handle.state();
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();

    let responder = tokio::spawn(async move {
        respond_to_aborted_start(&mut ws, None, 4343).await;
        let _ = release_rx.await;
    });

    let start = bsk::daemon::sessions::start_session(
        &state.browsers,
        &state.sessions,
        &state.tool_queues,
        None,
        bsk::daemon::sessions::AgentWindowOptions::default(),
        Duration::ZERO,
        Duration::from_millis(20),
        None,
    )
    .await;
    assert!(matches!(
        start,
        Err(bsk::daemon::sessions::StartSessionError::Timeout)
    ));
    assert!(state.sessions.is_empty());

    let _ = release_tx.send(());
    responder.await.unwrap();
    handle.shutdown().await;
}

#[tokio::test]
async fn cancelling_session_stop_keeps_the_session_retryable() {
    const STOP_RPC_ID: &str = "session-stop-cancel";

    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (stop_seen_tx, stop_seen_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();

    let responder = tokio::spawn(async move {
        respond_to_aborted_stop(&mut ws, Some(stop_seen_tx)).await;
        let _ = release_rx.await;
    });

    let mut start_ipc = IpcClient::connect(&sock).await.unwrap();
    let start: serde_json::Value = start_ipc
        .call(
            "start-before-stop-cancel",
            Method::SessionStart,
            Some(serde_json::json!({ "focused": false })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    let session_id = start["session_id"].as_str().unwrap().to_string();

    let mut stop_ipc = IpcClient::connect(&sock).await.unwrap();
    let stop_session_id = session_id.clone();
    let stop_call = tokio::spawn(async move {
        let outcome: Result<serde_json::Value, RpcError> = stop_ipc
            .call_with_id(
                STOP_RPC_ID.to_string(),
                Method::SessionStop,
                Some(serde_json::json!({
                    "session_id": stop_session_id,
                    "all": false,
                })),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        outcome
    });

    stop_seen_rx.await.unwrap();
    let mut cancel_ipc = IpcClient::connect(&sock).await.unwrap();
    let cancel: CancelResult = cancel_ipc
        .call(
            "cancel-stop",
            Method::Cancel,
            Some(CancelParams {
                rpc_id: STOP_RPC_ID.to_string(),
            }),
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(cancel.cancelled);

    let stop_error = stop_call.await.unwrap().unwrap_err();
    assert_eq!(stop_error.code, ErrorCode::Cancelled);

    let mut status_ipc = IpcClient::connect(&sock).await.unwrap();
    let status: StatusResult = status_ipc
        .call::<(), _>(
            "status-after-stop-cancel",
            Method::SystemStatus,
            None,
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.sessions.len(), 1);
    assert_eq!(status.sessions[0].session_id, session_id);

    let _ = release_tx.send(());
    responder.await.unwrap();
    handle.shutdown().await;
}

#[tokio::test]
async fn timing_out_session_stop_cancels_extension_teardown_and_keeps_session() {
    let (handle, sock) = spawn_daemon().await;
    let state = handle.state();
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();

    let responder = tokio::spawn(async move {
        respond_to_aborted_stop(&mut ws, None).await;
        let _ = release_rx.await;
    });

    let mut start_ipc = IpcClient::connect(&sock).await.unwrap();
    let start: serde_json::Value = start_ipc
        .call(
            "start-before-stop-timeout",
            Method::SessionStart,
            Some(serde_json::json!({ "focused": false })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    let session_id =
        bsk::daemon::sessions::SessionId(start["session_id"].as_str().unwrap().to_string());

    let stop = bsk::daemon::sessions::stop_session(
        &state.browsers,
        &state.sessions,
        &state.tool_queues,
        &state.session_interrupts,
        &session_id,
        Duration::from_millis(20),
        None,
    )
    .await;
    assert!(matches!(
        stop,
        Err(bsk::daemon::sessions::StopSessionError::Timeout)
    ));
    assert!(state.sessions.get(&session_id).is_some());

    let _ = release_tx.send(());
    responder.await.unwrap();
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
        container_mode: None,
        interaction: None,

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
                container_mode: None,
                interaction: None,
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
        protocol_version: bsk::daemon::state::PROTOCOL_VERSION.into(),
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
                    container_mode: None,
                    interaction: None,
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
                    container_mode: None,
                    interaction: None,
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
        container_mode: None,
        interaction: None,

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
        container_mode: None,
        interaction: None,

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
    // Legacy extension versions or unusual reconnect races can leave a
    // daemon session after the extension's SessionManager resets and answers
    // `not_found`. Stop must still reconcile local state so `session.list`
    // does not show an orphan (review M4/M5 round 3 I-R3-2).

    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    // Inject a session bound to this browser (mimics surviving SW
    // restart from the daemon's point of view).
    let state = handle.state();
    let session = bsk::daemon::sessions::Session {
        container_mode: None,
        interaction: None,

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
async fn reconnect_with_same_instance_id_purges_stale_sessions_but_keeps_new_browser() {
    // Spawn a daemon, connect ext A, register a session bound to it,
    // then connect ext B reusing the same instance_id (mimics a SW
    // restart / WS reconnect under MV3). The extension now safely stops
    // its local sessions before reconnecting, so the new handshake must
    // purge the matching daemon rows. The generation guard must still keep
    // the NEW browser registration when the old WS task later tears down.

    let (handle, _sock) = spawn_daemon().await;
    let mut ws_a = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws_a).await;
    let state = handle.state();
    // Pretend ext A registered a real session.
    let session = bsk::daemon::sessions::Session {
        container_mode: None,
        interaction: None,

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
    wait_for_no_sessions(&state).await;

    // Tear down ext A only; the cleanup path will run but must
    // observe that the registered generation no longer matches and
    // leave the new browser entry alone.
    let _ = ws_a.close(None).await;
    drop(ws_a);
    wait_for_browser_count(&state, 1).await;

    assert_eq!(
        state.browsers.len(),
        1,
        "new browser entry must survive old cleanup"
    );
    assert_eq!(
        state.sessions.len(),
        0,
        "stale sessions must not survive reconnect"
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

#[tokio::test]
async fn legacy_unattended_uses_browser_policy_and_help_reaches_extension() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    handshake_as_ext(&mut ws).await;
    let responder = tokio::spawn(async move {
        let request = next_extension_request(&mut ws).await;
        assert_eq!(request.method, Method::ToolSessionStart);
        assert!(request.params.as_ref().unwrap().get("unattended").is_none());
        send_extension_response(
            &mut ws,
            ResponseFrame {
                id: request.id,
                body: ResponseBody::Ok(serde_json::json!({"agent_window_id": 987,
                "interaction": {"borrow_confirmation": "always", "request_help": "enabled"}})),
            },
        )
        .await;
        let help = next_extension_request(&mut ws).await;
        assert_eq!(help.method, Method::ToolRequestHelp);
        send_extension_response(
            &mut ws,
            ResponseFrame {
                id: help.id,
                body: ResponseBody::Ok(serde_json::json!({"outcome": "cancelled", "tab_id": 5})),
            },
        )
        .await;
        ws
    });
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let result: serde_json::Value = ipc
        .call(
            "start-legacy",
            Method::SessionStart,
            Some(serde_json::json!({"unattended": true})),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["interaction"]["borrow_confirmation"], "always");
    assert_eq!(result["interaction"]["request_help"], "enabled");
    let mut later = IpcClient::connect(&sock).await.unwrap();
    let help: serde_json::Value = later.call("help", Method::ToolRequestHelp,
        Some(serde_json::json!({"session_id": result["session_id"], "prompt": "Log in", "timeout_ms": 300_000})),
        Duration::from_secs(5)).await.unwrap().unwrap();
    assert_eq!(help["outcome"], "cancelled");
    let listed: serde_json::Value = later
        .call::<(), _>("list", Method::SessionList, None, Duration::from_secs(1))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(listed["sessions"][0]["interaction"], result["interaction"]);
    let ws = responder.await.unwrap();
    drop(ws);
    handle.shutdown().await;
}

#[test]
fn interaction_updates_follow_the_owning_browser_in_both_directions() {
    use bsk::daemon::{
        browsers::BrowserId,
        sessions::{Session, SessionId, SessionRegistry},
    };
    use bsk_protocol::tools::{BorrowConfirmationPolicy, InteractionPolicy, RequestHelpPolicy};
    let registry = SessionRegistry::new();
    let owner = BrowserId("owner".into());
    let id = SessionId("existing".into());
    registry.insert(Session {
        container_mode: None,
        id: id.clone(),
        browser_id: owner.clone(),
        agent_window_id: Some(100),
        created_at_ms: 0,
        interaction: None,
    });
    let interactive = InteractionPolicy {
        borrow_confirmation: BorrowConfirmationPolicy::Always,
        request_help: RequestHelpPolicy::Enabled,
    };
    let disabled = InteractionPolicy {
        borrow_confirmation: BorrowConfirmationPolicy::Never,
        request_help: RequestHelpPolicy::Disabled,
    };
    registry.update_interaction(&id, &BrowserId("other".into()), disabled);
    assert_eq!(registry.get(&id).unwrap().interaction, None);
    for policy in [interactive, disabled, interactive] {
        registry.update_interaction(&id, &owner, policy);
        assert_eq!(
            registry.get(&id).unwrap().status_entry().interaction,
            Some(policy)
        );
        registry.update_interaction(&id, &BrowserId("other".into()), disabled);
        assert_eq!(registry.get(&id).unwrap().interaction, Some(policy));
    }
}

#[tokio::test]
async fn borrow_deadline_cancels_the_extension_and_preserves_a_committed_result() {
    use bsk::daemon::{
        queue::DispatchError,
        sessions::{Session, SessionId},
    };
    for committed in [false, true] {
        let (handle, _sock) = spawn_daemon().await;
        let mut ws = connect_ext(handle.ws_addr()).await;
        handshake_with_protocol(&mut ws, bsk::daemon::state::PROTOCOL_VERSION).await;
        let state = handle.state();
        let session_id = SessionId("borrow-deadline".into());
        state.sessions.insert(Session {
            container_mode: None,
            id: session_id.clone(),
            browser_id: bsk::daemon::browsers::BrowserId(TEST_EXT_ID.into()),
            agent_window_id: Some(100),
            created_at_ms: 0,

            interaction: None,
        });
        state.tool_queues.spawn(session_id.clone());
        let responder = tokio::spawn(async move {
            let request = next_extension_request(&mut ws).await;
            assert_eq!(request.method, Method::ToolTabBorrow);
            let cancel = next_extension_request(&mut ws).await;
            acknowledge_extension_cancel(&mut ws, cancel, &request.id).await;
            let body = if committed {
                ResponseBody::Ok(serde_json::json!({"tab_id": 7, "agent_window_id": 100,
                    "original_window_id": 200, "original_index": 4}))
            } else {
                ResponseBody::Err(RpcError {
                    code: ErrorCode::Cancelled,
                    message: "borrow aborted before move".into(),
                    data: None,
                })
            };
            send_extension_response(
                &mut ws,
                ResponseFrame {
                    id: request.id,
                    body,
                },
            )
            .await;
            ws
        });
        let result = state
            .tool_queues
            .dispatch(
                &session_id,
                Method::ToolTabBorrow,
                serde_json::json!({"session_id": session_id.0, "tab_id": 7}),
                Duration::from_millis(20),
                None,
            )
            .await;
        if committed {
            assert_eq!(result.unwrap()["tab_id"], 7);
        } else {
            assert!(matches!(
                result,
                Err(DispatchError::Rpc(RpcError {
                    code: ErrorCode::Timeout,
                    ..
                }))
            ));
        }
        drop(responder.await.unwrap());
        handle.shutdown().await;
    }
}

#[tokio::test]
async fn borrow_reports_unknown_outcome_when_cancel_cleanup_never_finishes() {
    use bsk::daemon::{
        queue::DispatchError,
        sessions::{Session, SessionId},
    };
    let (handle, _sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    handshake_with_protocol(&mut ws, bsk::daemon::state::PROTOCOL_VERSION).await;
    let state = handle.state();
    let sid = SessionId("borrow-unknown".into());
    state.sessions.insert(Session {
        container_mode: None,
        id: sid.clone(),
        browser_id: bsk::daemon::browsers::BrowserId(TEST_EXT_ID.into()),
        agent_window_id: Some(100),
        created_at_ms: 0,

        interaction: None,
    });
    state.tool_queues.spawn(sid.clone());
    let queues = state.tool_queues.clone();
    let pending = tokio::spawn(async move {
        queues
            .dispatch(
                &sid,
                Method::ToolTabBorrow,
                serde_json::json!({"session_id": sid.0, "tab_id": 7}),
                Duration::from_millis(20),
                None,
            )
            .await
    });
    let borrow = next_extension_request(&mut ws).await;
    let cancel = next_extension_request(&mut ws).await;
    acknowledge_extension_cancel(&mut ws, cancel, &borrow.id).await;
    // Acknowledging cancel is not proof that the original operation stopped.
    let result = tokio::time::timeout(Duration::from_secs(10), pending)
        .await
        .unwrap()
        .unwrap();
    let Err(DispatchError::Rpc(error)) = result else {
        panic!("expected unknown outcome");
    };
    assert_eq!(
        error.data.as_ref().unwrap()["reason"],
        "borrow_outcome_unknown"
    );
    assert_eq!(error.data.as_ref().unwrap()["effect_state"], "unknown");
    drop(ws);
    handle.shutdown().await;
}

mod recoverable_starts {
    use super::*;
    use serde_json::{Value, json};

    fn token() -> String {
        let expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            + 60_000;
        format!("{expires}:{}", uuid::Uuid::new_v4())
    }

    async fn request(sock: &PathBuf, id: &str, action: &str) -> Value {
        IpcClient::connect(sock)
            .await
            .unwrap()
            .call(
                "request",
                Method::SessionRequest,
                Some(json!({"request_id": id, "action": action})),
                Duration::from_secs(15),
            )
            .await
            .unwrap()
            .unwrap()
    }

    async fn successful_start(ws: &mut TestWs) -> String {
        let start = next_extension_request(ws).await;
        assert_eq!(start.method, Method::ToolSessionStart);
        let params: SessionStartParams = serde_json::from_value(start.params.unwrap()).unwrap();
        send_extension_response(
            ws,
            ResponseFrame {
                id: start.id,
                body: ResponseBody::Ok(
                    json!({"session_id": params.session_id, "agent_window_id": 101}),
                ),
            },
        )
        .await;
        params.session_id
    }

    async fn successful_stop(ws: &mut TestWs, expected: &str) {
        let stop = next_extension_request(ws).await;
        assert_eq!(stop.method, Method::ToolSessionStop);
        assert_eq!(stop.params.as_ref().unwrap()["session_id"], expected);
        send_extension_response(
            ws,
            ResponseFrame {
                id: stop.id,
                body: ResponseBody::Ok(serde_json::to_value(SessionStopResult::default()).unwrap()),
            },
        )
        .await;
    }

    #[tokio::test]
    async fn cancellation_before_start_is_a_tombstone() {
        let (daemon, sock) = spawn_daemon().await;
        let id = token();
        assert_eq!(request(&sock, &id, "prepare").await["state"], "prepared");
        assert_eq!(request(&sock, &id, "cancel").await["state"], "closed");
        let mut client = IpcClient::connect(&sock).await.unwrap();
        let outcome = client
            .call_with_id::<_, Value>(
                "late-start".into(),
                Method::SessionStartTracked,
                Some(json!({"request_id": id})),
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert_eq!(outcome.unwrap_err().code, ErrorCode::Cancelled);
        assert!(daemon.state().sessions.is_empty());
        daemon.shutdown().await;
    }

    #[tokio::test]
    async fn duplicate_start_and_lost_reply_are_recoverable_without_touching_foreign_session() {
        let (daemon, sock) = spawn_daemon().await;
        let mut ws = connect_ext(daemon.ws_addr()).await;
        handshake_as_ext(&mut ws).await;
        let id = token();
        assert_eq!(request(&sock, &id, "prepare").await["state"], "prepared");
        let start_sock = sock.clone();
        let start_id = id.clone();
        let original = tokio::spawn(async move {
            IpcClient::connect(start_sock)
                .await
                .unwrap()
                .call::<_, Value>(
                    "lost",
                    Method::SessionStartTracked,
                    Some(json!({"request_id": start_id})),
                    Duration::from_secs(10),
                )
                .await
        });
        let sid = successful_start(&mut ws).await;
        // Drop the original receiving process/connection after the remote side effect.
        original.abort();
        let mut retry = IpcClient::connect(&sock).await.unwrap();
        let reply: Value = retry
            .call(
                "retry",
                Method::SessionStartTracked,
                Some(json!({"request_id": id})),
                Duration::from_secs(2),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply["session_id"], sid);
        assert_eq!(daemon.state().sessions.len(), 1);
        assert_eq!(request(&sock, &id, "status").await["state"], "ready");
        assert_eq!(request(&sock, &id, "claim").await["state"], "active");
        let conflicting = retry
            .call_with_id::<_, Value>(
                "conflict".into(),
                Method::SessionStartTracked,
                Some(json!({"request_id": id, "width": 900, "height": 700})),
                Duration::from_secs(2),
            )
            .await
            .unwrap();
        assert_eq!(conflicting.unwrap_err().code, ErrorCode::InvalidParams);
        let foreign = bsk::daemon::sessions::Session {
            container_mode: None,
            id: bsk::daemon::sessions::SessionId("foreign".into()),
            browser_id: bsk::daemon::browsers::BrowserId(TEST_EXT_ID.into()),
            agent_window_id: Some(999),
            created_at_ms: 1,
            interaction: None,
        };
        daemon.state().sessions.insert(foreign.clone());
        let transfer = daemon.state().transfers.begin_download(&sid).unwrap();
        let cancelling = request(&sock, &id, "cancel");
        let (_, cancelled) = tokio::join!(successful_stop(&mut ws, &sid), cancelling);
        assert_eq!(cancelled["state"], "closed");
        assert_eq!(daemon.state().sessions.len(), 1);
        assert!(daemon.state().sessions.get(&foreign.id).is_some());
        assert!(
            !daemon
                .state()
                .transfers
                .release(bsk_protocol::tools::TransferIdParams {
                    transfer_id: transfer.transfer_id,
                })
                .released,
            "managed stop must also release the session's transfer resources"
        );
        assert_eq!(request(&sock, &id, "cancel").await["state"], "closed");
        daemon.shutdown().await;
    }

    #[tokio::test]
    async fn cancel_during_start_rolls_back_late_success() {
        let (daemon, sock) = spawn_daemon().await;
        let mut ws = connect_ext(daemon.ws_addr()).await;
        handshake_as_ext(&mut ws).await;
        let id = token();
        assert_eq!(request(&sock, &id, "prepare").await["state"], "prepared");
        let caller_sock = sock.clone();
        let caller_id = id.clone();
        let start = tokio::spawn(async move {
            IpcClient::connect(caller_sock)
                .await
                .unwrap()
                .call_with_id::<_, Value>(
                    "start".into(),
                    Method::SessionStartTracked,
                    Some(json!({"request_id": caller_id})),
                    Duration::from_secs(15),
                )
                .await
                .unwrap()
        });
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
        let extension = tokio::spawn(async move {
            respond_to_aborted_start(&mut ws, Some(seen_tx), 77).await;
            ws
        });
        seen_rx.await.unwrap();
        assert_eq!(request(&sock, &id, "cancel").await["state"], "closed");
        assert_eq!(start.await.unwrap().unwrap_err().code, ErrorCode::Cancelled);
        let _ws = extension.await.unwrap();
        assert!(daemon.state().sessions.is_empty());
        daemon.shutdown().await;
    }

    #[tokio::test]
    async fn failed_cleanup_retains_ownership_for_retry() {
        let (daemon, sock) = spawn_daemon().await;
        let mut ws = connect_ext(daemon.ws_addr()).await;
        handshake_as_ext(&mut ws).await;
        let id = token();
        assert_eq!(request(&sock, &id, "prepare").await["state"], "prepared");
        let mut client = IpcClient::connect(&sock).await.unwrap();
        let (sid, start) = tokio::join!(
            successful_start(&mut ws),
            client.call::<_, Value>(
                "start",
                Method::SessionStartTracked,
                Some(json!({"request_id": id})),
                Duration::from_secs(5)
            )
        );
        start.unwrap().unwrap();
        let fail_stop = async {
            let stop = next_extension_request(&mut ws).await;
            assert_eq!(stop.method, Method::ToolSessionStop);
            send_extension_response(
                &mut ws,
                ResponseFrame {
                    id: stop.id,
                    body: ResponseBody::Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: "injected close failure".into(),
                        data: None,
                    }),
                },
            )
            .await;
        };
        let (_, status) = tokio::join!(fail_stop, request(&sock, &id, "cancel"));
        assert_eq!(status["state"], "cleanup_failed");
        assert_eq!(status["session"]["session_id"], sid);
        assert_eq!(daemon.state().sessions.len(), 1);
        let (_, status) = tokio::join!(
            successful_stop(&mut ws, &sid),
            request(&sock, &id, "cancel")
        );
        assert_eq!(status["state"], "closed");
        assert!(daemon.state().sessions.is_empty());
        daemon.shutdown().await;
    }
    #[tokio::test]
    async fn failed_startup_compensation_retains_the_window_for_retry() {
        let (daemon, sock) = spawn_daemon().await;
        let mut ws = connect_ext(daemon.ws_addr()).await;
        handshake_as_ext(&mut ws).await;
        let id = token();
        request(&sock, &id, "prepare").await;
        let start_sock = sock.clone();
        let start_id = id.clone();
        let start = tokio::spawn(async move {
            IpcClient::connect(start_sock)
                .await
                .unwrap()
                .call::<_, Value>(
                    "start",
                    Method::SessionStartTracked,
                    Some(json!({"request_id": start_id})),
                    Duration::from_secs(5),
                )
                .await
                .unwrap()
        });
        let create = next_extension_request(&mut ws).await;
        let sid = create.params.as_ref().unwrap()["session_id"]
            .as_str()
            .unwrap()
            .to_owned();
        send_extension_response(
            &mut ws,
            ResponseFrame {
                id: create.id,
                body: ResponseBody::Err(RpcError {
                    code: ErrorCode::ProtocolError,
                    message: "initialization and window rollback failed".into(),
                    data: Some(json!({"reason": "cleanup_failed", "resource_id": 123})),
                }),
            },
        )
        .await;
        assert_eq!(
            start.await.unwrap().unwrap_err().data.unwrap()["session_id"],
            sid
        );
        let stop = next_extension_request(&mut ws).await;
        assert_eq!(stop.method, Method::ToolSessionStop);
        assert_eq!(stop.params.unwrap()["session_id"], sid);
        send_extension_response(
            &mut ws,
            ResponseFrame {
                id: stop.id,
                body: ResponseBody::Err(RpcError {
                    code: ErrorCode::ProtocolError,
                    message: "window still cannot close".into(),
                    data: None,
                }),
            },
        )
        .await;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let status = request(&sock, &id, "status").await;
                if status["state"] == "cleanup_failed" {
                    assert_eq!(status["session"]["agent_window_id"], 123);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(daemon.state().sessions.len(), 1);
        let (_, status) = tokio::join!(
            successful_stop(&mut ws, &sid),
            request(&sock, &id, "cancel")
        );
        assert_eq!(status["state"], "closed");
        assert!(daemon.state().sessions.is_empty());
        daemon.shutdown().await;
    }

    #[tokio::test]
    async fn real_cli_can_cancel_a_start_after_its_process_is_killed() {
        let (daemon, sock) = spawn_daemon().await;
        let home = tempfile::tempdir().unwrap();
        bsk::daemon::info::write_to_path(
            &bsk::daemon::info::DaemonInfo::now(
                std::process::id(),
                sock.clone(),
                daemon.ws_addr().port(),
                env!("CARGO_PKG_VERSION"),
            ),
            &home.path().join("daemon.json"),
        )
        .unwrap();
        let command = |args: Vec<String>| {
            let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_bsk"));
            cmd.args(args)
                .arg("--json")
                .env("BSK_HOME", home.path())
                .env("BSK_AUTO_START", "0")
                .env("BSK_AUTO_UPDATE", "off")
                .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            cmd
        };
        let mut ws = connect_ext(daemon.ws_addr()).await;
        handshake_as_ext(&mut ws).await;
        let id = token();
        let prepare = command(vec![
            "session".into(),
            "request".into(),
            id.clone(),
            "--prepare".into(),
        ])
        .output()
        .await
        .unwrap();
        assert!(
            prepare.status.success(),
            "{}",
            String::from_utf8_lossy(&prepare.stderr)
        );
        let mut child = command(vec![
            "session".into(),
            "start".into(),
            "--request-id".into(),
            id.clone(),
        ])
        .spawn()
        .unwrap();
        let start = next_extension_request(&mut ws).await;
        let sid = start.params.as_ref().unwrap()["session_id"]
            .as_str()
            .unwrap()
            .to_owned();
        // Kill the receiving CLI after dispatch but before any successful reply.
        child.kill().await.unwrap();
        send_extension_response(
            &mut ws,
            ResponseFrame {
                id: start.id,
                body: ResponseBody::Ok(json!({"agent_window_id": 88})),
            },
        )
        .await;
        let mut cancel = command(vec![
            "session".into(),
            "request".into(),
            id,
            "--cancel".into(),
        ]);
        let (_, output) = tokio::join!(successful_stop(&mut ws, &sid), cancel.output());
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap()["state"],
            "closed"
        );
        assert!(daemon.state().sessions.is_empty());
        daemon.shutdown().await;
    }
    #[tokio::test]
    async fn cancellation_waits_for_slow_creation_before_confirming_cleanup() {
        let (daemon, sock) = spawn_daemon().await;
        let mut ws = connect_ext(daemon.ws_addr()).await;
        handshake_as_ext(&mut ws).await;
        let id = token();
        request(&sock, &id, "prepare").await;
        let start_sock = sock.clone();
        let start_id = id.clone();
        let start_task = tokio::spawn(async move {
            IpcClient::connect(start_sock)
                .await
                .unwrap()
                .call::<_, Value>(
                    "start",
                    Method::SessionStartTracked,
                    Some(json!({"request_id": start_id})),
                    Duration::from_secs(15),
                )
                .await
                .unwrap()
        });
        let start = next_extension_request(&mut ws).await;
        let sid = start.params.as_ref().unwrap()["session_id"]
            .as_str()
            .unwrap()
            .to_owned();
        let cancel_sock = sock.clone();
        let cancel_id = id.clone();
        let cancellation =
            tokio::spawn(async move { request(&cancel_sock, &cancel_id, "cancel").await });
        let cancel = next_extension_request(&mut ws).await;
        acknowledge_extension_cancel(&mut ws, cancel, &start.id).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(2200), next_extension_request(&mut ws))
                .await
                .is_err(),
            "must not issue stop before the original create settles"
        );
        assert!(!cancellation.is_finished());
        assert!(
            daemon
                .state()
                .sessions
                .idle_ids_at(Duration::ZERO, std::time::Instant::now())
                .is_empty()
        );
        send_extension_response(
            &mut ws,
            ResponseFrame {
                id: start.id,
                body: ResponseBody::Ok(json!({"agent_window_id": 777})),
            },
        )
        .await;
        successful_stop(&mut ws, &sid).await;
        assert_eq!(cancellation.await.unwrap()["state"], "closed");
        assert_eq!(
            start_task.await.unwrap().unwrap_err().code,
            ErrorCode::Cancelled
        );
        assert!(daemon.state().sessions.is_empty());
        daemon.shutdown().await;
    }

    #[tokio::test]
    async fn concurrent_retries_create_exactly_one_window() {
        let (daemon, sock) = spawn_daemon().await;
        let mut ws = connect_ext(daemon.ws_addr()).await;
        handshake_as_ext(&mut ws).await;
        let id = token();
        request(&sock, &id, "prepare").await;
        let mut a = IpcClient::connect(&sock).await.unwrap();
        let mut b = IpcClient::connect(&sock).await.unwrap();
        let (sid, first, retry) = tokio::join!(
            successful_start(&mut ws),
            a.call::<_, Value>(
                "first",
                Method::SessionStartTracked,
                Some(json!({"request_id":id})),
                Duration::from_secs(5)
            ),
            b.call::<_, Value>(
                "retry",
                Method::SessionStartTracked,
                Some(json!({"request_id":id})),
                Duration::from_secs(5)
            )
        );
        assert_eq!(first.unwrap().unwrap()["session_id"], sid);
        assert_eq!(retry.unwrap().unwrap()["session_id"], sid);
        assert_eq!(daemon.state().sessions.len(), 1);
        // The next extension operation must be the single corresponding stop.
        let (_, status) = tokio::join!(
            successful_stop(&mut ws, &sid),
            request(&sock, &id, "cancel")
        );
        assert_eq!(status["state"], "closed");
        daemon.shutdown().await;
    }
}
