//! Business RPCs with terminal Ctrl-C and opt-in parent cancellation.
//!
//! When cancellation arrives while a business RPC is in flight:
//!
//! 1. We send a fresh `cancel { rpc_id }` IPC frame on a new
//!    connection without blocking progress on the original call.
//! 2. Keep polling the original call while retrying unmatched cancellation.
//!    Connection setup, retries and the response share [`CANCEL_RESPONSE_GRACE`].
//! 3. If the daemon never replies within the grace window, synthesise
//!    a `cancelled` [`RpcError`] locally and return — CLI exits with
//!    the matching exit code rather than hanging on a wedged daemon.
//!
//! Admin commands (`bsk status`, `bsk doctor`, `bsk daemon …`, `bsk logs`)
//! intentionally bypass this helper and use `Client::call` /
//! `IpcClient::call` directly so SIGINT keeps its default
//! "kill the CLI process" behaviour for short status reads.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::{
    ActionMetadataPolicy, CancelParams, CancelResult, ErrorCode, Method, RpcError, RpcId,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::time::{Instant, timeout_at};
use tracing::debug;

use crate::cli::error::CliError;
use crate::ipc_client::{IpcClient, IpcRequestMeta, IpcResponseMeta};

/// Total budget after cancellation is observed: connecting, sending cancel,
/// retrying before registration, and waiting for the original RPC to settle.
pub const CANCEL_RESPONSE_GRACE: Duration = Duration::from_secs(2);

const CANCEL_RETRY_INITIAL: Duration = Duration::from_millis(10);
const CANCEL_RETRY_MAX: Duration = Duration::from_millis(250);

/// Keep the IPC connection alive long enough to receive the tool's timeout.
pub(crate) fn ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms) + 15_000)
}

fn normalize_non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// Param-sensitive caller action-metadata policy:
/// - `Full` for guarded browser actions (including `observe` only when `probe_hover == true`
///   and `debug` only when `action.cooperation_guarded()`).
/// - `ContextOnly` for `tool.read` (`--context` / `context` only).
/// - `None` for all other methods, so caller-supplied conditions fail closed with `invalid_params`
///   before contacting the daemon.
pub(crate) fn caller_action_metadata_policy(
    method: &Method,
    params: Option<&serde_json::Value>,
) -> ActionMetadataPolicy {
    if method_accepts_action_metadata_with_params(method, params) {
        ActionMetadataPolicy::Full
    } else if *method == Method::ToolRead {
        ActionMetadataPolicy::ContextOnly
    } else {
        ActionMetadataPolicy::None
    }
}

pub(crate) fn method_accepts_action_metadata_with_params(
    method: &Method,
    params: Option<&serde_json::Value>,
) -> bool {
    match method {
        Method::ToolObserve => {
            params
                .and_then(|v| v.get("probe_hover"))
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        }
        Method::ToolDebug => params
            .and_then(|v| v.get("action"))
            .and_then(|a| {
                serde_json::from_value::<bsk_protocol::tools::DebugAction>(a.clone()).ok()
            })
            .is_some_and(|a| a.cooperation_guarded()),
        other => other.accepts_action_metadata(),
    }
}

/// Request-scoped context replacing process-wide global action metadata and caller scope state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClientContext {
    pub scope: Option<String>,
    pub mcp_scope: Option<String>,
    pub context_id: Option<String>,
    pub depends_on: Vec<String>,
    pub observation_id: Option<String>,
    pub expect: Option<serde_json::Value>,
}

impl ClientContext {
    /// Build request context from parsed CLI global flags.
    pub fn from_cli_flags(flags: &crate::cli::GlobalFlags) -> Self {
        Self {
            scope: flags.scope.as_deref().and_then(normalize_non_empty),
            mcp_scope: None,
            context_id: flags.context.clone(),
            depends_on: flags.depends_on.clone(),
            observation_id: flags.observation.clone(),
            expect: flags.expect.clone(),
        }
    }

