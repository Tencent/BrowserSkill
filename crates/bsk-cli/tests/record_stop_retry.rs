mod support;

use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::Poll;
use std::time::{Duration, Instant};

use bsk::daemon::info::DaemonInfo;
use bsk::daemon::ipc::{self, DaemonStatus, RpcHandler};
use bsk::daemon::paths::BSK_HOME_ENV;
use bsk::daemon::state::{DAEMON_VERSION, PROTOCOL_VERSION};
use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::{
    RecordStopResult, RecordedTrace, RecorderInfo, SessionStartParams, SessionStartResult,
    StopReason, TraceEntry, TraceStateV3, TraceV3, VOM_FORMAT_VERSION,
};
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, Frame, Method, RequestFrame, ResponseBody, ResponseFrame, RpcError,
};
use futures_util::{FutureExt, SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

const TEST_EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn bsk_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_bsk"))
}

async fn connect_extension(addr: std::net::SocketAddr) -> Ws {
    let origin = format!("chrome-extension://{TEST_EXT_ID}");
    let request = Request::builder()
        .method("GET")
        .uri(format!("ws://{addr}/"))
        .header("Host", addr.to_string())
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header("Origin", origin)
        .body(())
        .unwrap();
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

async fn handshake(ws: &mut Ws) {
    let request = RequestFrame {
        id: "handshake".into(),
        method: Method::SystemHandshake,
        params: Some(
            serde_json::to_value(HandshakeParams {
                client: "browser-skill-extension".into(),
                version: "0.1.10".parse().unwrap(),
                protocol_version: bsk::daemon::state::PROTOCOL_VERSION.into(),
                instance_id: TEST_EXT_ID.into(),
                browser: BrowserPeerInfo {
                    name: "chrome".into(),
                    version: "131.0".into(),
                },
                min_compatible_peer: Some("0.1.10".parse().unwrap()),
                min_compatible_protocol: Some("1.1".into()),
                label: "Record stop retry test".into(),
            })
            .unwrap(),
        ),
    };
    ws.send(Message::Text(serde_json::to_string(&request).unwrap()))
        .await
        .unwrap();
    let Message::Text(response) = ws.next().await.unwrap().unwrap() else {
        panic!("expected text handshake response");
    };
    let response: ResponseFrame = serde_json::from_str(&response).unwrap();
    let ResponseBody::Ok(value) = response.body else {
        panic!("handshake failed");
    };
    let _: HandshakeResult = serde_json::from_value(value).unwrap();
}

fn sample_trace() -> TraceV3 {
    TraceV3 {
        requests: None,
        version: 3,
        purpose: Some("retry record stop".into()),
        started_at: Some("2026-08-12T10:00:00Z".into()),
        recorded_at: "2026-08-12T10:01:00Z".into(),
        stopped_by: StopReason::CliStop,
        entry: TraceEntry {
            start_url: "https://example.com/".into(),
        },
        recorder: RecorderInfo {
            bsk: "0.1.10".into(),
            vom: VOM_FORMAT_VERSION,
        },
        states: vec![TraceStateV3 {
            id: "s1".into(),
            url: "https://example.com/".into(),
            title: Some("Example".into()),
            body: "@vom 1\nL1 page".into(),
            truncated: false,
        }],
        steps: vec![],
    }
}

fn run_extension(
    mut ws: Ws,
    record_stop_calls: Arc<AtomicUsize>,
    session_stop_calls: Arc<AtomicUsize>,
) {
    tokio::spawn(async move {
        while let Some(Ok(Message::Text(text))) = ws.next().await {
            let Ok(Frame::Request(request)) = serde_json::from_str::<Frame>(&text) else {
                continue;
            };
            let body = match request.method {
                Method::ToolSessionStart => {
                    let _: SessionStartParams =
                        serde_json::from_value(request.params.clone().unwrap()).unwrap();
                    ResponseBody::Ok(
                        serde_json::to_value(SessionStartResult {
                            interaction: None,
                            agent_window_id: Some(100),
                        })
                        .unwrap(),
                    )
                }
                Method::ToolRecordStop => {
                    if record_stop_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        ResponseBody::Err(RpcError {
                            code: ErrorCode::ProtocolError,
                            message: "recording remains active; retry record stop".into(),
                            data: Some(json!({ "recording": true, "retryable": true })),
                        })
                    } else {
                        ResponseBody::Ok(
                            serde_json::to_value(RecordStopResult {
                                trace: RecordedTrace::V3(sample_trace()),
                            })
                            .unwrap(),
                        )
                    }
                }
                Method::ToolSessionStop => {
                    session_stop_calls.fetch_add(1, Ordering::SeqCst);
                    ResponseBody::Ok(json!({}))
                }
                _ => ResponseBody::Err(RpcError {
                    code: ErrorCode::ProtocolError,
                    message: format!("unexpected method {:?}", request.method),
                    data: None,
                }),
            };
            let response = ResponseFrame {
                id: request.id,
                body,
            };
            ws.send(Message::Text(serde_json::to_string(&response).unwrap()))
                .await
                .unwrap();
        }
    });
}

