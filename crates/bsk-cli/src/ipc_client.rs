//! CLI-side IPC client: reads `~/.bsk/daemon.json` for the socket path
//! and issues typed JSON-line RPCs over it.
//!
//! Each [`Client::call`] is a fresh connection (cheap: UDS is local).
//! Future milestones may pool connections for the long-running `bsk
//! events` / `bsk logs -f` commands.
//!
//! On Windows the same line protocol runs over a per-user named pipe.

use bsk_protocol::RpcError;

#[cfg(unix)]
mod platform {
    use std::path::PathBuf;
    use std::time::Duration;

    use anyhow::{Context, Result};
    use bsk_protocol::{Frame, Method, RequestFrame, ResponseBody, StatusParams, StatusResult};
    use serde::{Serialize, de::DeserializeOwned};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::time::timeout;

    use crate::daemon::info as daemon_info;
    use crate::ipc_client::{RpcOutcome, random_id};

    /// Connected IPC client. Holds an open UDS connection plus a buffered
    /// reader/writer pair.
    pub struct Client {
        stream: BufReader<tokio::net::unix::OwnedReadHalf>,
        write: tokio::net::unix::OwnedWriteHalf,
        sock_path: PathBuf,
    }

    impl Client {
        /// Connect to the daemon described in `daemon.json`. Fails if no
        /// info file exists, the pid is dead, or the UDS is unreachable.
        pub async fn connect() -> Result<Self> {
            let info = daemon_info::read_valid()
                .context("read daemon.json")?
                .ok_or_else(|| anyhow::anyhow!("no live daemon (daemon.json missing or stale)"))?;
            let mut client = Self::connect_path(info.sock_path).await?;
            let status = client
                .call::<_, StatusResult>(
                    Method::SystemStatus,
                    &StatusParams::default(),
                    Duration::from_secs(2),
                )
                .await?
                .map_err(|err| {
                    anyhow::anyhow!(
                        "daemon verification RPC failed: {} ({:?})",
                        err.message,
                        err.code
                    )
                })?;
            if status.pid != info.pid {
                return Err(anyhow::anyhow!(
                    "daemon.json pid {} does not match IPC daemon pid {}",
                    info.pid,
                    status.pid
                ));
            }
            Ok(client)
        }

        /// Connect directly to a UDS path (used by tests + auto-spawn
        /// after the parent has just written daemon.json).
        pub async fn connect_path(sock_path: PathBuf) -> Result<Self> {
            let stream = UnixStream::connect(&sock_path)
                .await
                .with_context(|| format!("connect IPC socket {}", sock_path.display()))?;
            let (read, write) = stream.into_split();
            Ok(Self {
                stream: BufReader::new(read),
                write,
                sock_path,
            })
        }

        /// Issue a typed RPC: serialise `params`, send one JSON line, read
        /// one JSON line back, deserialise into `R`. Honours an overall
        /// `timeout`.
        pub async fn call<P: Serialize, R: DeserializeOwned>(
            &mut self,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            self.call_with_id(random_id(), method, params, call_timeout)
                .await
        }

        /// Same as [`Client::call`] but uses the caller-provided
        /// `id` as the wire correlation id. Lets the SIGINT cancel
        /// helper refer back to a known id without racing the
        /// random_id() generator (M10.2).
        pub async fn call_with_id<P: Serialize, R: DeserializeOwned>(
            &mut self,
            id: String,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            let frame = Frame::Request(RequestFrame {
                id: id.clone(),
                method,
                params: Some(serde_json::to_value(params).context("serialise params")?),
            });
            let mut payload = serde_json::to_string(&frame).context("encode request")?;
            payload.push('\n');

            timeout(call_timeout, async {
                self.write.write_all(payload.as_bytes()).await?;
                self.write.flush().await?;
                Result::<()>::Ok(())
            })
            .await
            .context("IPC write timed out")??;

            let mut line = String::new();
            timeout(call_timeout, self.stream.read_line(&mut line))
                .await
                .context("IPC read timed out")??;

            decode_response(line.trim_end(), &id)
        }

