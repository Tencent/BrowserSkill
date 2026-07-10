//! M8 integration: drive the 5 new `tool.tab_*` RPCs (create / close /
//! select / borrow / return) through the IPC + per-session queue +
//! fake extension and assert the wire shapes line up with bsk-protocol.
//! Mirrors `tools_m7_ipc.rs` for the navigate / click / fill / press
//! tools so the daemon's serialise → forward → deserialise → return
//! path stays covered end-to-end.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::{
    ReturnFailure, SessionStartParams, SessionStartResult, SessionStopResult, TabBorrowParams,
    TabBorrowResult, TabCloseParams, TabCloseResult, TabCreateParams, TabCreateResult,
    TabReturnParams, TabReturnResult, TabSelectParams, TabSelectResult,
};
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, Frame, Method, RequestFrame, ResponseBody, ResponseFrame, RpcError,
};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::Value;
use tokio::sync::Mutex;
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
    let sock = tempfile_path("bsk-test-tools-m8");
    let handle = daemon::run(DaemonConfig::new(port), Some(sock.clone()))
        .await
        .unwrap();
    (handle, sock)
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_ext(addr: std::net::SocketAddr) -> Ws {
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
    let (ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws
}

async fn do_handshake(ws: &mut Ws) -> HandshakeResult {
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
        _ => panic!("expected text"),
    };
    let frame: ResponseFrame = serde_json::from_str(&text).unwrap();
    match frame.body {
        ResponseBody::Ok(v) => serde_json::from_value(v).unwrap(),
        ResponseBody::Err(e) => panic!("handshake rejected: {e:?}"),
    }
}

fn run_extension<F>(ws: Ws, reply: F)
where
    F: Fn(&RequestFrame) -> ResponseBody + Send + Sync + 'static,
{
    let (writer, reader) = ws.split();
    let writer: Arc<Mutex<SplitSink<Ws, Message>>> = Arc::new(Mutex::new(writer));
    let mut reader: SplitStream<Ws> = reader;
    let reply = Arc::new(reply);
    let mut window_id: i64 = 100;
    tokio::spawn(async move {
        while let Some(Ok(msg)) = reader.next().await {
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };
            let frame: Frame = match serde_json::from_str(&text) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let Frame::Request(req) = frame else { continue };
            let body = match req.method {
                Method::ToolSessionStart => {
                    let _: SessionStartParams =
                        serde_json::from_value(req.params.clone().unwrap()).unwrap();
                    let id = window_id;
                    window_id += 1;
                    ResponseBody::Ok(
                        serde_json::to_value(SessionStartResult {
                            agent_window_id: Some(id),
                        })
                        .unwrap(),
                    )
                }
                Method::ToolSessionStop => reply(&req),
                _ => reply(&req),
            };
            let resp = ResponseFrame {
                id: req.id.clone(),
                body,
            };
            let mut w = writer.lock().await;
            w.send(Message::Text(serde_json::to_string(&resp).unwrap()))
                .await
                .unwrap();
        }
    });
}

async fn ipc_session_start(sock: &PathBuf) -> String {
    let mut ipc = IpcClient::connect(sock).await.unwrap();
    #[derive(serde::Deserialize)]
    struct R {
        session_id: String,
    }
    let r: R = ipc
        .call::<(), _>("s", Method::SessionStart, None, Duration::from_secs(5))
        .await
        .unwrap()
        .expect("session.start ok");
    r.session_id
}