    /// Build request context for a single MCP tool invocation.
    pub fn for_mcp(
        mcp_scope: Option<&str>,
        scope: Option<&str>,
        context_id: Option<String>,
        depends_on: Vec<String>,
        observation_id: Option<String>,
        expect: Option<serde_json::Value>,
    ) -> Self {
        Self {
            scope: scope.and_then(normalize_non_empty),
            mcp_scope: mcp_scope.and_then(normalize_non_empty),
            context_id,
            depends_on,
            observation_id,
            expect,
        }
    }

    /// Override caller scope when an explicit non-empty scope is supplied.
    pub fn with_scope(&self, scope: Option<&str>) -> Self {
        let mut next = self.clone();
        if let Some(scope) = scope.and_then(normalize_non_empty) {
            next.scope = Some(scope);
        }
        next
    }

    /// Override the explicit observation id when supplied on an action command.
    pub fn with_observation_id(&self, observation_id: Option<&str>) -> Self {
        let mut next = self.clone();
        if let Some(observation_id) = observation_id {
            next.observation_id = Some(observation_id.to_owned());
        }
        next
    }

    /// Preserve caller scope while stripping action metadata before auxiliary RPCs.
    pub fn without_action_metadata(&self) -> Self {
        Self {
            scope: self.scope.clone(),
            mcp_scope: self.mcp_scope.clone(),
            ..Self::default()
        }
    }

    /// Whether the caller attached any action condition (`context`, `depends_on`, `observation`, `expect`).
    pub fn has_any_action_metadata(&self) -> bool {
        self.context_id.is_some() || self.verification_requested()
    }

    /// Whether the caller attached anything asking for the page to be checked.
    pub fn verification_requested(&self) -> bool {
        !self.depends_on.is_empty() || self.observation_id.is_some() || self.expect.is_some()
    }

    /// Resolve the effective caller scope against `BSK_SCOPE`, `BSK_SESSION`, MCP scope and defaults.
    pub fn resolved_caller_scope(&self) -> String {
        crate::daemon::scopes::resolve_caller_scope_from_env(
            self.scope.as_deref(),
            self.mcp_scope.as_deref(),
        )
    }

    /// Reject caller action conditions before daemon discovery when `method` + `params` do not verify them.
    pub fn validate_action_metadata(
        &self,
        method: &Method,
        params: Option<&serde_json::Value>,
    ) -> Result<ActionMetadataPolicy, CliError> {
        let caller_policy = caller_action_metadata_policy(method, params);
        match caller_policy {
            ActionMetadataPolicy::None => {
                if self.has_any_action_metadata() {
                    return Err(CliError::invalid_params(anyhow::anyhow!(
                        "action conditions (--context, --depends-on, --observation, --expect) do not apply to {}",
                        method.wire_name()
                    )));
                }
            }
            ActionMetadataPolicy::ContextOnly => {
                if self.verification_requested() {
                    return Err(CliError::invalid_params(anyhow::anyhow!(
                        "--observation, --expect and --depends-on apply only to guarded browser actions; read accepts --context only"
                    )));
                }
            }
            ActionMetadataPolicy::Full => {
                if !self.depends_on.is_empty() && self.context_id.is_none() {
                    return Err(CliError::invalid_params(anyhow::anyhow!(
                        "depends_on requires context"
                    )));
                }
            }
        }
        Ok(caller_policy)
    }

