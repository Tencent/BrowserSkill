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
    UncertainPriorEffect,
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
    SessionBusy,
    SessionIdleTimeout,
    SessionWindowClosed,
    BrowserDisconnected,
    NoActiveSession,
    AmbiguousImplicitSession,
    SessionStopped,
    ScopeBrowserConflict,
    ScopeIncognitoConflict,
    RecordStartPageUnreachable,
    UnsupportedFeature,
    LocalPairingRequired,
    LocalFileError,
    ExtensionUnresponsive,
    ExtensionDisconnected,
    ExtensionReconnected,
    CancelCleanupTimeout,
    CancelledBeforeDispatch,
    Cancelled,
    CliParseError,
    DialogPending,
}

impl RpcErrorReason {
    pub const ALL: &'static [Self] = &[
        Self::UserMovedTab,
        Self::CooperationSyncRequired,
        Self::FrameUnobservable,
        Self::PageLoadFailed,
        Self::ControlAuthorityRequired,
        Self::ControlContextInvalid,
        Self::HumanIntervention,
        Self::ControlHeld,
        Self::DocumentChanged,
        Self::ObservationRequired,
        Self::ObservationChanged,
        Self::PreconditionInvalid,
        Self::PreconditionFailed,
        Self::TargetDetached,
        Self::TargetHidden,
        Self::TargetDisabled,
        Self::TargetReadonly,
        Self::TargetFocusLost,
        Self::TargetMoved,
        Self::TargetCovered,
        Self::VirtualRowRecycled,
        Self::ReadParamsInvalid,
        Self::ReadTargetStale,
        Self::ReadSelectorInvalid,
        Self::ReadFieldAmbiguous,
        Self::ReadLimit,
        Self::ExtractParamsInvalid,
        Self::ExtractTargetStale,
        Self::ExtractTargetAmbiguous,
        Self::ExtractTargetHidden,
        Self::ExtractSelectorInvalid,
        Self::ExtractStructureInvalid,
        Self::ExtractFieldAmbiguous,
        Self::ExtractLimit,
        Self::UiLookupFailed,
        Self::TaskUnavailable,
        Self::TargetUnavailable,
        Self::TaskStopping,
        Self::UiDeadline,
        Self::PreviewBusy,
        Self::AgentWindowScope,
        Self::ElementNotVisible,
        Self::InputNotReady,
        Self::InputClockUnavailable,
        Self::InputOutcomeUnknown,
        Self::UncertainPriorEffect,
        Self::InputPaintUnconfirmed,
        Self::InputCleanupFailed,
        Self::RefNotFound,
        Self::RefKindUnsupported,
        Self::VisualCaptureStale,
        Self::VisualCaptureInvalid,
        Self::VisualCoordinateInvalid,
        Self::VisualTargetChanged,
        Self::VisualPixelBudgetExceeded,
        Self::SelectorNotFound,
        Self::TargetNotFillable,
        Self::FillValueInvalid,
        Self::FillTargetChanged,
        Self::FillFocusLost,
        Self::FillValueMismatch,
        Self::FillFailed,
        Self::TargetNotSelect,
        Self::OptionNotFound,
        Self::OptionAmbiguous,
        Self::SingleSelectValueCount,
        Self::TabNotActive,
        Self::WindowResizeInactiveTab,
        Self::WindowResizeConstrained,
        Self::WindowResizeUnconfirmed,
        Self::WindowResizeViewportUnchanged,
        Self::RestrictedTabUrl,
        Self::CdpExtensionAccessDenied,
        Self::ObserveIdentityReloadLoop,
        Self::BorrowAgentWindowTab,
        Self::BorrowConflict,
        Self::IncognitoBorrowDisabled,
        Self::BorrowInProgress,
        Self::UserDenied,
        Self::ConfirmationTimeout,
        Self::ConfirmationUiUnavailable,
        Self::BorrowOutcomeUnknown,
        Self::ScreenshotCaptureFailed,
        Self::RendererReadTimeout,
        Self::OperationSettling,
        Self::UserCancelled,
        Self::PageHidden,
        Self::Navigation,
        Self::WatchdogTimeout,
        Self::StaleFrame,
        Self::LoadingStalled,
        Self::FileInputProbeFailed,
        Self::FileInputNotActivated,
        Self::SetFileInputFailed,
        Self::UploadMechanismUnsupported,
        Self::FileDropTargetUnavailable,
        Self::FileDropFailed,
        Self::DownloadCaptureFailed,
        Self::DownloadPathMismatch,
        Self::TransferOutcomeUnknown,
        Self::TransferTimeout,
        Self::CleanupFailed,
        Self::SessionBusy,
        Self::SessionIdleTimeout,
        Self::SessionWindowClosed,
        Self::BrowserDisconnected,
        Self::NoActiveSession,
        Self::AmbiguousImplicitSession,
        Self::SessionStopped,
        Self::ScopeBrowserConflict,
        Self::ScopeIncognitoConflict,
        Self::RecordStartPageUnreachable,
        Self::UnsupportedFeature,
        Self::LocalPairingRequired,
        Self::LocalFileError,
        Self::ExtensionUnresponsive,
        Self::ExtensionDisconnected,
        Self::ExtensionReconnected,
        Self::CancelCleanupTimeout,
        Self::CancelledBeforeDispatch,
        Self::Cancelled,
        Self::CliParseError,
        Self::DialogPending,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UserMovedTab => "user_moved_tab",
            Self::CooperationSyncRequired => "cooperation_sync_required",
            Self::FrameUnobservable => "frame_unobservable",
            Self::PageLoadFailed => "page_load_failed",
            Self::ControlAuthorityRequired => "control_authority_required",
            Self::ControlContextInvalid => "control_context_invalid",
            Self::HumanIntervention => "human_intervention",
            Self::ControlHeld => "control_held",
            Self::DocumentChanged => "document_changed",
            Self::ObservationRequired => "observation_required",
            Self::ObservationChanged => "observation_changed",
            Self::PreconditionInvalid => "precondition_invalid",
            Self::PreconditionFailed => "precondition_failed",
            Self::TargetDetached => "target_detached",
            Self::TargetHidden => "target_hidden",
            Self::TargetDisabled => "target_disabled",
            Self::TargetReadonly => "target_readonly",
            Self::TargetFocusLost => "target_focus_lost",
            Self::TargetMoved => "target_moved",
            Self::TargetCovered => "target_covered",
            Self::VirtualRowRecycled => "virtual_row_recycled",
            Self::ReadParamsInvalid => "read_params_invalid",
            Self::ReadTargetStale => "read_target_stale",
            Self::ReadSelectorInvalid => "read_selector_invalid",
            Self::ReadFieldAmbiguous => "read_field_ambiguous",
            Self::ReadLimit => "read_limit",
            Self::ExtractParamsInvalid => "extract_params_invalid",
            Self::ExtractTargetStale => "extract_target_stale",
            Self::ExtractTargetAmbiguous => "extract_target_ambiguous",
            Self::ExtractTargetHidden => "extract_target_hidden",
            Self::ExtractSelectorInvalid => "extract_selector_invalid",
            Self::ExtractStructureInvalid => "extract_structure_invalid",
            Self::ExtractFieldAmbiguous => "extract_field_ambiguous",
            Self::ExtractLimit => "extract_limit",
            Self::UiLookupFailed => "ui_lookup_failed",
            Self::TaskUnavailable => "task_unavailable",
            Self::TargetUnavailable => "target_unavailable",
            Self::TaskStopping => "task_stopping",
            Self::UiDeadline => "ui_deadline",
            Self::PreviewBusy => "preview_busy",
            Self::AgentWindowScope => "agent_window_scope",
            Self::ElementNotVisible => "element_not_visible",
            Self::InputNotReady => "input_not_ready",
            Self::InputClockUnavailable => "input_clock_unavailable",
            Self::InputOutcomeUnknown => "input_outcome_unknown",
            Self::UncertainPriorEffect => "uncertain_prior_effect",
            Self::InputPaintUnconfirmed => "input_paint_unconfirmed",
            Self::InputCleanupFailed => "input_cleanup_failed",
            Self::RefNotFound => "ref_not_found",
            Self::RefKindUnsupported => "ref_kind_unsupported",
            Self::VisualCaptureStale => "visual_capture_stale",
            Self::VisualCaptureInvalid => "visual_capture_invalid",
            Self::VisualCoordinateInvalid => "visual_coordinate_invalid",
            Self::VisualTargetChanged => "visual_target_changed",
            Self::VisualPixelBudgetExceeded => "visual_pixel_budget_exceeded",
            Self::SelectorNotFound => "selector_not_found",
            Self::TargetNotFillable => "target_not_fillable",
            Self::FillValueInvalid => "fill_value_invalid",
            Self::FillTargetChanged => "fill_target_changed",
            Self::FillFocusLost => "fill_focus_lost",
            Self::FillValueMismatch => "fill_value_mismatch",
            Self::FillFailed => "fill_failed",
            Self::TargetNotSelect => "target_not_select",
            Self::OptionNotFound => "option_not_found",
            Self::OptionAmbiguous => "option_ambiguous",
            Self::SingleSelectValueCount => "single_select_value_count",
            Self::TabNotActive => "tab_not_active",
            Self::WindowResizeInactiveTab => "window_resize_inactive_tab",
            Self::WindowResizeConstrained => "window_resize_constrained",
            Self::WindowResizeUnconfirmed => "window_resize_unconfirmed",
            Self::WindowResizeViewportUnchanged => "window_resize_viewport_unchanged",
            Self::RestrictedTabUrl => "restricted_tab_url",
            Self::CdpExtensionAccessDenied => "cdp_extension_access_denied",
            Self::ObserveIdentityReloadLoop => "observe_identity_reload_loop",
            Self::BorrowAgentWindowTab => "borrow_agent_window_tab",
            Self::BorrowConflict => "borrow_conflict",
            Self::IncognitoBorrowDisabled => "incognito_borrow_disabled",
            Self::BorrowInProgress => "borrow_in_progress",
            Self::UserDenied => "user_denied",
            Self::ConfirmationTimeout => "confirmation_timeout",
            Self::ConfirmationUiUnavailable => "confirmation_ui_unavailable",
            Self::BorrowOutcomeUnknown => "borrow_outcome_unknown",
            Self::ScreenshotCaptureFailed => "screenshot_capture_failed",
            Self::RendererReadTimeout => "renderer_read_timeout",
            Self::OperationSettling => "operation_settling",
            Self::UserCancelled => "user_cancelled",
            Self::PageHidden => "page_hidden",
            Self::Navigation => "navigation",
            Self::WatchdogTimeout => "watchdog_timeout",
            Self::StaleFrame => "stale_frame",
            Self::LoadingStalled => "loading_stalled",
            Self::FileInputProbeFailed => "file_input_probe_failed",
            Self::FileInputNotActivated => "file_input_not_activated",
            Self::SetFileInputFailed => "set_file_input_failed",
            Self::UploadMechanismUnsupported => "upload_mechanism_unsupported",
            Self::FileDropTargetUnavailable => "file_drop_target_unavailable",
            Self::FileDropFailed => "file_drop_failed",
            Self::DownloadCaptureFailed => "download_capture_failed",
            Self::DownloadPathMismatch => "download_path_mismatch",
            Self::TransferOutcomeUnknown => "transfer_outcome_unknown",
            Self::TransferTimeout => "transfer_timeout",
            Self::CleanupFailed => "cleanup_failed",
            Self::SessionBusy => "session_busy",
            Self::SessionIdleTimeout => "session_idle_timeout",
            Self::SessionWindowClosed => "session_window_closed",
            Self::BrowserDisconnected => "browser_disconnected",
            Self::NoActiveSession => "no_active_session",
            Self::AmbiguousImplicitSession => "ambiguous_implicit_session",
            Self::SessionStopped => "session_stopped",
            Self::ScopeBrowserConflict => "scope_browser_conflict",
            Self::ScopeIncognitoConflict => "scope_incognito_conflict",
            Self::RecordStartPageUnreachable => "record_start_page_unreachable",
            Self::UnsupportedFeature => "unsupported_feature",
            Self::LocalPairingRequired => "local_pairing_required",
            Self::LocalFileError => "local_file_error",
            Self::ExtensionUnresponsive => "extension_unresponsive",
            Self::ExtensionDisconnected => "extension_disconnected",
            Self::ExtensionReconnected => "extension_reconnected",
            Self::CancelCleanupTimeout => "cancel_cleanup_timeout",
            Self::CancelledBeforeDispatch => "cancelled_before_dispatch",
            Self::Cancelled => "cancelled",
            Self::CliParseError => "cli_parse_error",
            Self::DialogPending => "dialog_pending",
        }
    }

    pub fn from_wire(raw: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|reason| reason.as_str() == raw)
    }
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
    fn rpc_error_reason_all_matches_wire_names_uniquely() {
        let mut seen = std::collections::HashSet::new();
        assert_eq!(RpcErrorReason::ALL.len(), 123);
        for &reason in RpcErrorReason::ALL {
            assert!(
                seen.insert(reason),
                "duplicate RpcErrorReason in ALL: {reason:?}"
            );
            assert_eq!(
                serde_json::to_value(reason).unwrap(),
                serde_json::Value::String(reason.as_str().to_owned()),
            );
            let decoded: RpcErrorReason =
                serde_json::from_str(&format!("\"{}\"", reason.as_str())).unwrap();
            assert_eq!(decoded, reason);
        }
    }

    #[test]
    fn rpc_error_reason_round_trips_wave1_reasons() {
        for (variant, expected) in [
            (RpcErrorReason::VirtualRowRecycled, "virtual_row_recycled"),
            (RpcErrorReason::OptionAmbiguous, "option_ambiguous"),
            (
                RpcErrorReason::UncertainPriorEffect,
                "uncertain_prior_effect",
            ),
        ] {
            let encoded = serde_json::to_value(variant).unwrap();
            assert_eq!(encoded, serde_json::json!(expected));
            let decoded: RpcErrorReason = serde_json::from_value(encoded).unwrap();
            assert_eq!(decoded, variant);
        }
    }
}
