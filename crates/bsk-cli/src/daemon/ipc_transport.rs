//! UDS (Unix) and Named Pipe (Windows) JSON-line IPC server transport.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::ipc::{DaemonStatus, full_envelope_handler};
use super::state::{DAEMON_VERSION, DaemonState, PROTOCOL_VERSION};

/// RAII guard ensuring `on_close` always runs when a spawned IPC connection
/// task exits, including on panic or task cancellation, so `active_connections`
/// can never leak and block daemon idle shutdown.
struct ConnectionCloseGuard(Arc<dyn Fn() + Send + Sync>);

impl Drop for ConnectionCloseGuard {
    fn drop(&mut self) {
        (self.0)();
    }
}

/// Owning handle around a spawned IPC server task. Returned by
/// [`IpcServer::bind`] and the public [`super::run`] helper.
pub struct IpcHandle {
    pub sock_path: PathBuf,
    pub shutdown: Arc<Notify>,
    pub task: JoinHandle<()>,
}

pub struct IpcServer {
    state: Arc<DaemonState>,
}

impl IpcServer {
    pub fn new(state: Arc<DaemonState>) -> Self {
        Self { state }
    }

    /// Bind `sock_path` and spawn the serve loop. The returned
    /// [`IpcHandle`] can be used to wait for / shut down the task.
    pub async fn bind(self, sock_path: PathBuf) -> anyhow::Result<IpcHandle> {
        let started_at = Instant::now();
        let status = DaemonStatus {
            started_at,
            ws_port: 0,
            sock_path: sock_path.clone(),
            daemon_version: DAEMON_VERSION,
            protocol_version: PROTOCOL_VERSION,
        };
        let handler = full_envelope_handler(status, Arc::clone(&self.state));
        let listener = bind(&sock_path).await?;
        let shutdown = Arc::new(Notify::new());
        let shutdown_signal = Arc::clone(&shutdown);
        let task = tokio::spawn(serve(listener, handler, || {}, || {}, || {}, async move {
            shutdown_signal.notified().await;
        }));
        Ok(IpcHandle {
            sock_path,
            shutdown,
            task,
        })
    }
}

#[cfg(unix)]
mod unix {
    use std::path::Path;
    use std::sync::Arc;

    use anyhow::{Context, Result};
    use bsk_protocol::{ErrorCode, ResponseBody, RpcError};
    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{UnixListener, UnixStream};
    use tracing::{debug, info, warn};

    use crate::daemon::ipc::{EnvelopeRpcHandler, IntoEnvelopeHandler};
    use crate::ipc_client::{
        IpcEnvelope, IpcRequestEnvelope, IpcResponseEnvelope, IpcResponseMeta,
    };

    /// Bind the IPC server. Unbinds a stale socket if present (the daemon
    /// lock has already prevented two daemons running, so this is safe).
    pub async fn bind(path: &Path) -> Result<UnixListener> {
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let listener =
            UnixListener::bind(path).with_context(|| format!("bind UDS {}", path.display()))?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        Ok(listener)
    }

    /// Run the IPC server loop until `shutdown` resolves.
    pub async fn serve<H, S>(
        listener: UnixListener,
        handler: H,
        on_open: impl Fn() + Send + Sync + 'static,
        on_activity: impl Fn() + Send + Sync + 'static,
        on_close: impl Fn() + Send + Sync + 'static,
        shutdown: S,
    ) where
        H: IntoEnvelopeHandler,
        S: std::future::Future<Output = ()> + Send + 'static,
    {
        info!("ipc server listening");
        let handler = handler.into_envelope_handler();
        let on_open = Arc::new(on_open);
        let on_activity = Arc::new(on_activity);
        let on_close = Arc::new(on_close);
        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                _ = &mut shutdown => {
                    info!("ipc server shutdown requested");
                    break;
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _addr)) => {
                            on_open();
                            let close_guard = super::ConnectionCloseGuard(on_close.clone());
                            let handler = handler.clone();
                            let on_act = on_activity.clone();
                            tokio::spawn(async move {
                                let _close_guard = close_guard;
                                if let Err(err) = handle_connection(stream, handler, on_act).await {
                                    debug!(?err, "ipc connection ended with error");
                                }
                            });
                        }
                        Err(err) => {
                            warn!(?err, "ipc accept failed");
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                    }
                }
            }
        }
    }

    async fn handle_connection(
        stream: UnixStream,
        handler: EnvelopeRpcHandler,
        on_activity: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader.read_line(&mut line).await?;
            if n == 0 {
                break;
            }
            on_activity();
            let trimmed = line.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                continue;
            }

            let response = match serde_json::from_str::<IpcEnvelope>(trimmed) {
                Ok(IpcEnvelope::Request(IpcRequestEnvelope {
                    id,
                    method,
                    params,
                    meta,
                })) => {
                    let params = params.unwrap_or(Value::Null);
                    let (body, resp_meta) = (handler)(id.clone(), method, params, meta).await;
                    serde_json::to_string(&IpcEnvelope::Response(IpcResponseEnvelope {
                        id,
                        body,
                        meta: resp_meta,
                    }))?
                }
                Ok(other) => {
                    debug!(?other, "ipc client sent non-request frame");
                    continue;
                }
                Err(err) => serde_json::to_string(&IpcEnvelope::Response(IpcResponseEnvelope {
                    id: "0".into(),
                    body: ResponseBody::Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: format!("invalid frame: {err}"),
                        data: None,
                    }),
                    meta: IpcResponseMeta::default(),
                }))?,
            };

            write_half.write_all(response.as_bytes()).await?;
            write_half.write_all(b"\n").await?;
            write_half.flush().await?;
        }
        Ok(())
    }
}