    /// Validate and frame outgoing RPC parameters using compile-time `MethodSpec` and param-sensitive rules.
    pub fn prepare_params<P: Serialize>(
        &self,
        method: &Method,
        params: Option<P>,
    ) -> Result<Option<serde_json::Value>, CliError> {
        let mut value = params
            .map(|p| serde_json::to_value(p).map_err(|err| CliError::invalid_params(err.into())))
            .transpose()?;
        let caller_policy = self.validate_action_metadata(method, value.as_ref())?;
        let wire_policy = if matches!(method, Method::ToolObserve | Method::ToolDebug) {
            caller_policy
        } else {
            method.action_metadata_policy()
        };

        let Some(object) = value.as_mut().and_then(serde_json::Value::as_object_mut) else {
            return Ok(value);
        };

        match wire_policy {
            ActionMetadataPolicy::None => {
                if ["context_id", "depends_on", "observation_id", "expect"]
                    .iter()
                    .any(|key| object.get(*key).is_some_and(|v| !v.is_null()))
                {
                    return Err(CliError::invalid_params(anyhow::anyhow!(
                        "{} does not accept action metadata (context_id, depends_on, observation_id, expect)",
                        method.wire_name()
                    )));
                }
            }
            ActionMetadataPolicy::ContextOnly => {
                if ["depends_on", "observation_id", "expect"]
                    .iter()
                    .any(|key| object.get(*key).is_some_and(|v| !v.is_null()))
                {
                    return Err(CliError::invalid_params(anyhow::anyhow!(
                        "{} does not accept depends_on, observation_id, or expect",
                        method.wire_name()
                    )));
                }
                if caller_policy == ActionMetadataPolicy::ContextOnly
                    && let Some(context) = &self.context_id
                {
                    if let Some(existing) = object.get("context_id").filter(|v| !v.is_null()) {
                        if existing.as_str() != Some(context.as_str()) {
                            return Err(CliError::invalid_params(anyhow::anyhow!(
                                "--context conflicts with the action's context_id"
                            )));
                        }
                    } else {
                        object.insert("context_id".into(), context.clone().into());
                    }
                }
            }
            ActionMetadataPolicy::Full => {
                if let Some(context) = &self.context_id {
                    if let Some(existing) = object.get("context_id").filter(|v| !v.is_null()) {
                        if existing.as_str() != Some(context.as_str()) {
                            return Err(CliError::invalid_params(anyhow::anyhow!(
                                "--context conflicts with the action's context_id"
                            )));
                        }
                    } else {
                        object.insert("context_id".into(), context.clone().into());
                    }
                    if !self.depends_on.is_empty() {
                        object.insert(
                            "depends_on".into(),
                            serde_json::to_value(&self.depends_on)
                                .map_err(|err| CliError::Local(err.into()))?,
                        );
                    }
                }
                if let Some(observation) = &self.observation_id {
                    if let Some(existing) = object.get("observation_id").filter(|v| !v.is_null())
                        && existing.as_str() != Some(observation.as_str())
                    {
                        return Err(CliError::invalid_params(anyhow::anyhow!(
                            "--observation conflicts with the action's observation_id"
                        )));
                    }
                    object.insert("observation_id".into(), observation.clone().into());
                }
                if let Some(expect) = &self.expect {
                    object.insert("expect".into(), expect.clone());
                }
            }
        }

        Ok(value)
    }

