//! Per-operation compatibility checks for features older daemons may ignore.

use crate::cli::error::CliError;
use bsk_protocol::{ErrorCode, RpcError};
use std::{path::Path, time::Duration};

pub(crate) fn require_daemon_support(
    sock: &Path,
    operation: &str,
    required_protocol: &str,
    supports: fn(&str) -> bool,
) -> Result<(), CliError> {
    let status = crate::cli::status::query_sock_with_wait(sock.to_path_buf(), Duration::ZERO)?;
    if !supports(&status.protocol_version) {
        return Err(CliError::from_rpc(RpcError {
            code: ErrorCode::Unsupported,
            message: format!(
                "{operation} requires daemon protocol {required_protocol} (connected: {}); update bsk and restart its daemon. Ordinary sessions and browsing remain available",
                status.protocol_version
            ),
            data: Some(serde_json::json!({
                "reason": "unsupported_feature", "operation": operation,
                "component": "daemon", "required_protocol": required_protocol,
                "actual_protocol": status.protocol_version,
            })),
        }));
    }
    Ok(())
}
