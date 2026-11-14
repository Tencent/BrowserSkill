//! Wave 2 top-level full-chain E2E verification (`bsk mcp` -> `ClientContext` -> real Daemon -> mock WS `"2.0"` browser):
//! - Chain A: all 11 base MCP tools, dual-scope isolation (`agent-alpha` vs `agent-beta`),
//!   `MethodSpec::accepts_action_metadata` gate (`click` + `until_visible` + `sync_after`, `upload`,
//!   `read --context`, `emulate`, `video`, `record` Trace v3 export).
//! - Chain B: adversarial counterexamples:
//!   1) `bsk_debug(replay)` native dialog suspension (`dialog_pending` + `mcp_hint` naming `bsk_assist`,
//!      never `bsk dialog`), queue/gate rejection before WS dispatch, `dialog_accept`, `operation_await`.
//!   2) `bsk_interact(download)` timeout/unknown -> WAL `UNKNOWN` freeze -> subsequent mutating click
//!      blocked with `uncertain_prior_effect` + `mcp_hint` naming `bsk_ledger` (never `bsk ledger resolve`),
//!      `bsk_ledger(status/resolve)` -> click succeeds.
//! - Chain C: WS `"1.9"` peer handshake rejection (`VersionTooOld`).
use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bsk::daemon::info::DaemonInfo;
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::{SessionStartParams, SessionStartResult};
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, Frame, Method, PROTOCOL_VERSION, RequestFrame, ResponseBody,
    ResponseFrame, RpcError,
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

#[derive(Debug, Clone)]
enum DeferredReply {
    DialogReplay {
        req_id: String,
        session_id: String,
        op_id: String,
    },
}

struct MockExtensionState {
    recorded: Vec<RequestFrame>,
    session_tabs: HashMap<String, i64>,
    next_tab_id: i64,
    next_window_id: i64,
    sync_seq: u32,
    suspend_next_debug_replay: bool,
    pending_debug_replay: Option<DeferredReply>,
    fail_next_download_unknown: bool,
}

impl Default for MockExtensionState {
    fn default() -> Self {
        Self {
            recorded: Vec::new(),
            session_tabs: HashMap::new(),
            next_tab_id: 7,
            next_window_id: 100,
            sync_seq: 0,
            suspend_next_debug_replay: false,
            pending_debug_replay: None,
            fail_next_download_unknown: false,
        }
    }
}

struct McpClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl McpClient {
    async fn spawn(home: &std::path::Path) -> Self {
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
            .env_remove("BSK_RECIPES")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn bsk mcp");
        let stdin = child.stdin.take().expect("mcp stdin");
        let stdout = BufReader::new(child.stdout.take().expect("mcp stdout"));
        let mut client = Self {
            child,
            stdin,
            stdout,
            next_id: 1,
        };
        let init = client
            .rpc(
                "initialize",
                json!({
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": { "name": "wave2-e2e", "version": "1.0" }
                }),
            )
            .await;
        assert!(init["result"]["protocolVersion"].is_string());
        client.notify("notifications/initialized", json!({})).await;
        client
    }

    async fn notify(&mut self, method: &str, params: Value) {
        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .unwrap();
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.write_all(b"\n").await.unwrap();
        self.stdin.flush().await.unwrap();
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .unwrap();
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.write_all(b"\n").await.unwrap();
        self.stdin.flush().await.unwrap();

        let mut resp_line = String::new();
        tokio::time::timeout(
            Duration::from_secs(15),
            self.stdout.read_line(&mut resp_line),
        )
        .await
        .expect("mcp reply timeout")
        .expect("read mcp stdout");
        let reply: Value = serde_json::from_str(resp_line.trim()).expect("valid mcp json reply");
        assert_eq!(reply["id"], id, "mismatched json-rpc id in {reply}");
        reply
    }

