//! End-to-end coverage of the SessionUserInterrupt path: an
//! `EventFrame` arriving from the (fake) extension over the WS
//! channel cancels every inflight tool RPC for that session and the
//! IPC caller observes `ErrorCode::UserAborted` (NOT `Cancelled`).
//!
//! The daemon synthesises the IPC error code locally from the
//! recorded `CancelReason::UserAborted` — even if the extension's
//! cancel-reply body says `Cancelled`, the IPC peer sees
//! `UserAborted` because `cancel_session` records the reason before
//! the WS cancel forward goes out.

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::SessionStartResult;
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, EventFrame, EventKind, Frame, Method, RequestFrame, ResponseBody,
    ResponseFrame, RpcError,
};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::json;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

use support::{wait_for_inflight_forwarded, wait_for_session_interrupt_pending};

const TEST_EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

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
    let port = 0;

    let config = DaemonConfig::new(port);
    let sock = tempfile_path("bsk-test-user-interrupt");
    let handle = daemon::run(config, Some(sock.clone())).await.unwrap();
    (handle, sock)
}

async fn connect_ext(
    addr: std::net::SocketAddr,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
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

async fn handshake_as_ext(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> HandshakeResult {
    let params = HandshakeParams {
        client: "browser-skill-extension".into(),
        version: "0.1.0-dev.0".parse().unwrap(),
        protocol_version: "1.0".into(),
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
        _ => panic!(),
    };
    let resp: ResponseFrame = serde_json::from_str(&text).unwrap();
    match resp.body {
        ResponseBody::Ok(v) => serde_json::from_value(v).unwrap(),
        ResponseBody::Err(e) => panic!("handshake rejected: {e:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_user_interrupt_event_cancels_inflight_with_user_aborted() {
    // 1. Spin up daemon + fake extension.
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    // 2. Set up the fake extension's responder: replies to
    //    tool.session_start immediately, stashes the WS rpc_id of
    //    tool.snapshot but does NOT reply, and on receiving a
    //    `cancel` frame from the daemon answers the original snapshot
    //    with body=Cancelled (the IPC peer should still see
    //    UserAborted because the daemon overrides the code from the
    //    inflight entry's CancelReason).
    //
    // Split the WS into independent read and write halves: the
    // receive loop blocks on `next().await` for the entire duration
    // of the test, and the main task needs to push the
    // SessionUserInterrupt event INTO the same WS while that loop is
    // parked. With a single Mutex over the whole stream the send
    // would deadlock against the receive lock; splitting decouples
    // the two directions cleanly. The `cancel_forwarding.rs` tests
    // get away with the Mutex pattern because they only ever send
    // from inside the receiver loop (in response to a cancel frame
    // from the daemon).
    let (ws_sink, mut ws_stream) = ws.split();
    let ws_sink = Arc::new(tokio::sync::Mutex::new(ws_sink));
    let responder_sink = Arc::clone(&ws_sink);
    let responder = tokio::spawn(async move {
        let mut pending_snapshot: Option<String> = None;
        while let Some(next) = ws_stream.next().await {
            let msg = match next {
                Ok(m) => m,
                Err(_) => break,
            };
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };
            let frame: Frame = match serde_json::from_str(&text) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if let Frame::Request(req) = frame {
                match req.method {
                    Method::ToolSessionStart => {
                        let result = SessionStartResult {
                            agent_window_id: Some(1),
                        };
                        let reply = ResponseFrame {
                            id: req.id,
                            body: ResponseBody::Ok(serde_json::to_value(result).unwrap()),
                        };
                        let mut g = responder_sink.lock().await;
                        g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                            .await
                            .unwrap();
                    }
                    Method::ToolSnapshot => {
                        pending_snapshot = Some(req.id);
                    }
                    Method::Cancel => {
                        let target = req
                            .params
                            .as_ref()
                            .and_then(|v| v.get("rpc_id"))
                            .and_then(|v| v.as_str())
                            .map(str::to_string);
                        let snapshot_id = pending_snapshot.take();
                        if let (Some(target), Some(snap)) = (target, snapshot_id)
                            && target == snap
                        {
                            let reply = ResponseFrame {
                                id: snap,
                                body: ResponseBody::Err(RpcError {
                                    code: ErrorCode::Cancelled,
                                    message: "snapshot aborted by daemon cancel".into(),
                                    data: None,
                                }),
                            };
                            let mut g = responder_sink.lock().await;
                            g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                                .await
                                .unwrap();
                        }
                    }
                    _ => {}
                }
            }
        }
    });

    // 3. CLI side: open IPC, start session, kick off slow snapshot.
    let mut snap_ipc = IpcClient::connect(&sock).await.unwrap();
    let event_ws = Arc::clone(&ws_sink);

    #[derive(serde::Serialize)]
    struct StartParams {
        browser_instance_id: Option<String>,
    }
    #[derive(serde::Deserialize, Debug)]
    struct StartReply {
        session_id: String,
    }
    let start: StartReply = snap_ipc
        .call(
            "sess-1",
            Method::SessionStart,
            Some(StartParams {
                browser_instance_id: None,
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("session.start succeeded");

    let session_id = start.session_id.clone();
    let snapshot_id = "snap-user-1".to_string();
    let snapshot_id_clone = snapshot_id.clone();
    let session_id_for_task = session_id.clone();
    let snapshot_task = tokio::spawn(async move {
        snap_ipc
            .call_with_id::<_, serde_json::Value>(
                snapshot_id_clone,
                Method::ToolSnapshot,
                Some(json!({"session_id": session_id_for_task})),
                Duration::from_secs(10),
            )
            .await
    });

    let state = handle.state();
    wait_for_inflight_forwarded(&state, &snapshot_id).await;

    // 5. Fake extension EMITS the SessionUserInterrupt event over WS
    //    (this is what the real Extension's background SW will do
    //    when the user clicks the mask interrupt button).
    let event = EventFrame {
        event: EventKind::SessionUserInterrupt,
        payload: json!({"session_id": session_id}),
    };
    {
        let mut g = event_ws.lock().await;
        g.send(Message::Text(serde_json::to_string(&event).unwrap()))
            .await
            .unwrap();
    }

    // 6. The daemon should now: trip the inflight cancel flag with
    //    UserAborted, emit a per-RPC cancel frame to the extension,
    //    and the responder above will answer the original snapshot.
    //    The IPC peer (CLI) should see `UserAborted` (NOT
    //    `Cancelled`) because the daemon synthesises the error from
    //    the recorded CancelReason.
    let outcome = tokio::time::timeout(Duration::from_secs(5), snapshot_task)
        .await
        .expect("snapshot did not resolve")
        .unwrap()
        .unwrap();
    let err = outcome.expect_err("snapshot must surface a cancellation error");
    assert_eq!(
        err.code,
        ErrorCode::UserAborted,
        "user-interrupt path must surface UserAborted, not Cancelled (got {:?})",
        err
    );

    responder.abort();
    handle.shutdown().await;
}

/// The pending-interrupt marker must reject a *new* mutating tool
/// call that arrives AFTER the user clicked stop, even when no
/// tool was inflight at click time. Under v2 single-use marker
/// semantics, the marker survives indefinitely until consumed by
/// a mutating tool call — there is no time window. This is the
/// core motivating scenario: agents spend most of their time
/// between tool calls (LLM thinking), and the stop button must
/// catch a tool dispatched arbitrarily later.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_interrupt_rejects_next_mutating_tool_call_when_session_was_idle() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (ws_sink, ws_stream) = ws.split();
    let ws_sink = Arc::new(tokio::sync::Mutex::new(ws_sink));

    // Fake extension: answer tool.session_start, observe other
    // requests but never reply. We expect the daemon to reject the
    // tool call BEFORE it ever forwards a tool.click frame.
    let ws_sink_for_responder = Arc::clone(&ws_sink);
    let observed_click_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed_click_count_clone = Arc::clone(&observed_click_count);
    let responder = tokio::spawn(async move {
        let mut ws_stream = ws_stream;
        while let Some(Ok(msg)) = ws_stream.next().await {
            let text = match msg {
                Message::Text(t) => t,
                _ => continue,
            };
            let frame: Frame = match serde_json::from_str(&text) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if let Frame::Request(req) = frame {
                if req.method == Method::ToolSessionStart {
                    let result = SessionStartResult {
                        agent_window_id: Some(1),
                    };
                    let reply = ResponseFrame {
                        id: req.id,
                        body: ResponseBody::Ok(serde_json::to_value(result).unwrap()),
                    };
                    let mut g = ws_sink_for_responder.lock().await;
                    g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                        .await
                        .unwrap();
                } else if req.method == Method::ToolClick {
                    observed_click_count_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    // Deliberately do NOT reply — daemon should reject before
                    // ever forwarding to us.
                    let _ = req;
                }
            }
        }
    });

    // CLI side: open IPC, start session.
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    #[derive(serde::Serialize)]
    struct StartParams {
        browser_instance_id: Option<String>,
    }
    #[derive(serde::Deserialize, Debug)]
    struct StartReply {
        session_id: String,
    }
    let start: StartReply = ipc
        .call(
            "sess-1",
            Method::SessionStart,
            Some(StartParams {
                browser_instance_id: None,
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("session.start succeeded");

    // No tool inflight. The user clicks stop — emit the WS event.
    let event = EventFrame {
        event: EventKind::SessionUserInterrupt,
        payload: json!({"session_id": start.session_id.clone()}),
    };
    {
        let mut g = ws_sink.lock().await;
        g.send(Message::Text(serde_json::to_string(&event).unwrap()))
            .await
            .unwrap();
    }

    let state = handle.state();
    wait_for_session_interrupt_pending(&state, &start.session_id).await;

    // The CLI now issues a tool.click (mutating). The daemon must
    // reject it WITHOUT forwarding to the extension.
    let click_outcome = ipc
        .call::<_, serde_json::Value>(
            "click-after-interrupt",
            Method::ToolClick,
            Some(json!({
                "session_id": start.session_id,
                "ref": "fake-ref-1",
            })),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
    let err = click_outcome.expect_err("tool.click must be rejected");
    assert_eq!(
        err.code,
        ErrorCode::UserAborted,
        "rejected tool dispatch must surface UserAborted (got {:?})",
        err
    );

    // Crucially: the extension never saw a tool.click frame.
    assert_eq!(
        observed_click_count.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "tool.click must NOT have been forwarded to the extension"
    );

    responder.abort();
    handle.shutdown().await;
}

/// Read-only tool calls (snapshot / get_html / waits / tab_list)
/// must pass through transparently when a pending-interrupt
/// marker is set, AND must not consume the marker. This covers
/// the design rule that the agent should be able to observe page
/// state to ask the user a coherent question.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn read_only_tool_passes_through_without_consuming_interrupt_marker() {
    use futures_util::stream::StreamExt;

    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (ws_sink, ws_stream) = ws.split();
    let ws_sink = Arc::new(tokio::sync::Mutex::new(ws_sink));

    // Fake extension: replies to session_start, console, and snapshot
    // (read-only tools must succeed transparently). Records click count
    // — must remain 0 because the daemon should reject the click
    // without forwarding.
    let ws_sink_for_responder = Arc::clone(&ws_sink);
    let observed_click_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed_click_count_clone = Arc::clone(&observed_click_count);
    let responder = tokio::spawn(async move {
        let mut ws_stream = ws_stream;
        while let Some(Ok(msg)) = ws_stream.next().await {
            let text = match msg {
                tokio_tungstenite::tungstenite::protocol::Message::Text(t) => t,
                _ => continue,
            };
            let frame: Frame = match serde_json::from_str(&text) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if let Frame::Request(req) = frame {
                let body = match req.method {
                    Method::ToolSessionStart => ResponseBody::Ok(
                        serde_json::to_value(SessionStartResult {
                            agent_window_id: Some(1),
                        })
                        .unwrap(),
                    ),
                    Method::ToolConsole => ResponseBody::Ok(json!({
                        "tab_id": 7,
                        "entries": [],
                        "next_since": 0,
                        "truncated": false
                    })),
                    Method::ToolSnapshot => ResponseBody::Ok(json!({"ok": true})),
                    Method::ToolClick => {
                        observed_click_count_clone
                            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        continue;
                    }
                    _ => continue,
                };
                let reply = ResponseFrame { id: req.id, body };
                let mut g = ws_sink_for_responder.lock().await;
                g.send(tokio_tungstenite::tungstenite::protocol::Message::Text(
                    serde_json::to_string(&reply).unwrap(),
                ))
                .await
                .unwrap();
            }
        }
    });

    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    #[derive(serde::Serialize)]
    struct StartParams {
        browser_instance_id: Option<String>,
    }
    #[derive(serde::Deserialize, Debug)]
    struct StartReply {
        session_id: String,
    }
    let start: StartReply = ipc
        .call(
            "sess-1",
            Method::SessionStart,
            Some(StartParams {
                browser_instance_id: None,
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("session.start succeeded");

    // User clicks stop while idle.
    let event = EventFrame {
        event: EventKind::SessionUserInterrupt,
        payload: json!({"session_id": start.session_id.clone()}),
    };
    {
        let mut g = ws_sink.lock().await;
        g.send(tokio_tungstenite::tungstenite::protocol::Message::Text(
            serde_json::to_string(&event).unwrap(),
        ))
        .await
        .unwrap();
    }
    let state = handle.state();
    wait_for_session_interrupt_pending(&state, &start.session_id).await;

    // Read-only console must succeed AND must not consume the marker.
    let console_outcome = ipc
        .call::<_, serde_json::Value>(
            "console-after-interrupt",
            Method::ToolConsole,
            Some(json!({"session_id": start.session_id.clone()})),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
    assert!(
        console_outcome.is_ok(),
        "read-only tool.console must pass through transparently (got {:?})",
        console_outcome
    );

    // Existing read-only snapshot must still succeed after console,
    // proving console did not consume the marker.
    let snapshot_outcome = ipc
        .call::<_, serde_json::Value>(
            "snap-after-interrupt",
            Method::ToolSnapshot,
            Some(json!({"session_id": start.session_id})),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
    assert!(
        snapshot_outcome.is_ok(),
        "read-only tool.snapshot must pass through transparently (got {:?})",
        snapshot_outcome
    );

    // The mutating click that follows MUST still be rejected — the
    // marker survived the snapshot.
    let click_outcome = ipc
        .call::<_, serde_json::Value>(
            "click-after-snapshot",
            Method::ToolClick,
            Some(json!({
                "session_id": start.session_id,
                "ref": "fake-ref-2",
            })),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
    let err = click_outcome.expect_err("tool.click must be rejected");
    assert_eq!(err.code, ErrorCode::UserAborted, "got {:?}", err);
    assert_eq!(
        observed_click_count.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "tool.click must NOT have been forwarded after snapshot transparency"
    );

    responder.abort();
    handle.shutdown().await;
}

/// The pending-interrupt marker must survive an arbitrary delay
/// between user click and next mutating tool call. This is the
/// regression test for v2's core motivating bug: v1's 500ms time
/// window dropped interrupts whenever the LLM's thinking phase
/// took longer to respond than the window allowed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn user_interrupt_marker_survives_long_delay_before_next_tool() {
    use futures_util::stream::StreamExt;

    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let (ws_sink, ws_stream) = ws.split();
    let ws_sink = Arc::new(tokio::sync::Mutex::new(ws_sink));

    let ws_sink_for_responder = Arc::clone(&ws_sink);
    let observed_click_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed_click_count_clone = Arc::clone(&observed_click_count);
    let responder = tokio::spawn(async move {
        let mut ws_stream = ws_stream;
        while let Some(Ok(msg)) = ws_stream.next().await {
            let text = match msg {
                tokio_tungstenite::tungstenite::protocol::Message::Text(t) => t,
                _ => continue,
            };
            let frame: Frame = match serde_json::from_str(&text) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if let Frame::Request(req) = frame {
                let body = match req.method {
                    Method::ToolSessionStart => ResponseBody::Ok(
                        serde_json::to_value(SessionStartResult {
                            agent_window_id: Some(1),
                        })
                        .unwrap(),
                    ),
                    Method::ToolClick => {
                        observed_click_count_clone
                            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        continue;
                    }
                    _ => continue,
                };
                let reply = ResponseFrame { id: req.id, body };
                let mut g = ws_sink_for_responder.lock().await;
                g.send(tokio_tungstenite::tungstenite::protocol::Message::Text(
                    serde_json::to_string(&reply).unwrap(),
                ))
                .await
                .unwrap();
            }
        }
    });

    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    #[derive(serde::Serialize)]
    struct StartParams {
        browser_instance_id: Option<String>,
    }
    #[derive(serde::Deserialize, Debug)]
    struct StartReply {
        session_id: String,
    }
    let start: StartReply = ipc
        .call(
            "sess-1",
            Method::SessionStart,
            Some(StartParams {
                browser_instance_id: None,
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("session.start succeeded");

    let event = EventFrame {
        event: EventKind::SessionUserInterrupt,
        payload: json!({"session_id": start.session_id.clone()}),
    };
    {
        let mut g = ws_sink.lock().await;
        g.send(tokio_tungstenite::tungstenite::protocol::Message::Text(
            serde_json::to_string(&event).unwrap(),
        ))
        .await
        .unwrap();
    }

    // Sleep WELL beyond v1's old 500ms window. Production LLM
    // thinking phases routinely run 3-10 seconds.
    tokio::time::sleep(Duration::from_secs(2)).await;

    let click_outcome = ipc
        .call::<_, serde_json::Value>(
            "click-after-long-delay",
            Method::ToolClick,
            Some(json!({
                "session_id": start.session_id,
                "ref": "fake-ref-3",
            })),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
    let err = click_outcome.expect_err("tool.click after long delay must be rejected");
    assert_eq!(err.code, ErrorCode::UserAborted);
    assert_eq!(
        observed_click_count.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "tool.click must NOT have reached the extension"
    );

    responder.abort();
    handle.shutdown().await;
}
