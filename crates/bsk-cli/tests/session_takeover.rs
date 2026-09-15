//! End-to-end coverage of the user-takeover ("held") control state:
//! `session.control_taken` / `session.control_returned` WS events, the
//! `control=user` rejection of interrupt-gated tool dispatch, and the
//! `session.status` / `session.wait_control` daemon-local RPCs the agent
//! uses to observe and wait out the takeover.
//!
//! Uses the same fake-extension harness as `session_user_interrupt.rs`:
//! a real daemon + IPC socket + WS peer, so the contract exercised here
//! is the wire one, not an internal function call.

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::{
    HandshakeParams, HandshakeResult, SessionControl, SessionStatusResult,
    SessionWaitControlResult, WaitControlOutcome,
};
use bsk_protocol::tools::SessionStartResult;
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, EventFrame, EventKind, Frame, Method, RequestFrame, ResponseBody,
    ResponseFrame,
};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::json;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

use support::{wait_for_session_interrupt_pending, wait_until};

const TEST_EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";
const TAKEOVER_REJECTION: &str = "tool dispatch rejected: the user has taken over this session (control=user). Do not retry; run `bsk session wait-control --session <id>` and continue only after it returns control=agent.";

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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
    let config = DaemonConfig::new(0);
    let sock = tempfile_path("bsk-test-takeover");
    let handle = daemon::run(config, Some(sock.clone())).await.unwrap();
    (handle, sock)
}

async fn connect_ext(addr: std::net::SocketAddr) -> TestWs {
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
    let (ws, _resp) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws
}

async fn handshake_as_ext(ws: &mut TestWs) -> HandshakeResult {
    let params = HandshakeParams {
        client: "browser-skill-extension".into(),
        version: "0.1.0-dev.0".parse().unwrap(),
        protocol_version: bsk::daemon::state::PROTOCOL_VERSION.into(),
        instance_id: TEST_EXT_ID.into(),
        browser: BrowserPeerInfo {
            name: "chrome".into(),
            version: "131.0".into(),
        },
        label: "Test".into(),
        min_compatible_peer: Some("0.1.0-dev.0".parse().unwrap()),
        min_compatible_protocol: Some("1.0".into()),
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
        _ => panic!("expected text handshake reply"),
    };
    let resp: ResponseFrame = serde_json::from_str(&text).unwrap();
    match resp.body {
        ResponseBody::Ok(v) => serde_json::from_value(v).unwrap(),
        ResponseBody::Err(e) => panic!("handshake rejected: {e:?}"),
    }
}

#[derive(serde::Serialize)]
struct StartParams {
    browser_instance_id: Option<String>,
}

#[derive(serde::Deserialize, Debug)]
struct StartReply {
    session_id: String,
}

