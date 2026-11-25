//! Top-level full-chain E2E tests for CLI, MCP, orchestration, record, and recipe contracts
//! (`bsk` CLI / `bsk mcp` stdio subprocess -> real in-process Daemon -> mock WS `"2.0"` browser):
//! 1. MCP `bsk_inspect` (`screenshot full_page=true`, `observe probe_hover=true`) and sibling
//!    `bsk_page` / `bsk_tabs` / `bsk_assist` action metadata parity + fail-closed offline checks.
//! 2. CLI `bsk debug` & MCP `bsk_debug` cooperation guards (`DebugAction::cooperation_guarded()`)
//!    and implicit session / `scope` resolution (plus offline `capabilities` preservation).
//! 3. Real wire MCP error recovery hints (`bsk_session(browsers|wait)`, `bsk_assist(dialog_status)`,
//!    `bsk_inspect(html)`, `bsk_interact(upload, params={"mode":"drop"})`).
//! 4. Dynamic IPC timeout (`navigate` 60s) and `post_sync` cached VOM hydration across
//!    CLI `bsk step`, CLI `bsk plan`, MCP `bsk_interact(sync_after=true)`, and MCP `bsk_plan`
//!    on `unchanged` and text-`delta`, plus non-reusable field-delta counterexample.
//! 5. Recipe runner `delta -> unchanged` stale VOM refresh via `ToolSnapshot`.
//! 6. MCP `bsk_record(action="start")` uncancelled `SessionStop` cleanup on `notifications/cancelled`,
//!    preserving `record-session.json` on stop failure for recovery via `bsk_record(action="stop")`,
//!    isolated `:record` scope preserving browsing session, and stdio EOF reaping.

use std::net::SocketAddr;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bsk::daemon::info::DaemonInfo;
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::{
    ScreenshotFullPageResult, ScreenshotScope, SessionStartParams, SessionStartResult,
};
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, Frame, Method, RequestFrame, ResponseBody, ResponseFrame, RpcError,
    RpcErrorReason,
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
const TEST_EXT_ID_2: &str = "bcdefghijklmnopabcdefghijklmnopa";

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_ext(addr: std::net::SocketAddr, ext_id: &str) -> Ws {
    let origin = format!("chrome-extension://{ext_id}");
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
    tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .unwrap()
        .unwrap()
}

struct McpProcess {
    child: Child,
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
            child,
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
                    "clientInfo": { "name": "contracts-e2e", "version": "1.0" }
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

    async fn send_tool_call_async(&mut self, name: &str, arguments: Value) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        self.send_raw(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments,
            },
        }))
        .await;
        id
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
        let reply = self.read_reply().await;
        assert_eq!(reply["id"], id, "mismatched json-rpc id: {reply}");
        reply
    }

    async fn read_reply(&mut self) -> Value {
        let mut out = String::new();
        tokio::time::timeout(Duration::from_secs(15), self.stdout.read_line(&mut out))
            .await
            .expect("mcp reply timed out")
            .expect("read mcp line");
        serde_json::from_str(out.trim_end()).expect("parse mcp json")
    }

    async fn call_tool_full(&mut self, name: &str, arguments: Value) -> Value {
        let resp = self
            .rpc(
                "tools/call",
                json!({
                    "name": name,
                    "arguments": arguments,
                }),
            )
            .await;
        assert!(
            resp.get("error").is_none(),
            "unexpected json-rpc protocol error for {name}: {resp}"
        );
        resp["result"].clone()
    }

    async fn call_tool_json(&mut self, name: &str, arguments: Value) -> (bool, Value) {
        let result = self.call_tool_full(name, arguments).await;
        let is_error = result["isError"].as_bool().unwrap_or(false);
        let text = result["content"][0]["text"]
            .as_str()
            .expect("mcp json text block");
        let parsed: Value = serde_json::from_str(text).expect("valid tool json");
        (is_error, parsed)
    }

    async fn call_ok(&mut self, name: &str, arguments: Value) -> Value {
        let (is_error, body) = self.call_tool_json(name, arguments).await;
        assert!(!is_error, "expected ok result for {name}, got: {body}");
        body
    }

    async fn call_err(&mut self, name: &str, arguments: Value) -> Value {
        let (is_error, body) = self.call_tool_json(name, arguments).await;
        assert!(is_error, "expected error result for {name}, got: {body}");
        body
    }

    async fn await_cancelled_settled(&mut self, cancelled_id: i64) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            self.send_raw(&json!({
                "jsonrpc": "2.0",
                "id": cancelled_id,
                "method": "tools/call",
                "params": {
                    "name": "bsk_session",
                    "arguments": { "action": "browsers" }
                }
            }))
            .await;
            let reply = self.read_reply().await;
            if reply["id"] == cancelled_id && reply.get("result").is_some() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "cancelled MCP request {cancelled_id} did not settle: {reply}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    async fn wait_exit(&mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(10), self.child.wait()).await;
    }
}

/// Isolated `bsk daemon` child process scoped strictly to `BSK_HOME=<tempdir>`
/// so tests never touch `~/.bsk/run/transfers` or `~/.bsk/intent_ledger.jsonl`.
struct SpawnedDaemon {
    child: Child,
    ws_addr: SocketAddr,
}

