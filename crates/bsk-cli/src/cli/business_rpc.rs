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
use bsk_protocol::{CancelParams, CancelResult, ErrorCode, Method, RpcError, RpcId};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::time::{Instant, timeout_at};
use tracing::debug;

use crate::cli::error::CliError;
use crate::ipc_client::IpcClient;

/// Total budget after cancellation is observed: connecting, sending cancel,
/// retrying before registration, and waiting for the original RPC to settle.
pub const CANCEL_RESPONSE_GRACE: Duration = Duration::from_secs(2);

const CANCEL_RETRY_INITIAL: Duration = Duration::from_millis(10);
const CANCEL_RETRY_MAX: Duration = Duration::from_millis(250);

/// Keep the IPC connection alive long enough to receive the tool's timeout.
pub(crate) fn ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms) + 15_000)
}

static OBSERVATION_DEPENDENCIES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();

static OBSERVATION_CONTEXT: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
static ACTION_EVIDENCE: std::sync::OnceLock<(Option<String>, Option<serde_json::Value>)> =
    std::sync::OnceLock::new();
static TARGET_POLICY_REQUESTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
static EXPLICIT_CALLER_SCOPE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

// Keep the user's stop request even if the in-flight RPC finishes successfully.
// One CLI process is one command, including its follow-up reads.
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

pub(super) fn cancel_requested() -> bool {
    CANCEL_REQUESTED.load(Ordering::Relaxed)
}

/// A CLI process represents one explicit caller operation. Never fill this from cached state.
pub fn set_context(context: Option<String>) {
    let _ = OBSERVATION_CONTEXT.set(context);
}

pub fn set_dependencies(dependencies: Vec<String>) {
    let _ = OBSERVATION_DEPENDENCIES.set(dependencies);
}

pub fn set_action_evidence(observation: Option<String>, expect: Option<serde_json::Value>) {
    let _ = ACTION_EVIDENCE.set((observation, expect));
}

pub fn set_target_policy_requested() {
    let _ = TARGET_POLICY_REQUESTED.set(true);
}

pub fn set_caller_scope(scope: Option<String>) {
    if let Some(scope) = scope.filter(|s| !s.trim().is_empty()) {
        *EXPLICIT_CALLER_SCOPE.lock().unwrap() = Some(scope);
    }
}

pub fn current_caller_scope() -> String {
    let explicit = EXPLICIT_CALLER_SCOPE.lock().unwrap().clone();
    crate::daemon::scopes::resolve_caller_scope_from_env(explicit.as_deref(), None)
}

/// Whether the caller attached anything asking for the page to be checked.
pub(super) fn verification_requested() -> bool {
    OBSERVATION_DEPENDENCIES
        .get()
        .is_some_and(|dependencies| !dependencies.is_empty())
        || ACTION_EVIDENCE
            .get()
            .is_some_and(|(observation, expect)| observation.is_some() || expect.is_some())
}

/// Use the status already read during discovery, before any guarded action can be forwarded.
pub(super) fn check_daemon_protocol(protocol: &str) -> anyhow::Result<()> {
    require_target_control(
        protocol,
        TARGET_POLICY_REQUESTED.get().copied().unwrap_or(false),
        ACTION_EVIDENCE
            .get()
            .is_some_and(|(observation, expect)| observation.is_some() || expect.is_some()),
    )
}

/// Reject target policy or action evidence when the daemon could silently discard them.
pub(crate) fn require_target_control(
    protocol: &str,
    target_policy: bool,
    evidence: bool,
) -> anyhow::Result<()> {
    if target_policy {
        anyhow::ensure!(
            bsk_protocol::tools::supports_target_control(protocol),
            "--policy target requires daemon protocol 1.8 or a later compatible 1.x version; update the CLI and restart its daemon (running protocol {protocol})"
        );
    }
    if evidence {
        anyhow::ensure!(
            bsk_protocol::tools::supports_target_control(protocol),
            "--expect and --observation require daemon protocol 1.8 or a later compatible 1.x version; update the CLI and restart its daemon (running protocol {protocol}). Conditions are never silently discarded"
        );
    }
    Ok(())
}

pub(crate) fn with_context<P: Serialize>(
    params: Option<P>,
    context: Option<&str>,
    dependencies: &[String],
    observation: Option<&str>,
    expect: Option<&serde_json::Value>,
) -> anyhow::Result<Option<serde_json::Value>> {
    params
        .map(|p| {
            let mut value = serde_json::to_value(p)?;
            if let (Some(context), Some(object)) = (context, value.as_object_mut()) {
                object.insert("context_id".into(), context.into());
                if !dependencies.is_empty() {
                    object.insert("depends_on".into(), serde_json::to_value(dependencies)?);
                }
            }
            if let Some(object) = value.as_object_mut() {
                if let Some(observation) = observation {
                    anyhow::ensure!(
                        object
                            .get("observation_id")
                            .is_none_or(|existing| existing == observation),
                        "--observation conflicts with the action's observation_id"
                    );
                    object.insert("observation_id".into(), observation.into());
                }
                if let Some(expect) = expect {
                    object.insert("expect".into(), expect.clone());
                }
                let has_empty_session = object.get("session_id").is_some_and(|v| {
                    v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty())
                });
                if has_empty_session && !object.contains_key("_caller_scope") {
                    object.insert("_caller_scope".into(), current_caller_scope().into());
                }
            }
            Ok(value)
        })
        .transpose()
}

