//! Real CLI cancellation over Unix sockets / Windows named pipes, including
//! caller-owned transfer cleanup and cancellation before RPC registration.
#![cfg(any(unix, windows))]

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bsk::daemon::{file_transfer::TransferRegistry, info::DaemonInfo};
use bsk_protocol::tools::{TransferBeginParams, TransferIdParams};
use bsk_protocol::{ErrorCode, Frame, Method, ResponseBody, ResponseFrame, RpcError};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(windows)]
use tokio::net::windows::named_pipe::ServerOptions;
use tokio::process::Command;
use tokio::sync::{Notify, watch};

/// Keep the actual operation outside the daemon until after the CLI has
/// returned from its two-second cancel grace. The production handler, queues
/// and execution registries then see the late request, not a mocked cancel.
#[test]
fn cancelled_cli_cannot_dispatch_a_late_admitted_request() {
    const NAME: &str = "cancelled_cli_cannot_dispatch_a_late_admitted_request";
    if std::env::var("BSK_ADMISSION_TEST_CHILD").as_deref() != Ok(NAME) {
        let home = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--nocapture"])
            .env("BSK_ADMISSION_TEST_CHILD", NAME)
            .env("BSK_HOME", home.path())
            .env("BSK_AUTO_UPDATE", "off")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(late_admission());
}

async fn late_admission() {
    use bsk::daemon::{
        DaemonConfig, DaemonState,
        browsers::{BrowserClient, BrowserId, BrowserSink, Liveness, Pending},
        ipc::{DaemonStatus, full_handler},
        sessions::{Session, SessionId},
    };
    use bsk::ipc_client::IpcClient;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let home = std::path::PathBuf::from(std::env::var_os("BSK_HOME").unwrap());
    #[cfg(unix)]
    let address = home.join("admission.sock");
    #[cfg(windows)]
    let address =
        std::path::PathBuf::from(format!(r"\\.\pipe\bsk-admission-{}", uuid::Uuid::new_v4()));
    #[cfg(unix)]
    let listener = tokio::net::UnixListener::bind(&address).unwrap();
    #[cfg(windows)]
    let mut pipe = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&address)
        .unwrap();
    let state = Arc::new(DaemonState::new(DaemonConfig::new(0)));
    let (tx, mut frames) = tokio::sync::mpsc::unbounded_channel();
    let browser = Arc::new(BrowserClient {
        id: BrowserId("fixture-browser".into()),
        browser_name: "chrome".into(),
        browser_version: "test".into(),
        extension_version: "0.4.1".into(),
        extension_protocol_version: "1.8".into(),
        label: "fixture".into(),
        sink: BrowserSink { tx },
        pending: Mutex::new(Pending::default()),
        generation: 1,
        connected_at_ms: 0,
        version_skew: false,
        liveness: Liveness::default(),
    });
    state.browsers.insert(browser.clone());
    let session = SessionId("fixture".into());
    state.sessions.insert(Session {
        controller: None,
        interaction: None,
        id: session.clone(),
        browser_id: browser.id.clone(),
        agent_window_id: Some(42),
        created_at_ms: 0,
    });
    state.tool_queues.spawn(session);
    let dispatched = Arc::new(AtomicUsize::new(0));
    let count = dispatched.clone();
    let extension = tokio::spawn(async move {
        while let Some(Frame::Request(request)) = frames.recv().await {
            count.fetch_add(1, Ordering::SeqCst);
            browser.pending.lock().unwrap().resolve(ResponseFrame {
                id: request.id,
                body: ResponseBody::Ok(json!({"tab_id":42})),
            });
        }
    });
    let handler = full_handler(
        DaemonStatus {
            started_at: Instant::now(),
            ws_port: 0,
            sock_path: address.clone(),
            daemon_version: "0.4.1",
            protocol_version: "1.8",
        },
        state.clone(),
    );
    let info = DaemonInfo::now(std::process::id(), address.clone(), 0, "0.4.1");
    std::fs::write(home.join("daemon.json"), serde_json::to_vec(&info).unwrap()).unwrap();
    let status_calls = Arc::new(AtomicUsize::new(0));
    let status_count = status_calls.clone();
    let received = Arc::new(Notify::new());
    let first = received.clone();
    let (release, gate) = watch::channel(false);
    let (results, mut result) = tokio::sync::mpsc::unbounded_channel();
    #[cfg(windows)]
    let endpoint = address.clone();
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            #[cfg(unix)]
            let (connection, _) = listener.accept().await.unwrap();
            #[cfg(windows)]
            let connection = {
                pipe.connect().await.unwrap();
                let next = ServerOptions::new().create(&endpoint).unwrap();
                std::mem::replace(&mut pipe, next)
            };
            let handler = handler.clone();
            let status_count = status_count.clone();
            let first = first.clone();
            let mut gate = gate.clone();
            let results = results.clone();
            connections.spawn(async move {
                let (read, mut write) = tokio::io::split(connection);
                let mut reader = BufReader::new(read);
                let mut line = String::new();
                while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                    let Frame::Request(request) = serde_json::from_str::<Frame>(&line).unwrap()
                    else {
                        panic!("expected request")
                    };
                    line.clear();
                    if request.method == Method::SystemStatus {
                        status_count.fetch_add(1, Ordering::SeqCst);
                    }
                    let delayed = request.method == Method::ToolClick && !*gate.borrow();
                    if delayed {
                        first.notify_one();
                        gate.wait_for(|ready| *ready).await.unwrap();
                    }
                    let body = handler(
                        request.id.clone(),
                        request.method,
                        request.params.unwrap_or_default(),
                    )
                    .await;
                    if delayed {
                        results.send(body.clone()).unwrap();
                    }
                    let mut bytes = serde_json::to_vec(&ResponseFrame {
                        id: request.id,
                        body,
                    })
                    .unwrap();
                    bytes.push(b'\n');
                    if write.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    // The optional override also lets this exact regression exercise an older CLI.
    let executable = std::env::var_os("BSK_ADMISSION_TEST_CLI")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_bsk").into());
    let mut child = Command::new(executable)
        .env("BSK_HOME", &home)
        .env("BSK_AUTO_START", "0")
        .env("BSK_AUTO_UPDATE", "off")
        .env("BSK_CANCEL_ON_STDIN_CLOSE", "1")
        .args(["click", "--session", "fixture", "--ref", "@e1", "--json"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(8), received.notified())
        .await
        .unwrap();
    assert_eq!(
        status_calls.load(Ordering::SeqCst),
        1,
        "reuse discovery capability without another status RPC"
    );
    let start = Instant::now();
    drop(child.stdin.take());
    let output = tokio::time::timeout(Duration::from_secs(4), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(2),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(start.elapsed() < Duration::from_secs(3));
    // The CLI is already gone; no cancellation retry can rescue this request.
    release.send(true).unwrap();
    let late = tokio::time::timeout(Duration::from_secs(3), result.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(
            late,
            ResponseBody::Err(RpcError {
                code: ErrorCode::Cancelled,
                ..
            })
        ),
        "late result: {late:?}"
    );
    assert_eq!(
        dispatched.load(Ordering::SeqCst),
        0,
        "cancelled operation reached browser"
    );
    assert!(state.tool_inflight.is_empty());
    let mut client = IpcClient::connect(address).await.unwrap();
    let next = client
        .call::<_, serde_json::Value>(
            "next",
            Method::ToolClick,
            Some(json!({"session_id":"fixture","ref":"@e2"})),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert!(next.is_ok(), "session did not recover: {next:?}");
    assert_eq!(dispatched.load(Ordering::SeqCst), 1);
    server.abort();
    extension.abort();
    let _ = server.await;
    let _ = extension.await;
}

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
        "late-registration",
        "missing-registration",
        "unregistered-method",
        "cancel-no-response",
        "confirmed-but-stalled",
        "completed-during-cancel",
        "upload",
        "upload-multi",
        "upload-before-dispatch",
        "download",
        "upload-multi-stall",
        "ordinary",
    ] {
        let home = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let address = std::path::PathBuf::from(format!(
            r"\\.\pipe\bsk-parent-cancel-{}",
            uuid::Uuid::new_v4()
        ));
        #[cfg(unix)]
        let address = home.path().join("daemon.sock");
        let info = DaemonInfo::now(std::process::id(), address.clone(), 0, "0.2.0");
        std::fs::write(
            home.path().join("daemon.json"),
            serde_json::to_vec(&info).unwrap(),
        )
        .unwrap();
        #[cfg(windows)]
        let mut pipe = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&address)
            .unwrap();
        #[cfg(unix)]
        let listener = tokio::net::UnixListener::bind(&address).unwrap();
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
        let first_cancel = Arc::new(Notify::new());
        let ready = Arc::clone(&registered);
        let name = address;
        let registry = Arc::clone(&transfers);
        let server_ids = Arc::clone(&ids);
        let server_released = Arc::clone(&released);
        let server_received = Arc::clone(&received);
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                #[cfg(windows)]
                let connection = {
                    pipe.connect().await.unwrap();
                    let next = ServerOptions::new().create(&name).unwrap();
                    std::mem::replace(&mut pipe, next)
                };
                #[cfg(unix)]
                let (connection, _) = listener.accept().await.unwrap();
                let ready = Arc::clone(&ready);
                let pending = Arc::clone(&pending);
                let cancel = cancel.clone();
                let first_cancel = Arc::clone(&first_cancel);
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
                            Method::ToolWaitMs if mode == "completed-during-cancel" => {
                                ready.notify_one();
                                first_cancel.notified().await;
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
                            | Method::SessionList
                            | Method::TransferChunk
                            | Method::TransferRead
                            | Method::TransferFinish => {
                                if matches!(
                                    mode,
                                    "late-registration"
                                        | "missing-registration"
                                        | "unregistered-method"
                                ) {
                                    // Independent IPC connections need not reach registration in
                                    // send order. Let the first cancel overtake this request.
                                    ready.notify_one();
                                    first_cancel.notified().await;
                                    if mode != "late-registration" {
                                        std::future::pending::<()>().await;
                                    }
                                }
                                *pending.lock().unwrap() = Some(req.id.clone());
                                ready.notify_one();
                                cancelled.wait_for(|value| *value).await.unwrap();
                                if mode == "confirmed-but-stalled" {
                                    std::future::pending::<()>().await;
                                }
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
                                if mode == "cancel-no-response" {
                                    std::future::pending::<()>().await;
                                }
                                let target = params["rpc_id"].as_str().unwrap();
                                let matched = pending.lock().unwrap().as_deref() == Some(target);
                                if matched {
                                    cancel.send(true).unwrap();
                                } else {
                                    assert!(
                                        mode.ends_with("registration")
                                            || mode == "unregistered-method"
                                            || mode == "completed-during-cancel"
                                    );
                                    first_cancel.notify_one();
                                }
                                ResponseBody::Ok(json!({"cancelled": matched}))
                            }
                            Method::TransferRelease => {
                                let params: TransferIdParams =
                                    serde_json::from_value(params).unwrap();
                                released.lock().unwrap().push(params.transfer_id.clone());
                                if mode == "upload-multi-stall" {
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
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
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
        } else if mode == "unregistered-method" {
            cmd.args(["session", "list"]);
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
            Some(if mode == "ordinary" || mode == "completed-during-cancel" {
                0
            } else {
                2
            }),
            "{mode}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if mode == "completed-during-cancel" {
            let body: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(body["waited_ms"], 1);
        } else if mode != "ordinary" {
            let body: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(body["code"], "cancelled");
            if matches!(
                mode,
                "missing-registration"
                    | "unregistered-method"
                    | "cancel-no-response"
                    | "confirmed-but-stalled"
            ) {
                assert_eq!(
                    body["message"],
                    "rpc did not respond within cancel grace window"
                );
                // A separate confirmation budget would make these take 4s.
                assert!(
                    start.elapsed() >= Duration::from_millis(1800)
                        && start.elapsed() < Duration::from_secs(3),
                    "{mode}: cancellation took {:?}",
                    start.elapsed()
                );
            } else if mode != "upload-before-dispatch" {
                assert_eq!(body["message"], "parent cancellation reached daemon");
            }
            let received = received.lock().unwrap();
            let cancel = received.iter().position(|m| *m == Method::Cancel).unwrap();
            assert!(
                received[cancel + 1..]
                    .iter()
                    .all(|m| *m == Method::TransferRelease || *m == Method::Cancel),
                "only cleanup may follow cancellation: {received:?}"
            );
            let cancel_count = received.iter().filter(|m| **m == Method::Cancel).count();
            if mode.ends_with("registration") || mode == "unregistered-method" {
                assert!(cancel_count > 1);
                assert!(
                    cancel_count <= 12,
                    "{mode}: excessive retries: {cancel_count}"
                );
            } else {
                assert_eq!(cancel_count, 1, "{mode}: unexpected cancel retry");
            }
        }
        let ids = ids.lock().unwrap();
        if mode == "upload-multi-stall" {
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
