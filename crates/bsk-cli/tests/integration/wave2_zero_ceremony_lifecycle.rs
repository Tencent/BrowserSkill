//! Wave 2 integration & regression gates:
//! - Zero-ceremony lifecycle (`bsk open`, `bsk sync`, `bsk close`)
//! - Daemon in-memory `ImplicitScopeRegistry` (`caller_scope` priority, `c1`/`o1` short tokens, `last_vom` hydration)
//! - Anti-silent-hijack guard & multi-agent / multi-MCP concurrency isolation
//! - 100% backward compatibility with `bsk session start` / `bsk cooperate sync --session <id>`
//! - `SKILL.md` <= 2,000-byte budget and all 4 `RT-05` safety invariants
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bsk::daemon::info::DaemonInfo;
use bsk::daemon::{self, DaemonConfig};
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::{SessionStartParams, SessionStartResult};
use bsk_protocol::{BrowserPeerInfo, Frame, Method, RequestFrame, ResponseBody, ResponseFrame};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

const TEST_EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct IsolatedEnv {
    home: tempfile::TempDir,
    handle: daemon::DaemonHandle,
    ext_requests: Arc<Mutex<Vec<RequestFrame>>>,
}

impl IsolatedEnv {
    async fn start<F>(reply: F) -> Self
    where
        F: Fn(&RequestFrame) -> ResponseBody + Send + Sync + 'static,
    {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let sock = home.path().join("ipc.sock");
        let handle = daemon::run(
            DaemonConfig::new(0)
                .with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal),
            Some(sock.clone()),
        )
        .await
        .unwrap();
        let ws_addr = handle.ws_addr();
        let info = DaemonInfo::now(
            std::process::id(),
            sock,
            ws_addr.port(),
            bsk::daemon::state::DAEMON_VERSION,
        );
        std::fs::write(
            home.path().join("daemon.json"),
            serde_json::to_vec(&info).unwrap(),
        )
        .unwrap();

        let mut ws = connect_ext(ws_addr).await;
        do_handshake(&mut ws).await;

        let ext_requests = Arc::new(Mutex::new(Vec::new()));
        spawn_mock_extension(ws, Arc::clone(&ext_requests), reply);

        Self {
            home,
            handle,
            ext_requests,
        }
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

async fn do_handshake(ws: &mut Ws) -> HandshakeResult {
    let params = HandshakeParams {
        client: bsk_protocol::EXTENSION_CLIENT_ID.into(),
        version: "0.1.0-dev.0".parse().unwrap(),
        protocol_version: bsk::daemon::state::PROTOCOL_VERSION.into(),
        instance_id: TEST_EXT_ID.into(),
        browser: BrowserPeerInfo {
            name: "chrome".into(),
            version: "131.0".into(),
        },
        min_compatible_peer: Some("0.1.0-dev.0".parse().unwrap()),
        min_compatible_protocol: Some(bsk::daemon::state::MIN_COMPATIBLE_PROTOCOL.into()),
        label: "MockChrome".into(),
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
    let mut next_window_id: i64 = 100;
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

#[tokio::test]
async fn open_click_fill_sync_unchanged_and_close_roundtrip() {
    let sync_seq = Arc::new(Mutex::new(0u32));
    let sync_seq_ext = Arc::clone(&sync_seq);

    let ctx_uuid_1 = "11111111-1111-4111-8111-111111111111";
    let obs_uuid_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let ctx_uuid_2 = "22222222-2222-4222-8222-222222222222";
    let obs_uuid_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    let env = IsolatedEnv::start(move |req| match &req.method {
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 7,
            "url": "https://app.test/login",
            "final_url": "https://app.test/login",
            "reached": "load"
        })),
        Method::ToolCooperate => {
            let mut count = sync_seq_ext.lock().unwrap();
            *count += 1;
            if *count == 1 {
                ResponseBody::Ok(json!({
                    "tab_id": 7,
                    "control_policy": "target",
                    "context_id": ctx_uuid_1,
                    "observation_id": obs_uuid_1,
                    "observation": {
                        "observation_id": obs_uuid_1,
                        "tab_id": 7,
                        "url": "https://app.test/login",
                        "title": "Login",
                        "text": "@e1 textbox \"Email\"\n@e2 button \"Sign in\"",
                        "ref_count": 2,
                        "truncated": false
                    },
                    "state": { "mode": "ready", "revision": 1 }
                }))
            } else {
                // Simulate extension `unchanged` reply omitting full VOM body.
                ResponseBody::Ok(json!({
                    "tab_id": 7,
                    "control_policy": "target",
                    "context_id": ctx_uuid_2,
                    "observation_id": obs_uuid_2,
                    "kind": "unchanged",
                    "state": { "mode": "ready", "revision": 1 }
                }))
            }
        }
        Method::ToolFill => {
            ResponseBody::Ok(json!({ "tab_id": 7, "used_ref": "@e1", "value_length": 13 }))
        }
        Method::ToolClick => ResponseBody::Ok(json!({ "tab_id": 7, "x": 12.0, "y": 24.0 })),
        Method::ToolWheel => ResponseBody::Ok(
            json!({ "tab_id": 7, "x": 100.0, "y": 100.0, "delta_x": 0.0, "delta_y": 400.0 }),
        ),
        other => panic!("unexpected extension method: {other:?}"),
    })
    .await;

