//! Exercise the production RPC handler and extension audit API over real WS.

use std::sync::Arc;
use std::time::{Duration, Instant};

use bsk::daemon::audit::AuditStore;
use bsk::daemon::ipc::{DaemonStatus, full_handler};
use bsk::daemon::queue::ToolQueueRegistry;
use bsk::daemon::sessions::SessionRegistry;
use bsk::daemon::ws::WsServer;
use bsk::daemon::{DaemonConfig, DaemonState};
use bsk_protocol::{Method, ResponseBody};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn send(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string())).await.unwrap();
}

async fn receive(ws: &mut Ws) -> Value {
    loop {
        match ws.next().await.unwrap().unwrap() {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(data) => ws.send(Message::Pong(data)).await.unwrap(),
            other => panic!("Unexpected frame: {other:?}"),
        }
    }
}

async fn connect(addr: std::net::SocketAddr, instance: &str, enabled: bool) -> Ws {
    let mut request = format!("ws://{addr}/").into_client_request().unwrap();
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
            .parse()
            .unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    send(
        &mut ws,
        json!({"id":"handshake", "method":"system.handshake", "params":{
            "client":bsk_protocol::EXTENSION_CLIENT_ID, "version":"0.2.1", "protocol_version":bsk::daemon::state::PROTOCOL_VERSION,
        "instance_id":instance, "label":"Audit test", "browser":{"name":"chrome","version":"131"},
            "audit_enabled":enabled
        }}),
    )
    .await;
    let response = receive(&mut ws).await;
    assert_eq!(response["result"]["audit_version"], 1, "{response}");
    assert_eq!(response["result"]["audit_ready"], true);
    ws
}

async fn audit(ws: &mut Ws, params: Value) -> Value {
    send(
        ws,
        json!({"id":"audit-query", "method":"audit.request", "params":params}),
    )
    .await;
    let response = receive(ws).await;
    assert_eq!(response["id"], "audit-query");
    response
}

fn ok(body: ResponseBody) -> Value {
    match body {
        ResponseBody::Ok(value) => value,
        ResponseBody::Err(error) => panic!("RPC failed: {error:?}"),
    }
}

