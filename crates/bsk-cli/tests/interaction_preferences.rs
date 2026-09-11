//! Real CLI and daemon processes must defer to the browser, even when both
//! inherit BSK_REQUEST_HELP=off and the caller supplies legacy override flags.

use std::path::Path;
use std::process::{Output, Stdio};
use std::time::Duration;

use bsk::daemon::info::read_from_path;
use bsk_protocol::{ErrorCode, Frame, Method, RequestFrame, ResponseBody, ResponseFrame, RpcError};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::process::{Child, Command};
use tokio_tungstenite::tungstenite::handshake::client::generate_key;
use tokio_tungstenite::tungstenite::http::Request;
use tokio_tungstenite::tungstenite::protocol::Message;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
const WAIT: Duration = Duration::from_secs(10);

fn command(home: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bsk"));
    command
        .args(args)
        .env("BSK_HOME", home)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("BSK_REQUEST_HELP", "off")
        .env("BSK_AUTO_START", "0")
        .env("BSK_AUTO_UPDATE", "0")
        .env("RUST_LOG", "warn")
        .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

async fn output(child: Child) -> Output {
    tokio::time::timeout(WAIT, child.wait_with_output())
        .await
        .expect("CLI did not finish")
        .unwrap()
}

fn successful_json(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

async fn next_request(ws: &mut Ws, method: Method) -> RequestFrame {
    tokio::time::timeout(WAIT, async {
        loop {
            let Message::Text(text) = ws.next().await.unwrap().unwrap() else {
                continue;
            };
            if let Frame::Request(request) = serde_json::from_str(&text).unwrap() {
                assert_eq!(request.method, method);
                return request;
            }
        }
    })
    .await
    .expect("request did not reach the browser")
}

async fn reply(ws: &mut Ws, request: RequestFrame, body: ResponseBody) {
    ws.send(Message::Text(
        serde_json::to_string(&ResponseFrame {
            id: request.id,
            body,
        })
        .unwrap(),
    ))
    .await
    .unwrap();
}

async fn start_with_protocol(protocol: &str) -> (tempfile::TempDir, Child, Ws) {
    let temp = tempfile::tempdir().unwrap();
    let mut daemon = command(
        temp.path(),
        &["daemon", "start", "--foreground", "--port", "0"],
    )
    .spawn()
    .unwrap();
    let info = tokio::time::timeout(WAIT, async {
        loop {
            assert!(
                daemon.try_wait().unwrap().is_none(),
                "daemon exited during startup"
            );
            if let Some(info) = read_from_path(&temp.path().join("daemon.json")).unwrap() {
                break info;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("daemon discovery unavailable");
    let address = format!("127.0.0.1:{}", info.ws_port);
    let request = Request::builder()
        .uri(format!("ws://{address}/"))
        .header("Host", &address)
        .header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", generate_key())
        .header(
            "Origin",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        )
        .body(())
        .unwrap();
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    ws.send(Message::Text(json!({"id":"hello", "method":"system.handshake", "params":{
        "client":"browser-skill-extension", "version":env!("CARGO_PKG_VERSION"),
        "protocol_version":protocol,
        "instance_id":"policy-test", "browser":{"name":"chrome", "version":"130"}, "label":"test"
    }}).to_string())).await.unwrap();
    let Message::Text(text) = ws.next().await.unwrap().unwrap() else {
        panic!("missing handshake")
    };
    let handshake: ResponseFrame = serde_json::from_str(&text).unwrap();
    assert!(matches!(handshake.body, ResponseBody::Ok(_)));
    (temp, daemon, ws)
}

#[tokio::test]
async fn legacy_flags_and_both_process_environments_cannot_override_the_browser() {
    let (temp, mut daemon, mut ws) =
        start_with_protocol(bsk::daemon::state::PROTOCOL_VERSION).await;

    for borrow_confirmation in ["always", "never"] {
        for request_help in ["enabled", "disabled"] {
            let policy =
                json!({"borrow_confirmation":borrow_confirmation, "request_help":request_help});
            let start = command(
                temp.path(),
                &["session", "start", "--unattended", "--no-focus", "--json"],
            )
            .spawn()
            .unwrap();
            let request = next_request(&mut ws, Method::ToolSessionStart).await;
            let params = request.params.as_ref().unwrap();
            assert!(params.get("unattended").is_none());
            assert_eq!(params["focused"], false);
            reply(
                &mut ws,
                request,
                ResponseBody::Ok(json!({"agent_window_id":100,"interaction":policy})),
            )
            .await;
            let result = output(start).await;
            assert!(String::from_utf8_lossy(&result.stderr).contains("--unattended"));
            let started = successful_json(&result);
            assert_eq!(started["interaction"], policy);
            let session = started["session_id"].as_str().unwrap();

            let mut borrow = command(
                temp.path(),
                &[
                    "tab",
                    "borrow",
                    "7",
                    "--session",
                    session,
                    "--no-confirm",
                    "--json",
                ],
            )
            .spawn()
            .unwrap();
            let request = next_request(&mut ws, Method::ToolTabBorrow).await;
            assert!(request.params.as_ref().unwrap().get("confirm").is_none());
            assert!(
                borrow.try_wait().unwrap().is_none(),
                "borrow returned before browser approval"
            );
            let body = if borrow_confirmation == "always" {
                ResponseBody::Err(RpcError {
                    code: ErrorCode::Cancelled,
                    message: "user denied borrowing".into(),
                    data: Some(json!({"reason":"user_denied"})),
                })
            } else {
                ResponseBody::Ok(
                    json!({"tab_id":7,"original_window_id":200,"original_index":0,"agent_window_id":100}),
                )
            };
            reply(&mut ws, request, body).await;
            let result = output(borrow).await;
            assert!(String::from_utf8_lossy(&result.stderr).contains("--no-confirm"));
            assert_eq!(result.status.success(), borrow_confirmation == "never");

            let mut help = command(
                temp.path(),
                &[
                    "request-help",
                    "--session",
                    session,
                    "--prompt",
                    "Please continue",
                    "--json",
                ],
            )
            .spawn()
            .unwrap();
            let request = next_request(&mut ws, Method::ToolRequestHelp).await;
            assert!(
                help.try_wait().unwrap().is_none(),
                "help returned before the browser decided"
            );
            let outcome = if request_help == "enabled" {
                "continued"
            } else {
                "disabled"
            };
            reply(
                &mut ws,
                request,
                ResponseBody::Ok(json!({"outcome":outcome,"tab_id":7})),
            )
            .await;
            let result = output(help).await;
            assert!(String::from_utf8_lossy(&result.stderr).contains("BSK_REQUEST_HELP=off"));
            assert_eq!(successful_json(&result)["outcome"], outcome);

            let stop = command(temp.path(), &["session", "stop", session, "--json"])
                .spawn()
                .unwrap();
            let request = next_request(&mut ws, Method::ToolSessionStop).await;
            reply(&mut ws, request, ResponseBody::Ok(json!({}))).await;
            successful_json(&output(stop).await);
        }
    }
    drop(ws);
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
}

#[tokio::test]
async fn mixed_extension_versions_keep_sessions_usable_and_cannot_receive_legacy_overrides() {
    for protocol in ["1.0", "1.1", "1.2", "1.3"] {
        let (temp, mut daemon, mut ws) = start_with_protocol(protocol).await;
        let info = read_from_path(&temp.path().join("daemon.json"))
            .unwrap()
            .unwrap();
        let mut ipc = bsk::ipc_client::IpcClient::connect(&info.sock_path)
            .await
            .unwrap();
        // Simulate the wire inputs of an old CLI, including its session override.
        let start = ipc.call::<Value, Value>(
            "start",
            Method::SessionStart,
            Some(json!({"unattended": true})),
            WAIT,
        );
        let respond = async {
            let request = next_request(&mut ws, Method::ToolSessionStart).await;
            assert!(request.params.as_ref().unwrap().get("unattended").is_none());
            // Legacy extensions can omit interaction policy entirely.
            reply(
                &mut ws,
                request,
                ResponseBody::Ok(json!({"agent_window_id": 100})),
            )
            .await;
        };
        let (started, ()) = tokio::join!(start, respond);
        let started = started.unwrap().unwrap();
        let session = started["session_id"].as_str().unwrap();

        let custom = ipc.call::<Value, Value>(
            "custom",
            Method::ToolTabBorrow,
            Some(json!({"session_id": session, "tab_id": 7, "confirmation_timeout_ms": 120_000})),
            WAIT,
        );
        if protocol == "1.0" || protocol == "1.1" {
            let error = custom.await.unwrap().unwrap_err();
            assert_eq!(error.code, ErrorCode::Unsupported);
            assert_eq!(error.data.unwrap()["component"], "extension");
        } else {
            let respond = async {
                let request = next_request(&mut ws, Method::ToolTabBorrow).await;
                assert_eq!(
                    request.params.as_ref().unwrap()["confirmation_timeout_ms"],
                    120_000
                );
                reply(&mut ws, request, ResponseBody::Ok(json!({"tab_id": 7}))).await;
            };
            let (result, ()) = tokio::join!(custom, respond);
            result.unwrap().unwrap();
        }

        // This reaches the same connection even after an unsupported custom wait.
        let borrow = ipc.call::<Value, Value>(
            "borrow",
            Method::ToolTabBorrow,
            Some(json!({"session_id": session, "tab_id": 7, "confirm": false})),
            WAIT,
        );
        let respond = async {
            let request = next_request(&mut ws, Method::ToolTabBorrow).await;
            let params = request.params.as_ref().unwrap();
            assert!(params.get("confirm").is_none());
            assert!(params.get("confirmation_timeout_ms").is_none());
            reply(
                &mut ws,
                request,
                ResponseBody::Err(RpcError {
                    code: ErrorCode::Cancelled,
                    message: "User denied borrowing".into(),
                    data: Some(json!({"reason": "user_denied"})),
                }),
            )
            .await;
        };
        let (result, ()) = tokio::join!(borrow, respond);
        assert_eq!(
            result.unwrap().unwrap_err().data.unwrap()["reason"],
            "user_denied"
        );

        // The new daemon inherits BSK_REQUEST_HELP=off but still forwards help
        // to older extensions. Their response, not the environment, decides.
        let help = command(
            temp.path(),
            &[
                "request-help",
                "--session",
                session,
                "--prompt",
                "Continue",
                "--json",
            ],
        )
        .spawn()
        .unwrap();
        let request = next_request(&mut ws, Method::ToolRequestHelp).await;
        reply(
            &mut ws,
            request,
            ResponseBody::Ok(json!({"outcome": "continued", "tab_id": 7})),
        )
        .await;
        assert_eq!(successful_json(&output(help).await)["outcome"], "continued");

        let stop = command(temp.path(), &["session", "stop", session, "--json"])
            .spawn()
            .unwrap();
        let request = next_request(&mut ws, Method::ToolSessionStop).await;
        reply(&mut ws, request, ResponseBody::Ok(json!({}))).await;
        successful_json(&output(stop).await);
        drop(ipc);
        drop(ws);
        daemon.kill().await.unwrap();
        daemon.wait().await.unwrap();
    }
}

#[tokio::test]
async fn legacy_environment_without_a_daemon_returns_an_error_not_disabled() {
    let temp = tempfile::tempdir().unwrap();
    let result = output(
        command(
            temp.path(),
            &[
                "request-help",
                "--session",
                "abcd",
                "--prompt",
                "Continue",
                "--json",
            ],
        )
        .spawn()
        .unwrap(),
    )
    .await;
    assert!(!result.status.success());
    let result: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert!(result.get("outcome").is_none());
    assert!(!temp.path().join("daemon.json").exists());
}
