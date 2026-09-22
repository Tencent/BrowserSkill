//! Session-scoped tools (`tool.session_*`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ErrorCode;

/// Protocol 1.3 makes browser Automation settings authoritative.
pub const INTERACTION_POLICY_PROTOCOL: &str = "1.3";

/// Stay within protocol major 1, matching handshake compatibility. A future
/// major version must explicitly establish support rather than inherit it.
pub fn supports_interaction_policy(protocol: &str) -> bool {
    crate::system::compare_protocol(protocol, "2.0") == Some(std::cmp::Ordering::Less)
        && matches!(
            crate::system::compare_protocol(protocol, INTERACTION_POLICY_PROTOCOL),
            Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
        )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BorrowConfirmationPolicy {
    Always,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RequestHelpPolicy {
    Enabled,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InteractionPolicy {
    pub borrow_confirmation: BorrowConfirmationPolicy,
    pub request_help: RequestHelpPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStartParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_instance_id: Option<String>,
    /// Optional Agent Window outer width in CSS pixels (100..=7680).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Optional Agent Window outer height in CSS pixels (100..=7680).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Whether the new Agent Window should take focus. Omitted means the
    /// extension's default (`true`) for compatibility with older clients.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    /// Legacy input, ignored. Browser settings decide both prompts for every session.
    #[serde(default, skip_serializing)]
    #[schemars(skip)]
    pub unattended: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStartResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction: Option<InteractionPolicy>,
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
    fn legacy_unattended_is_accepted_but_never_forwarded() {
        let schema = schemars::schema_for!(SessionStartParams);
        let object = schema.schema.object.unwrap();
        for unattended in [false, true] {
            let params: SessionStartParams = serde_json::from_value(json!({
                "session_id": "abcd", "unattended": unattended
            }))
            .unwrap();
            let encoded = serde_json::to_value(params).unwrap();
            assert_eq!(encoded, json!({"session_id": "abcd"}));
            for required in &object.required {
                assert!(
                    encoded.get(required).is_some(),
                    "schema requires omitted field {required}"
                );
            }
        }
        assert!(!object.properties.contains_key("unattended"));
    }

    #[test]
    fn interaction_policy_requires_a_compatible_protocol() {
        for protocol in ["1.0", "1.1", "1.2", "2.0", "invalid"] {
            assert!(!supports_interaction_policy(protocol), "{protocol}");
        }
        for protocol in ["1.3", "1.4"] {
            assert!(supports_interaction_policy(protocol), "{protocol}");
        }
        let legacy: SessionStartParams =
            serde_json::from_value(json!({"session_id": "abcd"})).unwrap();
        assert!(!legacy.unattended);
    }

    #[test]
    fn session_start_focus_is_optional_and_round_trips_false() {
        let defaulted: SessionStartParams = serde_json::from_value(json!({
            "session_id": "aa11"
        }))
        .unwrap();
        assert_eq!(defaulted.focused, None);

        let background: SessionStartParams = serde_json::from_value(json!({
            "session_id": "aa11",
            "focused": false
        }))
        .unwrap();
        assert_eq!(background.focused, Some(false));
        assert_eq!(serde_json::to_value(background).unwrap()["focused"], false);
    }

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
