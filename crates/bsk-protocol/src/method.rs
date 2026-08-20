//! Namespaced RPC methods (§4.3).

use serde::{Deserialize, Serialize};

/// Observable browser-side effect class for a protocol method.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// Namespaced method string (`system.handshake`, `tool.tab_list`, …).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Method {
    #[serde(rename = "system.handshake")]
    SystemHandshake,
    #[serde(rename = "system.ping")]
    SystemPing,
    #[serde(rename = "system.status")]
    SystemStatus,

    #[serde(rename = "session.start")]
    SessionStart,
    #[serde(rename = "session.stop")]
    SessionStop,
    #[serde(rename = "session.stop_all")]
    SessionStopAll,
    #[serde(rename = "session.list")]
    SessionList,

    #[serde(rename = "browser.list")]
    BrowserList,

    #[serde(rename = "tool.session_start")]
    ToolSessionStart,
    #[serde(rename = "tool.session_stop")]
    ToolSessionStop,
    #[serde(rename = "tool.window_resize")]
    ToolWindowResize,
    #[serde(rename = "tool.emulate")]
    ToolEmulate,
    #[serde(rename = "tool.tab_list")]
    ToolTabList,
    #[serde(rename = "tool.tab_create")]
    ToolTabCreate,
    #[serde(rename = "tool.tab_close")]
    ToolTabClose,
    #[serde(rename = "tool.tab_borrow")]
    ToolTabBorrow,
    #[serde(rename = "tool.tab_return")]
    ToolTabReturn,
    #[serde(rename = "tool.tab_select")]
    ToolTabSelect,
    #[serde(rename = "tool.navigate")]
    ToolNavigate,
    #[serde(rename = "tool.navigate_back")]
    ToolNavigateBack,
    #[serde(rename = "tool.navigate_forward")]
    ToolNavigateForward,
    #[serde(rename = "tool.reload")]
    ToolReload,
    #[serde(rename = "tool.click")]
    ToolClick,
    #[serde(rename = "tool.hover")]
    ToolHover,
    #[serde(rename = "tool.fill")]
    ToolFill,
    #[serde(rename = "tool.press")]
    ToolPress,
    #[serde(rename = "tool.select")]
    ToolSelect,
    #[serde(rename = "tool.upload")]
    ToolUpload,
    #[serde(rename = "tool.download")]
    ToolDownload,
    #[serde(rename = "tool.snapshot")]
    ToolSnapshot,
    #[serde(rename = "tool.observe")]
    ToolObserve,
    #[serde(rename = "tool.get_html")]
    ToolGetHtml,
    #[serde(rename = "tool.screenshot")]
    ToolScreenshot,
    #[serde(rename = "tool.console")]
    ToolConsole,
    #[serde(rename = "tool.network")]
    ToolNetwork,
    #[serde(rename = "tool.evaluate")]
    ToolEvaluate,
    #[serde(rename = "tool.wait_for_navigation")]
    ToolWaitForNavigation,
    #[serde(rename = "tool.wait_ms")]
    ToolWaitMs,
    #[serde(rename = "tool.request_help")]
    ToolRequestHelp,
    #[serde(rename = "tool.record_start")]
    ToolRecordStart,
    #[serde(rename = "tool.record_stop")]
    ToolRecordStop,
    #[serde(rename = "tool.record_await")]
    ToolRecordAwait,

    #[serde(rename = "transfer.begin")]
    TransferBegin,
    #[serde(rename = "transfer.chunk")]
    TransferChunk,
    #[serde(rename = "transfer.finish")]
    TransferFinish,
    #[serde(rename = "transfer.read")]
    TransferRead,
    #[serde(rename = "transfer.release")]
    TransferRelease,

    #[serde(rename = "cancel")]
    Cancel,
}

impl Method {
    /// Browser-side effect classification for this method.
    ///
    /// Used by the daemon's pending-interrupt machinery: when the
    /// user has clicked the agent-window mask's stop button, the
    /// next tool call that dispatches browser/page input for that
    /// session is rejected with `ErrorCode::UserAborted`. Passive reads
    /// and control-plane RPCs pass through transparently.
    ///
    /// **Compile-time enforcement.** The match below is exhaustive
    /// (no `_ =>` fallthrough). Adding a new `Method` variant is a
    /// compile error here, so classification cannot silently be
    /// skipped — the author has to make a deliberate choice.
    ///
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
    /// * `cancel` is NOT gated. It's a control-plane operation
    ///   (stops another in-flight RPC), not a browser action.
    pub fn effect(&self) -> MethodEffect {
        match self {
            // Browser/page mutations — gated by pending-interrupt.
            Method::ToolTabCreate
            | Method::ToolTabClose
            | Method::ToolTabBorrow
            | Method::ToolTabReturn
            | Method::ToolTabSelect
            | Method::ToolWindowResize
            | Method::ToolEmulate
            | Method::ToolNavigate
            | Method::ToolNavigateBack
            | Method::ToolNavigateForward
            | Method::ToolReload
            | Method::ToolClick
            | Method::ToolFill
            | Method::ToolPress
            | Method::ToolSelect
            | Method::ToolUpload
            | Method::ToolDownload
            | Method::ToolEvaluate
            // May navigate via optional `url` and changes Agent Window
            // chrome; gate behind pending-interrupt like other writes.
            | Method::ToolRecordStart => MethodEffect::BrowserMutation,

            // Transient input — no committed browser action, but still page
            // input. It must be stopped by pending user interrupts.
            Method::ToolHover | Method::ToolObserve => MethodEffect::TransientInput,

            // Passive reads — transparent.
            // `record_stop` / `record_await` observe / finish a recording
            // without driving new automation gestures, so they stay
            // ungated (teardown after interrupt must still work).
            Method::ToolTabList
            | Method::ToolSnapshot
            | Method::ToolGetHtml
            | Method::ToolScreenshot
            | Method::ToolConsole
            | Method::ToolNetwork
            | Method::ToolWaitForNavigation
            | Method::ToolWaitMs
            | Method::ToolRequestHelp
            | Method::ToolRecordStop
            | Method::ToolRecordAwait => MethodEffect::PassiveRead,

            // Session lifecycle — not gated.
            Method::SessionStart
            | Method::SessionStop
            | Method::SessionStopAll
            | Method::SessionList
            | Method::ToolSessionStart
            | Method::ToolSessionStop => MethodEffect::ControlPlane,

            // System / control — not gated.
            Method::SystemHandshake
            | Method::SystemPing
            | Method::SystemStatus
            | Method::BrowserList
            | Method::TransferBegin
            | Method::TransferChunk
            | Method::TransferFinish
            | Method::TransferRead
            | Method::TransferRelease
            | Method::Cancel => MethodEffect::ControlPlane,
        }
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
        assert_eq!(Method::Cancel.effect(), MethodEffect::ControlPlane);
    }

    #[test]
    fn interrupt_gate_includes_transient_input() {
        assert!(!Method::ToolSnapshot.requires_interrupt_gate());
        assert!(Method::ToolHover.requires_interrupt_gate());
        assert!(Method::ToolObserve.requires_interrupt_gate());
        assert!(Method::ToolClick.requires_interrupt_gate());
        assert!(!Method::Cancel.requires_interrupt_gate());
    }
}