    /// Prepare both the clean business JSON `params` and the out-of-band
    /// [`IpcRequestMeta`] envelope header for `method`.
    pub fn prepare_envelope<P: Serialize>(
        &self,
        method: &Method,
        params: Option<P>,
        mut meta: IpcRequestMeta,
    ) -> Result<(Option<serde_json::Value>, IpcRequestMeta), CliError> {
        let value = self.prepare_params(method, params)?;
        let has_empty_session = value
            .as_ref()
            .and_then(|v| v.as_object())
            .and_then(|obj| obj.get("session_id"))
            .is_some_and(|v| v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty()));
        if meta.caller_scope.is_none()
            && (has_empty_session || meta.bind_scope || meta.reuse_or_start_scope)
        {
            meta.caller_scope = Some(self.resolved_caller_scope());
        }
        Ok((value, meta))
    }

    /// Issue a business RPC against the daemon with SIGINT-driven cancellation.
    pub fn call<P, R>(
        &self,
        sock: PathBuf,
        rpc_id_prefix: &str,
        method: Method,
        params: Option<P>,
        call_timeout: Duration,
    ) -> Result<R, CliError>
    where
        P: Serialize,
        R: DeserializeOwned + Send + 'static,
    {
        self.call_envelope::<P, R>(
            sock,
            rpc_id_prefix,
            method,
            params,
            IpcRequestMeta::default(),
            call_timeout,
        )
        .map(|(reply, _)| reply)
    }

    /// Issue a business RPC with an explicit [`IpcRequestMeta`] envelope and
    /// return both the decoded reply and [`IpcResponseMeta`].
    pub fn call_envelope<P, R>(
        &self,
        sock: PathBuf,
        rpc_id_prefix: &str,
        method: Method,
        params: Option<P>,
        meta: IpcRequestMeta,
        call_timeout: Duration,
    ) -> Result<(R, IpcResponseMeta), CliError>
    where
        P: Serialize,
        R: DeserializeOwned + Send + 'static,
    {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .context("build tokio runtime for business RPC")
            .map_err(CliError::Local)?;
        rt.block_on(self.call_envelope_async::<P, R>(
            sock,
            rpc_id_prefix,
            method,
            params,
            meta,
            call_timeout,
        ))
    }

    /// Same as [`ClientContext::call`] but assumes a pre-existing tokio runtime context.
    pub async fn call_async<P, R>(
        &self,
        sock: PathBuf,
        rpc_id_prefix: &str,
        method: Method,
        params: Option<P>,
        call_timeout: Duration,
    ) -> Result<R, CliError>
    where
        P: Serialize,
        R: DeserializeOwned + Send + 'static,
    {
        self.call_envelope_async::<P, R>(
            sock,
            rpc_id_prefix,
            method,
            params,
            IpcRequestMeta::default(),
            call_timeout,
        )
        .await
        .map(|(reply, _)| reply)
    }

    /// Same as [`ClientContext::call_envelope`] inside an existing tokio runtime.
    pub async fn call_envelope_async<P, R>(
        &self,
        sock: PathBuf,
        rpc_id_prefix: &str,
        method: Method,
        params: Option<P>,
        meta: IpcRequestMeta,
        call_timeout: Duration,
    ) -> Result<(R, IpcResponseMeta), CliError>
    where
        P: Serialize,
        R: DeserializeOwned + Send + 'static,
    {
        let mut sock = super::ensure_daemon::resolve_effective_sock(&sock);
        let parent_cancel = stdin_cancellation();
        if cancel_requested() || parent_cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
            CANCEL_REQUESTED.store(true, Ordering::Relaxed);
            return Err(CliError::from_rpc(RpcError {
                code: ErrorCode::Cancelled,
                message: "command cancelled before dispatch".into(),
                data: Some(serde_json::json!({
                    "reason": bsk_protocol::RpcErrorReason::CancelledBeforeDispatch.as_str()
                })),
            }));
        }
        let rpc_id: RpcId = format!("{}-{}", rpc_id_prefix, random_short_id());
        let (params, meta) = self.prepare_envelope(&method, params, meta)?;
        // Optimistic single-UDS fast path: connect once and send the target RPC directly.
        // Fail-safe auto-spawn: ONLY if initial connect() fails before any bytes are written
        // (NotFound / ConnectionRefused on an unverified optimistic daemon.json candidate),
        // fall back to ensure_daemon_with_protocol() and connect once to the fresh daemon.
        let was_optimistic = super::ensure_daemon::take_optimistic_candidate(&sock);
        let mut client = match IpcClient::connect(sock.clone()).await {
            Ok(client) => client,
            Err(connect_err) if was_optimistic && is_daemon_absent_connect_error(&connect_err) => {
                let stale_sock = sock.clone();
                let (fresh_info, fresh_protocol) =
                    tokio::task::spawn_blocking(super::ensure_daemon::ensure_daemon_with_protocol)
                        .await
                        .context("join daemon auto-spawn task")
                        .map_err(CliError::Local)?
                        .context("ensure daemon is running")
                        .map_err(CliError::Local)?;
                check_daemon_protocol(&fresh_protocol).map_err(CliError::Local)?;
                super::ensure_daemon::record_redirected_sock(&stale_sock, &fresh_info.sock_path);
                sock = fresh_info.sock_path;
                IpcClient::connect(sock.clone()).await?
            }
            Err(connect_err) => return Err(connect_err.into()),
        };
        let rpc_id_for_call = rpc_id.clone();
        let rpc_id_for_cancel = rpc_id.clone();
        let action_started = AtomicBool::new(false);
        let action_started_ref = &action_started;

        let main_fut = async move {
            action_started_ref.store(true, Ordering::Relaxed);
            client
                .call_envelope_with_id::<serde_json::Value, R>(
                    rpc_id_for_call,
                    method,
                    params,
                    meta,
                    call_timeout,
                )
                .await
        };
        tokio::pin!(main_fut);

        let (outcome, resp_meta) = tokio::select! {
            biased;
            // Arm cancellation before the RPC can dispatch browser input.
            sig = wait_for_cancel(parent_cancel) => {
                sig.context("wait for cancellation").map_err(CliError::Local)?;
                CANCEL_REQUESTED.store(true, Ordering::Relaxed);
                if !action_started.load(Ordering::Relaxed) {
                    return Err(CliError::from_rpc(RpcError {
                        code: ErrorCode::Cancelled,
                        message: "request cancelled before dispatch".into(),
                        data: Some(serde_json::json!({
                            "reason": bsk_protocol::RpcErrorReason::CancelledBeforeDispatch.as_str(),
                            "effect_state": "none"
                        })),
                    }));
                }
                debug!(rpc_id = %rpc_id_for_cancel, "forwarding cancel to daemon");
                // Separate IPC connections can deliver cancel before the business
                // request is registered. Keep polling that request while confirming
                // cancellation, including any write that has not completed yet.
                let deadline = Instant::now() + CANCEL_RESPONSE_GRACE;
                let settle = async {
                    tokio::select! {
                        biased;
                        res = &mut main_fut => return res,
                        result = send_cancel(&sock, &rpc_id_for_cancel, deadline) => {
                            if let Err(err) = result {
                                debug!(rpc_id = %rpc_id_for_cancel, %err, "cancel was not confirmed");
                            }
                        },
                    }
                    main_fut.await
                };
                match timeout_at(deadline, settle).await {
                    Ok(res) => res?,
                    Err(_) => {
                        debug!(
                            rpc_id = %rpc_id_for_cancel,
                            "cancel grace elapsed; synthesising cancelled error"
                        );
                        return Err(CliError::from_rpc(RpcError {
                            code: ErrorCode::Cancelled,
                            message: "rpc did not respond within cancel grace window".into(),
                            data: None,
                        }));
                    }
                }
            }
            res = &mut main_fut => res?,
        };

        outcome
            .map(|reply| (reply, resp_meta))
            .map_err(CliError::from_rpc)
    }
}

