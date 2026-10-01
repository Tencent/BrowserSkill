//! Daemon scheduling policy. Exhaustive matching makes every new method choose
//! a timeout and settlement policy independently of its browser effect class.
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
    Evaluation,
}

#[derive(Clone, Copy)]
pub struct ExecutionPolicy {
    pub deadline: Deadline,
    pub response_grace: bool,
    pub cancel_at_deadline: bool,
    pub outcome: Outcome,
    /// A caller deadline cannot prove that arbitrary page JavaScript has stopped.
    pub retain_until_settled: bool,
}

pub fn execution_policy(method: &Method) -> ExecutionPolicy {
    use Method::*;
    let (deadline, response_grace, cancel_at_deadline, outcome, retain_until_settled) = match method
    {
        ToolTabBorrow => (
            Deadline::BorrowConfirmation,
            false,
            true,
            Outcome::Ordinary,
            false,
        ),
        ToolNavigate => (Deadline::Standard, true, false, Outcome::Ordinary, false),
        ToolNavigateBack => (Deadline::Standard, true, false, Outcome::Ordinary, false),
        ToolNavigateForward => (Deadline::Standard, true, false, Outcome::Ordinary, false),
        ToolReload => (Deadline::Standard, true, false, Outcome::Ordinary, false),
        ToolClick => (Deadline::Standard, false, true, Outcome::NativeInput, false),
        ToolWheel => (Deadline::Standard, false, true, Outcome::NativeInput, false),
        ToolPress => (Deadline::Standard, false, true, Outcome::NativeInput, false),
        ToolUpload => (Deadline::Standard, true, true, Outcome::FileTransfer, false),
        ToolDownload => (Deadline::Standard, true, true, Outcome::FileTransfer, false),
        ToolScreenshotFullPage => (Deadline::FullPage, false, true, Outcome::Ordinary, false),
        ToolEvaluate => (Deadline::Standard, false, true, Outcome::Evaluation, true),
        ToolWaitForNavigation => (Deadline::Standard, true, false, Outcome::Ordinary, false),
        ToolRequestHelp => (Deadline::Standard, true, true, Outcome::Ordinary, false),
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
        | ToolWaitMs
        | ToolRecordStart
        | ToolRecordStop
        | ToolRecordAwait
        | TransferBegin
        | TransferChunk
        | TransferFinish
        | TransferRead
        | TransferRelease
        | Cancel => (Deadline::Standard, false, false, Outcome::Ordinary, false),
    };
    ExecutionPolicy {
        deadline,
        response_grace,
        cancel_at_deadline,
        outcome,
        retain_until_settled,
    }
}
