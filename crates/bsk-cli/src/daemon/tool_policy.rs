//! Daemon scheduling policy. Exhaustive matching makes every new method choose
//! a timeout and cancellation policy independently of its browser effect class.
use bsk_protocol::Method;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Deadline {
    Standard,
    FullPage,
    BorrowConfirmation,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ordinary,
    NativeInput,
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
    use Method::*;
    const ORDINARY: ExecutionPolicy = ExecutionPolicy {
        deadline: Deadline::Standard,
        response_grace: false,
        cancel_at_deadline: false,
        outcome: Outcome::Ordinary,
    };
    match method {
        ToolTabBorrow => ExecutionPolicy {
            deadline: Deadline::BorrowConfirmation,
            cancel_at_deadline: true,
            ..ORDINARY
        },
        ToolNavigate
        | ToolNavigateBack
        | ToolNavigateForward
        | ToolReload
        | ToolWaitForNavigation => ExecutionPolicy {
            response_grace: true,
            ..ORDINARY
        },
        ToolClick | ToolWheel | ToolPress => ExecutionPolicy {
            cancel_at_deadline: true,
            outcome: Outcome::NativeInput,
            ..ORDINARY
        },
        ToolUpload | ToolDownload => ExecutionPolicy {
            response_grace: true,
            cancel_at_deadline: true,
            outcome: Outcome::FileTransfer,
            ..ORDINARY
        },
        ToolScreenshotFullPage => ExecutionPolicy {
            deadline: Deadline::FullPage,
            cancel_at_deadline: true,
            ..ORDINARY
        },
        ToolRequestHelp => ExecutionPolicy {
            response_grace: true,
            cancel_at_deadline: true,
            ..ORDINARY
        },
        AuditRequest
        | SystemHandshake
        | SystemPing
        | SystemStatus
        | SessionStart
        | SessionStartTracked
        | SessionRequest
        | SessionStop
        | SessionStopAll
        | SessionList
        | BrowserList
        | ToolSessionStart
        | ToolSessionStop
        | ToolWindowResize
        | ToolEmulate
        | ToolTabList
        | ToolTabCreate
        | ToolTabClose
        | ToolTabReturn
        | ToolTabSelect
        | ToolHover
        | ToolScrollTo
        | ToolFocus
        | ToolBlur
        | ToolFill
        | ToolSelect
        | ToolSnapshot
        | ToolObserve
        | ToolGetHtml
        | ToolScreenshot
        | ToolScreenshotRead
        | ToolScreenshotRelease
        | ToolConsole
        | ToolDebug
        | ToolNetwork
        | ToolEvaluate
        | ToolWaitMs
        | ToolRecordStart
        | ToolRecordStop
        | ToolRecordAwait
        | TransferBegin
        | TransferChunk
        | TransferFinish
        | TransferRead
        | TransferRelease
        | Cancel => ORDINARY,
    }
}
