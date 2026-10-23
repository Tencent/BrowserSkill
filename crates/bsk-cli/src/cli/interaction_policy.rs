use crate::cli::error::CliError;
use crate::cli::protocol::require_daemon_support;
use std::path::Path;

pub(crate) fn require_dialog_support(sock: &Path) -> Result<(), CliError> {
    require_daemon_support(
        sock,
        "JavaScript dialog control",
        bsk_protocol::tools::DIALOG_CONTROL_PROTOCOL,
        bsk_protocol::tools::supports_dialog_control,
    )
}

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

/// Keep legacy inputs parseable without letting them change browser policy.
pub(crate) fn warn_legacy_override(option: &str) {
    tracing::warn!(
        "{option} is deprecated and has no effect; Automation settings in the browser extension control confirmation and human help"
    );
}
