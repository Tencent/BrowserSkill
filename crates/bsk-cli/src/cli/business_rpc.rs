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
    if parent_cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
        return Err(CliError::from_rpc(RpcError {
            code: ErrorCode::Cancelled,
            message: "parent closed the cancellation pipe".into(),
            data: Some(serde_json::json!({"reason": "cancelled_before_dispatch"})),
        }));
    }
    let rpc_id: RpcId = format!("{}-{}", rpc_id_prefix, random_short_id());
    let mut client = IpcClient::connect(sock.clone()).await?;
    let rpc_id_for_call = rpc_id.clone();
    let rpc_id_for_cancel = rpc_id.clone();

    let main_fut = async move {
        client
            .call_with_id::<P, R>(rpc_id_for_call, method, params, call_timeout)
            .await
    };
    tokio::pin!(main_fut);

    let outcome = tokio::select! {
        biased;
        res = &mut main_fut => res?,
        sig = wait_for_cancel(parent_cancel) => {
            sig.context("wait for cancellation").map_err(CliError::Local)?;
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
async fn send_cancel(sock: &Path, rpc_id: &str, deadline: Instant) -> anyhow::Result<()> {
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

fn random_short_id() -> String {
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
mod tests {
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
