//! End-to-end IPC ping smoke test using the public daemon::ipc API.

#![cfg(unix)]

use bsk::daemon::ipc::{bind, default_ping_handler, serve};
use bsk_protocol::{Frame, Method, RequestFrame, ResponseBody};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::runtime::Runtime;
use tokio::sync::oneshot;

fn make_request_line(id: &str, method: Method) -> String {
    let frame = Frame::Request(RequestFrame {
        id: id.into(),
        method,
        params: None,
    });
    let mut s = serde_json::to_string(&frame).unwrap();
    s.push('\n');
    s
}

#[test]
fn ipc_ping_pong_over_uds() {
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        let tmp = TempDir::new().unwrap();
        let sock = tmp.path().join("daemon.sock");
        let listener = bind(&sock).await.expect("bind");
        let (tx, rx) = oneshot::channel::<()>();

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

        let stream = UnixStream::connect(&sock).await.expect("connect");
        let (read, mut write) = stream.into_split();
        write
            .write_all(make_request_line("ping-1", Method::SystemPing).as_bytes())
            .await
            .unwrap();
        write.flush().await.unwrap();

        let mut reader = BufReader::new(read);
        let mut buf = String::new();
        reader.read_line(&mut buf).await.unwrap();
        let frame: Frame = serde_json::from_str(buf.trim_end()).unwrap();
        match frame {
            Frame::Response(resp) => {
                assert_eq!(resp.id, "ping-1");
                match resp.body {
                    ResponseBody::Ok(v) => {
                        assert_eq!(v, serde_json::json!({ "pong": true }));
                    }
                    other => panic!("unexpected body {other:?}"),
                }
            }
            other => panic!("unexpected frame {other:?}"),
        }

        drop(write);
        drop(reader);
        let _ = tx.send(());
        let _ = server.await;
    });
}