impl SpawnedDaemon {
    async fn start(home: &Path) -> Self {
        let trust = run_bsk_at(home, &["daemon", "trust-local", "on"], &[]).await;
        assert!(
            trust.status.success(),
            "bsk daemon trust-local on failed: stdout={} stderr={}",
            String::from_utf8_lossy(&trust.stdout),
            String::from_utf8_lossy(&trust.stderr)
        );
        let log_path = home.join("test-daemon.log");
        let log_file = std::fs::File::create(&log_path).expect("create daemon log");
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
        cmd.args(["daemon", "start", "--foreground", "--port", "0"])
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
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log_file))
            .kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn isolated bsk daemon");
        let info_path = home.join("daemon.json");
        let deadline = Instant::now() + Duration::from_secs(10);
        let info: DaemonInfo = loop {
            if let Ok(raw) = std::fs::read(&info_path)
                && let Ok(parsed) = serde_json::from_slice::<DaemonInfo>(&raw)
                && parsed.ws_port > 0
            {
                break parsed;
            }
            if let Some(status) = child.try_wait().expect("poll daemon child") {
                panic!(
                    "isolated daemon exited early ({status}): {}",
                    std::fs::read_to_string(&log_path).unwrap_or_default()
                );
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {}: {}",
                info_path.display(),
                std::fs::read_to_string(&log_path).unwrap_or_default()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let ws_addr = SocketAddr::from(([127, 0, 0, 1], info.ws_port));
        Self { child, ws_addr }
    }

    fn ws_addr(&self) -> SocketAddr {
        self.ws_addr
    }

    async fn shutdown(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

struct ContractEnv {
    home: tempfile::TempDir,
    daemon: SpawnedDaemon,
    ext_requests: Arc<Mutex<Vec<RequestFrame>>>,
}

impl ContractEnv {
    async fn start<F>(reply: F) -> Self
    where
        F: Fn(&RequestFrame) -> ResponseBody + Send + Sync + 'static,
    {
        let home = crate::support::short_tempdir();
        let daemon = SpawnedDaemon::start(home.path()).await;
        let ws_addr = daemon.ws_addr();

        let mut ws = connect_ext(ws_addr, TEST_EXT_ID).await;
        do_handshake(&mut ws, TEST_EXT_ID, "ContractsChrome").await;

        let ext_requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&ext_requests);
        let (writer, mut reader): (SplitSink<Ws, Message>, SplitStream<Ws>) = ws.split();
        let writer = Arc::new(tokio::sync::Mutex::new(writer));
        let reply = Arc::new(reply);
        let mut next_window_id: i64 = 400;
        tokio::spawn(async move {
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
                recorded.lock().unwrap().push(req.clone());
                let body = match req.method {
                    Method::ToolSessionStart => {
                        let _: SessionStartParams =
                            serde_json::from_value(req.params.clone().unwrap()).unwrap();
                        let wid = next_window_id;
                        next_window_id += 1;
                        ResponseBody::Ok(
                            serde_json::to_value(SessionStartResult {
                                interaction: None,
                                agent_window_id: Some(wid),
                            })
                            .unwrap(),
                        )
                    }
                    Method::ToolSessionStop => ResponseBody::Ok(json!({})),
                    _ => reply(&req),
                };
                let resp = ResponseFrame { id: req.id, body };
                let mut w = writer.lock().await;
                if w.send(Message::Text(serde_json::to_string(&resp).unwrap()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });

        Self {
            home,
            daemon,
            ext_requests,
        }
    }

    async fn run_bsk(&self, args: &[&str], envs: &[(&str, &str)]) -> std::process::Output {
        run_bsk_at(self.home.path(), args, envs).await
    }

    fn take_requests(&self) -> Vec<RequestFrame> {
        std::mem::take(&mut *self.ext_requests.lock().unwrap())
    }

    async fn shutdown(self) {
        self.daemon.shutdown().await;
    }
}

// ---------------------------------------------------------------------------
// 1. P1 #4 — MCP `bsk_inspect` & sibling action metadata parity
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mcp_inspect_and_sibling_action_metadata_full_chain() {
    let env = ContractEnv::start(|req| match &req.method {
        Method::ToolTabCreate => ResponseBody::Ok(json!({
            "tab_id": 11,
            "url": "https://app.test",
            "title": "App"
        })),
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 11,
            "url": "https://app.test/next",
            "title": "Next",
            "reached": "load"
        })),
        Method::ToolCooperate => ResponseBody::Ok(json!({
            "tab_id": 11,
            "control_policy": "target",
            "kind": "baseline",
            "history_complete": true,
            "context_id": "ctx-meta-1",
            "observation_id": "obs-meta-1",
            "changes": [],
            "observation": {
                "observation_id": "obs-meta-1",
                "tab_id": 11,
                "url": "https://app.test",
                "title": "App",
                "text": "@vom 1\nL1 page\n  @e1 button \"Submit\"",
                "ref_count": 1,
                "truncated": false
            },
            "state": { "mode": "ready", "revision": 1 }
        })),
        Method::ToolScreenshotFullPage => ResponseBody::Ok(
            serde_json::to_value(ScreenshotFullPageResult {
                tab_id: 11,
                capture_id: "cap-fp-1".into(),
                width: 1280,
                height: 2400,
                byte_size: 4,
                format: "png".into(),
                scope: Some(ScreenshotScope::Follow),
                dialogs: vec![],
            })
            .unwrap(),
        ),
        Method::ToolScreenshotRead => ResponseBody::Ok(json!({
            "data_base64": "AQIDBA==",
            "next_offset": 4,
            "eof": true
        })),
        Method::ToolScreenshotRelease => ResponseBody::Ok(json!({})),
        Method::ToolObserve => ResponseBody::Ok(json!({
            "observation_id": "obs-hover-2",
            "tab_id": 11,
            "url": "https://app.test",
            "title": "App",
            "text": "@vom 1\nL1 page\n  @e1 button \"Submit\"",
            "ref_count": 1,
            "truncated": false
        })),
        Method::ToolRead => ResponseBody::Ok(json!({
            "tab_id": 11,
            "items": [{ "ref": "@e1", "values": { "label": "Submit" } }]
        })),
        Method::ToolWindowResize => ResponseBody::Ok(json!({
            "window_id": 400,
            "width": 1280,
            "height": 720
        })),
        Method::ToolEmulate => ResponseBody::Ok(json!({
            "tab_id": 11,
            "active": true
        })),
        Method::ToolTabClose => ResponseBody::Ok(json!({
            "closed": true
        })),
        other => panic!("unexpected method in metadata E2E: {other:?}"),
    })
    .await;

    let mut mcp = McpProcess::spawn(env.home.path(), &[]).await;
    let opened = mcp
        .call_ok(
            "bsk_session",
            json!({"action": "open", "url": "https://app.test"}),
        )
        .await;
    let ctx = opened["context_id"].as_str().unwrap().to_owned();
    let obs = opened["observation_id"].as_str().unwrap().to_owned();
    let expect = json!([{"target": "@e1", "field": "text", "equals": "Submit"}]);
    let depends_on = json!(["@e1"]);

    let assert_full_meta = |req: &RequestFrame, label: &str| {
        let p = req.params.as_ref().expect("request params");
        assert_eq!(p["context_id"], ctx, "{label} missing context_id: {p}");
        assert_eq!(
            p["observation_id"], obs,
            "{label} missing observation_id: {p}"
        );
        assert_eq!(p["expect"], expect, "{label} missing expect: {p}");
        assert_eq!(
            p["depends_on"], depends_on,
            "{label} missing depends_on: {p}"
        );
    };

    // 1. bsk_inspect(screenshot, full_page=true) forwards all 4 metadata fields.
    env.take_requests();
    let fp_out = env.home.path().join("full-page.png");
    let fp_reply = mcp
        .call_ok(
            "bsk_inspect",
            json!({
                "action": "screenshot",
                "full_page": true,
                "out": fp_out,
                "context": ctx,
                "observation": obs,
                "expect": expect,
                "depends_on": depends_on,
            }),
        )
        .await;
    assert_eq!(fp_reply["byte_size"], 4);
    assert!(fp_out.exists());
    let reqs = env.take_requests();
    let fp_req = reqs
        .iter()
        .find(|r| r.method == Method::ToolScreenshotFullPage)
        .expect("ToolScreenshotFullPage dispatched");
    assert_full_meta(fp_req, "screenshot full_page");

    // 2. bsk_inspect(observe, probe_hover=true) forwards all 4 metadata fields.
    env.take_requests();
    let _ = mcp
        .call_ok(
            "bsk_inspect",
            json!({
                "action": "observe",
                "probe_hover": true,
                "context": ctx,
                "observation": obs,
                "expect": expect,
                "depends_on": depends_on,
            }),
        )
        .await;
    let reqs = env.take_requests();
    let obs_req = reqs
        .iter()
        .find(|r| r.method == Method::ToolObserve)
        .expect("ToolObserve dispatched");
    assert_eq!(obs_req.params.as_ref().unwrap()["probe_hover"], true);
    assert_full_meta(obs_req, "observe probe_hover");

    // 3. bsk_inspect(read) accepts context only and forwards context_id.
    env.take_requests();
    let _ = mcp
        .call_ok(
            "bsk_inspect",
            json!({
                "action": "read",
                "ref": "@e1",
                "read_fields": [{"key": "label", "read": "text"}],
                "context": ctx,
            }),
        )
        .await;
    let read_req = env
        .take_requests()
        .into_iter()
        .find(|r| r.method == Method::ToolRead)
        .expect("ToolRead dispatched");
    assert_eq!(read_req.params.as_ref().unwrap()["context_id"], ctx);

    // 4. bsk_page(navigate) forwards expect & depends_on in addition to context & observation.
    env.take_requests();
    let _ = mcp
        .call_ok(
            "bsk_page",
            json!({
                "action": "navigate",
                "url": "https://app.test/next",
                "context": ctx,
                "observation": obs,
                "expect": expect,
                "depends_on": depends_on,
            }),
        )
        .await;
    let nav_req = env
        .take_requests()
        .into_iter()
        .find(|r| r.method == Method::ToolNavigate)
        .expect("ToolNavigate dispatched");
    assert_full_meta(&nav_req, "page navigate");

    // 5. bsk_assist(resize & emulate) forward all 4 metadata fields.
    env.take_requests();
    let _ = mcp
        .call_ok(
            "bsk_assist",
            json!({
                "action": "resize",
                "width": 1280,
                "height": 720,
                "context": ctx,
                "observation": obs,
                "expect": expect,
                "depends_on": depends_on,
            }),
        )
        .await;
    let resize_req = env
        .take_requests()
        .into_iter()
        .find(|r| r.method == Method::ToolWindowResize)
        .expect("ToolWindowResize dispatched");
    assert_full_meta(&resize_req, "assist resize");

    env.take_requests();
    let _ = mcp
        .call_ok(
            "bsk_assist",
            json!({
                "action": "emulate",
                "device": "iphone-14",
                "context": ctx,
                "observation": obs,
                "expect": expect,
                "depends_on": depends_on,
            }),
        )
        .await;
    let emulate_req = env
        .take_requests()
        .into_iter()
        .find(|r| r.method == Method::ToolEmulate)
        .expect("ToolEmulate dispatched");
    assert_full_meta(&emulate_req, "assist emulate");

    // 6. bsk_tabs(close) forwards all 4 metadata fields.
    env.take_requests();
    let _ = mcp
        .call_ok(
            "bsk_tabs",
            json!({
                "action": "close",
                "tab_id": 11,
                "context": ctx,
                "observation": obs,
                "expect": expect,
                "depends_on": depends_on,
            }),
        )
        .await;
    let close_req = env
        .take_requests()
        .into_iter()
        .find(|r| r.method == Method::ToolTabClose)
        .expect("ToolTabClose dispatched");
    assert_full_meta(&close_req, "tabs close");

    // 6b. Second bsk_session(open) on an already-synchronized session forwards all 4 metadata fields to ToolNavigate.
    env.take_requests();
    let _ = mcp
        .call_ok(
            "bsk_session",
            json!({
                "action": "open",
                "url": "https://app.test/next2",
                "context": ctx,
                "observation": obs,
                "expect": expect,
                "depends_on": depends_on,
            }),
        )
        .await;
    let reopen_nav = env
        .take_requests()
        .into_iter()
        .find(|r| r.method == Method::ToolNavigate)
        .expect("reopen ToolNavigate dispatched");
    assert_full_meta(&reopen_nav, "session reopen navigate");

    // 7. Non-guarded siblings fail closed offline with invalid_params and ZERO WS calls.
    env.take_requests();
    for (tool, args) in [
        ("bsk_session", json!({"action": "sync", "observation": obs})),
        (
            "bsk_inspect",
            json!({"action": "screenshot", "full_page": false, "observation": obs}),
        ),
        (
            "bsk_inspect",
            json!({"action": "observe", "probe_hover": false, "observation": obs}),
        ),
        (
            "bsk_inspect",
            json!({"action": "read", "ref": "@e1", "read_fields": [{"key": "t", "read": "text"}], "observation": obs}),
        ),
        (
            "bsk_page",
            json!({"action": "wait_for_element", "selector": "#ok", "expect": expect}),
        ),
        ("bsk_tabs", json!({"action": "list", "expect": expect})),
        (
            "bsk_assist",
            json!({"action": "dialog_status", "depends_on": depends_on}),
        ),
    ] {
        let err = mcp.call_err(tool, args.clone()).await;
        assert_eq!(
            err["code"], "invalid_params",
            "expected offline invalid_params for {tool} {args}, got {err}"
        );
    }
    assert!(
        env.take_requests().is_empty(),
        "offline metadata rejections must not dispatch to extension"
    );
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// 2. P1 #5 + P2-3 — CLI/MCP `bsk debug` cooperation guards & implicit session
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cli_and_mcp_debug_cooperation_guards_and_implicit_session_full_chain() {
    let env = ContractEnv::start(|req| match &req.method {
        Method::ToolTabCreate => ResponseBody::Ok(json!({
            "tab_id": 12,
            "url": "https://dbg.test",
            "title": "Dbg"
        })),
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 12,
            "url": "https://dbg.test",
            "title": "Dbg",
            "reached": "load"
        })),
        Method::ToolCooperate => ResponseBody::Ok(json!({
            "tab_id": 12,
            "control_policy": "target",
            "kind": "baseline",
            "history_complete": true,
            "context_id": "ctx-dbg-1",
            "observation_id": "obs-dbg-1",
            "changes": [],
            "observation": {
                "observation_id": "obs-dbg-1",
                "tab_id": 12,
                "url": "https://dbg.test",
                "title": "Dbg",
                "text": "@vom 1\nL1 page\n  @e1 button \"Refresh\"",
                "ref_count": 1,
                "truncated": false
            },
            "state": { "mode": "ready", "revision": 1 }
        })),
        Method::ToolDebug => {
            let p = req.params.as_ref().unwrap();
            let action = p["action"].as_str().unwrap_or("");
            match action {
                "capabilities" => ResponseBody::Ok(json!({
                    "session_id": p["session_id"],
                    "action": "capabilities",
                    "capabilities": {
                        "extension": { "version": "0.5.0", "live": true }
                    }
                })),
                _ => ResponseBody::Ok(json!({
                    "session_id": p["session_id"],
                    "action": action,
                    "tab_id": 12
                })),
            }
        }
        other => panic!("unexpected method in debug E2E: {other:?}"),
    })
    .await;

    // 1. Offline CLI `bsk debug capabilities` (no --session, no --scope) stays offline.
    env.take_requests();
    let offline_cli = env.run_bsk(&["debug", "capabilities"], &[]).await;
    assert!(
        offline_cli.status.success(),
        "offline cli capabilities failed: {}",
        String::from_utf8_lossy(&offline_cli.stderr)
    );
    let offline_json: Value = serde_json::from_slice(&offline_cli.stdout).unwrap();
    assert_eq!(offline_json["discovery"], "cli_schema_only");
    assert!(env.take_requests().is_empty());

    // 2. Establish CLI scope `dbg-cli` via `bsk open`.
    let open_out = env
        .run_bsk(
            &["open", "https://dbg.test", "--json"],
            &[("BSK_SCOPE", "dbg-cli")],
        )
        .await;
    assert!(
        open_out.status.success(),
        "open failed: {}",
        String::from_utf8_lossy(&open_out.stderr)
    );
    let cli_sid = serde_json::from_slice::<Value>(&open_out.stdout).unwrap()["session_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // 3. CLI `bsk debug` without `--session` resolves implicit session via `--scope` for:
    //    - extension read (`status`), daemon action (`activity`), live `capabilities`.
    env.take_requests();
    let status_out = env
        .run_bsk(&["debug", "--scope", "dbg-cli", "status"], &[])
        .await;
    assert!(
        status_out.status.success(),
        "debug status via --scope failed: {}",
        String::from_utf8_lossy(&status_out.stderr)
    );
    let status_req = env
        .take_requests()
        .into_iter()
        .find(|r| r.method == Method::ToolDebug)
        .expect("debug status forwarded");
    assert_eq!(status_req.params.as_ref().unwrap()["session_id"], cli_sid);

    let act_out = env
        .run_bsk(&["debug", "--scope", "dbg-cli", "activity"], &[])
        .await;
    assert!(
        act_out.status.success(),
        "debug activity via --scope failed: {}",
        String::from_utf8_lossy(&act_out.stderr)
    );
    let act_json: Value = serde_json::from_slice(&act_out.stdout).unwrap();
    assert_eq!(act_json["session_id"], cli_sid);

    env.take_requests();
    let live_caps = env
        .run_bsk(&["debug", "--scope", "dbg-cli", "capabilities"], &[])
        .await;
    assert!(
        live_caps.status.success(),
        "debug capabilities via --scope failed: {}",
        String::from_utf8_lossy(&live_caps.stderr)
    );
    let live_caps_json: Value = serde_json::from_slice(&live_caps.stdout).unwrap();
    assert_eq!(live_caps_json["capabilities"]["extension"]["live"], true);
    assert!(!env.take_requests().is_empty());

    // 4. All 4 cooperation-guarded rule write commands + replay accept & forward full metadata
    //    (without --session, using --scope dbg-cli).
    let expect_arg = r#"[{"target":"@e1","field":"text","equals":"Refresh"}]"#;
    let rule_json = r#"{"match":{"url":"https://dbg.test/api"},"effect":{"type":"mock","status":503,"body":"{}"}}"#;
    let guarded_cmds: Vec<(&str, Vec<&str>)> = vec![
        (
            "rule_add",
            vec![
                "--context",
                "ctx-dbg-1",
                "--observation",
                "obs-dbg-1",
                "--expect",
                expect_arg,
                "--depends-on",
                "@e1",
                "debug",
                "--scope",
                "dbg-cli",
                "rule_add",
                "--rule",
                rule_json,
            ],
        ),
        (
            "rule_enable",
            vec![
                "--context",
                "ctx-dbg-1",
                "--observation",
                "obs-dbg-1",
                "--expect",
                expect_arg,
                "--depends-on",
                "@e1",
                "debug",
                "--scope",
                "dbg-cli",
                "rule_enable",
                "rule-1",
            ],
        ),
        (
            "rule_disable",
            vec![
                "--context",
                "ctx-dbg-1",
                "--observation",
                "obs-dbg-1",
                "--expect",
                expect_arg,
                "--depends-on",
                "@e1",
                "debug",
                "--scope",
                "dbg-cli",
                "rule_disable",
                "rule-1",
            ],
        ),
        (
            "rule_remove",
            vec![
                "--context",
                "ctx-dbg-1",
                "--observation",
                "obs-dbg-1",
                "--expect",
                expect_arg,
                "--depends-on",
                "@e1",
                "debug",
                "--scope",
                "dbg-cli",
                "rule_remove",
                "rule-1",
            ],
        ),
        (
            "replay",
            vec![
                "--context",
                "ctx-dbg-1",
                "--observation",
                "obs-dbg-1",
                "--expect",
                expect_arg,
                "--depends-on",
                "@e1",
                "debug",
                "--scope",
                "dbg-cli",
                "replay",
                "req-1",
                "--replay",
                r#"{"key":"idem-1"}"#,
            ],
        ),
    ];

    for (expected_action, args) in guarded_cmds {
        env.take_requests();
        let out = env.run_bsk(&args, &[]).await;
        assert!(
            out.status.success(),
            "CLI debug {expected_action} with cooperation metadata failed: stdout={} stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let req = env
            .take_requests()
            .into_iter()
            .find(|r| r.method == Method::ToolDebug)
            .unwrap_or_else(|| panic!("no ToolDebug forwarded for {expected_action}"));
        let p = req.params.as_ref().unwrap();
        assert_eq!(p["action"], expected_action);
        assert_eq!(p["session_id"], cli_sid);
        assert_eq!(p["context_id"], "ctx-dbg-1");
        assert_eq!(p["observation_id"], "obs-dbg-1");
        assert_eq!(p["depends_on"], json!(["@e1"]));
        assert!(p["expect"].is_array());
    }

    // 5. Non-guarded debug action rejects cooperation metadata offline.
    env.take_requests();
    let bad = env
        .run_bsk(
            &[
                "--context",
                "ctx-dbg-1",
                "debug",
                "--scope",
                "dbg-cli",
                "status",
            ],
            &[],
        )
        .await;
    assert!(!bad.status.success());
    assert!(env.take_requests().is_empty());

    // 6. MCP `bsk_debug` offline capabilities, explicit scope capabilities, and implicit conn_scope.
    let mut mcp = McpProcess::spawn(env.home.path(), &[]).await;
    env.take_requests();
    let mcp_offline_caps = mcp
        .call_ok("bsk_debug", json!({"action": "capabilities"}))
        .await;
    assert_eq!(mcp_offline_caps["discovery"], "cli_schema_only");
    assert!(env.take_requests().is_empty());

    let mcp_scoped_caps = mcp
        .call_ok(
            "bsk_debug",
            json!({"action": "capabilities", "scope": "dbg-cli"}),
        )
        .await;
    assert_eq!(mcp_scoped_caps["capabilities"]["extension"]["live"], true);

    let mcp_opened = mcp
        .call_ok(
            "bsk_session",
            json!({"action": "open", "url": "https://dbg.test"}),
        )
        .await;
    let mcp_sid = mcp_opened["session_id"].as_str().unwrap().to_owned();

    env.take_requests();
    let mcp_status = mcp.call_ok("bsk_debug", json!({"action": "status"})).await;
    assert_eq!(mcp_status["session_id"], mcp_sid);
    let mcp_act = mcp
        .call_ok("bsk_debug", json!({"action": "activity"}))
        .await;
    assert_eq!(mcp_act["session_id"], mcp_sid);
    let mcp_rule = mcp
        .call_ok(
            "bsk_debug",
            json!({
                "action": "rule_add",
                "rule": {"match": {"url": "https://dbg.test/tracker"}, "effect": {"type": "mock", "status": 503, "body": "{}"}},
                "context": "ctx-dbg-1",
                "observation": "obs-dbg-1",
                "expect": [{"target": "@e1", "field": "text", "equals": "Refresh"}],
                "depends_on": ["@e1"],
            }),
        )
        .await;
    assert_eq!(mcp_rule["session_id"], mcp_sid);
    let rule_req = env
        .take_requests()
        .into_iter()
        .rfind(|r| r.method == Method::ToolDebug)
        .expect("mcp rule_add forwarded");
    let rp = rule_req.params.as_ref().unwrap();
    assert_eq!(rp["action"], "rule_add");
    assert_eq!(rp["session_id"], mcp_sid);
    assert_eq!(rp["context_id"], "ctx-dbg-1");
    assert_eq!(rp["observation_id"], "obs-dbg-1");
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// 3. P1 #6 — Real wire MCP error recovery hints match actual MCP schemas
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mcp_error_recovery_hints_e2e_wire_contract() {
    let env = ContractEnv::start(|req| match &req.method {
        Method::ToolTabCreate => ResponseBody::Ok(json!({
            "tab_id": 13,
            "url": "https://hints.test",
            "title": "Hints"
        })),
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 13,
            "url": "https://hints.test",
            "title": "Hints",
            "reached": "load"
        })),
        Method::ToolCooperate => ResponseBody::Ok(json!({
            "tab_id": 13,
            "control_policy": "target",
            "kind": "baseline",
            "history_complete": true,
            "context_id": "ctx-h-1",
            "observation_id": "obs-h-1",
            "changes": [],
            "observation": {
                "observation_id": "obs-h-1",
                "tab_id": 13,
                "url": "https://hints.test",
                "title": "Hints",
                "text": "@vom 1\nL1 page\n  @e1 button \"Upload\"",
                "ref_count": 1,
                "truncated": false
            },
            "state": { "mode": "ready", "revision": 1 }
        })),
        Method::ToolClick => {
            let p = req.params.as_ref().unwrap();
            match p.get("selector").and_then(Value::as_str) {
                Some("#human") => ResponseBody::Err(RpcError {
                    code: ErrorCode::PermissionDenied,
                    message: "human is interacting".into(),
                    data: Some(json!({
                        "reason": RpcErrorReason::HumanIntervention.as_str(),
                        "session_id": p["session_id"],
                    })),
                }),
                Some("#dialog") => ResponseBody::Err(RpcError {
                    code: ErrorCode::DialogPending,
                    message: "native dialog open".into(),
                    data: Some(json!({
                        "reason": RpcErrorReason::DialogPending.as_str(),
                        "session_id": p["session_id"],
                        "dialog": { "id": "d-1", "kind": "confirm", "message": "Sure?" },
                    })),
                }),
                Some("#frame") => ResponseBody::Err(RpcError {
                    code: ErrorCode::PermissionDenied,
                    message: "frame unobservable".into(),
                    data: Some(json!({
                        "reason": RpcErrorReason::FrameUnobservable.as_str(),
                        "session_id": p["session_id"],
                    })),
                }),
                _ => ResponseBody::Ok(json!({"tab_id": 13, "x": 1.0, "y": 1.0})),
            }
        }
        Method::ToolUpload => ResponseBody::Err(RpcError {
            code: ErrorCode::Unsupported,
            message: "file input not activated".into(),
            data: Some(json!({
                "reason": RpcErrorReason::FileInputNotActivated.as_str(),
            })),
        }),
        other => panic!("unexpected method in hints E2E: {other:?}"),
    })
    .await;

    let mut mcp = McpProcess::spawn(env.home.path(), &[]).await;
    let opened = mcp
        .call_ok(
            "bsk_session",
            json!({"action": "open", "url": "https://hints.test"}),
        )
        .await;
    let ctx = opened["context_id"].as_str().unwrap().to_owned();

    // 1. human_intervention -> bsk_session(action='wait', ...), never cooperate_wait / session_id
    let human_err = mcp
        .call_err(
            "bsk_interact",
            json!({"action": "click", "params": {"selector": "#human"}, "context": ctx}),
        )
        .await;
    let human_hint = human_err["hint"].as_str().unwrap_or("");
    assert!(
        human_hint.contains("bsk_session(action='wait'"),
        "expected bsk_session(action='wait'), got: {human_hint}"
    );
    assert!(!human_hint.contains("cooperate_wait"), "{human_hint}");
    assert!(!human_hint.contains("session_id="), "{human_hint}");

    // 2. dialog_pending -> bsk_assist(action='dialog_status', session=...), never session_id=
    let dialog_err = mcp
        .call_err(
            "bsk_interact",
            json!({"action": "click", "params": {"selector": "#dialog"}, "context": ctx}),
        )
        .await;
    let dialog_hint = dialog_err["hint"].as_str().unwrap_or("");
    assert!(
        dialog_hint.contains("bsk_assist(action='dialog_status', session="),
        "expected session= in dialog hint, got: {dialog_hint}"
    );
    assert!(!dialog_hint.contains("session_id="), "{dialog_hint}");

    // 3. frame_unobservable -> bsk_inspect(action='html'...), never get_html
    let frame_err = mcp
        .call_err(
            "bsk_interact",
            json!({"action": "click", "params": {"selector": "#frame"}, "context": ctx}),
        )
        .await;
    let frame_hint = frame_err["hint"].as_str().unwrap_or("");
    assert!(
        frame_hint.contains("bsk_inspect(action='html'"),
        "expected action='html' in frame hint, got: {frame_hint}"
    );
    assert!(!frame_hint.contains("get_html"), "{frame_hint}");

    // 4. file_input_not_activated -> params={"mode": "drop", ...}, never top-level mode='drop'
    let upload_file = env.home.path().join("sample.txt");
    std::fs::write(&upload_file, b"hello").unwrap();
    let upload_err = mcp
        .call_err(
            "bsk_interact",
            json!({
                "action": "upload",
                "params": {"selector": "#dropzone", "files": [upload_file]},
                "context": ctx,
            }),
        )
        .await;
    let upload_hint = upload_err["hint"].as_str().unwrap_or("");
    assert!(
        upload_hint.contains(r#""mode": "drop""#),
        "expected nested params mode drop, got: {upload_hint}"
    );
    assert!(!upload_hint.contains("mode='drop'"), "{upload_hint}");

    // 5. Connect a second browser -> multiple_browsers_online hint uses action='browsers', never 'status'
    let mut ws2 = connect_ext(env.daemon.ws_addr(), TEST_EXT_ID_2).await;
    do_handshake(&mut ws2, TEST_EXT_ID_2, "SecondChrome").await;
    let mut mcp2 = McpProcess::spawn(env.home.path(), &[]).await;
    let multi_err = mcp2
        .call_err(
            "bsk_session",
            json!({"action": "open", "url": "https://two.test"}),
        )
        .await;
    let multi_hint = multi_err["hint"].as_str().unwrap_or("");
    assert!(
        multi_hint.contains("bsk_session(action='browsers')"),
        "expected action='browsers' in multi-browser hint, got: {multi_hint}"
    );
    assert!(
        !multi_hint.contains("bsk_session(action='status')"),
        "{multi_hint}"
    );
    drop(ws2);
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// 4. P1 #7 + P2-3 — Dynamic IPC timeout & post_sync cached VOM hydration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn orchestration_dynamic_ipc_timeout_and_post_sync_vom_hydration_full_chain() {
    let sync_stage = Arc::new(AtomicUsize::new(0));
    let sync_stage_ext = Arc::clone(&sync_stage);
    let env = ContractEnv::start(move |req| match &req.method {
        Method::ToolTabCreate => ResponseBody::Ok(json!({
            "tab_id": 14,
            "url": "https://shop.test",
            "title": "Shop"
        })),
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 14,
            "url": req.params.as_ref().unwrap()["url"],
            "title": "Shop",
            "reached": "load"
        })),
        Method::ToolClick | Method::ToolHover => ResponseBody::Ok(json!({
            "tab_id": 14,
            "x": 12.0,
            "y": 14.0
        })),
        Method::ToolCooperate => {
            let stage = sync_stage_ext.fetch_add(1, Ordering::SeqCst);
            match stage {
                // Stage 0: initial baseline on open
                0 => ResponseBody::Ok(json!({
                    "tab_id": 14,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": "ctx-s0",
                    "observation_id": "obs-s0",
                    "changes": [],
                    "observation": {
                        "observation_id": "obs-s0",
                        "tab_id": 14,
                        "url": "https://shop.test",
                        "title": "Shop",
                        "text": "@vom 1\nL1 page\n  heading \"Shop\"\n  @e1 button \"Buy $10\"",
                        "ref_count": 1,
                        "truncated": false
                    },
                    "state": { "mode": "ready", "revision": 1 }
                })),
                // Stage 1: CLI `bsk step` (navigate 60s) post-sync slim `unchanged`
                1 => ResponseBody::Ok(json!({
                    "tab_id": 14,
                    "control_policy": "target",
                    "kind": "unchanged",
                    "history_complete": true,
                    "previous_context_id": "ctx-s0",
                    "context_id": "ctx-s0",
                    "observation_id": "obs-s0",
                    "changes": [],
                    "state": { "mode": "ready", "revision": 1 }
                })),
                // Stage 2: CLI `bsk plan` post-sync slim text-delta ($10 -> $25)
                2 => ResponseBody::Ok(json!({
                    "tab_id": 14,
                    "control_policy": "target",
                    "kind": "delta",
                    "history_complete": true,
                    "previous_context_id": "ctx-s0",
                    "previous_observation_id": "obs-s0",
                    "context_id": "ctx-s2",
                    "observation_id": "obs-s2",
                    "changes": [{
                        "kind": "text",
                        "previous_value": "Buy $10",
                        "value": "Buy $25",
                        "lines": [4]
                    }],
                    "observation_patch": {
                        "lines": [{
                            "line": 4,
                            "previous": "  @e1 button \"Buy $10\"",
                            "text": "  @e1 button \"Buy $25\""
                        }]
                    },
                    "state": { "mode": "ready", "revision": 2 }
                })),
                // Stage 3: MCP `bsk_interact(sync_after=true)` post-sync slim `unchanged`
                3 => ResponseBody::Ok(json!({
                    "tab_id": 14,
                    "control_policy": "target",
                    "kind": "unchanged",
                    "history_complete": true,
                    "previous_context_id": "ctx-s2",
                    "context_id": "ctx-s2",
                    "observation_id": "obs-s2",
                    "changes": [],
                    "state": { "mode": "ready", "revision": 2 }
                })),
                // Stage 4: MCP `bsk_plan` post-sync slim text-delta ($25 -> $40)
                4 => ResponseBody::Ok(json!({
                    "tab_id": 14,
                    "control_policy": "target",
                    "kind": "delta",
                    "history_complete": true,
                    "previous_context_id": "ctx-s2",
                    "previous_observation_id": "obs-s2",
                    "context_id": "ctx-s4",
                    "observation_id": "obs-s4",
                    "changes": [{
                        "kind": "text",
                        "previous_value": "Buy $25",
                        "value": "Buy $40",
                        "lines": [4]
                    }],
                    "observation_patch": {
                        "lines": [{
                            "line": 4,
                            "previous": "  @e1 button \"Buy $25\"",
                            "text": "  @e1 button \"Buy $40\""
                        }]
                    },
                    "state": { "mode": "ready", "revision": 3 }
                })),
                // Stage 5: unpatched field-delta (no observation_patch -> cache_reusable=false)
                _ => ResponseBody::Ok(json!({
                    "tab_id": 14,
                    "control_policy": "target",
                    "kind": "delta",
                    "history_complete": true,
                    "previous_context_id": "ctx-s4",
                    "previous_observation_id": "obs-s4",
                    "context_id": "ctx-s5",
                    "observation_id": "obs-s5",
                    "changes": [{
                        "kind": "field",
                        "ref": "@e1",
                        "previous_value": "old",
                        "value": "new"
                    }],
                    "state": { "mode": "ready", "revision": 4 }
                })),
            }
        }
        other => panic!("unexpected method in hydration E2E: {other:?}"),
    })
    .await;

    let scope = [("BSK_SCOPE", "orch-scope")];
    let open_out = env
        .run_bsk(&["open", "https://shop.test", "--json"], &scope)
        .await;
    assert!(open_out.status.success());

    // 1. CLI `bsk step` with slow navigate (`timeout_ms: 60000`) & `unchanged` post_sync hydration
    env.take_requests();
    let step_out = env
        .run_bsk(
            &[
                "--context",
                "ctx-s0",
                "step",
                "--action",
                "navigate",
                "--params",
                r#"{"url":"https://shop.test/slow","timeout_ms":60000}"#,
            ],
            &scope,
        )
        .await;
    assert!(
        step_out.status.success(),
        "bsk step navigate 60s failed: stdout={} stderr={}",
        String::from_utf8_lossy(&step_out.stdout),
        String::from_utf8_lossy(&step_out.stderr)
    );
    let nav_req = env
        .take_requests()
        .into_iter()
        .find(|r| r.method == Method::ToolNavigate)
        .expect("ToolNavigate sent");
    assert_eq!(nav_req.params.as_ref().unwrap()["timeout_ms"], 60_000);
    let step_json: Value = serde_json::from_slice(&step_out.stdout).unwrap();
    assert!(
        step_json["post"]["observation"]["text"]
            .as_str()
            .unwrap_or("")
            .contains("Buy $10"),
        "bsk step must hydrate post.observation.text on unchanged: {step_json}"
    );
    assert_eq!(step_json["post"]["observation_origin"]["kind"], "reused");

    // 2. CLI `bsk plan` with text-delta post_sync hydration
    let plan_out = env
        .run_bsk(
            &[
                "--context",
                "ctx-s0",
                "plan",
                "--steps",
                r#"[{"action":"click","ref":"@e1","timeout_ms":30000}]"#,
            ],
            &scope,
        )
        .await;
    assert!(
        plan_out.status.success(),
        "bsk plan failed: {}",
        String::from_utf8_lossy(&plan_out.stderr)
    );
    let plan_json: Value = serde_json::from_slice(&plan_out.stdout).unwrap();
    assert!(
        plan_json["post"]["observation"]["text"]
            .as_str()
            .unwrap_or("")
            .contains("Buy $25"),
        "bsk plan must hydrate post.observation.text on text-delta: {plan_json}"
    );
    assert_eq!(plan_json["post"]["observation_origin"]["kind"], "merged");

    // 3. MCP `bsk_interact(sync_after=true)` with `unchanged` post_sync hydration -> VOM block 1!
    let mut mcp = McpProcess::spawn(env.home.path(), &scope).await;
    let interact_full = mcp
        .call_tool_full(
            "bsk_interact",
            json!({
                "action": "hover",
                "params": {"ref": "@e1", "timeout_ms": 30000},
                "context": "ctx-s2",
                "sync_after": true,
            }),
        )
        .await;
    assert_ne!(interact_full["isError"], true, "{interact_full}");
    let interact_blocks = interact_full["content"].as_array().unwrap();
    assert_eq!(
        interact_blocks.len(),
        2,
        "MCP bsk_interact(sync_after=true) must return VOM content block on unchanged: {interact_full}"
    );
    assert!(
        interact_blocks[1]["text"]
            .as_str()
            .unwrap_or("")
            .contains("Buy $25"),
        "MCP interact VOM block missing hydrated text: {interact_full}"
    );

    // 4. MCP `bsk_plan` with text-delta post_sync hydration -> updated VOM block 1!
    let plan_full = mcp
        .call_tool_full(
            "bsk_plan",
            json!({
                "steps": [{"action": "click", "ref": "@e1"}],
                "context": "ctx-s2",
            }),
        )
        .await;
    assert_ne!(plan_full["isError"], true, "{plan_full}");
    let plan_blocks = plan_full["content"].as_array().unwrap();
    assert_eq!(
        plan_blocks.len(),
        2,
        "MCP bsk_plan must return VOM content block on text-delta: {plan_full}"
    );
    assert!(
        plan_blocks[1]["text"]
            .as_str()
            .unwrap_or("")
            .contains("Buy $40"),
        "MCP plan VOM block missing patched text: {plan_full}"
    );

    // 5. Counterexample: unpatched field-delta MUST NOT resurrect stale cached VOM!
    let stale_full = mcp
        .call_tool_full(
            "bsk_interact",
            json!({
                "action": "click",
                "params": {"ref": "@e1"},
                "context": "ctx-s4",
                "sync_after": true,
            }),
        )
        .await;
    assert_ne!(stale_full["isError"], true, "{stale_full}");
    let stale_blocks = stale_full["content"].as_array().unwrap();
    assert_eq!(
        stale_blocks.len(),
        1,
        "unpatched field-delta must not hydrate stale VOM block: {stale_full}"
    );
    let stale_json: Value =
        serde_json::from_str(stale_blocks[0]["text"].as_str().unwrap()).unwrap();
    assert!(
        stale_json["post"].get("observation").is_none(),
        "unpatched field-delta must leave post.observation absent: {stale_json}"
    );
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// 5. P1 #8 — Recipe Runner `delta -> unchanged` stale VOM refresh via snapshot
// ---------------------------------------------------------------------------

