//! CLI-side IPC client: reads `~/.bsk/daemon.json` for the socket path
//! and issues typed JSON-line RPCs over it.
//!
//! Each [`Client::call`] is a fresh connection (cheap: UDS is local).
//! Future milestones may pool connections for the long-running `bsk
//! events` / `bsk logs -f` commands.
//!
//! On Windows the same line protocol runs over a per-user named pipe.

use std::fmt;

use anyhow::{Context, Result};
use bsk_protocol::{
    DecodeError, EventFrame, EventKind, Method, ResponseBody, ResponseFrame, RpcError, RpcId,
};
use serde::de::{self, DeserializeOwned, MapAccess, Visitor};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

fn is_false(v: &bool) -> bool {
    !*v
}

/// Request-side transport metadata on the local CLI/MCP ↔ daemon IPC link.
/// Keeps caller scope and implicit session binding directives out of business
/// `params: Value` payloads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IpcRequestMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller_scope: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub bind_scope: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub reuse_or_start_scope: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub explicit_incognito: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub return_scope_meta: bool,
}

impl IpcRequestMeta {
    pub fn is_empty(&self) -> bool {
        self.caller_scope.is_none()
            && !self.bind_scope
            && !self.reuse_or_start_scope
            && !self.explicit_incognito
            && !self.return_scope_meta
    }
}

/// Daemon-cached observation metadata returned out-of-band alongside a
/// `tool.cooperate` (or `operation_await`) reply when `return_scope_meta` is requested.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopeResultMeta {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_ctx: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_obs: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_vom: Option<String>,
    #[serde(default)]
    pub cached_vom_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_vom_next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_title: Option<String>,
    #[serde(default)]
    pub cache_reusable: bool,
}

/// Response-side transport metadata on the local CLI/MCP ↔ daemon IPC link.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IpcResponseMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_meta: Option<ScopeResultMeta>,
}

impl IpcResponseMeta {
    pub fn is_empty(&self) -> bool {
        self.scope_meta.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IpcRequestEnvelope {
    pub id: RpcId,
    pub method: Method,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "IpcRequestMeta::is_empty")]
    pub meta: IpcRequestMeta,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IpcResponseEnvelope {
    pub id: RpcId,
    pub body: ResponseBody,
    pub meta: IpcResponseMeta,
}

impl Serialize for IpcResponseEnvelope {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let fields = if self.meta.is_empty() { 2 } else { 3 };
        let mut s = serializer.serialize_struct("IpcResponseEnvelope", fields)?;
        s.serialize_field("id", &self.id)?;
        match &self.body {
            ResponseBody::Ok(v) => s.serialize_field("result", v)?,
            ResponseBody::Err(e) => s.serialize_field("error", e)?,
        }
        if !self.meta.is_empty() {
            s.serialize_field("meta", &self.meta)?;
        }
        s.end()
    }
}

/// Strongly typed local IPC wire envelope shared by CLI/MCP and the daemon.
/// Wire-compatible with [`bsk_protocol::Frame`] whenever `meta` is empty.
#[derive(Debug, Clone, PartialEq)]
pub enum IpcEnvelope {
    Request(IpcRequestEnvelope),
    Response(IpcResponseEnvelope),
    Event(EventFrame),
}

impl Serialize for IpcEnvelope {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Request(v) => v.serialize(serializer),
            Self::Response(v) => v.serialize(serializer),
            Self::Event(v) => v.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for IpcEnvelope {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(IpcEnvelopeVisitor)
    }
}

struct IpcEnvelopeVisitor;

