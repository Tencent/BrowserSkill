//! Wave 3A top-level full-chain integration & adversarial counterexample suite:
//! - Counterexample A: `--max-tokens` truncation budget isolation (`truncated` + `next_cursor`
//!   preserved across `unchanged`, truncated cache never pollutes unbounded `bsk sync`),
//!   `target`-policy text `delta` line patching (`bsk sync --match` hits updated full-page cache
//!   with `presentation` preserved), and form `field` `delta` safety invalidation (`last_vom`
//!   cleared so stale `value="..."` is never matched).
//! - Counterexample B: `--max-tokens` + `--wait-for` below-cutoff full-page `tool.snapshot`
//!   fallback succeeds on the first poll with `refs_replaced: true` instead of timing out (exit 4).
//! - Counterexample C: `DialogPending` -> `bsk dialog accept` + `bsk operation await` full
//!   reconciliation closure (`run_logs` resolved to real completed step rather than `Uncertain`,
//!   `intent_wal` unlocked without `uncertain_prior_effect`, `scopes` updated) + `IpcEnvelope`
//!   wire purity (zero private `_` keys in local IPC `params`/`result`, while extension WS frames
//!   still carry `_operation_id` / `_audit_id`).
//! - Counterexample D: Host-agent scope sharing (`HOST_AGENT_ENV_KEYS` outranks transient
//!   `mcp:<pid>:<nonce>`, surviving MCP `stdio` EOF) vs isolated `bsk mcp` immediate `stdio` EOF
//!   orphan reaping, unified 12-table `DaemonState::teardown_session` bug fixes (idle-timeout
//!   `dialog_operations` cleanup + reason preservation across subsequent `BrowserGone`, unclaimed
//!   `session_requests::cleanup` 12-table teardown), and 256-capacity LRU eviction.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bsk::daemon::info::DaemonInfo;
use bsk::daemon::run_log::LoggedStep;
use bsk::daemon::sessions::SessionId;
use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::{IpcClient, IpcRequestMeta};
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::{SessionStartParams, SessionStartResult};
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, Frame, Method, RequestFrame, ResponseBody, ResponseFrame,
};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

const TEST_EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

const PRIVATE_IPC_KEYS: &[&str] = &[
    "_caller_scope",
    "_bind_scope",
    "_reuse_or_start_scope",
    "_explicit_incognito",
    "_return_scope_meta",
    "_audit_id",
    "_operation_id",
    "_scope_meta",
    "_carried_activity",
];

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn assert_no_private_ipc_keys(value: &Value, context: &str) {
    match value {
        Value::Object(map) => {
            for key in map.keys() {
                assert!(
                    !PRIVATE_IPC_KEYS.contains(&key.as_str()),
                    "private IPC field `{key}` leaked into business payload ({context}): {value}"
                );
            }
            for (k, v) in map {
                assert_no_private_ipc_keys(v, &format!("{context}.{k}"));
            }
        }
        Value::Array(items) => {
            for (idx, item) in items.iter().enumerate() {
                assert_no_private_ipc_keys(item, &format!("{context}[{idx}]"));
            }
        }
        _ => {}
    }
}

struct IsolatedEnv {
    home: tempfile::TempDir,
    sock: std::path::PathBuf,
    handle: daemon::DaemonHandle,
    ext_requests: Arc<Mutex<Vec<RequestFrame>>>,
}

impl IsolatedEnv {
    async fn start_with_config<F>(config: DaemonConfig, reply: F) -> Self
    where
        F: Fn(&RequestFrame) -> ResponseBody + Send + Sync + 'static,
    {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let sock = home.path().join("ipc.sock");
        let handle = daemon::run(config, Some(sock.clone())).await.unwrap();
        let ws_addr = handle.ws_addr();
        let info = DaemonInfo::now(
            std::process::id(),
            sock.clone(),
            ws_addr.port(),
            bsk::daemon::state::DAEMON_VERSION,
        );
        std::fs::write(
            home.path().join("daemon.json"),
            serde_json::to_vec(&info).unwrap(),
        )
        .unwrap();

        let mut ws = connect_ext(ws_addr).await;
        do_handshake(&mut ws, TEST_EXT_ID).await;

        let ext_requests = Arc::new(Mutex::new(Vec::new()));
        spawn_mock_extension(ws, Arc::clone(&ext_requests), reply);

        Self {
            home,
            sock,
            handle,
            ext_requests,
        }
    }

    async fn start<F>(reply: F) -> Self
    where
        F: Fn(&RequestFrame) -> ResponseBody + Send + Sync + 'static,
    {
        Self::start_with_config(
            DaemonConfig::new(0)
                .with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal),
            reply,
        )
        .await
    }

    async fn run_bsk(&self, args: &[&str], envs: &[(&str, &str)]) -> std::process::Output {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
        cmd.env("BSK_HOME", self.home.path())
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

    fn take_requests(&self) -> Vec<RequestFrame> {
        std::mem::take(&mut *self.ext_requests.lock().unwrap())
    }

    async fn shutdown(self) {
        self.handle.shutdown().await;
    }
}

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

async fn do_handshake(ws: &mut Ws, instance_id: &str) -> HandshakeResult {
    let params = HandshakeParams {
        client: bsk_protocol::EXTENSION_CLIENT_ID.into(),
        version: "0.5.0".parse().unwrap(),
        protocol_version: bsk::daemon::state::PROTOCOL_VERSION.into(),
        instance_id: instance_id.into(),
        browser: BrowserPeerInfo {
            name: "chrome".into(),
            version: "131.0".into(),
        },
        min_compatible_peer: Some("0.5.0".parse().unwrap()),
        min_compatible_protocol: Some(bsk::daemon::state::MIN_COMPATIBLE_PROTOCOL.into()),
        label: "Wave3AMockChrome".into(),
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
    let Message::Text(text) = resp else {
        panic!("expected handshake text frame");
    };
    let frame: ResponseFrame = serde_json::from_str(&text).unwrap();
    match frame.body {
        ResponseBody::Ok(v) => serde_json::from_value(v).unwrap(),
        ResponseBody::Err(e) => panic!("handshake rejected: {e:?}"),
    }
}

fn spawn_mock_extension<F>(ws: Ws, recorded: Arc<Mutex<Vec<RequestFrame>>>, reply: F)
where
    F: Fn(&RequestFrame) -> ResponseBody + Send + Sync + 'static,
{
    let (writer, mut reader): (SplitSink<Ws, Message>, SplitStream<Ws>) = ws.split();
    let writer = Arc::new(tokio::sync::Mutex::new(writer));
    let reply = Arc::new(reply);
    let mut next_window_id: i64 = 200;
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
                    "clientInfo": { "name": "wave3a-e2e", "version": "1.0" }
                }),
            )
            .await;
        assert!(init["result"]["protocolVersion"].is_string());
        proc.notify("notifications/initialized", json!({})).await;
        proc
    }

    async fn notify(&mut self, method: &str, params: Value) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .unwrap();
        stdin.write_all(line.as_bytes()).await.unwrap();
        stdin.write_all(b"\n").await.unwrap();
        stdin.flush().await.unwrap();
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let stdin = self.stdin.as_mut().expect("stdin open");
        let line = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .unwrap();
        stdin.write_all(line.as_bytes()).await.unwrap();
        stdin.write_all(b"\n").await.unwrap();
        stdin.flush().await.unwrap();

        let mut resp_line = String::new();
        tokio::time::timeout(
            Duration::from_secs(10),
            self.stdout.read_line(&mut resp_line),
        )
        .await
        .expect("mcp reply timeout")
        .expect("read mcp stdout");
        serde_json::from_str(resp_line.trim()).expect("valid mcp json")
    }

    async fn call_tool(&mut self, name: &str, arguments: Value) -> (bool, Value) {
        let reply = self
            .rpc(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await;
        assert!(reply.get("error").is_none(), "protocol error: {reply}");
        let result = &reply["result"];
        let is_error = result["isError"].as_bool().unwrap_or(false);
        let text = result["content"][0]["text"].as_str().expect("text content");
        (is_error, serde_json::from_str(text).expect("tool json"))
    }

    async fn close_stdin_and_wait(&mut self) -> std::process::ExitStatus {
        self.stdin.take();
        tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .expect("mcp exit on stdin EOF timed out")
            .expect("wait mcp")
    }
}

