//! `tool.har_*` — record and export a tab's network activity as HAR 1.2.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HarStartParams {
    pub session_id: String,
    /// Optional target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Capture response and request bodies when CDP makes them available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_content: Option<bool>,
    /// Redact credentials in headers and common sensitive query parameters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sanitize: Option<bool>,
    /// Maximum decoded bytes retained for any one response body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_body_bytes: Option<u64>,
    /// Maximum decoded response-body bytes retained by the recording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_total_body_bytes: Option<u64>,
    /// Maximum number of HAR entries retained by the recording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_entries: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HarStartResult {
    pub tab_id: i64,
    pub started_at: String,
    pub capture_content: bool,
    pub sanitize: bool,
    pub max_body_bytes: u64,
    pub max_total_body_bytes: u64,
    pub max_entries: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HarStatusParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HarStatusResult {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default)]
    pub entry_count: u32,
    #[serde(default)]
    pub in_flight: u32,
    #[serde(default)]
    pub body_bytes: u64,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HarStopParams {
    pub session_id: String,
    /// Wait this long for in-flight requests and response-body reads to finish.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settle_timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HarStopResult {
    pub tab_id: i64,
    pub entry_count: u32,
    pub body_bytes: u64,
    #[serde(default)]
    pub truncated: bool,
    /// A complete HAR 1.2 archive. Kept as JSON so vendor extension fields survive.
    pub har: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn optional_start_options_are_omitted() {
        let value = serde_json::to_value(HarStartParams {
            session_id: "aa11".into(),
            tab_id: None,
            capture_content: None,
            sanitize: None,
            max_body_bytes: None,
            max_total_body_bytes: None,
            max_entries: None,
        })
        .unwrap();
        assert_eq!(value, json!({ "session_id": "aa11" }));
    }

    #[test]
    fn stop_result_preserves_har_payload() {
        let result = HarStopResult {
            tab_id: 7,
            entry_count: 1,
            body_bytes: 2,
            truncated: false,
            har: json!({ "log": { "version": "1.2", "entries": [] } }),
        };
        let round: HarStopResult =
            serde_json::from_value(serde_json::to_value(&result).unwrap()).unwrap();
        assert_eq!(round, result);
    }
}