    // 1. `bsk open <url>` auto-starts background session + navigates + settled syncs -> deterministic output.
    let open_out = env.run_bsk(&["open", "https://app.test/login"], &[]).await;
    assert!(
        open_out.status.success(),
        "open failed: stdout={} stderr={}",
        String::from_utf8_lossy(&open_out.stdout),
        String::from_utf8_lossy(&open_out.stderr)
    );
    let open_stdout = String::from_utf8(open_out.stdout).unwrap();
    let mut lines = open_stdout.lines();
    let header = lines.next().expect("state header");
    assert!(header.starts_with("[state session="), "header={header}");
    assert!(header.contains(" tab=7 ctx=c1 url=\"https://app.test/login\" title=\"Login\"]"));
    let sid = header
        .strip_prefix("[state session=")
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_string();
    assert_eq!(sid.len(), 4);
    let vom_body: Vec<&str> = lines.collect();
    assert_eq!(
        vom_body,
        vec!["@e1 textbox \"Email\"", "@e2 button \"Sign in\""]
    );

    let reqs = env.take_requests();
    assert_eq!(reqs.len(), 3);
    assert_eq!(reqs[0].method, Method::ToolSessionStart);
    assert_eq!(
        reqs[0].params.as_ref().unwrap().get("focused"),
        Some(&json!(false))
    );
    assert_eq!(reqs[1].method, Method::ToolNavigate);
    assert_eq!(reqs[2].method, Method::ToolCooperate);

    // 2. `bsk fill @e1 --value ...` WITHOUT `--session` and WITHOUT `--context` injects real session_id + 36-char UUID!
    let fill_out = env
        .run_bsk(&["fill", "@e1", "--value", "user@app.test"], &[])
        .await;
    assert!(
        fill_out.status.success(),
        "fill failed: {}",
        String::from_utf8_lossy(&fill_out.stderr)
    );
    let reqs = env.take_requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].method, Method::ToolFill);
    let fill_params = reqs[0].params.as_ref().unwrap();
    assert_eq!(fill_params["session_id"], sid);
    assert_eq!(fill_params["context_id"], ctx_uuid_1);
    assert_eq!(ctx_uuid_1.len(), 36);

    // 3. `bsk click @e2 --context c1` expands short alias `c1` -> 36-char UUID `context_id`!
    let click_out = env.run_bsk(&["click", "@e2", "--context", "c1"], &[]).await;
    assert!(
        click_out.status.success(),
        "click failed: {}",
        String::from_utf8_lossy(&click_out.stderr)
    );
    let reqs = env.take_requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].method, Method::ToolClick);
    let click_params = reqs[0].params.as_ref().unwrap();
    assert_eq!(click_params["session_id"], sid);
    assert_eq!(click_params["context_id"], ctx_uuid_1);

    // 4. Short `--observation o1` expands to real `observation_id`, while omitted `--observation` is NEVER fabricated!
    let wheel_with_obs = env
        .run_bsk(&["wheel", "--delta-y", "400", "--observation", "o1"], &[])
        .await;
    assert!(wheel_with_obs.status.success());
    let reqs = env.take_requests();
    assert_eq!(
        reqs[0].params.as_ref().unwrap()["observation_id"],
        obs_uuid_1
    );

    let wheel_without_obs = env.run_bsk(&["wheel", "--delta-y", "400"], &[]).await;
    assert!(wheel_without_obs.status.success());
    let reqs = env.take_requests();
    assert!(
        reqs[0]
            .params
            .as_ref()
            .unwrap()
            .get("observation_id")
            .is_none(),
        "must never fabricate omitted observation_id"
    );

    // 5. `bsk sync` on `unchanged` hydrates cached `last_vom` and marks `unchanged=true` with `ctx=c2`.
    let sync_out = env.run_bsk(&["sync"], &[]).await;
    assert!(
        sync_out.status.success(),
        "sync failed: {}",
        String::from_utf8_lossy(&sync_out.stderr)
    );
    let sync_stdout = String::from_utf8(sync_out.stdout).unwrap();
    let expected_sync = format!(
        "[state session={sid} tab=7 ctx=c2 unchanged=true url=\"https://app.test/login\" title=\"Login\"]\n@e1 textbox \"Email\"\n@e2 button \"Sign in\"\n"
    );
    assert_eq!(sync_stdout, expected_sync);
    let _ = env.take_requests();

    // 6. `bsk close` stops session, clears scope slot, and leaves a clear `session_stopped` tombstone hint.
    let close_out = env.run_bsk(&["close"], &[]).await;
    assert!(close_out.status.success());
    assert_eq!(
        String::from_utf8(close_out.stdout).unwrap(),
        format!("[closed session={sid}]\n")
    );
    let reqs = env.take_requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].method, Method::ToolSessionStop);

    let post_close = env.run_bsk(&["click", "@e1"], &[]).await;
    assert!(!post_close.status.success());
    let stderr = String::from_utf8(post_close.stderr).unwrap();
    assert!(
        stderr.contains("bsk open"),
        "expected session_stopped repair hint mentioning 'bsk open', got: {stderr}"
    );

    env.shutdown().await;
}