/// Counterexample A:
/// 1) `bsk sync --max-tokens 150` (truncated + `next_cursor`) -> `unchanged` at `--max-tokens 150`
///    preserves `truncated: true` and `next_cursor`, while subsequent unbounded `bsk sync` never
///    reuses the truncated 150-token cache (both when the extension sends a fresh baseline and as
///    defense-in-depth if a peer ever sent `unchanged` against a truncated baseline).
/// 2) Full `bsk sync` -> `target`-policy text `delta` with `observation_patch.lines` patches
///    `last_vom` in-place -> `bsk sync --match` hits the updated full-page cache and preserves
///    `presentation` metadata in both JSON and Human modes.
/// 3) Form `field` `delta` without `observation_patch` clears `last_vom` so `bsk sync --match`
///    never matches a stale `value="Alice"`.
#[tokio::test]
async fn counterexample_a_max_tokens_budget_guard_text_delta_patch_and_field_delta_invalidation() {
    let step = Arc::new(Mutex::new(0u32));
    let step_ext = Arc::clone(&step);

    let ctx_1 = "11111111-1111-4111-8111-111111111111";
    let obs_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    let obs_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    let obs_3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
    let obs_4 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
    let obs_5 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
    let obs_6 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6";

    let env = IsolatedEnv::start(move |req| match &req.method {
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 7,
            "url": "https://app.test/dashboard",
            "final_url": "https://app.test/dashboard",
            "reached": "load"
        })),
        Method::ToolCooperate => {
            let mut seq = step_ext.lock().unwrap();
            *seq += 1;
            let max_tokens = req
                .params
                .as_ref()
                .and_then(|p| p.get("max_tokens"))
                .and_then(Value::as_u64);
            match *seq {
                // Step 1: initial `bsk open` sync (unbounded).
                1 => ResponseBody::Ok(json!({
                    "tab_id": 7,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": ctx_1,
                    "observation_id": obs_1,
                    "changes": [],
                    "observation": {
                        "observation_id": obs_1,
                        "tab_id": 7,
                        "url": "https://app.test/dashboard",
                        "title": "Dashboard",
                        "text": "@e1 heading \"Top\"\n@e2 button \"Count: 1\"\n@e3 textbox \"Owner\" value=\"Alice\"",
                        "ref_count": 3,
                        "truncated": false
                    },
                    "state": { "mode": "ready", "revision": 1 }
                })),
                // Step 2: `bsk sync --max-tokens 150` -> truncated 150-token baseline with next_cursor.
                2 => {
                    assert_eq!(max_tokens, Some(150));
                    ResponseBody::Ok(json!({
                        "tab_id": 7,
                        "control_policy": "target",
                        "kind": "baseline",
                        "baseline_reason": "token_budget_changed",
                        "history_complete": true,
                        "context_id": ctx_1,
                        "observation_id": obs_2,
                        "changes": [],
                        "observation": {
                            "observation_id": obs_2,
                            "tab_id": 7,
                            "url": "https://app.test/dashboard",
                            "title": "Dashboard",
                            "text": "@e1 heading \"Top\"",
                            "ref_count": 1,
                            "truncated": true,
                            "next_cursor": "cursor-after-e1"
                        },
                        "state": { "mode": "ready", "revision": 2 }
                    }))
                }
                // Step 3 & 4: `bsk sync --max-tokens 150` unchanged (JSON then Human) -> preserves truncated & next_cursor.
                3 | 4 => {
                    assert_eq!(max_tokens, Some(150));
                    ResponseBody::Ok(json!({
                        "tab_id": 7,
                        "control_policy": "target",
                        "kind": "unchanged",
                        "history_complete": true,
                        "previous_context_id": ctx_1,
                        "previous_observation_id": obs_2,
                        "context_id": ctx_1,
                        "observation_id": obs_2,
                        "changes": [],
                        "state": { "mode": "ready", "revision": 2 }
                    }))
                }
                // Step 5: Defense-in-depth adversarial check: unbounded `bsk sync` receives a buggy
                // `unchanged` pointing at the 150-token truncated baseline -> Daemon MUST NOT hydrate
                // the truncated `@e1 heading "Top"` cache as if it were the full page!
                5 => {
                    assert_eq!(max_tokens, None);
                    ResponseBody::Ok(json!({
                        "tab_id": 7,
                        "control_policy": "target",
                        "kind": "unchanged",
                        "history_complete": true,
                        "previous_context_id": ctx_1,
                        "previous_observation_id": obs_2,
                        "context_id": ctx_1,
                        "observation_id": obs_2,
                        "changes": [],
                        "state": { "mode": "ready", "revision": 2 }
                    }))
                }
                // Step 6: Normal unbounded `bsk sync` -> extension emits full untruncated baseline
                // (`baseline_reason: "token_budget_changed"`).
                6 => {
                    assert_eq!(max_tokens, None);
                    ResponseBody::Ok(json!({
                        "tab_id": 7,
                        "control_policy": "target",
                        "kind": "baseline",
                        "baseline_reason": "token_budget_changed",
                        "history_complete": true,
                        "context_id": ctx_1,
                        "observation_id": obs_3,
                        "changes": [],
                        "observation": {
                            "observation_id": obs_3,
                            "tab_id": 7,
                            "url": "https://app.test/dashboard",
                            "title": "Dashboard",
                            "text": "@vom 1\n@e1 heading \"Top\"\n@e2 button \"Count: 1\"\n@e3 textbox \"Owner\" value=\"Alice\"\n@e4 button \"item 1\"\n@e5 button \"item 2\"\n@e6 button \"item 3\"\n@e7 button \"item 4\"\n@e8 button \"item 5\"\n@e9 button \"item 6\"",
                            "ref_count": 9,
                            "truncated": false
                        },
                        "state": { "mode": "ready", "revision": 3 }
                    }))
                }
                // Step 7: `target` policy text `delta` with 1-based `observation_patch.lines`.
                7 => ResponseBody::Ok(json!({
                    "tab_id": 7,
                    "control_policy": "target",
                    "kind": "delta",
                    "history_complete": true,
                    "previous_context_id": ctx_1,
                    "previous_observation_id": obs_3,
                    "context_id": ctx_1,
                    "observation_id": obs_4,
                    "changes": [
                        {
                            "kind": "text",
                            "label": "Count",
                            "previous_value": "Count: 1",
                            "value": "Count: 2"
                        }
                    ],
                    "observation_patch": {
                        "total_lines": 10,
                        "lines": [
                            {
                                "line": 3,
                                "previous": "@e2 button \"Count: 1\"",
                                "text": "@e2 button \"Count: 2\""
                            }
                        ]
                    },
                    "state": { "mode": "ready", "revision": 4 }
                })),
                // Step 8 & 9: `bsk sync --match "Count: 2"` (JSON then Human) receives `unchanged`
                // and hydrates the delta-patched full-page VOM!
                8 | 9 => ResponseBody::Ok(json!({
                    "tab_id": 7,
                    "control_policy": "target",
                    "kind": "unchanged",
                    "history_complete": true,
                    "previous_context_id": ctx_1,
                    "previous_observation_id": obs_4,
                    "context_id": ctx_1,
                    "observation_id": obs_4,
                    "changes": [],
                    "state": { "mode": "ready", "revision": 4 }
                })),
                // Step 10: Adversarial `strict`-style form `field` delta WITHOUT `observation_patch`
                // (Owner input changed from "Alice" to "Bob" in DOM).
                10 => ResponseBody::Ok(json!({
                    "tab_id": 7,
                    "control_policy": "strict",
                    "kind": "delta",
                    "history_complete": true,
                    "previous_context_id": ctx_1,
                    "previous_observation_id": obs_4,
                    "context_id": ctx_1,
                    "observation_id": obs_5,
                    "changes": [
                        { "kind": "field", "summary": "Owner changed to Bob" }
                    ],
                    "state": { "mode": "ready", "revision": 5 }
                })),
                // Step 11: Subsequent `unchanged` must NOT hydrate stale `value="Alice"` because
                // Step 10 cleared `last_vom`!
                11 => ResponseBody::Ok(json!({
                    "tab_id": 7,
                    "control_policy": "strict",
                    "kind": "unchanged",
                    "history_complete": true,
                    "previous_context_id": ctx_1,
                    "previous_observation_id": obs_5,
                    "context_id": ctx_1,
                    "observation_id": obs_6,
                    "changes": [],
                    "state": { "mode": "ready", "revision": 5 }
                })),
                other => panic!("unexpected cooperate sequence {other}"),
            }
        }
        other => panic!("unexpected method {other:?}"),
    })
    .await;

    // Step 1: open
    let open = env
        .run_bsk(&["open", "https://app.test/dashboard"], &[])
        .await;
    assert!(open.status.success());

    // Step 2: truncated `--max-tokens 150`
    let trunc_base = env
        .run_bsk(&["sync", "--max-tokens", "150", "--json"], &[])
        .await;
    assert!(trunc_base.status.success());
    let trunc_json: Value = serde_json::from_slice(&trunc_base.stdout).unwrap();
    assert_no_private_ipc_keys(&trunc_json, "trunc_base");
    assert_eq!(trunc_json["truncated"], true);
    assert_eq!(trunc_json["next_cursor"], "cursor-after-e1");

    // Step 3: `--max-tokens 150` unchanged (JSON) -> preserves truncated & next_cursor!
    let trunc_unchanged = env
        .run_bsk(&["sync", "--max-tokens", "150", "--json"], &[])
        .await;
    assert!(trunc_unchanged.status.success());
    let trunc_unchanged_json: Value = serde_json::from_slice(&trunc_unchanged.stdout).unwrap();
    assert_eq!(trunc_unchanged_json["unchanged"], true);
    assert_eq!(trunc_unchanged_json["truncated"], true);
    assert_eq!(trunc_unchanged_json["next_cursor"], "cursor-after-e1");
    assert_eq!(trunc_unchanged_json["vom"], "@e1 heading \"Top\"");

    // Step 4: `--max-tokens 150` unchanged (Human) -> header surfaces truncated=true and next_cursor!
    let trunc_human = env.run_bsk(&["sync", "--max-tokens", "150"], &[]).await;
    assert!(trunc_human.status.success());
    let trunc_human_str = String::from_utf8(trunc_human.stdout).unwrap();
    let header = trunc_human_str.lines().next().unwrap();
    assert!(header.contains("truncated=true"), "header={header}");
    assert!(
        header.contains("next_cursor=\"cursor-after-e1\""),
        "header={header}"
    );

    // Step 5: Defense-in-depth: unbounded `bsk sync` when peer mistakenly sends `unchanged`
    // referencing the 150-token truncated snapshot -> `vom` is empty/null, NEVER the truncated 150-token slice!
    let defense_sync = env.run_bsk(&["sync", "--json"], &[]).await;
    assert!(defense_sync.status.success());
    let defense_json: Value = serde_json::from_slice(&defense_sync.stdout).unwrap();
    assert!(
        defense_json["vom"].as_str().unwrap_or("").is_empty(),
        "truncated 150-token cache must never leak into unbounded sync: {defense_json}"
    );
    assert_ne!(defense_json["truncated"], true);

    // Step 6: Unbounded `bsk sync` with fixed extension -> returns full untruncated VOM!
    let full_sync = env.run_bsk(&["sync", "--json"], &[]).await;
    assert!(full_sync.status.success());
    let full_json: Value = serde_json::from_slice(&full_sync.stdout).unwrap();
    assert_eq!(full_json["truncated"], false);
    assert!(full_json.get("next_cursor").is_none());
    assert!(
        full_json["vom"]
            .as_str()
            .unwrap()
            .contains("@e3 textbox \"Owner\" value=\"Alice\"")
    );

    // Step 7: Plain `bsk sync` on `target` text `delta` stays slim while patching `last_vom` in-place.
    let delta_sync = env.run_bsk(&["sync"], &[]).await;
    assert!(delta_sync.status.success());
    let delta_stdout = String::from_utf8(delta_sync.stdout).unwrap();
    assert!(delta_stdout.contains("delta=true"), "stdout={delta_stdout}");
    assert!(
        delta_stdout.contains("[change label=\"Count\" previous=\"Count: 1\" value=\"Count: 2\"]"),
        "stdout={delta_stdout}"
    );
    assert!(
        !delta_stdout.contains("@e3 textbox"),
        "plain delta sync should stay slim without dumping full VOM: {delta_stdout}"
    );

    // Step 8: `bsk sync --match-text "Count: 2" --context-lines 0 --json` hits the delta-patched full-page cache and preserves `presentation`!
    let match_json_out = env
        .run_bsk(
            &[
                "sync",
                "--match-text",
                "Count: 2",
                "--context-lines",
                "0",
                "--json",
            ],
            &[],
        )
        .await;
    assert!(
        match_json_out.status.success(),
        "match-text json failed: stdout={} stderr={}",
        String::from_utf8_lossy(&match_json_out.stdout),
        String::from_utf8_lossy(&match_json_out.stderr)
    );
    let match_json: Value = serde_json::from_slice(&match_json_out.stdout).unwrap();
    assert_eq!(match_json["unchanged"], true);
    assert!(
        match_json["vom"]
            .as_str()
            .unwrap()
            .contains("@e2 button \"Count: 2\""),
        "expected patched Count: 2 in matched VOM: {match_json}"
    );
    assert_eq!(match_json["presentation"]["filtered"], true);
    assert_eq!(match_json["capture_truncated"], false);

    // Step 9: `bsk sync --match-text "Count: 2" --context-lines 0` (Human) renders `[presentation ...]`.
    let match_human_out = env
        .run_bsk(
            &["sync", "--match-text", "Count: 2", "--context-lines", "0"],
            &[],
        )
        .await;
    assert!(match_human_out.status.success());
    let match_human = String::from_utf8(match_human_out.stdout).unwrap();
    assert!(
        match_human.contains("[presentation filtered=true"),
        "expected presentation line in human output: {match_human}"
    );
    assert!(match_human.contains("@e2 button \"Count: 2\""));

    // Step 10 & 11: Form `field` delta without `observation_patch` invalidates `last_vom`, so
    // `bsk sync --match-text Alice --json` cannot falsely match stale `value="Alice"`.
    let field_delta_out = env.run_bsk(&["sync"], &[]).await;
    assert!(field_delta_out.status.success());
    let stale_match_out = env
        .run_bsk(&["sync", "--match-text", "Alice", "--json"], &[])
        .await;
    assert!(stale_match_out.status.success());
    let stale_match_json: Value = serde_json::from_slice(&stale_match_out.stdout).unwrap();
    assert!(
        !stale_match_json["vom"]
            .as_str()
            .unwrap_or("")
            .contains("Alice"),
        "stale form value=\"Alice\" must never survive unpatched field delta: {stale_match_json}"
    );

    env.shutdown().await;
}

