//! Native mouse-wheel input primitive (`tool.wheel`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{ActionExpectation, JavaScriptDialogInfo, KeyModifier};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
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
    /// Native CDP wheel input in CSS pixels. Positive X means right. Not measured displacement.
    #[serde(default)]
    pub delta_x: f64,
    /// Native CDP wheel input in CSS pixels. Positive Y means down. Defaults to zero.
    #[serde(default)]
    pub delta_y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
    /// Context actually returned by sync. Reusable for target-policy DOM actions;
    /// strict policy consumes it after one action. Never fill it from cached state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub context_id: Option<String>,
    /// Sync's single-use baseline for untargeted/visual actions under target policy,
    /// including untargeted keys and displacement-only drags. Drags with a
    /// target ref/selector need only context_id. A script needs it only when it
    /// states no expect facts; passing both checks the whole page as well.
    /// Strict-policy drag instead accepts its legacy ref-map observation token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
    /// Strict policy only: observed decision regions. Target policy requires exact
    /// business facts in expect; regions cannot be translated to facts automatically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Vec<String>", length(max = 16))]
    pub depends_on: Option<Vec<String>>,
    /// Literal conditions checked before input. Selectors search the main document;
    /// use observed refs for iframe/shadow-root targets. Text includes all whitespace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Vec<ActionExpectation>", length(max = 16))]
    pub expect: Option<Vec<ActionExpectation>>,
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
    /// Requested deltas, not measured scroll distance or completion.
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
    #[test]
    fn params_accept_horizontal_only_input() {
        let params: WheelParams = serde_json::from_value(serde_json::json!({
            "session_id": "abcd", "delta_x": -120.5
        }))
        .unwrap();
        assert_eq!((params.delta_x, params.delta_y), (-120.5, 0.0));
    }
}
