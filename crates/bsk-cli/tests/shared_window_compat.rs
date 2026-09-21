//! Windows counterpart of the Unix discovery test: a legacy daemon must never
//! receive a session.start request for a shared-window session.
#![cfg(windows)]

mod support;

use bsk::cli::session::{SessionStartOptions, start_session};
use bsk_protocol::{ErrorCode, Frame, Method, ResponseBody, ResponseFrame};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ServerOptions;

#[tokio::test]
async fn shared_session_preflight_rejects_legacy_daemon_over_named_pipe() {
    let endpoint = support::ipc_endpoint("bsk-legacy");
    let pipe = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&endpoint)
        .unwrap();
    let client_endpoint = endpoint.clone();
    let client = tokio::task::spawn_blocking(move || {
        start_session(
            client_endpoint,
            SessionStartOptions {
                in_window: true,
                ..Default::default()
            },
        )
    });
    pipe.connect().await.unwrap();
    // Keep another listener available so an erroneous second RPC cannot merely
    // fail to connect and masquerade as a successful compatibility check.
    let next = ServerOptions::new().create(&endpoint).unwrap();
    let mut connection = BufReader::new(pipe);
    let mut line = String::new();
    connection.read_line(&mut line).await.unwrap();
    let Frame::Request(request) = serde_json::from_str(&line).unwrap() else {
        panic!("expected status request");
    };
    assert_eq!(request.method, Method::SystemStatus);
    let reply = Frame::Response(ResponseFrame {
        id: request.id,
        body: ResponseBody::Ok(serde_json::json!({
            "daemon_version": "0.3.0", "protocol_version": "1.3",
            "pid": std::process::id(), "uptime_secs": 1, "ws_port": 0,
            "sock_path": endpoint, "browsers": [], "sessions": []
        })),
    });
    connection
        .get_mut()
        .write_all(format!("{}\n", serde_json::to_string(&reply).unwrap()).as_bytes())
        .await
        .unwrap();
    let error = tokio::select! {
        result = client => result.unwrap().unwrap_err(),
        result = next.connect() => panic!("legacy daemon received a second connection: {result:?}"),
        _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => panic!("preflight timed out"),
    };
    assert_eq!(error.code(), Some(ErrorCode::Unsupported));
    assert_eq!(error.data().unwrap()["required_protocol"], "1.4");
}
