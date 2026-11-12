//! Check feature requirements against the daemon protocol discovered during
//! startup, or on the same IPC connection when invoked as a library helper
//! without `ensure_daemon()`.
use crate::cli::error::CliError;
use crate::ipc_client::{IpcClient, RpcOutcome};
use bsk_protocol::{
    Method, StatusParams, StatusResult,
    compatibility::{self, Feature, Peer},
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

static VERIFIED_DAEMON_PROTOCOL: Mutex<Option<(PathBuf, String)>> = Mutex::new(None);

pub(crate) fn record_daemon_protocol(sock: &Path, protocol: &str) {
    *VERIFIED_DAEMON_PROTOCOL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
        Some((sock.to_path_buf(), protocol.to_owned()));
}

pub(crate) fn cached_daemon_protocol(sock: &Path) -> Option<String> {
    VERIFIED_DAEMON_PROTOCOL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .filter(|(cached_sock, _)| cached_sock == sock)
        .map(|(_, protocol)| protocol.clone())
}

/// Returns `Ok(true)` when the request is already verified without an IPC probe,
/// `Ok(false)` when an on-connection `system.status` check is still needed, or
/// `Err(CliError)` when the cached daemon protocol lacks a requested feature.
pub(crate) fn precheck_cached_daemon_support(
    sock: &Path,
    method: &Method,
    params: &Value,
) -> Result<bool, CliError> {
    if !method
        .features()
        .iter()
        .any(|feature| feature.requested(Peer::Daemon, params))
    {
        return Ok(true);
    }
    let Some(protocol) = cached_daemon_protocol(sock) else {
        return Ok(false);
    };
    compatibility::check_request(method, params, Peer::Daemon, &protocol)
        .map(|()| true)
        .map_err(CliError::from_rpc)
}

pub(crate) fn require_feature_on_daemon(sock: &Path, feature: Feature) -> Result<(), CliError> {
    let protocol = match cached_daemon_protocol(sock) {
        Some(protocol) => protocol,
        None => {
            crate::cli::status::query_sock_with_wait(sock.to_path_buf(), Duration::ZERO)?
                .protocol_version
        }
    };
    feature
        .require(Peer::Daemon, &protocol)
        .map_err(CliError::from_rpc)
}

pub(crate) async fn check_daemon_support(
    client: &mut IpcClient,
    method: &Method,
    params: &Value,
) -> anyhow::Result<RpcOutcome<()>> {
    if !method
        .features()
        .iter()
        .any(|feature| feature.requested(Peer::Daemon, params))
    {
        return Ok(Ok(()));
    }
    let status = client
        .call::<_, StatusResult>(
            "compatibility",
            Method::SystemStatus,
            Some(StatusParams::default()),
            Duration::from_secs(2),
        )
        .await?;
    Ok(match status {
        Ok(status) => {
            compatibility::check_request(method, params, Peer::Daemon, &status.protocol_version)
        }
        Err(error) => Err(error),
    })
}
