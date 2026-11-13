//! Daemon scheduling policy derived directly from compile-time `MethodSpec`
//! metadata in `bsk-protocol` (zero duplicated tables, zero wildcard arms).
use bsk_protocol::{DeadlineKind, Method, OutcomeKind};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Deadline {
    Standard,
    FullPage,
    BorrowConfirmation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ordinary,
    EffectAwareAction,
    FileTransfer,
}

#[derive(Clone, Copy)]
pub struct ExecutionPolicy {
    pub deadline: Deadline,
    pub response_grace: bool,
    pub cancel_at_deadline: bool,
    pub outcome: Outcome,
}

pub fn execution_policy(method: &Method) -> ExecutionPolicy {
    let spec = method.spec();
    let deadline = match spec.deadline {
        DeadlineKind::Standard => Deadline::Standard,
        DeadlineKind::FullPage => Deadline::FullPage,
        DeadlineKind::BorrowConfirmation => Deadline::BorrowConfirmation,
    };
    let outcome = match spec.outcome {
        OutcomeKind::Ordinary => Outcome::Ordinary,
        OutcomeKind::EffectAwareAction => Outcome::EffectAwareAction,
        OutcomeKind::FileTransfer => Outcome::FileTransfer,
    };
    ExecutionPolicy {
        deadline,
        response_grace: spec.response_grace,
        cancel_at_deadline: spec.cancel_at_deadline,
        outcome,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutating_window_emulate_and_tab_close_keep_effect_aware_policy() {
        for method in [
            Method::ToolWindowResize,
            Method::ToolEmulate,
            Method::ToolTabClose,
        ] {
            let policy = execution_policy(&method);
            assert_eq!(policy.outcome, Outcome::EffectAwareAction);
            assert!(policy.cancel_at_deadline);
        }
    }
}