impl<'de> Visitor<'de> for IpcEnvelopeVisitor {
    type Value = IpcEnvelope;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "an IPC envelope object")
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut id = None::<RpcId>;
        let mut method = None::<Method>;
        let mut params = None::<serde_json::Value>;
        let mut result = None::<serde_json::Value>;
        let mut error = None::<RpcError>;
        let mut event = None::<EventKind>;
        let mut payload = None::<serde_json::Value>;
        let mut meta = None::<serde_json::Value>;

        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "id" => {
                    if id.is_some() {
                        return Err(de::Error::duplicate_field("id"));
                    }
                    id = Some(map.next_value()?);
                }
                "method" => {
                    if method.is_some() {
                        return Err(de::Error::duplicate_field("method"));
                    }
                    method = Some(map.next_value()?);
                }
                "params" => {
                    if params.is_some() {
                        return Err(de::Error::duplicate_field("params"));
                    }
                    params = Some(map.next_value()?);
                }
                "result" => {
                    if result.is_some() {
                        return Err(de::Error::duplicate_field("result"));
                    }
                    result = Some(map.next_value()?);
                }
                "error" => {
                    if error.is_some() {
                        return Err(de::Error::duplicate_field("error"));
                    }
                    error = Some(map.next_value()?);
                }
                "event" => {
                    if event.is_some() {
                        return Err(de::Error::duplicate_field("event"));
                    }
                    event = Some(map.next_value()?);
                }
                "payload" => {
                    if payload.is_some() {
                        return Err(de::Error::duplicate_field("payload"));
                    }
                    payload = Some(map.next_value()?);
                }
                "meta" => {
                    if meta.is_some() {
                        return Err(de::Error::duplicate_field("meta"));
                    }
                    meta = Some(map.next_value()?);
                }
                other => {
                    return Err(de::Error::unknown_field(
                        other,
                        &[
                            "id", "method", "params", "result", "error", "event", "payload", "meta",
                        ],
                    ));
                }
            }
        }

        if let Some(event) = event {
            if id.is_some()
                || method.is_some()
                || params.is_some()
                || result.is_some()
                || error.is_some()
                || meta.is_some()
            {
                return Err(de::Error::custom(DecodeError::InvalidFrame(
                    "mixed event and rpc frame fields".into(),
                )));
            }
            return Ok(IpcEnvelope::Event(EventFrame {
                event,
                payload: payload.unwrap_or(serde_json::Value::Null),
            }));
        }

        if payload.is_some() {
            return Err(de::Error::custom(DecodeError::InvalidFrame(
                "unexpected event payload on rpc frame".into(),
            )));
        }

        match (id, method, result, error) {
            (Some(id), Some(method), None, None) => {
                let meta: IpcRequestMeta = match meta {
                    Some(raw) => serde_json::from_value(raw).map_err(de::Error::custom)?,
                    None => IpcRequestMeta::default(),
                };
                Ok(IpcEnvelope::Request(IpcRequestEnvelope {
                    id,
                    method,
                    params,
                    meta,
                }))
            }
            (Some(id), None, result, error) if params.is_none() => {
                let meta: IpcResponseMeta = match meta {
                    Some(raw) => serde_json::from_value(raw).map_err(de::Error::custom)?,
                    None => IpcResponseMeta::default(),
                };
                let body = match (result, error) {
                    (Some(v), None) => ResponseBody::Ok(v),
                    (None, Some(e)) => ResponseBody::Err(e),
                    _ => return Err(de::Error::custom(DecodeError::AmbiguousResponse)),
                };
                let _ = ResponseFrame {
                    id: id.clone(),
                    body: body.clone(),
                };
                Ok(IpcEnvelope::Response(IpcResponseEnvelope {
                    id,
                    body,
                    meta,
                }))
            }
            _ => Err(de::Error::custom(DecodeError::InvalidFrame(
                "invalid IPC envelope fields".into(),
            ))),
        }
    }
}

fn decode_response_envelope<R: DeserializeOwned>(
    line: &str,
    id: &str,
) -> Result<(RpcOutcome<R>, IpcResponseMeta)> {
    let frame: IpcEnvelope = serde_json::from_str(line).context("decode IPC response")?;
    match frame {
        IpcEnvelope::Response(resp) => {
            if resp.id != id {
                return Err(anyhow::anyhow!(
                    "IPC response id mismatch: expected {id}, got {}",
                    resp.id
                ));
            }
            match resp.body {
                ResponseBody::Ok(v) => {
                    let value: R = serde_json::from_value(v).context("decode result")?;
                    Ok((Ok(value), resp.meta))
                }
                ResponseBody::Err(e) => Ok((Err(e), resp.meta)),
            }
        }
        other => Err(anyhow::anyhow!("unexpected frame from daemon: {other:?}")),
    }
}

#[cfg(test)]
fn decode_response<R: DeserializeOwned>(line: &str, id: &str) -> Result<RpcOutcome<R>> {
    decode_response_envelope(line, id).map(|(outcome, _)| outcome)
}

#[cfg(test)]
mod tests {
    use super::decode_response;
    use bsk_protocol::{ErrorCode, PingResult};
    use serde_json::{Value, json};