#[tokio::test]
async fn records_production_dispatch_and_isolates_browser_history() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let temp = tempfile::tempdir().unwrap();
        let mut state = DaemonState::new(DaemonConfig::new(0).with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal));
        state.audit = Arc::new(AuditStore::new(Some(temp.path().join("audit"))));
        state.sessions = Arc::new(SessionRegistry::with_audit(Arc::clone(&state.audit)));
        state.tool_queues = Arc::new(ToolQueueRegistry::new(
            Arc::clone(&state.browsers), Arc::clone(&state.sessions),
        ));
        let state = Arc::new(state);
        let server = WsServer::new(Arc::clone(&state)).bind("127.0.0.1:0".parse().unwrap()).await.unwrap();
        let handler = full_handler(DaemonStatus {
            started_at: Instant::now(), ws_port: server.local_addr.port(),
            sock_path: temp.path().join("unused"), daemon_version:"0.2.1", protocol_version:bsk::daemon::state::PROTOCOL_VERSION,
        }, Arc::clone(&state));
        let mut ws = connect(server.local_addr, "aaaaaaaa", true).await;

        let start = tokio::spawn(handler("start".into(), Method::SessionStart, json!({"task_name":"Search docs"})));
        let request = receive(&mut ws).await;
        assert_eq!(request["method"], "tool.session_start");
        send(&mut ws, json!({"id":request["id"],"result":{"agent_window_id":42}})).await;
        let session = ok(start.await.unwrap())["session_id"].as_str().unwrap().to_owned();

        let call = tokio::spawn(handler("click".into(), Method::ToolClick, json!({"session_id":session,"ref":"@e1","_audit_id":"caller-forgery","audit_id":"caller-forgery"})));
        let request = receive(&mut ws).await;
        assert_eq!(request["method"], "tool.click");
        let operation = &request["audit_id"];
        assert!(operation.is_string());
        assert_ne!(operation, "caller-forgery");
        send(&mut ws, json!({"event":"audit.context","payload":{
            "operation_id":operation,"target":"Search", "url":"https://example.com/private?secret=hidden"
        }})).await;
        send(&mut ws, json!({"id":request["id"],"result":{"ok":true,"text":"private-page"}})).await;
        ok(call.await.unwrap());
        let list = audit(&mut ws, json!({"action":"list", "limit":5})).await;
        assert_eq!(list["result"]["total"], 1);
        let id = list["result"]["runs"][0]["id"].as_str().unwrap().to_owned();
        assert_eq!(list["result"]["runs"][0]["name"], "Search docs");
        assert_eq!(list["result"]["runs"][0]["operations"], 1);
        let detail = audit(&mut ws, json!({"action":"get", "id":id})).await;
        assert!(detail["result"]["events"].as_array().unwrap().iter().any(|e| e["data"]["target"] == "Search"));

        let mut other = connect(server.local_addr, "bbbbbbbb", false).await;
        assert_eq!(audit(&mut other, json!({"action":"list","browser_id":"aaaaaaaa"})).await["result"]["total"], 0);
        assert!(audit(&mut other, json!({"action":"get","id":id})).await.get("error").is_some());
        assert!(audit(&mut ws, json!({"action":"delete","id":id})).await.get("error").is_some());

        audit(&mut ws, json!({"action":"configure","enabled":false})).await;
        let fill = tokio::spawn(handler("fill".into(), Method::ToolFill, json!({"session_id":session,"ref":"@e1","value":"private-input"})));
        let request = receive(&mut ws).await;
        assert!(request.get("audit_id").is_none());
        assert!(request["params"].get("_audit_id").is_none());
        send(&mut ws, json!({"id":request["id"],"result":{}})).await;
        ok(fill.await.unwrap());
        let stop = tokio::spawn(handler("stop".into(), Method::SessionStop, json!({"session_id":session})));
        let request = receive(&mut ws).await;
        assert_eq!(request["method"], "tool.session_stop");
        send(&mut ws, json!({"id":request["id"],"result":{}})).await;
        ok(stop.await.unwrap());
        let detail = audit(&mut ws, json!({"action":"get","id":id})).await;
        assert_eq!(detail["result"]["run"]["status"], "ended");
        assert_eq!(detail["result"]["run"]["partial"], true);
        assert_eq!(detail["result"]["run"]["operations"], 1);
        let raw = std::fs::read_to_string(temp.path().join("audit").join(format!("{id}.jsonl"))).unwrap();
        for secret in ["private-input", "private-page", "secret=", "caller-forgery"] {
            assert!(!raw.contains(secret));
        }
        assert!(audit(&mut other, json!({"action":"delete","id":id})).await.get("error").is_some());
        assert_eq!(audit(&mut ws, json!({"action":"delete","id":id})).await["result"]["deleted"], true);
        ws.close(None).await.unwrap();
        other.close(None).await.unwrap();
        server.shutdown.notify_one();
        server.task.await.unwrap();
    }).await.expect("audit round trip timed out");
}

