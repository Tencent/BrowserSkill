use crate::cli::error::CliError;
use bsk_protocol::{ErrorCode, RpcError};
use std::{path::Path, time::Duration};

/// Old daemons ignore unknown session fields. Check before sending any mutation.
pub(crate) fn require_support(sock: &Path) -> Result<(), CliError> {
    let status = crate::cli::status::query_sock_with_wait(sock.to_path_buf(), Duration::ZERO)?;
    if !bsk_protocol::tools::supports_interaction_policy(&status.protocol_version) {
        return Err(CliError::from_rpc(RpcError { code: ErrorCode::Unsupported,
            message: "This option requires a daemon supporting protocol 1.2; update bsk and restart its daemon".into(), data: None }));
    }
    Ok(())
}
