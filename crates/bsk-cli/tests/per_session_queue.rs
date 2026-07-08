//! M6.5 integration: per-session serial dispatch queue.
//!
//! Properties exercised:
//! 1. Inside one session, only one `tool.*` dispatch is active at a time;
//!    concurrent callers fast-fail with `session_busy`, while later calls
//!    succeed after the active command completes.
//! 2. Two sessions on the same browser run in parallel and never block
//!    each other — releasing one session's gate must not unblock the
//!    other's response.

mod support;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bsk::daemon::queue::DispatchError;
use bsk::daemon::{self, DaemonConfig};
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::{SessionStartParams, SessionStartResult};
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, Frame, Method, RequestFrame, ResponseBody, ResponseFrame,
};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde::Deserialize;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, mpsc};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

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
    let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let sock = tempfile_path("bsk-test-queue");
    let handle = daemon::run(DaemonConfig::new(port), Some(sock.clone()))
        .await
        .unwrap();
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
        min_compatible_peer: Some("0.1.0-dev.0".parse().unwrap()),
        min_compatible_protocol: Some("1.0".into()),
        label: "Test".into(),
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
        _ => panic!("expected text frame"),
    };
    let resp: ResponseFrame = serde_json::from_str(&text).unwrap();
    match resp.body {
        ResponseBody::Ok(v) => serde_json::from_value(v).unwrap(),
        ResponseBody::Err(e) => panic!("handshake rejected: {e:?}"),
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Drive a fake extension WS that:
/// * auto-replies to `tool.session_start` / `tool.session_stop` (so the
///   M5 round-trip works without test interaction),
/// * for every other request, forwards it through `requests_tx` and
///   awaits a reply payload from `replies_rx`,
/// * uses split sink/stream so the reader can park on `.next()` without
///   holding any writer-side mutex (avoiding a self-deadlock when the
///   test driver wants to push a reply).
async fn run_fake_extension(
    ws: Ws,
    next_window_id: Arc<Mutex<i64>>,
    requests_tx: mpsc::UnboundedSender<(String, String)>, // (rpc_id, payload tag)
    mut replies_rx: mpsc::UnboundedReceiver<(String, serde_json::Value)>, // (rpc_id, body)
) {
    let (writer, reader) = ws.split();
    let writer: Arc<Mutex<SplitSink<Ws, Message>>> = Arc::new(Mutex::new(writer));
    let mut reader: SplitStream<Ws> = reader;

    let reader_task = {
        let writer = Arc::clone(&writer);
        let next_window_id = Arc::clone(&next_window_id);
        tokio::spawn(async move {
            while let Some(Ok(msg)) = reader.next().await {
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
                            let _: SessionStartParams =
                                serde_json::from_value(req.params.clone().unwrap()).unwrap();
                            let id = {
                                let mut g = next_window_id.lock().await;
                                let v = *g;
                                *g += 1;
                                v
                            };
                            let reply = ResponseFrame {
                                id: req.id.clone(),
                                body: ResponseBody::Ok(
                                    serde_json::to_value(SessionStartResult {
                                        agent_window_id: Some(id),
                                    })
                                    .unwrap(),
                                ),
                            };
                            let mut w = writer.lock().await;
                            w.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                                .await
                                .unwrap();
                        }
                        Method::ToolSessionStop => {
                            let reply = ResponseFrame {
                                id: req.id.clone(),
                                body: ResponseBody::Ok(json!({})),
                            };
                            let mut w = writer.lock().await;
                            w.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                                .await
                                .unwrap();
                        }
                        _ => {
                            let tag = req
                                .params
                                .as_ref()
                                .and_then(|p| p.get("tag"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let _ = requests_tx.send((req.id.clone(), tag));
                        }
                    }
                }
            }
        })
    };

    let replies_task = tokio::spawn(async move {
        while let Some((rpc_id, body)) = replies_rx.recv().await {
            let frame = ResponseFrame {
                id: rpc_id,
                body: ResponseBody::Ok(body),
            };
            let mut w = writer.lock().await;
            w.send(Message::Text(serde_json::to_string(&frame).unwrap()))
                .await
                .unwrap();
        }
    });
    let _ = reader_task.await;
    replies_task.abort();
}

#[derive(Deserialize)]
struct StartReply {
    session_id: String,
}

