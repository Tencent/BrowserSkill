//! M10.2: end-to-end coverage of cancel forwarding from CLI → daemon
//! → extension. The fake extension never replies to a slow tool;
//! instead it waits for the daemon's `cancel` frame, then answers the
//! original RPC with `cancelled` so the CLI helper resolves promptly.

mod support;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::SessionStartResult;
use bsk_protocol::{
    BrowserPeerInfo, CancelParams, CancelResult, ErrorCode, Frame, Method, RequestFrame,
    ResponseBody, ResponseFrame, RpcError,
};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::json;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

use support::{wait_for_abort_registered, wait_for_inflight_forwarded, wait_until};

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
    let sock = tempfile_path("bsk-test-cancel");
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

#[tokio::test]
async fn wait_ms_cancel_resolves_locally_via_abort_registry() {
    // Sanity check that the M9.3 wait_ms path still answers the
    // existing AbortRegistry-based cancel surface (regression).
    let (handle, sock) = spawn_daemon().await;
    let mut ipc = IpcClient::connect(&sock).await.unwrap();

    // Send a long wait_ms with a known rpc_id we can reference.
    let wait_id = "wait-cancel-1";
    #[derive(serde::Serialize)]
    struct WaitParams {
        duration_ms: u64,
    }
    let mut sender = IpcClient::connect(&sock).await.unwrap();
    let waiter = tokio::spawn(async move {
        sender
            .call_with_id::<WaitParams, serde_json::Value>(
                wait_id.into(),
                Method::ToolWaitMs,
                Some(WaitParams {
                    duration_ms: 60_000,
                }),
                Duration::from_secs(5),
            )
            .await
    });

    let state = handle.state();
    wait_for_abort_registered(&state, &wait_id.into()).await;

    let cancel: CancelResult = ipc
        .call(
            "cancel-1",
            Method::Cancel,
            Some(CancelParams {
                rpc_id: wait_id.into(),
            }),
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .expect("cancel rpc must succeed");
    assert!(
        cancel.cancelled,
        "wait_ms registered locally; cancel must trip the AbortRegistry"
    );

    let outcome = waiter.await.unwrap().unwrap();
    let err = outcome.expect_err("wait_ms should resolve as cancelled");
    assert_eq!(err.code, ErrorCode::Cancelled);

    handle.shutdown().await;
}

#[tokio::test]
async fn cancel_forwards_to_extension_when_tool_is_inflight() {
    // Spin up daemon, attach a fake extension that:
    //   * answers `tool.session_start` immediately with a fake window id.
    //   * NEVER answers `tool.snapshot` until it sees a `cancel` frame
    //     from the daemon, at which point it replies to the original
    //     `tool.snapshot` with the structured `cancelled` error.
    //
    // The CLI side issues the cancel through a fresh IPC connection
    // (mimicking the SIGINT helper) and must observe `cancelled` from
    // the original snapshot RPC.
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;

    let ws = Arc::new(tokio::sync::Mutex::new(ws));
    let ws_clone = Arc::clone(&ws);
    let responder = tokio::spawn(async move {
        // ws_to_snapshot maps the WS-side rpc_id of the still-pending
        // tool.snapshot call so we can echo it back after we observe
        // the daemon's cancel frame.
        let mut pending_snapshot: Option<String> = None;
        loop {
            let next = {
                let mut g = ws_clone.lock().await;
                g.next().await
            };
            let msg = match next {
                Some(Ok(m)) => m,
                _ => break,
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
                        let mut g = ws_clone.lock().await;
                        g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                            .await
                            .unwrap();
                    }
                    Method::ToolSnapshot => {
                        // Stash the WS rpc_id; reply only after cancel arrives.
                        pending_snapshot = Some(req.id);
                    }
                    Method::Cancel => {
                        // The daemon forwarded our cancel — answer the
                        // original snapshot now with `cancelled`.
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
                            let mut g = ws_clone.lock().await;
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

    // Open one IPC client for the snapshot caller and another for the
    // cancel sender — the SIGINT helper does the same in production.
    let mut snap_ipc = IpcClient::connect(&sock).await.unwrap();
    let mut cancel_ipc = IpcClient::connect(&sock).await.unwrap();

    // Start a session through the daemon's CLI-facing path.
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

    // Drive the slow `tool.snapshot` on its own connection so we can
    // race a cancel through the cancel_ipc handle.
    let snapshot_id = "snap-cancel-1".to_string();
    let snapshot_id_clone = snapshot_id.clone();
    let session_id = start.session_id.clone();
    let snapshot_task = tokio::spawn(async move {
        snap_ipc
            .call_with_id::<_, serde_json::Value>(
                snapshot_id_clone,
                Method::ToolSnapshot,
                Some(json!({"session_id": session_id})),
                Duration::from_secs(10),
            )
            .await
    });

    let state = handle.state();
    wait_for_inflight_forwarded(&state, &snapshot_id).await;

    // Send the cancel.
    let cancel: CancelResult = cancel_ipc
        .call(
            "cancel-c1",
            Method::Cancel,
            Some(CancelParams {
                rpc_id: snapshot_id.clone(),
            }),
            Duration::from_secs(3),
        )
        .await
        .unwrap()
        .expect("cancel rpc succeeded");
    assert!(
        cancel.cancelled,
        "cancel must hit the inflight entry and forward to extension"
    );

    let outcome = tokio::time::timeout(Duration::from_secs(5), snapshot_task)
        .await
        .expect("snapshot did not resolve")
        .unwrap()
        .unwrap();
    let err = outcome.expect_err("snapshot must surface cancelled");
    assert_eq!(err.code, ErrorCode::Cancelled);

    responder.abort();
    handle.shutdown().await;
}

/// Process-wide hook serialiser: every test that flips the
/// `__set_promote_delay_for_tests` static grabs this Mutex first so a
/// parallel `cargo test --test cancel_forwarding` cannot read a stale
/// delay set by a different test case.
static PROMOTE_HOOK_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// RAII guard that arms the inflight test hook for the lifetime of a
/// single integration test. Resets the hook to `0` on drop so a
/// pre-fix race window does not leak into unrelated tests.
struct PromoteDelayHook {
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl PromoteDelayHook {
    fn enable(delay: Duration) -> Self {
        let lock = PROMOTE_HOOK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        bsk::daemon::inflight::__set_promote_delay_for_tests(delay);
        Self { _lock: lock }
    }
}

impl Drop for PromoteDelayHook {
    fn drop(&mut self) {
        bsk::daemon::inflight::__set_promote_delay_for_tests(Duration::from_millis(0));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_arriving_during_promote_critical_section_keeps_request_cancel_invariants() {
    // Round 2 C1 fault-injection: widen the pre-fix race window by
    // making `promote_to_forwarded_with` sleep 200ms BEFORE acquiring
    // the entry's inner lock (via `__set_promote_delay_for_tests`).
    // That sleep recreates the exact window the bug lived in: the old
    // `promote_to_forwarded` read the cancel atomic, then locked the
    // inner Mutex; a cancel landing between those two steps used to
    // snapshot None/None, trip the AbortToken, and report "queued"
    // — the IPC handler would skip forwarding a WS cancel even though
    // the worker was about to commit the promotion and emit the WS
    // request, so the CLI got synthesised `cancelled` while the
    // extension still ran the side-effecting tool. With the hook
    // armed, a concurrent cancel reliably wedges itself into that
    // window.
    //
    // After the fix, the cancelled flag lives under the inner Mutex
    // and is checked there, so cancel and promote serialise through
    // the lock. The two possible outcomes under fault injection are
    // both safe:
    //   * cancel-first (the common case here, since cancel arrives
    //     ~50ms in while promote is still sleeping pre-lock):
    //     cancel acquires the inner lock first, sets cancelled,
    //     returns snapshot None/None → the IPC handler skips WS
    //     forwarding; promote later locks, observes cancelled,
    //     returns `Cancelled`, and the dispatch closure NEVER runs
    //     → no WS request frame leaves the daemon.
    //   * promote-first (only if cancel-IPC takes longer than the
    //     sleep to round-trip): snapshot reaches the extension, then
    //     a WS cancel frame follows for the same rpc_id, preserving
    //     "request-before-cancel" wire order.
    //
    // The invariant under either winner: the extension's tool.snapshot
    // and cancel counts MUST match. Pre-fix this assertion would have
    // tripped (snapshot=1, cancel=0) for the cancel-first case.
    let _hook = PromoteDelayHook::enable(Duration::from_millis(200));

    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;

    use std::sync::atomic::{AtomicUsize, Ordering as AOrdering};
    let ws = Arc::new(tokio::sync::Mutex::new(ws));
    let snapshots_seen = Arc::new(AtomicUsize::new(0));
    let cancels_seen = Arc::new(AtomicUsize::new(0));
    let snapshots_clone = Arc::clone(&snapshots_seen);
    let cancels_clone = Arc::clone(&cancels_seen);
    let ws_clone = Arc::clone(&ws);
    let responder = tokio::spawn(async move {
        let mut pending_snapshot: Option<String> = None;
        loop {
            let next = {
                let mut g = ws_clone.lock().await;
                g.next().await
            };
            let msg = match next {
                Some(Ok(m)) => m,
                _ => break,
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
                        let mut g = ws_clone.lock().await;
                        g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                            .await
                            .unwrap();
                    }
                    Method::ToolSnapshot => {
                        snapshots_clone.fetch_add(1, AOrdering::SeqCst);
                        pending_snapshot = Some(req.id);
                    }
                    Method::Cancel => {
                        cancels_clone.fetch_add(1, AOrdering::SeqCst);
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
                            let mut g = ws_clone.lock().await;
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

    let mut snap_ipc = IpcClient::connect(&sock).await.unwrap();
    let mut cancel_ipc = IpcClient::connect(&sock).await.unwrap();

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
            "sess-r2c1",
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

    let snapshot_id = "snap-r2c1-race".to_string();
    let snapshot_id_clone = snapshot_id.clone();
    let snap_session = session_id.clone();
    let snapshot_task = tokio::spawn(async move {
        snap_ipc
            .call_with_id::<_, serde_json::Value>(
                snapshot_id_clone,
                Method::ToolSnapshot,
                Some(json!({"session_id": snap_session})),
                Duration::from_secs(10),
            )
            .await
    });

    // Land cancel ~50ms in, while the worker is still parked inside
    // the 200ms-wide promote critical section. The cancel attempt
    // must serialise on the entry's inner Mutex; with the pre-fix
    // race window this is exactly where a queued snapshot could trip
    // the AbortToken and skip WS forwarding.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let cancel: CancelResult = cancel_ipc
        .call(
            "cancel-r2c1-race",
            Method::Cancel,
            Some(CancelParams {
                rpc_id: snapshot_id.clone(),
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("cancel rpc succeeded");
    assert!(cancel.cancelled, "cancel rpc must report cancelled=true");

    // CLI side of the snapshot RPC must resolve as Cancelled.
    let snap_outcome = tokio::time::timeout(Duration::from_secs(8), snapshot_task)
        .await
        .expect("snapshot did not resolve")
        .unwrap()
        .unwrap();
    let snap_err = snap_outcome.expect_err("snapshot must surface cancelled");
    assert_eq!(snap_err.code, ErrorCode::Cancelled);

    let snapshots_clone = Arc::clone(&snapshots_seen);
    let cancels_clone = Arc::clone(&cancels_seen);
    wait_until(
        "extension snapshot/cancel counters to match",
        Duration::from_secs(2),
        || snapshots_clone.load(AOrdering::SeqCst) == cancels_clone.load(AOrdering::SeqCst),
    )
    .await;

    let snapshots = snapshots_seen.load(AOrdering::SeqCst);
    let cancels = cancels_seen.load(AOrdering::SeqCst);
    assert_eq!(
        snapshots, cancels,
        "extension must observe matching tool.snapshot / cancel counts \
         (round 2 C1): snapshots={snapshots}, cancels={cancels}"
    );

    responder.abort();
    handle.shutdown().await;
}

#[tokio::test]
async fn cancel_for_unknown_rpc_id_returns_false() {
    let (handle, sock) = spawn_daemon().await;
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let cancel: CancelResult = ipc
        .call(
            "cancel-ghost",
            Method::Cancel,
            Some(CancelParams {
                rpc_id: "nope".into(),
            }),
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .expect("cancel rpc succeeded");
    assert!(!cancel.cancelled);
    handle.shutdown().await;
}

#[tokio::test]
async fn concurrent_tool_call_returns_session_busy_while_slow_rpc_inflight() {
    // With session busy fast-fail, a second tool RPC submitted while
    // the worker is occupied returns `session_busy` immediately
    // instead of queuing behind the slow call. Cancel still unblocks
    // the in-flight RPC through the existing forwarded-cancel path.
    use std::sync::atomic::{AtomicUsize, Ordering as AOrdering};
    let (handle, sock) = spawn_daemon().await;
    let mut ws = connect_ext(handle.ws_addr()).await;
    let _ = handshake_as_ext(&mut ws).await;

    let ws = Arc::new(tokio::sync::Mutex::new(ws));
    let snapshots_seen = Arc::new(AtomicUsize::new(0));
    let snapshots_seen_clone = Arc::clone(&snapshots_seen);
    let ws_clone = Arc::clone(&ws);
    let responder = tokio::spawn(async move {
        let mut pending_snapshot: Option<String> = None;
        loop {
            let next = {
                let mut g = ws_clone.lock().await;
                g.next().await
            };
            let msg = match next {
                Some(Ok(m)) => m,
                _ => break,
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
                        let mut g = ws_clone.lock().await;
                        g.send(Message::Text(serde_json::to_string(&reply).unwrap()))
                            .await
                            .unwrap();
                    }
                    Method::ToolSnapshot => {
                        snapshots_seen_clone.fetch_add(1, AOrdering::SeqCst);
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
                            let mut g = ws_clone.lock().await;
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

    let mut slow_ipc = IpcClient::connect(&sock).await.unwrap();
    let mut busy_ipc = IpcClient::connect(&sock).await.unwrap();
    let mut cancel_ipc = IpcClient::connect(&sock).await.unwrap();

    #[derive(serde::Serialize)]
    struct StartParams {
        browser_instance_id: Option<String>,
    }
    #[derive(serde::Deserialize, Debug)]
    struct StartReply {
        session_id: String,
    }
    let start: StartReply = slow_ipc
        .call(
            "sess-cq",
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

    let slow_id = "snap-slow".to_string();
    let slow_session = session_id.clone();
    let slow_handle = tokio::spawn(async move {
        slow_ipc
            .call_with_id::<_, serde_json::Value>(
                slow_id,
                Method::ToolSnapshot,
                Some(json!({"session_id": slow_session})),
                Duration::from_secs(10),
            )
            .await
    });

    let snapshots_seen_for_wait = Arc::clone(&snapshots_seen);
    wait_until(
        "slow snapshot forwarded to extension",
        Duration::from_secs(2),
        || snapshots_seen_for_wait.load(AOrdering::SeqCst) >= 1,
    )
    .await;

    let busy_id = "snap-busy".to_string();
    let busy_session = session_id.clone();
    let busy_outcome = tokio::time::timeout(
        Duration::from_millis(200),
        busy_ipc.call_with_id::<_, serde_json::Value>(
            busy_id,
            Method::ToolSnapshot,
            Some(json!({"session_id": busy_session})),
            Duration::from_secs(10),
        ),
    )
    .await
    .expect("busy RPC should fast-fail immediately")
    .unwrap();
    let busy_err = busy_outcome.expect_err("concurrent snapshot must fast-fail as session_busy");
    assert_eq!(busy_err.code, ErrorCode::Timeout);
    assert_eq!(
        busy_err
            .data
            .as_ref()
            .and_then(|d| d.get("reason"))
            .and_then(|v| v.as_str()),
        Some(bsk::rpc_reason::SESSION_BUSY)
    );

    let cancel_slow: CancelResult = cancel_ipc
        .call(
            "cancel-slow",
            Method::Cancel,
            Some(CancelParams {
                rpc_id: "snap-slow".into(),
            }),
            Duration::from_secs(3),
        )
        .await
        .unwrap()
        .expect("cancel slow rpc succeeds");
    assert!(cancel_slow.cancelled);

    let slow_outcome = tokio::time::timeout(Duration::from_secs(5), slow_handle)
        .await
        .expect("slow snapshot did not resolve")
        .unwrap()
        .unwrap();
    let slow_err = slow_outcome.expect_err("slow snapshot must surface cancelled");
    assert_eq!(slow_err.code, ErrorCode::Cancelled);

    assert_eq!(
        snapshots_seen.load(AOrdering::SeqCst),
        1,
        "only the slow snapshot must reach the extension"
    );

    responder.abort();
    handle.shutdown().await;
}