    #[test]
    fn shared_decoder_preserves_typed_results_and_rpc_error_details() {
        let result: PingResult = decode_response(r#"{"id":"one","result":{"pong":true}}"#, "one")
            .unwrap()
            .unwrap();
        assert!(result.pong);
        let error = decode_response::<Value>(
            r#"{"id":"one","error":{"code":"cancelled","message":"stopped","data":{"reason":"test"}}}"#,
            "one",
        )
        .unwrap()
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.message, "stopped");
        assert_eq!(error.data, Some(json!({"reason": "test"})));
    }

    #[test]
    fn shared_decoder_rejects_wrong_request_ids_and_invalid_response_shapes() {
        for wire in [
            r#"{"id":"other","result":{"pong":true}}"#,
            r#"{"id":"one","method":"system.ping"}"#,
            r#"{"id":"one","result":{"pong":"wrong type"}}"#,
            "not JSON",
        ] {
            assert!(
                decode_response::<PingResult>(wire, "one").is_err(),
                "{wire}"
            );
        }
    }
}

#[cfg(unix)]
mod platform {
    use std::path::PathBuf;
    use std::time::Duration;

    use anyhow::{Context, Result};
    use bsk_protocol::Method;
    use serde::{Serialize, de::DeserializeOwned};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::time::timeout;

    use crate::ipc_client::{
        IpcEnvelope, IpcRequestEnvelope, IpcRequestMeta, IpcResponseMeta, RpcOutcome,
        decode_response_envelope, random_id,
    };

    /// Connected IPC client. Holds an open UDS connection plus a buffered
    /// reader/writer pair.
    pub struct Client {
        stream: BufReader<tokio::net::unix::OwnedReadHalf>,
        write: tokio::net::unix::OwnedWriteHalf,
        sock_path: PathBuf,
    }

    impl Client {
        /// PID in the caller's namespace, supplied by the kernel, not JSON.
        pub(crate) fn peer_pid(&self) -> std::io::Result<Option<u32>> {
            let credentials = self.stream.get_ref().as_ref().peer_cred()?;
            Ok(credentials
                .pid()
                .and_then(|pid| u32::try_from(pid).ok())
                .filter(|pid| *pid > 0))
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
            self.call_envelope_with_id(id, method, params, IpcRequestMeta::default(), call_timeout)
                .await
                .map(|(outcome, _)| outcome)
        }

        pub async fn call_envelope<P: Serialize, R: DeserializeOwned>(
            &mut self,
            method: Method,
            params: &P,
            meta: IpcRequestMeta,
            call_timeout: Duration,
        ) -> Result<(RpcOutcome<R>, IpcResponseMeta)> {
            self.call_envelope_with_id(random_id(), method, params, meta, call_timeout)
                .await
        }