// Keep the user's stop request even if the in-flight RPC finishes successfully.
// One CLI process is one command, including its follow-up reads.
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

pub(super) fn cancel_requested() -> bool {
    CANCEL_REQUESTED.load(Ordering::Relaxed)
}

/// Verify daemon protocol compatibility against v2.0 baseline.
pub(crate) fn check_daemon_protocol(protocol: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        bsk_protocol::catalog::is_protocol_compatible(protocol),
        "daemon protocol {protocol} is incompatible with CLI (requires >= {}, current {}); update the CLI and restart its daemon",
        bsk_protocol::catalog::MIN_COMPATIBLE_PROTOCOL,
        bsk_protocol::catalog::PROTOCOL_VERSION,
    );
    Ok(())
}

fn is_daemon_absent_connect_error(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause.downcast_ref::<std::io::Error>().is_some_and(|io| {
            matches!(
                io.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            )
        })
    })
}
/// Release caller-owned staging even after cancellation. This deliberately
/// exposes only transfer.release, not a general bypass for business RPCs.
/// The entire batch, including connection setup, shares one bounded budget.
pub fn release_transfers<'a>(
    sock: &Path,
    transfer_ids: impl IntoIterator<Item = &'a str>,
) -> Result<(), CliError> {
    use bsk_protocol::tools::{TransferIdParams, TransferReleaseResult};
    const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
    let ids: Vec<_> = transfer_ids.into_iter().collect();
    if ids.is_empty() {
        return Ok(());
    }
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build runtime for transfer cleanup")?;
    rt.block_on(async {
        tokio::time::timeout(CLEANUP_TIMEOUT, async {
            let mut client = IpcClient::connect(sock).await?;
            for id in ids {
                client
                    .call::<_, TransferReleaseResult>(
                        "transfer-release",
                        Method::TransferRelease,
                        Some(TransferIdParams {
                            transfer_id: id.to_string(),
                        }),
                        CLEANUP_TIMEOUT,
                    )
                    .await?
                    .map_err(CliError::from_rpc)?;
            }
            Ok::<_, CliError>(())
        })
        .await
        .context("transfer cleanup exceeded its total time budget")?
    })
}

