//! Real Windows CLI cancellation, including caller-owned transfer cleanup.
#![cfg(windows)]

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bsk::daemon::{file_transfer::TransferRegistry, info::DaemonInfo};
use bsk_protocol::tools::{TransferBeginParams, TransferIdParams};
use bsk_protocol::{ErrorCode, Frame, Method, ResponseBody, ResponseFrame, RpcError};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ServerOptions;
use tokio::process::Command;
use tokio::sync::{Notify, watch};

fn response<T: serde::Serialize>(result: Result<T, RpcError>) -> ResponseBody {
    match result {
        Ok(value) => ResponseBody::Ok(serde_json::to_value(value).unwrap()),
        Err(err) => ResponseBody::Err(err),
    }
}

#[test]
fn stdin_close_cancels_business_but_releases_resources_with_a_bounded_budget() {
    // Resolve the production registry's root before starting any runtime threads.
    let registry_home = tempfile::tempdir().unwrap();
    let original_home = std::env::var_os("BSK_HOME");
    unsafe {
        std::env::set_var("BSK_HOME", registry_home.path());
    }
    let transfers = Arc::new(TransferRegistry::new().unwrap());
    unsafe {
        match original_home {
            Some(value) => std::env::set_var("BSK_HOME", value),
            None => std::env::remove_var("BSK_HOME"),
        }
    }
    transfers.initialize().unwrap();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(exercise(
            transfers,
            &registry_home.path().join("run/transfers"),
        ));
}

