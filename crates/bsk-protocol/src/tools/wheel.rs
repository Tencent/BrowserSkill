//! Native mouse-wheel input primitive (`tool.wheel`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{JavaScriptDialogInfo, KeyModifier};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WheelParams {
    pub session_id: String,
    /// Optional `@e<N>` ref used as the wheel event's hit-test point.
    /// Mutually exclusive with `selector`. When neither is supplied,
    /// the event is dispatched at the viewport centre.
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
    /// Horizontal wheel distance in CSS pixels. Positive values move right.
    #[serde(default)]
    pub delta_x: f64,
    /// Vertical wheel distance in CSS pixels. Positive values move down.
    pub delta_y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WheelResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Top-level viewport coordinates where the real wheel event was dispatched.
    pub x: f64,
    pub y: f64,
    pub delta_x: f64,
    pub delta_y: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_accept_missing_horizontal_delta_and_serialise_ref() {
        let value = serde_json::json!({
            "session_id": "abcd",
            "ref": "@e3",
            "delta_y": 600.0
        });
        let params: WheelParams = serde_json::from_value(value).unwrap();
        assert_eq!(params.delta_x, 0.0);
        assert_eq!(params.ref_.as_deref(), Some("@e3"));

        let round = serde_json::to_value(params).unwrap();
        assert_eq!(round.get("ref").and_then(|v| v.as_str()), Some("@e3"));
        assert!(round.get("ref_").is_none());
    }
}
