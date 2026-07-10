//! Integration tests: daemon status/list RPCs wait for a late extension handshake.

#![cfg(unix)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use bsk::cli::doctor;
use bsk::cli::status::Output;
use bsk::daemon::{self, DaemonConfig};
use bsk::ipc_client::IpcClient;
use bsk_protocol::system::{BrowserListParams, HandshakeParams, HandshakeResult, StatusParams};
use bsk_protocol::{BrowserPeerInfo, Method, RequestFrame, ResponseBody, ResponseFrame};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

const TEST_EXT_ID: &str = "abcdefghijklmnopabcdefghijklmnop";
static DOCTOR_ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvRestore(Vec<(&'static str, Option<OsString>)>);

impl Drop for EnvRestore {
    fn drop(&mut self) {
        for (key, value) in self.0.drain(..) {
            unsafe {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }
}

fn with_doctor_env<R>(
    bsk_home: &Path,
    overrides: &[(&'static str, &'static str)],
    f: impl FnOnce() -> R,
) -> R {
    let _lock = DOCTOR_ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let saved = [
        "BSK_HOME",
        "BSK_BROWSER_WAIT_MS",
        "BSK_DOCTOR_BROWSER_WAIT_MS",
    ]
    .into_iter()
    .map(|key| (key, std::env::var_os(key)))
    .collect();
    let _restore = EnvRestore(saved);
    unsafe {
        std::env::set_var("BSK_HOME", bsk_home);
        std::env::remove_var("BSK_BROWSER_WAIT_MS");
        std::env::remove_var("BSK_DOCTOR_BROWSER_WAIT_MS");
        for (key, value) in overrides {
            std::env::set_var(key, value);
        }
    }
    f()
}

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
    let sock = tempfile_path("bsk-test-browser-wait");
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

#[tokio::test]
async fn system_status_waits_for_late_extension_handshake() {
    let (handle, sock) = spawn_daemon().await;
    let ws_addr = handle.ws_addr();

    let sock_for_ipc = sock.clone();
    let status_task = tokio::spawn(async move {
        let mut ipc = IpcClient::connect(&sock_for_ipc).await.unwrap();
        ipc.call::<StatusParams, bsk_protocol::StatusResult>(
            "status-wait",
            Method::SystemStatus,
            Some(StatusParams {
                wait_for_browser_ms: Some(500),
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("system.status should succeed")
    });

    tokio::time::sleep(Duration::from_millis(80)).await;
    let mut ws = connect_ext(ws_addr).await;
    let _ = handshake_as_ext(&mut ws).await;

    let status = status_task.await.expect("join");
    assert_eq!(status.browsers.len(), 1);
    assert_eq!(status.browsers[0].instance_id, TEST_EXT_ID);

    handle.shutdown().await;
}

#[tokio::test]
async fn browser_list_waits_for_late_extension_handshake() {
    let (handle, sock) = spawn_daemon().await;
    let ws_addr = handle.ws_addr();

    #[derive(serde::Deserialize)]
    struct ListReply {
        browsers: Vec<bsk_protocol::system::BrowserStatusEntry>,
    }

    let sock_for_ipc = sock.clone();
    let list_task = tokio::spawn(async move {
        let mut ipc = IpcClient::connect(&sock_for_ipc).await.unwrap();
        ipc.call::<BrowserListParams, ListReply>(
            "browser-list-wait",
            Method::BrowserList,
            Some(BrowserListParams {
                wait_for_browser_ms: Some(500),
            }),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .expect("browser.list should succeed")
    });

    tokio::time::sleep(Duration::from_millis(80)).await;
    let mut ws = connect_ext(ws_addr).await;
    let _ = handshake_as_ext(&mut ws).await;

    let list = list_task.await.expect("join");
    assert_eq!(list.browsers.len(), 1);
    assert_eq!(list.browsers[0].instance_id, TEST_EXT_ID);

    handle.shutdown().await;
}

#[tokio::test]
async fn system_status_without_wait_returns_immediately_when_empty() {
    let (handle, sock) = spawn_daemon().await;
    let mut ipc = IpcClient::connect(&sock).await.unwrap();
    let started = std::time::Instant::now();
    let status = ipc
        .call::<StatusParams, bsk_protocol::StatusResult>(
            "status-now",
            Method::SystemStatus,
            Some(StatusParams::default()),
            Duration::from_secs(2),
        )
        .await
        .unwrap()
        .expect("system.status should succeed");
    assert!(started.elapsed() < Duration::from_millis(200));
    assert!(status.browsers.is_empty());
    handle.shutdown().await;
}

#[tokio::test]
async fn doctor_reports_extension_connected_after_handshake() {
    let (handle, sock) = spawn_daemon().await;
    let ws_addr = handle.ws_addr();
    let home = tempfile::TempDir::new().unwrap();
    let bsk_home = home.path().join("bsk");
    std::fs::create_dir_all(&bsk_home).unwrap();
    let info = serde_json::json!({
        "pid": std::process::id(),
        "sock_path": sock,
        "ws_port": ws_addr.port(),
        "version": env!("CARGO_PKG_VERSION"),
        "started_at_epoch_secs": 1
    });
    std::fs::write(
        bsk_home.join("daemon.json"),
        serde_json::to_vec_pretty(&info).unwrap(),
    )
    .unwrap();

    let mut ws = connect_ext(ws_addr).await;
    let _ = handshake_as_ext(&mut ws).await;

    let bsk_home_for_doctor = bsk_home.clone();
    let checks = tokio::task::spawn_blocking(move || {
        with_doctor_env(
            &bsk_home_for_doctor,
            &[("BSK_BROWSER_WAIT_MS", "0")],
            || doctor::run(Output::Json),
        )
    })
    .await
    .expect("doctor join")
    .expect("doctor ok");
    let ext = checks
        .iter()
        .find(|check| check.name == "extension connected")
        .expect("extension connected check");
    assert_eq!(ext.status, doctor::CheckStatus::Ok);

    handle.shutdown().await;
}

#[tokio::test]
async fn doctor_waits_for_late_extension_on_verified_daemon() {
    let (handle, sock) = spawn_daemon().await;
    let ws_addr = handle.ws_addr();
    let home = tempfile::TempDir::new().unwrap();
    let bsk_home = home.path().join("bsk");
    std::fs::create_dir_all(&bsk_home).unwrap();
    let info = serde_json::json!({
        "pid": std::process::id(),
        "sock_path": sock,
        "ws_port": ws_addr.port(),
        "version": env!("CARGO_PKG_VERSION"),
        "started_at_epoch_secs": 1
    });
    std::fs::write(
        bsk_home.join("daemon.json"),
        serde_json::to_vec_pretty(&info).unwrap(),
    )
    .unwrap();

    let bsk_home_for_doctor = bsk_home.clone();
    let doctor_task = tokio::task::spawn_blocking(move || {
        with_doctor_env(
            &bsk_home_for_doctor,
            &[("BSK_DOCTOR_BROWSER_WAIT_MS", "500")],
            || doctor::run(Output::Json),
        )
    });

    tokio::time::sleep(Duration::from_millis(80)).await;
    let mut ws = connect_ext(ws_addr).await;
    let _ = handshake_as_ext(&mut ws).await;

    let checks = doctor_task.await.expect("doctor join").expect("doctor ok");
    let ext = checks
        .iter()
        .find(|check| check.name == "extension connected")
        .expect("extension connected check");
    assert_eq!(ext.status, doctor::CheckStatus::Ok);

    handle.shutdown().await;
}
