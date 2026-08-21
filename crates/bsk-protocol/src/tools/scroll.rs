//! Element scrolling primitive (`tool.scroll_to`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::JavaScriptDialogInfo;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ScrollToParams {
    pub session_id: String,
    /// Optional `@e<N>` ref allocated by the last observation.
    /// Mutually exclusive with `selector`.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ScrollToResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Visible target bounds in top-level viewport CSS pixels.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_serialise_ref_field_name() {
        let params = ScrollToParams {
            session_id: "abcd".into(),
            ref_: Some("@e3".into()),
            selector: None,
            tab_id: Some(42),
            timeout_ms: Some(5_000),
        };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value.get("ref").and_then(|v| v.as_str()), Some("@e3"));
        assert!(value.get("ref_").is_none());
        let round: ScrollToParams = serde_json::from_value(value).unwrap();
        assert_eq!(round, params);
    }
}
