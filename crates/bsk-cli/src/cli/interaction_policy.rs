use crate::cli::error::CliError;
use bsk_protocol::{ErrorCode, RpcError};
use std::{path::Path, time::Duration};

/// Older daemons may bypass browser settings. Check before starting or dispatching a prompt-sensitive operation.
pub(crate) fn require_support(sock: &Path) -> Result<(), CliError> {
    let status = crate::cli::status::query_sock_with_wait(sock.to_path_buf(), Duration::ZERO)?;
    if !bsk_protocol::tools::supports_interaction_policy(&status.protocol_version) {
        return Err(CliError::from_rpc(RpcError { code: ErrorCode::Unsupported,
            message: "Browser Automation settings require daemon protocol 1.3; update bsk and restart its daemon".into(), data: None }));
    }
    Ok(())
}

/// Keep legacy inputs parseable without letting them change browser policy.
pub(crate) fn warn_legacy_override(option: &str) {
    tracing::warn!(
        "{option} is deprecated and has no effect; Automation settings in the browser extension control confirmation and human help"
    );
}