#[tokio::test]
async fn recipe_runner_delta_unchanged_refreshes_stale_vom_via_snapshot() {
    let sync_calls = Arc::new(AtomicUsize::new(0));
    let sync_calls_ext = Arc::clone(&sync_calls);
    let env = ContractEnv::start(move |req| match &req.method {
        Method::ToolTabCreate => ResponseBody::Ok(json!({
            "tab_id": 15,
            "url": "http://site.test/report",
            "title": "Sales"
        })),
        Method::ToolTabList => ResponseBody::Ok(json!({
            "tabs": [{
                "tab_id": 15,
                "active": true,
                "url": "http://site.test/report",
                "title": "Sales"
            }]
        })),
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 15,
            "url": "http://site.test/report",
            "title": "Sales",
            "reached": "load"
        })),
        Method::ToolSelect => ResponseBody::Ok(json!({"tab_id": 15, "selected": ["East"]})),
        Method::ToolClick => ResponseBody::Ok(json!({"tab_id": 15, "x": 10.0, "y": 10.0})),
        Method::ToolCooperate => {
            let n = sync_calls_ext.fetch_add(1, Ordering::SeqCst);
            match n {
                // Initial sync: baseline before action
                0 => ResponseBody::Ok(json!({
                    "tab_id": 15,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": "ctx-r0",
                    "observation_id": "obs-r0",
                    "changes": [],
                    "observation": {
                        "observation_id": "obs-r0",
                        "tab_id": 15,
                        "url": "http://site.test/report",
                        "title": "Sales",
                        "text": "@vom 1\nL1 page\n  heading \"Sales\"\n  @e1 combobox \"Region\"\n  @e2 button \"Search\"\n  status \"Pending\"",
                        "ref_count": 2,
                        "truncated": false
                    },
                    "state": { "mode": "ready", "revision": 1 }
                })),
                // Post-click sync #1: unpatched field delta (NO observation, NO observation_patch!)
                1 => ResponseBody::Ok(json!({
                    "tab_id": 15,
                    "control_policy": "target",
                    "kind": "delta",
                    "history_complete": true,
                    "previous_context_id": "ctx-r0",
                    "previous_observation_id": "obs-r0",
                    "context_id": "ctx-r1",
                    "observation_id": "obs-r1",
                    "changes": [{
                        "kind": "field",
                        "ref": "@e1",
                        "previous_value": "",
                        "value": "East"
                    }],
                    "state": { "mode": "ready", "revision": 2 }
                })),
                // Subsequent syncs during await_until: `unchanged` with realistic fresh
                // `observation_id` (matching real extension `crypto.randomUUID()` on every sync)
                // and `previous_observation_id` pointing at the prior sync.
                _ => ResponseBody::Ok(json!({
                    "tab_id": 15,
                    "control_policy": "target",
                    "kind": "unchanged",
                    "history_complete": true,
                    "previous_context_id": "ctx-r1",
                    "previous_observation_id": format!("obs-r{n}"),
                    "context_id": "ctx-r1",
                    "observation_id": format!("obs-r{}", n + 1),
                    "changes": [],
                    "state": { "mode": "ready", "revision": 2 }
                })),
            }
        }
        Method::ToolSnapshot => ResponseBody::Ok(json!({
            "observation_id": "obs-r1",
            "tab_id": 15,
            "url": "http://site.test/report",
            "title": "Sales",
            "text": "@vom 1\nL1 page\n  heading \"Sales\"\n  @e1 combobox \"Region\" =\"East\"\n  @e2 button \"Search\"\n  status \"Total $99\"",
            "ref_count": 2,
            "truncated": false
        })),
        other => panic!("unexpected method in recipe delta E2E: {other:?}"),
    })
    .await;

    let recipe = json!({
        "recipe_version": 1,
        "name": "sales-delta",
        "description": "Verify delta->unchanged stale VOM refresh",
        "site": {"origins": ["http://site.test"], "start": "/report"},
        "params": {"region": {"type": "enum", "values": ["East", "North"]}},
        "segments": [{
            "id": "query",
            "requires": [{"role": "heading", "name": "Sales"}],
            "steps": [
                {"action": "select", "target": {"role": "combobox", "name": "Region"}, "values": ["{{region}}"]},
                {"action": "click", "target": {"role": "button", "name": "Search"}}
            ],
            "until": {"text": "Total $99", "timeout_ms": 2000}
        }],
        "outputs": {"total": {"regex": "Total \\$(\\d+)", "required": true}}
    });
    let recipe_path = env.home.path().join("sales-delta.json");
    std::fs::write(&recipe_path, serde_json::to_vec(&recipe).unwrap()).unwrap();

    let save_out = env
        .run_bsk(
            &["recipe", "save", "--file", recipe_path.to_str().unwrap()],
            &[("BSK_RECIPES", "1")],
        )
        .await;
    assert!(
        save_out.status.success(),
        "recipe save failed: {}",
        String::from_utf8_lossy(&save_out.stderr)
    );

    env.take_requests();
    let run_out = env
        .run_bsk(
            &["recipe", "run", "sales-delta", "--param", "region=East"],
            &[("BSK_RECIPES", "1")],
        )
        .await;
    assert!(
        run_out.status.success(),
        "recipe run failed: stdout={} stderr={}",
        String::from_utf8_lossy(&run_out.stdout),
        String::from_utf8_lossy(&run_out.stderr)
    );
    let reply: Value = serde_json::from_slice(&run_out.stdout).unwrap();
    assert_eq!(reply["status"], "completed", "{reply}");
    assert_eq!(reply["outputs"]["total"], "99", "{reply}");

    let reqs = env.take_requests();
    assert!(
        reqs.iter().any(|r| r.method == Method::ToolSnapshot),
        "runner must call ToolSnapshot to refresh stale VOM after unpatched delta -> unchanged"
    );

    // Part 2: When a clean baseline is followed by an `unchanged` sync carrying a fresh
    // `observation_id` and matching `previous_observation_id`, the runner must preserve the
    // cached VOM WITHOUT issuing a redundant ToolSnapshot!
    let clean_sync_calls = Arc::new(AtomicUsize::new(0));
    let clean_sync_ext = Arc::clone(&clean_sync_calls);
    let clean_env = ContractEnv::start(move |req| match &req.method {
        Method::ToolTabCreate => ResponseBody::Ok(json!({
            "tab_id": 18,
            "url": "http://site.test/report",
            "title": "Sales"
        })),
        Method::ToolTabList => ResponseBody::Ok(json!({
            "tabs": [{
                "tab_id": 18,
                "active": true,
                "url": "http://site.test/report",
                "title": "Sales"
            }]
        })),
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 18,
            "url": "http://site.test/report",
            "title": "Sales",
            "reached": "load"
        })),
        Method::ToolClick | Method::ToolHover => ResponseBody::Ok(json!({"tab_id": 18, "x": 10.0, "y": 10.0})),
        Method::ToolCooperate => {
            let n = clean_sync_ext.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                ResponseBody::Ok(json!({
                    "tab_id": 18,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": "ctx-c0",
                    "observation_id": "obs-c0",
                    "changes": [],
                    "observation": {
                        "observation_id": "obs-c0",
                        "tab_id": 18,
                        "url": "http://site.test/report",
                        "title": "Sales",
                        "text": "@vom 1\nL1 page\n  heading \"Sales\"\n  @e1 button \"Refresh\"\n  status \"Total $55\"",
                        "ref_count": 1,
                        "truncated": false
                    },
                    "state": { "mode": "ready", "revision": 1 }
                }))
            } else {
                ResponseBody::Ok(json!({
                    "tab_id": 18,
                    "control_policy": "target",
                    "kind": "unchanged",
                    "history_complete": true,
                    "previous_context_id": "ctx-c0",
                    "previous_observation_id": format!("obs-c{}", n - 1),
                    "context_id": "ctx-c0",
                    "observation_id": format!("obs-c{n}"),
                    "changes": [],
                    "state": { "mode": "ready", "revision": 1 }
                }))
            }
        }
        other => panic!("unexpected method in clean unchanged recipe E2E: {other:?}"),
    })
    .await;
    let clean_recipe = json!({
        "recipe_version": 1,
        "name": "sales-clean-unchanged",
        "description": "Unchanged sync with rotating observation_id keeps VOM without ToolSnapshot",
        "site": {"origins": ["http://site.test"], "start": "/report"},
        "params": {},
        "segments": [
            {
                "id": "step1",
                "requires": [{"role": "heading", "name": "Sales"}],
                "steps": [
                    {"action": "click", "target": {"role": "button", "name": "Refresh"}}
                ]
            },
            {
                "id": "step2",
                "requires": [{"role": "heading", "name": "Sales"}],
                "steps": [
                    {"action": "hover", "target": {"role": "button", "name": "Refresh"}}
                ]
            }
        ],
        "outputs": {"total": {"regex": "Total \\$(\\d+)", "required": true}}
    });
    let clean_path = clean_env.home.path().join("sales-clean-unchanged.json");
    std::fs::write(&clean_path, serde_json::to_vec(&clean_recipe).unwrap()).unwrap();
    assert!(
        clean_env
            .run_bsk(
                &["recipe", "save", "--file", clean_path.to_str().unwrap()],
                &[("BSK_RECIPES", "1")],
            )
            .await
            .status
            .success()
    );
    clean_env.take_requests();
    let clean_run = clean_env
        .run_bsk(
            &["recipe", "run", "sales-clean-unchanged"],
            &[("BSK_RECIPES", "1")],
        )
        .await;
    assert!(
        clean_run.status.success(),
        "clean unchanged recipe failed: stdout={} stderr={}",
        String::from_utf8_lossy(&clean_run.stdout),
        String::from_utf8_lossy(&clean_run.stderr)
    );
    let clean_reply: Value = serde_json::from_slice(&clean_run.stdout).unwrap();
    assert_eq!(clean_reply["status"], "completed", "{clean_reply}");
    assert_eq!(clean_reply["outputs"]["total"], "55", "{clean_reply}");
    assert!(
        !clean_env
            .take_requests()
            .iter()
            .any(|r| r.method == Method::ToolSnapshot),
        "clean unchanged poll with fresh observation_id must not call redundant ToolSnapshot"
    );
    clean_env.shutdown().await;
    env.shutdown().await;
}