#[tokio::test]
async fn multi_agent_scope_isolation_and_anti_silent_hijack_guard() {
    let ctx_counter = Arc::new(Mutex::new(0u32));
    let ctx_counter_ext = Arc::clone(&ctx_counter);
    let session_urls: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
    let session_urls_ext = Arc::clone(&session_urls);

    let env = IsolatedEnv::start(move |req| match &req.method {
        Method::ToolNavigate => {
            let p = req.params.as_ref().unwrap();
            let sid = p["session_id"].as_str().unwrap().to_string();
            let url = p["url"].as_str().unwrap().to_string();
            session_urls_ext.lock().unwrap().insert(sid, url.clone());
            ResponseBody::Ok(json!({
                "tab_id": 11,
                "url": url,
                "final_url": url,
                "reached": "load"
            }))
        }
        Method::ToolCooperate => {
            let p = req.params.as_ref().unwrap();
            let sid = p["session_id"].as_str().unwrap();
            let url = session_urls_ext
                .lock()
                .unwrap()
                .get(sid)
                .cloned()
                .unwrap_or_else(|| "https://legacy.test/".into());
            let mut n = ctx_counter_ext.lock().unwrap();
            *n += 1;
            let ctx = format!("{:08x}-0000-4000-8000-000000000000", *n);
            let obs = format!("{:08x}-1111-4111-8111-111111111111", *n);
            ResponseBody::Ok(json!({
                "tab_id": 11,
                "control_policy": "target",
                "context_id": ctx,
                "observation_id": obs,
                "observation": {
                    "observation_id": obs,
                    "tab_id": 11,
                    "url": url,
                    "title": "ScopedPage",
                    "text": format!("@e1 button \"Act on {url}\""),
                    "ref_count": 1,
                    "truncated": false
                },
                "state": { "mode": "ready", "revision": 1 }
            }))
        }
        Method::ToolClick => ResponseBody::Ok(json!({ "tab_id": 11, "x": 5, "y": 5 })),
        other => panic!("unexpected extension method: {other:?}"),
    })
    .await;

    // 1. Legacy `bsk session start --json` + `bsk cooperate sync --session <id>` works 100% unchanged.
    let start_legacy = env.run_bsk(&["session", "start", "--json"], &[]).await;
    assert!(start_legacy.status.success());
    let start_json: Value = serde_json::from_slice(&start_legacy.stdout).unwrap();
    let legacy_sid = start_json["session_id"].as_str().unwrap().to_string();

    let legacy_sync = env
        .run_bsk(
            &["cooperate", "sync", "--session", &legacy_sid, "--json"],
            &[],
        )
        .await;
    assert!(legacy_sync.status.success());
    let legacy_sync_json: Value = serde_json::from_slice(&legacy_sync.stdout).unwrap();
    assert_eq!(legacy_sync_json["control_policy"], "target");
    assert!(legacy_sync_json.get("guidance").is_none());
    let _ = env.take_requests();

    // 2. Anti-silent-hijack guard: unbound `"default"` scope MUST refuse to hijack `legacy_sid`!
    let hijack_attempt = env.run_bsk(&["click", "@e1"], &[]).await;
    assert!(!hijack_attempt.status.success());
    let hijack_stderr = String::from_utf8(hijack_attempt.stderr).unwrap();
    assert!(
        hijack_stderr.contains("--session") && hijack_stderr.contains("BSK_SCOPE"),
        "expected anti-hijack repair hint, got: {hijack_stderr}"
    );
    assert!(
        env.take_requests().is_empty(),
        "must not dispatch tool.click to extension on refused implicit hijack"
    );

    // 3. Two concurrent `BSK_SCOPE`s + one `CODEX_THREAD_ID` subagent scope isolate sessions & `c1` tokens!
    let open_a = env
        .run_bsk(
            &["open", "https://alpha.test", "--json"],
            &[("BSK_SCOPE", "agent-alpha")],
        )
        .await;
    let open_b = env
        .run_bsk(
            &["open", "https://beta.test", "--json"],
            &[("BSK_SCOPE", "agent-beta")],
        )
        .await;
    let open_sub = env
        .run_bsk(
            &["open", "https://subagent.test", "--json"],
            &[("CODEX_THREAD_ID", "thread-42")],
        )
        .await;
    assert!(open_a.status.success() && open_b.status.success() && open_sub.status.success());
    let ja: Value = serde_json::from_slice(&open_a.stdout).unwrap();
    let jb: Value = serde_json::from_slice(&open_b.stdout).unwrap();
    let jsub: Value = serde_json::from_slice(&open_sub.stdout).unwrap();

    let sid_a = ja["session_id"].as_str().unwrap();
    let sid_b = jb["session_id"].as_str().unwrap();
    let sid_sub = jsub["session_id"].as_str().unwrap();
    assert_ne!(sid_a, legacy_sid);
    assert_ne!(sid_a, sid_b);
    assert_ne!(sid_a, sid_sub);
    assert_ne!(sid_b, sid_sub);
    assert_eq!(ja["ctx"], "c1");
    assert_eq!(jb["ctx"], "c1");
    assert_ne!(ja["context_id"], jb["context_id"]);

    let _ = env.take_requests();

    // Implicit `click` in each scope routes strictly to that scope's session and `c1` UUID.
    assert!(
        env.run_bsk(
            &["click", "@e1", "--context", "c1"],
            &[("BSK_SCOPE", "agent-alpha")]
        )
        .await
        .status
        .success()
    );
    assert!(
        env.run_bsk(
            &["click", "@e1", "--context", "c1"],
            &[("BSK_SCOPE", "agent-beta")]
        )
        .await
        .status
        .success()
    );
    assert!(
        env.run_bsk(&["click", "@e1"], &[("CODEX_THREAD_ID", "thread-42")])
            .await
            .status
            .success()
    );
    let reqs = env.take_requests();
    assert_eq!(reqs.len(), 3);
    assert_eq!(reqs[0].params.as_ref().unwrap()["session_id"], sid_a);
    assert_eq!(
        reqs[0].params.as_ref().unwrap()["context_id"],
        ja["context_id"]
    );
    assert_eq!(reqs[1].params.as_ref().unwrap()["session_id"], sid_b);
    assert_eq!(
        reqs[1].params.as_ref().unwrap()["context_id"],
        jb["context_id"]
    );
    assert_eq!(reqs[2].params.as_ref().unwrap()["session_id"], sid_sub);
    assert_eq!(
        reqs[2].params.as_ref().unwrap()["context_id"],
        jsub["context_id"]
    );

    // Closing `agent-alpha` stops only `sid_a`; `agent-beta` and `legacy_sid` stay alive.
    assert!(
        env.run_bsk(&["close"], &[("BSK_SCOPE", "agent-alpha")])
            .await
            .status
            .success()
    );
    assert!(
        env.run_bsk(&["click", "@e1"], &[("BSK_SCOPE", "agent-beta")])
            .await
            .status
            .success()
    );
    assert!(
        env.run_bsk(&["session", "stop", &legacy_sid], &[])
            .await
            .status
            .success()
    );
    assert!(env.run_bsk(&["close", "--all"], &[]).await.status.success());

    env.shutdown().await;
}

