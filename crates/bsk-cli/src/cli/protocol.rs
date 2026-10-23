//! Check feature requirements on the same IPC connection used for the action,
//! so a restarted daemon cannot replace the peer between checking and sending.
use crate::ipc_client::{IpcClient, RpcOutcome};
use bsk_protocol::{
    Method, StatusParams, StatusResult,
    compatibility::{self, Peer},
};
use serde_json::Value;
use std::time::Duration;

pub(crate) async fn check_daemon_support(
    client: &mut IpcClient,
    method: &Method,
    params: &Value,
) -> anyhow::Result<RpcOutcome<()>> {
    if !method
        .features()
        .iter()
        .any(|feature| feature.requested(params))
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
