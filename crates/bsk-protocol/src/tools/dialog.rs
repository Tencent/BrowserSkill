//! Shared JavaScript dialog observability types.
//!
//! Mirrors CDP `Page.javascriptDialogOpening` / `Page.handleJavaScriptDialog`.
//! Handled dialogs are included in tool results. Pending decisions have their
//! own status/control API and are also reported in `dialog_pending` RPC errors.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const DIALOG_CONTROL_PROTOCOL: &str = "1.4";

pub fn supports_dialog_control(protocol: &str) -> bool {
    crate::system::compare_protocol(protocol, "2.0") == Some(std::cmp::Ordering::Less)
        && matches!(
            crate::system::compare_protocol(protocol, DIALOG_CONTROL_PROTOCOL),
            Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
        )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DialogAction {
    Status,
    Accept,
    Dismiss,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DialogParams {
    pub session_id: String,
    pub action: DialogAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialog_id: Option<String>,
}

/// Live decision state. Kept separate from the existing handled-dialog history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PendingJavaScriptDialog {
    pub id: String,
    pub tab_id: i64,
    #[serde(rename = "type")]
    pub dialog_type: JavaScriptDialogType,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_browser_handler: Option<bool>,
    pub sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DialogResult {
    pub tab_id: i64,
    pub pending: Option<PendingJavaScriptDialog>,
    pub execution_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handled: Option<JavaScriptDialogInfo>,
}

/// Native JS dialog kind reported by CDP.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum JavaScriptDialogType {
    Alert,
    Confirm,
    Prompt,
    #[serde(rename = "beforeunload")]
    BeforeUnload,
}

/// How the extension resolved the dialog so CDP could continue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum JavaScriptDialogHandledAction {
    Accepted,
    Dismissed,
}

impl JavaScriptDialogType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Alert => "alert",
            Self::Confirm => "confirm",
            Self::Prompt => "prompt",
            Self::BeforeUnload => "beforeunload",
        }
    }
}

impl JavaScriptDialogHandledAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Dismissed => "dismissed",
        }
    }
}

/// One observed + handled JavaScript dialog during a tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct JavaScriptDialogInfo {
    pub tab_id: i64,
    #[serde(rename = "type")]
    pub dialog_type: JavaScriptDialogType,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_browser_handler: Option<bool>,
    pub handled: JavaScriptDialogHandledAction,
    /// Monotonic per-tab sequence for ordering within a session.
    pub sequence: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dialog_wire_contract_distinguishes_pending_history_and_empty_text() {
        let params: DialogParams = serde_json::from_value(json!({
            "session_id":"test", "action":"accept", "prompt_text":""
        }))
        .unwrap();
        assert_eq!(params.prompt_text.as_deref(), Some(""));
        let status: DialogResult = serde_json::from_value(json!({
            "tab_id":7, "pending":{"id":"d1", "tab_id":7, "type":"prompt", "message":"Name?", "sequence":1},
            "execution_pending":true
        })).unwrap();
        assert!(status.handled.is_none());
        assert_eq!(
            status.pending.unwrap().dialog_type,
            JavaScriptDialogType::Prompt
        );
        for version in ["1.0", "1.3", "2.0", "invalid"] {
            assert!(!supports_dialog_control(version));
        }
        assert!(supports_dialog_control("1.4"));
    }

    #[test]
    fn dialog_info_round_trips() {
        let info = JavaScriptDialogInfo {
            tab_id: 4,
            dialog_type: JavaScriptDialogType::Alert,
            message: "hello".into(),
            url: Some("https://example.com/".into()),
            default_prompt: None,
            has_browser_handler: Some(false),
            handled: JavaScriptDialogHandledAction::Accepted,
            sequence: 1,
        };
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["type"], json!("alert"));
        assert_eq!(v["handled"], json!("accepted"));
        let round: JavaScriptDialogInfo = serde_json::from_value(v).unwrap();
        assert_eq!(round, info);
    }

    #[test]
    fn beforeunload_serialises_as_beforeunload() {
        let v = serde_json::to_value(JavaScriptDialogType::BeforeUnload).unwrap();
        assert_eq!(v, json!("beforeunload"));
    }
}
