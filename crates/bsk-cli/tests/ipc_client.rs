//! End-to-end IPC client ↔ server round trip.

#![cfg(unix)]

use std::time::Duration;

use bsk::daemon::ipc::{bind, default_ping_handler, serve};
use bsk::ipc_client::Client;
use bsk_protocol::{Method, PingParams, PingResult};
use tempfile::TempDir;
use tokio::runtime::Runtime;

#[test]
fn ping_through_typed_client() {
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        let tmp = TempDir::new().unwrap();
        let sock = tmp.path().join("daemon.sock");
        let listener = bind(&sock).await.expect("bind");
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(serve(
            listener,
            default_ping_handler(),
            || {},
            || {},
            || {},
            async move {
                let _ = rx.await;
            },
        ));

        let mut client = Client::connect_path(sock.clone()).await.expect("connect");
        let outcome = client
            .call::<_, PingResult>(
                Method::SystemPing,
                &PingParams::default(),
                Duration::from_secs(2),
            )
            .await
            .expect("call");
        let result = outcome.expect("ping should succeed");
        assert!(result.pong);

        let _ = tx.send(());
        let _ = server.await;
    });
}
