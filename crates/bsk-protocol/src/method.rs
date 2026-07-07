//! Namespaced RPC methods (§4.3).

use serde::{Deserialize, Serialize};

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
    #[serde(rename = "tool.fill")]
    ToolFill,
    #[serde(rename = "tool.press")]
    ToolPress,
    #[serde(rename = "tool.select")]
    ToolSelect,
    #[serde(rename = "tool.snapshot")]
    ToolSnapshot,
    #[serde(rename = "tool.get_html")]
    ToolGetHtml,
    #[serde(rename = "tool.screenshot")]
    ToolScreenshot,
    #[serde(rename = "tool.console")]
    ToolConsole,
    #[serde(rename = "tool.evaluate")]
    ToolEvaluate,
    #[serde(rename = "tool.wait_for_navigation")]
    ToolWaitForNavigation,
    #[serde(rename = "tool.wait_ms")]
    ToolWaitMs,
    #[serde(rename = "tool.request_help")]
    ToolRequestHelp,

    #[serde(rename = "cancel")]
    Cancel,
}

impl Method {
    /// Whether this RPC may modify browser state.
    ///
    /// Used by the daemon's pending-interrupt machinery: when the
    /// user has clicked the agent-window mask's stop button, the
    /// next *mutating* tool call for that session is rejected with
    /// `ErrorCode::UserAborted`. Read-only tools and session-
    /// lifecycle RPCs pass through transparently.
    ///
    /// **Compile-time enforcement.** The match below is exhaustive
    /// (no `_ =>` fallthrough). Adding a new `Method` variant is a
    /// compile error here, so classification cannot silently be
    /// skipped — the author has to make a deliberate choice.
    ///
    /// **Judgment calls** (read these before adding new variants):
    ///
    /// * `tool.evaluate` is classified as mutating because the
    ///   daemon cannot statically distinguish a `document.title`
    ///   read from a `form.submit()` write.
    /// * `tool.wait_*` are classified as read-only: they do not
    ///   initiate any browser action; they observe state only.
    /// * `session.*` and `tool.session_*` are NOT gated. Blocking
    ///   `session.stop` would prevent the agent from gracefully
    ///   tearing down after observing the user's interrupt.
    /// * `cancel` is NOT gated. It's a control-plane operation
    ///   (stops another in-flight RPC), not a browser action.
    pub fn is_mutating(&self) -> bool {
        match self {
            // Mutating tool calls — gated by pending-interrupt.
            Method::ToolTabCreate
            | Method::ToolTabClose
            | Method::ToolTabBorrow
            | Method::ToolTabReturn
            | Method::ToolTabSelect
            | Method::ToolNavigate
            | Method::ToolNavigateBack
            | Method::ToolNavigateForward
            | Method::ToolReload
            | Method::ToolClick
            | Method::ToolFill
            | Method::ToolPress
            | Method::ToolSelect
            | Method::ToolEvaluate => true,

            // Read-only tool calls — transparent.
            Method::ToolTabList
            | Method::ToolSnapshot
            | Method::ToolGetHtml
            | Method::ToolScreenshot
            | Method::ToolConsole
            | Method::ToolWaitForNavigation
            | Method::ToolWaitMs
            | Method::ToolRequestHelp => false,

            // Session lifecycle — not gated.
            Method::SessionStart
            | Method::SessionStop
            | Method::SessionStopAll
            | Method::SessionList
            | Method::ToolSessionStart
            | Method::ToolSessionStop => false,

            // System / control — not gated.
            Method::SystemHandshake
            | Method::SystemPing
            | Method::SystemStatus
            | Method::BrowserList
            | Method::Cancel => false,
        }
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
        assert!(!Method::ToolGetHtml.is_mutating());
        assert!(!Method::ToolScreenshot.is_mutating());
        assert!(!Method::ToolConsole.is_mutating());
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
}
