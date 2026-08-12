//! Shared JavaScript dialog observability types.
//!
//! Mirrors CDP `Page.javascriptDialogOpening` / `Page.handleJavaScriptDialog`.
//! Dialogs are surfaced as in-band data on tool results — not RPC errors.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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
