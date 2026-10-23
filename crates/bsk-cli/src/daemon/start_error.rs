//! Recovery guidance for startup failures, preserved through anyhow contexts.

#[derive(Debug, Clone, Copy, thiserror::Error)]
pub(crate) enum DaemonStartFailure {
    #[error(
        "automatic daemon startup is disabled (BSK_AUTO_START=0); restore the daemon in its owning environment with its original configuration"
    )]
    AutoStartDisabled,
    #[cfg(any(windows, test))]
    #[error(
        "cannot start an independent Windows daemon; the host Job Object forbids breakaway; \
         use `bsk daemon start --foreground` in a persistent host task"
    )]
    IndependentStartFailed,

    /// The child process was created (immediate Job allows breakaway) but is still
    /// associated with an outer Job that blocked full breakaway. This is the common
    /// Windows 11 case where system-service Job Objects sit above the terminal's Job.
    #[cfg(any(windows, test))]
    #[error(
        "cannot start an independent Windows daemon; a nested outer Job Object blocked \
         full breakaway even though the immediate Job allows it; \
         use `bsk daemon start --foreground` in a persistent host task"
    )]
    PartialBreakaway,

    #[cfg(any(windows, test))]
    #[error(
        "cannot start an independent Windows daemon; the daemon process left every Job Object \
         but could not be resumed; retry `bsk daemon start`"
    )]
    ResumeFailed,
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
                "The host Job Object forbids breakaway entirely (e.g. a sandbox or restricted \
                 service environment). Do not retry detached startup in this host. \
                 Run `bsk daemon start --foreground` in a persistent host task that outlives \
                 client commands. Use the same BSK_HOME and OS user as the clients. \
                 Then set BSK_AUTO_START=0 for client commands and verify `bsk status --json` \
                 in a separate invocation."
            }
            #[cfg(any(windows, test))]
            Self::PartialBreakaway => {
                "The immediate Job Object allows breakaway, but a nested outer Job Object \
                 (typically held by a Windows system service such as BrokerInfrastructure, \
                 Appinfo or PcaSvc) blocked full breakaway — this is the default Windows 11 \
                 nested-Job layout. Switching terminals or shells usually does not help. \
                 Run `bsk daemon start --foreground` in a persistent host task, for example \
                 a silent VBS launcher placed in the Startup folder (see issue #337 for a \
                 working example). Use the same BSK_HOME and OS user as the clients. \
                 Then set BSK_AUTO_START=0 for client commands and verify `bsk status --json` \
                 in a separate invocation."
            }
            #[cfg(any(windows, test))]
            Self::ResumeFailed => {
                "Job Object breakaway succeeded, so this is not a host Job restriction. \
                 The suspended daemon process was terminated before it ran. \
                 Retry `bsk daemon start`. If it keeps failing, check whether security \
                 software is blocking bsk.exe."
            }
        }
    }
}

pub(crate) fn recovery_hint(error: &anyhow::Error) -> Option<&'static str> {
    error
        .downcast_ref::<DaemonStartFailure>()
        .map(|failure| failure.hint())
}