/// Send a `cancel { rpc_id }` frame over a fresh connection so it
/// lands on the daemon while the original call is still parked.
/// An unmatched request may still be in transit on the other connection;
/// retry with backoff until the shared response deadline. The daemon may never
/// register this method, so retries must not extend the caller's grace period.
/// This bounds the registration race; it cannot cancel a request that arrives
/// after the deadline without daemon-side cancellation tracking.
pub(crate) async fn send_cancel(
    sock: &Path,
    rpc_id: &str,
    deadline: Instant,
) -> anyhow::Result<()> {
    timeout_at(deadline, async {
        let mut client = IpcClient::connect(sock).await?;
        let mut retry_delay = CANCEL_RETRY_INITIAL;
        loop {
            let result = client
                .call_with_id::<_, CancelResult>(
                    format!("cancel-{}", random_short_id()),
                    Method::Cancel,
                    Some(CancelParams {
                        rpc_id: rpc_id.to_string(),
                    }),
                    deadline.saturating_duration_since(Instant::now()),
                )
                .await?
                .map_err(CliError::from_rpc)?;
            if result.cancelled {
                return Ok(());
            }
            tokio::time::sleep(retry_delay).await;
            retry_delay = (retry_delay * 2).min(CANCEL_RETRY_MAX);
        }
    })
    .await
    .context("daemon did not confirm cancellation before the response deadline")?
}

