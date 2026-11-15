//! Wave 4b top-level E2E regressions:
//! 1. Unified `tool_pipeline` cancellation across `session.user_interrupt` and `session.window_closed`
//!    (`teardown_session`), waking in-flight `tool.video(stop|status)`, `tool.operation_await`, and
//!    scope-bound `tool.wait_ms` immediately while forwarding WS `cancel` frames.
//! 2. Exhaustive `OutcomeKind` / `Outcome` deadline cleanup attribution in `queue.rs`, ensuring
//!    non-transfer tools (`ToolNavigate`, `ToolScreenshotFullPage`, `ToolWindowResize`) never emit
//!    `transfer_outcome_unknown` or `"file transfer timed out"` when extension cancel cleanup hangs.
//! 3. Non-blocking persistence across `TransferRegistry`, `AuditStore`, and `IntentWal`, keeping
//!    concurrent `system.status` and `ledger.request` responsive during multi-MB staging/import I/O
//!    and leaving zero orphan transfer directories when `session.stop` races `import_download`.
//! 4. Shared `cli::orchestration` parity across `bsk` CLI and `bsk mcp`: Canvas screenshot point-click
//!    validation, `bsk sync --wait-for --timeout-ms 60000` bounds, structured `scope_browser_conflict`
//!    on `open`, and MCP `CANCEL_RESPONSE_GRACE` settlement releasing staged upload transfers on
//!    `notifications/cancelled`.

use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::{IpcClient, IpcRequestMeta};
use bsk_protocol::system::{HandshakeParams, HandshakeResult, StatusResult};
use bsk_protocol::tools::{
    DownloadParams, DownloadResult, SessionStartResult, TransferBeginParams, TransferBeginResult,
    TransferChunkParams, TransferChunkResult, TransferIdParams, TransferReadParams,
    TransferReadyResult, TransferReleaseResult,
};
use bsk_protocol::{
    BrowserPeerInfo, DialogChangedEvent, ErrorCode, EventFrame, Frame, Method, RequestFrame,
    ResponseBody, ResponseFrame, RpcErrorReason, SessionUserInterruptEvent,
    SessionWindowClosedEvent, SessionWindowClosedReason,
};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

const TEST_EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

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

async fn do_handshake(ws: &mut Ws, instance_id: &str, label: &str) -> HandshakeResult {
    let params = HandshakeParams {
        client: bsk_protocol::EXTENSION_CLIENT_ID.into(),
        version: "0.5.0".parse().unwrap(),
        protocol_version: bsk::daemon::state::PROTOCOL_VERSION.into(),
        instance_id: instance_id.into(),
        browser: BrowserPeerInfo {
            name: "chrome".into(),
            version: "136.0".into(),
        },
        min_compatible_peer: Some("0.5.0".parse().unwrap()),
        min_compatible_protocol: Some(bsk::daemon::state::MIN_COMPATIBLE_PROTOCOL.into()),
        label: label.into(),
    };
    let req = RequestFrame {
        id: "hs".into(),
        method: Method::SystemHandshake,
        params: Some(serde_json::to_value(params).unwrap()),
        audit_id: None,
        operation_id: None,
    };
    ws.send(Message::Text(serde_json::to_string(&req).unwrap()))
        .await
        .unwrap();
    let resp = ws.next().await.unwrap().unwrap();
    let Message::Text(text) = resp else {
        panic!("expected handshake text frame");
    };
    let frame: ResponseFrame = serde_json::from_str(&text).unwrap();
    match frame.body {
        ResponseBody::Ok(v) => serde_json::from_value(v).unwrap(),
        ResponseBody::Err(e) => panic!("handshake rejected: {e:?}"),
    }
}

async fn run_bsk_at(home: &Path, args: &[&str], envs: &[(&str, &str)]) -> std::process::Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
    cmd.env("BSK_HOME", home)
        .env("BSK_AUTO_START", "0")
        .env("BSK_AUTO_UPDATE", "off")
        .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
        .env_remove("BSK_SESSION")
        .env_remove("BSK_SCOPE")
        .env_remove("CLAUDE_CODE_AGENT_ID")
        .env_remove("CODEX_THREAD_ID")
        .env_remove("ANTIGRAVITY_CONVERSATION_ID")
        .env_remove("CURSOR_TRACE_ID")
        .env_remove("DSH_SESSION_ID")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let child = cmd.spawn().unwrap();
    tokio::time::timeout(Duration::from_secs(10), child.wait_with_output())
        .await
        .unwrap()
        .unwrap()
}