// ---------------------------------------------------------------------------
// 6. P1 #9 — MCP `bsk_record(action="start")` cancel cleanup & EOF reaping
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mcp_record_cancel_cleanup_preserve_on_failure_and_eof_reap_full_chain() {
    let home = crate::support::short_tempdir();
    let daemon = SpawnedDaemon::start(home.path()).await;
    let ws_addr = daemon.ws_addr();

    let mut ws = connect_ext(ws_addr, TEST_EXT_ID).await;
    do_handshake(&mut ws, TEST_EXT_ID, "RecordChrome").await;
    let (writer, mut reader): (SplitSink<Ws, Message>, SplitStream<Ws>) = ws.split();
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

    let await_entered = Arc::new(tokio::sync::Notify::new());
    let fail_next_stop = Arc::new(AtomicBool::new(false));
    let record_stop_not_found = Arc::new(AtomicBool::new(false));
    let stall_cancel_for_eof = Arc::new(AtomicBool::new(false));
    let stopped_sessions: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let pending_await: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let await_entered_ext = Arc::clone(&await_entered);
    let fail_next_stop_ext = Arc::clone(&fail_next_stop);
    let record_stop_not_found_ext = Arc::clone(&record_stop_not_found);
    let stall_cancel_ext = Arc::clone(&stall_cancel_for_eof);
    let stopped_ext = Arc::clone(&stopped_sessions);
    let pending_await_ext = Arc::clone(&pending_await);
    let writer_ext = Arc::clone(&writer);

    let trace_payload = || {
        json!({
            "version": 3,
            "started_at": "2026-11-21T00:00:00Z",
            "recorded_at": "2026-11-21T00:00:01Z",
            "stopped_by": "user_finish",
            "entry": { "start_url": "https://rec.test/" },
            "recorder": { "bsk": env!("CARGO_PKG_VERSION"), "vom": 1 },
            "states": [{
                "id": "s1",
                "url": "https://rec.test/",
                "title": "Rec",
                "body": "@vom 1\nRootWebArea \"Rec\"",
                "truncated": false
            }],
            "steps": []
        })
    };

    tokio::spawn(async move {
        let mut next_window_id: i64 = 500;
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
            if req.method == Method::ToolRecordAwait {
                *pending_await_ext.lock().unwrap() = Some(req.id.clone());
                await_entered_ext.notify_one();
                continue;
            }
            if req.method == Method::Cancel {
                let target_rpc = req
                    .params
                    .as_ref()
                    .and_then(|p| p.get("rpc_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let cancel_resp = ResponseFrame {
                    id: req.id,
                    body: ResponseBody::Ok(json!({ "cancelled": true })),
                };
                let mut w = writer_ext.lock().await;
                let _ = w
                    .send(Message::Text(serde_json::to_string(&cancel_resp).unwrap()))
                    .await;
                let maybe_pending = {
                    let mut guard = pending_await_ext.lock().unwrap();
                    if guard.as_deref() == Some(target_rpc.as_str()) {
                        guard.take()
                    } else {
                        None
                    }
                };
                if let Some(await_id) = maybe_pending
                    && !stall_cancel_ext.load(Ordering::SeqCst)
                {
                    let await_resp = ResponseFrame {
                        id: await_id,
                        body: ResponseBody::Err(RpcError {
                            code: ErrorCode::Cancelled,
                            message: "record await cancelled".into(),
                            data: None,
                        }),
                    };
                    let _ = w
                        .send(Message::Text(serde_json::to_string(&await_resp).unwrap()))
                        .await;
                }
                continue;
            }

            let body = match req.method {
                Method::ToolSessionStart => {
                    let wid = next_window_id;
                    next_window_id += 1;
                    ResponseBody::Ok(
                        serde_json::to_value(SessionStartResult {
                            interaction: None,
                            agent_window_id: Some(wid),
                        })
                        .unwrap(),
                    )
                }
                Method::ToolTabCreate => ResponseBody::Ok(json!({
                    "tab_id": 16,
                    "url": "https://browse.test",
                    "title": "Browse"
                })),
                Method::ToolNavigate => ResponseBody::Ok(json!({
                    "tab_id": 16,
                    "url": "https://browse.test",
                    "title": "Browse",
                    "reached": "load"
                })),
                Method::ToolCooperate => ResponseBody::Ok(json!({
                    "tab_id": 16,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": "ctx-rec-browse",
                    "observation_id": "obs-rec-browse",
                    "changes": [],
                    "observation": {
                        "observation_id": "obs-rec-browse",
                        "tab_id": 16,
                        "url": "https://browse.test",
                        "title": "Browse",
                        "text": "@vom 1\nL1 page\n  heading \"Browse\"",
                        "ref_count": 0,
                        "truncated": false
                    },
                    "state": { "mode": "ready", "revision": 1 }
                })),
                Method::ToolRecordStart => {
                    ResponseBody::Ok(json!({ "recording": true, "tab_id": 17 }))
                }
                Method::ToolRecordStop => {
                    if record_stop_not_found_ext.swap(false, Ordering::SeqCst) {
                        ResponseBody::Err(RpcError {
                            code: ErrorCode::NotFound,
                            message: "recording already ended".into(),
                            data: None,
                        })
                    } else {
                        ResponseBody::Ok(json!({ "trace": trace_payload() }))
                    }
                }
                Method::ToolSessionStop => {
                    let sid = req
                        .params
                        .as_ref()
                        .and_then(|p| p.get("session_id"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    if fail_next_stop_ext.swap(false, Ordering::SeqCst) {
                        ResponseBody::Err(RpcError {
                            code: ErrorCode::ProtocolError,
                            message: "simulated browser close failure".into(),
                            data: None,
                        })
                    } else {
                        stopped_ext.lock().unwrap().push(sid);
                        ResponseBody::Ok(json!({}))
                    }
                }
                other => panic!("unexpected method in record E2E: {other:?}"),
            };
            let resp = ResponseFrame { id: req.id, body };
            let mut w = writer_ext.lock().await;
            if w.send(Message::Text(serde_json::to_string(&resp).unwrap()))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    let wait_for_record_state = |home: &Path| {
        let path = home.join("record-session.json");
        async move {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if let Ok(raw) = std::fs::read_to_string(&path)
                    && let Ok(v) = serde_json::from_str::<Value>(&raw)
                    && let Some(sid) = v["session_id"].as_str()
                {
                    return sid.to_owned();
                }
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting for {}",
                    path.display()
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    };

    // --- Scenario A: Cancel `bsk_record(start)` -> uncancelled SessionStop succeeds & clears pointer ---
    let mut mcp = McpProcess::spawn(home.path(), &[]).await;
    let browse = mcp
        .call_ok(
            "bsk_session",
            json!({"action": "open", "url": "https://browse.test"}),
        )
        .await;
    let browse_sid = browse["session_id"].as_str().unwrap().to_owned();

    let out_a = home.path().join("trace-a");
    let rec_a_id = mcp
        .send_tool_call_async("bsk_record", json!({"action": "start", "output": out_a}))
        .await;
    tokio::time::timeout(Duration::from_secs(5), await_entered.notified())
        .await
        .expect("ToolRecordAwait entered (A)");
    let rec_a_sid = wait_for_record_state(home.path()).await;
    assert_ne!(rec_a_sid, browse_sid);

    mcp.notify(
        "notifications/cancelled",
        json!({"requestId": rec_a_id, "reason": "user cancelled"}),
    )
    .await;
    mcp.await_cancelled_settled(rec_a_id).await;

    assert!(
        stopped_sessions.lock().unwrap().contains(&rec_a_sid),
        "cancel cleanup must send uncancelled SessionStop for {rec_a_sid}"
    );
    assert!(
        !home.path().join("record-session.json").exists(),
        "record-session.json must be cleared after confirmed SessionStop"
    );

    // Caller's browsing session in `conn_scope` must remain alive & unaffected!
    let sync_ok = mcp.call_ok("bsk_session", json!({"action": "sync"})).await;
    assert_eq!(sync_ok["tab_id"], 16);

    // --- Scenario B: Cancel when SessionStop fails -> preserve record-session.json, recover via stop ---
    fail_next_stop.store(true, Ordering::SeqCst);
    let out_b = home.path().join("trace-b");
    let rec_b_id = mcp
        .send_tool_call_async("bsk_record", json!({"action": "start", "output": out_b}))
        .await;
    tokio::time::timeout(Duration::from_secs(5), await_entered.notified())
        .await
        .expect("ToolRecordAwait entered (B)");
    let rec_b_sid = wait_for_record_state(home.path()).await;

    mcp.notify(
        "notifications/cancelled",
        json!({"requestId": rec_b_id, "reason": "user cancelled"}),
    )
    .await;
    mcp.await_cancelled_settled(rec_b_id).await;

    // Because SessionStop failed, record-session.json MUST remain so `bsk_record(stop)` can recover!
    assert!(
        home.path().join("record-session.json").exists(),
        "record-session.json must be preserved when SessionStop fails"
    );
    let out_b_stop = home.path().join("trace-b-stop");
    let stop_ok = mcp
        .call_ok(
            "bsk_record",
            json!({"action": "stop", "output": out_b_stop}),
        )
        .await;
    assert_eq!(stop_ok["window_closed"], true);
    assert!(stopped_sessions.lock().unwrap().contains(&rec_b_sid));
    assert!(
        !home.path().join("record-session.json").exists(),
        "record-session.json must be cleared after successful recovery stop"
    );

    // --- Scenario B2: Recording already ended (`ToolRecordStop` -> NotFound) while Agent Window
    //     remains live -> `bsk_record(stop)` still closes the live session before clearing pointer ---
    fail_next_stop.store(true, Ordering::SeqCst);
    let out_b2 = home.path().join("trace-b2");
    let rec_b2_id = mcp
        .send_tool_call_async("bsk_record", json!({"action": "start", "output": out_b2}))
        .await;
    tokio::time::timeout(Duration::from_secs(5), await_entered.notified())
        .await
        .expect("ToolRecordAwait entered (B2)");
    let rec_b2_sid = wait_for_record_state(home.path()).await;
    mcp.notify(
        "notifications/cancelled",
        json!({"requestId": rec_b2_id, "reason": "user cancelled"}),
    )
    .await;
    mcp.await_cancelled_settled(rec_b2_id).await;
    assert!(home.path().join("record-session.json").exists());

    record_stop_not_found.store(true, Ordering::SeqCst);
    let out_b2_stop = home.path().join("trace-b2-stop");
    let not_found_err = mcp
        .call_err(
            "bsk_record",
            json!({"action": "stop", "output": out_b2_stop}),
        )
        .await;
    assert_eq!(not_found_err["code"], "not_found");
    assert!(
        stopped_sessions.lock().unwrap().contains(&rec_b2_sid),
        "bsk_record(stop) must close live Agent Window {rec_b2_sid} when ToolRecordStop returns NotFound"
    );
    assert!(
        !home.path().join("record-session.json").exists(),
        "record-session.json must be cleared once live Agent Window is closed"
    );

    // --- Scenario C: Abrupt stdio EOF while recording -> reaps BOTH browsing & :record sessions ---
    // Keep ToolRecordAwait stalled on cancel so the EOF shutdown reaper handles the `:record` scope too.
    stall_cancel_for_eof.store(true, Ordering::SeqCst);
    let out_c = home.path().join("trace-c");
    let _rec_c_id = mcp
        .send_tool_call_async("bsk_record", json!({"action": "start", "output": out_c}))
        .await;
    tokio::time::timeout(Duration::from_secs(5), await_entered.notified())
        .await
        .expect("ToolRecordAwait entered (C)");
    let rec_c_sid = wait_for_record_state(home.path()).await;

    mcp.close_stdin();
    mcp.wait_exit().await;

    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let stopped = stopped_sessions.lock().unwrap().clone();
        if stopped.contains(&browse_sid)
            && stopped.contains(&rec_c_sid)
            && !home.path().join("record-session.json").exists()
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "EOF reaper did not stop both browsing ({browse_sid}) and record ({rec_c_sid}) sessions; stopped={stopped:?}, state_exists={}",
            home.path().join("record-session.json").exists()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // --- Scenario D: CLI sibling `bsk record start` cancelled via BSK_CANCEL_ON_STDIN_CLOSE=1 ---
    // 1) When SessionStop succeeds after cancellation: CLI still dispatches uncancelled SessionStop
    //    and clears record-session.json.
    stall_cancel_for_eof.store(false, Ordering::SeqCst);
    let spawn_cli_record = |home: &Path, out: &Path| {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
        cmd.args([
            "record",
            "start",
            "--output",
            out.to_str().unwrap(),
            "--json",
        ])
        .env("BSK_HOME", home)
        .env("BSK_AUTO_START", "0")
        .env("BSK_AUTO_UPDATE", "off")
        .env("BSK_CANCEL_ON_STDIN_CLOSE", "1")
        .env_remove("BSK_SESSION")
        .env_remove("BSK_SCOPE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
        cmd.spawn().expect("spawn bsk record start")
    };

    let out_d1 = home.path().join("trace-cli-d1");
    let mut cli_d1 = spawn_cli_record(home.path(), &out_d1);
    let cli_d1_stdin = cli_d1.stdin.take().unwrap();
    tokio::select! {
        _ = tokio::time::timeout(Duration::from_secs(5), await_entered.notified()) => {}
        status = cli_d1.wait() => {
            let mut out = String::new();
            let mut err = String::new();
            let _ = tokio::io::AsyncReadExt::read_to_string(cli_d1.stdout.as_mut().unwrap(), &mut out).await;
            let _ = tokio::io::AsyncReadExt::read_to_string(cli_d1.stderr.as_mut().unwrap(), &mut err).await;
            panic!("CLI record start D1 exited early ({status:?}): stdout={out} stderr={err}");
        }
    }
    let rec_d1_sid = wait_for_record_state(home.path()).await;
    drop(cli_d1_stdin);
    let d1_out = tokio::time::timeout(Duration::from_secs(10), cli_d1.wait_with_output())
        .await
        .expect("CLI record start D1 exited")
        .unwrap();
    assert!(!d1_out.status.success());
    assert!(
        stopped_sessions.lock().unwrap().contains(&rec_d1_sid),
        "CLI bsk record start cancel cleanup must dispatch uncancelled SessionStop for {rec_d1_sid}"
    );
    assert!(
        !home.path().join("record-session.json").exists(),
        "CLI cancel cleanup must clear record-session.json after confirmed SessionStop"
    );

    // 2) When SessionStop fails after CLI cancellation: record-session.json is preserved, and
    //    CLI `bsk record stop` on ToolRecordStop NotFound still closes the live window before clearing!
    fail_next_stop.store(true, Ordering::SeqCst);
    let out_d2 = home.path().join("trace-cli-d2");
    let mut cli_d2 = spawn_cli_record(home.path(), &out_d2);
    let cli_d2_stdin = cli_d2.stdin.take().unwrap();
    tokio::time::timeout(Duration::from_secs(5), await_entered.notified())
        .await
        .expect("CLI ToolRecordAwait entered (D2)");
    let rec_d2_sid = wait_for_record_state(home.path()).await;
    drop(cli_d2_stdin);
    let _ = tokio::time::timeout(Duration::from_secs(10), cli_d2.wait_with_output())
        .await
        .expect("CLI record start D2 exited")
        .unwrap();
    assert!(
        home.path().join("record-session.json").exists(),
        "CLI must preserve record-session.json when cancel SessionStop fails"
    );
    record_stop_not_found.store(true, Ordering::SeqCst);
    let out_d2_stop = home.path().join("trace-cli-d2-stop");
    let d2_stop = run_bsk_at(
        home.path(),
        &[
            "record",
            "stop",
            "--output",
            out_d2_stop.to_str().unwrap(),
            "--json",
        ],
        &[],
    )
    .await;
    assert!(!d2_stop.status.success());
    assert!(
        stopped_sessions.lock().unwrap().contains(&rec_d2_sid),
        "CLI bsk record stop must close live Agent Window {rec_d2_sid} on ToolRecordStop NotFound"
    );
    assert!(
        !home.path().join("record-session.json").exists(),
        "CLI bsk record stop must clear record-session.json once live window is closed"
    );

    daemon.shutdown().await;
}