        pub async fn call_envelope_with_id<P: Serialize, R: DeserializeOwned>(
            &mut self,
            id: String,
            method: Method,
            params: &P,
            meta: IpcRequestMeta,
            call_timeout: Duration,
        ) -> Result<(RpcOutcome<R>, IpcResponseMeta)> {
            let frame = IpcEnvelope::Request(IpcRequestEnvelope {
                id: id.clone(),
                method,
                params: Some(serde_json::to_value(params).context("serialise params")?),
                meta,
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

            decode_response_envelope(line.trim_end(), &id)
        }

        /// Path of the socket this client connected through (debug helper).
        pub fn sock_path(&self) -> &std::path::Path {
            &self.sock_path
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use anyhow::{Context, Result};
    use bsk_protocol::Method;
    use serde::{Serialize, de::DeserializeOwned};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
    use tokio::time::{sleep, timeout};
    use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY};

    use crate::ipc_client::{
        IpcEnvelope, IpcRequestEnvelope, IpcRequestMeta, IpcResponseMeta, RpcOutcome,
        decode_response_envelope, random_id,
    };

    pub struct Client {
        stream: BufReader<tokio::io::ReadHalf<NamedPipeClient>>,
        write: tokio::io::WriteHalf<NamedPipeClient>,
        pipe_name: PathBuf,
        peer_pid: std::io::Result<Option<u32>>,
    }

    impl Client {
        pub(crate) fn peer_pid(&self) -> std::io::Result<Option<u32>> {
            self.peer_pid
                .as_ref()
                .copied()
                .map_err(|err| std::io::Error::new(err.kind(), err.to_string()))
        }

        /// Total budget for retrying `ERROR_PIPE_BUSY` while connecting
        /// to the daemon's named pipe. Long enough to ride out a
        /// short-lived burst of clients, short enough that a wedged or
        /// preempted pipe surfaces as a clear error rather than a
        /// silent hang.
        const CONNECT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

        pub async fn connect_path(pipe_name: PathBuf) -> Result<Self> {
            let name = pipe_name.to_string_lossy().into_owned();
            let connect_loop = async {
                loop {
                    match ClientOptions::new().open(&name) {
                        Ok(client) => return Ok::<NamedPipeClient, anyhow::Error>(client),
                        Err(err) if err.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                            sleep(Duration::from_millis(50)).await;
                        }
                        Err(err) if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
                            return Err(anyhow::Error::from(err).context(format!(
                                "connect IPC named pipe {name}: access denied. The current account \
                                 or access token lacks permission to open the daemon's pipe. This \
                                 can happen when a sandbox uses a different account or a restricted \
                                 token. See https://github.com/Tencent/BrowserSkill/blob/main/docs/\
                                 sandboxed-agents.md#windows-sandbox-users-access-denied-on-the-pipe"
                            )));
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
            // Fetch while the pipe handle is directly available; an identity
            // lookup failure affects management only, not normal IPC use.
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
            let mut pid = 0;
            let peer_pid =
                if unsafe { GetNamedPipeServerProcessId(client.as_raw_handle(), &mut pid) } != 0 {
                    Ok((pid > 0).then_some(pid))
                } else {
                    Err(std::io::Error::last_os_error())
                };
            let (read, write) = tokio::io::split(client);
            Ok(Self {
                stream: BufReader::new(read),
                write,
                pipe_name,
                peer_pid,
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
            self.call_envelope_with_id(id, method, params, IpcRequestMeta::default(), call_timeout)
                .await
                .map(|(outcome, _)| outcome)
        }

        pub async fn call_envelope<P: Serialize, R: DeserializeOwned>(
            &mut self,
            method: Method,
            params: &P,
            meta: IpcRequestMeta,
            call_timeout: Duration,
        ) -> Result<(RpcOutcome<R>, IpcResponseMeta)> {
            self.call_envelope_with_id(random_id(), method, params, meta, call_timeout)
                .await
        }

        pub async fn call_envelope_with_id<P: Serialize, R: DeserializeOwned>(
            &mut self,
            id: String,
            method: Method,
            params: &P,
            meta: IpcRequestMeta,
            call_timeout: Duration,
        ) -> Result<(RpcOutcome<R>, IpcResponseMeta)> {
            let frame = IpcEnvelope::Request(IpcRequestEnvelope {
                id: id.clone(),
                method,
                params: Some(serde_json::to_value(params).context("serialise params")?),
                meta,
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

            decode_response_envelope(line.trim_end(), &id)
        }

        pub fn sock_path(&self) -> &Path {
            &self.pipe_name
        }
    }
}

pub use platform::Client;

impl Client {
    /// Discover and verify the existing daemon without starting one.
    pub async fn connect() -> anyhow::Result<Self> {
        use crate::daemon::probe::{Probe, probe_async};
        match probe_async(
            std::time::Duration::from_secs(2),
            bsk_protocol::StatusParams::default(),
        )
        .await?
        {
            Probe::Ready(daemon) => Ok(daemon.client),
            Probe::Absent(_) => {
                anyhow::bail!("no listening daemon (daemon.json or IPC endpoint missing)")
            }
        }
    }
}

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

    pub async fn call_envelope<P, R>(
        &mut self,
        id: impl Into<bsk_protocol::RpcId>,
        method: bsk_protocol::Method,
        params: Option<P>,
        meta: IpcRequestMeta,
        call_timeout: std::time::Duration,
    ) -> anyhow::Result<(std::result::Result<R, RpcError>, IpcResponseMeta)>
    where
        P: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        self.call_envelope_with_id(id.into(), method, params, meta, call_timeout)
            .await
    }

    pub async fn call_envelope_with_id<P, R>(
        &mut self,
        id: bsk_protocol::RpcId,
        method: bsk_protocol::Method,
        params: Option<P>,
        meta: IpcRequestMeta,
        call_timeout: std::time::Duration,
    ) -> anyhow::Result<(std::result::Result<R, RpcError>, IpcResponseMeta)>
    where
        P: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        match params {
            Some(p) => {
                self.inner
                    .call_envelope_with_id::<P, R>(id, method, &p, meta, call_timeout)
                    .await
            }
            None => {
                self.inner
                    .call_envelope_with_id::<(), R>(id, method, &(), meta, call_timeout)
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