    async fn call_tool_raw(&mut self, name: &str, arguments: Value) -> (bool, Value) {
        let reply = self
            .rpc(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await;
        assert!(
            reply.get("error").is_none(),
            "unexpected json-rpc protocol error for {name}: {reply}"
        );
        let result = &reply["result"];
        let is_error = result["isError"].as_bool().unwrap_or(false);
        let text = result["content"][0]["text"]
            .as_str()
            .expect("mcp text block");
        let parsed: Value = serde_json::from_str(text).expect("tool json text");
        (is_error, parsed)
    }

    async fn call_ok(&mut self, name: &str, arguments: Value) -> Value {
        let (is_error, body) = self.call_tool_raw(name, arguments).await;
        assert!(!is_error, "expected ok tool result for {name}, got: {body}");
        body
    }

    async fn call_err(&mut self, name: &str, arguments: Value) -> Value {
        let (is_error, body) = self.call_tool_raw(name, arguments).await;
        assert!(
            is_error,
            "expected error tool result for {name}, got: {body}"
        );
        body
    }
}

async fn connect_ws(ws_port: u16) -> Ws {
    let req = Request::builder()
        .uri(format!("ws://127.0.0.1:{ws_port}"))
        .header("Host", format!("127.0.0.1:{ws_port}"))
        .header("Origin", format!("chrome-extension://{TEST_EXT_ID}"))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .body(())
        .unwrap();
    let (ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .expect("connect ws");
    ws
}

async fn handshake_ws(
    ws: &mut Ws,
    protocol_version: &str,
    min_compatible_protocol: Option<&str>,
) -> ResponseFrame {
    let params = HandshakeParams {
        client: bsk_protocol::EXTENSION_CLIENT_ID.into(),
        version: env!("CARGO_PKG_VERSION").parse().unwrap(),
        protocol_version: protocol_version.into(),
        instance_id: TEST_EXT_ID.into(),
        browser: BrowserPeerInfo {
            name: "chrome".into(),
            version: "131.0".into(),
        },
        label: "e2e-profile".into(),
        min_compatible_peer: None,
        min_compatible_protocol: min_compatible_protocol.map(String::from),
    };
    let req = RequestFrame {
        id: "hs-e2e".into(),
        method: Method::SystemHandshake,
        params: Some(serde_json::to_value(params).unwrap()),
    };
    ws.send(Message::Text(serde_json::to_string(&req).unwrap()))
        .await
        .unwrap();
    let frame = ws.next().await.unwrap().unwrap();
    let Message::Text(text) = frame else {
        panic!("expected text handshake response: {frame:?}");
    };
    serde_json::from_str(&text).unwrap()
}

fn sample_trace_v3() -> Value {
    json!({
        "version": 3,
        "purpose": "wave2-e2e-record",
        "started_at": "2026-11-13T10:00:00Z",
        "recorded_at": "2026-11-13T10:00:05Z",
        "stopped_by": "user_finish",
        "entry": { "start_url": "https://example.com/" },
        "recorder": { "bsk": env!("CARGO_PKG_VERSION"), "vom": 1 },
        "states": [
            {
                "id": "s1",
                "url": "https://example.com/",
                "title": "Example Domain",
                "body": "@vom 1\nRootWebArea \"Example Domain\"",
                "truncated": false
            }
        ],
        "steps": [
            {
                "op": "navigate",
                "id": 1,
                "state": "s1",
                "result": { "state": "s1" },
                "to": "https://example.com/",
                "cause": "user_typed"
            }
        ]
    })
}

fn spawn_mock_extension(
    ws: Ws,
    state: Arc<Mutex<MockExtensionState>>,
) -> tokio::task::JoinHandle<()> {
    let (writer, mut reader): (SplitSink<Ws, Message>, SplitStream<Ws>) = ws.split();
    let writer = Arc::new(tokio::sync::Mutex::new(writer));
    tokio::spawn(async move {
        let mut out_queue: VecDeque<Value> = VecDeque::new();
        while let Some(Ok(msg)) = reader.next().await {
            let Message::Text(text) = msg else {
                if matches!(msg, Message::Close(_)) {
                    break;
                }
                continue;
            };
            let Ok(Frame::Request(req)) = serde_json::from_str::<Frame>(&text) else {
                continue;
            };
            let req_id = req.id.clone();
            let params = req.params.clone().unwrap_or(Value::Null);
            let mut reply_now: Option<ResponseBody> = None;

            {
                let mut st = state.lock().unwrap();
                st.recorded.push(req.clone());
                match req.method {
                    Method::ToolSessionStart => {
                        let parsed: SessionStartParams =
                            serde_json::from_value(params.clone()).unwrap();
                        let tab_id = st.next_tab_id;
                        st.next_tab_id += 1;
                        let wid = st.next_window_id;
                        st.next_window_id += 1;
                        st.session_tabs.insert(parsed.session_id, tab_id);
                        reply_now = Some(ResponseBody::Ok(
                            serde_json::to_value(SessionStartResult {
                                interaction: None,
                                agent_window_id: Some(wid),
                            })
                            .unwrap(),
                        ));
                    }
                    Method::ToolSessionStop => {
                        reply_now = Some(ResponseBody::Ok(json!({})));
                    }
                    Method::ToolNavigate => {
                        let sid = params["session_id"].as_str().unwrap_or("");
                        let tab_id = *st.session_tabs.get(sid).unwrap_or(&7);
                        let url = params["url"].as_str().unwrap_or("https://example.com/");
                        reply_now = Some(ResponseBody::Ok(json!({
                            "tab_id": tab_id,
                            "url": url,
                            "final_url": url,
                            "reached": "load",
                        })));
                    }
                    Method::ToolCooperate => {
                        let sid = params["session_id"].as_str().unwrap_or("");
                        let tab_id = *st.session_tabs.get(sid).unwrap_or(&7);
                        st.sync_seq += 1;
                        let seq = st.sync_seq;
                        let ctx_id = format!("{seq:08}-1111-4111-8111-111111111111");
                        let obs_id = format!("{seq:08}-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
                        reply_now = Some(ResponseBody::Ok(json!({
                            "tab_id": tab_id,
                            "control_policy": "target",
                            "context_id": ctx_id,
                            "observation_id": obs_id,
                            "observation": {
                                "observation_id": obs_id,
                                "tab_id": tab_id,
                                "url": format!("https://example.com/tab/{tab_id}"),
                                "title": format!("Page {tab_id}"),
                                "text": "@e1 button \"Save\"\n@e2 file \"Upload\"\n@e5 link \"Download\"",
                                "ref_count": 3,
                                "truncated": false,
                            },
                            "state": { "mode": "ready", "revision": seq },
                        })));
                    }
                    Method::ToolWaitForElement => {
                        let sid = params["session_id"].as_str().unwrap_or("");
                        let tab_id = *st.session_tabs.get(sid).unwrap_or(&7);
                        reply_now = Some(ResponseBody::Ok(json!({
                            "tab_id": tab_id,
                            "satisfied": true,
                            "elapsed_ms": 12,
                        })));
                    }
                    Method::ToolClick => {
                        let sid = params["session_id"].as_str().unwrap_or("");
                        let tab_id = *st.session_tabs.get(sid).unwrap_or(&7);
                        reply_now = Some(ResponseBody::Ok(json!({
                            "tab_id": tab_id,
                            "x": 12.0,
                            "y": 24.0,
                        })));
                    }
                    Method::ToolUpload => {
                        let sid = params["session_id"].as_str().unwrap_or("");
                        let tab_id = *st.session_tabs.get(sid).unwrap_or(&7);
                        let names: Vec<Value> = params["files"]
                            .as_array()
                            .map(|arr| arr.iter().map(|f| f["name"].clone()).collect())
                            .unwrap_or_default();
                        reply_now = Some(ResponseBody::Ok(json!({
                            "tab_id": tab_id,
                            "used_ref": params.get("ref").cloned().unwrap_or(Value::Null),
                            "file_names": names,
                        })));
                    }
                    Method::ToolDownload => {
                        let sid = params["session_id"].as_str().unwrap_or("");
                        let tab_id = *st.session_tabs.get(sid).unwrap_or(&7);
                        if st.fail_next_download_unknown {
                            st.fail_next_download_unknown = false;
                            reply_now = Some(ResponseBody::Err(RpcError {
                                code: ErrorCode::Timeout,
                                message: "download timed out after activation".into(),
                                data: Some(json!({
                                    "reason": "action_timeout",
                                    "effect_state": "unknown",
                                    "tab_id": tab_id,
                                })),
                            }));
                        } else {
                            reply_now = Some(ResponseBody::Ok(json!({
                                "tab_id": tab_id,
                                "suggested_filename": "report.txt",
                                "byte_size": 5,
                            })));
                        }
                    }
                    Method::ToolRead => {
                        let sid = params["session_id"].as_str().unwrap_or("");
                        let tab_id = *st.session_tabs.get(sid).unwrap_or(&7);
                        reply_now = Some(ResponseBody::Ok(json!({
                            "tab_id": tab_id,
                            "page_url": format!("https://example.com/tab/{tab_id}"),
                            "frame_url": format!("https://example.com/tab/{tab_id}"),
                            "frame_id": "main",
                            "title": "Price Page",
                            "captured_at": "2026-11-13T10:00:00Z",
                            "items": [{
                                "ref": "@e10",
                                "values": { "text": "$42.00" },
                                "redacted": [],
                            }],
                            "truncated": false,
                            "scope": "current_dom",
                        })));
                    }
                    Method::ToolEmulate => {
                        let sid = params["session_id"].as_str().unwrap_or("");
                        let tab_id = *st.session_tabs.get(sid).unwrap_or(&7);
                        reply_now = Some(ResponseBody::Ok(json!({
                            "tab_id": tab_id,
                            "cleared": false,
                            "applied": { "mobile": true, "touch": true },
                        })));
                    }
                    Method::ToolVideo => {
                        let action = params["action"].as_str().unwrap_or("");
                        let sid = params["session_id"].as_str().unwrap_or("sess-alpha");
                        let tab_id = *st.session_tabs.get(sid).unwrap_or(&7);
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_millis() as u64;
                        let recording = json!({
                            "recording_id": "vid_11111111111111111111111111111111",
                            "session_id": sid,
                            "tab_id": tab_id,
                            "title": "Video Capture",
                            "state": if action == "stop" { "ready" } else { "recording" },
                            "quality": "standard",
                            "created_at": now_ms,
                            "expires_at": now_ms + 86_400_000,
                            "started_at": now_ms,
                            "max_duration_ms": 10_000,
                            "duration_ms": if action == "stop" { 250 } else { 10 },
                            "byte_size": if action == "stop" { 2048 } else { 0 },
                            "width": 1280,
                            "height": 720,
                            "frames": 5,
                            "dropped_frames": 0,
                            "stop_reason": if action == "stop" { json!("stopped") } else { Value::Null },
                            "completeness": if action == "stop" { json!("complete") } else { Value::Null },
                            "error": Value::Null,
                            "exported": false,
                        });
                        match action {
                            "capabilities" => {
                                reply_now = Some(ResponseBody::Ok(json!({
                                    "version": 1,
                                    "format": "mp4",
                                    "audio": false,
                                    "max_duration_ms": 600_000,
                                })));
                            }
                            "start" => {
                                reply_now = Some(ResponseBody::Ok(json!({
                                    "recording": recording,
                                    "capability": "cap-vid-1",
                                })));
                            }
                            "list" => {
                                reply_now = Some(ResponseBody::Ok(json!({
                                    "recordings": [{
                                        "recording": recording,
                                        "capability": "cap-vid-1",
                                    }],
                                })));
                            }
                            "stop" | "status" => {
                                reply_now = Some(ResponseBody::Ok(json!({
                                    "recording": recording,
                                })));
                            }
                            other => {
                                reply_now = Some(ResponseBody::Err(RpcError {
                                    code: ErrorCode::InvalidParams,
                                    message: format!("unexpected video action {other}"),
                                    data: None,
                                }));
                            }
                        }
                    }
                    Method::ToolRecordStart => {
                        let sid = params["session_id"].as_str().unwrap_or("");
                        let tab_id = *st.session_tabs.get(sid).unwrap_or(&7);
                        reply_now = Some(ResponseBody::Ok(json!({
                            "tab_id": tab_id,
                            "recording": true,
                        })));
                    }
                    Method::ToolRecordAwait => {
                        reply_now = Some(ResponseBody::Ok(json!({
                            "trace": sample_trace_v3(),
                        })));
                    }
                    Method::ToolDebug => {
                        let action = params["action"].as_str().unwrap_or("");
                        let sid = params["session_id"].as_str().unwrap_or("").to_owned();
                        if action == "replay" && st.suspend_next_debug_replay {
                            st.suspend_next_debug_replay = false;
                            let op_id = params["_operation_id"].as_str().unwrap().to_owned();
                            out_queue.push_back(json!({
                                "event": "dialog.changed",
                                "payload": {
                                    "session_id": sid,
                                    "operation_id": op_id,
                                    "dialog": {
                                        "id": "dlg-1",
                                        "tab_id": 7,
                                        "type": "confirm",
                                        "message": "Confirm replay?",
                                        "sequence": 1,
                                        "decision_deadline": 60000,
                                    }
                                }
                            }));
                            st.pending_debug_replay = Some(DeferredReply::DialogReplay {
                                req_id: req_id.clone(),
                                session_id: sid,
                                op_id,
                            });
                        } else {
                            reply_now = Some(ResponseBody::Ok(json!({
                                "session_id": sid,
                                "replay": {
                                    "id": "rep-1",
                                    "key": "attempt-1",
                                    "source_request_id": "d:n1",
                                    "request_id": "d:n2",
                                    "state": "completed",
                                },
                            })));
                        }
                    }
                    Method::ToolDialogAccept => {
                        let sid = params["session_id"].as_str().unwrap_or("").to_owned();
                        if let Some(DeferredReply::DialogReplay {
                            req_id: orig_req_id,
                            session_id: orig_sid,
                            op_id: orig_op_id,
                        }) = st.pending_debug_replay.take()
                        {
                            out_queue.push_back(json!({
                                "event": "dialog.changed",
                                "payload": { "session_id": sid, "operation_id": orig_op_id, "dialog": null }
                            }));
                            out_queue.push_back(
                                serde_json::to_value(ResponseFrame {
                                    id: req_id.clone(),
                                    body: ResponseBody::Ok(
                                        json!({ "dialog": { "handled": "accepted" } }),
                                    ),
                                })
                                .unwrap(),
                            );
                            out_queue.push_back(
                                serde_json::to_value(ResponseFrame {
                                    id: orig_req_id,
                                    body: ResponseBody::Ok(json!({
                                        "session_id": orig_sid,
                                        "replay": {
                                            "id": "rep-1",
                                            "key": "attempt-1",
                                            "source_request_id": "d:n1",
                                            "request_id": "d:n2",
                                            "state": "completed",
                                        },
                                    })),
                                })
                                .unwrap(),
                            );
                        } else {
                            reply_now = Some(ResponseBody::Ok(
                                json!({ "dialog": { "handled": "accepted" } }),
                            ));
                        }
                    }
                    other => {
                        reply_now = Some(ResponseBody::Err(RpcError {
                            code: ErrorCode::InvalidParams,
                            message: format!("unhandled mock method {other:?}"),
                            data: None,
                        }));
                    }
                }
            }

            if let Some(body) = reply_now {
                out_queue
                    .push_back(serde_json::to_value(ResponseFrame { id: req_id, body }).unwrap());
            }

            let mut w = writer.lock().await;
            while let Some(frame) = out_queue.pop_front() {
                if w.send(Message::Text(serde_json::to_string(&frame).unwrap()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    })
}

async fn start_real_daemon(home: &std::path::Path) -> (Child, DaemonInfo) {
    let trust = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .args(["daemon", "trust-local", "on"])
        .env("BSK_HOME", home)
        .env("BSK_AUTO_UPDATE", "off")
        .output()
        .await
        .expect("run bsk daemon trust-local on");
    assert!(
        trust.status.success(),
        "trust-local failed: {}",
        String::from_utf8_lossy(&trust.stderr)
    );

    let daemon = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .args(["daemon", "start", "--foreground", "--port", "0"])
        .env("BSK_HOME", home)
        .env("BSK_AUTO_UPDATE", "off")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn bsk daemon");

    let daemon_json = home.join("daemon.json");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let info = loop {
        if let Ok(bytes) = std::fs::read(&daemon_json)
            && let Ok(info) = serde_json::from_slice::<DaemonInfo>(&bytes)
            && tokio::net::UnixStream::connect(&info.sock_path)
                .await
                .is_ok()
        {
            break info;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for daemon.json and ipc socket"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    (daemon, info)
}

#[tokio::test]
async fn wave2_full_chain_ssot_mcp_parity_and_counterexamples() {
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let (_daemon, info) = start_real_daemon(home.path()).await;

    // Chain C: reject protocol "1.9" browser before registering.
    let mut old_ws = connect_ws(info.ws_port).await;
    let old_resp = handshake_ws(&mut old_ws, "1.9", Some("1.6")).await;
    match old_resp.body {
        ResponseBody::Err(err) => {
            assert_eq!(
                err.code,
                ErrorCode::VersionTooOld,
                "expected VersionTooOld: {err:?}"
            );
        }
        ResponseBody::Ok(v) => panic!("expected 1.9 rejection, got Ok: {v}"),
    }
    drop(old_ws);

    // Connect valid protocol "2.0" browser.
    let mut ws = connect_ws(info.ws_port).await;
    let hs = handshake_ws(&mut ws, PROTOCOL_VERSION, Some(PROTOCOL_VERSION)).await;
    let hs_result: HandshakeResult = match hs.body {
        ResponseBody::Ok(v) => serde_json::from_value(v).unwrap(),
        ResponseBody::Err(e) => panic!("2.0 handshake failed: {e:?}"),
    };
    assert_eq!(hs_result.protocol_version, "2.0");
    assert_eq!(hs_result.min_compatible_protocol.as_deref(), Some("2.0"));

    let ext_state = Arc::new(Mutex::new(MockExtensionState::default()));
    let _ext_task = spawn_mock_extension(ws, Arc::clone(&ext_state));

    let mut mcp = McpClient::spawn(home.path()).await;

    // Chain A.1: 11 first-class base tools exposed in tools/list.
    let list_reply = mcp.rpc("tools/list", json!({})).await;
    let tool_names: Vec<&str> = list_reply["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        tool_names,
        vec![
            "bsk_session",
            "bsk_page",
            "bsk_inspect",
            "bsk_interact",
            "bsk_plan",
            "bsk_tabs",
            "bsk_assist",
            "bsk_ledger",
            "bsk_debug",
            "bsk_video",
            "bsk_record",
        ]
    );

    // Chain A.2: dual-scope isolation across agent-alpha (tab 7) and agent-beta (tab 8).
    let open_alpha = mcp
        .call_ok(
            "bsk_session",
            json!({
                "action": "open",
                "scope": "agent-alpha",
                "url": "https://example.com/alpha"
            }),
        )
        .await;
    let open_beta = mcp
        .call_ok(
            "bsk_session",
            json!({
                "action": "open",
                "scope": "agent-beta",
                "url": "https://example.com/beta"
            }),
        )
        .await;
    let sess_alpha = open_alpha["session_id"].as_str().unwrap().to_owned();
    let sess_beta = open_beta["session_id"].as_str().unwrap().to_owned();
    assert_ne!(sess_alpha, sess_beta);
    assert_eq!(open_alpha["tab_id"], 7);
    assert_eq!(open_beta["tab_id"], 8);

    // Omitted-session read on agent-beta routes strictly to sess_beta (tab 8) without touching agent-alpha.
    let beta_read = mcp
        .call_ok(
            "bsk_inspect",
            json!({
                "action": "read",
                "scope": "agent-beta",
                "selector": "#price",
                "context": open_beta["context_id"].as_str().unwrap()
            }),
        )
        .await;
    assert_eq!(beta_read["tab_id"], 8);

    // Chain A.3: bsk_interact click with expect + until_visible + sync_after must never leak
    // expect/context_id/observation_id/depends_on onto wait_for_element or cooperate.sync.
    let before_click_len = ext_state.lock().unwrap().recorded.len();
    let click_ok = mcp
        .call_ok(
            "bsk_interact",
            json!({
                "action": "click",
                "scope": "agent-alpha",
                "params": { "ref": "@e1" },
                "context": open_alpha["context_id"].as_str().unwrap(),
                "expect": [{ "target": "@e1", "field": "text", "equals": "Save" }],
                "until_visible": "#saved",
                "sync_after": true
            }),
        )
        .await;
    assert_eq!(click_ok["ok"], true);
    assert_eq!(click_ok["action"]["result"]["tab_id"], 7);
    assert_eq!(click_ok["post"]["tab_id"], 7);
    let next_ctx = click_ok["post"]["context_id"]
        .as_str()
        .expect("post context_id")
        .to_owned();
    let next_obs = click_ok["post"]["observation_id"]
        .as_str()
        .expect("post observation_id")
        .to_owned();
    {
        let st = ext_state.lock().unwrap();
        let slice = &st.recorded[before_click_len..];
        let click_req = slice
            .iter()
            .find(|r| r.method == Method::ToolClick)
            .expect("tool.click sent");
        let click_p = click_req.params.as_ref().unwrap();
        assert_eq!(click_p["session_id"], sess_alpha);
        assert!(
            click_p.get("context_id").is_some(),
            "click missing context_id: {click_p}"
        );
        assert!(
            click_p.get("expect").is_some(),
            "click missing expect: {click_p}"
        );

        for method in [Method::ToolWaitForElement, Method::ToolCooperate] {
            let req = slice
                .iter()
                .find(|r| r.method == method)
                .unwrap_or_else(|| panic!("expected {method:?} after click"));
            let p = req.params.as_ref().unwrap();
            for forbidden in ["context_id", "expect", "observation_id", "depends_on"] {
                assert!(
                    p.get(forbidden).is_none(),
                    "{method:?} leaked {forbidden}: {p}"
                );
            }
        }
    }

    // Chain A.4: bsk_interact upload with expect succeeds and stages file cleanly.
    let upload_file = home.path().join("upload-sample.txt");
    std::fs::write(&upload_file, b"wave2 upload bytes").unwrap();
    let upload_before = ext_state.lock().unwrap().recorded.len();
    let upload_ok = mcp
        .call_ok(
            "bsk_interact",
            json!({
                "action": "upload",
                "scope": "agent-alpha",
                "params": { "ref": "@e2", "files": [upload_file] },
                "context": &next_ctx,
                "expect": [{ "target": "@e2", "field": "exists", "equals": true }]
            }),
        )
        .await;
    assert_eq!(upload_ok["file_names"][0], "upload-sample.txt");
    {
        let st = ext_state.lock().unwrap();
        let upload_req = st.recorded[upload_before..]
            .iter()
            .find(|r| r.method == Method::ToolUpload)
            .expect("tool.upload sent");
        assert!(upload_req.params.as_ref().unwrap().get("expect").is_some());
    }

    // Chain A.5: bsk_inspect read with context carries translated context_id to WS.
    let read_before = ext_state.lock().unwrap().recorded.len();
    let alpha_read = mcp
        .call_ok(
            "bsk_inspect",
            json!({
                "action": "read",
                "scope": "agent-alpha",
                "selector": "#price",
                "context": &next_ctx
            }),
        )
        .await;
    assert_eq!(alpha_read["scope"], "current_dom");
    {
        let st = ext_state.lock().unwrap();
        let read_req = st.recorded[read_before..]
            .iter()
            .find(|r| r.method == Method::ToolRead)
            .expect("tool.read sent");
        assert!(
            read_req
                .params
                .as_ref()
                .unwrap()
                .get("context_id")
                .is_some()
        );
    }

    // Chain A.6: bsk_assist emulate parity.
    let emulate_ok = mcp
        .call_ok(
            "bsk_assist",
            json!({
                "action": "emulate",
                "scope": "agent-alpha",
                "device": "iphone-14",
                "context": &next_ctx,
                "observation": &next_obs
            }),
        )
        .await;
    assert_eq!(emulate_ok["cleared"], false);

    // Chain A.7: bsk_video start + stop parity.
    let vid_start = mcp
        .call_ok(
            "bsk_video",
            json!({
                "action": "start",
                "scope": "agent-alpha",
                "duration": "10s"
            }),
        )
        .await;
    assert_eq!(
        vid_start["recording"]["recording_id"],
        "vid_11111111111111111111111111111111"
    );
    let vid_stop = mcp
        .call_ok(
            "bsk_video",
            json!({
                "action": "stop",
                "recording": "vid_11111111111111111111111111111111"
            }),
        )
        .await;
    assert_eq!(vid_stop["recording"]["state"], "ready");

    // Chain A.8: bsk_record start exports Trace v3 bundle onto disk.
    let trace_dir = home.path().join("trace-out");
    let record_ok = mcp
        .call_ok(
            "bsk_record",
            json!({
                "action": "start",
                "url": "https://example.com/",
                "output": trace_dir
            }),
        )
        .await;
    assert_eq!(record_ok["trace_version"], 3);
    let trace_disk: Value =
        serde_json::from_slice(&std::fs::read(trace_dir.join("trace.json")).unwrap()).unwrap();
    assert_eq!(trace_disk["version"], 3);

    // Chain B Counterexample 1: bsk_debug(replay) native dialog suspension -> dialog_pending
    // with mcp_hint naming bsk_assist (NOT bsk dialog), second replay blocked before WS dispatch,
    // then bsk_assist(dialog_accept) + operation_await settles cleanly.
    ext_state.lock().unwrap().suspend_next_debug_replay = true;
    let replay_pending = mcp
        .call_err(
            "bsk_debug",
            json!({
                "action": "replay",
                "session": &sess_alpha,
                "scope": "agent-alpha",
                "id": "d:n1",
                "context": &next_ctx,
                "replay": { "key": "attempt-1" }
            }),
        )
        .await;
    assert_eq!(replay_pending["data"]["reason"], "dialog_pending");
    let op_id = replay_pending["data"]["operation_id"]
        .as_str()
        .expect("operation_id on dialog_pending")
        .to_owned();
    let pending_hint = replay_pending["hint"].as_str().unwrap_or("");
    assert!(
        pending_hint.contains("bsk_assist"),
        "expected mcp_hint naming bsk_assist, got: {pending_hint}"
    );
    assert!(
        !pending_hint.contains("bsk dialog"),
        "mcp_hint leaked CLI command 'bsk dialog': {pending_hint}"
    );

    let before_second_replay = ext_state.lock().unwrap().recorded.len();
    let replay_blocked = mcp
        .call_err(
            "bsk_debug",
            json!({
                "action": "replay",
                "session": &sess_alpha,
                "scope": "agent-alpha",
                "id": "d:n1",
                "context": &next_ctx,
                "replay": { "key": "attempt-2" }
            }),
        )
        .await;
    assert!(
        matches!(
            replay_blocked["data"]["reason"].as_str(),
            Some("session_busy" | "dialog_pending")
        ),
        "expected second replay rejected before dispatch, got: {replay_blocked}"
    );
    assert_eq!(
        ext_state.lock().unwrap().recorded.len(),
        before_second_replay,
        "second replay must NOT reach extension WS while dialog suspended"
    );

    // Confirm operation_await(wait_ms=0) also reports dialog_pending before acceptance.
    let op_still_pending = mcp
        .call_err(
            "bsk_assist",
            json!({
                "action": "operation_await",
                "scope": "agent-alpha",
                "operation_id": op_id,
                "wait_ms": 0
            }),
        )
        .await;
    assert_eq!(op_still_pending["data"]["reason"], "dialog_pending");

    let accept_ok = mcp
        .call_ok(
            "bsk_assist",
            json!({
                "action": "dialog_accept",
                "scope": "agent-alpha",
                "dialog_id": "dlg-1"
            }),
        )
        .await;
    assert_eq!(accept_ok["dialog"]["handled"], "accepted");

    let awaited = mcp
        .call_ok(
            "bsk_assist",
            json!({
                "action": "operation_await",
                "scope": "agent-alpha",
                "operation_id": op_id,
                "wait_ms": 1000
            }),
        )
        .await;
    assert_eq!(awaited["state"], "completed");
    assert_eq!(awaited["result"]["replay"]["state"], "completed");

    // Chain B Counterexample 2: bsk_interact(download) timeout/unknown triggers WAL UNKNOWN freeze ->
    // subsequent mutating bsk_interact(click) blocked before WS dispatch with uncertain_prior_effect
    // + mcp_hint naming bsk_ledger (NOT "bsk ledger resolve") -> bsk_ledger(status/resolve) -> click ok.
    ext_state.lock().unwrap().fail_next_download_unknown = true;
    let dl_out = home.path().join("out.bin");
    let dl_err = mcp
        .call_err(
            "bsk_interact",
            json!({
                "action": "download",
                "scope": "agent-alpha",
                "tab_id": 7,
                "context": &next_ctx,
                "params": { "ref": "@e5", "out": dl_out }
            }),
        )
        .await;
    assert_eq!(dl_err["data"]["reason"], "action_timeout");

    let before_frozen_click = ext_state.lock().unwrap().recorded.len();
    let frozen_click = mcp
        .call_err(
            "bsk_interact",
            json!({
                "action": "click",
                "scope": "agent-alpha",
                "tab_id": 7,
                "context": &next_ctx,
                "params": { "ref": "@e1" }
            }),
        )
        .await;
    assert_eq!(frozen_click["data"]["reason"], "uncertain_prior_effect");
    let wal_hint = frozen_click["hint"].as_str().unwrap_or("");
    assert!(
        wal_hint.contains("bsk_ledger"),
        "expected mcp_hint naming bsk_ledger, got: {wal_hint}"
    );
    assert!(
        !wal_hint.contains("bsk ledger resolve"),
        "mcp_hint leaked CLI command 'bsk ledger resolve': {wal_hint}"
    );
    assert_eq!(
        ext_state.lock().unwrap().recorded.len(),
        before_frozen_click,
        "frozen mutating click must NOT dispatch over WS"
    );

    let ledger_status = mcp
        .call_ok(
            "bsk_ledger",
            json!({
                "action": "status",
                "scope": "agent-alpha"
            }),
        )
        .await;
    assert_eq!(ledger_status["frozen"], true);
    assert_eq!(
        ledger_status["pending_unknown"][0]["method"],
        "tool.download"
    );

    let ledger_resolve = mcp
        .call_ok(
            "bsk_ledger",
            json!({
                "action": "resolve",
                "scope": "agent-alpha"
            }),
        )
        .await;
    assert_eq!(ledger_resolve["resolved_count"], 1);

    let click_resumed = mcp
        .call_ok(
            "bsk_interact",
            json!({
                "action": "click",
                "scope": "agent-alpha",
                "tab_id": 7,
                "context": &next_ctx,
                "params": { "ref": "@e1" }
            }),
        )
        .await;
    assert_eq!(click_resumed["tab_id"], 7);

    // Cleanly stop scoped sessions.
    let _ = mcp
        .call_ok("bsk_session", json!({ "action": "stop", "all": true }))
        .await;
    let _ = mcp.child.kill().await;
}
