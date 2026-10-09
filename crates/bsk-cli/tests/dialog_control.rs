//! Production IPC/WS dialog receipts, busy-queue bypass, ownership and no action replay.
mod support;

use std::path::Path;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk_protocol::{ErrorCode, Method, RpcError};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn send(ws: &mut Ws, value: Value) {
    ws.send(Message::Text(value.to_string())).await.unwrap();
}

async fn receive(ws: &mut Ws) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match ws.next().await.unwrap().unwrap() {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Ping(data) => ws.send(Message::Pong(data)).await.unwrap(),
                other => panic!("Unexpected frame: {other:?}"),
            }
        }
    })
    .await
    .expect("extension request timed out (dialog controls must bypass the busy queue)")
}

async fn connect(addr: std::net::SocketAddr, instance: &str) -> Ws {
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
        json!({"id":"hs", "method":"system.handshake", "params":{
            "client":"browser-skill-extension", "version":"0.3.2", "protocol_version":"1.4",
        "min_compatible_protocol":"1.4", "instance_id":instance, "label":"Dialog test",
            "browser":{"name":"chrome","version":"153"}
        }}),
    )
    .await;
    assert!(receive(&mut ws).await.get("result").is_some());
    ws
}

async fn call(sock: &Path, id: &str, method: Method, params: Value) -> Result<Value, RpcError> {
    bsk::ipc_client::IpcClient::connect(sock)
        .await
        .unwrap()
        .call_with_id::<Value, Value>(id.into(), method, Some(params), Duration::from_secs(4))
        .await
        .unwrap()
}

#[tokio::test]
async fn a_sequential_ipc_agent_can_decide_a_modal_and_retrieve_the_original_result() {
    let temp = tempfile::tempdir().unwrap();
    let sock = temp.path().join("dialog.sock");
    let handle = daemon::run(DaemonConfig::new(0), Some(sock.clone()))
        .await
        .unwrap();
    let state = handle.state();
    let mut ws = connect(handle.ws_addr(), "dialog-owner").await;
    let mut sessions = Vec::new();
    for i in 0..2 {
        let sock = sock.clone();
        let start =
            tokio::spawn(
                async move { call(&sock, "start", Method::SessionStart, json!({})).await },
            );
        let req = receive(&mut ws).await;
        assert_eq!(req["method"], "tool.session_start");
        send(
            &mut ws,
            json!({"id":req["id"],"result":{"agent_window_id":42+i}}),
        )
        .await;
        sessions.push(
            start.await.unwrap().unwrap()["session_id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    let session = sessions[0].clone();
    let original = {
        let sock = sock.clone();
        let session = session.clone();
        tokio::spawn(async move {
            call(&sock, "original", Method::ToolEvaluate, json!({
            "session_id":session, "expression":"prompt('Name','anonymous')", "_operation_id":"forged"
        })).await
        })
    };
    let req = receive(&mut ws).await;
    assert_eq!(req["method"], "tool.evaluate");
    let op = req["params"]["_operation_id"].as_str().unwrap().to_owned();
    assert_ne!(op, "forged");
    let dialog = json!({"id":"dlg", "tab_id":7, "type":"prompt", "message":"Name", "default_prompt":"anonymous", "sequence":1, "decision_deadline":60000});
    send(&mut ws, json!({"event":"dialog.changed","payload":{"session_id":session,"operation_id":op,"dialog":dialog}})).await;
    let pending = original.await.unwrap().unwrap_err();
    assert_eq!(pending.code, ErrorCode::DialogPending);
    assert_eq!(pending.data.unwrap()["operation_id"], op);
    assert!(state.tool_inflight.get(&"original".into()).is_some());
    assert_eq!(
        call(
            &sock,
            "blocked",
            Method::ToolEvaluate,
            json!({"session_id":session,"expression":"shouldNotRun()"})
        )
        .await
        .unwrap_err()
        .data
        .unwrap()["reason"],
        "session_busy"
    );

    let status = {
        let sock = sock.clone();
        let session = session.clone();
        tokio::spawn(async move {
            call(
                &sock,
                "status",
                Method::ToolDialogStatus,
                json!({"session_id":session}),
            )
            .await
        })
    };
    let status_req = receive(&mut ws).await;
    assert_eq!(status_req["method"], "tool.dialog_status");
    send(
        &mut ws,
        json!({"id":status_req["id"],"result":{"dialogs":[dialog]}}),
    )
    .await;
    assert_eq!(status.await.unwrap().unwrap()["dialogs"][0]["id"], "dlg");
    assert_eq!(
        call(
            &sock,
            "other-session",
            Method::ToolOperationAwait,
            json!({"session_id":sessions[1],"operation_id":op,"wait_ms":0})
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::NotFound
    );

    let mut other_browser = connect(handle.ws_addr(), "other-browser").await;
    send(&mut other_browser, json!({"event":"dialog.changed","payload":{"session_id":session,"operation_id":op,"dialog":{"id":"spoof"}}})).await;
    let pending = call(
        &sock,
        "still-pending",
        Method::ToolOperationAwait,
        json!({"session_id":session,"operation_id":op,"wait_ms":0}),
    )
    .await
    .unwrap_err();
    assert_eq!(pending.data.unwrap()["dialog"]["id"], "dlg");

    let accept = {
        let sock = sock.clone();
        let session = session.clone();
        tokio::spawn(async move {
            call(
                &sock,
                "accept",
                Method::ToolDialogAccept,
                json!({"session_id":session,"dialog_id":"dlg","text":""}),
            )
            .await
        })
    };
    let accept_req = receive(&mut ws).await;
    assert_eq!(accept_req["method"], "tool.dialog_accept");
    assert_eq!(accept_req["params"]["text"], "");
    send(&mut ws, json!({"event":"dialog.changed","payload":{"session_id":session,"operation_id":op,"dialog":null}})).await;
    send(
        &mut ws,
        json!({"id":accept_req["id"],"result":{"dialog":{"handled":"accepted"}}}),
    )
    .await;
    accept.await.unwrap().unwrap();
    send(&mut ws, json!({"id":req["id"],"result":{"tab_id":7,"value":"","javascript_dialogs":[{"handled":"accepted"}]}})).await;
    for i in 0..2 {
        let result = call(
            &sock,
            &format!("result-{i}"),
            Method::ToolOperationAwait,
            json!({"session_id":session,"operation_id":op,"wait_ms":500}),
        )
        .await
        .unwrap();
        assert_eq!(result["state"], "completed");
        assert_eq!(result["result"]["value"], "");
    }
    assert!(state.tool_inflight.get(&"original".into()).is_none());
    assert!(
        tokio::time::timeout(Duration::from_millis(30), ws.next())
            .await
            .is_err(),
        "Retrieval must not dispatch another browser action"
    );
    ws.close(None).await.unwrap();
    other_browser.close(None).await.unwrap();
    handle.shutdown().await;
}