        /// Path of the socket this client connected through (debug helper).
        pub fn sock_path(&self) -> &std::path::Path {
            &self.sock_path
        }
    }

    fn decode_response<R: DeserializeOwned>(line: &str, id: &str) -> Result<RpcOutcome<R>> {
        let frame: Frame = serde_json::from_str(line).context("decode IPC response")?;
        match frame {
            Frame::Response(resp) => {
                if resp.id != id {
                    return Err(anyhow::anyhow!(
                        "IPC response id mismatch: expected {id}, got {}",
                        resp.id
                    ));
                }
                match resp.body {
                    ResponseBody::Ok(v) => {
                        let value: R = serde_json::from_value(v).context("decode result")?;
                        Ok(Ok(value))
                    }
                    ResponseBody::Err(e) => Ok(Err(e)),
                }
            }
            other => Err(anyhow::anyhow!("unexpected frame from daemon: {other:?}")),
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use anyhow::{Context, Result};
    use bsk_protocol::{Frame, Method, RequestFrame, ResponseBody, StatusParams, StatusResult};
    use serde::{Serialize, de::DeserializeOwned};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
    use tokio::time::{sleep, timeout};
    use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;

    use crate::daemon::info as daemon_info;
    use crate::ipc_client::{RpcOutcome, random_id};

    pub struct Client {
        stream: BufReader<tokio::io::ReadHalf<NamedPipeClient>>,
        write: tokio::io::WriteHalf<NamedPipeClient>,
        pipe_name: PathBuf,
    }

    impl Client {
        pub async fn connect() -> Result<Self> {
            let info = daemon_info::read_valid()
                .context("read daemon.json")?
                .ok_or_else(|| anyhow::anyhow!("no live daemon (daemon.json missing or stale)"))?;
            let mut client = Self::connect_path(info.sock_path).await?;
            let status = client
                .call::<_, StatusResult>(
                    Method::SystemStatus,
                    &StatusParams::default(),
                    Duration::from_secs(2),
                )
                .await?
                .map_err(|err| {
                    anyhow::anyhow!(
                        "daemon verification RPC failed: {} ({:?})",
                        err.message,
                        err.code
                    )
                })?;
            if status.pid != info.pid {
                return Err(anyhow::anyhow!(
                    "daemon.json pid {} does not match IPC daemon pid {}",
                    info.pid,
                    status.pid
                ));
            }
            Ok(client)
        }

        /// Total budget for retrying `ERROR_PIPE_BUSY` while connecting
        /// to the daemon's named pipe. Long enough to ride out a
        /// short-lived burst of clients, short enough that a wedged or
        /// preempted pipe surfaces as a clear error rather than a
        /// silent hang.
        const CONNECT_BUSY_TIMEOUT: Duration = Duration::from_secs(2); // Reduced from 5s to 2s

        pub async fn connect_path(pipe_name: PathBuf) -> Result<Self> {
            let name = pipe_name.to_string_lossy().into_owned();
            let connect_loop = async {
                loop {
                    match ClientOptions::new().open(&name) {
                        Ok(client) => return Ok::<NamedPipeClient, anyhow::Error>(client),
                        Err(err) if err.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                            sleep(Duration::from_millis(25)).await; // Reduced from 50ms to 25ms
                        }
                        Err(err) => {
                            return Err(anyhow::Error::from(err)
                                .context(format!("connect IPC named pipe {name}")));
                        }
                    }
                }
            };
            let client = timeout(Self::CONNECT_BUSY_TIMEOUT, connect_loop)
                .await
                .map_err(|_| {
                    anyhow::anyhow!(
                        "named pipe {name} still busy after {:?}; daemon may be wedged or preempted",
                        Self::CONNECT_BUSY_TIMEOUT
                    )
                })??;
            let (read, write) = tokio::io::split(client);
            Ok(Self {
                stream: BufReader::new(read),
                write,
                pipe_name,
            })
        }

        pub async fn call<P: Serialize, R: DeserializeOwned>(
            &mut self,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            self.call_with_id(random_id(), method, params, call_timeout)
                .await
        }

        pub async fn call_with_id<P: Serialize, R: DeserializeOwned>(
            &mut self,
            id: String,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            let frame = Frame::Request(RequestFrame {
                id: id.clone(),
                method,
                params: Some(serde_json::to_value(params).context("serialise params")?),
            });
            let mut payload = serde_json::to_string(&frame).context("encode request")?;
            payload.push('\n');

            timeout(call_timeout, async {
                self.write.write_all(payload.as_bytes()).await?;
                self.write.flush().await?;
                Result::<()>::Ok(())
            })
            .await
            .context("IPC write timed out")??;

            let mut line = String::new();
            timeout(call_timeout, self.stream.read_line(&mut line))
                .await
                .context("IPC read timed out")??;

            decode_response(line.trim_end(), &id)
        }

        pub fn sock_path(&self) -> &Path {
            &self.pipe_name
        }
    }

    fn decode_response<R: DeserializeOwned>(line: &str, id: &str) -> Result<RpcOutcome<R>> {
        let frame: Frame = serde_json::from_str(line).context("decode IPC response")?;
        match frame {
            Frame::Response(resp) => {
                if resp.id != id {
                    return Err(anyhow::anyhow!(
                        "IPC response id mismatch: expected {id}, got {}",
                        resp.id
                    ));
                }
                match resp.body {
                    ResponseBody::Ok(v) => {
                        let value: R = serde_json::from_value(v).context("decode result")?;
                        Ok(Ok(value))
                    }
                    ResponseBody::Err(e) => Ok(Err(e)),
                }
            }
            other => Err(anyhow::anyhow!("unexpected frame from daemon: {other:?}")),
        }
    }
}

pub use platform::Client;

/// Result of a typed RPC: either the deserialised happy-path result or
/// the structured `RpcError` returned by the daemon.
pub type RpcOutcome<T> = std::result::Result<T, RpcError>;

/// Test/embed helper that exposes the M4/M5 `IpcClient` API on top of the
/// production [`Client`]. Skips the `daemon.json` pid-verification step
/// so integration tests can talk to an ad-hoc daemon spawned via
/// [`crate::daemon::run`].
pub struct IpcClient {
    inner: Client,
}

impl IpcClient {
    pub async fn connect(sock_path: impl AsRef<std::path::Path>) -> anyhow::Result<Self> {
        let inner = Client::connect_path(sock_path.as_ref().to_path_buf()).await?;
        Ok(Self { inner })
    }