/// Counterexample B:
/// On a `--max-tokens` truncated page where `--wait-for` target text lies below the token cutoff,
/// `bsk sync --max-tokens 50 --wait-for "Footer Ready"` immediately falls back to an unbounded
/// `tool.snapshot` check, succeeds on the first poll (exit 0), and marks `refs_replaced: true`.
#[tokio::test]
async fn counterexample_b_wait_for_falls_back_to_full_snapshot_when_max_tokens_truncates_page() {
    let ctx_1 = "22222222-2222-4222-8222-222222222222";
    let obs_1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    let snap_obs = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

    let env = IsolatedEnv::start(move |req| match &req.method {
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 9,
            "url": "https://app.test/long",
            "final_url": "https://app.test/long",
            "reached": "load"
        })),
        Method::ToolCooperate => {
            let max_tokens = req
                .params
                .as_ref()
                .and_then(|p| p.get("max_tokens"))
                .and_then(Value::as_u64);
            if max_tokens == Some(50) {
                ResponseBody::Ok(json!({
                    "tab_id": 9,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": ctx_1,
                    "observation_id": obs_1,
                    "changes": [],
                    "observation": {
                        "observation_id": obs_1,
                        "tab_id": 9,
                        "url": "https://app.test/long",
                        "title": "Long Report",
                        "text": "@e1 heading \"Above Fold Only\"",
                        "ref_count": 1,
                        "truncated": true,
                        "next_cursor": "cur-50"
                    },
                    "state": { "mode": "ready", "revision": 1 }
                }))
            } else {
                ResponseBody::Ok(json!({
                    "tab_id": 9,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": ctx_1,
                    "observation_id": obs_1,
                    "changes": [],
                    "observation": {
                        "observation_id": obs_1,
                        "tab_id": 9,
                        "url": "https://app.test/long",
                        "title": "Long Report",
                        "text": "@e1 heading \"Above Fold Only\"\n@e99 status \"Footer Ready\"",
                        "ref_count": 2,
                        "truncated": false
                    },
                    "state": { "mode": "ready", "revision": 1 }
                }))
            }
        }
        Method::ToolSnapshot => {
            let max_tokens = req
                .params
                .as_ref()
                .and_then(|p| p.get("max_tokens"))
                .and_then(Value::as_u64);
            assert_eq!(
                max_tokens, None,
                "--wait-for fallback snapshot must be unbounded"
            );
            ResponseBody::Ok(json!({
                "observation_id": snap_obs,
                "tab_id": 9,
                "url": "https://app.test/long",
                "title": "Long Report",
                "text": "@e1 heading \"Above Fold Only\"\n@e99 status \"Footer Ready\"",
                "ref_count": 2,
                "truncated": false
            }))
        }
        other => panic!("unexpected method {other:?}"),
    })
    .await;

    let open = env.run_bsk(&["open", "https://app.test/long"], &[]).await;
    assert!(open.status.success());
    let _ = env.take_requests();

    let wait_out = env
        .run_bsk(
            &[
                "sync",
                "--max-tokens",
                "50",
                "--wait-for",
                "Footer Ready",
                "--timeout-ms",
                "800",
                "--json",
            ],
            &[],
        )
        .await;
    assert!(
        wait_out.status.success(),
        "expected immediate full-page fallback success instead of exit-4 timeout: stdout={} stderr={}",
        String::from_utf8_lossy(&wait_out.stdout),
        String::from_utf8_lossy(&wait_out.stderr)
    );
    let wait_json: Value = serde_json::from_slice(&wait_out.stdout).unwrap();
    assert_eq!(wait_json["truncated"], true);
    assert_eq!(wait_json["next_cursor"], "cur-50");

    // 1st RPC: budgeted cooperate(max_tokens: 50) -> truncated
    // 2nd RPC: unbounded tool.snapshot(max_tokens: None) -> confirms "Footer Ready" below cutoff!
    // 3rd RPC: re-sync cooperate(max_tokens: 50) (`refs_replaced == true`) so returned `ctx` & refs stay valid!
    let reqs = env.take_requests();
    assert_eq!(
        reqs.len(),
        3,
        "expected cooperate(50) -> snapshot(None) -> re-sync cooperate(50)"
    );
    assert_eq!(reqs[0].method, Method::ToolCooperate);
    assert_eq!(reqs[1].method, Method::ToolSnapshot);
    assert_eq!(reqs[2].method, Method::ToolCooperate);

    env.shutdown().await;
}

