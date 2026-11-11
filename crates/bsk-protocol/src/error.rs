//! RPC error codes and structured JSON-RPC-style errors.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Wire-format JSON-RPC error object carried inside [`crate::frame::ResponseFrame`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub struct RpcError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// Stable daemon/extension error codes (§4.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    UnknownMethod,
    Unsupported,
    InvalidParams,
    NotFound,
    PermissionDenied,
    Timeout,
    /// The original operation is still running and needs an agent dialog decision.
    DialogPending,
    CdpFailed,
    ProtocolError,
    Cancelled,
    UserAborted,
    VersionTooOld,
    MultipleBrowsersOnline,
    NoBrowserConnected,
    PairingRequired,
}

impl ErrorCode {
    pub const ALL: &'static [Self] = &[
        Self::UnknownMethod,
        Self::Unsupported,
        Self::InvalidParams,
        Self::NotFound,
        Self::PermissionDenied,
        Self::Timeout,
        Self::DialogPending,
        Self::CdpFailed,
        Self::ProtocolError,
        Self::Cancelled,
        Self::UserAborted,
        Self::VersionTooOld,
        Self::MultipleBrowsersOnline,
        Self::NoBrowserConnected,
        Self::PairingRequired,
    ];

    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::UnknownMethod => "unknown_method",
            Self::Unsupported => "unsupported",
            Self::InvalidParams => "invalid_params",
            Self::NotFound => "not_found",
            Self::PermissionDenied => "permission_denied",
            Self::Timeout => "timeout",
            Self::DialogPending => "dialog_pending",
            Self::CdpFailed => "cdp_failed",
            Self::ProtocolError => "protocol_error",
            Self::Cancelled => "cancelled",
            Self::UserAborted => "user_aborted",
            Self::VersionTooOld => "version_too_old",
            Self::MultipleBrowsersOnline => "multiple_browsers_online",
            Self::NoBrowserConnected => "no_browser_connected",
            Self::PairingRequired => "pairing_required",
        }
    }
}

/// Stable `RpcError.data.reason` values shared across extension emitters and CLI renderers.
///
/// Wire frames carry `data` as untyped JSON so older peers can ignore unknown reasons and
/// fall back to [`ErrorCode`]-level rendering, while TypeScript and JSON Schema consumers
/// obtain the canonical union from this single source of truth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RpcErrorReason {
    UserMovedTab,
    CooperationSyncRequired,
    FrameUnobservable,
    PageLoadFailed,
    ControlAuthorityRequired,
    ControlContextInvalid,
    HumanIntervention,
    ControlHeld,
    DocumentChanged,
    ObservationRequired,
    ObservationChanged,
    PreconditionInvalid,
    PreconditionFailed,
    TargetDetached,
    TargetHidden,
    TargetDisabled,
    TargetReadonly,
    TargetFocusLost,
    TargetMoved,
    TargetCovered,
    VirtualRowRecycled,
    ReadParamsInvalid,
    ReadTargetStale,
    ReadSelectorInvalid,
    ReadFieldAmbiguous,
    ReadLimit,
    ExtractParamsInvalid,
    ExtractTargetStale,
    ExtractTargetAmbiguous,
    ExtractTargetHidden,
    ExtractSelectorInvalid,
    ExtractStructureInvalid,
    ExtractFieldAmbiguous,
    ExtractLimit,
    UiLookupFailed,
    TaskUnavailable,
    TargetUnavailable,
    TaskStopping,
    UiDeadline,
    PreviewBusy,
    AgentWindowScope,
    ElementNotVisible,
    InputNotReady,
    InputClockUnavailable,
    InputOutcomeUnknown,
    InputPaintUnconfirmed,
    InputCleanupFailed,
    RefNotFound,
    RefKindUnsupported,
    VisualCaptureStale,
    VisualCaptureInvalid,
    VisualCoordinateInvalid,
    VisualTargetChanged,
    VisualPixelBudgetExceeded,
    SelectorNotFound,
    TargetNotFillable,
    FillValueInvalid,
    FillTargetChanged,
    FillFocusLost,
    FillValueMismatch,
    FillFailed,
    TargetNotSelect,
    OptionNotFound,
    OptionAmbiguous,
    SingleSelectValueCount,
    TabNotActive,
    WindowResizeInactiveTab,
    WindowResizeConstrained,
    WindowResizeUnconfirmed,
    WindowResizeViewportUnchanged,
    RestrictedTabUrl,
    CdpExtensionAccessDenied,
    ObserveIdentityReloadLoop,
    BorrowAgentWindowTab,
    BorrowConflict,
    IncognitoBorrowDisabled,
    BorrowInProgress,
    UserDenied,
    ConfirmationTimeout,
    ConfirmationUiUnavailable,
    BorrowOutcomeUnknown,
    ScreenshotCaptureFailed,
    RendererReadTimeout,
    OperationSettling,
    UserCancelled,
    PageHidden,
    Navigation,
    WatchdogTimeout,
    StaleFrame,
    LoadingStalled,
    FileInputProbeFailed,
    FileInputNotActivated,
    SetFileInputFailed,
    UploadMechanismUnsupported,
    FileDropTargetUnavailable,
    FileDropFailed,
    DownloadCaptureFailed,
    DownloadPathMismatch,
    TransferOutcomeUnknown,
    TransferTimeout,
    CleanupFailed,
}

#[derive(Debug, Error)]
pub enum DecodeError {
    #[error("ambiguous response frame: expected exactly one of result or error")]
    AmbiguousResponse,
    #[error("invalid protocol frame: {0}")]
    InvalidFrame(String),
}

#[cfg(test)]
mod user_aborted_tests {
    use super::*;

    #[test]
    fn user_aborted_serialises_as_snake_case() {
        let v = serde_json::to_value(ErrorCode::UserAborted).unwrap();
        assert_eq!(v, serde_json::json!("user_aborted"));
    }

    #[test]
    fn user_aborted_round_trips() {
        let parsed: ErrorCode = serde_json::from_value(serde_json::json!("user_aborted")).unwrap();
        assert_eq!(parsed, ErrorCode::UserAborted);
    }

    #[test]
    fn user_aborted_is_distinct_from_cancelled() {
        assert_ne!(ErrorCode::UserAborted, ErrorCode::Cancelled);
    }

    #[test]
    fn error_code_all_matches_wire_names_uniquely() {
        let mut seen = std::collections::HashSet::new();
        for &code in ErrorCode::ALL {
            assert!(seen.insert(code), "duplicate ErrorCode in ALL: {code:?}");
            assert_eq!(
                serde_json::to_value(code).unwrap(),
                serde_json::Value::String(code.wire_name().to_owned()),
            );
        }
    }

    #[test]
    fn rpc_error_reason_round_trips_wave1_reasons() {
        for (variant, expected) in [
            (RpcErrorReason::VirtualRowRecycled, "virtual_row_recycled"),
            (RpcErrorReason::OptionAmbiguous, "option_ambiguous"),
        ] {
            let encoded = serde_json::to_value(variant).unwrap();
            assert_eq!(encoded, serde_json::json!(expected));
            let decoded: RpcErrorReason = serde_json::from_value(encoded).unwrap();
            assert_eq!(decoded, variant);
        }
    }
}
