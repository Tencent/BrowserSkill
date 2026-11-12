/// Keep legacy inputs parseable without letting them change browser policy.
pub(crate) fn warn_legacy_override(option: &str) {
    tracing::warn!(
        "{option} is deprecated and has no effect; Automation settings in the browser extension control confirmation and human help"
    );
}