#[cfg(unix)]
pub use unix::{bind, serve};

#[cfg(all(test, unix))]
mod unix_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn ipc_connection_close_guard_runs_even_when_handler_panics() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("panic-guard.sock");
        let listener = bind(&sock).await.unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let active_open = Arc::clone(&active);
        let active_close = Arc::clone(&active);
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();

        let handler: crate::daemon::ipc::RpcHandler = Arc::new(|_id, _method, _params| {
            Box::pin(async move {
                panic!("simulated IPC handler panic");
            })
        });
        let server = tokio::spawn(serve(
            listener,
            handler,
            move || {
                active_open.fetch_add(1, Ordering::SeqCst);
            },
            || {},
            move || {
                active_close.fetch_sub(1, Ordering::SeqCst);
            },
            async move {
                let _ = stop_rx.await;
            },
        ));

        let mut stream = tokio::net::UnixStream::connect(&sock).await.unwrap();
        let req = serde_json::json!({
            "id": "panic-1",
            "method": "system.ping",
            "params": {}
        });
        stream
            .write_all(format!("{req}\n").as_bytes())
            .await
            .unwrap();
        stream.flush().await.unwrap();
        drop(stream);

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while active.load(Ordering::SeqCst) != 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "active_connections leaked after IPC handler panic"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let _ = stop_tx.send(());
        server.await.unwrap();
    }
}

#[cfg(windows)]
mod windows {
    use std::path::Path;
    use std::sync::Arc;

    use anyhow::{Context, Result};
    use bsk_protocol::{ErrorCode, ResponseBody, RpcError};
    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use tracing::{debug, info, warn};

    use crate::daemon::ipc::{EnvelopeRpcHandler, IntoEnvelopeHandler};
    use crate::ipc_client::{
        IpcEnvelope, IpcRequestEnvelope, IpcResponseEnvelope, IpcResponseMeta,
    };

    pub struct NamedPipeListener {
        pipe_name: String,
        first: Option<NamedPipeServer>,
    }

    pub async fn bind(path: &Path) -> Result<NamedPipeListener> {
        let pipe_name = crate::daemon::paths::endpoint_pipe_name(path);
        let first = ServerOptions::new()
            .first_pipe_instance(true)
            .access_inbound(true)
            .access_outbound(true)
            .create(&pipe_name)
            .with_context(|| format!("create first named-pipe instance {pipe_name}"))?;
        Ok(NamedPipeListener {
            pipe_name,
            first: Some(first),
        })
    }

