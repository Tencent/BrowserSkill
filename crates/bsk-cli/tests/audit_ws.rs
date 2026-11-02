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
            "client":"browser-skill-extension", "version":"0.2.1", "protocol_version":bsk::daemon::state::PROTOCOL_VERSION,
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
        let mut state = DaemonState::new(DaemonConfig::new(0));
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

        let call = tokio::spawn(handler("click".into(), Method::ToolClick, json!({"session_id":session,"ref":"@e1","_audit_id":"caller-forgery"})));
        let request = receive(&mut ws).await;
        assert_eq!(request["method"], "tool.click");
        let operation = &request["params"]["_audit_id"];
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