pub(crate) fn random_short_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; 4];
    rng.fill(&mut bytes[..]);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Opt-in control pipe for parent processes that cannot send Ctrl-C (Node on
/// Windows). One reader survives the short-lived runtimes used by multi-RPC
/// commands such as upload. Ordinary CLI stdin and terminal Ctrl-C are unchanged.
fn stdin_cancellation() -> Option<tokio::sync::watch::Receiver<bool>> {
    if std::env::var("BSK_CANCEL_ON_STDIN_CLOSE").as_deref() != Ok("1") {
        return None;
    }
    static CANCEL: std::sync::OnceLock<tokio::sync::watch::Receiver<bool>> =
        std::sync::OnceLock::new();
    Some(
        CANCEL
            .get_or_init(|| {
                let (tx, rx) = tokio::sync::watch::channel(false);
                std::thread::spawn(move || {
                    use std::io::Read;
                    let mut stdin = std::io::stdin().lock();
                    let mut buf = [0; 64];
                    loop {
                        match stdin.read(&mut buf) {
                            Ok(0) => break,
                            Ok(_) => {}
                            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                            Err(_) => break,
                        }
                    }
                    let _ = tx.send(true);
                });
                rx
            })
            .clone(),
    )
}

async fn wait_for_cancel(
    parent_cancel: Option<tokio::sync::watch::Receiver<bool>>,
) -> anyhow::Result<()> {
    let parent_closed = async move {
        match parent_cancel {
            Some(mut rx) => {
                let _ = rx.wait_for(|closed| *closed).await;
            }
            None => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        result = wait_for_sigint() => result,
        _ = parent_closed => Ok(()),
    }
}

/// Wait for terminal Ctrl-C.
async fn wait_for_sigint() -> anyhow::Result<()> {
    tokio::signal::ctrl_c().await.context("listen for SIGINT")?;
    Ok(())
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

    #[tokio::test]
    async fn cancel_deadline_includes_waiting_for_a_busy_pipe() {
        let address = PathBuf::from(format!(
            r"\\.\pipe\bsk-cancel-busy-{}",
            uuid::Uuid::new_v4()
        ));
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .max_instances(1)
            .create(&address)
            .unwrap();
        let _occupied = ClientOptions::new().open(&address).unwrap();
        server.connect().await.unwrap();
        assert_eq!(
            ClientOptions::new()
                .open(&address)
                .err()
                .unwrap()
                .raw_os_error(),
            Some(windows_sys::Win32::Foundation::ERROR_PIPE_BUSY as i32)
        );

        let start = Instant::now();
        let result = send_cancel(&address, "pending-rpc", start + Duration::from_millis(100)).await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("response deadline")
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}

#[cfg(test)]
mod tests {
    use super::{ClientContext, ipc_timeout};
    use bsk_protocol::Method;
    use serde_json::json;
    use std::time::Duration;

    #[test]
    fn ipc_timeout_preserves_grace_at_the_largest_tool_timeout() {
        assert_eq!(ipc_timeout(60_000), Duration::from_secs(75));
        assert_eq!(ipc_timeout(u32::MAX).as_millis(), u32::MAX as u128 + 15_000);
    }

    #[test]
    fn context_is_explicit_and_does_not_change_action_parameters() {
        let params = json!({"session_id":"s1", "ref":"e1", "value":"Shanghai"});
        assert_eq!(
            ClientContext::default()
                .prepare_params(&Method::ToolFill, Some(&params))
                .unwrap(),
            Some(params.clone())
        );
        let ctx = ClientContext {
            context_id: Some("observed-context".into()),
            depends_on: vec!["@e2".into()],
            ..ClientContext::default()
        };
        let framed = ctx
            .prepare_params(&Method::ToolFill, Some(&params))
            .unwrap()
            .unwrap();
        assert_eq!(framed["context_id"], "observed-context");
        assert_eq!(framed["depends_on"], json!(["@e2"]));
        assert_eq!(framed["value"], "Shanghai");
        assert!(params.get("context_id").is_none());
    }

    #[test]
    fn explicit_conditions_survive_without_implicit_context() {
        let params = json!({"session_id":"s1", "ref":"e1"});
        let checks = json!([{ "target":"#price", "field":"text", "equals":"$12" }]);
        let ctx = ClientContext {
            observation_id: Some("observed".into()),
            expect: Some(checks.clone()),
            ..ClientContext::default()
        };
        let framed = ctx
            .prepare_params(&Method::ToolClick, Some(&params))
            .unwrap()
            .unwrap();
        assert_eq!(framed["observation_id"], "observed");
        assert_eq!(framed["expect"], checks);
        assert!(framed.get("context_id").is_none());
        assert_eq!(params, json!({"session_id":"s1", "ref":"e1"}));
    }

    #[test]
    fn conflicting_visual_and_action_observations_are_rejected() {
        let params = json!({"session_id":"s1", "observation_id":"visual"});
        assert!(
            ClientContext {
                observation_id: Some("other".into()),
                ..ClientContext::default()
            }
            .prepare_params(&Method::ToolClick, Some(&params))
            .is_err()
        );
        assert_eq!(
            ClientContext {
                observation_id: Some("visual".into()),
                ..ClientContext::default()
            }
            .prepare_params(&Method::ToolClick, Some(&params))
            .unwrap(),
            Some(params)
        );
    }

    #[test]
    fn accepts_action_metadata_enforced_per_method_and_tool_read_context_only() {
        let ctx = ClientContext {
            scope: Some("agent-1".into()),
            context_id: Some("ctx-1".into()),
            expect: Some(json!([{"target":"@e1","field":"exists","equals":true}])),
            ..ClientContext::default()
        };
        assert!(
            ctx.prepare_params(
                &Method::ToolWaitForElement,
                Some(json!({"session_id":"s1"}))
            )
            .is_err()
        );
        assert!(
            ctx.prepare_params(&Method::TransferBegin, Some(json!({"session_id":"s1"})))
                .is_err()
        );
        let stripped = ctx.without_action_metadata();
        assert_eq!(stripped.scope.as_deref(), Some("agent-1"));
        let (wait_params, wait_meta) = stripped
            .prepare_envelope(
                &Method::ToolWaitForElement,
                Some(json!({"session_id":""})),
                crate::ipc_client::IpcRequestMeta::default(),
            )
            .unwrap();
        let wait_params = wait_params.unwrap();
        assert!(wait_params.get("expect").is_none());
        assert!(wait_params.get("context_id").is_none());
        assert_eq!(wait_params, json!({"session_id": ""}));
        assert_eq!(
            wait_meta.caller_scope.as_deref(),
            Some(
                crate::daemon::scopes::resolve_caller_scope_from_env(Some("agent-1"), None)
                    .as_str()
            )
        );

        let mcp_ctx = ClientContext::for_mcp(Some("mcp:42:nonce"), None, None, vec![], None, None)
            .without_action_metadata();
        assert_eq!(mcp_ctx.mcp_scope.as_deref(), Some("mcp:42:nonce"));
        assert!(mcp_ctx.scope.is_none());
        assert_eq!(
            mcp_ctx.resolved_caller_scope(),
            crate::daemon::scopes::resolve_caller_scope_from_env(None, Some("mcp:42:nonce"))
        );

        let read_ctx = ClientContext {
            context_id: Some("ctx-read".into()),
            ..ClientContext::default()
        };
        let read_params = read_ctx
            .prepare_params(&Method::ToolRead, Some(json!({"session_id":"s1"})))
            .unwrap()
            .unwrap();
        assert_eq!(read_params["context_id"], "ctx-read");
        assert!(
            ctx.prepare_params(&Method::ToolRead, Some(json!({"session_id":"s1"})))
                .is_err(),
            "tool.read must reject expect/observation/depends_on"
        );

        for passive_method in [
            Method::ToolSnapshot,
            Method::ToolGetHtml,
            Method::ToolExtract,
            Method::ToolScreenshot,
            Method::ToolConsole,
            Method::ToolNetwork,
            Method::ToolWaitForNavigation,
            Method::ToolWaitForElement,
        ] {
            assert!(
                read_ctx
                    .prepare_params(&passive_method, Some(json!({"session_id":"s1"})))
                    .is_err(),
                "{} must reject caller-supplied context_id",
                passive_method.wire_name()
            );
            let inline_params = ClientContext::default()
                .prepare_params(
                    &passive_method,
                    Some(json!({"session_id":"s1","context_id":"ctx-inline"})),
                )
                .unwrap()
                .unwrap();
            assert_eq!(inline_params["context_id"], "ctx-inline");
            assert!(
                ctx.prepare_params(&passive_method, Some(json!({"session_id":"s1"})))
                    .is_err(),
                "{} must reject expect/observation/depends_on",
                passive_method.wire_name()
            );
        }

        // Param-sensitive guarded sub-modes (`observe --probe-hover` and `debug` guarded actions).
        assert!(
            read_ctx
                .prepare_params(&Method::ToolObserve, Some(json!({"session_id":"s1"})))
                .is_err()
        );
        let probe_params = ctx
            .prepare_params(
                &Method::ToolObserve,
                Some(json!({"session_id":"s1","probe_hover":true})),
            )
            .unwrap()
            .unwrap();
        assert_eq!(probe_params["context_id"], "ctx-1");
        assert!(
            read_ctx
                .prepare_params(
                    &Method::ToolDebug,
                    Some(json!({"session_id":"s1","action":"requests"})),
                )
                .is_err()
        );
        let replay_params = ctx
            .prepare_params(
                &Method::ToolDebug,
                Some(json!({"session_id":"s1","action":"replay"})),
            )
            .unwrap()
            .unwrap();
        assert_eq!(replay_params["context_id"], "ctx-1");

        assert!(
            read_ctx
                .prepare_params(&Method::TransferBegin, Some(json!({"session_id":"s1"})))
                .is_err()
        );
    }
}
