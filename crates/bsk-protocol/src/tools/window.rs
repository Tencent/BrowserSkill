//! Agent Window management tools (`tool.window_*`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// ----- window_resize -----

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WindowResizeParams {
    pub session_id: String,
    /// New Agent Window outer width in CSS pixels (100..=7680).
    pub width: u32,
    /// New Agent Window outer height in CSS pixels (100..=7680).
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WindowResizeResult {
    pub window_id: i64,
    pub width: u32,
    pub height: u32,
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
        let encoded = serde_json::to_value(result).unwrap();
        assert_eq!(
            encoded,
            json!({ "window_id": 42, "width": 1280, "height": 800 })
        );
    }
}