#[tokio::test]
async fn mcp_stdio_connections_get_isolated_process_scopes() {
    let ctx_seq = Arc::new(Mutex::new(10u32));
    let ctx_seq_ext = Arc::clone(&ctx_seq);

    let env = IsolatedEnv::start(move |req| match &req.method {
        Method::ToolCooperate => {
            let mut n = ctx_seq_ext.lock().unwrap();
            *n += 1;
            let ctx = format!("{:08x}-aaaa-4aaa-8aaa-aaaaaaaaaaaa", *n);
            let obs = format!("{:08x}-bbbb-4bbb-8bbb-bbbbbbbbbbbb", *n);
            ResponseBody::Ok(json!({
                "tab_id": 9,
                "control_policy": "target",
                "context_id": ctx,
                "observation_id": obs,
                "observation": {
                    "observation_id": obs,
                    "tab_id": 9,
                    "url": "https://mcp.test/",
                    "title": "MCP",
                    "text": "@e1 button \"Go\"",
                    "ref_count": 1,
                    "truncated": false
                },
                "state": { "mode": "ready", "revision": 1 }
            }))
        }
        Method::ToolClick => ResponseBody::Ok(json!({ "tab_id": 9, "x": 1, "y": 2 })),
        other => panic!("unexpected extension method in MCP test: {other:?}"),
    })
    .await;

    async fn spawn_mcp(
        home: &Path,
    ) -> (
        tokio::process::Child,
        tokio::process::ChildStdin,
        BufReader<tokio::process::ChildStdout>,
    ) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_bsk"))
            .env("BSK_HOME", home)
            .env("BSK_AUTO_START", "0")
            .env("BSK_AUTO_UPDATE", "off")
            .env_remove("BSK_SESSION")
            .env_remove("BSK_SCOPE")
            .env_remove("CLAUDE_CODE_AGENT_ID")
            .env_remove("CODEX_THREAD_ID")
            .env_remove("ANTIGRAVITY_CONVERSATION_ID")
            .env_remove("CURSOR_TRACE_ID")
            .env_remove("DSH_SESSION_ID")
            .arg("mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        (child, stdin, stdout)
    }

    async fn mcp_call(
        stdin: &mut tokio::process::ChildStdin,
        stdout: &mut BufReader<tokio::process::ChildStdout>,
        req: Value,
    ) -> Value {
        let mut bytes = serde_json::to_vec(&req).unwrap();
        bytes.push(b'\n');
        stdin.write_all(&bytes).await.unwrap();
        stdin.flush().await.unwrap();
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), stdout.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        serde_json::from_str(&line).unwrap()
    }

    let (_c1, mut in1, mut out1) = spawn_mcp(env.home.path()).await;
    let (_c2, mut in2, mut out2) = spawn_mcp(env.home.path()).await;

    for (stdin, stdout) in [(&mut in1, &mut out1), (&mut in2, &mut out2)] {
        let init = mcp_call(
            stdin,
            stdout,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": { "name": "test", "version": "1.0" }
                }
            }),
        )
        .await;
        assert!(init.get("result").is_some(), "MCP init failed: {init}");
    }

    // Start + sync session on MCP #1 and MCP #2 without passing explicit `session` to sync/interact!
    let s1 = mcp_call(
        &mut in1,
        &mut out1,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "bsk_session",
                "arguments": {
                    "action": "start",
                    "agent_name": "DSH",
                    "project": "BrowserSkill",
                    "controller_color": "#2563eb"
                }
            }
        }),
    )
    .await;
    let s2 = mcp_call(
        &mut in2,
        &mut out2,
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": { "name": "bsk_session", "arguments": { "action": "start" } }
        }),
    )
    .await;
    let s1_payload: Value =
        serde_json::from_str(s1["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let s2_payload: Value =
        serde_json::from_str(s2["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_ne!(s1_payload["session_id"], s2_payload["session_id"]);
    let sid1 = s1_payload["session_id"].as_str().unwrap().to_string();
    let sid2 = s2_payload["session_id"].as_str().unwrap().to_string();

    for (stdin, stdout) in [(&mut in1, &mut out1), (&mut in2, &mut out2)] {
        let sync_res = mcp_call(
            stdin,
            stdout,
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": { "name": "bsk_session", "arguments": { "action": "sync" } }
            }),
        )
        .await;
        assert_ne!(sync_res["result"]["isError"], json!(true), "{sync_res}");
    }
    let startup_reqs = env.take_requests();
    assert!(
        startup_reqs.iter().any(|r| {
            r.method == bsk_protocol::Method::ToolSessionStart
                && r.params.as_ref().and_then(|p| p.get("controller"))
                    == Some(&json!({
                        "name": "DSH",
                        "project": "BrowserSkill",
                        "color": "#2563eb"
                    }))
        }),
        "expected tool.session_start to forward MCP controller identity, got {startup_reqs:?}"
    );

    // Call `bsk_interact` on both MCP connections omitting `session` AND omitting `context`!
    for (stdin, stdout) in [(&mut in1, &mut out1), (&mut in2, &mut out2)] {
        let act_res = mcp_call(
            stdin,
            stdout,
            json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "bsk_interact",
                    "arguments": { "action": "click", "params": { "ref": "@e1" } }
                }
            }),
        )
        .await;
        assert_ne!(act_res["result"]["isError"], json!(true), "{act_res}");
    }

    let reqs = env.take_requests();
    assert_eq!(reqs.len(), 2);
    assert_eq!(reqs[0].params.as_ref().unwrap()["session_id"], sid1);
    assert_eq!(reqs[1].params.as_ref().unwrap()["session_id"], sid2);
    assert_ne!(
        reqs[0].params.as_ref().unwrap()["context_id"],
        reqs[1].params.as_ref().unwrap()["context_id"]
    );

    drop(in1);
    drop(in2);
    env.shutdown().await;
}