async fn start_session(ipc: &mut IpcClient) -> String {
    let start: StartReply = ipc
        .call(
            "sess-start",
            Method::SessionStart,
            Some(StartParams {
                browser_instance_id: None,
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("session.start succeeded");
    start.session_id
}

/// Split the WS peer into a sink we can drive and a responder task that
/// answers `tool.session_start` and counts every other forwarded request.
/// `blocked_method` calls are counted but never answered: a correct
/// daemon rejects them before they ever reach the extension.
fn spawn_responder(
    ws: TestWs,
    counted_method: Method,
) -> (
    Arc<tokio::sync::Mutex<futures_util::stream::SplitSink<TestWs, Message>>>,
    Arc<AtomicUsize>,
) {
    let (sink, stream) = ws.split();
    let sink = Arc::new(tokio::sync::Mutex::new(sink));
    let count = Arc::new(AtomicUsize::new(0));
    let sink_for_responder = Arc::clone(&sink);
    let count_for_responder = Arc::clone(&count);
    tokio::spawn(async move {
        let mut stream = stream;
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Text(text) = msg else { continue };
            let Ok(frame) = serde_json::from_str::<Frame>(&text) else {
                continue;
            };
            let Frame::Request(req) = frame else { continue };
            if req.method == Method::ToolSessionStart {
                let result = SessionStartResult {
                    interaction: None,
                    agent_window_id: Some(1),
                };
                let reply = ResponseFrame {
                    id: req.id,
                    body: ResponseBody::Ok(serde_json::to_value(result).unwrap()),
                };
                let mut g = sink_for_responder.lock().await;
                g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                    .await
                    .unwrap();
            } else if req.method == Method::ToolConsole {
                // Answer passive reads so the test can assert they pass the
                // held gate *and* reach the extension.
                let reply = ResponseFrame {
                    id: req.id,
                    body: ResponseBody::Ok(json!({
                        "tab_id": 7,
                        "entries": [],
                        "next_since": 0,
                        "truncated": false
                    })),
                };
                let mut g = sink_for_responder.lock().await;
                g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                    .await
                    .unwrap();
            } else if req.method == counted_method {
                count_for_responder.fetch_add(1, Ordering::SeqCst);
            }
        }
    });
    (sink, count)
}

/// Full takeover lifecycle over the real transport:
/// taken → gated rejection → status=user → wait_control →
/// returned(note) → status=agent with the receipt consumed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn takeover_blocks_dispatch_until_control_returns() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (ws_sink, forwarded_click_count) = spawn_responder(ws, Method::ToolClick);

    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let session_id = start_session(&mut ipc).await;

    // The user presses "接管/Take over".
    {
        let event = EventFrame {
            event: EventKind::SessionControlTaken,
            payload: json!({ "session_id": session_id.clone() }),
        };
        let mut g = ws_sink.lock().await;
        g.send(Message::Text(serde_json::to_string(&event).unwrap()))
            .await
            .unwrap();
    }
    let state = handle.state();
    wait_for_session_interrupt_pending(&state, &session_id).await;
    wait_until("session held", Duration::from_secs(2), || {
        state
            .session_interrupts
            .is_held(&bsk::daemon::sessions::SessionId(session_id.clone()))
    })
    .await;

    // `session.status` reports the hold without clearing it.
    let status: SessionStatusResult = ipc
        .call(
            "status-1",
            Method::SessionStatus,
            Some(json!({ "session_id": session_id.clone() })),
            Duration::from_secs(3),
        )
        .await
        .unwrap()
        .expect("session.status ok");
    assert_eq!(status.control, SessionControl::User);
    assert!(status.held_for_ms.is_some());

    // An interrupt-gated tool call is rejected with the exact message and
    // never reaches the extension.
    let outcome = ipc
        .call::<_, serde_json::Value>(
            "click-while-held",
            Method::ToolClick,
            Some(json!({ "session_id": session_id.clone(), "ref": "@e1" })),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
    let err = outcome.expect_err("held session must reject a click");
    assert_eq!(err.code, ErrorCode::UserAborted);
    assert_eq!(err.message, TAKEOVER_REJECTION);
    assert_eq!(
        forwarded_click_count.load(Ordering::SeqCst),
        0,
        "a held session's click must not be forwarded to the extension"
    );

    // Rejection is non-consuming: a second click is rejected the same way.
    let outcome = ipc
        .call::<_, serde_json::Value>(
            "click-while-held-2",
            Method::ToolClick,
            Some(json!({ "session_id": session_id.clone(), "ref": "@e1" })),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
    let err = outcome.expect_err("held session keeps rejecting");
    assert_eq!(err.code, ErrorCode::UserAborted);
    assert_eq!(err.message, TAKEOVER_REJECTION);

    // A passive read still passes through the held gate and reaches the
    // extension, proving the gate is narrow.
    let console = ipc
        .call::<_, serde_json::Value>(
            "console-while-held",
            Method::ToolConsole,
            Some(json!({ "session_id": session_id.clone() })),
            Duration::from_secs(3),
        )
        .await
        .unwrap()
        .expect("passive reads must pass a held session");
    assert_eq!(console["tab_id"], json!(7));

    // Park a waiter on `session.wait_control`, then return control.
    let waiter = {
        let sock = sock.clone();
        let session_id = session_id.clone();
        tokio::spawn(async move {
            let mut ipc = IpcClient::connect(&sock).await.unwrap();
            ipc.call::<_, SessionWaitControlResult>(
                "wait-1",
                Method::SessionWaitControl,
                Some(json!({ "session_id": session_id, "timeout_ms": 5_000 })),
                Duration::from_secs(10),
            )
            .await
            .unwrap()
            .expect("wait_control ok")
        })
    };
    // Give the waiter time to park before the release lands.
    tokio::time::sleep(Duration::from_millis(150)).await;
    {
        let event = EventFrame {
            event: EventKind::SessionControlReturned,
            payload: json!({
                "session_id": session_id.clone(),
                "note": "I finished the captcha"
            }),
        };
        let mut g = ws_sink.lock().await;
        g.send(Message::Text(serde_json::to_string(&event).unwrap()))
            .await
            .unwrap();
    }
    let released = tokio::time::timeout(Duration::from_secs(5), waiter)
        .await
        .expect("wait_control must resolve after control returns")
        .unwrap();
    assert_eq!(released.outcome, WaitControlOutcome::Released);
    assert_eq!(released.control, SessionControl::Agent);
    assert_eq!(released.note.as_deref(), Some("I finished the captcha"));

    // The receipt is delivered exactly once: status no longer shows it, and
    // a second wait reports already_agent.
    let status: SessionStatusResult = ipc
        .call(
            "status-2",
            Method::SessionStatus,
            Some(json!({ "session_id": session_id.clone() })),
            Duration::from_secs(3),
        )
        .await
        .unwrap()
        .expect("session.status ok");
    assert_eq!(status.control, SessionControl::Agent);
    assert!(
        status.last_return.is_none(),
        "wait_control must have consumed the receipt"
    );

    let again: SessionWaitControlResult = ipc
        .call(
            "wait-2",
            Method::SessionWaitControl,
            Some(json!({ "session_id": session_id.clone(), "timeout_ms": 50 })),
            Duration::from_secs(3),
        )
        .await
        .unwrap()
        .expect("wait_control ok");
    assert_eq!(again.outcome, WaitControlOutcome::AlreadyAgent);
    assert!(again.note.is_none());

    // Control is back and the takeover's legacy one-shot marker was dropped
    // by the return, so the very next click must pass the gate and reach the
    // extension. A short daemon-side `timeout_ms` keeps the test fast: the
    // responder never answers, so the daemon surfaces `timeout` only after
    // the click was actually forwarded.
    let click = ipc
        .call::<_, serde_json::Value>(
            "click-after-release",
            Method::ToolClick,
            Some(json!({
                "session_id": session_id.clone(),
                "ref": "@e1",
                "timeout_ms": 300
            })),
            Duration::from_secs(10),
        )
        .await;
    let click = match click {
        Ok(Err(err)) => {
            assert_ne!(
                err.code,
                ErrorCode::UserAborted,
                "no gate may fire after control returns: {err:?}"
            );
            assert!(
                !err.message.contains("pending user interrupt"),
                "the takeover's one-shot marker must be cleared on return: {err:?}"
            );
            err
        }
        Ok(Ok(value)) => panic!("click should not have succeeded, got {value:?}"),
        Err(err) => panic!("IPC round trip must complete, got {err}"),
    };
    assert!(
        matches!(click.code, ErrorCode::Timeout | ErrorCode::Cancelled),
        "unanswered forwarded click surfaces a timeout, got {click:?}"
    );
    wait_until(
        "click forwarded after release",
        Duration::from_secs(2),
        || forwarded_click_count.load(Ordering::SeqCst) >= 1,
    )
    .await;

    handle.shutdown().await;
}

/// `session.wait_control` on a session the user never took over returns
/// `already_agent` promptly, and on a session that disappears returns
/// `session_gone`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wait_control_reports_already_agent_and_session_gone() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (_ws_sink, _count) = spawn_responder(ws, Method::ToolClick);

    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let session_id = start_session(&mut ipc).await;

    let already: SessionWaitControlResult = ipc
        .call(
            "wait-agent",
            Method::SessionWaitControl,
            Some(json!({ "session_id": session_id.clone(), "timeout_ms": 100 })),
            Duration::from_secs(3),
        )
        .await
        .unwrap()
        .expect("wait_control ok");
    assert_eq!(already.outcome, WaitControlOutcome::AlreadyAgent);

    let gone: SessionWaitControlResult = ipc
        .call(
            "wait-ghost",
            Method::SessionWaitControl,
            Some(json!({ "session_id": "ghost", "timeout_ms": 100 })),
            Duration::from_secs(3),
        )
        .await
        .unwrap()
        .expect("wait_control answers session_gone rather than erroring");
    assert_eq!(gone.outcome, WaitControlOutcome::SessionGone);

    let status_err = ipc
        .call::<_, serde_json::Value>(
            "status-ghost",
            Method::SessionStatus,
            Some(json!({ "session_id": "ghost" })),
            Duration::from_secs(3),
        )
        .await
        .unwrap()
        .expect_err("unknown session must be not_found");
    assert_eq!(status_err.code, ErrorCode::NotFound);

    handle.shutdown().await;
}
