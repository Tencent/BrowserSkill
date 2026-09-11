use crate::cli::error::CliError;
use bsk_protocol::{ErrorCode, RpcError};
use std::{path::Path, time::Duration};

/// An old daemon can return locally without letting the browser decide. Limit
/// this operation, while ordinary sessions and browsing remain available.
pub(crate) fn require_help_support(sock: &Path) -> Result<(), CliError> {
    require_daemon_support(
        sock,
        "request-help",
        bsk_protocol::tools::INTERACTION_POLICY_PROTOCOL,
        bsk_protocol::tools::supports_interaction_policy,
    )
}

pub(crate) fn require_borrow_timeout_support(sock: &Path) -> Result<(), CliError> {
    require_daemon_support(
        sock,
        "tab borrow --timeout",
        bsk_protocol::tools::BORROW_CONFIRMATION_TIMEOUT_PROTOCOL,
        bsk_protocol::tools::supports_borrow_confirmation_timeout,
    )
}

fn require_daemon_support(
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

/// Keep legacy inputs parseable without letting them change browser policy.
pub(crate) fn warn_legacy_override(option: &str) {
    tracing::warn!(
        "{option} is deprecated and has no effect; Automation settings in the browser extension control confirmation and human help"
    );
}
