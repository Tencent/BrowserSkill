//! Wave 3c top-level E2E regressions:
//! 1. Session activity leases across `Unlocked` (`cooperate`, `dialog_accept`), `operation await`,
//!    and `SessionRunLog`, plus per-session `dialog_accept` serialization + deadline cancel -> `IntentWal`.
//! 2. `bind_scope` isolation when ephemeral `record start` / `bsk_record(start)` / `bsk_recipe(run)`
//!    sessions start and stop alongside an active implicit session.
//! 3. Multi-tab `ImplicitScopeRegistry` active-tab alias pinning across >32 ring evictions and
//!    authoritative per-tab `IntentWal` reconciliation (`UserAborted`, `dispatched: false`, resolved `tab_id`).
//! 4. #737 VOM cache last-mile closure: `bsk sync --json` + `bsk view` + `bsk step --baseline`,
//!    `bsk sync --wait-for` on slim text-patched `delta`, MCP `bsk_session(open/sync)` `cached_vom`
//!    hydration, `RunLogs` slim `delta` + multi-tab sensitive masking, and cold-start `plan` / `bsk_plan`
//!    Step 0 `context_id` pinning across batch steps.

use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bsk::daemon::info::DaemonInfo;
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
        label: "Wave3CMockChrome".into(),
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
                    "clientInfo": { "name": "wave3c-e2e", "version": "1.0" }
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
}

struct IsolatedEnv {
    home: tempfile::TempDir,
    sock: std::path::PathBuf,
    handle: daemon::DaemonHandle,
    ext_requests: Arc<Mutex<Vec<RequestFrame>>>,
}

impl IsolatedEnv {
    async fn start<F>(reply: F) -> Self
    where
        F: Fn(&RequestFrame) -> ResponseBody + Send + Sync + 'static,
    {
        let home = crate::support::short_tempdir();
        let sock = home.path().join("ipc.sock");
        let config = DaemonConfig::new(0)
            .with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal);
        let handle = daemon::run(config, Some(sock.clone())).await.unwrap();
        let ws_addr = handle.ws_addr();
        let info = DaemonInfo::now(
            std::process::id(),
            sock.clone(),
            ws_addr.port(),
            bsk::daemon::state::DAEMON_VERSION,
        )
        .with_protocol_version(bsk::daemon::state::PROTOCOL_VERSION)
        .with_ipc_envelope(true);
        bsk::daemon::info::write_to_path(&info, &home.path().join("daemon.json")).unwrap();

        let mut ws = connect_ext(ws_addr).await;
        do_handshake(&mut ws, TEST_EXT_ID).await;

        let ext_requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&ext_requests);
        let (writer, mut reader): (SplitSink<Ws, Message>, SplitStream<Ws>) = ws.split();
        let writer = Arc::new(tokio::sync::Mutex::new(writer));
        let reply = Arc::new(reply);
        let mut next_window_id: i64 = 300;
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
            sock,
            handle,
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
        self.handle.shutdown().await;
    }
}