async fn ipc_session_start(sock: &PathBuf) -> String {
    let mut ipc = bsk::ipc_client::IpcClient::connect(sock).await.unwrap();
    let r: StartReply = ipc
        .call::<(), _>("qs", Method::SessionStart, None, Duration::from_secs(5))
        .await
        .unwrap()
        .expect("session.start ok");
    r.session_id
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn same_session_dispatches_run_after_previous_completes() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let window_counter = Arc::new(Mutex::new(1_i64));
    let (req_tx, mut req_rx) = mpsc::unbounded_channel::<(String, String)>();
    let (reply_tx, reply_rx) = mpsc::unbounded_channel::<(String, serde_json::Value)>();
    tokio::spawn(run_fake_extension(
        ws,
        Arc::clone(&window_counter),
        req_tx,
        reply_rx,
    ));

    let session_id = ipc_session_start(&sock).await;
    let state = handle.state();

    // Submit jobs one at a time: each dispatch must finish (freeing the
    // session busy slot) before the next is released.
    let total = 5;
    for i in 0..total {
        let queues = Arc::clone(&state.tool_queues);
        let sid = bsk::daemon::sessions::SessionId(session_id.clone());
        let i = i as u32;
        let dispatch_task = tokio::spawn(async move {
            queues
                .dispatch(
                    &sid,
                    Method::ToolTabList,
                    json!({"session_id": sid.0, "tag": format!("job-{i}")}),
                    Duration::from_secs(5),
                    None,
                )
                .await
        });
        let (rpc_id, tag) = tokio::time::timeout(Duration::from_secs(2), req_rx.recv())
            .await
            .expect("request did not reach extension")
            .expect("request channel closed");
        assert_eq!(tag, format!("job-{i}"));
        reply_tx.send((rpc_id, json!({"acked": true}))).unwrap();
        let r = dispatch_task.await.unwrap();
        assert!(r.is_ok(), "dispatch should succeed, got {r:?}");
    }

    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_stop_fast_fails_while_tool_is_in_flight() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let window_counter = Arc::new(Mutex::new(1_i64));
    let (req_tx, mut req_rx) = mpsc::unbounded_channel::<(String, String)>();
    let (reply_tx, reply_rx) = mpsc::unbounded_channel::<(String, serde_json::Value)>();
    tokio::spawn(run_fake_extension(
        ws,
        Arc::clone(&window_counter),
        req_tx,
        reply_rx,
    ));

    let session_id = ipc_session_start(&sock).await;
    let state = handle.state();
    let sid = bsk::daemon::sessions::SessionId(session_id.clone());

    let tool_task = {
        let queues = Arc::clone(&state.tool_queues);
        let sid = sid.clone();
        tokio::spawn(async move {
            queues
                .dispatch(
                    &sid,
                    Method::ToolSnapshot,
                    json!({"session_id": sid.0, "tag": "slow-tool"}),
                    Duration::from_secs(5),
                    None,
                )
                .await
        })
    };

    let (tool_rpc_id, tag) = tokio::time::timeout(Duration::from_secs(2), req_rx.recv())
        .await
        .expect("slow tool did not reach extension")
        .expect("request channel closed");
    assert_eq!(tag, "slow-tool");

    let stop_result = bsk::daemon::sessions::stop_session(
        &state.browsers,
        &state.sessions,
        &state.tool_queues,
        &state.session_interrupts,
        &sid,
        Duration::from_secs(5),
    )
    .await;
    assert!(
        matches!(
            stop_result,
            Err(bsk::daemon::sessions::StopSessionError::SessionBusy)
        ),
        "session.stop should fast-fail while a tool is active, got {stop_result:?}"
    );
    assert!(
        state.tool_queues.is_accepting(&sid),
        "session should remain accepting after busy stop rejection"
    );

    let late = state
        .tool_queues
        .dispatch(
            &sid,
            Method::ToolTabList,
            json!({"session_id": session_id, "tag": "late-tool"}),
            Duration::from_secs(1),
            None,
        )
        .await;
    assert!(
        matches!(late, Err(DispatchError::SessionBusy)),
        "new tools should be rejected while session is busy, got {late:?}"
    );

    reply_tx
        .send((tool_rpc_id, json!({"snapshot": "done"})))
        .unwrap();
    assert!(tool_task.await.unwrap().is_ok());

    bsk::daemon::sessions::stop_session(
        &state.browsers,
        &state.sessions,
        &state.tool_queues,
        &state.session_interrupts,
        &sid,
        Duration::from_secs(5),
    )
    .await
    .expect("session.stop ok after tool completes");
    assert!(state.sessions.get(&sid).is_none());
    assert_eq!(state.tool_queues.len(), 0);

    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_same_session_dispatch_returns_session_busy_immediately() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let window_counter = Arc::new(Mutex::new(1_i64));
    let (req_tx, mut req_rx) = mpsc::unbounded_channel::<(String, String)>();
    let (reply_tx, reply_rx) = mpsc::unbounded_channel::<(String, serde_json::Value)>();
    tokio::spawn(run_fake_extension(
        ws,
        Arc::clone(&window_counter),
        req_tx,
        reply_rx,
    ));

    let session_id = ipc_session_start(&sock).await;
    let state = handle.state();
    let sid = bsk::daemon::sessions::SessionId(session_id.clone());

    let first_task = {
        let queues = Arc::clone(&state.tool_queues);
        let sid = sid.clone();
        tokio::spawn(async move {
            queues
                .dispatch(
                    &sid,
                    Method::ToolTabList,
                    json!({"session_id": sid.0, "tag": "held-open"}),
                    Duration::from_secs(5),
                    None,
                )
                .await
        })
    };

    let (first_rpc_id, tag) = tokio::time::timeout(Duration::from_secs(2), req_rx.recv())
        .await
        .expect("first tool did not reach extension")
        .expect("request channel closed");
    assert_eq!(tag, "held-open");

    let busy = tokio::time::timeout(
        Duration::from_millis(200),
        state.tool_queues.dispatch(
            &sid,
            Method::ToolTabList,
            json!({"session_id": session_id, "tag": "should-fail"}),
            Duration::from_secs(5),
            None,
        ),
    )
    .await
    .expect("busy dispatch should fast-fail immediately");
    assert!(
        matches!(busy, Err(DispatchError::SessionBusy)),
        "second dispatch should fast-fail, got {busy:?}"
    );
    let rpc = DispatchError::SessionBusy.into_rpc();
    assert_eq!(rpc.code, ErrorCode::Timeout);
    assert_eq!(
        rpc.data
            .as_ref()
            .and_then(|d| d.get("reason"))
            .and_then(|v| v.as_str()),
        Some(bsk::rpc_reason::SESSION_BUSY)
    );

    reply_tx
        .send((first_rpc_id, json!({"acked": true})))
        .unwrap();
    assert!(first_task.await.unwrap().is_ok());

    let after_task = {
        let queues = Arc::clone(&state.tool_queues);
        let sid = sid.clone();
        let session_id = session_id.clone();
        tokio::spawn(async move {
            queues
                .dispatch(
                    &sid,
                    Method::ToolTabList,
                    json!({"session_id": session_id, "tag": "after-first"}),
                    Duration::from_secs(5),
                    None,
                )
                .await
        })
    };
    let (after_rpc_id, after_tag) = tokio::time::timeout(Duration::from_secs(2), req_rx.recv())
        .await
        .expect("after-first request did not reach extension")
        .expect("request channel closed");
    assert_eq!(after_tag, "after-first");
    reply_tx
        .send((after_rpc_id, json!({"acked": true})))
        .unwrap();
    let after = after_task.await.unwrap();
    assert!(
        after.is_ok(),
        "dispatch should succeed after first completes, got {after:?}"
    );

    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatches_for_different_sessions_do_not_block_each_other() {
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;
    let window_counter = Arc::new(Mutex::new(1_i64));
    let (req_tx, mut req_rx) = mpsc::unbounded_channel::<(String, String)>();
    let (reply_tx, reply_rx) = mpsc::unbounded_channel::<(String, serde_json::Value)>();
    tokio::spawn(run_fake_extension(
        ws,
        Arc::clone(&window_counter),
        req_tx,
        reply_rx,
    ));

    let session_a = ipc_session_start(&sock).await;
    let session_b = ipc_session_start(&sock).await;
    assert_ne!(session_a, session_b);
    let state = handle.state();

    // Fire one job per session simultaneously. They must both arrive at
    // the extension before either is replied to (proves cross-session
    // parallelism).
    let queues_for_a = Arc::clone(&state.tool_queues);
    let sid_a = bsk::daemon::sessions::SessionId(session_a.clone());
    let task_a = tokio::spawn(async move {
        queues_for_a
            .dispatch(
                &sid_a,
                Method::ToolTabList,
                json!({"session_id": sid_a.0, "tag": "from-a"}),
                Duration::from_secs(5),
                None,
            )
            .await
    });
    let queues_for_b = Arc::clone(&state.tool_queues);
    let sid_b = bsk::daemon::sessions::SessionId(session_b.clone());
    let task_b = tokio::spawn(async move {
        queues_for_b
            .dispatch(
                &sid_b,
                Method::ToolTabList,
                json!({"session_id": sid_b.0, "tag": "from-b"}),
                Duration::from_secs(5),
                None,
            )
            .await
    });

    let mut seen = HashSet::new();
    let mut rpc_ids = Vec::new();
    for _ in 0..2 {
        let (rpc_id, tag) = tokio::time::timeout(Duration::from_secs(2), req_rx.recv())
            .await
            .expect("expected inbound request")
            .unwrap();
        seen.insert(tag);
        rpc_ids.push(rpc_id);
    }
    assert!(
        seen.contains("from-a") && seen.contains("from-b"),
        "both sessions' requests must be forwarded in parallel, saw {seen:?}"
    );

    for id in rpc_ids {
        reply_tx.send((id, json!({"acked": true}))).unwrap();
    }
    let _ = task_a.await.unwrap();
    let _ = task_b.await.unwrap();

    handle.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_returns_session_not_found_for_unknown_session() {
    let (handle, _sock) = spawn_daemon().await;
    let queues = Arc::clone(&handle.state().tool_queues);
    let result = queues
        .dispatch(
            &bsk::daemon::sessions::SessionId("zzzz".into()),
            Method::ToolTabList,
            json!({"session_id": "zzzz"}),
            Duration::from_secs(1),
            None,
        )
        .await;
    match result {
        Err(DispatchError::SessionNotFound) => {}
        other => panic!("expected SessionNotFound, got {other:?}"),
    }
    // And the surfaced RpcError carries `not_found`.
    let rpc = DispatchError::SessionNotFound.into_rpc();
    assert_eq!(rpc.code, ErrorCode::NotFound);
    handle.shutdown().await;
}