/// Counterexample C:
/// 1) Local `IpcEnvelope` wire frames carry request/response metadata outside `params`/`result`,
///    keeping business payloads 100% free of private `_` keys while extension WS frames still
///    carry `_operation_id`.
/// 2) When a mutating action (`bsk click @e1`) triggers a native modal (`DialogPending`) and is
///    settled via `bsk dialog accept` + `bsk operation await`, the unified completion hook:
///    - resolves `run_logs` in-place to `Outcome::Done` (`uncertain == 0`, never stranded as `Uncertain`),
///    - settles `intent_wal` cleanly (`bsk ledger status` has zero `UNKNOWN` entries, and a
///      subsequent mutating `bsk click @e1` is NOT blocked by `uncertain_prior_effect`),
///    - and updates `scopes` (`cN` / `oN` / `active_tab_id` / `scope_meta`) identically to
///      synchronous completion even when a dialog-gated `cooperate(sync)` or `tab_select` settles
///      through `operation_await`.
#[tokio::test]
async fn counterexample_c_dialog_pending_reconciles_run_logs_wal_and_scopes_with_pure_ipc_envelopes()
 {
    let temp = tempfile::tempdir_in("/tmp").unwrap();
    let sock = temp.path().join("ipc.sock");
    let handle = daemon::run(
        DaemonConfig::new(0).with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal),
        Some(sock.clone()),
    )
    .await
    .unwrap();
    let state = handle.state();
    let ws_addr = handle.ws_addr();
    let info = DaemonInfo::now(
        std::process::id(),
        sock.clone(),
        ws_addr.port(),
        bsk::daemon::state::DAEMON_VERSION,
    );
    std::fs::write(
        temp.path().join("daemon.json"),
        serde_json::to_vec(&info).unwrap(),
    )
    .unwrap();

    let mut ws = connect_ext(ws_addr).await;
    do_handshake(&mut ws, TEST_EXT_ID).await;

    async fn recv_ws(ws: &mut Ws) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match ws.next().await.unwrap().unwrap() {
                    Message::Text(text) => return serde_json::from_str::<Value>(&text).unwrap(),
                    Message::Ping(d) => ws.send(Message::Pong(d)).await.unwrap(),
                    other => panic!("unexpected ws message: {other:?}"),
                }
            }
        })
        .await
        .expect("ws frame timeout")
    }

    let run_bsk = |args: Vec<String>| {
        let home = temp.path().to_path_buf();
        tokio::spawn(async move {
            Command::new(env!("CARGO_BIN_EXE_bsk"))
                .env("BSK_HOME", &home)
                .env("BSK_AUTO_START", "0")
                .env("BSK_AUTO_UPDATE", "off")
                .env_remove("BSK_SESSION")
                .env_remove("BSK_SCOPE")
                .env_remove("CLAUDE_CODE_AGENT_ID")
                .env_remove("CODEX_THREAD_ID")
                .env_remove("ANTIGRAVITY_CONVERSATION_ID")
                .env_remove("CURSOR_TRACE_ID")
                .env_remove("DSH_SESSION_ID")
                .args(&args)
                .output()
                .await
                .unwrap()
        })
    };

    // 1. Open implicit session (`bsk open https://app.test/pay`) and inspect extension WS frames.
    let open_task = run_bsk(vec![
        "open".into(),
        "https://app.test/pay".into(),
        "--json".into(),
    ]);

    let start_req = recv_ws(&mut ws).await;
    assert_eq!(start_req["method"], "tool.session_start");
    ws.send(Message::Text(
        json!({ "id": start_req["id"], "result": { "agent_window_id": 301 } }).to_string(),
    ))
    .await
    .unwrap();

    let nav_req = recv_ws(&mut ws).await;
    assert_eq!(nav_req["method"], "tool.navigate");
    let sid = nav_req["params"]["session_id"].as_str().unwrap().to_owned();
    assert!(nav_req["params"]["_operation_id"].is_string());
    ws.send(Message::Text(
        json!({
            "id": nav_req["id"],
            "result": { "tab_id": 11, "url": "https://app.test/pay", "final_url": "https://app.test/pay", "reached": "load" }
        })
        .to_string(),
    ))
    .await
    .unwrap();

    let ctx_1 = "33333333-3333-4333-8333-333333333331";
    let obs_1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
    let sync_req = recv_ws(&mut ws).await;
    assert_eq!(sync_req["method"], "tool.cooperate");
    ws.send(Message::Text(
        json!({
            "id": sync_req["id"],
            "result": {
                "tab_id": 11,
                "control_policy": "target",
                "kind": "baseline",
                "history_complete": true,
                "context_id": ctx_1,
                "observation_id": obs_1,
                "changes": [],
                "observation": {
                    "observation_id": obs_1,
                    "tab_id": 11,
                    "url": "https://app.test/pay",
                    "title": "Checkout",
                    "text": "@e1 button \"Place Order\"",
                    "ref_count": 1,
                    "truncated": false
                },
                "state": { "mode": "ready", "revision": 1 }
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();

    let open_out = open_task.await.unwrap();
    assert!(open_out.status.success());

    // 2. Verify raw local Unix socket `IpcEnvelope` wire format carries `meta` cleanly outside `params` and `result`.
    let raw_sync_task = {
        let sock = sock.clone();
        tokio::spawn(async move {
            let mut stream = UnixStream::connect(&sock).await.unwrap();
            let raw_req = json!({
                "id": "wire-check-1",
                "method": "tool.cooperate",
                "params": { "action": "sync" },
                "meta": {
                    "caller_scope": "default",
                    "return_scope_meta": true
                }
            });
            stream
                .write_all(format!("{raw_req}\n").as_bytes())
                .await
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            serde_json::from_str::<Value>(line.trim()).unwrap()
        })
    };
    let wire_ws_req = recv_ws(&mut ws).await;
    assert_eq!(wire_ws_req["method"], "tool.cooperate");
    assert_eq!(wire_ws_req["params"]["session_id"], sid);
    assert!(wire_ws_req["params"].get("_caller_scope").is_none());
    assert!(wire_ws_req["params"].get("_return_scope_meta").is_none());
    ws.send(Message::Text(
        json!({
            "id": wire_ws_req["id"],
            "result": {
                "tab_id": 11,
                "control_policy": "target",
                "kind": "unchanged",
                "history_complete": true,
                "previous_context_id": ctx_1,
                "previous_observation_id": obs_1,
                "context_id": ctx_1,
                "observation_id": obs_1,
                "changes": [],
                "state": { "mode": "ready", "revision": 1 }
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let raw_resp = raw_sync_task.await.unwrap();
    assert_no_private_ipc_keys(&raw_resp["result"], "raw_ipc_result");
    assert_eq!(raw_resp["meta"]["scope_meta"]["session_id"], sid);
    assert_eq!(raw_resp["meta"]["scope_meta"]["short_ctx"], "c1");
    assert_eq!(raw_resp["meta"]["scope_meta"]["cache_reusable"], true);

    // 3. Mutating `bsk click @e1` triggers native confirm modal (`DialogPending`).
    let click_task = run_bsk(vec!["click".into(), "@e1".into(), "--json".into()]);
    let click_req = recv_ws(&mut ws).await;
    assert_eq!(click_req["method"], "tool.click");
    let click_op_id = click_req["params"]["_operation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let dlg = json!({
        "id": "dlg-confirm-1",
        "tab_id": 11,
        "type": "confirm",
        "message": "Confirm order?",
        "sequence": 1,
        "decision_deadline": 60000
    });
    ws.send(Message::Text(
        json!({
            "event": "dialog.changed",
            "payload": {
                "session_id": sid,
                "operation_id": click_op_id,
                "dialog": dlg
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();

    let click_out = click_task.await.unwrap();
    assert!(
        !click_out.status.success(),
        "click should suspend with dialog_pending"
    );
    let click_err: Value = serde_json::from_slice(&click_out.stdout).unwrap();
    assert_eq!(click_err["code"], "dialog_pending");
    assert_eq!(click_err["data"]["operation_id"], click_op_id);

    // 4. Settle the dialog via top-level `bsk dialog accept dlg-confirm-1` + `bsk operation await <op_id>`.
    let accept_task = run_bsk(vec![
        "dialog".into(),
        "accept".into(),
        "dlg-confirm-1".into(),
    ]);
    let accept_req = recv_ws(&mut ws).await;
    assert_eq!(accept_req["method"], "tool.dialog_accept");
    ws.send(Message::Text(
        json!({
            "event": "dialog.changed",
            "payload": {
                "session_id": sid,
                "operation_id": click_op_id,
                "dialog": Value::Null
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    ws.send(Message::Text(
        json!({
            "id": accept_req["id"],
            "result": { "dialog": { "handled": "accepted" }, "effect_state": "committed" }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    assert!(accept_task.await.unwrap().status.success());

    // Extension finishes the suspended `tool.click`.
    ws.send(Message::Text(
        json!({
            "id": click_req["id"],
            "result": {
                "tab_id": 11,
                "x": 40.0,
                "y": 20.0,
                "effect_state": "committed",
                "javascript_dialogs": [{ "handled": "accepted" }]
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();

    let await_out = run_bsk(vec![
        "operation".into(),
        "await".into(),
        click_op_id.clone(),
    ])
    .await
    .unwrap();
    assert!(
        await_out.status.success(),
        "operation await failed: {}",
        String::from_utf8_lossy(&await_out.stderr)
    );
    let await_json: Value = serde_json::from_slice(&await_out.stdout).unwrap();
    assert_no_private_ipc_keys(&await_json, "operation_await");
    assert_eq!(await_json["state"], "completed");

    // 5. Verify `run_logs` resolved in-place to `LoggedStep::Action` (zero `LoggedStep::Uncertain`)!
    let log_view = state.run_logs.read(&sid);
    assert!(
        !log_view
            .steps
            .iter()
            .any(|s| matches!(s, LoggedStep::Uncertain { .. })),
        "DialogPending operation resolved via operation_await must NOT stay Uncertain: {log_view:?}"
    );
    assert!(
        log_view.steps.iter().any(|s| matches!(
            s,
            LoggedStep::Action { action, .. } if action == "click"
        )),
        "expected LoggedStep::Action(click) in run_logs: {log_view:?}"
    );

    // 6. Verify `intent_wal` settled cleanly (`bsk ledger status --json` has 0 UNKNOWN entries,
    // and a follow-up mutating `bsk click @e1` succeeds without `uncertain_prior_effect`).
    let ledger_out = run_bsk(vec!["ledger".into(), "status".into(), "--json".into()])
        .await
        .unwrap();
    assert!(ledger_out.status.success());
    let ledger_json: Value = serde_json::from_slice(&ledger_out.stdout).unwrap();
    assert_eq!(ledger_json["frozen"], false);
    assert_eq!(
        ledger_json["pending_unknown"].as_array().unwrap().len(),
        0,
        "intent_wal must have zero UNKNOWN entries after dialog settlement: {ledger_json}"
    );

    let second_click_task = run_bsk(vec!["click".into(), "@e1".into(), "--json".into()]);
    let second_click_req = recv_ws(&mut ws).await;
    assert_eq!(second_click_req["method"], "tool.click");
    ws.send(Message::Text(
        json!({
            "id": second_click_req["id"],
            "result": { "tab_id": 11, "x": 40.0, "y": 20.0, "effect_state": "committed" }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    assert!(second_click_task.await.unwrap().status.success());

    // 7. Also verify `scopes` reconciliation (`active_tab_id` + `scope_meta`) when a dialog-gated
    // `tool.tab_select` suspends on `beforeunload` and settles via `operation_await`.
    let select_sock = sock.clone();
    let select_sid = sid.clone();
    let select_task = tokio::spawn(async move {
        IpcClient::connect(&select_sock)
            .await
            .unwrap()
            .call_with_id::<_, Value>(
                "tab-select-dlg".into(),
                Method::ToolTabSelect,
                Some(json!({ "session_id": select_sid, "tab_id": 22 })),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
    });
    let select_req = recv_ws(&mut ws).await;
    assert_eq!(select_req["method"], "tool.tab_select");
    let select_op_id = select_req["params"]["_operation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    ws.send(Message::Text(
        json!({
            "event": "dialog.changed",
            "payload": {
                "session_id": sid,
                "operation_id": select_op_id,
                "dialog": {
                    "id": "dlg-beforeunload",
                    "tab_id": 11,
                    "type": "beforeunload",
                    "message": "Leave site?",
                    "sequence": 2,
                    "decision_deadline": 60000
                }
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let select_err = select_task.await.unwrap().unwrap_err();
    assert_eq!(select_err.code, ErrorCode::DialogPending);

    ws.send(Message::Text(
        json!({
            "event": "dialog.changed",
            "payload": { "session_id": sid, "operation_id": select_op_id, "dialog": Value::Null }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    ws.send(Message::Text(
        json!({
            "id": select_req["id"],
            "result": { "tab_id": 22, "window_id": 301 }
        })
        .to_string(),
    ))
    .await
    .unwrap();

    let (await_res, _) = IpcClient::connect(&sock)
        .await
        .unwrap()
        .call_envelope::<_, Value>(
            "await-tab-select",
            Method::ToolOperationAwait,
            Some(json!({
                "session_id": sid,
                "operation_id": select_op_id,
                "wait_ms": 2000
            })),
            IpcRequestMeta {
                caller_scope: Some("default".into()),
                return_scope_meta: true,
                ..Default::default()
            },
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(await_res.unwrap()["state"], "completed");
    assert_eq!(
        state.scopes.active_tab_id(&SessionId(sid.clone())),
        Some(22),
        "tab_select completing after DialogPending must update scopes.active_tab_id"
    );

    handle.shutdown().await;
}

/// Counterexample D:
/// 1) With `CODEX_THREAD_ID` set, `bsk mcp` and `bsk` CLI share the same `agent:codex:...`
///    session without opening a second window, and `bsk mcp` `stdio` EOF does NOT kill the
///    shared host-agent session.
/// 2) Without host env vars, `bsk mcp` uses an exclusive transient `mcp:<pid>:<nonce>` scope and
///    immediately stops & tears down its orphan session on `stdio` EOF (without touching the
///    shared host-agent session).
/// 3) Unified `DaemonState::teardown_session` fixes:
///    - idle-timeout teardown clears `dialog_operations` and preserves `"session_idle_timeout"`
///      across subsequent `purge_sessions_of_browser` (`"browser_disconnected"`),
///    - unclaimed `session_requests::cleanup` clears `dialog_operations`, `scopes`, and `intent_wal`,
///    - >256 transient scopes evict inactive tombstones and idle `start_locks` at 256 while keeping
///      active bound scopes intact.
#[tokio::test]
async fn counterexample_d_host_scope_sharing_mcp_eof_reap_unified_teardown_and_lru_cap() {
    let ctx_uuid = "44444444-4444-4444-8444-444444444444";
    let obs_uuid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    let env = IsolatedEnv::start(move |req| match &req.method {
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 5,
            "url": "https://app.test/shared",
            "final_url": "https://app.test/shared",
            "reached": "load"
        })),
        Method::ToolCooperate => ResponseBody::Ok(json!({
            "tab_id": 5,
            "control_policy": "target",
            "kind": "baseline",
            "history_complete": true,
            "context_id": ctx_uuid,
            "observation_id": obs_uuid,
            "changes": [],
            "observation": {
                "observation_id": obs_uuid,
                "tab_id": 5,
                "url": "https://app.test/shared",
                "title": "Shared Workspace",
                "text": "@e1 button \"Run\"",
                "ref_count": 1,
                "truncated": false
            },
            "state": { "mode": "ready", "revision": 1 }
        })),
        other => panic!("unexpected method {other:?}"),
    })
    .await;
    let state = env.handle.state();

    // --- Part 1: Host-agent env var (`CODEX_THREAD_ID`) shares session across `bsk mcp` + `bsk` CLI ---
    let host_env = &[("CODEX_THREAD_ID", "codex-thread-wave3a")];
    let mut shared_mcp = McpProcess::spawn(env.home.path(), host_env).await;
    let (is_err, open_reply) = shared_mcp
        .call_tool(
            "bsk_session",
            json!({ "action": "open", "url": "https://app.test/shared" }),
        )
        .await;
    assert!(!is_err, "mcp open failed: {open_reply}");
    let shared_sid = open_reply["session_id"].as_str().unwrap().to_owned();

    let reqs_after_mcp_open = env.take_requests();
    assert_eq!(
        reqs_after_mcp_open
            .iter()
            .filter(|r| r.method == Method::ToolSessionStart)
            .count(),
        1
    );

    // Run `bsk sync --json` CLI in the same `CODEX_THREAD_ID` without `--session` / `--scope`:
    // must reuse `shared_sid` without starting a second window!
    let cli_sync = env.run_bsk(&["sync", "--json"], host_env).await;
    assert!(
        cli_sync.status.success(),
        "cli sync failed: {}",
        String::from_utf8_lossy(&cli_sync.stderr)
    );
    let cli_sync_json: Value = serde_json::from_slice(&cli_sync.stdout).unwrap();
    assert_eq!(cli_sync_json["session_id"], shared_sid);
    assert_eq!(
        env.take_requests()
            .iter()
            .filter(|r| r.method == Method::ToolSessionStart)
            .count(),
        0,
        "CLI in same host agent thread must share session without opening a second window"
    );

    // Close `shared_mcp` stdin (EOF): shared host-agent session MUST survive!
    let shared_exit = shared_mcp.close_stdin_and_wait().await;
    assert!(shared_exit.success());
    assert!(
        state.sessions.get(&SessionId(shared_sid.clone())).is_some(),
        "closing MCP stdio must NOT kill a shared host-agent session"
    );
    assert_eq!(
        env.take_requests()
            .iter()
            .filter(|r| r.method == Method::ToolSessionStop)
            .count(),
        0
    );

    // --- Part 2: Isolated `bsk mcp` (no host env vars) immediately reaps orphan session on EOF ---
    let mut transient_mcp = McpProcess::spawn(env.home.path(), &[]).await;
    let (is_err, trans_open) = transient_mcp
        .call_tool(
            "bsk_session",
            json!({ "action": "open", "url": "https://app.test/shared" }),
        )
        .await;
    assert!(!is_err, "transient mcp open failed: {trans_open}");
    let transient_sid = trans_open["session_id"].as_str().unwrap().to_owned();
    assert_ne!(transient_sid, shared_sid);
    assert!(
        state
            .sessions
            .get(&SessionId(transient_sid.clone()))
            .is_some()
    );
    let _ = env.take_requests();

    // Drop `transient_mcp` stdin (EOF) -> must immediately stop & tear down `transient_sid`!
    let trans_exit = transient_mcp.close_stdin_and_wait().await;
    assert!(trans_exit.success());
    assert!(
        state
            .sessions
            .get(&SessionId(transient_sid.clone()))
            .is_none(),
        "isolated transient MCP session must be reaped immediately on stdio EOF"
    );
    assert!(
        state.sessions.get(&SessionId(shared_sid.clone())).is_some(),
        "reaping transient MCP session must leave shared host-agent session untouched"
    );
    let stop_reqs = env.take_requests();
    assert_eq!(
        stop_reqs
            .iter()
            .filter(|r| r.method == Method::ToolSessionStop)
            .count(),
        1,
        "expected tool.session_stop on transient MCP EOF"
    );

    // --- Part 3: Idle-timeout teardown clears `dialog_operations` and preserves reason across `BrowserGone` ---
    let (idle_res, _) = IpcClient::connect(&env.sock)
        .await
        .unwrap()
        .call_envelope::<_, Value>(
            "idle-start",
            Method::SessionStart,
            Some(json!({})),
            IpcRequestMeta {
                caller_scope: Some("scope:idle-victim".into()),
                bind_scope: true,
                ..Default::default()
            },
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    let idle_sid = SessionId(idle_res.unwrap()["session_id"].as_str().unwrap().to_owned());
    let idle_op = state
        .dialog_operations
        .register(&idle_sid.0, "idle-rpc", Method::ToolClick)
        .expect("register dialog op on idle session");

    assert!(state.teardown_session(
        &idle_sid,
        bsk_protocol::RpcErrorReason::SessionIdleTimeout.as_str()
    ));
    assert!(
        state
            .dialog_operations
            .get(&idle_sid.0, &idle_op.id)
            .is_none(),
        "teardown_session(session_idle_timeout) must remove dialog_operations"
    );
    // Simulate subsequent browser disconnect attempting to purge sessions of that browser:
    // the original `session_idle_timeout` tombstone reason must NOT be overwritten!
    assert!(!state.teardown_session(
        &idle_sid,
        bsk_protocol::RpcErrorReason::BrowserDisconnected.as_str()
    ));
    assert_eq!(
        state.sessions.end_info(&idle_sid).unwrap().reason,
        bsk_protocol::RpcErrorReason::SessionIdleTimeout.as_str(),
        "subsequent teardown must preserve original session_idle_timeout reason"
    );

    // --- Part 4: Unclaimed `SessionStartTracked` cleanup clears `dialog_operations`, `scopes`, and `intent_wal` ---
    let expiry_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    let request_id = format!("{expiry_ms}:{}", uuid::Uuid::new_v4());
    let _ = IpcClient::connect(&env.sock)
        .await
        .unwrap()
        .call_with_id::<_, Value>(
            "prep-unclaimed".into(),
            Method::SessionRequest,
            Some(json!({
                "request_id": request_id,
                "action": "prepare"
            })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    let (tracked_res, _) = IpcClient::connect(&env.sock)
        .await
        .unwrap()
        .call_envelope::<_, Value>(
            "start-unclaimed",
            Method::SessionStartTracked,
            Some(json!({
                "request_id": request_id
            })),
            IpcRequestMeta {
                caller_scope: Some("scope:unclaimed-victim".into()),
                bind_scope: true,
                ..Default::default()
            },
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    let unclaimed_sid = SessionId(
        tracked_res.unwrap()["session_id"]
            .as_str()
            .unwrap()
            .to_owned(),
    );
    let unclaimed_op = state
        .dialog_operations
        .register(&unclaimed_sid.0, "unclaimed-rpc", Method::ToolEvaluate)
        .unwrap();
    assert!(
        state
            .scopes
            .active_binding("scope:unclaimed-victim", &state.sessions)
            .is_some()
    );

    let cancel_reply = IpcClient::connect(&env.sock)
        .await
        .unwrap()
        .call_with_id::<_, Value>(
            "cancel-unclaimed".into(),
            Method::SessionRequest,
            Some(json!({
                "request_id": request_id,
                "action": "cancel"
            })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cancel_reply["state"], "closed");

    assert!(state.sessions.get(&unclaimed_sid).is_none());
    assert!(
        state
            .scopes
            .active_binding("scope:unclaimed-victim", &state.sessions)
            .is_none(),
        "unclaimed session cleanup must unbind scopes"
    );
    assert!(
        state
            .dialog_operations
            .get(&unclaimed_sid.0, &unclaimed_op.id)
            .is_none(),
        "unclaimed session cleanup must clear dialog_operations"
    );

    // --- Part 5: >256 transient scopes evict inactive tombstones & idle start_locks at 256 ---
    let browser_id = state
        .sessions
        .get(&SessionId(shared_sid.clone()))
        .unwrap()
        .browser_id;
    for idx in 0..300 {
        let transient_scope = format!("mcp:99999:nonce-{idx}");
        let _lock = state.scopes.scope_start_lock(&transient_scope);
        drop(_lock);
        let fake_sid = SessionId(format!("t{idx:03}"));
        state.scopes.bind_scope(
            &transient_scope,
            fake_sid.clone(),
            browser_id.clone(),
            false,
        );
        state.scopes.on_session_ended(
            &fake_sid,
            bsk_protocol::RpcErrorReason::SessionStopped.as_str(),
        );
    }
    assert!(
        state.scopes.inactive_scope_count() <= 256,
        "inactive scope tombstones exceeded 256 cap: {}",
        state.scopes.inactive_scope_count()
    );
    assert!(
        state.scopes.start_lock_count() <= 256,
        "idle start_locks exceeded 256 cap: {}",
        state.scopes.start_lock_count()
    );
    assert!(
        state
            .scopes
            .active_binding("agent:codex:codex-thread-wave3a", &state.sessions)
            .is_some(),
        "256-cap LRU eviction must never evict active bound scopes"
    );

    let _ = HashMap::<String, String>::new();
    env.shutdown().await;
}

/// Counterexample E:
/// 1) Truncated `target`-policy text `delta` (`--max-tokens 150`, `truncated: true`, `grown == 0`)
///    patches `last_vom` in-place and preserves `truncated: true` + `next_cursor` across both
///    `--match-text` on the delta frame and a subsequent `unchanged` `--max-tokens 150` sync.
/// 2) Whitespace-collapsed `target` text `delta` (`observation_patch: { lines: [] }, changes: []`)
///    preserves `last_vom` instead of wiping it.
/// 3) Abrupt `bsk mcp` `stdio` read error (`ConnectionReset` via TCP `SO_LINGER=0` RST on stdin,
///    NOT clean 0-byte EOF) still reaps its exclusive transient `mcp:<pid>:<nonce>` session.
/// 4) A suspended `DialogOperation` (`tool.cooperate` sync) completing *after* `teardown_session`
///    does NOT resurrect a zombie `SessionContextSlot` in `ImplicitScopeRegistry`.
#[tokio::test]
async fn counterexample_e_truncated_delta_whitespace_delta_abrupt_mcp_rst_and_late_teardown_liveness()
 {
    let temp = tempfile::tempdir_in("/tmp").unwrap();
    let sock = temp.path().join("ipc.sock");
    let handle = daemon::run(
        DaemonConfig::new(0).with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal),
        Some(sock.clone()),
    )
    .await
    .unwrap();
    let state = handle.state();
    let ws_addr = handle.ws_addr();
    let info = DaemonInfo::now(
        std::process::id(),
        sock.clone(),
        ws_addr.port(),
        bsk::daemon::state::DAEMON_VERSION,
    );
    std::fs::write(
        temp.path().join("daemon.json"),
        serde_json::to_vec(&info).unwrap(),
    )
    .unwrap();

    let mut ws = connect_ext(ws_addr).await;
    do_handshake(&mut ws, TEST_EXT_ID).await;

    async fn recv_ws(ws: &mut Ws) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match ws.next().await.unwrap().unwrap() {
                    Message::Text(text) => return serde_json::from_str::<Value>(&text).unwrap(),
                    Message::Ping(d) => ws.send(Message::Pong(d)).await.unwrap(),
                    other => panic!("unexpected ws message: {other:?}"),
                }
            }
        })
        .await
        .expect("ws frame timeout")
    }

    let run_bsk = |args: Vec<String>| {
        let home = temp.path().to_path_buf();
        tokio::spawn(async move {
            Command::new(env!("CARGO_BIN_EXE_bsk"))
                .env("BSK_HOME", &home)
                .env("BSK_AUTO_START", "0")
                .env("BSK_AUTO_UPDATE", "off")
                .env_remove("BSK_SESSION")
                .env_remove("BSK_SCOPE")
                .env_remove("CLAUDE_CODE_AGENT_ID")
                .env_remove("CODEX_THREAD_ID")
                .env_remove("ANTIGRAVITY_CONVERSATION_ID")
                .env_remove("CURSOR_TRACE_ID")
                .env_remove("DSH_SESSION_ID")
                .args(&args)
                .output()
                .await
                .unwrap()
        })
    };

    // --- Parts 1 & 2: Truncated `--max-tokens 150` text `delta` + whitespace-collapsed empty `delta` ---
    let ctx_1 = "55555555-5555-4555-8555-555555555551";
    let obs_1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
    let obs_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
    let obs_3 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3";
    let obs_4 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4";

    let open_task = run_bsk(vec![
        "open".into(),
        "https://app.test/feed".into(),
        "--json".into(),
    ]);
    let start_req = recv_ws(&mut ws).await;
    assert_eq!(start_req["method"], "tool.session_start");
    ws.send(Message::Text(
        json!({ "id": start_req["id"], "result": { "agent_window_id": 401 } }).to_string(),
    ))
    .await
    .unwrap();
    let nav_req = recv_ws(&mut ws).await;
    assert_eq!(nav_req["method"], "tool.navigate");
    ws.send(Message::Text(
        json!({
            "id": nav_req["id"],
            "result": { "tab_id": 31, "url": "https://app.test/feed", "final_url": "https://app.test/feed", "reached": "load" }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let init_sync_req = recv_ws(&mut ws).await;
    ws.send(Message::Text(
        json!({
            "id": init_sync_req["id"],
            "result": {
                "tab_id": 31,
                "control_policy": "target",
                "kind": "baseline",
                "history_complete": true,
                "context_id": ctx_1,
                "observation_id": obs_1,
                "changes": [],
                "observation": {
                    "observation_id": obs_1,
                    "tab_id": 31,
                    "url": "https://app.test/feed",
                    "title": "Feed",
                    "text": "@e1 heading \"Orders\"\n@e2 status \"Count: 1\"\n@e3 region \"Below Fold\"",
                    "ref_count": 3,
                    "truncated": false
                },
                "state": { "mode": "ready", "revision": 1 }
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    assert!(open_task.await.unwrap().status.success());

    // Step 1a: `bsk sync --max-tokens 150 --json` establishes truncated baseline (`cur-150`).
    let trunc_base_task = run_bsk(vec![
        "sync".into(),
        "--max-tokens".into(),
        "150".into(),
        "--json".into(),
    ]);
    let trunc_base_req = recv_ws(&mut ws).await;
    assert_eq!(trunc_base_req["params"]["max_tokens"], 150);
    ws.send(Message::Text(
        json!({
            "id": trunc_base_req["id"],
            "result": {
                "tab_id": 31,
                "control_policy": "target",
                "kind": "baseline",
                "baseline_reason": "token_budget_changed",
                "history_complete": true,
                "context_id": ctx_1,
                "observation_id": obs_2,
                "changes": [],
                "observation": {
                    "observation_id": obs_2,
                    "tab_id": 31,
                    "url": "https://app.test/feed",
                    "title": "Feed",
                    "text": "@e1 heading \"Orders\"\n@e2 status \"Count: 1\"",
                    "ref_count": 3,
                    "truncated": true,
                    "next_cursor": "cur-150"
                },
                "state": { "mode": "ready", "revision": 1 }
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let trunc_base_out = trunc_base_task.await.unwrap();
    assert!(trunc_base_out.status.success());

    // Step 1b: Equal-token text `delta` above the cutoff (`Count: 1` -> `Count: 2`) under `--max-tokens 150 --match-text "Count: 2"`.
    let trunc_delta_task = run_bsk(vec![
        "sync".into(),
        "--max-tokens".into(),
        "150".into(),
        "--match-text".into(),
        "Count: 2".into(),
        "--json".into(),
    ]);
    let trunc_delta_req = recv_ws(&mut ws).await;
    assert_eq!(trunc_delta_req["params"]["max_tokens"], 150);
    ws.send(Message::Text(
        json!({
            "id": trunc_delta_req["id"],
            "result": {
                "tab_id": 31,
                "control_policy": "target",
                "kind": "delta",
                "history_complete": true,
                "previous_context_id": ctx_1,
                "previous_observation_id": obs_2,
                "context_id": ctx_1,
                "observation_id": obs_3,
                "observation_patch": {
                    "lines": [
                        {
                            "line": 2,
                            "previous": "@e2 status \"Count: 1\"",
                            "text": "@e2 status \"Count: 2\""
                        }
                    ]
                },
                "changes": [
                    {
                        "frame_id": 0,
                        "kind": "text",
                        "id": "@e2",
                        "label": "status",
                        "previous_value": "Count: 1",
                        "value": "Count: 2",
                        "lines": [2]
                    }
                ],
                "state": { "mode": "ready", "revision": 2 }
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let trunc_delta_out = trunc_delta_task.await.unwrap();
    assert!(trunc_delta_out.status.success());
    let trunc_delta_json: Value = serde_json::from_slice(&trunc_delta_out.stdout).unwrap();
    assert!(
        trunc_delta_json["vom"]
            .as_str()
            .unwrap()
            .contains("Count: 2"),
        "truncated text delta with matching max_tokens must patch last_vom: {trunc_delta_json}"
    );
    assert_eq!(trunc_delta_json["truncated"], true);
    assert_eq!(trunc_delta_json["next_cursor"], "cur-150");

    // Step 1c: Follow-up `unchanged` `--max-tokens 150` still hydrates patched VOM + truncation metadata.
    let trunc_unchanged_task = run_bsk(vec![
        "sync".into(),
        "--max-tokens".into(),
        "150".into(),
        "--json".into(),
    ]);
    let trunc_unchanged_req = recv_ws(&mut ws).await;
    ws.send(Message::Text(
        json!({
            "id": trunc_unchanged_req["id"],
            "result": {
                "tab_id": 31,
                "control_policy": "target",
                "kind": "unchanged",
                "history_complete": true,
                "previous_context_id": ctx_1,
                "previous_observation_id": obs_3,
                "context_id": ctx_1,
                "observation_id": obs_3,
                "changes": [],
                "state": { "mode": "ready", "revision": 2 }
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let trunc_unchanged_out = trunc_unchanged_task.await.unwrap();
    assert!(trunc_unchanged_out.status.success());
    let trunc_unchanged_json: Value = serde_json::from_slice(&trunc_unchanged_out.stdout).unwrap();
    assert_eq!(
        trunc_unchanged_json["vom"],
        "@e1 heading \"Orders\"\n@e2 status \"Count: 2\""
    );
    assert_eq!(trunc_unchanged_json["truncated"], true);
    assert_eq!(trunc_unchanged_json["next_cursor"], "cur-150");

    // Step 2: Whitespace-collapsed `delta` (`observation_patch: { lines: [] }, changes: []`) preserves `last_vom`.
    let ws_collapse_task = run_bsk(vec![
        "sync".into(),
        "--max-tokens".into(),
        "150".into(),
        "--match-text".into(),
        "Count: 2".into(),
        "--json".into(),
    ]);
    let ws_collapse_req = recv_ws(&mut ws).await;
    ws.send(Message::Text(
        json!({
            "id": ws_collapse_req["id"],
            "result": {
                "tab_id": 31,
                "control_policy": "target",
                "kind": "delta",
                "history_complete": true,
                "previous_context_id": ctx_1,
                "previous_observation_id": obs_3,
                "context_id": ctx_1,
                "observation_id": obs_4,
                "observation_patch": { "lines": [] },
                "changes": [],
                "state": { "mode": "ready", "revision": 3 }
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let ws_collapse_out = ws_collapse_task.await.unwrap();
    assert!(ws_collapse_out.status.success());
    let ws_collapse_json: Value = serde_json::from_slice(&ws_collapse_out.stdout).unwrap();
    assert!(
        ws_collapse_json["vom"]
            .as_str()
            .unwrap()
            .contains("Count: 2"),
        "whitespace-collapsed empty text delta must preserve last_vom: {ws_collapse_json}"
    );
    assert_eq!(ws_collapse_json["truncated"], true);

    // --- Part 3: Abrupt TCP `RST` (`ConnectionReset`) on `bsk mcp` stdin still reaps transient session ---
    let tcp_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let tcp_addr = tcp_listener.local_addr().unwrap();
    let parent_sock = tokio::net::TcpSocket::new_v4().unwrap();
    let mut parent_tx = parent_sock.connect(tcp_addr).await.unwrap();
    let (child_rx_std, _) = tcp_listener.accept().unwrap();
    let child_stdin_fd = std::os::fd::OwnedFd::from(child_rx_std);

    let mut mcp_child = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .arg("mcp")
        .env("BSK_HOME", temp.path())
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
        .stdin(Stdio::from(child_stdin_fd))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn bsk mcp with tcp stdin");
    let mut mcp_stdout = BufReader::new(mcp_child.stdout.take().expect("mcp stdout"));

    parent_tx
        .write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"rst-test\",\"version\":\"1.0\"}}}\n",
        )
        .await
        .unwrap();
    let mut init_line = String::new();
    mcp_stdout.read_line(&mut init_line).await.unwrap();
    assert!(init_line.contains("\"protocolVersion\""));

    parent_tx
        .write_all(
            b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"bsk_session\",\"arguments\":{\"action\":\"start\"}}}\n",
        )
        .await
        .unwrap();
    let mcp_start_req = recv_ws(&mut ws).await;
    assert_eq!(mcp_start_req["method"], "tool.session_start");
    ws.send(Message::Text(
        json!({ "id": mcp_start_req["id"], "result": { "agent_window_id": 402 } }).to_string(),
    ))
    .await
    .unwrap();
    let mut start_line = String::new();
    mcp_stdout.read_line(&mut start_line).await.unwrap();
    let start_rpc: Value = serde_json::from_str(start_line.trim()).unwrap();
    let start_payload: Value =
        serde_json::from_str(start_rpc["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let rst_sid = start_payload["session_id"].as_str().unwrap().to_owned();
    assert!(state.sessions.get(&SessionId(rst_sid.clone())).is_some());

    // Write an unterminated fragment so `read_message` blocks mid-line, then trigger TCP RST (`SO_LINGER=0`)!
    parent_tx.write_all(b"{\"jsonrpc\":\"2.0\"").await.unwrap();
    parent_tx.set_zero_linger().unwrap();
    drop(parent_tx);

    // `bsk mcp` must immediately invoke `tool.session_stop` to reap `rst_sid` before exiting on I/O error!
    let mcp_stop_req = recv_ws(&mut ws).await;
    assert_eq!(mcp_stop_req["method"], "tool.session_stop");
    assert_eq!(mcp_stop_req["params"]["session_id"], rst_sid);
    ws.send(Message::Text(
        json!({ "id": mcp_stop_req["id"], "result": {} }).to_string(),
    ))
    .await
    .unwrap();

    let mcp_out = tokio::time::timeout(Duration::from_secs(5), mcp_child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        !mcp_out.status.success(),
        "expected non-zero exit on stdin ConnectionReset, got success"
    );
    assert!(
        state.sessions.get(&SessionId(rst_sid.clone())).is_none(),
        "transient MCP session must be reaped even when stdin fails with ConnectionReset"
    );

    // --- Part 4: Suspended `DialogOperation` completing AFTER `teardown_session` must NOT resurrect zombie scope slot ---
    let late_sock = sock.clone();
    let late_start_task = tokio::spawn(async move {
        IpcClient::connect(&late_sock)
            .await
            .unwrap()
            .call_envelope::<_, Value>(
                "late-start",
                Method::SessionStart,
                Some(json!({})),
                IpcRequestMeta {
                    caller_scope: Some("scope:late-dialog".into()),
                    bind_scope: true,
                    ..Default::default()
                },
                Duration::from_secs(5),
            )
            .await
            .unwrap()
    });
    let late_ws_start = recv_ws(&mut ws).await;
    assert_eq!(late_ws_start["method"], "tool.session_start");
    ws.send(Message::Text(
        json!({ "id": late_ws_start["id"], "result": { "agent_window_id": 403 } }).to_string(),
    ))
    .await
    .unwrap();
    let (late_start_res, _) = late_start_task.await.unwrap();
    let late_sid = late_start_res.unwrap()["session_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let late_sync_sock = sock.clone();
    let late_sync_sid = late_sid.clone();
    let late_sync_task = tokio::spawn(async move {
        IpcClient::connect(&late_sync_sock)
            .await
            .unwrap()
            .call_with_id::<_, Value>(
                "late-coop-sync".into(),
                Method::ToolCooperate,
                Some(json!({ "session_id": late_sync_sid, "action": "sync" })),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
    });
    let late_sync_ws = recv_ws(&mut ws).await;
    assert_eq!(late_sync_ws["method"], "tool.cooperate");
    let late_op_id = late_sync_ws["params"]["_operation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    ws.send(Message::Text(
        json!({
            "event": "dialog.changed",
            "payload": {
                "session_id": late_sid,
                "operation_id": late_op_id,
                "dialog": {
                    "id": "dlg-late-1",
                    "tab_id": 77,
                    "type": "alert",
                    "message": "Hold sync",
                    "sequence": 1,
                    "decision_deadline": 60000
                }
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let late_sync_err = late_sync_task.await.unwrap().unwrap_err();
    assert_eq!(late_sync_err.code, ErrorCode::DialogPending);

    // Tear down `late_sid` BEFORE the suspended `tool.cooperate` WS call finishes!
    let stop_late_sock = sock.clone();
    let stop_late_sid = late_sid.clone();
    let stop_late_task = tokio::spawn(async move {
        IpcClient::connect(&stop_late_sock)
            .await
            .unwrap()
            .call_with_id::<_, Value>(
                "stop-late".into(),
                Method::SessionStop,
                Some(json!({ "session_id": stop_late_sid, "all": false })),
                Duration::from_secs(5),
            )
            .await
            .unwrap()
            .unwrap()
    });
    let stop_late_ws = recv_ws(&mut ws).await;
    assert_eq!(stop_late_ws["method"], "tool.session_stop");
    ws.send(Message::Text(
        json!({ "id": stop_late_ws["id"], "result": {} }).to_string(),
    ))
    .await
    .unwrap();
    let _ = stop_late_task.await.unwrap();
    assert!(state.sessions.get(&SessionId(late_sid.clone())).is_none());
    let tracked_after_teardown = state.scopes.tracked_session_count();

    // Now the extension delivers the late completion frame for the suspended `tool.cooperate`!
    ws.send(Message::Text(
        json!({
            "id": late_sync_ws["id"],
            "result": {
                "tab_id": 77,
                "control_policy": "target",
                "kind": "baseline",
                "history_complete": true,
                "context_id": "66666666-6666-4666-8666-666666666666",
                "observation_id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
                "changes": [],
                "observation": {
                    "observation_id": "ffffffff-ffff-4fff-8fff-ffffffffffff",
                    "tab_id": 77,
                    "url": "https://app.test/zombie",
                    "title": "Zombie",
                    "text": "@e1 button \"Zombie\"",
                    "ref_count": 1,
                    "truncated": false
                },
                "state": { "mode": "ready", "revision": 1 }
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    // Flush WS roundtrip via a quick `browser.list` IPC call to ensure the daemon processed the WS frame.
    let _ = IpcClient::connect(&sock)
        .await
        .unwrap()
        .call_with_id::<_, Value>(
            "flush-after-late-ws".into(),
            Method::BrowserList,
            Some(json!({})),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    // Give the spawned `DialogOperation` background task a moment to run `reconcile_completed_tool_rpc`.
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert_eq!(
        state.scopes.tracked_session_count(),
        tracked_after_teardown,
        "late DialogOperation completion after teardown_session must NOT resurrect a zombie SessionContextSlot"
    );
    assert_eq!(
        state.scopes.active_tab_id(&SessionId(late_sid)),
        None,
        "torn-down session must have no active_tab_id in scopes"
    );

    handle.shutdown().await;
}