#[tokio::test]
async fn corrupt_and_missing_audit_files_do_not_brick_tools_or_opt_out() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let temp = tempfile::tempdir().unwrap();
        let audit_dir = temp.path().join("audit");
        std::fs::create_dir_all(&audit_dir).unwrap();
        // Seed corrupt JSON, bad header, and mismatched filename `.jsonl` files.
        std::fs::write(audit_dir.join("corrupt-1.jsonl"), b"{not valid json\n").unwrap();
        std::fs::write(
            audit_dir.join("bad-header.jsonl"),
            b"{\"at\":1,\"kind\":\"ended\",\"data\":{}}\n",
        )
        .unwrap();
        std::fs::write(
            audit_dir.join("wrong-name.jsonl"),
            serde_json::json!({
                "at": 1,
                "kind": "started",
                "data": {
                    "id": "different-id",
                    "browser_id": "aaaaaaaa",
                    "session_id": "abcd",
                    "started_at": 1,
                    "recorded_at": 1,
                    "updated_at": 1,
                    "status": "ended",
                    "operations": 0,
                    "errors": 0,
                    "partial": false
                }
            })
            .to_string()
                + "\n",
        )
        .unwrap();
        // Seed an expired valid run whose file will be removed externally before prune.
        let expired_id = "1000-00000000-0000-0000-0000-000000000001";
        let expired_path = audit_dir.join(format!("{expired_id}.jsonl"));
        std::fs::write(
            &expired_path,
            serde_json::json!({
                "at": 1000,
                "kind": "started",
                "data": {
                    "id": expired_id,
                    "browser_id": "aaaaaaaa",
                    "session_id": "old1",
                    "started_at": 1000,
                    "recorded_at": 1000,
                    "updated_at": 1000,
                    "status": "ended",
                    "operations": 0,
                    "errors": 0,
                    "partial": false
                }
            })
            .to_string()
                + "\n",
        )
        .unwrap();

        let state = Arc::new(DaemonState::new_isolated(
            DaemonConfig::new(0)
                .with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal),
            temp.path(),
        ));
        let server = WsServer::new(Arc::clone(&state))
            .bind("127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let handler = full_handler(
            DaemonStatus {
                started_at: Instant::now(),
                ws_port: server.local_addr.port(),
                sock_path: temp.path().join("unused"),
                daemon_version: "0.5.0",
                protocol_version: bsk::daemon::state::PROTOCOL_VERSION,
            },
            Arc::clone(&state),
        );

        let mut ws = connect(server.local_addr, "aaaaaaaa", true).await;
        // Expired file should already have been pruned on load without tripping over corrupt files.
        assert!(!expired_path.exists());

        let start = tokio::spawn(handler("start".into(), Method::SessionStart, json!({})));
        let req = receive(&mut ws).await;
        send(
            &mut ws,
            json!({"id": req["id"], "result": {"agent_window_id": 7}}),
        )
        .await;
        let session = ok(start.await.unwrap())["session_id"]
            .as_str()
            .unwrap()
            .to_owned();

        // `tool.click` must NOT be bricked by corrupt files in the audit directory.
        let click = tokio::spawn(handler(
            "click".into(),
            Method::ToolClick,
            json!({"session_id": session, "ref": "@e1"}),
        ));
        let req = receive(&mut ws).await;
        send(&mut ws, json!({"id": req["id"], "result": {"ok": true}})).await;
        ok(click.await.unwrap());

        let stop = tokio::spawn(handler(
            "stop".into(),
            Method::SessionStop,
            json!({"session_id": session}),
        ));
        let req = receive(&mut ws).await;
        send(&mut ws, json!({"id": req["id"], "result": {}})).await;
        ok(stop.await.unwrap());

        let list = audit(&mut ws, json!({"action": "list", "limit": 10})).await;
        assert_eq!(list["result"]["total"], 1);
        let run_id = list["result"]["runs"][0]["id"].as_str().unwrap().to_owned();

        // Externally deleting the run file before `delete` must drop the stale
        // in-memory entry cleanly instead of failing with NotFound.
        std::fs::remove_file(audit_dir.join(format!("{run_id}.jsonl"))).unwrap();
        let del = audit(&mut ws, json!({"action": "delete", "id": run_id})).await;
        assert_eq!(del["result"]["deleted"], true);
        let list_after = audit(&mut ws, json!({"action": "list", "limit": 10})).await;
        assert_eq!(list_after["result"]["total"], 0);

        // Disabling audit (`configure(false)`) must succeed even on a fresh store
        // whose root directory is unavailable / never loaded.
        let broken_store = AuditStore::new(None);
        assert!(broken_store.configure("browser-x", true).is_err());
        assert_eq!(
            broken_store.configure("browser-x", false).unwrap()["enabled"],
            false
        );

        ws.close(None).await.unwrap();
        server.shutdown.notify_one();
        server.task.await.unwrap();
    })
    .await
    .expect("corrupt audit recovery test timed out");
}

