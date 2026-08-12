//! Cancellable business-RPC helper used by every long-running CLI
//! subcommand.
//!
//! M10.2 wires `SIGINT → cancel { rpc_id }` end-to-end. The CLI arms
//! a Ctrl-C handler around the IPC call, so when the user hits Ctrl-C
//! while a `bsk tool.*` / `bsk session.*` call is in flight:
//!
//! 1. We send a fresh `cancel { rpc_id }` IPC frame on a new
//!    connection (the original socket is still parked on `read_line`).
//! 2. Wait up to [`CANCEL_RESPONSE_GRACE`] for the original call to
//!    return with a structured `cancelled` error.
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
use tracing::debug;

use crate::cli::error::CliError;
use crate::ipc_client::IpcClient;

/// Hard cap on how long we wait for the cancelled RPC to settle after
/// SIGINT triggers. Picked per design §4.6 ("≤ 2s, then force exit").
pub const CANCEL_RESPONSE_GRACE: Duration = Duration::from_secs(2);

/// Hard cap on the cancel-frame's own IPC round-trip. Independent of
/// the original call's timeout because cancel must answer promptly.
const CANCEL_FRAME_TIMEOUT: Duration = Duration::from_secs(2);

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
        sig = wait_for_sigint() => {
            sig.context("install SIGINT handler").map_err(CliError::Local)?;
            debug!(rpc_id = %rpc_id_for_cancel, "SIGINT: forwarding cancel to daemon");
            let _ = send_cancel(&sock, &rpc_id_for_cancel).await;
            match tokio::time::timeout(CANCEL_RESPONSE_GRACE, &mut main_fut).await {
                Ok(res) => res?,
                Err(_) => {
                    debug!(
                        rpc_id = %rpc_id_for_cancel,
                        "SIGINT: cancel grace elapsed; synthesising cancelled error"
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

/// Send a `cancel { rpc_id }` frame over a fresh connection so it
/// lands on the daemon while the original call is still parked.
///
/// The on-the-wire method name is `cancel` (not `system.cancel`)
/// because that is the identifier registered in
/// [`bsk_protocol::Method::Cancel`] today — design §4.3 lists the
/// bare `cancel` namespace, and the implementation has used that
/// name since M9. The CLI sticks to whatever the protocol crate
/// exports as `Method::Cancel` so drift between docs and code
/// stays loud.
pub async fn send_cancel(sock: &Path, rpc_id: &str) -> anyhow::Result<()> {
    let mut client = IpcClient::connect(sock).await?;
    let cancel_id = format!("cancel-{}", random_short_id());
    let _ignored: anyhow::Result<std::result::Result<CancelResult, RpcError>> = client
        .call_with_id::<_, CancelResult>(
            cancel_id,
            Method::Cancel,
            Some(CancelParams {
                rpc_id: rpc_id.to_string(),
            }),
            CANCEL_FRAME_TIMEOUT,
        )
        .await;
    Ok(())
}

fn random_short_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; 4];
    rng.fill(&mut bytes[..]);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Wait for either Ctrl-C or process SIGTERM. Returning here means
/// the user has asked us to stop.
async fn wait_for_sigint() -> anyhow::Result<()> {
    tokio::signal::ctrl_c().await.context("listen for SIGINT")?;
    Ok(())
}