async fn ipc_tool_call<P: serde::Serialize, R: serde::de::DeserializeOwned>(
    sock: &PathBuf,
    method: Method,
    params: P,
) -> Result<R, RpcError> {
    let mut ipc = IpcClient::connect(sock).await.unwrap();
    ipc.call::<P, R>("t", method, Some(params), Duration::from_secs(15))
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tab_create_round_trips_url_and_index() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| {
        assert_eq!(req.method, Method::ToolTabCreate);
        let p: TabCreateParams = serde_json::from_value(req.params.clone().unwrap()).unwrap();
        assert_eq!(p.url.as_deref(), Some("https://example.com/"));
        assert_eq!(p.active, Some(false));
        assert_eq!(p.index, Some(2));
        ResponseBody::Ok(
            serde_json::to_value(TabCreateResult {
                tab_id: 17,
                window_id: 100,
                url: "https://example.com/".into(),
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: TabCreateResult = ipc_tool_call(
        &sock,
        Method::ToolTabCreate,
        TabCreateParams {
            session_id,
            url: Some("https://example.com/".into()),
            active: Some(false),
            index: Some(2),
        },
    )
    .await
    .expect("tab_create ok");
    assert_eq!(result.tab_id, 17);
    assert_eq!(result.window_id, 100);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tab_close_round_trips_tab_id() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| {
        assert_eq!(req.method, Method::ToolTabClose);
        let p: TabCloseParams = serde_json::from_value(req.params.clone().unwrap()).unwrap();
        ResponseBody::Ok(serde_json::to_value(TabCloseResult { tab_id: p.tab_id }).unwrap())
    });

    let session_id = ipc_session_start(&sock).await;
    let result: TabCloseResult = ipc_tool_call(
        &sock,
        Method::ToolTabClose,
        TabCloseParams {
            session_id,
            tab_id: 33,
        },
    )
    .await
    .expect("tab_close ok");
    assert_eq!(result.tab_id, 33);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tab_close_propagates_invalid_params_for_borrowed_tab() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| match &req.method {
        Method::ToolTabClose => ResponseBody::Err(RpcError {
            code: ErrorCode::InvalidParams,
            message: "tab_close: tab 33 is borrowed; call tab_return first".into(),
            data: None,
        }),
        other => panic!("unexpected method {other:?}"),
    });

    let session_id = ipc_session_start(&sock).await;
    let err = ipc_tool_call::<_, Value>(
        &sock,
        Method::ToolTabClose,
        TabCloseParams {
            session_id,
            tab_id: 33,
        },
    )
    .await
    .expect_err("expected invalid_params error");
    assert_eq!(err.code, ErrorCode::InvalidParams);
    assert!(err.message.contains("borrowed"));
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tab_select_round_trips_window_id() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| {
        assert_eq!(req.method, Method::ToolTabSelect);
        let p: TabSelectParams = serde_json::from_value(req.params.clone().unwrap()).unwrap();
        ResponseBody::Ok(
            serde_json::to_value(TabSelectResult {
                tab_id: p.tab_id,
                window_id: 100,
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: TabSelectResult = ipc_tool_call(
        &sock,
        Method::ToolTabSelect,
        TabSelectParams {
            session_id,
            tab_id: 8,
        },
    )
    .await
    .expect("tab_select ok");
    assert_eq!(result.window_id, 100);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tab_select_propagates_permission_denied_across_sessions() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| match &req.method {
        Method::ToolTabSelect => ResponseBody::Err(RpcError {
            code: ErrorCode::PermissionDenied,
            message: "tab_select: tab 9 is not in Agent Window 200".into(),
            data: None,
        }),
        other => panic!("unexpected method {other:?}"),
    });

    let session_id = ipc_session_start(&sock).await;
    let err = ipc_tool_call::<_, Value>(
        &sock,
        Method::ToolTabSelect,
        TabSelectParams {
            session_id,
            tab_id: 9,
        },
    )
    .await
    .expect_err("expected permission_denied");
    assert_eq!(err.code, ErrorCode::PermissionDenied);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tab_borrow_round_trips_original_position() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| {
        assert_eq!(req.method, Method::ToolTabBorrow);
        let p: TabBorrowParams = serde_json::from_value(req.params.clone().unwrap()).unwrap();
        assert_eq!(p.confirm, Some(false));
        ResponseBody::Ok(
            serde_json::to_value(TabBorrowResult {
                tab_id: p.tab_id,
                original_window_id: 200,
                original_index: 4,
                agent_window_id: 100,
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: TabBorrowResult = ipc_tool_call(
        &sock,
        Method::ToolTabBorrow,
        TabBorrowParams {
            session_id,
            tab_id: 9,
            confirm: Some(false),
        },
    )
    .await
    .expect("tab_borrow ok");
    assert_eq!(result.original_window_id, 200);
    assert_eq!(result.original_index, 4);
    assert_eq!(result.agent_window_id, 100);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tab_return_round_trips_fallback_flag() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| {
        assert_eq!(req.method, Method::ToolTabReturn);
        let p: TabReturnParams = serde_json::from_value(req.params.clone().unwrap()).unwrap();
        ResponseBody::Ok(
            serde_json::to_value(TabReturnResult {
                tab_id: p.tab_id,
                returned_to_window_id: 500,
                returned_to_index: -1,
                fallback: true,
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: TabReturnResult = ipc_tool_call(
        &sock,
        Method::ToolTabReturn,
        TabReturnParams {
            session_id,
            tab_id: 9,
        },
    )
    .await
    .expect("tab_return ok");
    assert_eq!(result.returned_to_window_id, 500);
    assert!(result.fallback);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tab_return_propagates_not_found_when_not_borrowed() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| match &req.method {
        Method::ToolTabReturn => ResponseBody::Err(RpcError {
            code: ErrorCode::NotFound,
            message: "tab_return: tab 9 is not borrowed by this session".into(),
            data: None,
        }),
        other => panic!("unexpected method {other:?}"),
    });

    let session_id = ipc_session_start(&sock).await;
    let err = ipc_tool_call::<_, Value>(
        &sock,
        Method::ToolTabReturn,
        TabReturnParams {
            session_id,
            tab_id: 9,
        },
    )
    .await
    .expect_err("expected not_found");
    assert_eq!(err.code, ErrorCode::NotFound);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_stop_return_failures_keep_session_registered() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| match &req.method {
        Method::ToolSessionStop => ResponseBody::Ok(
            serde_json::to_value(SessionStopResult {
                returned_tab_ids: vec![7, 8],
                return_failures: vec![ReturnFailure {
                    tab_id: 9,
                    code: ErrorCode::CdpFailed,
                    message: "move failed".into(),
                }],
            })
            .unwrap(),
        ),
        other => panic!("unexpected method {other:?}"),
    });

    let session_id = ipc_session_start(&sock).await;

    #[derive(serde::Serialize)]
    struct StopParams {
        session_id: Option<String>,
        all: bool,
    }
    #[derive(serde::Deserialize)]
    struct StopReply {
        stopped: Vec<String>,
        failed: Vec<StopFailure>,
        returned_tab_ids: Vec<i64>,
        return_failures: Vec<ReturnFailure>,
    }
    #[derive(serde::Deserialize)]
    struct StopFailure {
        session_id: String,
        code: ErrorCode,
        message: String,
    }

    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let result: StopReply = ipc
        .call(
            "stop",
            Method::SessionStop,
            Some(StopParams {
                session_id: Some(session_id.clone()),
                all: false,
            }),
            Duration::from_secs(15),
        )
        .await
        .unwrap()
        .expect("session.stop ok");

    assert!(result.stopped.is_empty());
    assert_eq!(result.failed.len(), 1);
    assert_eq!(result.failed[0].session_id, session_id);
    assert_eq!(result.failed[0].code, ErrorCode::CdpFailed);
    assert!(
        result.failed[0]
            .message
            .contains("failed to return borrowed tabs")
    );
    assert_eq!(result.returned_tab_ids, vec![7, 8]);
    assert_eq!(result.return_failures[0].tab_id, 9);
    assert_eq!(result.return_failures[0].code, ErrorCode::CdpFailed);
    assert!(
        handle
            .state()
            .sessions
            .get(&bsk::daemon::sessions::SessionId(session_id))
            .is_some(),
        "session must stay registered so failed tabs can be retried"
    );
    handle.shutdown().await;
}
