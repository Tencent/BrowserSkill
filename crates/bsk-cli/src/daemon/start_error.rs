//! Recovery guidance for startup failures, preserved through anyhow contexts.

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum DaemonStartFailure {
    #[error(
        "automatic daemon startup is disabled (BSK_AUTO_START=0); restore the daemon in its owning environment with its original configuration"
    )]
    AutoStartDisabled,
    /// Process creation was denied and the immediate Job's policy was read as
    /// forbidding breakaway.
    #[cfg(any(windows, test))]
    #[error(
        "cannot start an independent Windows daemon; the Job Object of this process does not allow breakaway; \
         use `bsk daemon start --foreground` in a persistent host task"
    )]
    IndependentStartFailed,

    /// Process creation was denied inside a Job whose policy could not be read.
    #[cfg(any(windows, test))]
    #[error(
        "cannot start an independent Windows daemon; process creation was denied, either by a Job Object \
         that forbids breakaway or by access permissions on the executable or process; \
         check access to the bsk executable, or use `bsk daemon start --foreground` in a persistent host task"
    )]
    BreakawayUnverified,

    /// Process creation was denied although no Job policy forbids breakaway.
    #[cfg(any(windows, test))]
    #[error(
        "cannot start an independent Windows daemon; process creation was denied although the Job Object \
         of this process, if any, allows breakaway; check access to the bsk executable"
    )]
    ProcessCreationDenied,

    /// The child was created, so the immediate Job allowed breakaway, but it
    /// still belongs to a Job. Which Job holds it is not inspected.
    #[cfg(any(windows, test))]
    #[error(
        "cannot start an independent Windows daemon; the daemon process was created but still belongs to \
         a Job Object after breakaway; use `bsk daemon start --foreground` in a persistent host task"
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
                "The Job Object of this process does not allow breakaway, so a detached daemon \
                 cannot leave it. Do not retry detached startup in this host. Run \
                 `bsk daemon start --foreground` in a persistent host task that outlives client \
                 commands, or run `bsk daemon start` from an independent terminal that is not \
                 inside this Job. Use the same BSK_HOME and OS user as the clients. Then set \
                 BSK_AUTO_START=0 for client commands and verify `bsk status --json` in a \
                 separate invocation."
            }
            #[cfg(any(windows, test))]
            Self::BreakawayUnverified => {
                "This process is in a Job Object whose breakaway policy could not be read, so \
                 the cause is not confirmed: a Job restriction or denied access to the \
                 executable or process. Check that this OS user can run the bsk executable named \
                 above and that security software does not block it. If access is fine, run \
                 `bsk daemon start --foreground` in a persistent host task that outlives client \
                 commands, or run `bsk daemon start` from an independent terminal. Use the same \
                 BSK_HOME and OS user as the clients. Then set BSK_AUTO_START=0 for client \
                 commands and verify `bsk status --json` in a separate invocation."
            }
            #[cfg(any(windows, test))]
            Self::ProcessCreationDenied => {
                "Breakaway is permitted here, so a host Job restriction did not cause this. \
                 Check that this OS user can run the bsk executable named above and that \
                 security software does not block it, then retry `bsk daemon start`."
            }
            #[cfg(any(windows, test))]
            Self::PartialBreakaway => {
                "The daemon process was created, so the immediate Job Object allows breakaway, \
                 but the process still belongs to a Job Object after breakaway, for example an \
                 outer Job held by an IDE, a launcher or a system service. Run \
                 `bsk daemon start --foreground` in a persistent host task that outlives client \
                 commands. If another host or terminal does not run inside that Job, \
                 `bsk daemon start` from there can succeed. Use the same BSK_HOME and OS user \
                 as the clients. Then set BSK_AUTO_START=0 for client commands and verify \
                 `bsk status --json` in a separate invocation."
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