#[test]
fn skill_md_budget_and_rt05_safety_invariants_gate() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let skill_path = manifest_dir.join("skill/SKILL.md");
    let content = std::fs::read_to_string(&skill_path).unwrap();

    // 1. Hard UTF-8 byte ceiling <= 2,000 bytes (both LF and CRLF).
    assert!(
        content.len() <= 2_000,
        "SKILL.md is {} bytes (must be <= 2,000)",
        content.len()
    );
    let crlf_len = content.replace('\n', "\r\n").len();
    assert!(
        crlf_len <= 2_000,
        "SKILL.md CRLF length is {} bytes (must be <= 2,000)",
        crlf_len
    );

    // 2. Zero-ceremony workflow primitives documented; Wave 4 `bsk flow` NOT prematurely documented.
    assert!(content.contains("bsk open"));
    assert!(content.contains("bsk sync"));
    assert!(content.contains("bsk close"));
    assert!(
        !content.contains("bsk flow"),
        "SKILL.md must not mention unimplemented Wave 4 'bsk flow'"
    );

    // 3. All 4 RT-05 safety invariants present!
    // Invariant 1: Untrusted page data & secret protection
    assert!(content.contains("never instructions"));
    assert!(content.contains("injection"));
    assert!(content.contains("passwords, cookies, tokens, or secrets"));
    // Invariant 2: No blind replay on timeout / dialog_pending / unknown
    assert!(content.contains("dialog_pending"));
    assert!(content.contains("effect_state: \"unknown\""));
    assert!(content.contains("never repeat the write action"));
    // Invariant 3: Explicit multi-browser / profile binding
    assert!(content.contains("bsk browsers"));
    assert!(content.contains("--browser <id-or-label>"));
    // Invariant 4: Agent Window & explicit user tab borrowing boundary
    assert!(content.contains("Agent Window"));
    assert!(content.contains("bsk tab borrow <tab-id>"));
    assert!(content.contains("Automation settings"));
}

