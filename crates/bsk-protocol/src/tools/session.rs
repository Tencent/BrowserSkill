//! Session-scoped tools (`tool.session_*`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ErrorCode;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStartParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_instance_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStartResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_window_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStopParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ReturnFailure {
    pub tab_id: i64,
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStopResult {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub returned_tab_ids: Vec<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub return_failures: Vec<ReturnFailure>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_stop_result_round_trips_auto_return_payload() {
        let result: SessionStopResult = serde_json::from_value(json!({
            "returned_tab_ids": [7, 8],
            "return_failures": [
                { "tab_id": 9, "code": "cdp_failed", "message": "move failed" }
            ]
        }))
        .unwrap();

        assert_eq!(result.returned_tab_ids, vec![7, 8]);
        assert_eq!(result.return_failures[0].tab_id, 9);
        assert_eq!(result.return_failures[0].code, ErrorCode::CdpFailed);
        let encoded = serde_json::to_value(result).unwrap();
        assert_eq!(encoded["returned_tab_ids"], json!([7, 8]));
        assert_eq!(encoded["return_failures"][0]["code"], "cdp_failed");
    }
}
