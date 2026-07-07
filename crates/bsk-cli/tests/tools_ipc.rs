//! M6 integration: drive `tool.*` RPCs (tab_list / screenshot /
//! snapshot / get_html) through the IPC + per-session queue + fake
//! extension and assert the wire shapes line up.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::{
    ConsoleEntry, ConsoleEntryKind, ConsoleParams, ConsoleResult, GetHtmlParams, GetHtmlResult,
    ScreenshotParams, ScreenshotResult, SessionStartParams, SessionStartResult, SnapshotParams,
    SnapshotResult, TabInfo, TabListParams, TabListResult, TabScope,
};
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, Frame, Method, RequestFrame, ResponseBody, ResponseFrame, RpcError,
};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::{Value, json};
use tokio::net::TcpListener;
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
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let sock = tempfile_path("bsk-test-tools");
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

/// Fake extension that auto-replies to `tool.session_start` /
/// `tool.session_stop` and routes everything else through a closure
/// supplied by the test.
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
                Method::ToolSessionStop => ResponseBody::Ok(json!({})),
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
async fn tab_list_round_trips_through_ipc_queue_and_ws() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| {
        // Echo a representative tab list result.
        assert_eq!(req.method, Method::ToolTabList);
        let _: TabListParams = serde_json::from_value(req.params.clone().unwrap()).unwrap();
        ResponseBody::Ok(
            serde_json::to_value(TabListResult {
                tabs: vec![TabInfo {
                    tab_id: 42,
                    title: Some("Example".into()),
                    url: Some("https://example.com/".into()),
                    window_id: Some(100),
                    active: Some(true),
                    scope: Some(TabScope::User),
                }],
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: TabListResult = ipc_tool_call(
        &sock,
        Method::ToolTabList,
        TabListParams {
            session_id: session_id.clone(),
            scope: TabScope::User,
        },
    )
    .await
    .expect("tab_list ok");
    assert_eq!(result.tabs.len(), 1);
    assert_eq!(result.tabs[0].tab_id, 42);
    assert_eq!(result.tabs[0].scope, Some(TabScope::User));
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn screenshot_returns_image_base64_with_dimensions() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| {
        assert_eq!(req.method, Method::ToolScreenshot);
        let _: ScreenshotParams = serde_json::from_value(req.params.clone().unwrap()).unwrap();
        ResponseBody::Ok(
            serde_json::to_value(ScreenshotResult {
                image_base64: "iVBORw0KGgo=".into(),
                width: 800,
                height: 600,
                format: "png".into(),
                tab_id: 7,
                dialogs: vec![],
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: ScreenshotResult = ipc_tool_call(
        &sock,
        Method::ToolScreenshot,
        ScreenshotParams {
            session_id,
            tab_id: Some(7),
            ref_: None,
        },
    )
    .await
    .expect("screenshot ok");
    assert_eq!(result.image_base64, "iVBORw0KGgo=");
    assert_eq!(result.width, 800);
    assert_eq!(result.height, 600);
    assert_eq!(result.tab_id, 7);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn screenshot_forwards_ref_to_extension() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| {
        assert_eq!(req.method, Method::ToolScreenshot);
        let params_value = req.params.clone().unwrap();
        let Value::Object(map) = &params_value else {
            panic!("screenshot params should be an object");
        };
        assert_eq!(map.get("ref").and_then(Value::as_str), Some("@e5"));
        assert!(map.get("ref_").is_none());
        let params: ScreenshotParams = serde_json::from_value(params_value).unwrap();
        assert_eq!(params.ref_.as_deref(), Some("@e5"));
        ResponseBody::Ok(
            serde_json::to_value(ScreenshotResult {
                image_base64: "iVBORw0KGgo=".into(),
                width: 100,
                height: 60,
                format: "png".into(),
                tab_id: 7,
                dialogs: vec![],
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: ScreenshotResult = ipc_tool_call(
        &sock,
        Method::ToolScreenshot,
        ScreenshotParams {
            session_id,
            tab_id: Some(7),
            ref_: Some("@e5".into()),
        },
    )
    .await
    .expect("screenshot with ref ok");
    assert_eq!(result.width, 100);
    assert_eq!(result.height, 60);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn console_returns_buffered_entries() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| {
        assert_eq!(req.method, Method::ToolConsole);
        let params: ConsoleParams = serde_json::from_value(req.params.clone().unwrap()).unwrap();
        assert_eq!(params.tab_id, Some(7));
        assert_eq!(params.since, Some(3));
        assert_eq!(params.limit, Some(50));
        assert_eq!(params.max_text_chars, Some(1000));
        assert_eq!(params.include_stack, Some(false));
        ResponseBody::Ok(
            serde_json::to_value(ConsoleResult {
                tab_id: 7,
                entries: vec![ConsoleEntry {
                    sequence: 4,
                    kind: ConsoleEntryKind::Console,
                    level: "warn".into(),
                    text: "deprecated API".into(),
                    url: Some("https://example.test/app.js".into()),
                    line: Some(10),
                    column: Some(2),
                    timestamp: None,
                    stack_trace: vec![],
                    truncated: false,
                }],
                next_since: 4,
                truncated: false,
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: ConsoleResult = ipc_tool_call(
        &sock,
        Method::ToolConsole,
        ConsoleParams {
            session_id,
            tab_id: Some(7),
            since: Some(3),
            limit: Some(50),
            max_text_chars: Some(1000),
            include_stack: Some(false),
        },
    )
    .await
    .expect("console ok");
    assert_eq!(result.tab_id, 7);
    assert_eq!(result.next_since, 4);
    assert_eq!(result.entries[0].text, "deprecated API");
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_returns_text_and_ref_count() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| {
        assert_eq!(req.method, Method::ToolSnapshot);
        let _: SnapshotParams = serde_json::from_value(req.params.clone().unwrap()).unwrap();
        ResponseBody::Ok(
            serde_json::to_value(SnapshotResult {
                text: "@e1 link \"home\"\n@e2 button \"submit\"\n".into(),
                ref_count: 2,
                tab_id: 13,
                truncated: false,
                dialogs: vec![],
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: SnapshotResult = ipc_tool_call(
        &sock,
        Method::ToolSnapshot,
        SnapshotParams {
            session_id,
            tab_id: None,
            max_depth: None,
            max_tokens: None,
        },
    )
    .await
    .expect("snapshot ok");
    assert_eq!(result.ref_count, 2);
    assert!(result.text.contains("@e1"));
    assert_eq!(result.tab_id, 13);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_html_round_trips_with_ref_alias() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;

    run_extension(ws, |req| {
        // Assert the wire payload uses `ref` (not `ref_`).
        let params = req.params.clone().unwrap();
        if let Value::Object(map) = &params {
            assert!(map.contains_key("ref"));
            assert!(!map.contains_key("ref_"));
        }
        let _: GetHtmlParams = serde_json::from_value(params).unwrap();
        ResponseBody::Ok(
            serde_json::to_value(GetHtmlResult {
                html: "<html><body>hi</body></html>".into(),
                truncated: false,
                byte_size: 28,
                tab_id: 4,
                dialogs: vec![],
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: GetHtmlResult = ipc_tool_call(
        &sock,
        Method::ToolGetHtml,
        GetHtmlParams {
            session_id,
            tab_id: Some(4),
            ref_: Some("e3".into()),
            max_bytes: None,
        },
    )
    .await
    .expect("get_html ok");
    assert_eq!(result.byte_size, 28);
    assert!(!result.truncated);
    assert_eq!(result.tab_id, 4);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_dispatch_rejects_missing_session_id() {
    let (handle, sock) = spawn_daemon().await;
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let outcome: Result<TabListResult, RpcError> = ipc
        .call::<Value, TabListResult>(
            "x",
            Method::ToolTabList,
            Some(json!({})),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    let err = outcome.expect_err("expected invalid_params");
    assert_eq!(err.code, ErrorCode::InvalidParams);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_dispatch_rejects_unknown_session() {
    let (handle, sock) = spawn_daemon().await;
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let outcome: Result<TabListResult, RpcError> = ipc
        .call::<Value, TabListResult>(
            "x",
            Method::ToolTabList,
            Some(json!({"session_id": "zzzz"})),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    let err = outcome.expect_err("expected not_found");
    assert_eq!(err.code, ErrorCode::NotFound);
    handle.shutdown().await;
}
