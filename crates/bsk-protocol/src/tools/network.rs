//! `tool.network` — read buffered network responses / failures.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NetworkParams {
    pub session_id: String,
    /// Optional target tab. Defaults to the Agent Window's currently active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Return entries with sequence strictly greater than this cursor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    /// Maximum number of entries to return. Extension applies safe defaults and caps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub limit: Option<u32>,
    /// Maximum characters returned per URL / error text. Extension applies safe defaults and caps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub max_text_chars: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum NetworkEntryKind {
    /// A response was received (`Network.responseReceived`).
    Response,
    /// The request failed before completing (`Network.loadingFailed`).
    Failure,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NetworkEntry {
    pub sequence: u64,
    pub kind: NetworkEntryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// HTTP status code (`response` entries only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    /// CDP failure reason (`failure` entries only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<f64>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NetworkResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<NetworkEntry>,
    pub next_since: u64,
    #[serde(default)]
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn network_params_omit_optional_fields() {
        let params = NetworkParams {
            session_id: "aa11".into(),
            tab_id: None,
            since: None,
            limit: None,
            max_text_chars: None,
        };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value["session_id"], "aa11");
        assert!(value.get("tab_id").is_none());
        assert!(value.get("since").is_none());
        assert!(value.get("limit").is_none());
        assert!(value.get("max_text_chars").is_none());
        let round: NetworkParams = serde_json::from_value(value).unwrap();
        assert_eq!(round, params);
    }

    #[test]
    fn network_result_round_trips_response_and_failure() {
        let result = NetworkResult {
            tab_id: 7,
            entries: vec![
                NetworkEntry {
                    sequence: 3,
                    kind: NetworkEntryKind::Response,
                    method: Some("GET".into()),
                    url: Some("https://example.test/api".into()),
                    status: Some(404),
                    status_text: Some("Not Found".into()),
                    mime_type: Some("application/json".into()),
                    resource_type: Some("Fetch".into()),
                    error_text: None,
                    timestamp: Some(1234.5),
                    truncated: false,
                },
                NetworkEntry {
                    sequence: 4,
                    kind: NetworkEntryKind::Failure,
                    method: Some("GET".into()),
                    url: None,
                    status: None,
                    status_text: None,
                    mime_type: None,
                    resource_type: Some("Script".into()),
                    error_text: Some("net::ERR_BLOCKED_BY_CLIENT".into()),
                    timestamp: Some(1240.0),
                    truncated: false,
                },
            ],
            next_since: 4,
            truncated: false,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["entries"][0]["kind"], json!("response"));
        assert_eq!(value["entries"][0]["status"], json!(404));
        assert_eq!(value["entries"][1]["kind"], json!("failure"));
        assert!(value["entries"][1].get("url").is_none());
        assert_eq!(
            value["entries"][1]["error_text"],
            json!("net::ERR_BLOCKED_BY_CLIENT")
        );
        let round: NetworkResult = serde_json::from_value(value).unwrap();
        assert_eq!(round, result);
    }
}
