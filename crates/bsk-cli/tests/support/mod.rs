//! Shared synchronization helpers for IPC integration tests.
//!
//! Prefer condition-based waits over fixed `sleep` so tests proceed as soon
//! as the daemon / fake extension reaches the expected state.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use bsk::daemon::queue::ToolQueueRegistry;
use bsk::daemon::sessions::SessionId;
use bsk::daemon::state::DaemonState;
use bsk_protocol::RpcId;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(2);

/// Poll `condition` until it returns `true` or `timeout` elapses.
pub async fn wait_until<F>(label: &str, timeout: Duration, mut condition: F)
where
    F: FnMut() -> bool,
{
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return;
        }
        if Instant::now() >= deadline {
            panic!("timed out waiting for {label}");
        }
        tokio::task::yield_now().await;
    }
}

pub async fn wait_for_browser_count(state: &Arc<DaemonState>, expected: usize) {
    wait_until(
        &format!("browser count == {expected}"),
        DEFAULT_TIMEOUT,
        || state.browsers.len() == expected,
    )
    .await;
}

pub async fn wait_for_no_sessions(state: &Arc<DaemonState>) {
    wait_until("no sessions", DEFAULT_TIMEOUT, || state.sessions.is_empty()).await;
}

pub async fn wait_for_session_count(state: &Arc<DaemonState>, expected: usize) {
    wait_until(
        &format!("session count == {expected}"),
        DEFAULT_TIMEOUT,
        || state.sessions.len() == expected,
    )
    .await;
}

pub async fn wait_for_inflight_registered(state: &Arc<DaemonState>, rpc_id: &RpcId) {
    let id = rpc_id.clone();
    wait_until(
        &format!("inflight registered for {id}"),
        DEFAULT_TIMEOUT,
        || state.tool_inflight.get(&id).is_some(),
    )
    .await;
}

pub async fn wait_for_inflight_forwarded(state: &Arc<DaemonState>, rpc_id: &RpcId) {
    let id = rpc_id.clone();
    wait_until(
        &format!("inflight forwarded for {id}"),
        DEFAULT_TIMEOUT,
        || {
            state
                .tool_inflight
                .get(&id)
                .is_some_and(|entry| entry.snapshot().ws_rpc_id.is_some())
        },
    )
    .await;
}

pub async fn wait_for_abort_registered(state: &Arc<DaemonState>, rpc_id: &RpcId) {
    let id = rpc_id.clone();
    wait_until(&format!("abort token for {id}"), DEFAULT_TIMEOUT, || {
        state.abort_registry.contains(&id)
    })
    .await;
}

pub async fn wait_for_session_interrupt_pending(state: &Arc<DaemonState>, session_id: &str) {
    let sid = SessionId(session_id.to_string());
    wait_until(
        &format!("session interrupt pending for {session_id}"),
        DEFAULT_TIMEOUT,
        || state.session_interrupts.is_pending(&sid),
    )
    .await;
}

pub async fn wait_for_session_not_accepting(queues: &Arc<ToolQueueRegistry>, sid: &SessionId) {
    let sid = sid.clone();
    wait_until(
        &format!("session {} queue closed to new tools", sid.0),
        DEFAULT_TIMEOUT,
        || !queues.is_accepting(&sid),
    )
    .await;
}

pub fn bsk_bin() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_bsk"))
}

/// Short temporary directory whose socket path fits within Unix `SUN_LEN`
/// limits while falling back to the standard temp directory on Windows.
pub fn short_tempdir() -> tempfile::TempDir {
    #[cfg(unix)]
    {
        tempfile::tempdir_in("/tmp").expect("create short tempdir in /tmp")
    }
    #[cfg(not(unix))]
    {
        tempfile::tempdir().expect("create tempdir")
    }
}