#[tokio::test]
async fn ws_pump_keeps_dispatching_while_audit_get_reads_large_run() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let temp = tempfile::tempdir().unwrap();
        let audit_dir = temp.path().join("audit");
        std::fs::create_dir_all(&audit_dir).unwrap();
        let run_id = "2000-00000000-0000-0000-0000-000000000002";
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let mut content = String::with_capacity(2 * 1024 * 1024);
        content.push_str(
            &serde_json::json!({
                "at": now_ms,
                "kind": "started",
                "data": {
                    "id": run_id,
                    "browser_id": "aaaaaaaa",
                    "session_id": "big1",
                    "started_at": now_ms,
                    "recorded_at": now_ms,
                    "updated_at": now_ms,
                    "status": "ended",
                    "operations": 0,
                    "errors": 0,
                    "partial": false
                }
            })
            .to_string(),
        );
        content.push('\n');
        let line = serde_json::json!({
            "at": now_ms,
            "kind": "context",
            "operation_id": "op-1",
            "data": { "target": "button label padding for bulk audit history", "tab_id": 1 }
        })
        .to_string();
        for _ in 0..8_000 {
            content.push_str(&line);
            content.push('\n');
        }
        std::fs::write(audit_dir.join(format!("{run_id}.jsonl")), content).unwrap();

        let state = Arc::new(DaemonState::new_isolated(
            DaemonConfig::new(0).with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal),
            temp.path(),
        ));
        let server = WsServer::new(Arc::clone(&state))
            .bind("127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let handler = full_handler(
            DaemonStatus {
                started_at: Instant::now(),
                ws_port: server.local_addr.port(),
                sock_path: temp.path().join("unused"),
                daemon_version: "0.5.0",
                protocol_version: bsk::daemon::state::PROTOCOL_VERSION,
            },
            Arc::clone(&state),
        );

        let mut ws = connect(server.local_addr, "aaaaaaaa", false).await;
        let start = tokio::spawn(handler("start".into(), Method::SessionStart, json!({})));
        let req = receive(&mut ws).await;
        send(&mut ws, json!({"id": req["id"], "result": {"agent_window_id": 9}})).await;
        let session = ok(start.await.unwrap())["session_id"]
            .as_str()
            .unwrap()
            .to_owned();

        // Dispatch a tool call and simultaneously kick off a large `audit.request("get")`.
        let snap = tokio::spawn(handler(
            "snap-1".into(),
            Method::ToolSnapshot,
            json!({"session_id": session}),
        ));
        let snap_req = receive(&mut ws).await;
        assert_eq!(snap_req["method"], "tool.snapshot");

        send(
            &mut ws,
            json!({"id": "audit-big", "method": "audit.request", "params": {"action": "get", "id": run_id, "limit": 50}}),
        )
        .await;
        send(
            &mut ws,
            json!({"id": snap_req["id"], "result": {"ok": true}}),
        )
        .await;

        // Both the tool response and the background audit response complete cleanly.
        assert_eq!(ok(snap.await.unwrap())["ok"], true);
        let audit_reply = receive(&mut ws).await;
        assert_eq!(audit_reply["id"], "audit-big");
        assert_eq!(audit_reply["result"]["total"], 8_001);

        ws.close(None).await.unwrap();
        server.shutdown.notify_one();
        server.task.await.unwrap();
    })
    .await
    .expect("non-blocking audit WS pump test timed out");
}

