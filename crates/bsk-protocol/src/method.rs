//! Namespaced RPC methods (§4.3).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::catalog::{MethodDescriptor, MethodOwner};
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
/// Adding a method requires an owner, an effect classification and both payload types.
macro_rules! methods {
    ($($variant:ident => ($wire:literal, $owner:ident, $effect:ident, $params:ty, $result:ty)),* $(,)?) => {
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

            pub const fn effect(&self) -> MethodEffect {
                match self { $(Self::$variant => MethodEffect::$effect,)* }
            }

            pub fn describe(&self, generator: &mut schemars::SchemaGenerator) -> MethodDescriptor {
                match self {
                    $(Self::$variant => MethodDescriptor::new::<$params, $result>(
                        $wire, MethodOwner::$owner, MethodEffect::$effect, generator,
                    ),)*
                }
            }
        }
    };
}

methods! {
    AuditRequest => ("audit.request", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    SystemHandshake => ("system.handshake", Daemon, ControlPlane, HandshakeRequest, HandshakeResponse),
    SystemPing => ("system.ping", Daemon, ControlPlane, PingParams, PingResult),
    SystemStatus => ("system.status", Daemon, ControlPlane, StatusParams, StatusResult),
    SessionStart => ("session.start", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    SessionStartTracked => ("session.start_tracked", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    SessionRequest => ("session.request", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    SessionStop => ("session.stop", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    SessionStopAll => ("session.stop_all", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    SessionList => ("session.list", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    BrowserList => ("browser.list", Daemon, ControlPlane, BrowserListParams, serde_json::Value),
    ToolSessionStart => ("tool.session_start", Extension, ControlPlane, SessionStartParams, SessionStartResult),
    ToolSessionStop => ("tool.session_stop", Extension, ControlPlane, SessionStopParams, SessionStopOutcome),
    ToolWindowResize => ("tool.window_resize", Extension, BrowserMutation, WindowResizeParams, WindowResizeResult),
    ToolEmulate => ("tool.emulate", Extension, BrowserMutation, EmulateParams, EmulateResult),
    ToolTabList => ("tool.tab_list", Extension, PassiveRead, TabListParams, TabListResult),
    ToolTabCreate => ("tool.tab_create", Extension, BrowserMutation, TabCreateParams, TabCreateResult),
    ToolTabClose => ("tool.tab_close", Extension, BrowserMutation, TabCloseParams, TabCloseResult),
    ToolTabBorrow => ("tool.tab_borrow", Extension, BrowserMutation, TabBorrowParams, TabBorrowResult),
    ToolTabReturn => ("tool.tab_return", Extension, BrowserMutation, TabReturnParams, TabReturnResult),
    ToolTabSelect => ("tool.tab_select", Extension, BrowserMutation, TabSelectParams, TabSelectResult),
    ToolNavigate => ("tool.navigate", Extension, BrowserMutation, NavigateParams, NavigateResult),
    ToolNavigateBack => ("tool.navigate_back", Extension, BrowserMutation, NavigateBackParams, NavigateBackResult),
    ToolNavigateForward => ("tool.navigate_forward", Extension, BrowserMutation, NavigateForwardParams, NavigateForwardResult),
    ToolReload => ("tool.reload", Extension, BrowserMutation, ReloadParams, ReloadResult),
    ToolClick => ("tool.click", Extension, BrowserMutation, ClickParams, ClickResult),
    ToolHover => ("tool.hover", Extension, TransientInput, HoverParams, HoverResult),
    ToolWheel => ("tool.wheel", Extension, BrowserMutation, WheelParams, WheelResult),
    ToolScrollTo => ("tool.scroll_to", Extension, BrowserMutation, ScrollToParams, ScrollToResult),
    ToolFocus => ("tool.focus", Extension, BrowserMutation, FocusParams, FocusResult),
    ToolBlur => ("tool.blur", Extension, BrowserMutation, BlurParams, BlurResult),
    ToolFill => ("tool.fill", Extension, BrowserMutation, FillParams, FillResult),
    ToolPress => ("tool.press", Extension, BrowserMutation, PressParams, PressResult),
    ToolSelect => ("tool.select", Extension, BrowserMutation, SelectParams, SelectResult),
    ToolUpload => ("tool.upload", Extension, BrowserMutation, UploadParams, UploadResult),
    ToolDownload => ("tool.download", Extension, BrowserMutation, DownloadParams, DownloadResult),
    ToolSnapshot => ("tool.snapshot", Extension, PassiveRead, SnapshotParams, SnapshotResult),
    ToolObserve => ("tool.observe", Extension, TransientInput, ObserveParams, ObserveResult),
    ToolGetHtml => ("tool.get_html", Extension, PassiveRead, GetHtmlParams, GetHtmlResult),
    ToolScreenshot => ("tool.screenshot", Extension, PassiveRead, ScreenshotParams, ScreenshotResult),
    ToolScreenshotFullPage => ("tool.screenshot_full_page", Extension, TransientInput, ScreenshotFullPageParams, ScreenshotFullPageResult),
    ToolScreenshotRead => ("tool.screenshot_read", Extension, PassiveRead, ScreenshotReadParams, ScreenshotReadResult),
    ToolScreenshotRelease => ("tool.screenshot_release", Extension, ControlPlane, ScreenshotReleaseParams, ScreenshotReleaseResult),
    ToolConsole => ("tool.console", Extension, PassiveRead, ConsoleParams, ConsoleResult),
    ToolDebug => ("tool.debug", Extension, ControlPlane, DebugParams, DebugResult),
    ToolNetwork => ("tool.network", Extension, PassiveRead, NetworkParams, NetworkResult),
    ToolEvaluate => ("tool.evaluate", Extension, BrowserMutation, EvaluateParams, EvaluateResult),
    ToolWaitForNavigation => ("tool.wait_for_navigation", Extension, PassiveRead, WaitForNavigationParams, WaitForNavigationResult),
    ToolWaitMs => ("tool.wait_ms", Daemon, PassiveRead, WaitMsParams, WaitMsResult),
    ToolRequestHelp => ("tool.request_help", Extension, PassiveRead, RequestHelpParams, RequestHelpResult),
    ToolRecordStart => ("tool.record_start", Extension, BrowserMutation, RecordStartParams, RecordStartResult),
    ToolRecordStop => ("tool.record_stop", Extension, PassiveRead, RecordStopParams, RecordStopResult),
    ToolRecordAwait => ("tool.record_await", Extension, PassiveRead, RecordAwaitParams, RecordAwaitResult),
    TransferBegin => ("transfer.begin", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    TransferChunk => ("transfer.chunk", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    TransferFinish => ("transfer.finish", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    TransferRead => ("transfer.read", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    TransferRelease => ("transfer.release", Daemon, ControlPlane, serde_json::Value, serde_json::Value),
    Cancel => ("cancel", Shared, ControlPlane, CancelParams, CancelResult),
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
        matches!(
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
        assert!(!Method::ToolScreenshot.is_mutating());
        assert!(!Method::ToolConsole.is_mutating());
        assert!(!Method::ToolNetwork.is_mutating());
        assert!(!Method::ToolWaitForNavigation.is_mutating());
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
        assert!(Method::ToolWheel.is_mutating());
        assert!(Method::ToolScrollTo.is_mutating());
        assert!(Method::ToolFocus.is_mutating());
        assert!(Method::ToolBlur.is_mutating());
        assert!(Method::ToolFill.is_mutating());
        assert!(Method::ToolPress.is_mutating());
        assert!(Method::ToolSelect.is_mutating());
        assert!(Method::ToolEvaluate.is_mutating());
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
        // Session lifecycle RPCs are not "mutating" for the purposes
        // of pending-interrupt gating — gating them would prevent the
        // agent from gracefully tearing down after observing the
        // user's interrupt.
        assert!(!Method::SessionStart.is_mutating());
        assert!(!Method::SessionStop.is_mutating());
        assert!(!Method::SessionStopAll.is_mutating());
        assert!(!Method::SessionList.is_mutating());
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
