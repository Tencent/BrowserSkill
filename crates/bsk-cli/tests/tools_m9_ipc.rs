//! M9 integration: drive `tool.evaluate`, `tool.wait_for_navigation`,
//! and the daemon-local `tool.wait_ms` through the IPC + per-session
//! queue + fake extension. `wait_ms` is special — it never reaches
//! the extension, so the test does not run a fake-extension reply
//! callback for that method (it would be a sign of a regression if
//! the daemon dispatched it).

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::{
    EvaluateError, EvaluateParams, EvaluateResult, JavaScriptDialogHandledAction,
    JavaScriptDialogInfo, JavaScriptDialogType, SessionStartParams, SessionStartResult,
    WaitForNavigationParams, WaitForNavigationReached, WaitForNavigationResult, WaitMsParams,
    WaitMsResult, WaitUntil,
};
use bsk_protocol::{
    BrowserPeerInfo, CancelParams, CancelResult, ErrorCode, Frame, Method, RequestFrame,
    ResponseBody, ResponseFrame, RpcError,
};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::{Value, json};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::UnixStream;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

use support::wait_for_abort_registered;

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
    let sock = tempfile_path("bsk-test-tools-m9");
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

// ---------------------------------------------------------------------------
// tool.evaluate
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn evaluate_round_trips_ok_with_value() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |req| {
        assert_eq!(req.method, Method::ToolEvaluate);
        let p: EvaluateParams = serde_json::from_value(req.params.clone().unwrap()).unwrap();
        assert_eq!(p.expression, "1+1");
        assert_eq!(p.await_promise, Some(true));
        assert_eq!(p.return_by_value, Some(true));
        ResponseBody::Ok(
            serde_json::to_value(EvaluateResult {
                ok: true,
                tab_id: 4,
                value: Some(json!(2)),
                error: None,
                dialogs: vec![],
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: EvaluateResult = ipc_tool_call(
        &sock,
        Method::ToolEvaluate,
        EvaluateParams {
            session_id,
            expression: "1+1".into(),
            tab_id: None,
            await_promise: Some(true),
            return_by_value: Some(true),
            timeout_ms: None,
        },
    )
    .await
    .expect("evaluate ok");
    assert!(result.ok);
    assert_eq!(result.value, Some(json!(2)));
    assert!(result.error.is_none());
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn evaluate_round_trips_dialogs_payload() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |_req| {
        ResponseBody::Ok(
            serde_json::to_value(EvaluateResult {
                ok: true,
                tab_id: 4,
                value: Some(json!("done")),
                error: None,
                dialogs: vec![JavaScriptDialogInfo {
                    tab_id: 4,
                    dialog_type: JavaScriptDialogType::Alert,
                    message: "hello".into(),
                    url: Some("https://example.com/".into()),
                    default_prompt: None,
                    has_browser_handler: Some(false),
                    handled: JavaScriptDialogHandledAction::Accepted,
                    sequence: 1,
                }],
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: EvaluateResult = ipc_tool_call(
        &sock,
        Method::ToolEvaluate,
        EvaluateParams {
            session_id,
            expression: "alert('hello')".into(),
            tab_id: None,
            await_promise: None,
            return_by_value: None,
            timeout_ms: None,
        },
    )
    .await
    .expect("evaluate ok");
    assert_eq!(result.dialogs.len(), 1);
    assert_eq!(result.dialogs[0].message, "hello");
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn evaluate_round_trips_exception_as_in_band_error() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |_req| {
        ResponseBody::Ok(
            serde_json::to_value(EvaluateResult {
                ok: false,
                tab_id: 4,
                value: None,
                error: Some(EvaluateError {
                    text: "Uncaught Error: boom".into(),
                    line: Some(0),
                    column: Some(6),
                }),
                dialogs: vec![],
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: EvaluateResult = ipc_tool_call(
        &sock,
        Method::ToolEvaluate,
        EvaluateParams {
            session_id,
            expression: "throw new Error('boom')".into(),
            tab_id: None,
            await_promise: None,
            return_by_value: None,
            timeout_ms: None,
        },
    )
    .await
    .expect("evaluate call must itself succeed (the throw is in-band)");
    assert!(!result.ok);
    let err = result.error.expect("expected in-band error");
    assert!(err.text.contains("boom"));
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn evaluate_propagates_permission_denied() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |_req| {
        ResponseBody::Err(RpcError {
            code: ErrorCode::PermissionDenied,
            message: "evaluate can only act on tabs inside the Agent Window".into(),
            data: None,
        })
    });

    let session_id = ipc_session_start(&sock).await;
    let err = ipc_tool_call::<_, Value>(
        &sock,
        Method::ToolEvaluate,
        EvaluateParams {
            session_id,
            expression: "1+1".into(),
            tab_id: Some(11),
            await_promise: None,
            return_by_value: None,
            timeout_ms: None,
        },
    )
    .await
    .expect_err("expected permission_denied");
    assert_eq!(err.code, ErrorCode::PermissionDenied);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn evaluate_returns_not_found_for_unknown_session() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |_| {
        panic!("unknown session must short-circuit before reaching the extension")
    });

    let err = ipc_tool_call::<_, Value>(
        &sock,
        Method::ToolEvaluate,
        EvaluateParams {
            session_id: "zzzz".into(),
            expression: "1+1".into(),
            tab_id: None,
            await_promise: None,
            return_by_value: None,
            timeout_ms: None,
        },
    )
    .await
    .expect_err("expected not_found");
    assert_eq!(err.code, ErrorCode::NotFound);
    handle.shutdown().await;
}

// ---------------------------------------------------------------------------
// tool.wait_for_navigation
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_for_navigation_round_trips_reached() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |req| {
        assert_eq!(req.method, Method::ToolWaitForNavigation);
        let p: WaitForNavigationParams =
            serde_json::from_value(req.params.clone().unwrap()).unwrap();
        assert_eq!(p.wait_until, Some(WaitUntil::Load));
        ResponseBody::Ok(
            serde_json::to_value(WaitForNavigationResult {
                tab_id: 4,
                reached: WaitForNavigationReached::Load,
                error_text: None,
                dialogs: vec![],
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: WaitForNavigationResult = ipc_tool_call(
        &sock,
        Method::ToolWaitForNavigation,
        WaitForNavigationParams {
            session_id,
            tab_id: None,
            wait_until: Some(WaitUntil::Load),
            timeout_ms: Some(1_000),
        },
    )
    .await
    .expect("wait_for_navigation ok");
    assert_eq!(result.tab_id, 4);
    assert_eq!(result.reached, WaitForNavigationReached::Load);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_for_navigation_reports_timeout_payload() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |_req| {
        ResponseBody::Ok(
            serde_json::to_value(WaitForNavigationResult {
                tab_id: 4,
                reached: WaitForNavigationReached::Timeout,
                error_text: Some("timed out waiting for lifecycle \"load\"".into()),
                dialogs: vec![],
            })
            .unwrap(),
        )
    });

    let session_id = ipc_session_start(&sock).await;
    let result: WaitForNavigationResult = ipc_tool_call(
        &sock,
        Method::ToolWaitForNavigation,
        WaitForNavigationParams {
            session_id,
            tab_id: None,
            wait_until: Some(WaitUntil::Load),
            timeout_ms: Some(25),
        },
    )
    .await
    .expect("wait_for_navigation ok");
    assert_eq!(result.reached, WaitForNavigationReached::Timeout);
    assert!(result.error_text.unwrap().contains("timed out"));
    handle.shutdown().await;
}

// ---------------------------------------------------------------------------
// tool.wait_ms (daemon-local, never reaches the extension)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_ms_short_duration_returns_quickly() {
    let (handle, sock) = spawn_daemon().await;
    // Connect a stub extension so the daemon's `BrowserRegistry` is
    // populated; wait_ms itself never sends WS traffic.
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |_req| panic!("wait_ms must not reach the extension"));

    let result: WaitMsResult =
        ipc_tool_call(&sock, Method::ToolWaitMs, WaitMsParams { duration_ms: 100 })
            .await
            .expect("wait_ms ok");
    assert_eq!(result.waited_ms, 100);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_ms_zero_short_circuits() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |_| panic!("wait_ms must not reach the extension"));

    let result: WaitMsResult =
        ipc_tool_call(&sock, Method::ToolWaitMs, WaitMsParams { duration_ms: 0 })
            .await
            .expect("wait_ms ok");
    assert_eq!(result.waited_ms, 0);
    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_ms_rejects_over_limit_duration() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |_| panic!("wait_ms must not reach the extension"));

    let err = ipc_tool_call::<_, Value>(
        &sock,
        Method::ToolWaitMs,
        WaitMsParams {
            duration_ms: 5 * 60 * 1_000 + 1,
        },
    )
    .await
    .expect_err("expected invalid_params");
    assert_eq!(err.code, ErrorCode::InvalidParams);
    assert!(err.message.to_lowercase().contains("exceeds"));
    handle.shutdown().await;
}

// The cancel end-to-end test needs to issue two concurrent IPC calls
// on the same daemon (wait_ms on conn1 + cancel on conn2). Doing that
// from raw `IpcClient` would require splitting `call` into write/read
// halves; on Unix we drop straight to `UnixStream` instead. The
// Windows side relies on the unit tests in `daemon::ipc::tests` for
// the same coverage (which exercise `handle_wait_ms` directly).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_ms_cancellation_returns_cancelled_via_method_cancel() {
    // End-to-end abort path: open a UDS connection, fire `tool.wait_ms`
    // with a deliberate id, fire `cancel { rpc_id }` from a *second*
    // connection ~100ms later, observe the original wait return
    // ErrorCode::Cancelled. Mirrors the design §5 cancel envelope so
    // M10.2 only has to wire SIGINT onto it.
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |_| panic!("wait_ms must not reach the extension"));

    // Connection #1 — issue the wait_ms.
    let stream = UnixStream::connect(&sock).await.unwrap();
    let (read, mut write) = stream.into_split();
    let wait_frame = Frame::Request(RequestFrame {
        id: "wait-cancel-1".into(),
        method: Method::ToolWaitMs,
        params: Some(serde_json::to_value(WaitMsParams { duration_ms: 5_000 }).unwrap()),
    });
    let mut line = serde_json::to_string(&wait_frame).unwrap();
    line.push('\n');
    write.write_all(line.as_bytes()).await.unwrap();
    write.flush().await.unwrap();

    let state = handle.state();
    wait_for_abort_registered(&state, &"wait-cancel-1".into()).await;

    // Connection #2 — issue the cancel.
    let mut cancel_client = IpcClient::connect(&sock).await.unwrap();
    let cancel_reply: CancelResult = cancel_client
        .call::<_, CancelResult>(
            "cancel-1",
            Method::Cancel,
            Some(CancelParams {
                rpc_id: "wait-cancel-1".into(),
            }),
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .expect("cancel ok");
    assert!(cancel_reply.cancelled);

    // Read connection #1's response — must be Cancelled, must arrive
    // long before the 5000ms sleep would have completed.
    let mut reader = BufReader::new(read);
    let mut buf = String::new();
    let start = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut buf))
        .await
        .expect("wait_ms cancellation must propagate fast")
        .unwrap();
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "wait_ms cancellation took too long: {elapsed:?}"
    );
    let frame: Frame = serde_json::from_str(buf.trim_end()).unwrap();
    match frame {
        Frame::Response(resp) => {
            assert_eq!(resp.id, "wait-cancel-1");
            match resp.body {
                ResponseBody::Err(err) => assert_eq!(err.code, ErrorCode::Cancelled),
                other => panic!("expected cancelled, got {other:?}"),
            }
        }
        other => panic!("unexpected frame {other:?}"),
    }

    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_unknown_rpc_returns_false_without_error() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = do_handshake(&mut ws).await;
    run_extension(ws, |_| panic!("cancel must not reach the extension"));

    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let reply: CancelResult = ipc
        .call::<_, CancelResult>(
            "cancel-noop",
            Method::Cancel,
            Some(CancelParams {
                rpc_id: "ghost".into(),
            }),
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .expect("cancel ok");
    assert!(!reply.cancelled);
    handle.shutdown().await;
}
