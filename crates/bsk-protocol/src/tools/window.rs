//! Agent Window management tools (`tool.window_*`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::ActionExpectation;

// ----- window_resize -----

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WindowResizeParams {
    pub session_id: String,
    /// Optional target tab bound by cooperation before resizing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// New Agent Window outer width in CSS pixels (100..=7680).
    pub width: u32,
    /// New Agent Window outer height in CSS pixels (100..=7680).
    pub height: u32,
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
#[serde(rename_all = "snake_case")]
pub enum WindowResizeWarning {
    SizeConstrained,
    ViewportDidNotFollow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WindowResizeSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WindowResizeResult {
    pub window_id: i64,
    /// Actual outer window size after the browser applies platform constraints.
    pub width: u32,
    pub height: u32,
    /// Requested outer size, present when the browser constrained the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested: Option<WindowResizeSize>,
    /// The target tab's actual CSS layout viewport when it could be measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_viewport: Option<WindowResizeSize>,
    /// Non-fatal differences between the requested size and the observed result.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<WindowResizeWarning>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn window_resize_params_round_trip() {
        let params: WindowResizeParams = serde_json::from_value(json!({
            "session_id": "ab12",
            "width": 1280,
            "height": 800,
        }))
        .unwrap();
        assert_eq!(params.session_id, "ab12");
        assert_eq!(params.width, 1280);
        assert_eq!(params.height, 800);
        let encoded = serde_json::to_value(params).unwrap();
        assert_eq!(
            encoded,
            json!({ "session_id": "ab12", "width": 1280, "height": 800 })
        );
    }

    #[test]
    fn window_resize_result_round_trip() {
        let result: WindowResizeResult = serde_json::from_value(json!({
            "window_id": 42,
            "width": 1280,
            "height": 800,
        }))
        .unwrap();
        assert_eq!(result.window_id, 42);
        assert_eq!(result.requested, None);
        assert_eq!(result.actual_viewport, None);
        assert!(result.warnings.is_empty());
        let encoded = serde_json::to_value(result).unwrap();
        assert_eq!(
            encoded,
            json!({ "window_id": 42, "width": 1280, "height": 800 })
        );
    }

    #[test]
    fn window_resize_result_reports_constrained_bounds_and_viewport() {
        let result = WindowResizeResult {
            window_id: 42,
            width: 1200,
            height: 875,
            requested: Some(WindowResizeSize {
                width: 1200,
                height: 900,
            }),
            actual_viewport: Some(WindowResizeSize {
                width: 1185,
                height: 523,
            }),
            warnings: vec![
                WindowResizeWarning::SizeConstrained,
                WindowResizeWarning::ViewportDidNotFollow,
            ],
        };

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({
                "window_id": 42,
                "width": 1200,
                "height": 875,
                "requested": { "width": 1200, "height": 900 },
                "actual_viewport": { "width": 1185, "height": 523 },
                "warnings": ["size_constrained", "viewport_did_not_follow"]
            })
        );
    }
}