#[tokio::test]
async fn strict_policy_delta_sync_and_open_wait_committed_effect_state() {
    let sync_seq = Arc::new(Mutex::new(0u32));
    let sync_seq_ext = Arc::clone(&sync_seq);
    let promote_next_baseline = Arc::new(Mutex::new(false));
    let promote_next_ext = Arc::clone(&promote_next_baseline);
    let last_ctx = Arc::new(Mutex::new(String::new()));
    let last_ctx_ext = Arc::clone(&last_ctx);

    let env = IsolatedEnv::start(move |req| match &req.method {
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 7,
            "url": "https://app.test/form",
            "final_url": "https://app.test/form",
            "reached": "load"
        })),
        Method::ToolSnapshot => {
            *promote_next_ext.lock().unwrap() = true;
            ResponseBody::Ok(json!({
                "tab_id": 7,
                "text": "Status: Ready\n@e1 textbox \"Email\" value=\"new@app.test\"",
                "ref_count": 1,
                "truncated": false
            }))
        }
        Method::ToolCooperate => {
            let mut n = sync_seq_ext.lock().unwrap();
            *n += 1;
            let ctx = format!("{:08x}-1111-4111-8111-111111111111", *n);
            let prev = last_ctx_ext.lock().unwrap().clone();
            *last_ctx_ext.lock().unwrap() = ctx.clone();

            let mut promoted = promote_next_ext.lock().unwrap();
            if *promoted {
                *promoted = false;
                return ResponseBody::Ok(json!({
                    "tab_id": 7,
                    "control_policy": "strict",
                    "context_id": ctx,
                    "kind": "baseline",
                    "observation": {
                        "tab_id": 7,
                        "url": "https://app.test/form",
                        "title": "Form",
                        "text": "Status: Ready\n@e1 textbox \"Email\" value=\"new@app.test\"",
                        "ref_count": 1,
                        "truncated": false
                    },
                    "state": { "mode": "ready", "revision": 2 }
                }));
            }
            drop(promoted);

            match *n {
                1 => ResponseBody::Ok(json!({
                    "tab_id": 7,
                    "control_policy": "strict",
                    "context_id": ctx,
                    "kind": "baseline",
                    "observation": {
                        "tab_id": 7,
                        "url": "https://app.test/form",
                        "title": "Form",
                        "text": "Status: Ready\n@e1 textbox \"Email\" value=\"old@app.test\"",
                        "ref_count": 1,
                        "truncated": false
                    },
                    "state": { "mode": "ready", "revision": 1 }
                })),
                2 => ResponseBody::Ok(json!({
                    "tab_id": 7,
                    "control_policy": "strict",
                    "context_id": ctx,
                    "previous_context_id": prev,
                    "kind": "delta",
                    "history_complete": true,
                    "changes": [{
                        "frame_id": 0,
                        "label": "Email",
                        "previous_value": "old@app.test",
                        "value": "new@app.test"
                    }],
                    "activity": [{ "sequence": 1, "type": "input", "label": "Email" }],
                    "state": { "mode": "ready", "revision": 2 }
                })),
                _ => ResponseBody::Ok(json!({
                    "tab_id": 7,
                    "control_policy": "strict",
                    "context_id": ctx,
                    "previous_context_id": prev,
                    "kind": "unchanged",
                    "history_complete": true,
                    "changes": [],
                    "state": { "mode": "ready", "revision": 2 }
                })),
            }
        }
        other => panic!("unexpected extension method: {other:?}"),
    })
    .await;

    // 1. `bsk open` establishes baseline VOM (`old@app.test`).
    let open_out = env.run_bsk(&["open", "https://app.test/form"], &[]).await;
    assert!(open_out.status.success());
    let _ = env.take_requests();

    // 2. Slim `bsk sync --policy strict` (without wait conditions) receives `kind: "delta"`:
    //    emits `delta=true` + `[change ...]`, makes ZERO `tool.snapshot` calls,
    //    and NEVER prints stale `old@app.test` VOM!
    let delta_out = env.run_bsk(&["sync", "--policy", "strict"], &[]).await;
    assert!(delta_out.status.success());
    let delta_stdout = String::from_utf8(delta_out.stdout).unwrap();
    assert!(delta_stdout.contains(" delta=true "), "got: {delta_stdout}");
    assert!(
        delta_stdout
            .contains("[change label=\"Email\" previous=\"old@app.test\" value=\"new@app.test\"]"),
        "got: {delta_stdout}"
    );
    assert!(
        !delta_stdout.contains("@e1 textbox \"Email\" value=\"old@app.test\""),
        "must not print stale pre-delta VOM: {delta_stdout}"
    );
    let delta_reqs = env.take_requests();
    assert_eq!(delta_reqs.len(), 1);
    assert_eq!(delta_reqs[0].method, Method::ToolCooperate);

    // 3. Follow-up `unchanged` after `delta` (without wait conditions) must NOT resurrect stale pre-delta VOM!
    let post_delta = env
        .run_bsk(&["sync", "--policy", "strict", "--json"], &[])
        .await;
    assert!(post_delta.status.success());
    let post_json: Value = serde_json::from_slice(&post_delta.stdout).unwrap();
    assert_eq!(post_json["unchanged"], true);
    assert_eq!(post_json["vom"], "");
    let post_delta_reqs = env.take_requests();
    assert_eq!(post_delta_reqs.len(), 1);
    assert_eq!(post_delta_reqs[0].method, Method::ToolCooperate);

    // 4. `bsk sync --policy strict --wait-for "Status: Ready"` on uncached `unchanged` promotes
    //    to full baseline via `tool.snapshot` + `tool.cooperate(sync)` and matches static VOM text!
    let promoted_wait = env
        .run_bsk(
            &[
                "sync",
                "--policy",
                "strict",
                "--wait-for",
                "Status: Ready",
                "--wait-not",
                "Loading...",
                "--timeout-ms",
                "1000",
            ],
            &[],
        )
        .await;
    assert!(promoted_wait.status.success());
    let promoted_stdout = String::from_utf8(promoted_wait.stdout).unwrap();
    assert!(
        promoted_stdout.contains("Status: Ready\n@e1 textbox \"Email\" value=\"new@app.test\""),
        "got: {promoted_stdout}"
    );
    let promoted_reqs: Vec<Method> = env.take_requests().into_iter().map(|r| r.method).collect();
    assert_eq!(
        promoted_reqs,
        vec![
            Method::ToolCooperate,
            Method::ToolSnapshot,
            Method::ToolCooperate,
        ]
    );

    // 5. `bsk open --wait-for` timeout after navigation must report `effect_state: "committed"`,
    //    whereas `bsk sync --wait-for` timeout reports `effect_state: "none"`.
    let open_timeout = env
        .run_bsk(
            &[
                "open",
                "https://app.test/form",
                "--wait-for",
                "NEVER_APPEARS",
                "--timeout-ms",
                "50",
                "--json",
            ],
            &[],
        )
        .await;
    assert!(!open_timeout.status.success());
    let open_err: Value = serde_json::from_slice(&open_timeout.stdout).unwrap();
    assert_eq!(open_err["data"]["effect_state"], "committed");

    let sync_timeout = env
        .run_bsk(
            &[
                "sync",
                "--policy",
                "strict",
                "--wait-for",
                "NEVER_APPEARS",
                "--timeout-ms",
                "50",
                "--json",
            ],
            &[],
        )
        .await;
    assert!(!sync_timeout.status.success());
    let sync_err: Value = serde_json::from_slice(&sync_timeout.stdout).unwrap();
    assert_eq!(sync_err["data"]["effect_state"], "none");

    env.shutdown().await;
}