#[tokio::test]
async fn audit_configure_false_stops_recording_immediately_and_records_paused_marker() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(DaemonState::new_isolated(
            DaemonConfig::new(0)
                .with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal),
            temp.path(),
        ));
        let server = WsServer::new(Arc::clone(&state))
            .bind("127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        let handler = full_handler(
            DaemonStatus {
                started_at: Instant::now(),
                ws_port: server.local_addr.port(),
                sock_path: temp.path().join("unused"),
                daemon_version: "0.5.0",
                protocol_version: bsk::daemon::state::PROTOCOL_VERSION,
            },
            Arc::clone(&state),
        );

        let mut ws = connect(server.local_addr, "dddddddd", true).await;
        let start = tokio::spawn(handler("start".into(), Method::SessionStart, json!({})));
        let req = receive(&mut ws).await;
        send(&mut ws, json!({"id": req["id"], "result": {"agent_window_id": 11}})).await;
        let session = ok(start.await.unwrap())["session_id"]
            .as_str()
            .unwrap()
            .to_owned();

        // First tool call creates an active audit run while enabled.
        let snap1 = tokio::spawn(handler(
            "snap-before".into(),
            Method::ToolSnapshot,
            json!({"session_id": session}),
        ));
        let snap1_req = receive(&mut ws).await;
        assert!(
            snap1_req["audit_id"].as_str().is_some(),
            "enabled audit must stamp audit_id before opt-out: {snap1_req}"
        );
        send(&mut ws, json!({"id": snap1_req["id"], "result": {"ok": true}})).await;
        assert_eq!(ok(snap1.await.unwrap())["ok"], true);

        // Seed a large run so an earlier queued `audit.request("get")` keeps the
        // per-connection worker busy when `configure(false)` arrives behind it.
        let bulk_id = "20260401-bulk-pause";
        let audit_dir = temp.path().join("audit");
        std::fs::create_dir_all(&audit_dir).unwrap();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let mut content = String::with_capacity(600_000);
        content.push_str(
            &json!({
                "at": now_ms,
                "kind": "started",
                "data": {
                    "id": bulk_id,
                    "session_id": "bulk-sess",
                    "browser_id": "dddddddd",
                    "started_at": now_ms,
                    "updated_at": now_ms,
                    "status": "completed",
                    "operations": 0,
                    "errors": 0,
                    "partial": false
                }
            })
            .to_string(),
        );
        content.push('\n');
        let line = json!({
            "at": now_ms,
            "kind": "context",
            "operation_id": "op-bulk",
            "data": { "target": "padding for slow queued audit get", "tab_id": 1 }
        })
        .to_string();
        for _ in 0..4_000 {
            content.push_str(&line);
            content.push('\n');
        }
        std::fs::write(audit_dir.join(format!("{bulk_id}.jsonl")), content).unwrap();

        // Queue a slow `get` followed immediately by `configure(false)` on WS.
        send(
            &mut ws,
            json!({"id": "audit-slow", "method": "audit.request", "params": {"action": "get", "id": bulk_id, "limit": 10}}),
        )
        .await;
        send(
            &mut ws,
            json!({"id": "audit-off", "method": "audit.request", "params": {"action": "configure", "enabled": false}}),
        )
        .await;

        // Wait for WS pump to parse `configure(false)` and apply immediate
        // in-memory opt-out (happens synchronously before `audit-slow` finishes).
        let deadline = Instant::now() + Duration::from_secs(2);
        while state.audit.needs_begin(&session) {
            assert!(
                Instant::now() < deadline,
                "configure(false) must disable audit in memory immediately on arrival"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        // Dispatch a tool call right away: it must NOT receive an `audit_id`
        // or write any operation to disk after opt-out.
        let snap2 = tokio::spawn(handler(
            "snap-after".into(),
            Method::ToolSnapshot,
            json!({"session_id": session}),
        ));
        let mut saw_snap2 = false;
        let mut saw_off = false;
        while !(saw_snap2 && saw_off) {
            let msg = receive(&mut ws).await;
            if msg["method"] == "tool.snapshot" {
                assert!(
                    msg.get("audit_id").is_none() || msg["audit_id"].is_null(),
                    "tool call after configure(false) must not record audit_id: {msg}"
                );
                send(&mut ws, json!({"id": msg["id"], "result": {"ok": true}})).await;
                saw_snap2 = true;
            } else if msg["id"] == "audit-off" {
                assert_eq!(msg["result"]["enabled"], false);
                saw_off = true;
            }
        }
        assert_eq!(ok(snap2.await.unwrap())["ok"], true);

        // The existing run still received its `"paused"` marker and recorded only 1 operation.
        let listed = state.audit.list("dddddddd", 0, 10).unwrap();
        let run = listed["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["session_id"] == session)
            .expect("session run must exist");
        assert_eq!(run["operations"], 1);
        assert_eq!(run["partial"], true);
        let run_id = run["id"].as_str().unwrap();
        let detail = state.audit.get("dddddddd", run_id, 0, 50).unwrap();
        assert!(
            detail["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|ev| ev["kind"] == "paused"),
            "queued configure(false) must still record a paused marker: {detail}"
        );

        ws.close(None).await.unwrap();
        server.shutdown.notify_one();
        server.task.await.unwrap();
    })
    .await
    .expect("audit configure(false) test timed out");
}
