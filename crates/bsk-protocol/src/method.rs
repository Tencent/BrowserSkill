//! Namespaced RPC methods (§4.3).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::catalog::{MethodDescriptor, MethodOwner};
use crate::compatibility::Feature;
use crate::system::*;
use crate::tools::*;
use crate::{CancelParams, CancelResult};

/// Observable browser-side effect class for a protocol method.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MethodEffect {
    /// Reads browser/session state without dispatching page input.
    PassiveRead,
    /// Dispatches temporary input such as hover probes. It must not submit,
    /// navigate, or persist page state, but it can trigger page event handlers.
    TransientInput,
    /// Drives browser/page state such as clicking, filling, navigation, tabs,
    /// or arbitrary page script.
    BrowserMutation,
    /// Control-plane/session lifecycle operation. These are deliberately not
    /// gated by the pending browser-action interrupt path.
    ControlPlane,
}

/// The method catalog is the only list of wire methods and their payloads.
/// Adding a method requires an owner, effect classification, action-metadata
/// composition flag, both payload types, and an explicit list of feature
/// requirements.
macro_rules! methods {
    ($($variant:ident => ($wire:literal, $owner:ident, $effect:ident, $action_metadata:literal, $params:ty, $result:ty, [$($feature:ident),*])),* $(,)?) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
        pub enum Method {
            $(#[serde(rename = $wire)] $variant,)*
        }

        impl Method {
            pub const ALL: &'static [Method] = &[$(Self::$variant,)*];

            pub const fn wire_name(&self) -> &'static str {
                match self { $(Self::$variant => $wire,)* }
            }

            pub const fn owner(&self) -> MethodOwner {
                match self { $(Self::$variant => MethodOwner::$owner,)* }
            }

            /// **Judgment calls** (read these before adding new variants):
            ///
            /// * `tool.evaluate` is classified as browser-mutating because the
            ///   daemon cannot statically distinguish a `document.title`
            ///   read from a `form.submit()` write.
            /// * `tool.observe` is classified as transient input: its bounded
            ///   hover probes do not commit browser state, but they dispatch real
            ///   page input events and therefore must be gated like automation.
            /// * `tool.wait_*` are classified as read-only: they do not
            ///   initiate any browser action; they observe state only.
            /// * `session.*` and `tool.session_*` are NOT gated. Blocking
            ///   `session.stop` would prevent the agent from gracefully
            ///   tearing down after observing the user's interrupt.
            /// * `cancel`, `tool.dialog_dismiss`, and `tool.operation_cancel` are
            ///   control-plane operations so cleanup/teardown remains available
            ///   after a user stop.
            pub const fn effect(&self) -> MethodEffect {
                match self { $(Self::$variant => MethodEffect::$effect,)* }
            }

            /// Whether the wire parameter contract merges [`ActionMetadata`]
            /// (`context_id`, `observation_id`, `depends_on`, `expect`).
            pub const fn accepts_action_metadata(&self) -> bool {
                match self { $(Self::$variant => $action_metadata,)* }
            }

            /// Whether this method belongs to the `tool.*` namespace audited and
            /// logged per session operation.
            pub const fn is_tool(&self) -> bool {
                matches!(self.wire_name().as_bytes(), [b't', b'o', b'o', b'l', b'.', ..])
            }

            pub const fn features(&self) -> &'static [Feature] {
                match self { $(Self::$variant => &[$(Feature::$feature),*],)* }
            }

            pub fn describe(&self, generator: &mut schemars::SchemaGenerator) -> MethodDescriptor {
                match self {
                    $(Self::$variant => MethodDescriptor::new::<$params, $result>(
                        $wire,
                        MethodOwner::$owner,
                        MethodEffect::$effect,
                        $action_metadata,
                        self.features(),
                        generator,
                    ),)*
                }
            }
        }
    };
}