async fn start_session(sock: &Path) -> String {
    #[derive(serde::Deserialize)]
    struct StartResult {
        session_id: String,
    }

    let mut client = IpcClient::connect(sock).await.unwrap();
    client
        .call::<(), StartResult>(
            "session-start",
            Method::SessionStart,
            None,
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap()
        .session_id
}

fn record_command(home: &Path, subcommand: &str, output: &Path) -> Command {
    let mut command = Command::new(bsk_bin());
    command
        .args(["record", subcommand])
        .arg("--output")
        .arg(output)
        .env(BSK_HOME_ENV, home)
        .env("BSK_AUTO_START", "0")
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

async fn run_record_stop(home: &Path, output: &Path) -> Output {
    record_command(home, "stop", output).output().await.unwrap()
}

fn write_daemon_info(home: &Path, sock: &Path, port: u16) {
    bsk::daemon::info::write_to_path(
        &DaemonInfo::now(std::process::id(), sock.to_owned(), port, DAEMON_VERSION),
        &home.join("daemon.json"),
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_record_stop_keeps_state_and_session_for_retry() {
    // Keep the Unix-domain socket below macOS's SUN_LEN even from a deep worktree.
    let temp = tempfile::Builder::new()
        .prefix("bsk-record-stop-")
        .tempdir()
        .unwrap();
    let home = temp.path().join("bsk-home");
    let sock = support::ipc_endpoint(temp.path());
    let output = temp.path().join("trace");

    let daemon = daemon::run(
        DaemonConfig::new(0).with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal),
        Some(sock.clone()),
    )
    .await
    .unwrap();
    write_daemon_info(&home, &sock, daemon.ws_addr().port());

    let mut extension = connect_extension(daemon.ws_addr()).await;
    handshake(&mut extension).await;
    let record_stop_calls = Arc::new(AtomicUsize::new(0));
    let session_stop_calls = Arc::new(AtomicUsize::new(0));
    run_extension(
        extension,
        Arc::clone(&record_stop_calls),
        Arc::clone(&session_stop_calls),
    );

    let session_id = start_session(&sock).await;
    let record_session = home.join("record-session.json");
    let state = json!({ "session_id": session_id, "started_at": "1" });
    std::fs::write(&record_session, state.to_string()).unwrap();

    let first = run_record_stop(&home, &output).await;
    assert!(
        !first.status.success(),
        "first stop unexpectedly succeeded: {}",
        String::from_utf8_lossy(&first.stdout)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&record_session).unwrap()).unwrap(),
        state
    );
    assert_eq!(record_stop_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        session_stop_calls.load(Ordering::SeqCst),
        0,
        "failed record stop must leave the session active"
    );

    let second = run_record_stop(&home, &output).await;
    assert!(
        second.status.success(),
        "retry failed: {}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert!(!record_session.exists());
    assert_eq!(record_stop_calls.load(Ordering::SeqCst), 2);
    assert_eq!(session_stop_calls.load(Ordering::SeqCst), 1);
    assert!(output.join("trace.json").exists());
    assert!(output.join("states/s1.txt").exists());

    daemon.shutdown().await;
}

async fn next_request(ws: &mut Ws, method: Method) -> RequestFrame {
    let Message::Text(text) = ws.next().await.unwrap().unwrap() else {
        panic!("expected {method:?} request");
    };
    let Frame::Request(request) = serde_json::from_str(&text).unwrap() else {
        panic!("expected {method:?} request, got {text}");
    };
    assert_eq!(request.method, method);
    request
}

async fn reply(ws: &mut Ws, request: RequestFrame, body: ResponseBody) {
    let frame = ResponseFrame {
        id: request.id,
        body,
    };
    ws.send(Message::Text(serde_json::to_string(&frame).unwrap()))
        .await
        .unwrap();
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Cleanup {
    Concurrent,
    AwaitStillBusy,
    Late,
    CancelFirst,
    DisconnectFirst,
    Timeout,
    ReturnFailure,
}

async fn exercise_record_cleanup(first: Method, cleanup: Cleanup) {
    tokio::time::timeout(Duration::from_secs(15), async {
        let temp = tempfile::Builder::new().prefix("bsk-record-").tempdir().unwrap();
        let home = temp.path().join("bsk-home");
        let sock = support::ipc_endpoint(temp.path());
        let start_dir = temp.path().join("start");
        let stop_dir = temp.path().join("stop");
        let daemon = daemon::run(
            DaemonConfig::new(0).with_local_auth(bsk::daemon::local_auth::LocalAuthMode::TrustLocal),
            None,
        )
        .await
        .unwrap();
        let ws_addr = daemon.ws_addr();
        write_daemon_info(&home, &sock, ws_addr.port());

        let handler = ipc::full_handler(
            DaemonStatus {
                started_at: Instant::now(),
                ws_port: ws_addr.port(),
                sock_path: sock.clone(),
                daemon_version: DAEMON_VERSION,
                protocol_version: PROTOCOL_VERSION,
            },
            daemon.state(),
        );
        let start_first = first == Method::ToolRecordAwait;
        let delayed_method = if start_first { Method::ToolRecordStop } else { Method::ToolRecordAwait };
        let release = Arc::new(Semaphore::new(0));
        let gate = Arc::clone(&release);
        let (stop_seen, mut stops) = mpsc::unbounded_channel();
        let wrapped: RpcHandler = Arc::new(move |id, method, params| {
            let gate = Arc::clone(&gate);
            let stop_seen = stop_seen.clone();
            let mut response = handler(id.clone(), method.clone(), params);
            let delayed = method == delayed_method;
            Box::pin(async move {
                if method == Method::SessionStop {
                    // Signal after the real handler has seen the request. Its
                    // first poll either joins the pending teardown or returns
                    // an immediate error, regardless of scheduling.
                    let polled = futures_util::poll!(&mut response);
                    stop_seen.send((id, polled.is_pending())).unwrap();
                    return match polled {
                        Poll::Ready(result) => result,
                        Poll::Pending => response.await,
                    };
                }
                let result = response.await;
                if delayed {
                    gate.acquire().await.unwrap().forget();
                }
                result
            })
        });
        let listener = ipc::bind(&sock).await.unwrap();
        let (shutdown, done) = oneshot::channel::<()>();
        let server = tokio::spawn(ipc::serve(listener, wrapped, || {}, || {}, || {}, async {
            let _ = done.await;
        }));

        let mut ws = connect_extension(ws_addr).await;
        handshake(&mut ws).await;
        let start = record_command(&home, "start", &start_dir)
            .args(["--url", "https://example.com/", "--json"])
            .spawn()
            .unwrap();
        let session_start = next_request(&mut ws, Method::ToolSessionStart).await;
        let session_id = session_start.params.as_ref().unwrap()["session_id"].clone();
        reply(&mut ws, session_start, ResponseBody::Ok(json!({ "agent_window_id": 100 }))).await;
        let record_start = next_request(&mut ws, Method::ToolRecordStart).await;
        reply(&mut ws, record_start, ResponseBody::Ok(json!({ "tab_id": 10, "recording": true }))).await;
        let record_await = next_request(&mut ws, Method::ToolRecordAwait).await;
        let stop = record_command(&home, "stop", &stop_dir)
            .arg("--json")
            .spawn()
            .unwrap();
        let record_stop = next_request(&mut ws, Method::ToolRecordStop).await;

        // Gate the trailing result at IPC so the leading CLI starts cleanup.
        let trace = json!({ "trace": sample_trace() });
        let busy_await = if cleanup == Cleanup::AwaitStillBusy {
            Some(record_await)
        } else {
            reply(&mut ws, record_await, ResponseBody::Ok(trace.clone())).await;
            None
        };
        reply(&mut ws, record_stop, ResponseBody::Ok(trace.clone())).await;

        let (mut leader, follower, lead_dir, follow_dir) = if start_first {
            (start, stop, start_dir, stop_dir)
        } else {
            (stop, start, stop_dir, start_dir)
        };
        let (leader_rpc, leader_pending) = stops.recv().await.unwrap();
        assert!(leader_pending, "first cleanup must wait for the extension");
        if let Some(record_await) = busy_await {
            reply(&mut ws, record_await, ResponseBody::Ok(trace)).await;
        }
        let teardown = next_request(&mut ws, Method::ToolSessionStop).await;
        assert_eq!(teardown.params.as_ref().unwrap()["session_id"], session_id);

        if cleanup == Cleanup::CancelFirst {
            assert!(daemon.state().abort_registry.cancel(&leader_rpc));
            assert!(!leader.wait().await.unwrap().success());
        } else if cleanup == Cleanup::DisconnectFirst {
            leader.kill().await.unwrap();
        }
        let follower_late = matches!(cleanup, Cleanup::Late | Cleanup::ReturnFailure);
        if !follower_late {
            release.add_permits(1);
            let (_, follower_pending) = stops.recv().await.unwrap();
            assert!(follower_pending, "second session.stop must wait for the first");
        }
        assert_eq!(daemon.state().sessions.len(), 1);
        assert!(ws.next().now_or_never().is_none(), "duplicate extension teardown");

        let (outcome, error_code) = match cleanup {
            Cleanup::Timeout => (ResponseBody::Err(RpcError {
                code: ErrorCode::Timeout,
                message: "cleanup timed out".into(),
                data: None,
            }), Some("timeout")),
            Cleanup::ReturnFailure => (ResponseBody::Ok(json!({
                "return_failures": [{"tab_id": 10, "code": "cdp_failed", "message": "could not move tab"}],
            })), Some("cdp_failed")),
            _ => (ResponseBody::Ok(json!({})), None),
        };
        reply(&mut ws, teardown, outcome).await;

        let lead_output = leader.wait_with_output().await.unwrap();
        if follower_late {
            release.add_permits(1);
        }
        let follow_output = follower.wait_with_output().await.unwrap();
        if cleanup == Cleanup::DisconnectFirst {
            assert!(!lead_output.status.success());
        } else if cleanup == Cleanup::CancelFirst {
            assert_record_result(&lead_output, &lead_dir, Some("cancelled"));
        } else {
            assert_record_result(&lead_output, &lead_dir, error_code);
        }
        assert_record_result(&follow_output, &follow_dir, error_code);

        let lead_trace = std::fs::read(lead_dir.join("trace.json")).unwrap();
        let follow_trace = std::fs::read(follow_dir.join("trace.json")).unwrap();
        assert_eq!(lead_trace, follow_trace);
        let exported: Value = serde_json::from_slice(&lead_trace).unwrap();
        assert_eq!(exported["stopped_by"], "cli_stop");
        assert!(!home.join("record-session.json").exists());
        assert_eq!(daemon.state().sessions.len(), usize::from(error_code.is_some()));
        assert!(ws.next().now_or_never().is_none(), "duplicate extension teardown");
        shutdown.send(()).unwrap();
        server.await.unwrap();
        daemon.shutdown().await;
    })
    .await
    .expect("record cleanup scenario timed out");
}

fn assert_record_result(output: &Output, dir: &Path, error_code: Option<&str>) {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let exit_code = match error_code {
        Some("timeout") => 4,
        Some("cdp_failed") => 3,
        Some("cancelled") => 2,
        None => 0,
        Some(code) => panic!("unexpected expected error code {code}"),
    };
    assert_eq!(
        output.status.code(),
        Some(exit_code),
        "{}: {stdout} {}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );
    assert!(output.stderr.is_empty());
    let json: Value = serde_json::from_str(&stdout).unwrap_or_else(|_| {
        panic!("expected one JSON document, got {stdout}");
    });
    if let Some(code) = error_code {
        assert_eq!(json["code"], code);
        assert!(json.get("trace_json").is_none());
    } else {
        assert_eq!(json["trace_json"], json!(dir.join("trace.json")));
        assert_eq!(json["trace_version"], 3);
        assert_eq!(json["trace"], json!(sample_trace()));
    }
}

#[tokio::test]
async fn record_cleanup_joins_when_start_arrives_first() {
    exercise_record_cleanup(Method::ToolRecordAwait, Cleanup::Concurrent).await;
}

#[tokio::test]
async fn record_cleanup_joins_when_stop_arrives_first() {
    exercise_record_cleanup(Method::ToolRecordStop, Cleanup::Concurrent).await;
}

#[tokio::test]
async fn record_cleanup_waits_for_the_inflight_record_await() {
    exercise_record_cleanup(Method::ToolRecordStop, Cleanup::AwaitStillBusy).await;
}

#[tokio::test]
async fn record_cleanup_accepts_a_confirmed_prior_stop() {
    exercise_record_cleanup(Method::ToolRecordStop, Cleanup::Late).await;
}

#[tokio::test]
async fn record_cleanup_survives_cancelling_the_first_waiter() {
    exercise_record_cleanup(Method::ToolRecordAwait, Cleanup::CancelFirst).await;
}

#[tokio::test]
async fn record_cleanup_survives_losing_the_first_cli() {
    exercise_record_cleanup(Method::ToolRecordStop, Cleanup::DisconnectFirst).await;
}

#[tokio::test]
async fn record_cleanup_reports_real_timeout_to_both_clis() {
    exercise_record_cleanup(Method::ToolRecordAwait, Cleanup::Timeout).await;
}

#[tokio::test]
async fn record_cleanup_reports_a_borrowed_tab_return_failure_to_a_late_caller() {
    exercise_record_cleanup(Method::ToolRecordStop, Cleanup::ReturnFailure).await;
}
