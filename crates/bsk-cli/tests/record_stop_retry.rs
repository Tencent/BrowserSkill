use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use bsk::cli::record_state;
use bsk::daemon::info::DaemonInfo;
use bsk::daemon::paths::BSK_HOME_ENV;
use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::{HandshakeParams, HandshakeResult};
use bsk_protocol::tools::{
    RecordStopResult, RecorderInfo, SessionStartParams, SessionStartResult, StopReason, Trace,
    TraceEntry, TraceState, VOM_FORMAT_VERSION,
};
use bsk_protocol::{
    BrowserPeerInfo, ErrorCode, Frame, Method, RequestFrame, ResponseBody, ResponseFrame, RpcError,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::process::Command;
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
                protocol_version: "1.1".into(),
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

fn sample_trace() -> Trace {
    Trace {
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
        frame_capture: None,
        states: vec![TraceState {
            id: "s1".into(),
            url: "https://example.com/".into(),
            title: Some("Example".into()),
            body: Some("@vom 1\nL1 page".into()),
            page: None,
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
                                trace: sample_trace(),
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

async fn run_record_stop(home: &Path, output: &Path) -> std::process::Output {
    Command::new(bsk_bin())
        .arg("record")
        .arg("stop")
        .arg("--output")
        .arg(output)
        .env(BSK_HOME_ENV, home)
        .output()
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_record_stop_keeps_state_and_session_for_retry() {
    let temp = tempfile::Builder::new()
        .prefix(".record-stop-retry-")
        .tempdir_in(env!("CARGO_MANIFEST_DIR"))
        .unwrap();
    let home = temp.path().join("bsk-home");
    let sock = temp.path().join("daemon.sock");
    let output = temp.path().join("trace");

    let daemon = daemon::run(DaemonConfig::new(0), Some(sock.clone()))
        .await
        .unwrap();
    bsk::daemon::info::write_to_path(
        &DaemonInfo::now(
            std::process::id(),
            sock.clone(),
            daemon.ws_addr().port(),
            env!("CARGO_PKG_VERSION"),
        ),
        &home.join("daemon.json"),
    )
    .unwrap();

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
    unsafe {
        std::env::set_var(BSK_HOME_ENV, &home);
    }
    record_state::write(&session_id).unwrap();

    let first = run_record_stop(&home, &output).await;
    assert!(
        !first.status.success(),
        "first stop unexpectedly succeeded: {}",
        String::from_utf8_lossy(&first.stdout)
    );
    assert_eq!(record_state::read().unwrap().session_id, session_id);
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
    assert!(record_state::read().is_err());
    assert_eq!(record_stop_calls.load(Ordering::SeqCst), 2);
    assert_eq!(session_stop_calls.load(Ordering::SeqCst), 1);
    assert!(output.join("trace.json").exists());
    assert!(output.join("pages/s1.vom.txt").exists());

    unsafe {
        std::env::remove_var(BSK_HOME_ENV);
    }
    daemon.shutdown().await;
}