methods! {
    ToolCooperate => ("tool.cooperate", Extension, ControlPlane, false, CooperateParams, serde_json::Value, [TargetControl]),
    LocalAuthPair => ("local_auth.pair", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    LocalAuthDevices => ("local_auth.devices", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    LocalAuthRevoke => ("local_auth.revoke", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    LocalAuthRotate => ("local_auth.rotate", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    LocalAuthSetMode => ("local_auth.set_mode", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    AuditRequest => ("audit.request", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    LedgerRequest => ("ledger.request", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    SystemHandshake => ("system.handshake", Daemon, ControlPlane, false, HandshakeRequest, HandshakeResponse, []),
    SystemPing => ("system.ping", Daemon, ControlPlane, false, PingParams, PingResult, []),
    SystemStatus => ("system.status", Daemon, ControlPlane, false, StatusParams, StatusResult, []),
    SessionStart => ("session.start", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, [IncognitoSessions]),
    SessionStartTracked => ("session.start_tracked", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, [IncognitoSessions]),
    SessionRequest => ("session.request", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    SessionStop => ("session.stop", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    SessionStopAll => ("session.stop_all", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    SessionList => ("session.list", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    SessionRunLog => ("session.run_log", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    BrowserList => ("browser.list", Daemon, ControlPlane, false, BrowserListParams, serde_json::Value, []),
    ToolSessionStart => ("tool.session_start", Extension, ControlPlane, false, SessionStartParams, SessionStartResult, [IncognitoSessions]),
    ToolSessionStop => ("tool.session_stop", Extension, ControlPlane, false, SessionStopParams, SessionStopOutcome, []),
    ToolWindowResize => ("tool.window_resize", Extension, BrowserMutation, true, WindowResizeParams, WindowResizeResult, [ActionConditions]),
    ToolEmulate => ("tool.emulate", Extension, BrowserMutation, true, EmulateParams, EmulateResult, [ActionConditions]),
    ToolTabList => ("tool.tab_list", Extension, PassiveRead, false, TabListParams, TabListResult, []),
    ToolTabCreate => ("tool.tab_create", Extension, BrowserMutation, false, TabCreateParams, TabCreateResult, []),
    ToolTabClose => ("tool.tab_close", Extension, BrowserMutation, true, TabCloseParams, TabCloseResult, [ActionConditions]),
    ToolTabBorrow => ("tool.tab_borrow", Extension, BrowserMutation, false, TabBorrowParams, TabBorrowResult, [BorrowConfirmationTimeout]),
    ToolTabReturn => ("tool.tab_return", Extension, BrowserMutation, false, TabReturnParams, TabReturnResult, []),
    ToolTabSelect => ("tool.tab_select", Extension, BrowserMutation, false, TabSelectParams, TabSelectResult, []),
    ToolNavigate => ("tool.navigate", Extension, BrowserMutation, true, NavigateParams, NavigateResult, [ActionConditions]),
    ToolNavigateBack => ("tool.navigate_back", Extension, BrowserMutation, true, NavigateBackParams, NavigateBackResult, [ActionConditions]),
    ToolNavigateForward => ("tool.navigate_forward", Extension, BrowserMutation, true, NavigateForwardParams, NavigateForwardResult, [ActionConditions]),
    ToolReload => ("tool.reload", Extension, BrowserMutation, true, ReloadParams, ReloadResult, [ActionConditions]),
    ToolClick => ("tool.click", Extension, BrowserMutation, true, ClickParams, ClickResult, [ActionConditions]),
    ToolHover => ("tool.hover", Extension, TransientInput, true, HoverParams, HoverResult, [ActionConditions]),
    ToolDrag => ("tool.drag", Extension, BrowserMutation, true, DragParams, DragResult, [ClickMoveClick, ActionConditions]),
    ToolWheel => ("tool.wheel", Extension, BrowserMutation, true, WheelParams, WheelResult, [ActionConditions]),
    ToolScrollTo => ("tool.scroll_to", Extension, BrowserMutation, true, ScrollToParams, ScrollToResult, [ActionConditions]),
    ToolFocus => ("tool.focus", Extension, BrowserMutation, true, FocusParams, FocusResult, [ActionConditions]),
    ToolBlur => ("tool.blur", Extension, BrowserMutation, true, BlurParams, BlurResult, [ActionConditions]),
    ToolFill => ("tool.fill", Extension, BrowserMutation, true, FillParams, FillResult, [ActionConditions]),
    ToolPress => ("tool.press", Extension, BrowserMutation, true, PressParams, PressResult, [ActionConditions]),
    ToolSelect => ("tool.select", Extension, BrowserMutation, true, SelectParams, SelectResult, [ActionConditions]),
    ToolUpload => ("tool.upload", Extension, BrowserMutation, true, UploadParams, UploadResult, [ActionConditions]),
    ToolDownload => ("tool.download", Extension, BrowserMutation, true, DownloadParams, DownloadResult, [ActionConditions]),
    ToolSnapshot => ("tool.snapshot", Extension, PassiveRead, false, SnapshotParams, SnapshotResult, []),
    ToolObserve => ("tool.observe", Extension, TransientInput, true, ObserveParams, ObserveResult, [ActionConditions]),
    ToolGetHtml => ("tool.get_html", Extension, PassiveRead, false, GetHtmlParams, GetHtmlResult, []),
    ToolRead => ("tool.read", Extension, PassiveRead, false, ReadParams, ReadResult, [DomRead]),
    ToolExtract => ("tool.extract", Extension, PassiveRead, false, ExtractParams, ExtractResult, []),
    ToolScreenshot => ("tool.screenshot", Extension, PassiveRead, false, ScreenshotParams, ScreenshotResult, []),
    ToolScreenshotFullPage => ("tool.screenshot_full_page", Extension, TransientInput, true, ScreenshotFullPageParams, ScreenshotFullPageResult, [ActionConditions]),
    ToolScreenshotRead => ("tool.screenshot_read", Extension, PassiveRead, false, ScreenshotReadParams, ScreenshotReadResult, []),
    ToolScreenshotRelease => ("tool.screenshot_release", Extension, ControlPlane, false, ScreenshotReleaseParams, ScreenshotReleaseResult, []),
    ToolConsole => ("tool.console", Extension, PassiveRead, false, ConsoleParams, ConsoleResult, []),
    ToolDebug => ("tool.debug", Extension, ControlPlane, true, DebugParams, DebugResult, [ActionConditions]),
    ToolNetwork => ("tool.network", Extension, PassiveRead, false, NetworkParams, NetworkResult, []),
    ToolEvaluate => ("tool.evaluate", Extension, BrowserMutation, true, EvaluateParams, EvaluateResult, [UnverifiedScript, ActionConditions]),
    ToolDialogStatus => ("tool.dialog_status", Extension, PassiveRead, false, DialogStatusParams, DialogStatusResult, [DialogControl]),
    ToolDialogAccept => ("tool.dialog_accept", Extension, BrowserMutation, false, DialogHandleParams, DialogHandleResult, [DialogControl]),
    ToolDialogDismiss => ("tool.dialog_dismiss", Extension, ControlPlane, false, DialogHandleParams, DialogHandleResult, [DialogControl]),
    ToolOperationAwait => ("tool.operation_await", Daemon, PassiveRead, false, OperationParams, serde_json::Value, [DialogControl]),
    ToolOperationCancel => ("tool.operation_cancel", Daemon, ControlPlane, false, OperationParams, CancelResult, [DialogControl]),
    ToolWaitForNavigation => ("tool.wait_for_navigation", Extension, PassiveRead, false, WaitForNavigationParams, WaitForNavigationResult, []),
    ToolWaitForElement => ("tool.wait_for_element", Extension, PassiveRead, false, WaitForElementParams, WaitForElementResult, []),
    ToolWaitMs => ("tool.wait_ms", Daemon, PassiveRead, false, WaitMsParams, WaitMsResult, []),
    ToolRequestHelp => ("tool.request_help", Extension, PassiveRead, false, RequestHelpParams, RequestHelpResult, [InteractionPolicy]),
    ToolRecordStart => ("tool.record_start", Extension, BrowserMutation, false, RecordStartParams, RecordStartResult, []),
    ToolRecordStop => ("tool.record_stop", Extension, PassiveRead, false, RecordStopParams, RecordStopResult, []),
    ToolRecordAwait => ("tool.record_await", Extension, PassiveRead, false, RecordAwaitParams, RecordAwaitResult, []),
    ToolVideo => ("tool.video", Extension, ControlPlane, false, VideoParams, VideoResult, []),
    TransferBegin => ("transfer.begin", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    TransferChunk => ("transfer.chunk", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    TransferFinish => ("transfer.finish", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    TransferRead => ("transfer.read", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    TransferRelease => ("transfer.release", Daemon, ControlPlane, false, serde_json::Value, serde_json::Value, []),
    Cancel => ("cancel", Shared, ControlPlane, false, CancelParams, CancelResult, []),
}

impl Method {
    /// Debug reads/teardown remain available after interruption, while explicit
    /// network interventions and replay are gated like other browser writes.
    pub fn requires_interrupt_gate_with_params(&self, params: &serde_json::Value) -> bool {
        let effect = if matches!(self, Method::ToolDebug) {
            params
                .get("action")
                .cloned()
                .and_then(|action| serde_json::from_value::<DebugAction>(action).ok())
                .map(|action| action.effect())
                .unwrap_or(self.effect())
        } else {
            self.effect()
        };
        (matches!(self, Method::ToolVideo)
            && params.get("action").and_then(|value| value.as_str()) == Some("start"))
            || matches!(
                effect,
                MethodEffect::BrowserMutation | MethodEffect::TransientInput
            )
    }

    /// Whether this RPC drives browser/page state in the traditional sense.
    pub fn is_mutating(&self) -> bool {
        self.effect() == MethodEffect::BrowserMutation
    }

    /// Whether a pending user interrupt should reject this method.
    pub fn requires_interrupt_gate(&self) -> bool {
        matches!(
            self.effect(),
            MethodEffect::TransientInput | MethodEffect::BrowserMutation
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CancelParams, CancelResult};
    use serde_json::json;

    #[test]
    fn action_metadata_methods_always_declare_action_conditions_feature() {
        for method in Method::ALL {
            assert_eq!(
                method.accepts_action_metadata(),
                method.features().contains(&Feature::ActionConditions),
                "{} must keep accepts_action_metadata and Feature::ActionConditions in sync",
                method.wire_name(),
            );
            assert_eq!(
                method.is_tool(),
                method.wire_name().starts_with("tool."),
                "{} is_tool mismatch",
                method.wire_name(),
            );
        }
    }

    #[test]
    fn video_start_respects_interrupts_but_teardown_and_artifact_reads_remain_available() {
        assert!(
            super::Method::ToolVideo
                .requires_interrupt_gate_with_params(&serde_json::json!({"action":"start"}))
        );
        for action in [
            "capabilities",
            "list",
            "status",
            "stop",
            "read",
            "exported",
            "discard",
        ] {
            assert!(
                !super::Method::ToolVideo
                    .requires_interrupt_gate_with_params(&serde_json::json!({"action": action}))
            );
        }
    }

    #[test]
    fn cancel_method_round_trips() {
        let method: Method = serde_json::from_value(json!("cancel")).unwrap();
        assert_eq!(method, Method::Cancel);
        assert_eq!(serde_json::to_value(method).unwrap(), json!("cancel"));
    }

    #[test]
    fn console_method_round_trips() {
        let method: Method = serde_json::from_value(json!("tool.console")).unwrap();
        assert_eq!(method, Method::ToolConsole);
        assert_eq!(serde_json::to_value(method).unwrap(), json!("tool.console"));
    }

    #[test]
    fn network_method_round_trips() {
        let method: Method = serde_json::from_value(json!("tool.network")).unwrap();
        assert_eq!(method, Method::ToolNetwork);
        assert_eq!(serde_json::to_value(method).unwrap(), json!("tool.network"));
    }

    #[test]
    fn emulate_method_round_trips() {
        let method: Method = serde_json::from_value(json!("tool.emulate")).unwrap();
        assert_eq!(method, Method::ToolEmulate);
        assert_eq!(serde_json::to_value(method).unwrap(), json!("tool.emulate"));
    }

    #[test]
    fn cancel_params_and_result_round_trip() {
        let params: CancelParams = serde_json::from_value(json!({ "rpc_id": "wait-1" })).unwrap();
        assert_eq!(params.rpc_id, "wait-1");
        let result = CancelResult { cancelled: true };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({ "cancelled": true })
        );
    }

    #[test]
    fn full_page_capture_is_input_but_export_reads_are_not() {
        assert!(Method::ToolScreenshotFullPage.requires_interrupt_gate());
        assert_eq!(
            Method::ToolScreenshotFullPage.effect(),
            MethodEffect::TransientInput
        );
        assert!(!Method::ToolScreenshot.requires_interrupt_gate());
        assert!(!Method::ToolScreenshotRead.requires_interrupt_gate());
        assert!(!Method::ToolScreenshotRelease.requires_interrupt_gate());
    }

    #[test]
    fn debug_network_writes_respect_interrupts_without_blocking_teardown() {
        for action in ["rule_add", "rule_enable", "replay"] {
            assert!(
                Method::ToolDebug
                    .requires_interrupt_gate_with_params(&serde_json::json!({"action":action}))
            );
        }
        for action in [
            "request",
            "rules",
            "export",
            "stop",
            "rule_disable",
            "rule_remove",
        ] {
            assert!(
                !Method::ToolDebug
                    .requires_interrupt_gate_with_params(&serde_json::json!({"action":action}))
            );
        }
    }

    #[test]
    fn is_mutating_classifies_read_only_tools_as_non_mutating() {
        assert!(!Method::ToolTabList.is_mutating());
        assert!(!Method::ToolSnapshot.is_mutating());
        assert!(!Method::ToolHover.is_mutating());
        assert!(!Method::ToolObserve.is_mutating());
        assert!(!Method::ToolGetHtml.is_mutating());
        assert!(!Method::ToolRead.is_mutating());
        assert_eq!(Method::ToolExtract.effect(), MethodEffect::PassiveRead);
        assert!(!Method::ToolExtract.is_mutating());
        assert!(!Method::ToolScreenshot.is_mutating());
        assert!(!Method::ToolConsole.is_mutating());
        assert!(!Method::ToolNetwork.is_mutating());
        assert!(!Method::ToolDialogStatus.is_mutating());
        assert!(!Method::ToolDialogDismiss.is_mutating());
        assert!(!Method::ToolOperationAwait.is_mutating());
        assert!(!Method::ToolOperationCancel.is_mutating());
        assert!(!Method::ToolWaitForNavigation.is_mutating());
        assert!(!Method::ToolWaitForElement.is_mutating());
        assert!(!Method::ToolWaitMs.is_mutating());
    }

    #[test]
    fn is_mutating_classifies_mutating_tools_as_mutating() {
        assert!(Method::ToolTabCreate.is_mutating());
        assert!(Method::ToolTabClose.is_mutating());
        assert!(Method::ToolTabBorrow.is_mutating());
        assert!(Method::ToolTabReturn.is_mutating());
        assert!(Method::ToolTabSelect.is_mutating());
        assert!(Method::ToolNavigate.is_mutating());
        assert!(Method::ToolNavigateBack.is_mutating());
        assert!(Method::ToolNavigateForward.is_mutating());
        assert!(Method::ToolReload.is_mutating());
        assert!(Method::ToolClick.is_mutating());
        assert!(Method::ToolDrag.is_mutating());
        assert!(Method::ToolWheel.is_mutating());
        assert!(Method::ToolScrollTo.is_mutating());
        assert!(Method::ToolFocus.is_mutating());
        assert!(Method::ToolBlur.is_mutating());
        assert!(Method::ToolFill.is_mutating());
        assert!(Method::ToolPress.is_mutating());
        assert!(Method::ToolSelect.is_mutating());
        assert!(Method::ToolEvaluate.is_mutating());
        assert!(Method::ToolDialogAccept.is_mutating());
        assert!(Method::ToolRecordStart.is_mutating());
        assert!(Method::ToolWindowResize.is_mutating());
        assert!(Method::ToolEmulate.is_mutating());
    }

    #[test]
    fn is_mutating_classifies_record_stop_await_as_non_mutating() {
        assert!(!Method::ToolRecordStop.is_mutating());
        assert!(!Method::ToolRecordAwait.is_mutating());
    }

    #[test]
    fn is_mutating_classifies_session_lifecycle_as_non_mutating() {
        assert!(!Method::SessionStart.is_mutating());
        assert!(!Method::SessionStop.is_mutating());
        assert!(!Method::SessionStopAll.is_mutating());
        assert!(!Method::SessionList.is_mutating());
        assert!(!Method::SessionRunLog.is_mutating());
        assert!(!Method::ToolSessionStart.is_mutating());
        assert!(!Method::ToolSessionStop.is_mutating());
    }

    #[test]
    fn is_mutating_classifies_system_methods_as_non_mutating() {
        assert!(!Method::SystemHandshake.is_mutating());
        assert!(!Method::SystemPing.is_mutating());
        assert!(!Method::SystemStatus.is_mutating());
        assert!(!Method::BrowserList.is_mutating());
        assert!(!Method::Cancel.is_mutating());
    }

    #[test]
    fn effect_classifies_observe_as_transient_input() {
        assert_eq!(Method::ToolSnapshot.effect(), MethodEffect::PassiveRead);
        assert_eq!(Method::ToolHover.effect(), MethodEffect::TransientInput);
        assert_eq!(Method::ToolObserve.effect(), MethodEffect::TransientInput);
        assert_eq!(Method::ToolClick.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::ToolDrag.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::ToolWheel.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::ToolScrollTo.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::ToolFocus.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::ToolBlur.effect(), MethodEffect::BrowserMutation);
        assert_eq!(Method::Cancel.effect(), MethodEffect::ControlPlane);
    }

    #[test]
    fn interrupt_gate_includes_transient_input() {
        assert!(!Method::ToolSnapshot.requires_interrupt_gate());
        assert!(Method::ToolHover.requires_interrupt_gate());
        assert!(Method::ToolObserve.requires_interrupt_gate());
        assert!(Method::ToolClick.requires_interrupt_gate());
        assert!(Method::ToolWheel.requires_interrupt_gate());
        assert!(Method::ToolScrollTo.requires_interrupt_gate());
        assert!(Method::ToolFocus.requires_interrupt_gate());
        assert!(Method::ToolBlur.requires_interrupt_gate());
        assert!(!Method::Cancel.requires_interrupt_gate());
    }
}