    pub async fn serve<H, S>(
        mut listener: NamedPipeListener,
        handler: H,
        on_open: impl Fn() + Send + Sync + 'static,
        on_activity: impl Fn() + Send + Sync + 'static,
        on_close: impl Fn() + Send + Sync + 'static,
        shutdown: S,
    ) where
        H: IntoEnvelopeHandler,
        S: std::future::Future<Output = ()> + Send + 'static,
    {
        info!(pipe = %listener.pipe_name, "ipc named-pipe server listening");
        let handler = handler.into_envelope_handler();
        let on_open = Arc::new(on_open);
        let on_activity = Arc::new(on_activity);
        let on_close = Arc::new(on_close);
        tokio::pin!(shutdown);
        loop {
            let pipe = match listener.first.take() {
                Some(pipe) => pipe,
                None => match ServerOptions::new()
                    .first_pipe_instance(false)
                    .access_inbound(true)
                    .access_outbound(true)
                    .create(&listener.pipe_name)
                {
                    Ok(pipe) => pipe,
                    Err(err) => {
                        warn!(?err, "create named-pipe instance failed");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        continue;
                    }
                },
            };

            tokio::select! {
                _ = &mut shutdown => {
                    info!("ipc named-pipe server shutdown requested");
                    break;
                }
                connected = pipe.connect() => {
                    match connected {
                        Ok(()) => {
                            // Keep the connected instance alive until its replacement
                            // exists. Otherwise a fast handler can close the last
                            // instance and make new clients fail with NotFound.
                            loop {
                                match ServerOptions::new()
                                    .access_inbound(true)
                                    .access_outbound(true)
                                    .create(&listener.pipe_name)
                                {
                                    Ok(next) => {
                                        listener.first = Some(next);
                                        break;
                                    }
                                    Err(err) => {
                                        warn!(?err, "create next named-pipe instance failed");
                                        tokio::select! {
                                            _ = &mut shutdown => return,
                                            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
                                        }
                                    }
                                }
                            }
                            on_open();
                            let close_guard = super::ConnectionCloseGuard(on_close.clone());
                            let handler = handler.clone();
                            let on_act = on_activity.clone();
                            tokio::spawn(async move {
                                let _close_guard = close_guard;
                                if let Err(err) = handle_connection(pipe, handler, on_act).await {
                                    debug!(?err, "named-pipe connection ended with error");
                                }
                            });
                        }
                        Err(err) => {
                            warn!(?err, "named-pipe connect failed");
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                    }
                }
            }
        }
    }

    async fn handle_connection(
        pipe: NamedPipeServer,
        handler: EnvelopeRpcHandler,
        on_activity: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let (read_half, mut write_half) = tokio::io::split(pipe);
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader.read_line(&mut line).await?;
            if n == 0 {
                break;
            }
            on_activity();
            let trimmed = line.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                continue;
            }

            let response = match serde_json::from_str::<IpcEnvelope>(trimmed) {
                Ok(IpcEnvelope::Request(IpcRequestEnvelope {
                    id,
                    method,
                    params,
                    meta,
                })) => {
                    let params = params.unwrap_or(Value::Null);
                    let (body, resp_meta) = (handler)(id.clone(), method, params, meta).await;
                    serde_json::to_string(&IpcEnvelope::Response(IpcResponseEnvelope {
                        id,
                        body,
                        meta: resp_meta,
                    }))?
                }
                Ok(other) => {
                    debug!(?other, "named-pipe client sent non-request frame");
                    continue;
                }
                Err(err) => serde_json::to_string(&IpcEnvelope::Response(IpcResponseEnvelope {
                    id: "0".into(),
                    body: ResponseBody::Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: format!("invalid frame: {err}"),
                        data: None,
                    }),
                    meta: IpcResponseMeta::default(),
                }))?,
            };

            write_half.write_all(response.as_bytes()).await?;
            write_half.write_all(b"\n").await?;
            write_half.flush().await?;
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::Mutex;
        use std::time::Duration;
        use tokio::net::windows::named_pipe::ClientOptions;
        use tokio::sync::oneshot;

        fn isolated_listener() -> NamedPipeListener {
            let pipe_name = format!(r"\\.\pipe\bsk-test-{}", uuid::Uuid::new_v4());
            let first = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe_name)
                .unwrap();
            NamedPipeListener {
                pipe_name,
                first: Some(first),
            }
        }

        #[tokio::test]
        async fn next_instance_exists_before_connection_is_handed_off() {
            let listener = isolated_listener();
            let name = listener.pipe_name.clone();
            let probe_name = name.clone();
            let (probe_tx, probe_rx) = oneshot::channel();
            let probe_tx = Mutex::new(Some(probe_tx));
            let (stop_tx, stop_rx) = oneshot::channel();
            let server = tokio::spawn(serve(
                listener,
                crate::daemon::ipc::default_ping_handler(),
                move || {
                    if let Some(tx) = probe_tx.lock().unwrap().take() {
                        // This callback runs before the connection task can finish.
                        // A second client must already have an instance to open.
                        let result = ClientOptions::new().open(&probe_name).map(drop);
                        let _ = tx.send(result);
                    }
                },
                || {},
                || {},
                async {
                    let _ = stop_rx.await;
                },
            ));
            let client = ClientOptions::new().open(&name).unwrap();
            let result = tokio::time::timeout(Duration::from_secs(5), probe_rx).await;
            drop(client);
            let _ = stop_tx.send(());
            server.await.unwrap();
            result
                .expect("accept callback ran")
                .unwrap()
                .expect("next pipe instance is ready");
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn rapid_disconnects_and_concurrent_rpc_connections() {
            let listener = isolated_listener();
            let name = listener.pipe_name.clone();
            let (stop_tx, stop_rx) = oneshot::channel();
            let server = tokio::spawn(serve(
                listener,
                crate::daemon::ipc::default_ping_handler(),
                || {},
                || {},
                || {},
                async {
                    let _ = stop_rx.await;
                },
            ));
            let exercise = async {
                // Include clients that close without sending any request.
                for _ in 0..64 {
                    drop(
                        crate::ipc_client::Client::connect_path(name.clone().into())
                            .await
                            .unwrap(),
                    );
                }
                let mut clients = tokio::task::JoinSet::new();
                for _ in 0..8 {
                    let name = name.clone();
                    clients.spawn(async move {
                        for _ in 0..32 {
                            let mut client =
                                crate::ipc_client::Client::connect_path(name.clone().into())
                                    .await
                                    .unwrap();
                            let reply: bsk_protocol::PingResult = client
                                .call(
                                    bsk_protocol::Method::SystemPing,
                                    &serde_json::json!({}),
                                    Duration::from_secs(5),
                                )
                                .await
                                .unwrap()
                                .unwrap();
                            assert!(reply.pong);
                        }
                    });
                }
                while let Some(result) = clients.join_next().await {
                    result.unwrap();
                }
            };
            let result = tokio::time::timeout(Duration::from_secs(30), exercise).await;
            let _ = stop_tx.send(());
            server.await.unwrap();
            result.expect("connection exercise completed");
        }
    }
}

#[cfg(windows)]
pub use windows::{bind, serve};