#[tokio::test]
async fn concurrent_open_in_same_scope_serializes_and_tab_create_isolates_implicit_context() {
    let env = IsolatedEnv::start(move |req| match &req.method {
        Method::ToolNavigate => ResponseBody::Ok(json!({
            "tab_id": 7,
            "url": "https://app.test/one",
            "final_url": "https://app.test/one",
            "reached": "load"
        })),
        Method::ToolCooperate => ResponseBody::Ok(json!({
            "tab_id": 7,
            "control_policy": "target",
            "context_id": "aaaaaaaa-1111-4111-8111-111111111111",
            "observation_id": "bbbbbbbb-1111-4111-8111-111111111111",
            "observation": {
                "tab_id": 7,
                "url": "https://app.test/one",
                "title": "One",
                "text": "@e1 button \"First\"",
                "ref_count": 1,
                "truncated": false
            },
            "state": { "mode": "ready", "revision": 1 }
        })),
        Method::ToolTabCreate => ResponseBody::Ok(json!({
            "tab_id": 8,
            "window_id": 100,
            "url": "https://app.test/two"
        })),
        Method::ToolClick => ResponseBody::Ok(json!({ "tab_id": 8, "x": 10.0, "y": 10.0 })),
        other => panic!("unexpected extension method: {other:?}"),
    })
    .await;

    // 1. Two concurrent `bsk open` invocations in the SAME unbound `BSK_SCOPE` must start only ONE session
    //    (never leaking an orphaned second Agent Window); if their `tool.navigate` calls overlap on that
    //    single shared session, the loser receives `session_busy` rather than creating a second session.
    let (res1, res2) = tokio::join!(
        env.run_bsk(
            &["open", "https://app.test/one", "--json"],
            &[("BSK_SCOPE", "shared-worker")]
        ),
        env.run_bsk(
            &["open", "https://app.test/one", "--json"],
            &[("BSK_SCOPE", "shared-worker")]
        ),
    );
    assert!(
        res1.status.success() || res2.status.success(),
        "at least one concurrent bsk open must succeed"
    );
    for res in [&res1, &res2] {
        let j: Value = serde_json::from_slice(&res.stdout).unwrap();
        if res.status.success() {
            assert_eq!(j["ctx"], "c1");
        } else {
            assert_eq!(
                j["data"]["reason"], "session_busy",
                "unexpected failure: {j}"
            );
        }
    }

    let start_calls = env
        .take_requests()
        .into_iter()
        .filter(|r| r.method == Method::ToolSessionStart)
        .count();
    assert_eq!(
        start_calls, 1,
        "concurrent bsk open in same scope must start exactly 1 session"
    );
    let sessions_out = env.run_bsk(&["session", "list", "--json"], &[]).await;
    assert!(sessions_out.status.success());
    let sessions_json: Value = serde_json::from_slice(&sessions_out.stdout).unwrap();
    assert_eq!(
        sessions_json.as_array().unwrap().len(),
        1,
        "must not leak an orphaned session"
    );

    // Identical `context_id` UUID on follow-up sync reuses `c1` without alias churn!
    let sync_again = env
        .run_bsk(&["sync", "--json"], &[("BSK_SCOPE", "shared-worker")])
        .await;
    assert!(sync_again.status.success());
    let sync_json: Value = serde_json::from_slice(&sync_again.stdout).unwrap();
    assert_eq!(sync_json["ctx"], "c1");
    let _ = env.take_requests();

    // 2. Creating a new active tab (`tab_id = 8`) prevents implicit `click` without `--tab-id`
    //    from injecting tab 7's `context_id`!
    let create_out = env
        .run_bsk(
            &["tab", "create", "--url", "https://app.test/two"],
            &[("BSK_SCOPE", "shared-worker")],
        )
        .await;
    assert!(create_out.status.success());
    let _ = env.take_requests();

    let click_new_tab = env
        .run_bsk(&["click", "@e1"], &[("BSK_SCOPE", "shared-worker")])
        .await;
    assert!(click_new_tab.status.success());
    let reqs = env.take_requests();
    assert_eq!(reqs.len(), 1);
    assert!(
        reqs[0].params.as_ref().unwrap().get("context_id").is_none(),
        "must NOT inject tab 7's context_id when active tab switched to unsynced tab 8"
    );

    // Explicit `--tab-id 7` still resolves tab 7's `context_id`!
    let click_tab7 = env
        .run_bsk(
            &["click", "@e1", "--tab-id", "7"],
            &[("BSK_SCOPE", "shared-worker")],
        )
        .await;
    assert!(click_tab7.status.success());
    let reqs = env.take_requests();
    assert_eq!(
        reqs[0].params.as_ref().unwrap()["context_id"],
        "aaaaaaaa-1111-4111-8111-111111111111"
    );

    env.shutdown().await;
}
