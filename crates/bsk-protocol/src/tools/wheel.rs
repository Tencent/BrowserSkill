//! Native mouse-wheel input primitive (`tool.wheel`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{JavaScriptDialogInfo, KeyModifier};

/// Per-event weighting of the requested delta across a wheel burst.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WheelEasing {
    /// Split the requested delta evenly across the burst.
    #[default]
    Linear,
    /// Front-load the requested delta and decay the tail.
    EaseOut,
}

fn single_event() -> u32 {
    1
}

/// The underlying failure of an operation that stopped with `stopped: "error"`.
///
/// Kept separate from `stopped` so a caller reads partial progress and the cause
/// together, without mistaking the last event's error for the outcome of the
/// whole operation and replaying input that already reached the page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct WheelStopError {
    pub code: String,
    pub message: String,
}

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
    /// Native CDP wheel input in CSS pixels. Positive X means right. Not measured displacement.
    /// With `events` > 1 this is the total for the operation.
    #[serde(default)]
    pub delta_x: f64,
    /// Native CDP wheel input in CSS pixels. Positive Y means down. Defaults to zero.
    /// With `events` > 1 this is the total for the operation.
    #[serde(default)]
    pub delta_y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    /// Single deadline for the whole operation, including inter-event waits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
    /// Number of wheel events dispatched by this operation (1–200).
    #[serde(default = "single_event")]
    #[schemars(range(min = 1, max = 200))]
    pub events: u32,
    /// Milliseconds between dispatches, measured from the previous event.
    #[serde(default)]
    #[schemars(range(max = 5000))]
    pub interval_ms: u64,
    /// How the requested delta is split across the operation's events.
    #[serde(default)]
    pub easing: WheelEasing,
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
    /// With a multi-event operation these are the totals for the whole operation.
    pub delta_x: f64,
    pub delta_y: f64,
    /// Events actually dispatched. Equals the request unless `stopped` is set.
    #[serde(default = "single_event")]
    pub events: u32,
    /// Sum of the deltas actually dispatched, which a partial operation reports.
    #[serde(default)]
    pub total_delta_x: f64,
    #[serde(default)]
    pub total_delta_y: f64,
    /// Why the operation stopped before its last event: `timeout`, `cancelled` or `error`.
    /// Absent when every requested event was dispatched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<String>,
    /// The underlying failure when `stopped` is `error`, kept out of `stopped` so
    /// partial progress and its cause stay distinguishable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_error: Option<WheelStopError>,
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

    #[test]
    fn params_default_to_a_single_linear_event() {
        let params: WheelParams = serde_json::from_value(serde_json::json!({
            "session_id": "abcd", "delta_y": 600.0
        }))
        .unwrap();
        assert_eq!(params.events, 1);
        assert_eq!(params.interval_ms, 0);
        assert_eq!(params.easing, WheelEasing::Linear);
    }

    #[test]
    fn params_carry_a_burst_and_serialise_easing_as_snake_case() {
        let params: WheelParams = serde_json::from_value(serde_json::json!({
            "session_id": "abcd",
            "delta_y": 900.0,
            "events": 15,
            "interval_ms": 16,
            "easing": "ease_out"
        }))
        .unwrap();
        assert_eq!(params.events, 15);
        assert_eq!(params.interval_ms, 16);
        assert_eq!(params.easing, WheelEasing::EaseOut);

        let round = serde_json::to_value(&params).unwrap();
        assert_eq!(
            round.get("easing").and_then(|v| v.as_str()),
            Some("ease_out")
        );
    }

    #[test]
    fn result_defaults_describe_a_completed_single_event() {
        let result: WheelResult = serde_json::from_value(serde_json::json!({
            "tab_id": 7, "x": 1.0, "y": 2.0, "delta_x": 0.0, "delta_y": 120.0
        }))
        .unwrap();
        assert_eq!(result.events, 1);
        assert_eq!(result.total_delta_y, 0.0);
        assert_eq!(result.stopped, None);
    }

    #[test]
    fn result_reports_partial_progress_and_omits_absent_stop_reason() {
        let result = WheelResult {
            tab_id: 7,
            used_ref: None,
            used_selector: None,
            x: 1.0,
            y: 2.0,
            delta_x: 0.0,
            delta_y: 900.0,
            events: 4,
            total_delta_x: 0.0,
            total_delta_y: 240.0,
            stopped: Some("timeout".into()),
            stop_error: None,
            dialogs: Vec::new(),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value.get("events").and_then(|v| v.as_u64()), Some(4));
        assert_eq!(
            value.get("stopped").and_then(|v| v.as_str()),
            Some("timeout")
        );
        assert!(value.get("stop_error").is_none());

        let complete = WheelResult {
            stopped: None,
            ..result
        };
        let value = serde_json::to_value(&complete).unwrap();
        assert!(value.get("stopped").is_none());
    }

    #[test]
    fn result_keeps_progress_and_cause_separate_on_a_stopped_error() {
        let result = WheelResult {
            tab_id: 7,
            used_ref: None,
            used_selector: None,
            x: 1.0,
            y: 2.0,
            delta_x: 0.0,
            delta_y: 900.0,
            events: 2,
            total_delta_x: 0.0,
            total_delta_y: 360.0,
            stopped: Some("error".into()),
            stop_error: Some(WheelStopError {
                code: "cdp_failed".into(),
                message: "Input.dispatchMouseEvent failed".into(),
            }),
            dialogs: Vec::new(),
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["stopped"], "error");
        assert_eq!(value["events"], 2);
        assert_eq!(value["total_delta_y"], 360.0);
        assert_eq!(value["stop_error"]["code"], "cdp_failed");
        assert_eq!(
            value["stop_error"]["message"],
            "Input.dispatchMouseEvent failed"
        );
    }
}
