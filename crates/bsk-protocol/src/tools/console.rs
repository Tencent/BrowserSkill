//! `tool.console` — read buffered console/log/exception messages.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ConsoleParams {
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
    /// Maximum characters returned per entry text. Extension applies safe defaults and caps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub max_text_chars: Option<u32>,
    /// Include structured stack frames. Defaults to false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_stack: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleEntryKind {
    Console,
    Exception,
    Log,
}

impl ConsoleEntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Console => "console",
            Self::Exception => "exception",
            Self::Log => "log",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ConsoleStackFrame {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ConsoleEntry {
    pub sequence: u64,
    pub kind: ConsoleEntryKind,
    pub level: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stack_trace: Vec<ConsoleStackFrame>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ConsoleResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<ConsoleEntry>,
    pub next_since: u64,
    #[serde(default)]
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn console_params_omit_optional_fields() {
        let params = ConsoleParams {
            session_id: "aa11".into(),
            tab_id: None,
            since: None,
            limit: None,
            max_text_chars: None,
            include_stack: None,
        };
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value["session_id"], "aa11");
        assert!(value.get("tab_id").is_none());
        assert!(value.get("since").is_none());
        assert!(value.get("limit").is_none());
        assert!(value.get("max_text_chars").is_none());
        assert!(value.get("include_stack").is_none());
        let round: ConsoleParams = serde_json::from_value(value).unwrap();
        assert_eq!(round, params);
    }

    #[test]
    fn console_result_round_trips_with_stack_and_truncation() {
        let result = ConsoleResult {
            tab_id: 7,
            entries: vec![ConsoleEntry {
                sequence: 12,
                kind: ConsoleEntryKind::Exception,
                level: "error".into(),
                text: "Uncaught TypeError: x is undefined".into(),
                url: Some("https://example.test/app.js".into()),
                line: Some(42),
                column: Some(7),
                timestamp: Some(1234.5),
                stack_trace: vec![ConsoleStackFrame {
                    function_name: Some("render".into()),
                    url: Some("https://example.test/app.js".into()),
                    line: Some(42),
                    column: Some(7),
                }],
                truncated: true,
            }],
            next_since: 12,
            truncated: true,
        };
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["entries"][0]["kind"], json!("exception"));
        assert_eq!(
            value["entries"][0]["stack_trace"][0]["function_name"],
            json!("render")
        );
        let round: ConsoleResult = serde_json::from_value(value).unwrap();
        assert_eq!(round, result);
    }
}