struct McpProcess {
    _child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl McpProcess {
    async fn spawn(home: &Path, envs: &[(&str, &str)]) -> Self {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
        cmd.arg("mcp")
            .env("BSK_HOME", home)
            .env("BSK_AUTO_START", "0")
            .env("BSK_AUTO_UPDATE", "off")
            .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
            .env_remove("BSK_SESSION")
            .env_remove("BSK_SCOPE")
            .env_remove("CLAUDE_CODE_AGENT_ID")
            .env_remove("CODEX_THREAD_ID")
            .env_remove("ANTIGRAVITY_CONVERSATION_ID")
            .env_remove("CURSOR_TRACE_ID")
            .env_remove("DSH_SESSION_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in envs {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("spawn bsk mcp");
        let stdin = child.stdin.take().expect("mcp stdin");
        let stdout = BufReader::new(child.stdout.take().expect("mcp stdout"));
        let mut proc = Self {
            _child: child,
            stdin: Some(stdin),
            stdout,
            next_id: 1,
        };
        let init = proc
            .rpc(
                "initialize",
                json!({
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": { "name": "wave4b-e2e", "version": "1.0" }
                }),
            )
            .await;
        assert!(init["result"]["protocolVersion"].is_string());
        proc.notify("notifications/initialized", json!({})).await;
        proc
    }

    async fn send_raw(&mut self, msg: &Value) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        let line = serde_json::to_string(msg).unwrap();
        stdin.write_all(line.as_bytes()).await.unwrap();
        stdin.write_all(b"\n").await.unwrap();
        stdin.flush().await.unwrap();
    }

    async fn notify(&mut self, method: &str, params: Value) {
        self.send_raw(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await;
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send_raw(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await;
        self.read_reply().await
    }

    async fn read_reply(&mut self) -> Value {
        let mut out = String::new();
        tokio::time::timeout(Duration::from_secs(10), self.stdout.read_line(&mut out))
            .await
            .expect("mcp reply timed out")
            .expect("read mcp line");
        serde_json::from_str(out.trim_end()).expect("parse mcp json")
    }

    async fn call_tool(&mut self, name: &str, arguments: Value) -> Value {
        let resp = self
            .rpc(
                "tools/call",
                json!({
                    "name": name,
                    "arguments": arguments,
                }),
            )
            .await;
        resp["result"].clone()
    }

    /// Wait until a cancelled request `cancelled_id` has finished end-to-end
    /// (both daemon queue/WAL settlement and `bsk mcp` task cleanup) by probing
    /// `bsk_ledger(status)` under `cancelled_id` until `server.calls` releases it.
    async fn await_cancelled_settled(&mut self, cancelled_id: u64, session: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            self.send_raw(&json!({
                "jsonrpc": "2.0",
                "id": cancelled_id,
                "method": "tools/call",
                "params": {
                    "name": "bsk_ledger",
                    "arguments": {
                        "action": "status",
                        "session": session
                    }
                }
            }))
            .await;
            let reply = self.read_reply().await;
            if reply.get("result").is_some() {
                return reply["result"].clone();
            }
            assert!(
                Instant::now() < deadline,
                "cancelled MCP request {cancelled_id} did not settle within deadline: {reply}"
            );
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    }
}

async fn send_ws_event(writer: &Arc<tokio::sync::Mutex<SplitSink<Ws, Message>>>, ev: EventFrame) {
    let text = serde_json::to_string(&ev).unwrap();
    writer.lock().await.send(Message::Text(text)).await.unwrap();
}

async fn send_ws_response(
    writer: &Arc<tokio::sync::Mutex<SplitSink<Ws, Message>>>,
    id: String,
    body: ResponseBody,
) {
    let resp = ResponseFrame { id, body };
    let text = serde_json::to_string(&resp).unwrap();
    writer.lock().await.send(Message::Text(text)).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_window_closed_and_user_interrupt_cancel_inflight_video_and_operation_await() {
    let home = crate::support::short_tempdir();
    let sock = home.path().join("ipc.sock");
    let config =
        DaemonConfig::new(0).with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal);
    let handle = daemon::run(config, Some(sock.clone())).await.unwrap();
    let ws = connect_ext(handle.ws_addr()).await;
    let (writer, mut reader): (SplitSink<Ws, Message>, SplitStream<Ws>) = ws.split();
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

    // Handshake manually on split stream.
    {
        let hs = RequestFrame {
            id: "hs".into(),
            method: Method::SystemHandshake,
            params: Some(
                serde_json::to_value(HandshakeParams {
                    client: bsk_protocol::EXTENSION_CLIENT_ID.into(),
                    version: "0.5.0".parse().unwrap(),
                    protocol_version: bsk::daemon::state::PROTOCOL_VERSION.into(),
                    instance_id: TEST_EXT_ID.into(),
                    browser: BrowserPeerInfo {
                        name: "chrome".into(),
                        version: "136.0".into(),
                    },
                    min_compatible_peer: Some("0.5.0".parse().unwrap()),
                    min_compatible_protocol: Some(
                        bsk::daemon::state::MIN_COMPATIBLE_PROTOCOL.into(),
                    ),
                    label: "Wave4BMock".into(),
                })
                .unwrap(),
            ),
            audit_id: None,
            operation_id: None,
        };
        writer
            .lock()
            .await
            .send(Message::Text(serde_json::to_string(&hs).unwrap()))
            .await
            .unwrap();
        let _ = reader.next().await.unwrap().unwrap();
    }

    let (video_req_tx, mut video_req_rx) = tokio::sync::mpsc::unbounded_channel::<RequestFrame>();
    let (eval_req_tx, mut eval_req_rx) = tokio::sync::mpsc::unbounded_channel::<RequestFrame>();
    let (cancel_tx, mut cancel_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer_bg = Arc::clone(&writer);
    tokio::spawn(async move {
        let mut win_id = 100i64;
        while let Some(Ok(Message::Text(text))) = reader.next().await {
            let Ok(Frame::Request(req)) = serde_json::from_str::<Frame>(&text) else {
                continue;
            };
            match req.method {
                Method::ToolSessionStart => {
                    win_id += 1;
                    send_ws_response(
                        &writer_bg,
                        req.id,
                        ResponseBody::Ok(
                            serde_json::to_value(SessionStartResult {
                                interaction: None,
                                agent_window_id: Some(win_id),
                            })
                            .unwrap(),
                        ),
                    )
                    .await;
                }
                Method::ToolVideo => {
                    let _ = video_req_tx.send(req);
                }
                Method::ToolEvaluate => {
                    let _ = eval_req_tx.send(req);
                }
                Method::Cancel => {
                    let target = req.params.unwrap()["rpc_id"].as_str().unwrap().to_owned();
                    let _ = cancel_tx.send(target);
                    send_ws_response(
                        &writer_bg,
                        req.id,
                        ResponseBody::Ok(json!({ "cancelled": true })),
                    )
                    .await;
                }
                _ => {}
            }
        }
    });

    // --- Part 1: `session.user_interrupt` cancels in-flight `tool.video(stop)` and wakes `operation_await` ---
    let mut admin = IpcClient::connect(&sock).await.unwrap();
    let s1_val: Value = admin
        .call(
            "start-s1",
            Method::SessionStart,
            Some(json!({})),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    let s1 = s1_val["session_id"].as_str().unwrap().to_owned();

    // Suspend a `tool.evaluate` with a native dialog so `operation_await` has a real pending operation.
    let eval_sock = sock.clone();
    let s1_eval = s1.clone();
    let eval_task = tokio::spawn(async move {
        let mut c = IpcClient::connect(&eval_sock).await.unwrap();
        c.call_envelope_with_id::<Value, Value>(
            "eval-s1".into(),
            Method::ToolEvaluate,
            Some(json!({ "session_id": s1_eval, "expression": "alert('hi')" })),
            IpcRequestMeta::default(),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .0
    });
    let eval_req = eval_req_rx.recv().await.unwrap();
    let op_s1 = eval_req.operation_id.clone().expect("operation_id on WS");
    send_ws_event(
        &writer,
        EventFrame::DialogChanged(DialogChangedEvent {
            session_id: s1.clone(),
            tab_id: Some(7),
            dialog: Some(
                serde_json::from_value(json!({
                    "id": "dlg-1",
                    "tab_id": 7,
                    "type": "alert",
                    "message": "hi",
                    "sequence": 1,
                    "decision_deadline": 60000
                }))
                .unwrap(),
            ),
            operation_id: Some(op_s1.clone()),
        }),
    )
    .await;
    let eval_err = eval_task.await.unwrap().unwrap_err();
    assert_eq!(eval_err.code, ErrorCode::DialogPending);
    // Dialog closes while the retained `tool.evaluate` continues running, so `operation_await` blocks on `Progress::Running`.
    send_ws_event(
        &writer,
        EventFrame::DialogChanged(DialogChangedEvent {
            session_id: s1.clone(),
            tab_id: Some(7),
            dialog: None,
            operation_id: Some(op_s1.clone()),
        }),
    )
    .await;
    let dlg_clear_deadline = Instant::now() + Duration::from_secs(2);
    while handle
        .state()
        .dialog_operations
        .active_dialog_tab_id(&s1)
        .is_some()
    {
        assert!(
            Instant::now() < dlg_clear_deadline,
            "DialogChanged(None) for s1 was not processed in time"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    // Launch `tool.operation_await(wait_ms: 60_000)` + `tool.video(capabilities)` concurrently on `s1`.
    let await_sock = sock.clone();
    let s1_await = s1.clone();
    let await_task = tokio::spawn(async move {
        let mut c = IpcClient::connect(&await_sock).await.unwrap();
        c.call_envelope_with_id::<Value, Value>(
            "await-s1".into(),
            Method::ToolOperationAwait,
            Some(json!({
                "session_id": s1_await,
                "operation_id": op_s1,
                "wait_ms": 60_000
            })),
            IpcRequestMeta::default(),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .0
    });

    let video_sock = sock.clone();
    let s1_vid = s1.clone();
    let video_task = tokio::spawn(async move {
        let mut c = IpcClient::connect(&video_sock).await.unwrap();
        c.call_envelope_with_id::<Value, Value>(
            "video-cap-s1".into(),
            Method::ToolVideo,
            Some(json!({
                "action": "capabilities",
                "session_id": s1_vid
            })),
            IpcRequestMeta::default(),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .0
    });

    let video_ws_req = video_req_rx.recv().await.unwrap();
    // Ensure `operation_await` has registered in `tool_inflight`.
    let deadline = Instant::now() + Duration::from_secs(2);
    while handle
        .state()
        .tool_inflight
        .get(&"await-s1".into())
        .is_none()
    {
        assert!(Instant::now() < deadline, "await-s1 never registered");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let t0 = Instant::now();
    send_ws_event(
        &writer,
        EventFrame::SessionUserInterrupt(SessionUserInterruptEvent {
            session_id: s1.clone(),
        }),
    )
    .await;

    let mut cancelled_s1 = Vec::new();
    for _ in 0..2 {
        let cid = tokio::time::timeout(Duration::from_secs(2), cancel_rx.recv())
            .await
            .expect("WS cancel forwarded on user_interrupt")
            .unwrap();
        cancelled_s1.push(cid);
    }
    assert!(cancelled_s1.contains(&video_ws_req.id));
    assert!(cancelled_s1.contains(&eval_req.id));

    let await_err = tokio::time::timeout(Duration::from_secs(2), await_task)
        .await
        .expect("operation_await woke immediately on user_interrupt")
        .unwrap()
        .unwrap_err();
    assert_eq!(await_err.code, ErrorCode::UserAborted);
    assert!(t0.elapsed() < Duration::from_secs(2));

    let video_err = tokio::time::timeout(Duration::from_secs(2), video_task)
        .await
        .expect("video capabilities settled immediately on user_interrupt")
        .unwrap()
        .unwrap_err();
    assert_eq!(video_err.code, ErrorCode::UserAborted);

    // Also verify browser-scoped `tool.video(stop)` registers in `tool_inflight` and forwards WS `cancel`
    // immediately when peer `cancel { rpc_id }` arrives.
    let video_stop_sock = sock.clone();
    let video_stop_task = tokio::spawn(async move {
        let mut c = IpcClient::connect(&video_stop_sock).await.unwrap();
        c.call_envelope_with_id::<Value, Value>(
            "video-stop-peer".into(),
            Method::ToolVideo,
            Some(json!({
                "action": "stop",
                "browser": TEST_EXT_ID,
                "recording_id": "vid_0123456789abcdef0123456789abcdef",
                "capability": "cap_secret_1"
            })),
            IpcRequestMeta::default(),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .0
    });
    let video_stop_ws = video_req_rx.recv().await.unwrap();
    let cancel_reply: Value = admin
        .call(
            "cancel-video-stop",
            Method::Cancel,
            Some(json!({ "rpc_id": "video-stop-peer" })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cancel_reply["cancelled"], true);
    let cancelled_stop_ws = tokio::time::timeout(Duration::from_secs(2), cancel_rx.recv())
        .await
        .expect("WS cancel forwarded for video stop")
        .unwrap();
    assert_eq!(cancelled_stop_ws, video_stop_ws.id);
    let stop_err = tokio::time::timeout(Duration::from_secs(2), video_stop_task)
        .await
        .expect("video stop settled immediately on peer cancel")
        .unwrap()
        .unwrap_err();
    assert_eq!(stop_err.code, ErrorCode::Cancelled);

    // --- Part 2: `session.window_closed` tears down `s2`, waking `video(capabilities)`, `operation_await`, and `wait_ms` ---
    let (s2_val, _) = admin
        .call_envelope::<Value, Value>(
            "start-s2",
            Method::SessionStart,
            Some(json!({})),
            IpcRequestMeta {
                caller_scope: Some("scope-s2".into()),
                bind_scope: true,
                reuse_or_start_scope: false,
                explicit_incognito: false,
                return_scope_meta: false,
            },
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    let s2 = s2_val.unwrap()["session_id"].as_str().unwrap().to_owned();

    let eval_sock2 = sock.clone();
    let s2_eval = s2.clone();
    let eval_task2 = tokio::spawn(async move {
        let mut c = IpcClient::connect(&eval_sock2).await.unwrap();
        c.call_envelope_with_id::<Value, Value>(
            "eval-s2".into(),
            Method::ToolEvaluate,
            Some(json!({ "session_id": s2_eval, "expression": "confirm('sure?')" })),
            IpcRequestMeta::default(),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .0
    });
    let eval_req2 = eval_req_rx.recv().await.unwrap();
    let op_s2 = eval_req2.operation_id.clone().unwrap();
    send_ws_event(
        &writer,
        EventFrame::DialogChanged(DialogChangedEvent {
            session_id: s2.clone(),
            tab_id: Some(9),
            dialog: Some(
                serde_json::from_value(json!({
                    "id": "dlg-2",
                    "tab_id": 9,
                    "type": "confirm",
                    "message": "sure?",
                    "sequence": 1,
                    "decision_deadline": 60000
                }))
                .unwrap(),
            ),
            operation_id: Some(op_s2.clone()),
        }),
    )
    .await;
    assert_eq!(
        eval_task2.await.unwrap().unwrap_err().code,
        ErrorCode::DialogPending
    );
    send_ws_event(
        &writer,
        EventFrame::DialogChanged(DialogChangedEvent {
            session_id: s2.clone(),
            tab_id: Some(9),
            dialog: None,
            operation_id: Some(op_s2.clone()),
        }),
    )
    .await;
    let dlg_clear_deadline2 = Instant::now() + Duration::from_secs(2);
    while handle
        .state()
        .dialog_operations
        .active_dialog_tab_id(&s2)
        .is_some()
    {
        assert!(
            Instant::now() < dlg_clear_deadline2,
            "DialogChanged(None) for s2 was not processed in time"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let await_sock2 = sock.clone();
    let s2_await = s2.clone();
    let await_task2 = tokio::spawn(async move {
        let mut c = IpcClient::connect(&await_sock2).await.unwrap();
        c.call_envelope_with_id::<Value, Value>(
            "await-s2".into(),
            Method::ToolOperationAwait,
            Some(json!({
                "session_id": s2_await,
                "operation_id": op_s2,
                "wait_ms": 60_000
            })),
            IpcRequestMeta::default(),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .0
    });

    let video_sock2 = sock.clone();
    let s2_vid = s2.clone();
    let video_task2 = tokio::spawn(async move {
        let mut c = IpcClient::connect(&video_sock2).await.unwrap();
        c.call_envelope_with_id::<Value, Value>(
            "video-cap-s2".into(),
            Method::ToolVideo,
            Some(json!({
                "action": "capabilities",
                "session_id": s2_vid
            })),
            IpcRequestMeta::default(),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .0
    });

    let wait_sock2 = sock.clone();
    let wait_task2 = tokio::spawn(async move {
        let mut c = IpcClient::connect(&wait_sock2).await.unwrap();
        c.call_envelope_with_id::<Value, Value>(
            "wait-ms-s2".into(),
            Method::ToolWaitMs,
            Some(json!({ "duration_ms": 60_000 })),
            IpcRequestMeta {
                caller_scope: Some("scope-s2".into()),
                ..Default::default()
            },
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .0
    });

    let video_ws_req2 = video_req_rx.recv().await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while handle
        .state()
        .tool_inflight
        .get(&"await-s2".into())
        .is_none()
        || handle
            .state()
            .tool_inflight
            .get(&"wait-ms-s2".into())
            .is_none()
    {
        assert!(Instant::now() < deadline, "s2 waiters never registered");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let t1 = Instant::now();
    send_ws_event(
        &writer,
        EventFrame::SessionWindowClosed(SessionWindowClosedEvent {
            session_id: s2.clone(),
            reason: Some(SessionWindowClosedReason::UserClosedWindow),
            return_failures: Vec::new(),
        }),
    )
    .await;

    // Both `video-status-s2` AND dialog-retained `eval-s2` receive WS `cancel` frames on teardown!
    let mut cancelled_s2 = Vec::new();
    for _ in 0..2 {
        let cid = tokio::time::timeout(Duration::from_secs(2), cancel_rx.recv())
            .await
            .expect("WS cancel forwarded on session.window_closed")
            .unwrap();
        cancelled_s2.push(cid);
    }
    assert!(cancelled_s2.contains(&video_ws_req2.id));
    assert!(cancelled_s2.contains(&eval_req2.id));

    send_ws_response(
        &writer,
        video_ws_req2.id,
        ResponseBody::Err(bsk_protocol::RpcError {
            code: ErrorCode::Cancelled,
            message: "session closed".into(),
            data: None,
        }),
    )
    .await;

    for (label, err) in [
        (
            "operation_await",
            tokio::time::timeout(Duration::from_secs(2), await_task2)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err(),
        ),
        (
            "video_status",
            tokio::time::timeout(Duration::from_secs(2), video_task2)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err(),
        ),
        (
            "wait_ms",
            tokio::time::timeout(Duration::from_secs(2), wait_task2)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err(),
        ),
    ] {
        assert_eq!(err.code, ErrorCode::NotFound, "{label} error code");
        assert_eq!(
            err.data.as_ref().unwrap()["reason"],
            RpcErrorReason::SessionWindowClosed.as_str(),
            "{label} reason"
        );
    }
    assert!(t1.elapsed() < Duration::from_secs(2));

    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn non_transfer_deadline_cleanup_failure_never_misattributes_file_transfer() {
    let home = crate::support::short_tempdir();
    let sock = home.path().join("ipc.sock");
    let config =
        DaemonConfig::new(0).with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal);
    let handle = daemon::run(config, Some(sock.clone())).await.unwrap();
    let mut ws = connect_ext(handle.ws_addr()).await;
    do_handshake(&mut ws, TEST_EXT_ID, "Wave4BTimeoutChrome").await;

    let (writer, mut reader): (SplitSink<Ws, Message>, SplitStream<Ws>) = ws.split();
    let writer = Arc::new(tokio::sync::Mutex::new(writer));
    let cancel_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let cancel_count_bg = Arc::clone(&cancel_count);
    let writer_bg = Arc::clone(&writer);
    tokio::spawn(async move {
        let mut win_id = 200i64;
        while let Some(Ok(Message::Text(text))) = reader.next().await {
            let Ok(Frame::Request(req)) = serde_json::from_str::<Frame>(&text) else {
                continue;
            };
            match req.method {
                Method::ToolSessionStart => {
                    win_id += 1;
                    send_ws_response(
                        &writer_bg,
                        req.id,
                        ResponseBody::Ok(
                            serde_json::to_value(SessionStartResult {
                                interaction: None,
                                agent_window_id: Some(win_id),
                            })
                            .unwrap(),
                        ),
                    )
                    .await;
                }
                Method::Cancel => {
                    cancel_count_bg.fetch_add(1, Ordering::SeqCst);
                    send_ws_response(
                        &writer_bg,
                        req.id,
                        ResponseBody::Ok(json!({ "cancelled": true })),
                    )
                    .await;
                }
                // Deliberately ignore ToolNavigate, ToolScreenshotFullPage, and ToolWindowResize
                // even after WS `cancel` arrives, triggering `WaitOutcome::TimeoutCleanupFailed`.
                _ => {}
            }
        }
    });

    let mut admin = IpcClient::connect(&sock).await.unwrap();
    let mut sessions = Vec::new();
    for idx in 0..3 {
        let started: Value = admin
            .call(
                &format!("start-{idx}"),
                Method::SessionStart,
                Some(json!({})),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
            .unwrap();
        sessions.push(started["session_id"].as_str().unwrap().to_owned());
    }

    let cases = [
        (
            "navigate",
            Method::ToolNavigate,
            json!({
                "session_id": sessions[0],
                "url": "https://example.test/hang",
                "timeout_ms": 40
            }),
        ),
        (
            "screenshot_full_page",
            Method::ToolScreenshotFullPage,
            json!({
                "session_id": sessions[1],
                "timeout_ms": 40
            }),
        ),
        (
            "window_resize",
            Method::ToolWindowResize,
            json!({
                "session_id": sessions[2],
                "width": 1280,
                "height": 800,
                "timeout_ms": 40
            }),
        ),
    ];

    let mut tasks = Vec::new();
    for (name, method, payload) in cases {
        let sock_clone = sock.clone();
        tasks.push(tokio::spawn(async move {
            let mut client = IpcClient::connect(&sock_clone).await.unwrap();
            let err = client
                .call::<Value, Value>(name, method, Some(payload), Duration::from_secs(10))
                .await
                .unwrap()
                .unwrap_err();
            (name, err)
        }));
    }

    for task in tasks {
        let (name, err) = task.await.unwrap();
        assert_eq!(err.code, ErrorCode::Timeout, "{name} should return Timeout");
        assert!(
            !err.message.contains("file transfer"),
            "{name} misattributed as file transfer: {}",
            err.message
        );
        if let Some(data) = err.data.as_ref() {
            assert_ne!(
                data.get("reason").and_then(Value::as_str),
                Some(RpcErrorReason::TransferOutcomeUnknown.as_str()),
                "{name} emitted transfer_outcome_unknown: {data}"
            );
        }
        match name {
            "navigate" | "window_resize" => {
                assert_eq!(
                    err.data.as_ref().unwrap()["effect_state"],
                    "unknown",
                    "{name} must preserve effect_state=unknown"
                );
            }
            "screenshot_full_page" => {
                assert!(
                    err.message.contains("full-page screenshot timed out"),
                    "unexpected full-page message: {}",
                    err.message
                );
            }
            _ => unreachable!(),
        }
    }
    assert_eq!(cancel_count.load(Ordering::SeqCst), 3);

    // WAL-tracked mutating tools (`navigate`, `wal: Always`) freeze IntentWal on unknown deadline cleanup,
    // whereas non-WAL tools (`screenshot_full_page` & `window_resize`, `wal: Never`) remain unfrozen.
    for (sid, expected_frozen) in [
        (&sessions[0], true),
        (&sessions[1], false),
        (&sessions[2], false),
    ] {
        let ledger: Value = admin
            .call(
                "ledger-status",
                Method::LedgerRequest,
                Some(json!({ "action": "status", "session_id": sid })),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            ledger["frozen"], expected_frozen,
            "session {sid} WAL frozen mismatch: {ledger}"
        );
    }

    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_status_and_ledger_stay_non_blocking_during_transfer_audit_and_wal_disk_io() {
    let home = crate::support::short_tempdir();
    let downloads_dir = crate::support::short_tempdir();
    let downloads_root = std::fs::canonicalize(downloads_dir.path()).unwrap();

    // Configure TrustLocal inside isolated `BSK_HOME` and spawn a real foreground daemon process
    // so `audit/`, `run/transfers/`, and `intent_ledger.json` are 100% isolated from `~/.bsk`.
    let trust_out = run_bsk_at(home.path(), &["daemon", "trust-local", "on"], &[]).await;
    assert!(trust_out.status.success(), "{trust_out:?}");
    let mut daemon_child = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .args(["daemon", "start", "--foreground", "--port", "0"])
        .env("BSK_HOME", home.path())
        .env("BSK_AUTO_UPDATE", "off")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn foreground daemon");

    let daemon_json_path = home.path().join("daemon.json");
    let boot_deadline = Instant::now() + Duration::from_secs(10);
    let info = loop {
        if let Ok(Some(info)) = bsk::daemon::info::read_from_path(&daemon_json_path) {
            break info;
        }
        assert!(
            Instant::now() < boot_deadline,
            "foreground daemon never wrote daemon.json"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let sock = info.sock_path.clone();
    let ws_addr: std::net::SocketAddr = ([127, 0, 0, 1], info.ws_port).into();

    let ws = connect_ext(ws_addr).await;
    let (writer, mut reader): (SplitSink<Ws, Message>, SplitStream<Ws>) = ws.split();
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

    // Handshake with `audit_enabled: true` so every RPC exercises non-blocking `AuditStore` disk I/O + `sync_data()`.
    {
        let hs = json!({
            "id": "hs-audit",
            "method": "system.handshake",
            "params": {
                "client": bsk_protocol::EXTENSION_CLIENT_ID,
                "version": "0.5.0",
                "protocol_version": bsk::daemon::state::PROTOCOL_VERSION,
                "instance_id": TEST_EXT_ID,
                "browser": { "name": "chrome", "version": "136.0" },
                "label": "Wave4BIoChrome",
                "audit_enabled": true
            }
        });
        writer
            .lock()
            .await
            .send(Message::Text(hs.to_string()))
            .await
            .unwrap();
        let Message::Text(hs_reply_raw) = reader.next().await.unwrap().unwrap() else {
            panic!("expected handshake text frame");
        };
        let hs_reply: Value = serde_json::from_str(&hs_reply_raw).unwrap();
        assert_eq!(hs_reply["result"]["audit_ready"], true, "{hs_reply}");
    }

    let writer_bg = Arc::clone(&writer);
    let dl_root_bg = downloads_root.clone();
    let payload_bytes = Arc::new(vec![0xABu8; 512 * 1024]); // 512 KiB binary payload per download
    let payload_bg = Arc::clone(&payload_bytes);

    tokio::spawn(async move {
        let mut win_id = 300i64;
        while let Some(Ok(Message::Text(text))) = reader.next().await {
            let Ok(Frame::Request(req)) = serde_json::from_str::<Frame>(&text) else {
                continue;
            };
            let body = match req.method {
                Method::ToolSessionStart => {
                    win_id += 1;
                    ResponseBody::Ok(
                        serde_json::to_value(SessionStartResult {
                            interaction: None,
                            agent_window_id: Some(win_id),
                        })
                        .unwrap(),
                    )
                }
                Method::ToolSessionStop => ResponseBody::Ok(json!({ "closed": true })),
                Method::ToolClick => ResponseBody::Ok(json!({
                    "tab_id": 11,
                    "x": 10.0,
                    "y": 20.0,
                    "used_ref": "@e1"
                })),
                Method::ToolDownload => {
                    let parsed: DownloadParams =
                        serde_json::from_value(req.params.unwrap()).unwrap();
                    let rel = parsed
                        .browser_relative_dir
                        .expect("daemon injects browser_relative_dir");
                    let cap_dir = dl_root_bg.join(rel);
                    std::fs::create_dir_all(&cap_dir).unwrap();
                    let file_path = cap_dir.join("report.bin");
                    std::fs::write(&file_path, payload_bg.as_slice()).unwrap();
                    ResponseBody::Ok(
                        serde_json::to_value(DownloadResult {
                            tab_id: 11,
                            used_ref: parsed.ref_,
                            used_selector: parsed.selector,
                            suggested_filename: "report.bin".into(),
                            byte_size: payload_bg.len() as u64,
                            mime: Some("application/octet-stream".into()),
                            danger: None,
                            browser_path: Some(file_path.to_string_lossy().into_owned()),
                            transfer_id: None,
                        })
                        .unwrap(),
                    )
                }
                Method::Cancel => ResponseBody::Ok(json!({ "cancelled": true })),
                _ => ResponseBody::Ok(json!({})),
            };
            send_ws_response(&writer_bg, req.id, body).await;
        }
    });

    let mut admin = IpcClient::connect(&sock).await.unwrap();
    let s_io_val: Value = admin
        .call(
            "start-io",
            Method::SessionStart,
            Some(json!({})),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    let s_io = s_io_val["session_id"].as_str().unwrap().to_owned();

    // Concurrent status + ledger probe task verifying global locks stay unblocked.
    let done = Arc::new(AtomicBool::new(false));
    let done_probe = Arc::clone(&done);
    let probe_sock = sock.clone();
    let probe_sid = s_io.clone();
    let probe_task = tokio::spawn(async move {
        let mut client = IpcClient::connect(&probe_sock).await.unwrap();
        let mut polls = 0usize;
        while !done_probe.load(Ordering::Relaxed) {
            let status: StatusResult = client
                .call(
                    "probe-status",
                    Method::SystemStatus,
                    Some(json!({})),
                    Duration::from_secs(2),
                )
                .await
                .unwrap()
                .unwrap();
            assert!(!status.browsers.is_empty());
            let _: Value = client
                .call(
                    "probe-ledger",
                    Method::LedgerRequest,
                    Some(json!({ "action": "status", "session_id": probe_sid })),
                    Duration::from_secs(2),
                )
                .await
                .unwrap()
                .unwrap();
            polls += 1;
            tokio::task::yield_now().await;
        }
        polls
    });

    // Drive upload staging (`begin` -> `chunk` -> `finish` -> `release`), `tool.click` (WAL + Audit),
    // and `tool.download` (`import_download` + `transfer.read` + `transfer.release`).
    let chunk_raw = vec![0x5Au8; 256 * 1024];
    let chunk_b64 = base64::engine::general_purpose::STANDARD.encode(&chunk_raw);
    for round in 0..4 {
        let begin: TransferBeginResult = admin
            .call(
                "up-begin",
                Method::TransferBegin,
                Some(TransferBeginParams {
                    session_id: s_io.clone(),
                    name: format!("upload-{round}.bin"),
                    byte_size: (chunk_raw.len() * 2) as u64,
                }),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
            .unwrap();
        for idx in 0..2u64 {
            let _: TransferChunkResult = admin
                .call(
                    "up-chunk",
                    Method::TransferChunk,
                    Some(TransferChunkParams {
                        transfer_id: begin.transfer_id.clone(),
                        offset: idx * chunk_raw.len() as u64,
                        data_base64: chunk_b64.clone(),
                    }),
                    Duration::from_secs(5),
                )
                .await
                .unwrap()
                .unwrap();
        }
        let ready: TransferReadyResult = admin
            .call(
                "up-finish",
                Method::TransferFinish,
                Some(TransferIdParams {
                    transfer_id: begin.transfer_id.clone(),
                }),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ready.byte_size, (chunk_raw.len() * 2) as u64);

        let _: Value = admin
            .call(
                "wal-click",
                Method::ToolClick,
                Some(json!({
                    "session_id": s_io,
                    "ref": "@e1"
                })),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
            .unwrap();

        let dl: DownloadResult = admin
            .call(
                "dl-run",
                Method::ToolDownload,
                Some(json!({
                    "session_id": s_io,
                    "ref": "@e1"
                })),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
            .unwrap();
        let dl_id = dl.transfer_id.expect("daemon returns opaque transfer_id");
        let read_chunk: TransferChunkResult = admin
            .call(
                "dl-read",
                Method::TransferRead,
                Some(TransferReadParams {
                    transfer_id: dl_id.clone(),
                    offset: 0,
                    data_base64: None,
                }),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
            .unwrap();
        assert!(read_chunk.next_offset > 0);

        for tid in [begin.transfer_id, dl_id] {
            let rel: TransferReleaseResult = admin
                .call(
                    "tf-release",
                    Method::TransferRelease,
                    Some(TransferIdParams { transfer_id: tid }),
                    Duration::from_secs(5),
                )
                .await
                .unwrap()
                .unwrap();
            assert!(rel.released);
        }
    }

    done.store(true, Ordering::Relaxed);
    let completed_polls = probe_task.await.unwrap();
    assert!(completed_polls > 0);
    assert!(
        home.path().join("audit").exists(),
        "audit store wrote to isolated BSK_HOME"
    );

    // Adversarial race: `session.stop` racing an in-flight `tool.download` must leave zero orphan
    // transfer directories in `home/run/transfers` once both settle!
    let s_race_val: Value = admin
        .call(
            "start-race",
            Method::SessionStart,
            Some(json!({})),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    let s_race = s_race_val["session_id"].as_str().unwrap().to_owned();

    let sock_dl = sock.clone();
    let s_race_dl = s_race.clone();
    let dl_race = tokio::spawn(async move {
        let mut c = IpcClient::connect(&sock_dl).await.unwrap();
        c.call::<Value, DownloadResult>(
            "race-dl",
            Method::ToolDownload,
            Some(json!({ "session_id": s_race_dl, "ref": "@e1" })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
    });
    let sock_stop = sock.clone();
    let s_race_stop = s_race.clone();
    let stop_race = tokio::spawn(async move {
        let mut c = IpcClient::connect(&sock_stop).await.unwrap();
        c.call::<Value, Value>(
            "race-stop",
            Method::SessionStop,
            Some(json!({ "session_id": s_race_stop })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
    });

    let dl_outcome = dl_race.await.unwrap();
    let _ = stop_race.await.unwrap();
    let _ = admin
        .call::<Value, Value>(
            "cleanup-stop",
            Method::SessionStop,
            Some(json!({ "session_id": s_race })),
            Duration::from_secs(5),
        )
        .await;
    let _ = admin
        .call::<Value, Value>(
            "cleanup-stop-io",
            Method::SessionStop,
            Some(json!({ "session_id": s_io })),
            Duration::from_secs(5),
        )
        .await;

    if let Ok(dl_ok) = dl_outcome
        && let Some(tid) = dl_ok.transfer_id
    {
        let err = admin
            .call::<TransferReadParams, TransferChunkResult>(
                "verify-reaped",
                Method::TransferRead,
                Some(TransferReadParams {
                    transfer_id: tid,
                    offset: 0,
                    data_base64: None,
                }),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    let remaining_dirs = std::fs::read_dir(home.path().join("run").join("transfers"))
        .unwrap()
        .count();
    assert_eq!(
        remaining_dirs, 0,
        "zero orphan transfer directories must remain"
    );

    let _ = run_bsk_at(home.path(), &["daemon", "stop"], &[]).await;
    let _ = daemon_child.kill().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn canvas_click_validation_and_mcp_browser_conflict_and_graceful_cancel_parity() {
    let home = crate::support::short_tempdir();
    let trust_out = run_bsk_at(home.path(), &["daemon", "trust-local", "on"], &[]).await;
    assert!(trust_out.status.success(), "{trust_out:?}");
    let mut daemon_child = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .args(["daemon", "start", "--foreground", "--port", "0"])
        .env("BSK_HOME", home.path())
        .env("BSK_AUTO_UPDATE", "off")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn foreground daemon");

    let daemon_json_path = home.path().join("daemon.json");
    let boot_deadline = Instant::now() + Duration::from_secs(10);
    let info = loop {
        if let Ok(Some(info)) = bsk::daemon::info::read_from_path(&daemon_json_path) {
            break info;
        }
        assert!(
            Instant::now() < boot_deadline,
            "foreground daemon never wrote daemon.json"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let ws_addr: std::net::SocketAddr = ([127, 0, 0, 1], info.ws_port).into();

    let mut ws = connect_ext(ws_addr).await;
    do_handshake(&mut ws, TEST_EXT_ID, "primary-chrome").await;

    let ext_clicks = Arc::new(Mutex::new(Vec::<Value>::new()));
    let ext_clicks_bg = Arc::clone(&ext_clicks);
    let (upload_req_tx, mut upload_req_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let pending_upload_cancel = Arc::new(tokio::sync::Notify::new());
    let pending_upload_cancel_bg = Arc::clone(&pending_upload_cancel);
    let upload_attempt = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let upload_attempt_bg = Arc::clone(&upload_attempt);

    let (writer, mut reader): (SplitSink<Ws, Message>, SplitStream<Ws>) = ws.split();
    let writer = Arc::new(tokio::sync::Mutex::new(writer));
    let writer_bg = Arc::clone(&writer);
    tokio::spawn(async move {
        let mut win_id = 400i64;
        while let Some(Ok(Message::Text(text))) = reader.next().await {
            let Ok(Frame::Request(req)) = serde_json::from_str::<Frame>(&text) else {
                continue;
            };
            let writer_task = Arc::clone(&writer_bg);
            let clicks_task = Arc::clone(&ext_clicks_bg);
            let upload_seen = upload_req_tx.clone();
            let upload_cancel_sig = Arc::clone(&pending_upload_cancel_bg);
            let upload_attempt_task = Arc::clone(&upload_attempt_bg);
            if req.method == Method::ToolSessionStart {
                win_id += 1;
            }
            let assigned_win = win_id;
            tokio::spawn(async move {
                let body = match req.method {
                    Method::ToolSessionStart => ResponseBody::Ok(
                        serde_json::to_value(SessionStartResult {
                            interaction: None,
                            agent_window_id: Some(assigned_win),
                        })
                        .unwrap(),
                    ),
                    Method::ToolClick => {
                        let params = req.params.unwrap_or_default();
                        clicks_task.lock().unwrap().push(params.clone());
                        ResponseBody::Ok(json!({
                            "tab_id": 21,
                            "x": params.get("image_x").and_then(Value::as_f64).unwrap_or(50.0),
                            "y": params.get("image_y").and_then(Value::as_f64).unwrap_or(60.0),
                            "used_ref": params.get("ref").and_then(Value::as_str).unwrap_or("@e1")
                        }))
                    }
                    Method::ToolUpload => {
                        let attempt = upload_attempt_task.fetch_add(1, Ordering::SeqCst);
                        let _ = upload_seen.send(req.id.clone());
                        upload_cancel_sig.notified().await;
                        match attempt {
                            0 => ResponseBody::Err(bsk_protocol::RpcError {
                                code: ErrorCode::Cancelled,
                                message: "cancelled before file input attach".into(),
                                data: Some(json!({
                                    "reason": RpcErrorReason::CancelledBeforeDispatch.as_str(),
                                    "dispatched": false,
                                    "effect_state": "none"
                                })),
                            }),
                            1 => ResponseBody::Err(bsk_protocol::RpcError {
                                code: ErrorCode::Cancelled,
                                message: "cancelled after arm_interception disarmament".into(),
                                data: Some(json!({
                                    "effect_state": "none",
                                    "phase": "arm_interception"
                                })),
                            }),
                            _ => ResponseBody::Err(bsk_protocol::RpcError {
                                code: ErrorCode::Cancelled,
                                message: "rpc aborted mid-invocation without effect proof".into(),
                                data: Some(json!({
                                    "tab_id": 21
                                })),
                            }),
                        }
                    }
                    Method::ToolCooperate => ResponseBody::Ok(json!({
                        "kind": "baseline",
                        "tab_id": 21,
                        "context_id": "ctx-canvas-1",
                        "observation_id": "obs-canvas-1",
                        "control_policy": "target",
                        "state": {
                            "url": "https://example.test/canvas",
                            "title": "Canvas Studio"
                        },
                        "observation": {
                            "text": "@vom 1\ncanvas Board [ref=@e1] [visual:screenshot]\nheading Ready [ref=@e2]"
                        }
                    })),
                    Method::Cancel => {
                        upload_cancel_sig.notify_one();
                        ResponseBody::Ok(json!({ "cancelled": true }))
                    }
                    _ => ResponseBody::Ok(json!({})),
                };
                send_ws_response(&writer_task, req.id, body).await;
            });
        }
    });

    // Start a session via `bsk session start --json`.
    let start_out = run_bsk_at(home.path(), &["session", "start", "--json"], &[]).await;
    assert!(start_out.status.success(), "{:?}", start_out);
    let started_json: Value = serde_json::from_slice(&start_out.stdout).unwrap();
    let sid = started_json["session_id"].as_str().unwrap().to_owned();

    // Seed scope context via `bsk sync --wait-for Ready --timeout-ms 60000 --json`
    // (proving CLI `bsk sync` accepts `--timeout-ms > 25000` when `--wait-for` is present!).
    let sync_ok = run_bsk_at(
        home.path(),
        &[
            "sync",
            "--session",
            &sid,
            "--wait-for",
            "Ready",
            "--timeout-ms",
            "60000",
            "--json",
        ],
        &[],
    )
    .await;
    assert!(
        sync_ok.status.success(),
        "sync with wait-for + 60000ms failed: {}",
        String::from_utf8_lossy(&sync_ok.stderr)
    );

    // Without `--wait-for`/`--wait-not`, `bsk sync --timeout-ms 60000` must fail closed locally.
    let sync_bad = run_bsk_at(
        home.path(),
        &["sync", "--session", &sid, "--timeout-ms", "60000", "--json"],
        &[],
    )
    .await;
    assert!(!sync_bad.status.success());

    // 1. Valid Canvas point clicks succeed across `bsk click`, `bsk step click`, `bsk plan`, and MCP `bsk_interact`.
    let cli_click = run_bsk_at(
        home.path(),
        &[
            "click",
            "@e1",
            "--session",
            &sid,
            "--capture",
            "cap-cli",
            "--image-x",
            "12.5",
            "--image-y",
            "34",
            "--json",
        ],
        &[],
    )
    .await;
    assert!(
        cli_click.status.success(),
        "cli canvas click failed: {}",
        String::from_utf8_lossy(&cli_click.stderr)
    );

    let step_click = run_bsk_at(
        home.path(),
        &[
            "step",
            "--session",
            &sid,
            "--action",
            "click",
            "--params",
            r#"{"ref":"@e1","capture_id":"cap-step","image_x":22.0,"image_y":44.0}"#,
            "--json",
        ],
        &[],
    )
    .await;
    assert!(
        step_click.status.success(),
        "step canvas click failed: stdout={} stderr={}",
        String::from_utf8_lossy(&step_click.stdout),
        String::from_utf8_lossy(&step_click.stderr)
    );

    let plan_click = run_bsk_at(
        home.path(),
        &[
            "--observation",
            "obs-canvas-1",
            "plan",
            "--session",
            &sid,
            "--steps",
            r#"[{"action":"click","ref":"@e1","capture_id":"cap-plan","image_x":32.0,"image_y":54.0}]"#,
            "--json",
        ],
        &[],
    )
    .await;
    assert!(
        plan_click.status.success(),
        "plan canvas click failed: stdout={} stderr={}",
        String::from_utf8_lossy(&plan_click.stdout),
        String::from_utf8_lossy(&plan_click.stderr)
    );

    let mut mcp = McpProcess::spawn(home.path(), &[]).await;
    let mcp_click = mcp
        .call_tool(
            "bsk_interact",
            json!({
                "action": "click",
                "session": sid,
                "params": {
                    "ref": "@e1",
                    "capture_id": "cap-mcp",
                    "image_x": 42.0,
                    "image_y": 64.0
                }
            }),
        )
        .await;
    assert_ne!(
        mcp_click["isError"], true,
        "mcp canvas click failed: {mcp_click}"
    );

    let seen_captures: Vec<String> = ext_clicks
        .lock()
        .unwrap()
        .iter()
        .filter_map(|p| {
            p.get("capture_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    assert_eq!(
        seen_captures,
        vec!["cap-cli", "cap-step", "cap-plan", "cap-mcp"]
    );
    let before_bad_count = ext_clicks.lock().unwrap().len();

    // 2. Invalid Canvas point click combinations fail closed locally BEFORE daemon dispatch!
    let bad_cli_positional = run_bsk_at(
        home.path(),
        &[
            "click",
            "#canvas",
            "--session",
            &sid,
            "--capture",
            "cap-bad",
            "--image-x",
            "10",
            "--image-y",
            "20",
            "--json",
        ],
        &[],
    )
    .await;
    assert!(!bad_cli_positional.status.success());
    let bad_cli_text = format!(
        "{}{}",
        String::from_utf8_lossy(&bad_cli_positional.stdout),
        String::from_utf8_lossy(&bad_cli_positional.stderr)
    );
    assert!(
        bad_cli_text.contains("visual point click"),
        "unexpected bad_cli_positional output: {bad_cli_text}"
    );

    let bad_step = run_bsk_at(
        home.path(),
        &[
            "step",
            "--session",
            &sid,
            "--action",
            "click",
            "--params",
            r##"{"selector":"#canvas","capture_id":"cap-bad","image_x":10,"image_y":20}"##,
            "--json",
        ],
        &[],
    )
    .await;
    assert!(!bad_step.status.success());
    let bad_step_text = format!(
        "{}{}",
        String::from_utf8_lossy(&bad_step.stdout),
        String::from_utf8_lossy(&bad_step.stderr)
    );
    assert!(
        bad_step_text.contains("visual point click"),
        "unexpected bad_step output: {bad_step_text}"
    );

    let bad_mcp = mcp
        .call_tool(
            "bsk_interact",
            json!({
                "action": "click",
                "session": sid,
                "params": {
                    "ref": "@e1",
                    "capture_id": "cap-bad",
                    "image_x": 10.0,
                    "image_y": 20.0,
                    "click_count": 3
                }
            }),
        )
        .await;
    assert_eq!(bad_mcp["isError"], true);
    assert!(
        bad_mcp["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("visual point click"),
        "unexpected bad_mcp output: {bad_mcp}"
    );
    assert_eq!(
        ext_clicks.lock().unwrap().len(),
        before_bad_count,
        "invalid canvas clicks must never reach the extension"
    );

    // 3. Explicit `--session` + conflicting `--browser` emits `reason == "scope_browser_conflict"` on BOTH CLI and MCP!
    let cli_conflict = run_bsk_at(
        home.path(),
        &[
            "open",
            "https://example.test/",
            "--session",
            &sid,
            "--browser",
            "other-edge",
            "--json",
        ],
        &[],
    )
    .await;
    assert!(!cli_conflict.status.success());
    let cli_conflict_json: Value = serde_json::from_slice(&cli_conflict.stderr)
        .or_else(|_| serde_json::from_slice(&cli_conflict.stdout))
        .unwrap();
    assert_eq!(
        cli_conflict_json["data"]["reason"],
        RpcErrorReason::ScopeBrowserConflict.as_str(),
        "unexpected cli_conflict_json: {cli_conflict_json}"
    );
    assert_eq!(cli_conflict_json["data"]["bound_browser"], TEST_EXT_ID);
    assert_eq!(cli_conflict_json["data"]["requested_browser"], "other-edge");

    let mcp_conflict = mcp
        .call_tool(
            "bsk_session",
            json!({
                "action": "open",
                "url": "https://example.test/",
                "session": sid,
                "browser": "other-edge"
            }),
        )
        .await;
    assert_eq!(mcp_conflict["isError"], true);
    let mcp_conflict_payload: Value =
        serde_json::from_str(mcp_conflict["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        mcp_conflict_payload["data"]["reason"],
        RpcErrorReason::ScopeBrowserConflict.as_str()
    );
    assert_eq!(mcp_conflict_payload["data"]["bound_browser"], TEST_EXT_ID);
    assert_eq!(
        mcp_conflict_payload["data"]["requested_browser"],
        "other-edge"
    );

    // 4. MCP `notifications/cancelled` during `bsk_interact(upload)` settles within `CANCEL_RESPONSE_GRACE`
    //    as `CancelledBeforeDispatch`, releasing staged upload transfers on the daemon AND keeping WAL unfrozen!
    let upload_file_dir = crate::support::short_tempdir();
    let upload_src = upload_file_dir.path().join("sample.txt");
    std::fs::write(&upload_src, b"wave4b upload staging cleanup test").unwrap();

    mcp.send_raw(&json!({
        "jsonrpc": "2.0",
        "id": 777,
        "method": "tools/call",
        "params": {
            "name": "bsk_interact",
            "arguments": {
                "action": "upload",
                "session": sid,
                "params": {
                    "ref": "@e1",
                    "files": [upload_src.to_string_lossy()]
                }
            }
        }
    }))
    .await;

    // Wait until `tool.upload` has staged its file in `home/run/transfers` and reached the extension.
    let _ = tokio::time::timeout(Duration::from_secs(5), upload_req_rx.recv())
        .await
        .expect("tool.upload reached extension")
        .unwrap();
    let transfers_root = home.path().join("run").join("transfers");
    assert_eq!(
        std::fs::read_dir(&transfers_root).unwrap().count(),
        1,
        "staged upload transfer directory must exist before cancel"
    );

    // Cancel MCP request 777! With `await_cancelled_operation`, `Link::rpc_envelope` awaits the daemon's
    // `CancelledBeforeDispatch` response and `Prepared::Upload` releases its staged file immediately!
    mcp.notify("notifications/cancelled", json!({ "requestId": 777 }))
        .await;

    let ledger = mcp.await_cancelled_settled(777, &sid).await;
    assert_eq!(
        std::fs::read_dir(&transfers_root).unwrap().count(),
        0,
        "staged upload transfer leaked in {} after MCP notifications/cancelled!",
        transfers_root.display()
    );
    assert_ne!(ledger["isError"], true);
    let ledger_json: Value =
        serde_json::from_str(ledger["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(ledger_json["frozen"], false);

    // 4b. Adversarial boundary #1: post-invocation `arm_interception` cancel (`effect_state: "none"` WITHOUT
    //     `cancelled_before_dispatch`) keeps WAL unfrozen while retaining session-owned staging!
    mcp.send_raw(&json!({
        "jsonrpc": "2.0",
        "id": 778,
        "method": "tools/call",
        "params": {
            "name": "bsk_interact",
            "arguments": {
                "action": "upload",
                "session": sid,
                "params": {
                    "ref": "@e1",
                    "files": [upload_src.to_string_lossy()]
                }
            }
        }
    }))
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(5), upload_req_rx.recv())
        .await
        .unwrap()
        .unwrap();
    mcp.notify("notifications/cancelled", json!({ "requestId": 778 }))
        .await;
    let ledger_arm = mcp.await_cancelled_settled(778, &sid).await;
    let ledger_arm_json: Value =
        serde_json::from_str(ledger_arm["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        ledger_arm_json["frozen"], false,
        "arm_interception effect_state=none cancel must NOT freeze IntentWal"
    );
    assert_eq!(
        std::fs::read_dir(&transfers_root).unwrap().count(),
        1,
        "dispatched upload without cancelled_before_dispatch stays session-owned until session stop"
    );

    // 4c. Adversarial boundary #2: unconfirmed mid-invocation abort (`data: { tab_id: 21 }` without `effect_state`)
    //     fails closed (`effect_state: "unknown"`), freezing IntentWal on tab 21, and `session stop` reaps all staging!
    mcp.send_raw(&json!({
        "jsonrpc": "2.0",
        "id": 779,
        "method": "tools/call",
        "params": {
            "name": "bsk_interact",
            "arguments": {
                "action": "upload",
                "session": sid,
                "params": {
                    "ref": "@e1",
                    "files": [upload_src.to_string_lossy()]
                }
            }
        }
    }))
    .await;
    let _ = tokio::time::timeout(Duration::from_secs(5), upload_req_rx.recv())
        .await
        .unwrap()
        .unwrap();
    mcp.notify("notifications/cancelled", json!({ "requestId": 779 }))
        .await;
    let ledger_unk = mcp.await_cancelled_settled(779, &sid).await;
    let ledger_unk_json: Value =
        serde_json::from_str(ledger_unk["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(
        ledger_unk_json["frozen"], true,
        "unconfirmed upload abort must freeze IntentWal"
    );
    assert_eq!(ledger_unk_json["pending_unknown"][0]["tab_id"], 21);

    let stop_reply = mcp
        .call_tool("bsk_session", json!({ "action": "stop", "session": sid }))
        .await;
    assert_ne!(stop_reply["isError"], true);
    assert_eq!(
        std::fs::read_dir(&transfers_root).unwrap().count(),
        0,
        "session stop must reap all remaining session-owned upload transfers"
    );

    drop(mcp);
    let _ = run_bsk_at(home.path(), &["daemon", "stop"], &[]).await;
    let _ = daemon_child.kill().await;
}