    /// Issue a single RPC. The `_id` argument exists for API parity with
    /// the M4/M5 surface; the underlying [`Client::call`] generates its
    /// own correlation id since the wire id is only meaningful inside
    /// one connection.
    pub async fn call<P, R>(
        &mut self,
        _id: impl Into<bsk_protocol::RpcId>,
        method: bsk_protocol::Method,
        params: Option<P>,
        call_timeout: std::time::Duration,
    ) -> anyhow::Result<std::result::Result<R, RpcError>>
    where
        P: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        match params {
            Some(p) => self.inner.call::<P, R>(method, &p, call_timeout).await,
            None => self.inner.call::<(), R>(method, &(), call_timeout).await,
        }
    }

    /// Same as [`IpcClient::call`] but pins the wire correlation id
    /// so the SIGINT cancel helper can refer back to it (M10.2).
    pub async fn call_with_id<P, R>(
        &mut self,
        id: bsk_protocol::RpcId,
        method: bsk_protocol::Method,
        params: Option<P>,
        call_timeout: std::time::Duration,
    ) -> anyhow::Result<std::result::Result<R, RpcError>>
    where
        P: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        match params {
            Some(p) => {
                self.inner
                    .call_with_id::<P, R>(id, method, &p, call_timeout)
                    .await
            }
            None => {
                self.inner
                    .call_with_id::<(), R>(id, method, &(), call_timeout)
                    .await
            }
        }
    }
}

/// Generate an opaque RPC correlation id (12 lowercase hex chars).
fn random_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; 6];
    rng.fill(&mut bytes[..]);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
