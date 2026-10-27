//! Recovery guidance for startup failures, preserved through anyhow contexts.

#[derive(Debug, Clone, Copy, thiserror::Error)]
pub(crate) enum DaemonStartFailure {
    #[error(
        "automatic daemon startup is disabled (BSK_AUTO_START=0); restore the daemon in its owning environment with its original configuration"
    )]
    AutoStartDisabled,
    #[cfg(any(windows, test))]
    #[error(
        "cannot start an independent Windows daemon; the host may prohibit Job Object breakaway; use `bsk daemon start --foreground` in a persistent host task or start from an independent terminal"
    )]
    IndependentStartFailed,
}

impl DaemonStartFailure {
    pub(crate) fn hint(self) -> &'static str {
        match self {
            Self::AutoStartDisabled => {
                "Restore the daemon in its owning environment with its original configuration. \
                 For a new local daemon, run `bsk daemon start --foreground` in a task that \
                 outlives this command, using the same BSK_HOME and OS user as the clients. \
                 Keep that task running; verify `bsk status --json` with BSK_AUTO_START=0 \
                 in a separate invocation."
            }
            #[cfg(any(windows, test))]
            Self::IndependentStartFailed => {
                "Do not retry detached startup in this host. Run `bsk daemon start --foreground` \
                 in a persistent host task that outlives client commands, or run `bsk daemon start` \
                 from an independent terminal. Use the same BSK_HOME and OS user as the clients. \
                 Then set BSK_AUTO_START=0 for client commands and verify `bsk status --json` \
                 in a separate invocation."
            }
        }
    }
}

pub(crate) fn recovery_hint(error: &anyhow::Error) -> Option<&'static str> {
    error
        .downcast_ref::<DaemonStartFailure>()
        .map(|failure| failure.hint())
}