/// Pillar 1 E2E:
/// - RAII `SessionActivityGuard` keeps an active session alive across `Unlocked` (`cooperate wait`),
///   `SessionRunLog` (`bsk logs`), and `operation await` well past `session_idle` (240ms, reaper tick 100ms).
/// - Two concurrent `tool.dialog_accept` RPCs serialize on `dialog_operations.decision_lock`:
///   #1 times out after dispatch (`cancel` frame forwarded at deadline -> `effect_state: "unknown"` on
///   `tab_id: 77` recorded into `IntentWal` BEFORE releasing the lock), so #2 is immediately blocked by
///   `IntentWal` (`uncertain_prior_effect`, `dispatched: false`) with ONLY ONE `tool.dialog_accept`
///   ever dispatched to the extension WS!
#[tokio::test]
async fn wave3c_unlocked_liveness_lease_and_dialog_accept_serialization() {
    let home = crate::support::short_tempdir();
    let sock = home.path().join("ipc.sock");
    let mut config =
        DaemonConfig::new(0).with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal);
    config.session_idle = Duration::from_millis(240);

    let handle = daemon::run(config, Some(sock.clone())).await.unwrap();
    let state = handle.state();
    let ws_addr = handle.ws_addr();
    let info = DaemonInfo::now(
        std::process::id(),
        sock.clone(),
        ws_addr.port(),
        bsk::daemon::state::DAEMON_VERSION,
    )
    .with_protocol_version(bsk::daemon::state::PROTOCOL_VERSION)
    .with_ipc_envelope(true);
    bsk::daemon::info::write_to_path(&info, &home.path().join("daemon.json")).unwrap();

    let mut ws = connect_ext(ws_addr).await;
    do_handshake(&mut ws, TEST_EXT_ID).await;

    let dialog_accept_count = Arc::new(AtomicUsize::new(0));
    let dialog_accept_count_ext = Arc::clone(&dialog_accept_count);
    let cancel_count = Arc::new(AtomicUsize::new(0));
    let cancel_count_ext = Arc::clone(&cancel_count);
    let session_start_count = Arc::new(AtomicUsize::new(0));
    let session_start_count_ext = Arc::clone(&session_start_count);

    let (writer, mut reader): (SplitSink<Ws, Message>, SplitStream<Ws>) = ws.split();
    let writer = Arc::new(tokio::sync::Mutex::new(writer));
    let writer_ext = Arc::clone(&writer);

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
            let writer = Arc::clone(&writer_ext);
            let dialog_accept_count = Arc::clone(&dialog_accept_count_ext);
            let cancel_count = Arc::clone(&cancel_count_ext);
            let session_start_count = Arc::clone(&session_start_count_ext);
            tokio::spawn(async move {
                match req.method {
                    Method::ToolSessionStart => {
                        let start_idx = session_start_count.fetch_add(1, Ordering::SeqCst);
                        if start_idx > 0 {
                            tokio::time::sleep(Duration::from_millis(60)).await;
                        }
                        let resp = ResponseFrame {
                            id: req.id,
                            body: ResponseBody::Ok(json!({ "agent_window_id": 401 + start_idx })),
                        };
                        let _ = writer
                            .lock()
                            .await
                            .send(Message::Text(serde_json::to_string(&resp).unwrap()))
                            .await;
                    }
                    Method::ToolNavigate => {
                        let resp = ResponseFrame {
                            id: req.id,
                            body: ResponseBody::Ok(json!({
                                "tab_id": 77,
                                "url": "https://dlg.test/",
                                "final_url": "https://dlg.test/",
                                "reached": "load"
                            })),
                        };
                        let _ = writer
                            .lock()
                            .await
                            .send(Message::Text(serde_json::to_string(&resp).unwrap()))
                            .await;
                    }
                    Method::ToolCooperate => {
                        let action = req
                            .params
                            .as_ref()
                            .and_then(|p| p.get("action"))
                            .and_then(Value::as_str)
                            .unwrap_or("sync");
                        if action == "wait" {
                            // Hold for 420ms (> 240ms session_idle, spanning 4 reaper sweeps!).
                            tokio::time::sleep(Duration::from_millis(420)).await;
                            let resp = ResponseFrame {
                                id: req.id,
                                body: ResponseBody::Ok(json!({
                                                    "tab_id": 77,
                                                    "control_policy": "target",
                                                    "ready": true,
                                                    "state": {
                                    "mode": "ready",
                                    "revision": 1,
                                    "url": "http://site.test/report",
                                    "title": "Sales"
                                }
                                                })),
                            };
                            let _ = writer
                                .lock()
                                .await
                                .send(Message::Text(serde_json::to_string(&resp).unwrap()))
                                .await;
                        } else {
                            let resp = ResponseFrame {
                                id: req.id,
                                body: ResponseBody::Ok(json!({
                                                    "tab_id": 77,
                                                    "control_policy": "target",
                                                    "kind": "baseline",
                                                    "history_complete": true,
                                                    "context_id": "11111111-1111-4111-8111-111111111111",
                                                    "observation_id": "22222222-2222-4222-8222-222222222222",
                                                    "changes": [],
                                                    "observation": {
                                                        "observation_id": "22222222-2222-4222-8222-222222222222",
                                                        "tab_id": 77,
                                                        "url": "https://dlg.test/",
                                                        "title": "Dialog Test",
                                                        "text": "@e1 button \"Trigger Confirm\"",
                                                        "ref_count": 1,
                                                        "truncated": false
                                                    },
                                                    "state": {
                                    "mode": "ready",
                                    "revision": 1,
                                    "url": "http://site.test/report",
                                    "title": "Sales"
                                }
                                                })),
                            };
                            let _ = writer
                                .lock()
                                .await
                                .send(Message::Text(serde_json::to_string(&resp).unwrap()))
                                .await;
                        }
                    }
                    Method::ToolClick => {
                        let params = req.params.unwrap();
                        let sid = params["session_id"].as_str().unwrap().to_owned();
                        let op_id = req.operation_id.unwrap();
                        // Emit `dialog.changed` opening `dlg-race-1` on `tab_id: 77`, suspending `ToolClick`!
                        let evt = json!({
                            "event": "dialog.changed",
                            "payload": {
                                "session_id": sid,
                                "tab_id": 77,
                                "operation_id": op_id,
                                "dialog": {
                                    "id": "dlg-race-1",
                                    "tab_id": 77,
                                    "type": "confirm",
                                    "message": "Commit wire transfer?",
                                    "sequence": 1,
                                    "decision_deadline": 60000
                                }
                            }
                        });
                        let _ = writer
                            .lock()
                            .await
                            .send(Message::Text(evt.to_string()))
                            .await;
                        // Hold `ToolClick` until after `operation await` + `dialog_accept` test completes.
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                    Method::ToolDialogAccept => {
                        dialog_accept_count.fetch_add(1, Ordering::SeqCst);
                        // Stall past #1's 180ms deadline so the daemon sends `cancel` at deadline!
                    }
                    Method::Cancel => {
                        cancel_count.fetch_add(1, Ordering::SeqCst);
                        let resp = ResponseFrame {
                            id: req.id,
                            body: ResponseBody::Ok(json!({ "cancelled": true })),
                        };
                        let _ = writer
                            .lock()
                            .await
                            .send(Message::Text(serde_json::to_string(&resp).unwrap()))
                            .await;
                    }
                    Method::ToolSessionStop => {
                        let resp = ResponseFrame {
                            id: req.id,
                            body: ResponseBody::Ok(json!({})),
                        };
                        let _ = writer
                            .lock()
                            .await
                            .send(Message::Text(serde_json::to_string(&resp).unwrap()))
                            .await;
                    }
                    _ => {}
                }
            });
        }
    });

    // 1. Open session `S1` via real `bsk open` in isolated scope `tracked-victim`.
    let scope_env = [("BSK_SCOPE", "tracked-victim")];
    let open_out = run_bsk_at(
        home.path(),
        &["open", "https://dlg.test/", "--json"],
        &scope_env,
    )
    .await;
    assert!(
        open_out.status.success(),
        "open failed: {}",
        String::from_utf8_lossy(&open_out.stderr)
    );
    let open_json: Value = serde_json::from_slice(&open_out.stdout).unwrap();
    let sid = open_json["session_id"].as_str().unwrap().to_owned();

    // 1b. Cancelled in-flight `SessionStartTracked` (`bind_scope: true`) in `tracked-victim`
    //     that races to `Ok(S2)` before `session_requests::cleanup` MUST NOT clobber or
    //     tombstone `tracked-victim`'s existing binding to `sid`!
    let expiry_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 60_000;
    let tracked_req_id = format!("{expiry_ms}:{}", uuid::Uuid::new_v4());
    IpcClient::connect(&sock)
        .await
        .unwrap()
        .call::<_, Value>(
            "prep-tracked-race",
            Method::SessionRequest,
            Some(json!({
                "request_id": tracked_req_id,
                "action": "prepare"
            })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("prepare tracked request");
    let sock_tracked = sock.clone();
    let tracked_req_id_start = tracked_req_id.clone();
    let tracked_task = tokio::spawn(async move {
        let mut c = IpcClient::connect(&sock_tracked).await.unwrap();
        c.call_envelope::<_, Value>(
            "start-tracked-race",
            Method::SessionStartTracked,
            Some(json!({ "request_id": tracked_req_id_start })),
            IpcRequestMeta {
                caller_scope: Some("scope:tracked-victim".into()),
                bind_scope: true,
                ..Default::default()
            },
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .0
    });
    tokio::time::sleep(Duration::from_millis(15)).await;
    IpcClient::connect(&sock)
        .await
        .unwrap()
        .call::<_, Value>(
            "cancel-tracked-race",
            Method::SessionRequest,
            Some(json!({
                "request_id": tracked_req_id,
                "action": "cancel"
            })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("cancel tracked request");
    let tracked_err = tracked_task
        .await
        .unwrap()
        .expect_err("cancelled SessionStartTracked must return Cancelled");
    assert_eq!(tracked_err.code, ErrorCode::Cancelled);
    assert_eq!(
        state
            .scopes
            .active_binding("scope:tracked-victim", &state.sessions)
            .map(|(b, _)| b.session_id.0),
        Some(sid.clone()),
        "cancelled in-flight SessionStartTracked must preserve existing bound session"
    );

    // 2. Run `Unlocked` `cooperate wait` lasting 420ms (> 240ms `session_idle`):
    //    `SessionActivityGuard` must keep `sid` alive!
    let wait_out = run_bsk_at(
        home.path(),
        &[
            "cooperate",
            "wait",
            "--session",
            &sid,
            "--timeout-ms",
            "2000",
            "--json",
        ],
        &[],
    )
    .await;
    assert!(
        wait_out.status.success(),
        "cooperate wait reaped mid-flight: {}",
        String::from_utf8_lossy(&wait_out.stderr)
    );
    assert_eq!(state.sessions.len(), 1);

    // 3. Touch via `SessionRunLog` across two 140ms sleeps (total 280ms > 240ms `session_idle`).
    tokio::time::sleep(Duration::from_millis(140)).await;
    let mut log_client = IpcClient::connect(&sock).await.unwrap();
    log_client
        .call::<_, Value>(
            "run-log-touch",
            Method::SessionRunLog,
            Some(json!({ "session_id": sid })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("SessionRunLog");
    tokio::time::sleep(Duration::from_millis(140)).await;
    assert_eq!(
        state.sessions.len(),
        1,
        "SessionRunLog must refresh session activity"
    );

    // 4. Trigger `DialogPending` via `bsk click @e1`.
    let click_out = run_bsk_at(home.path(), &["click", "@e1", "--json"], &scope_env).await;
    assert!(!click_out.status.success());
    let click_err: Value = serde_json::from_slice(&click_out.stdout).unwrap();
    assert_eq!(click_err["code"], "dialog_pending");
    let op_id = click_err["data"]["operation_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // 5. Hold an `operation await` for 320ms (> 240ms `session_idle`): activity guard keeps `sid` alive!
    let mut op_client = IpcClient::connect(&sock).await.unwrap();
    let op_res = op_client
        .call::<_, Value>(
            "op-await-1",
            Method::ToolOperationAwait,
            Some(json!({
                "session_id": sid,
                "operation_id": op_id,
                "timeout_ms": 320
            })),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert!(op_res.is_err(), "operation is still suspended by dialog");
    assert_eq!(
        state.sessions.len(),
        1,
        "operation await lease must keep session alive"
    );

    // 6. Fire two concurrent `tool.dialog_accept` RPCs:
    //    - #1 has `timeout_ms: 180` -> forwards `cancel` at deadline (`cancel_at_deadline: true`) and
    //      returns `Timeout` with `effect_state: "unknown"` on `tab_id: 77` (`OutcomeKind::EffectAwareAction`).
    //    - #2 starts 30ms later while #1 holds `dialog_operations.decision_lock` -> once #1 records
    //      `effect_state: "unknown"` into `IntentWal` and releases the lock, #2 is immediately blocked
    //      by `IntentWal` (`uncertain_prior_effect`) WITHOUT sending a second `tool.dialog_accept`!
    let sock_1 = sock.clone();
    let sid_1 = sid.clone();
    let accept_1 = tokio::spawn(async move {
        let mut c = IpcClient::connect(&sock_1).await.unwrap();
        c.call::<_, Value>(
            "dlg-accept-1",
            Method::ToolDialogAccept,
            Some(json!({
                "session_id": sid_1,
                "dialog_id": "dlg-race-1",
                "timeout_ms": 180
            })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
    });

    tokio::time::sleep(Duration::from_millis(30)).await;
    // Concurrent caller with a short 80ms budget times out on `decision_lock` with `session_busy`
    // (`dispatched: false, effect_state: "none"`) while #1 is in-flight!
    let sock_busy = sock.clone();
    let sid_busy = sid.clone();
    let accept_busy = tokio::spawn(async move {
        let mut c = IpcClient::connect(&sock_busy).await.unwrap();
        c.call::<_, Value>(
            "dlg-accept-busy",
            Method::ToolDialogAccept,
            Some(json!({
                "session_id": sid_busy,
                "dialog_id": "dlg-race-1",
                "timeout_ms": 80
            })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
    });
    // Concurrent caller with a 4000ms budget (> 180ms + 2000ms cancel cleanup) waits on
    // `decision_lock` until #1 records `effect_state: "unknown"` into `IntentWal`, then fails
    // closed immediately with `uncertain_prior_effect` WITHOUT dispatching a duplicate accept!
    let sock_2 = sock.clone();
    let sid_2 = sid.clone();
    let accept_2 = tokio::spawn(async move {
        let mut c = IpcClient::connect(&sock_2).await.unwrap();
        c.call::<_, Value>(
            "dlg-accept-2",
            Method::ToolDialogAccept,
            Some(json!({
                "session_id": sid_2,
                "dialog_id": "dlg-race-1",
                "timeout_ms": 4000
            })),
            Duration::from_secs(6),
        )
        .await
        .unwrap()
    });

    let err_busy = accept_busy
        .await
        .unwrap()
        .expect_err("accept_busy must time out waiting on decision_lock");
    let data_busy = err_busy.data.expect("accept_busy error data");
    assert_eq!(data_busy["reason"], "session_busy");
    assert_eq!(data_busy["dispatched"], false);
    assert_eq!(data_busy["effect_state"], "none");

    let err_1 = accept_1
        .await
        .unwrap()
        .expect_err("accept #1 must time out");
    assert_eq!(err_1.code, ErrorCode::Timeout);
    let data_1 = err_1.data.expect("accept #1 error data");
    assert_eq!(data_1["effect_state"], "unknown");
    assert_eq!(data_1["tab_id"], 77);
    assert!(
        cancel_count.load(Ordering::SeqCst) >= 1,
        "ToolDialogAccept deadline must forward cancel frame to extension"
    );

    let err_2 = accept_2
        .await
        .unwrap()
        .expect_err("accept #2 must fail closed via IntentWal");
    let data_2 = err_2.data.expect("accept #2 error data");
    assert_eq!(data_2["reason"], "uncertain_prior_effect");
    assert_eq!(data_2["dispatched"], false);
    assert_eq!(data_2["effect_state"], "none");
    assert_eq!(
        dialog_accept_count.load(Ordering::SeqCst),
        1,
        "decision_lock + IntentWal must prevent duplicate dialog_accept dispatch"
    );

    handle.shutdown().await;
}

/// Pillar 1 (`bind_scope` Isolation) E2E:
/// - Starting and stopping ephemeral sessions via CLI `bsk record start/stop`, MCP `bsk_record(start/stop)`,
///   and MCP `bsk_recipe(run)` must NEVER overwrite or tombstone the caller's active implicit session!
/// - Explicit `bsk session start` in an isolated scope (`BSK_SCOPE=explicit-agent`) MUST still bind!
#[tokio::test]
async fn wave3c_ephemeral_record_and_recipe_sessions_preserve_bound_scope() {
    let sync_page = Arc::new(AtomicUsize::new(0));
    let sync_page_ext = Arc::clone(&sync_page);

    let env = IsolatedEnv::start(move |req| match &req.method {
        Method::ToolTabList => ResponseBody::Ok(json!({
            "tabs": [{
                "tab_id": 11,
                "url": "http://site.test/report",
                "title": "Sales",
                "active": true,
                "scope": "agent"
            }]
        })),
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 11,
            "url": "http://site.test/report",
            "final_url": "http://site.test/report",
            "reached": "load"
        })),
        Method::ToolRecordStart => ResponseBody::Ok(json!({
            "recording": true,
            "tab_id": 91
        })),
        Method::ToolRecordAwait | Method::ToolRecordStop => ResponseBody::Ok(json!({
            "trace": bsk_protocol::tools::TraceV3 {
                version: 3,
                purpose: None,
                started_at: Some("2026-11-14T10:00:00Z".into()),
                recorded_at: "2026-11-14T10:01:00Z".into(),
                stopped_by: bsk_protocol::tools::StopReason::CliStop,
                entry: bsk_protocol::tools::TraceEntry {
                    start_url: "http://site.test/report".into(),
                },
                recorder: bsk_protocol::tools::RecorderInfo {
                    bsk: "0.5.0".into(),
                    vom: bsk_protocol::tools::VOM_FORMAT_VERSION,
                },
                states: vec![bsk_protocol::tools::TraceStateV3 {
                    id: "s1".into(),
                    url: "http://site.test/report".into(),
                    title: Some("Sales".into()),
                    body: "@vom 1\nL1 page".into(),
                    truncated: false,
                }],
                steps: vec![],
            }
        })),
        Method::ToolCooperate => {
            let n = sync_page_ext.fetch_add(1, Ordering::SeqCst);
            let ctx = format!("aaaaaaaa-aaaa-4aaa-8aaa-{:012}", n + 1);
            let obs = format!("bbbbbbbb-bbbb-4bbb-8bbb-{:012}", n + 1);
            let vom = if n >= 3 {
                "@vom 1\nL1 page\n  heading \"Sales\"\n  @e1 combobox \"Region\"\n  @e2 button \"Search\"\n  status \"Total $42\""
            } else {
                "@vom 1\nL1 page\n  heading \"Sales\"\n  @e1 combobox \"Region\"\n  @e2 button \"Search\""
            };
            ResponseBody::Ok(json!({
                "tab_id": 11,
                "control_policy": "target",
                "kind": "baseline",
                "history_complete": true,
                "context_id": ctx,
                "observation_id": obs,
                "changes": [],
                "observation": {
                    "observation_id": obs,
                    "tab_id": 11,
                    "url": "http://site.test/report",
                    "title": "Sales",
                    "text": vom,
                    "ref_count": 2,
                    "truncated": false
                },
                "state": {
                    "mode": "ready",
                    "revision": 1,
                    "url": "http://site.test/report",
                    "title": "Sales"
                }
            }))
        }
        Method::ToolSelect | Method::ToolClick => ResponseBody::Ok(json!({
            "tab_id": 11,
            "x": 10.0,
            "y": 20.0,
            "effect_state": "committed"
        })),
        Method::ToolSnapshot => ResponseBody::Ok(json!({
            "tab_id": 11,
            "text": "@vom 1\nL1 page\n  heading \"Sales\"\n  @e1 combobox \"Region\"\n  @e2 button \"Search\"\n  status \"Total $42\"",
            "ref_count": 2,
            "truncated": false
        })),
        other => panic!("unexpected method in bind_scope test: {other:?}"),
    })
    .await;

    // 1. CLI isolated scope `agent-alpha`: `bsk open` binds session `S1`.
    let cli_env = [("BSK_SCOPE", "agent-alpha")];
    let open_out = env
        .run_bsk(&["open", "http://site.test/report", "--json"], &cli_env)
        .await;
    assert!(open_out.status.success());
    let s1 = serde_json::from_slice::<Value>(&open_out.stdout).unwrap()["session_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Run `bsk record start` (which starts an ephemeral session, awaits trace completion,
    // and stops its ephemeral session) in the SAME `BSK_SCOPE=agent-alpha`!
    let cli_trace_dir = env.home.path().join("cli-trace");
    let rec_start = env
        .run_bsk(
            &[
                "record",
                "start",
                "--url",
                "http://site.test/report",
                "--output",
                cli_trace_dir.to_str().unwrap(),
                "--json",
            ],
            &cli_env,
        )
        .await;
    assert!(
        rec_start.status.success(),
        "record start stderr: {}",
        String::from_utf8_lossy(&rec_start.stderr)
    );
    let rec_json: Value = serde_json::from_slice(&rec_start.stdout).unwrap();
    assert_eq!(rec_json["window_closed"], true);

    // Subsequent `bsk sync` in `agent-alpha` MUST still resolve to `s1` (not tombstoned by `record`!)!
    let sync_after_rec = env.run_bsk(&["sync", "--json"], &cli_env).await;
    assert!(
        sync_after_rec.status.success(),
        "sync hijacked by stopped record session: {}",
        String::from_utf8_lossy(&sync_after_rec.stderr)
    );
    let sync_json: Value = serde_json::from_slice(&sync_after_rec.stdout).unwrap();
    assert_eq!(sync_json["session_id"], s1);

    // 2. MCP stdio server: `bsk_session(open)` binds `M1`, then `bsk_record(start)` AND
    //    `bsk_recipe(run)` create & tear down ephemeral sessions without clobbering `M1`!
    let mut mcp = McpProcess::spawn(env.home.path(), &[("BSK_RECIPES", "1")]).await;
    let m_open = mcp
        .call_tool(
            "bsk_session",
            json!({ "action": "open", "url": "http://site.test/report" }),
        )
        .await;
    assert_ne!(m_open["isError"], true, "mcp open failed: {m_open}");
    let m1 = serde_json::from_str::<Value>(m_open["content"][0]["text"].as_str().unwrap()).unwrap()
        ["session_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let mcp_trace_dir = env.home.path().join("mcp-trace");
    let m_rec_start = mcp
        .call_tool(
            "bsk_record",
            json!({
                "action": "start",
                "url": "http://site.test/report",
                "output": mcp_trace_dir.to_str().unwrap()
            }),
        )
        .await;
    assert_ne!(
        m_rec_start["isError"], true,
        "mcp record start: {m_rec_start}"
    );
    let m_rec_reply: Value =
        serde_json::from_str(m_rec_start["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(m_rec_reply["window_closed"], true);

    // Save a valid recipe and run `bsk_recipe(action="run")` without `session`
    // (which starts & stops its own ephemeral session!).
    let m_recipe_save = mcp
        .call_tool(
            "bsk_recipe",
            json!({
                "action": "save",
                "recipe": {
                    "recipe_version": 1,
                    "name": "sales",
                    "description": "Read a region's total",
                    "site": { "origins": ["http://site.test"], "start": "/report" },
                    "params": { "region": { "type": "enum", "values": ["East", "North"] } },
                    "segments": [{
                        "id": "query",
                        "requires": [{ "role": "heading", "name": "Sales" }],
                        "steps": [
                            { "action": "select", "target": { "role": "combobox", "name": "Region" }, "values": ["{{region}}"] },
                            { "action": "click", "target": { "role": "button", "name": "Search" } }
                        ],
                        "until": { "text": "Total", "timeout_ms": 2000 }
                    }],
                    "outputs": { "total": { "regex": "Total \\$(\\d+)", "required": true } }
                }
            }),
        )
        .await;
    assert_ne!(
        m_recipe_save["isError"], true,
        "mcp recipe save: {m_recipe_save}"
    );

    let m_recipe = mcp
        .call_tool(
            "bsk_recipe",
            json!({
                "action": "run",
                "name": "sales",
                "params": { "region": "East" }
            }),
        )
        .await;
    assert_ne!(m_recipe["isError"], true, "mcp recipe run: {m_recipe}");

    // Verify MCP's implicit session is STILL `m1`!
    let m_sync = mcp
        .call_tool("bsk_session", json!({ "action": "sync" }))
        .await;
    assert_ne!(
        m_sync["isError"], true,
        "mcp sync after recipe/record failed: {m_sync}"
    );
    let m_sync_meta: Value =
        serde_json::from_str(m_sync["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(m_sync_meta["session_id"], m1);

    // 3. Explicit `bsk session start` in `BSK_SCOPE=explicit-agent` DOES bind its scope!
    let explicit_env = [("BSK_SCOPE", "explicit-agent")];
    let exp_start = env
        .run_bsk(&["session", "start", "--json"], &explicit_env)
        .await;
    assert!(exp_start.status.success());
    let exp_sid = serde_json::from_slice::<Value>(&exp_start.stdout).unwrap()["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let exp_sync = env.run_bsk(&["sync", "--json"], &explicit_env).await;
    assert!(exp_sync.status.success());
    let exp_sync_json: Value = serde_json::from_slice(&exp_sync.stdout).unwrap();
    assert_eq!(exp_sync_json["session_id"], exp_sid);

    drop(mcp);
    env.shutdown().await;
}

/// Pillar 2 E2E:
/// - Multi-tab `ImplicitScopeRegistry` keeps Tab `10`'s active `c1`/`o1` aliases resolvable even after
///   Tab `20` performs 36 syncs (`c2..c37`, `o2..o37` > 32 ring limit)!
/// - `bsk click @e1 --context c1` (with `active_tab_id == Some(20)` and NO `--tab-id`) expands `c1`
///   to Tab `10`'s UUID AND attributes `ErrorCode::UserAborted` (`effect_state: "unknown"`) to Tab `10`
///   in `IntentWal` — leaving Tab `20` completely unblocked while Tab `10` fails closed until resolved!
/// - Pre-dispatch cancellation (`dispatched: false, effect_state: "none"`) settles `IntentWal` cleanly.
#[tokio::test]
async fn wave3c_multitab_alias_pinning_and_wal_tab_isolation() {
    let tab10_ctx = "10101010-1010-4010-8010-000000000010";
    let tab10_obs = "20202020-2020-4020-8020-000000000010";
    let click_attempt = Arc::new(AtomicUsize::new(0));
    let click_attempt_ext = Arc::clone(&click_attempt);

    let env = IsolatedEnv::start(move |req| match &req.method {
        Method::ToolTabList => ResponseBody::Ok(json!({
            "tabs": [{
                "tab_id": 11,
                "url": "http://site.test/report",
                "title": "Sales",
                "active": true,
                "scope": "agent"
            }]
        })),
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 10,
            "url": "https://multi.test/tab10",
            "final_url": "https://multi.test/tab10",
            "reached": "load"
        })),
        Method::ToolCooperate => {
            let tab_id = req
                .params
                .as_ref()
                .and_then(|p| p.get("tab_id"))
                .and_then(Value::as_i64)
                .unwrap_or(10);
            if tab_id == 10 {
                ResponseBody::Ok(json!({
                    "tab_id": 10,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": tab10_ctx,
                    "observation_id": tab10_obs,
                    "changes": [],
                    "observation": {
                        "observation_id": tab10_obs,
                        "tab_id": 10,
                        "url": "https://multi.test/tab10",
                        "title": "Tab 10",
                        "text": "@e1 button \"Submit Tab 10\"",
                        "ref_count": 1,
                        "truncated": false
                    },
                    "state": {
                    "mode": "ready",
                    "revision": 1,
                    "url": "http://site.test/report",
                    "title": "Sales"
                }
                }))
            } else {
                let seq = uuid::Uuid::new_v4().to_string();
                let obs = uuid::Uuid::new_v4().to_string();
                ResponseBody::Ok(json!({
                    "tab_id": 20,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": seq,
                    "observation_id": obs,
                    "changes": [],
                    "observation": {
                        "observation_id": obs,
                        "tab_id": 20,
                        "url": "https://multi.test/tab20",
                        "title": "Tab 20",
                        "text": "@e1 button \"Submit Tab 20\"",
                        "ref_count": 1,
                        "truncated": false
                    },
                    "state": {
                    "mode": "ready",
                    "revision": 1,
                    "url": "http://site.test/report",
                    "title": "Sales"
                }
                }))
            }
        }
        Method::ToolClick => {
            let turn = click_attempt_ext.fetch_add(1, Ordering::SeqCst);
            let ctx = req
                .params
                .as_ref()
                .and_then(|p| p.get("context_id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            match turn {
                // Turn 0: Pre-dispatch cancellation on Tab 20 -> must NOT freeze IntentWal!
                0 => ResponseBody::Err(bsk_protocol::RpcError {
                    code: ErrorCode::Cancelled,
                    message: "rpc aborted before dispatch".into(),
                    data: Some(json!({
                        "reason": "cancelled_before_dispatch",
                        "dispatched": false,
                        "effect_state": "none",
                        "phase": "precondition"
                    })),
                }),
                // Turn 1: Action on Tab 10 using `--context c1` (with NO `tab_id` in params!)
                // fails with `ErrorCode::UserAborted`! Verify `c1` expanded to `tab10_ctx`!
                1 => {
                    assert_eq!(
                        ctx, tab10_ctx,
                        "c1 must still expand to Tab 10's UUID after 36 Tab 20 syncs!"
                    );
                    ResponseBody::Err(bsk_protocol::RpcError {
                        code: ErrorCode::UserAborted,
                        message: "User clicked Stop in overlay mid-action".into(),
                        data: Some(json!({
                            "tab_id": 10
                        })),
                    })
                }
                // Turn 2+: Actions on Tab 20 succeed cleanly!
                _ => ResponseBody::Ok(json!({
                    "tab_id": 20,
                    "x": 15.0,
                    "y": 25.0,
                    "effect_state": "committed"
                })),
            }
        }
        other => panic!("unexpected method in multitab test: {other:?}"),
    })
    .await;

    let scope = [("BSK_SCOPE", "multitab-agent")];

    // 1. Open Tab 10 -> mints `c1` / `o1` on Tab 10.
    let open_out = env
        .run_bsk(&["open", "https://multi.test/tab10", "--json"], &scope)
        .await;
    assert!(open_out.status.success());
    let open_json: Value = serde_json::from_slice(&open_out.stdout).unwrap();
    let sid = open_json["session_id"].as_str().unwrap().to_owned();
    assert_eq!(open_json["context_id"], tab10_ctx);
    assert_eq!(open_json["ctx"], "c1");

    // 2. Sync Tab 20 36 times (`c2..c37`), overflowing the 32-entry ring while `active_tab_id` becomes 20!
    let mut latest_tab20_ctx = String::new();
    let mut ipc = IpcClient::connect(&env.sock).await.unwrap();
    for i in 0..36 {
        let (res, meta) = ipc
            .call_envelope::<_, Value>(
                format!("tab20-sync-{i}"),
                Method::ToolCooperate,
                Some(json!({
                    "session_id": sid,
                    "tab_id": 20,
                    "action": "sync"
                })),
                IpcRequestMeta {
                    caller_scope: Some("multitab-agent".into()),
                    return_scope_meta: true,
                    ..Default::default()
                },
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        res.expect("tab 20 sync");
        latest_tab20_ctx = meta.scope_meta.unwrap().short_ctx.unwrap();
    }
    assert_eq!(latest_tab20_ctx, "c37");

    // 3. Turn 0: Pre-dispatch cancellation on Tab 20 (`dispatched: false`) leaves Tab 20 unblocked.
    let cancel_out = env
        .run_bsk(
            &[
                "click",
                "@e1",
                "--tab-id",
                "20",
                "--context",
                &latest_tab20_ctx,
                "--json",
            ],
            &scope,
        )
        .await;
    assert!(!cancel_out.status.success());

    // 4. Turn 1: Run `bsk click @e1 --context c1` WITHOUT `--tab-id`!
    //    `c1` expands to `tab10_ctx` AND `UserAborted` freezes Tab 10 (NOT `active_tab_id == 20`!).
    let abort_out = env
        .run_bsk(&["click", "@e1", "--context", "c1", "--json"], &scope)
        .await;
    assert!(!abort_out.status.success());

    // 5. Prove Tab 20 is STILL unblocked (`bsk click @e1 --tab-id 20 --context c37` succeeds!),
    //    whereas Tab 10 fails closed with `uncertain_prior_effect`!
    let tab20_ok = env
        .run_bsk(
            &[
                "click",
                "@e1",
                "--tab-id",
                "20",
                "--context",
                &latest_tab20_ctx,
                "--json",
            ],
            &scope,
        )
        .await;
    assert!(
        tab20_ok.status.success(),
        "Tab 20 was falsely frozen by Tab 10's UserAborted WAL entry: {}",
        String::from_utf8_lossy(&tab20_ok.stdout)
    );

    let tab10_blocked = env
        .run_bsk(&["click", "@e1", "--context", "c1", "--json"], &scope)
        .await;
    assert!(!tab10_blocked.status.success());
    let blocked_err: Value = serde_json::from_slice(&tab10_blocked.stdout).unwrap();
    assert_eq!(blocked_err["data"]["reason"], "uncertain_prior_effect");

    // Resolve Tab 10's WAL entry and verify Tab 10 is unblocked too.
    let resolve_out = env
        .run_bsk(
            &[
                "ledger",
                "resolve",
                "--session",
                &sid,
                "--tab-id",
                "10",
                "--json",
            ],
            &scope,
        )
        .await;
    assert!(
        resolve_out.status.success(),
        "ledger resolve failed: {}",
        String::from_utf8_lossy(&resolve_out.stderr)
    );

    env.shutdown().await;
}

/// Pillar 3 E2E (#737 VOM Cache Last-Mile Closure):
/// 1. `bsk sync --json` (`unchanged`) hydrates `vom` AND `observation` + `observation_origin`,
///    so `bsk view <sync.json> --find ...` and `bsk step --baseline <sync.json>` both work directly!
/// 2. Slim text-patched `delta` (`observation_patch.lines`, no `observation.text` on wire):
///    - `bsk sync --wait-for "Pay $25"` succeeds with **0** `tool.snapshot` fallback calls;
///    - `RunLogs` (`bsk logs`) hydrates the patched text so subsequent `click @e2` logs `"Pay $25"`
///      and preserves per-tab `sensitive` masking across multi-tab fills!
/// 3. MCP `bsk_session(open)` (reusing session with `unchanged`) and `bsk_session(sync, wait_for=...)`
///    both emit full VOM in content block #2!
/// 4. Cold-start CLI `bsk plan` and MCP `bsk_plan` (without `--context`) pin Step 0's resolved
///    `session_id`, `tab_id`, and `context_id` UUID across Steps `1..N` even if another sync rotates
///    the latest context mid-batch!
#[tokio::test]
async fn wave3c_vom_cache_last_mile_run_log_and_plan_context_pinning() {
    let sync_stage = Arc::new(AtomicUsize::new(0));
    let sync_stage_ext = Arc::clone(&sync_stage);
    let snapshot_calls = Arc::new(AtomicUsize::new(0));
    let snapshot_calls_ext = Arc::clone(&snapshot_calls);
    type SeenPlanCall = (String, Option<i64>, String);
    let plan_seen_contexts: Arc<Mutex<Vec<SeenPlanCall>>> = Arc::new(Mutex::new(Vec::new()));
    let plan_seen_ext = Arc::clone(&plan_seen_contexts);

    let ctx_base = "aaaaaaaa-0000-4000-8000-000000000001";
    let obs_base = "bbbbbbbb-0000-4000-8000-000000000001";
    let ctx_delta = "aaaaaaaa-0000-4000-8000-000000000002";
    let obs_delta = "bbbbbbbb-0000-4000-8000-000000000002";
    let ctx_delta_2 = "aaaaaaaa-0000-4000-8000-000000000005";
    let obs_delta_2 = "bbbbbbbb-0000-4000-8000-000000000005";
    let ctx_tab2 = "aaaaaaaa-0000-4000-8000-000000000003";
    let obs_tab2 = "bbbbbbbb-0000-4000-8000-000000000003";
    let ctx_plan = "aaaaaaaa-0000-4000-8000-000000000004";
    let obs_plan = "bbbbbbbb-0000-4000-8000-000000000004";

    let env = IsolatedEnv::start(move |req| match &req.method {
        Method::ToolTabList => ResponseBody::Ok(json!({
            "tabs": [{
                "tab_id": 11,
                "url": "http://site.test/report",
                "title": "Sales",
                "active": true,
                "scope": "agent"
            }]
        })),
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 11,
            "url": "https://shop.test/checkout",
            "final_url": "https://shop.test/checkout",
            "reached": "load"
        })),
        Method::ToolSnapshot => {
            snapshot_calls_ext.fetch_add(1, Ordering::SeqCst);
            ResponseBody::Ok(json!({
                "tab_id": 11,
                "text": "UNEXPECTED SNAPSHOT FALLBACK",
                "ref_count": 0,
                "truncated": false
            }))
        }
        Method::ToolCooperate => {
            let tab_id = req
                .params
                .as_ref()
                .and_then(|p| p.get("tab_id"))
                .and_then(Value::as_i64)
                .unwrap_or(11);
            if tab_id == 22 {
                return ResponseBody::Ok(json!({
                    "tab_id": 22,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": ctx_tab2,
                    "observation_id": obs_tab2,
                    "changes": [],
                    "observation": {
                        "observation_id": obs_tab2,
                        "tab_id": 22,
                        "url": "https://shop.test/notes",
                        "title": "Public Notes",
                        "text": "@e1 textbox \"Public Note\"",
                        "ref_count": 1,
                        "truncated": false
                    },
                    "state": {
                    "mode": "ready",
                    "revision": 1,
                    "url": "http://site.test/report",
                    "title": "Sales"
                }
                }));
            }
            let stage = sync_stage_ext.fetch_add(1, Ordering::SeqCst);
            match stage {
                // Stage 0: initial baseline on Tab 11 (`@e1 textbox "Password" sensitive`, `@e2 button "Pay $10"`)
                0 => ResponseBody::Ok(json!({
                    "tab_id": 11,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": ctx_base,
                    "observation_id": obs_base,
                    "changes": [],
                    "observation": {
                        "observation_id": obs_base,
                        "tab_id": 11,
                        "url": "https://shop.test/checkout",
                        "title": "Checkout",
                        "text": "heading \"Checkout\"\n@e1 textbox \"Password\" [filled] =\"•••\"\n@e2 button \"Pay $10\"",
                        "ref_count": 2,
                        "truncated": false
                    },
                    "state": {
                    "mode": "ready",
                    "revision": 1,
                    "url": "http://site.test/report",
                    "title": "Sales"
                }
                })),
                // Stage 1: slim `unchanged` (NO `observation` on wire!)
                1 => ResponseBody::Ok(json!({
                    "tab_id": 11,
                    "control_policy": "target",
                    "kind": "unchanged",
                    "history_complete": true,
                    "previous_context_id": ctx_base,
                    "context_id": ctx_base,
                    "observation_id": obs_base,
                    "changes": [],
                    "state": {
                        "mode": "ready",
                        "revision": 1,
                        "url": "https://shop.test/checkout",
                        "title": "Checkout"
                    }
                })),
                // Stage 2 (post-step sync): slim `unchanged` (NO `observation` on wire!)
                2 => ResponseBody::Ok(json!({
                    "tab_id": 11,
                    "control_policy": "target",
                    "kind": "unchanged",
                    "history_complete": true,
                    "previous_context_id": ctx_base,
                    "context_id": ctx_base,
                    "observation_id": obs_base,
                    "changes": [],
                    "state": {
                        "mode": "ready",
                        "revision": 1,
                        "url": "https://shop.test/checkout",
                        "title": "Checkout"
                    }
                })),
                // Stage 3: slim text-patched `delta` updating line 3 `"Pay $10"` -> `"Pay $25"` (NO `observation` on wire!)
                3 => ResponseBody::Ok(json!({
                    "tab_id": 11,
                    "control_policy": "target",
                    "kind": "delta",
                    "history_complete": true,
                    "previous_context_id": ctx_base,
                    "previous_observation_id": obs_base,
                    "context_id": ctx_delta,
                    "observation_id": obs_delta,
                    "changes": [{
                        "kind": "text",
                        "previous_value": "Pay $10",
                        "value": "Pay $25",
                        "lines": [3]
                    }],
                    "observation_patch": {
                        "lines": [{
                            "line": 3,
                            "previous": "@e2 button \"Pay $10\"",
                            "text": "@e2 button \"Pay $25\""
                        }]
                    },
                    "state": {
                        "mode": "ready",
                        "revision": 2,
                        "url": "https://shop.test/checkout",
                        "title": "Checkout"
                    }
                })),
                // Stage 4: slim `unchanged` after `ctx_delta` (post-step sync for `--baseline saved-delta-sync.json`)
                4 => ResponseBody::Ok(json!({
                    "tab_id": 11,
                    "control_policy": "target",
                    "kind": "unchanged",
                    "history_complete": true,
                    "previous_context_id": ctx_delta,
                    "context_id": ctx_delta,
                    "observation_id": obs_delta,
                    "changes": [],
                    "state": {
                        "mode": "ready",
                        "revision": 2,
                        "url": "https://shop.test/checkout",
                        "title": "Checkout"
                    }
                })),
                // Stage 5: slim text-patched `delta` updating line 3 `"Pay $25"` -> `"Pay $30"` (for `--wait-for`)
                5 => ResponseBody::Ok(json!({
                    "tab_id": 11,
                    "control_policy": "target",
                    "kind": "delta",
                    "history_complete": true,
                    "previous_context_id": ctx_delta,
                    "previous_observation_id": obs_delta,
                    "context_id": ctx_delta_2,
                    "observation_id": obs_delta_2,
                    "changes": [{
                        "kind": "text",
                        "previous_value": "Pay $25",
                        "value": "Pay $30",
                        "lines": [3]
                    }],
                    "observation_patch": {
                        "lines": [{
                            "line": 3,
                            "previous": "@e2 button \"Pay $25\"",
                            "text": "@e2 button \"Pay $30\""
                        }]
                    },
                    "state": {
                        "mode": "ready",
                        "revision": 3,
                        "url": "https://shop.test/checkout",
                        "title": "Checkout"
                    }
                })),
                // Stage 6 & 7: slim `unchanged` after `ctx_delta_2` (for MCP `bsk_session(open)` & `bsk_session(sync)`)
                6 | 7 => ResponseBody::Ok(json!({
                    "tab_id": 11,
                    "control_policy": "target",
                    "kind": "unchanged",
                    "history_complete": true,
                    "previous_context_id": ctx_delta_2,
                    "context_id": ctx_delta_2,
                    "observation_id": obs_delta_2,
                    "changes": [],
                    "state": {
                        "mode": "ready",
                        "revision": 3,
                        "url": "https://shop.test/checkout",
                        "title": "Checkout"
                    }
                })),
                // Stage 8+: baseline for `plan` / `bsk_plan` (`ctx_plan`)
                _ => ResponseBody::Ok(json!({
                    "tab_id": 11,
                    "control_policy": "target",
                    "kind": "baseline",
                    "history_complete": true,
                    "context_id": ctx_plan,
                    "observation_id": obs_plan,
                    "changes": [],
                    "observation": {
                        "observation_id": obs_plan,
                        "tab_id": 11,
                        "url": "https://shop.test/checkout",
                        "title": "Checkout",
                        "text": "heading \"Checkout\"\n@e1 textbox \"Password\" [filled] =\"•••\"\n@e2 button \"Pay $30\"",
                        "ref_count": 2,
                        "truncated": false
                    },
                    "state": { "mode": "ready", "revision": 4 }
                })),
            }
        }
        Method::ToolFill | Method::ToolClick | Method::ToolHover => {
            let p = req.params.as_ref().unwrap();
            let tab_id = p.get("tab_id").and_then(Value::as_i64);
            if let Some(ctx) = p.get("context_id").and_then(Value::as_str) {
                plan_seen_ext.lock().unwrap().push((
                    req.method.wire_name().to_owned(),
                    tab_id,
                    ctx.to_owned(),
                ));
            }
            if req.method == Method::ToolFill {
                ResponseBody::Ok(json!({
                    "tab_id": tab_id.unwrap_or(11),
                    "value_length": 13
                }))
            } else {
                ResponseBody::Ok(json!({
                    "tab_id": tab_id.unwrap_or(11),
                    "x": 10.0,
                    "y": 10.0
                }))
            }
        }
        other => panic!("unexpected method in cache test: {other:?}"),
    })
    .await;

    let scope = [("BSK_SCOPE", "cache-agent")];

    // 1. `bsk open` (Stage 0 baseline) + `bsk sync --json` (Stage 1 slim `unchanged`).
    let open_out = env
        .run_bsk(&["open", "https://shop.test/checkout", "--json"], &scope)
        .await;
    assert!(open_out.status.success());
    let sid = serde_json::from_slice::<Value>(&open_out.stdout).unwrap()["session_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let sync_out = env.run_bsk(&["sync", "--json"], &scope).await;
    assert!(sync_out.status.success());
    let sync_json: Value = serde_json::from_slice(&sync_out.stdout).unwrap();
    assert!(
        sync_json["vom"].as_str().unwrap().contains("Pay $10"),
        "bsk sync --json must hydrate vom on unchanged: {sync_json}"
    );
    assert_eq!(sync_json["observation_origin"]["kind"], "reused");

    let saved_sync_path = env.home.path().join("saved-sync.json");
    std::fs::write(&saved_sync_path, &sync_out.stdout).unwrap();

    // `bsk view <saved-sync.json> --find "Pay $10" --json` succeeds with ZERO browser calls!
    env.take_requests();
    let view_out = env
        .run_bsk(
            &[
                "view",
                saved_sync_path.to_str().unwrap(),
                "--find",
                "Pay $10",
                "--json",
            ],
            &scope,
        )
        .await;
    assert!(
        view_out.status.success(),
        "bsk view failed on bsk sync --json output: {}",
        String::from_utf8_lossy(&view_out.stderr)
    );
    let view_json: Value = serde_json::from_slice(&view_out.stdout).unwrap();
    assert_eq!(view_json["historical"], true);
    assert_eq!(view_json["observation_id"], obs_base);
    assert_eq!(view_json["matching_lines"], json!([3]));
    assert!(env.take_requests().is_empty());

    // `bsk step ... --baseline <saved-sync.json> --json` (Stage 2 post-sync `unchanged`) reuses `saved-sync.json`!
    let step_out = env
        .run_bsk(
            &[
                "step",
                "--session",
                &sid,
                "--context",
                ctx_base,
                "--action",
                "hover",
                "--params",
                r#"{"ref":"@e2"}"#,
                "--baseline",
                saved_sync_path.to_str().unwrap(),
                "--json",
            ],
            &scope,
        )
        .await;
    assert!(
        step_out.status.success(),
        "step with sync --json baseline failed: {}",
        String::from_utf8_lossy(&step_out.stderr)
    );
    let step_json: Value = serde_json::from_slice(&step_out.stdout).unwrap();
    assert_eq!(step_json["post"]["observation_origin"]["kind"], "reused");

    // 2a. Stage 3: plain `bsk sync --json` (WITHOUT `--match-text` or `--wait-for`) on slim text-patched `delta`!
    //     Must hydrate `vom`, `observation`, and `observation_origin.kind == "merged"` so `bsk view` and
    //     `bsk step --baseline` work directly on saved text-delta `bsk sync --json` files!
    let delta_sync_out = env.run_bsk(&["sync", "--json"], &scope).await;
    assert!(delta_sync_out.status.success());
    let delta_sync_json: Value = serde_json::from_slice(&delta_sync_out.stdout).unwrap();
    assert!(
        delta_sync_json["vom"]
            .as_str()
            .unwrap_or("")
            .contains("Pay $25"),
        "bsk sync --json must hydrate vom on reusable text delta: {delta_sync_json}"
    );
    assert_eq!(delta_sync_json["observation_origin"]["kind"], "merged");
    let saved_delta_path = env.home.path().join("saved-delta-sync.json");
    std::fs::write(&saved_delta_path, &delta_sync_out.stdout).unwrap();

    env.take_requests();
    let view_delta_out = env
        .run_bsk(
            &[
                "view",
                saved_delta_path.to_str().unwrap(),
                "--find",
                "Pay $25",
                "--json",
            ],
            &scope,
        )
        .await;
    assert!(
        view_delta_out.status.success(),
        "bsk view failed on text-delta bsk sync --json output: {}",
        String::from_utf8_lossy(&view_delta_out.stderr)
    );
    let view_delta_json: Value = serde_json::from_slice(&view_delta_out.stdout).unwrap();
    assert_eq!(view_delta_json["observation_id"], obs_delta);
    assert_eq!(view_delta_json["matching_lines"], json!([3]));
    assert!(env.take_requests().is_empty());

    let step_delta_out = env
        .run_bsk(
            &[
                "step",
                "--session",
                &sid,
                "--context",
                ctx_delta,
                "--action",
                "hover",
                "--params",
                r#"{"ref":"@e2"}"#,
                "--baseline",
                saved_delta_path.to_str().unwrap(),
                "--json",
            ],
            &scope,
        )
        .await;
    assert!(
        step_delta_out.status.success(),
        "step with text-delta sync --json baseline failed: {}",
        String::from_utf8_lossy(&step_delta_out.stderr)
    );
    let step_delta_json: Value = serde_json::from_slice(&step_delta_out.stdout).unwrap();
    assert_eq!(
        step_delta_json["post"]["observation_origin"]["kind"],
        "reused"
    );

    // 2b. Stage 5: `bsk sync --wait-for "Pay $30" --match-text "Pay $30" --json` on slim text-patched `delta`!
    //     Must hydrate from `scope_meta.cached_vom` with ZERO `tool.snapshot` fallback calls!
    let wait_delta_out = env
        .run_bsk(
            &[
                "sync",
                "--wait-for",
                "Pay $30",
                "--match-text",
                "Pay $30",
                "--json",
            ],
            &scope,
        )
        .await;
    assert!(
        wait_delta_out.status.success(),
        "sync --wait-for on slim delta failed: {}",
        String::from_utf8_lossy(&wait_delta_out.stderr)
    );
    assert_eq!(
        snapshot_calls.load(Ordering::SeqCst),
        0,
        "authoritative_full_vom must reuse patched delta without ToolSnapshot fallback!"
    );
    let wait_delta_json: Value = serde_json::from_slice(&wait_delta_out.stdout).unwrap();
    assert!(wait_delta_json["vom"].as_str().unwrap().contains("Pay $30"));

    // Verify `RunLogs` hydrated the slim `delta` AND keeps multi-tab `sensitive` masking isolated:
    // - Sync Tab 22 (`@e1 textbox "Public Note"`, NOT sensitive),
    // - Fill `@e1` on Tab 11 (`"top-secret-pw"`, MUST be redacted `[REDACTED]`),
    // - Fill `@e1` on Tab 22 (`"hello-public"`, MUST NOT be redacted),
    // - Click `@e2` on Tab 11 (MUST log target name `"Pay $30"` from the hydrated delta, NOT `"Pay $10"`!).
    let mut ipc = IpcClient::connect(&env.sock).await.unwrap();
    ipc.call_envelope::<_, Value>(
        "tab22-sync",
        Method::ToolCooperate,
        Some(json!({ "session_id": sid, "tab_id": 22, "action": "sync" })),
        IpcRequestMeta {
            caller_scope: Some("cache-agent".into()),
            return_scope_meta: true,
            ..Default::default()
        },
        Duration::from_secs(5),
    )
    .await
    .unwrap()
    .0
    .unwrap();

    assert!(
        env.run_bsk(
            &[
                "fill",
                "@e1",
                "--value",
                "top-secret-pw",
                "--tab-id",
                "11",
                "--context",
                ctx_delta_2,
                "--json"
            ],
            &scope
        )
        .await
        .status
        .success()
    );
    assert!(
        env.run_bsk(
            &[
                "fill",
                "@e1",
                "--value",
                "hello-public",
                "--tab-id",
                "22",
                "--context",
                ctx_tab2,
                "--json"
            ],
            &scope
        )
        .await
        .status
        .success()
    );
    assert!(
        env.run_bsk(
            &[
                "click",
                "@e2",
                "--tab-id",
                "11",
                "--context",
                ctx_delta_2,
                "--json"
            ],
            &scope
        )
        .await
        .status
        .success()
    );

    let logs_val = ipc
        .call::<_, Value>(
            "session-run-log",
            Method::SessionRunLog,
            Some(json!({ "session_id": sid })),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("SessionRunLog");
    let steps = logs_val["steps"].as_array().expect("run_log steps");
    let pw_step = steps
        .iter()
        .find(|s| s["target"]["name"] == "Password")
        .expect("Tab 11 Password fill step");
    assert_eq!(
        pw_step["sensitive"], true,
        "Tab 11 masked @e1 must stay sensitive=true even after Tab 22 sync: {logs_val}"
    );
    let note_step = steps
        .iter()
        .find(|s| s["target"]["name"] == "Public Note")
        .expect("Tab 22 Public Note fill step");
    assert_eq!(
        note_step["sensitive"], false,
        "Tab 22 non-sensitive @e1 must stay sensitive=false: {logs_val}"
    );
    assert!(
        steps
            .iter()
            .any(|s| s["action"] == "click" && s["target"]["name"] == "Pay $30"),
        "RunLogs missed slim delta hydration for @e2: {logs_val}"
    );

    // 3. MCP `bsk_session(open)` (reusing `sid` via `BSK_SCOPE=cache-agent`, Stage 6 slim `unchanged`)
    //    and `bsk_session(sync, wait_for="Pay $30")` (Stage 7 slim `unchanged`) both emit full VOM!
    let mut mcp = McpProcess::spawn(env.home.path(), &scope).await;
    let m_open = mcp
        .call_tool(
            "bsk_session",
            json!({ "action": "open", "url": "https://shop.test/checkout" }),
        )
        .await;
    assert_ne!(m_open["isError"], true, "mcp open failed: {m_open}");
    assert!(
        m_open["content"][1]["text"]
            .as_str()
            .unwrap_or("")
            .contains("Pay $30"),
        "MCP bsk_session(open) dropped cached_vom on unchanged sync: {m_open}"
    );

    let m_sync = mcp
        .call_tool(
            "bsk_session",
            json!({ "action": "sync", "tab_id": 11, "wait_for": "Pay $30" }),
        )
        .await;
    assert_ne!(
        m_sync["isError"], true,
        "mcp sync wait_for failed: {m_sync}"
    );
    assert!(
        m_sync["content"][1]["text"]
            .as_str()
            .unwrap_or("")
            .contains("Pay $30"),
        "MCP bsk_session(sync) dropped cached_vom: {m_sync}"
    );
    assert_eq!(snapshot_calls.load(Ordering::SeqCst), 0);

    // 4. Cold-start CLI `bsk plan` and MCP `bsk_plan` WITHOUT `--context`:
    //    First sync Tab 11 to `ctx_plan` (Stage 6), then sync Tab 22 so `active_tab_id` would have been 22
    //    unless we target Tab 11 via `--tab-id 11`; run `bsk plan --tab-id 11` WITHOUT `--context` and
    //    prove BOTH steps in the batch receive the exact resolved `session_id`, `tab_id: 11`, and `ctx_plan`!
    env.run_bsk(&["sync", "--tab-id", "11", "--json"], &scope)
        .await;
    plan_seen_contexts.lock().unwrap().clear();

    let plan_out = env
        .run_bsk(
            &[
                "plan",
                "--tab-id",
                "11",
                "--steps",
                r#"[{"action":"hover","ref":"@e2"},{"action":"click","ref":"@e2"}]"#,
                "--json",
            ],
            &scope,
        )
        .await;
    assert!(
        plan_out.status.success(),
        "cold-start bsk plan without --context failed: {}",
        String::from_utf8_lossy(&plan_out.stderr)
    );
    let seen_cli = std::mem::take(&mut *plan_seen_contexts.lock().unwrap());
    assert_eq!(
        seen_cli,
        vec![
            ("tool.hover".into(), Some(11), ctx_plan.into()),
            ("tool.click".into(), Some(11), ctx_plan.into()),
        ]
    );

    let m_plan = mcp
        .call_tool(
            "bsk_plan",
            json!({
                "tab_id": 11,
                "steps": [
                    { "action": "hover", "ref": "@e2" },
                    { "action": "click", "ref": "@e2" }
                ]
            }),
        )
        .await;
    assert_ne!(
        m_plan["isError"], true,
        "cold-start bsk_plan failed: {m_plan}"
    );
    let seen_mcp = std::mem::take(&mut *plan_seen_contexts.lock().unwrap());
    assert_eq!(
        seen_mcp,
        vec![
            ("tool.hover".into(), Some(11), ctx_plan.into()),
            ("tool.click".into(), Some(11), ctx_plan.into()),
        ]
    );

    drop(mcp);
    env.shutdown().await;
}