/// Issue a business RPC against the daemon with SIGINT-driven
/// cancellation.
pub fn call<P, R>(
    sock: PathBuf,
    rpc_id_prefix: &str,
    method: Method,
    params: Option<P>,
    call_timeout: Duration,
) -> Result<R, CliError>
where
    P: Serialize + Send + 'static,
    R: DeserializeOwned + Send + 'static,
{
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build tokio runtime for business RPC")
        .map_err(CliError::Local)?;
    rt.block_on(async move {
        call_async::<P, R>(sock, rpc_id_prefix, method, params, call_timeout).await
    })
}

/// Same as [`call`] but assumes a pre-existing tokio runtime context.
pub async fn call_async<P, R>(
    sock: PathBuf,
    rpc_id_prefix: &str,
    method: Method,
    params: Option<P>,
    call_timeout: Duration,
) -> Result<R, CliError>
where
    P: Serialize + Send + 'static,
    R: DeserializeOwned + Send + 'static,
{
    let parent_cancel = stdin_cancellation();
    if cancel_requested() || parent_cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
        CANCEL_REQUESTED.store(true, Ordering::Relaxed);
        return Err(CliError::from_rpc(RpcError {
            code: ErrorCode::Cancelled,
            message: "command cancelled before dispatch".into(),
            data: Some(serde_json::json!({"reason": "cancelled_before_dispatch"})),
        }));
    }
    let rpc_id: RpcId = format!("{}-{}", rpc_id_prefix, random_short_id());
    let params = with_context(
        params,
        OBSERVATION_CONTEXT.get().and_then(|c| c.as_deref()),
        OBSERVATION_DEPENDENCIES
            .get()
            .map(Vec::as_slice)
            .unwrap_or_default(),
        ACTION_EVIDENCE
            .get()
            .and_then(|(observation, _)| observation.as_deref()),
        ACTION_EVIDENCE
            .get()
            .and_then(|(_, expect)| expect.as_ref()),
    )?;
    let prechecked = super::protocol::precheck_cached_daemon_support(
        &sock,
        &method,
        params.as_ref().unwrap_or(&serde_json::Value::Null),
    )?;
    let mut client = IpcClient::connect(sock.clone()).await?;
    let rpc_id_for_call = rpc_id.clone();
    let rpc_id_for_cancel = rpc_id.clone();
    let action_started = std::sync::atomic::AtomicBool::new(false);
    let action_started_ref = &action_started;

    let main_fut = async move {
        if !prechecked
            && let Err(error) = super::protocol::check_daemon_support(
                &mut client,
                &method,
                params.as_ref().unwrap_or(&serde_json::Value::Null),
            )
            .await?
        {
            return Ok(Err(error));
        }
        action_started_ref.store(true, std::sync::atomic::Ordering::Relaxed);
        client
            .call_with_id::<serde_json::Value, R>(rpc_id_for_call, method, params, call_timeout)
            .await
    };
    tokio::pin!(main_fut);

    let outcome = tokio::select! {
        biased;
        // Arm cancellation before the RPC can dispatch browser input.
        sig = wait_for_cancel(parent_cancel) => {
            sig.context("wait for cancellation").map_err(CliError::Local)?;
            CANCEL_REQUESTED.store(true, Ordering::Relaxed);
            // The feature probe has no browser effects. Dropping it here must
            // also prevent the action from being sent after cancellation.
            if !action_started.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(CliError::from_rpc(RpcError {
                    code: ErrorCode::Cancelled,
                    message: "request cancelled before dispatch".into(),
                    data: Some(serde_json::json!({
                        "reason": "cancelled_before_dispatch", "effect_state": "none"
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

    outcome.map_err(CliError::from_rpc)
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
    use super::{ipc_timeout, with_context};
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
            with_context(Some(&params), None, &[], None, None).unwrap(),
            Some(params.clone())
        );
        let framed = with_context(
            Some(&params),
            Some("observed-context"),
            &["@e2".into()],
            None,
            None,
        )
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
        let framed = with_context(Some(&params), None, &[], Some("observed"), Some(&checks))
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
        assert!(with_context(Some(&params), None, &[], Some("other"), None).is_err());
        assert_eq!(
            with_context(Some(&params), None, &[], Some("visual"), None).unwrap(),
            Some(params)
        );
    }
}
