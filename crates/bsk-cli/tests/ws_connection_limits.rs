//! Local WebSocket admission and HTTP Upgrade deadline regressions.

use std::net::SocketAddr;
use std::time::Duration;

use bsk::daemon::{self, DaemonConfig};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;
const DEADLINE: Duration = Duration::from_secs(10);

fn request(addr: SocketAddr) -> tokio_tungstenite::tungstenite::handshake::client::Request {
    let mut request = format!("ws://{addr}/").into_client_request().unwrap();
    request.headers_mut().insert(
        "Origin",
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
            .parse()
            .unwrap(),
    );
    request
}

async fn register(ws: &mut Ws, instance: usize) {
    ws.send(Message::Text(
        json!({
            "id": "handshake", "method": "system.handshake", "params": {
                "client": "browser-skill-extension",
                "version": env!("CARGO_PKG_VERSION"),
                "protocol_version": bsk::daemon::state::PROTOCOL_VERSION,
                "instance_id": format!("connection-limit-{instance}"),
                "label": "Connection limit test",
                "browser": {"name": "chrome", "version": "131"}
            }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let response = ws.next().await.unwrap().unwrap().into_text().unwrap();
    let response: serde_json::Value = serde_json::from_str(&response).unwrap();
    assert!(response.get("result").is_some(), "{response}");
}

async fn assert_closed(stream: &mut TcpStream) {
    let mut byte = [0];
    match tokio::time::timeout(DEADLINE, stream.read(&mut byte))
        .await
        .expect("server did not close the TCP connection before the deadline")
    {
        Ok(0) | Err(_) => {}
        other => panic!("expected EOF or socket error, got {other:?}"),
    }
}

#[tokio::test]
async fn silent_tcp_connection_is_closed_before_upgrade() {
    let handle = daemon::run(DaemonConfig::new(0), None).await.unwrap();
    let mut stream = TcpStream::connect(handle.ws_addr()).await.unwrap();
    assert_closed(&mut stream).await;
    handle.shutdown().await;
}

#[tokio::test]
async fn incomplete_http_upgrade_is_closed() {
    let handle = daemon::run(DaemonConfig::new(0), None).await.unwrap();
    let mut stream = TcpStream::connect(handle.ws_addr()).await.unwrap();
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n")
        .await
        .unwrap();
    assert_closed(&mut stream).await;
    handle.shutdown().await;
}

#[tokio::test]
async fn silent_connections_hold_capacity_until_upgrade_timeout_then_release_it() {
    tokio::time::timeout(Duration::from_secs(20), async {
        let handle = daemon::run(DaemonConfig::new(0), None).await.unwrap();
        let addr = handle.ws_addr();
        let mut streams = Vec::new();
        for _ in 0..64 {
            streams.push(TcpStream::connect(addr).await.unwrap());
        }
        let mut excess = TcpStream::connect(addr).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), assert_closed(&mut excess))
            .await
            .expect("silent clients must consume connection capacity");
        for stream in &mut streams {
            assert_closed(stream).await;
        }
        let (mut ws, _) = tokio_tungstenite::connect_async(request(addr))
            .await
            .unwrap();
        register(&mut ws, 65).await;
        drop(ws);
        handle.shutdown().await;
    })
    .await
    .expect("silent capacity regression timed out");
}

#[tokio::test]
async fn connection_capacity_is_retained_after_upgrade_and_released_on_disconnect() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let handle = daemon::run(DaemonConfig::new(0), None).await.unwrap();
        let addr = handle.ws_addr();
        let mut clients = Vec::new();
        for instance in 0..64 {
            let (mut ws, _) = tokio_tungstenite::connect_async(request(addr))
                .await
                .unwrap();
            register(&mut ws, instance).await;
            clients.push(ws);
        }

        // A successful TCP connect alone is not admission: the listener must
        // close the excess socket even while existing clients are registered.
        let mut excess = TcpStream::connect(addr).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), assert_closed(&mut excess))
            .await
            .expect("capacity rejection should not wait for the Upgrade timeout");

        drop(clients.pop());
        // Disconnect cleanup races with the next accept; retry within a bounded
        // deadline rather than relying on a fixed sleep for permit release.
        let mut replacement = tokio::time::timeout(DEADLINE, async {
            loop {
                if let Ok((ws, _)) = tokio_tungstenite::connect_async(request(addr)).await {
                    break ws;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("disconnect did not release connection capacity");
        register(&mut replacement, 64).await;
        replacement
            .send(Message::Ping(vec![1, 2, 3]))
            .await
            .unwrap();
        assert_eq!(
            replacement.next().await.unwrap().unwrap(),
            Message::Pong(vec![1, 2, 3])
        );

        drop(replacement);
        drop(clients);
        handle.shutdown().await;
    })
    .await
    .expect("capacity regression timed out");
}