async fn exercise(transfers: Arc<TransferRegistry>, staging_root: &Path) {
    for mode in [
        "wait",
        "upload",
        "upload-multi",
        "upload-before-dispatch",
        "download",
        "upload-multi-stall",
        "ordinary",
    ] {
        let home = tempfile::tempdir().unwrap();
        let pipe_name = format!(r"\\.\pipe\bsk-parent-cancel-{}", uuid::Uuid::new_v4());
        let info = DaemonInfo::now(std::process::id(), (&pipe_name).into(), 0, "0.2.0");
        std::fs::write(
            home.path().join("daemon.json"),
            serde_json::to_vec(&info).unwrap(),
        )
        .unwrap();
        let mut pipe = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .unwrap();
        let registered = Arc::new(Notify::new());
        let pending = Arc::new(Mutex::new(None::<String>));
        let ids = Arc::new(Mutex::new(Vec::<String>::new()));
        let released = Arc::new(Mutex::new(Vec::<String>::new()));
        let received = Arc::new(Mutex::new(Vec::<Method>::new()));
        let download_id = if mode == "download" {
            let staging = transfers.begin_download("fixture").unwrap();
            let browser_dir = home.path().join("BrowserSkill").join(&staging.transfer_id);
            std::fs::create_dir_all(&browser_dir).unwrap();
            let file = browser_dir.join("download.txt");
            std::fs::write(&file, b"download fixture").unwrap();
            transfers
                .import_download(&staging.transfer_id, &file)
                .unwrap();
            ids.lock().unwrap().push(staging.transfer_id.clone());
            Some(staging.transfer_id)
        } else {
            None
        };
        let (cancel, cancelled) = watch::channel(false);
        let ready = Arc::clone(&registered);
        let name = pipe_name.clone();
        let registry = Arc::clone(&transfers);
        let server_ids = Arc::clone(&ids);
        let server_released = Arc::clone(&released);
        let server_received = Arc::clone(&received);
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                pipe.connect().await.unwrap();
                let next = ServerOptions::new().create(&name).unwrap();
                let connection = std::mem::replace(&mut pipe, next);
                let ready = Arc::clone(&ready);
                let pending = Arc::clone(&pending);
                let cancel = cancel.clone();
                let mut cancelled = cancelled.clone();
                let name = name.clone();
                let registry = Arc::clone(&registry);
                let ids = Arc::clone(&server_ids);
                let released = Arc::clone(&server_released);
                let received = Arc::clone(&server_received);
                let download_id = download_id.clone();
                connections.spawn(async move {
                    let (read, mut write) = tokio::io::split(connection);
                    let mut reader = BufReader::new(read);
                    let mut line = String::new();
                    while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                        let Frame::Request(req) = serde_json::from_str::<Frame>(&line).unwrap()
                        else {
                            panic!("expected request");
                        };
                        line.clear();
                        received.lock().unwrap().push(req.method.clone());
                        let params = req.params.clone().unwrap_or_default();
                        let body = match req.method {
                            Method::SystemStatus => ResponseBody::Ok(json!({
                                "daemon_version": "0.2.0", "protocol_version": "1.1",
                                "pid": std::process::id(), "uptime_secs": 0,
                                "ws_port": 0, "sock_path": name,
                                "browsers": [], "sessions": [], "version_skew_browsers": []
                            })),
                            Method::TransferBegin => {
                                let begin = registry
                                    .begin_upload(serde_json::from_value(params).unwrap())
                                    .unwrap();
                                ids.lock().unwrap().push(begin.transfer_id.clone());
                                response(Ok(begin))
                            }
                            Method::ToolDownload => ResponseBody::Ok(json!({
                                "tab_id": 1, "suggested_filename": "download.txt",
                                "byte_size": 16, "transfer_id": download_id,
                            })),
                            Method::ToolWaitMs if mode == "ordinary" => {
                                ResponseBody::Ok(json!({"waited_ms": 1}))
                            }
                            Method::TransferChunk
                                if mode == "upload-before-dispatch"
                                    || (mode.contains("multi")
                                        && ids.lock().unwrap().len() == 1) =>
                            {
                                response(
                                    registry.write_chunk(serde_json::from_value(params).unwrap()),
                                )
                            }
                            Method::TransferFinish if mode != "upload-before-dispatch" => response(
                                registry.finish_upload(serde_json::from_value(params).unwrap()),
                            ),
                            Method::ToolWaitMs
                            | Method::TransferChunk
                            | Method::TransferRead
                            | Method::TransferFinish => {
                                *pending.lock().unwrap() = Some(req.id.clone());
                                ready.notify_one();
                                cancelled.wait_for(|value| *value).await.unwrap();
                                if mode == "upload-before-dispatch" {
                                    // Finish won the race with cancellation, but tool.upload must
                                    // not be dispatched and the CLI still owns the staging.
                                    response(
                                        registry
                                            .finish_upload(serde_json::from_value(params).unwrap()),
                                    )
                                } else {
                                    ResponseBody::Err(RpcError {
                                        code: ErrorCode::Cancelled,
                                        message: "parent cancellation reached daemon".into(),
                                        data: None,
                                    })
                                }
                            }
                            Method::Cancel => {
                                let target = params["rpc_id"].as_str().unwrap();
                                assert_eq!(pending.lock().unwrap().as_deref(), Some(target));
                                cancel.send(true).unwrap();
                                ResponseBody::Ok(json!({"cancelled": true}))
                            }
                            Method::TransferRelease => {
                                let params: TransferIdParams =
                                    serde_json::from_value(params).unwrap();
                                released.lock().unwrap().push(params.transfer_id.clone());
                                if mode.contains("stall") {
                                    std::future::pending::<()>().await;
                                }
                                response(Ok(registry.release(params)))
                            }
                            other => panic!("unexpected request after cancellation: {other:?}"),
                        };
                        let response = Frame::Response(ResponseFrame { id: req.id, body });
                        let mut bytes = serde_json::to_vec(&response).unwrap();
                        bytes.push(b'\n');
                        if write.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });

        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
        cmd.env("BSK_HOME", home.path())
            .env("BSK_AUTO_UPDATE", "off")
            .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .creation_flags(0x0800_0000)
            .kill_on_drop(true);
        if mode.starts_with("upload") {
            let source = home.path().join("upload.txt");
            // Declare 300 MiB without allocating or transferring that much data.
            std::fs::File::create(&source)
                .unwrap()
                .set_len(if mode == "upload-before-dispatch" {
                    16
                } else {
                    300 * 1024 * 1024
                })
                .unwrap();
            cmd.args(["upload", "--session", "fixture", "--selector", "input"]);
            if mode.contains("multi") {
                let first = home.path().join("first.txt");
                std::fs::write(&first, b"first file").unwrap();
                cmd.arg("--file").arg(first);
            }
            cmd.arg("--file").arg(source);
        } else if mode == "download" {
            let out = home.path().join("out.txt");
            std::fs::write(&out, b"existing output").unwrap();
            cmd.args([
                "download",
                "--session",
                "fixture",
                "--selector",
                "a",
                "--overwrite",
                "--out",
            ])
            .arg(out);
        } else {
            cmd.args(["wait-ms", if mode == "ordinary" { "1ms" } else { "60s" }]);
        }
        cmd.arg("--json");
        if mode == "ordinary" {
            cmd.stdin(std::process::Stdio::null());
        } else {
            cmd.env("BSK_CANCEL_ON_STDIN_CLOSE", "1")
                .stdin(std::process::Stdio::piped());
        }
        let mut child = cmd.spawn().unwrap();
        if mode != "ordinary" {
            tokio::time::timeout(Duration::from_secs(10), registered.notified())
                .await
                .expect("CLI registered business RPC");
            child
                .stdin
                .as_mut()
                .unwrap()
                .write_all(b"still connected")
                .await
                .unwrap();
            drop(child.stdin.take());
        }
        let start = Instant::now();
        let output = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output())
            .await
            .expect("CLI must settle promptly, including cleanup")
            .unwrap();
        server.abort();
        let _ = server.await;
        assert_eq!(
            output.status.code(),
            Some(if mode == "ordinary" { 0 } else { 2 }),
            "{mode}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if mode != "ordinary" {
            let body: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(body["code"], "cancelled");
            if mode != "upload-before-dispatch" {
                assert_eq!(body["message"], "parent cancellation reached daemon");
            }
            let received = received.lock().unwrap();
            let cancel = received.iter().position(|m| *m == Method::Cancel).unwrap();
            assert!(
                received[cancel + 1..]
                    .iter()
                    .all(|m| *m == Method::TransferRelease),
                "only cleanup may follow cancellation: {received:?}"
            );
        }
        let ids = ids.lock().unwrap();
        if mode.contains("stall") {
            assert_eq!(released.lock().unwrap().len(), 1);
            assert!(start.elapsed() >= Duration::from_secs(4));
            // The CLI cannot force an unresponsive daemon to clean up.
            transfers.release_session("fixture");
        } else {
            assert_eq!(
                *released.lock().unwrap(),
                *ids,
                "{mode}: every allocation must be released"
            );
            for id in ids.iter() {
                assert!(!staging_root.join(id).exists(), "staging leaked: {id}");
            }
            if mode.starts_with("upload") {
                let retry = transfers
                    .begin_upload(TransferBeginParams {
                        session_id: "fixture".into(),
                        name: "retry.txt".into(),
                        byte_size: 300 * 1024 * 1024,
                    })
                    .expect("same session must have room for another 300 MiB upload");
                transfers.release(TransferIdParams {
                    transfer_id: retry.transfer_id,
                });
            }
        }
        if mode == "download" {
            assert_eq!(
                std::fs::read(home.path().join("out.txt")).unwrap(),
                b"existing output"
            );
            assert!(
                !std::fs::read_dir(home.path())
                    .unwrap()
                    .flatten()
                    .any(|entry| entry.file_name().to_string_lossy().ends_with(".part"))
            );
        }
    }
}