/// Send one raw JSON-line IPC frame over UDS (Unix) or Named Pipe (Windows)
/// and return the parsed JSON response line.
pub async fn send_raw_ipc(
    sock: &std::path::Path,
    payload: &serde_json::Value,
) -> serde_json::Value {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let mut line = serde_json::to_string(payload).expect("encode raw ipc frame");
    line.push('\n');

    #[cfg(unix)]
    let (read, mut write) = {
        let stream = tokio::net::UnixStream::connect(sock)
            .await
            .expect("connect raw unix ipc stream");
        tokio::io::split(stream)
    };

    #[cfg(windows)]
    let (read, mut write) = {
        use tokio::net::windows::named_pipe::ClientOptions;
        const ERROR_PIPE_BUSY: i32 = 231;
        let pipe_name = bsk::daemon::paths::endpoint_pipe_name(sock);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let client = loop {
            match ClientOptions::new().open(&pipe_name) {
                Ok(client) => break client,
                Err(err)
                    if err.raw_os_error() == Some(ERROR_PIPE_BUSY)
                        && tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(err) => panic!("connect raw named pipe {pipe_name}: {err}"),
            }
        };
        tokio::io::split(client)
    };

    write
        .write_all(line.as_bytes())
        .await
        .expect("write raw ipc frame");
    write.flush().await.expect("flush raw ipc frame");
    let mut reply_line = String::new();
    BufReader::new(read)
        .read_line(&mut reply_line)
        .await
        .expect("read raw ipc reply");
    serde_json::from_str(reply_line.trim_end()).expect("parse raw ipc reply")
}

/// Bind a raw JSON-line IPC test server synchronously (UDS on Unix, Named Pipe
/// on Windows) and spawn a background accept loop invoking `responder` per line.
pub fn spawn_raw_ipc_server<F>(sock: &std::path::Path, responder: F) -> tokio::task::JoinHandle<()>
where
    F: Fn(serde_json::Value) -> serde_json::Value + Send + Sync + 'static,
{
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let responder = Arc::new(responder);

    #[cfg(unix)]
    {
        if sock.exists() {
            let _ = std::fs::remove_file(sock);
        }
        let listener = tokio::net::UnixListener::bind(sock).expect("bind raw unix ipc listener");
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let responder = Arc::clone(&responder);
                tokio::spawn(async move {
                    let (read, mut write) = stream.into_split();
                    let mut reader = BufReader::new(read);
                    let mut line = String::new();
                    while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        if !trimmed.is_empty() {
                            let req: serde_json::Value =
                                serde_json::from_str(trimmed).expect("parse raw ipc request");
                            let resp = responder(req);
                            let mut bytes =
                                serde_json::to_vec(&resp).expect("encode raw ipc response");
                            bytes.push(b'\n');
                            if write.write_all(&bytes).await.is_err()
                                || write.flush().await.is_err()
                            {
                                break;
                            }
                        }
                        line.clear();
                    }
                });
            }
        })
    }

    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        let pipe_name = bsk::daemon::paths::endpoint_pipe_name(sock);
        let mut current = Some(
            ServerOptions::new()
                .first_pipe_instance(true)
                .access_inbound(true)
                .access_outbound(true)
                .create(&pipe_name)
                .expect("create initial raw named pipe instance"),
        );
        tokio::spawn(async move {
            loop {
                let pipe = match current.take() {
                    Some(pipe) => pipe,
                    None => match ServerOptions::new()
                        .access_inbound(true)
                        .access_outbound(true)
                        .create(&pipe_name)
                    {
                        Ok(pipe) => pipe,
                        Err(_) => {
                            tokio::time::sleep(Duration::from_millis(25)).await;
                            continue;
                        }
                    },
                };
                if pipe.connect().await.is_err() {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    continue;
                }
                current = ServerOptions::new()
                    .access_inbound(true)
                    .access_outbound(true)
                    .create(&pipe_name)
                    .ok();
                let responder = Arc::clone(&responder);
                tokio::spawn(async move {
                    let (read, mut write) = tokio::io::split(pipe);
                    let mut reader = BufReader::new(read);
                    let mut line = String::new();
                    while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        if !trimmed.is_empty() {
                            let req: serde_json::Value =
                                serde_json::from_str(trimmed).expect("parse raw ipc request");
                            let resp = responder(req);
                            let mut bytes =
                                serde_json::to_vec(&resp).expect("encode raw ipc response");
                            bytes.push(b'\n');
                            if write.write_all(&bytes).await.is_err()
                                || write.flush().await.is_err()
                            {
                                break;
                            }
                        }
                        line.clear();
                    }
                });
            }
        })
    }
}

#[cfg(unix)]
pub fn wait_for_pid_exit(pid: i32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        if !alive {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}
