//! Shared-tab coordination. A context is explicit caller evidence, never inferred by the daemon.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CooperateAction {
    Enable,
    Status,
    Sync,
    Wait,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CooperateParams {
    /// Omitted by legacy callers. A negotiated policy remains fixed for the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_policy: Option<ControlPolicy>,
    pub session_id: String,
    pub action: CooperateAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

pub const TARGET_CONTROL_PROTOCOL: &str = "1.8";

pub fn supports_target_control(protocol: &str) -> bool {
    crate::system::compare_protocol(protocol, "2.0") == Some(std::cmp::Ordering::Less)
        && matches!(
            crate::system::compare_protocol(protocol, TARGET_CONTROL_PROTOCOL),
            Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
        )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ControlPolicy {
    /// Keep the negotiated policy, or choose target when the session is unconfigured.
    Auto,
    Strict,
    Target,
}

/// Shared metadata merged into guarded tool params on the wire.
/// Passive reads and session lifecycle operations do not evaluate these conditions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ActionMetadata {
    /// Context actually returned by sync. Reusable for target-policy DOM actions;
    /// strict policy consumes it after one action. Never fill it from cached state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub context_id: Option<String>,
    /// Sync's baseline for untargeted/visual actions under target policy.
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

/// Caller-supplied facts checked immediately before starting an action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ActionExpectation {
    /// Observed ref or main-document CSS selector, measured in Unicode code points.
    #[schemars(length(min = 1, max = 1024))]
    pub target: String,
    pub field: ExpectationField,
    /// text/value require a string; checked/exists require a boolean;
    /// attribute accepts a string or null for absence. Text is exact textContent.
    pub equals: ExpectedValue,
    /// Required only for field=attribute, measured in Unicode code points.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String", length(min = 1, max = 256))]
    pub attribute: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExpectationField {
    Text,
    Value,
    Checked,
    Attribute,
    Exists,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ExpectedValue {
    String(String),
    Boolean(bool),
    Null,
}

impl ActionExpectation {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.target.trim().is_empty() || self.target.chars().count() > 1024 {
            return Err("expect target must contain 1..=1024 Unicode code points");
        }
        match (&self.field, &self.equals) {
            (ExpectationField::Text | ExpectationField::Value, ExpectedValue::String(_))
            | (ExpectationField::Checked | ExpectationField::Exists, ExpectedValue::Boolean(_))
            | (ExpectationField::Attribute, ExpectedValue::String(_) | ExpectedValue::Null) => {}
            _ => return Err("expect equals has the wrong type for its field"),
        }
        if self.field == ExpectationField::Attribute {
            if !self
                .attribute
                .as_ref()
                .is_some_and(|name| !name.trim().is_empty() && name.chars().count() <= 256)
            {
                return Err("attribute expectations require a name of 1..=256 Unicode code points");
            }
        } else if self.attribute.is_some() {
            return Err("attribute is only valid with the attribute field");
        }
        Ok(())
    }
}

pub fn parse_expectations(value: &str) -> Result<Vec<ActionExpectation>, String> {
    let conditions: Vec<ActionExpectation> =
        serde_json::from_str(value).map_err(|error| format!("invalid --expect JSON: {error}"))?;
    if conditions.len() > 16 {
        return Err("expect supports at most 16 conditions".into());
    }
    for condition in &conditions {
        condition.validate().map_err(str::to_owned)?;
    }
    Ok(conditions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_sync_omits_policy_and_new_policy_round_trips() {
        let mut value = json!({"session_id":"s", "action":"sync"});
        let old: CooperateParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(old.control_policy, None);
        assert_eq!(serde_json::to_value(old).unwrap(), value);
        value["control_policy"] = "target".into();
        let new: CooperateParams = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(new.control_policy, Some(ControlPolicy::Target));
        assert_eq!(serde_json::to_value(new).unwrap(), value);
    }

    #[test]
    fn target_control_has_an_explicit_protocol_boundary() {
        for old in ["", "invalid", "1.0", "1.7", "2.0"] {
            assert!(!supports_target_control(old));
        }
        for new in ["1.8", "1.8.0", "1.9"] {
            assert!(supports_target_control(new));
        }
    }

    #[test]
    fn expectations_preserve_literal_values_and_validate_field_types() {
        for condition in [
            json!({"target":"@e1","field":"text","equals":"  $10 [sale]  "}),
            json!({"target":"input[name=city]","field":"value","equals":"北京"}),
            json!({"target":"@e2","field":"checked","equals":true}),
            json!({"target":"#banner","field":"exists","equals":false}),
            json!({"target":"@e3","field":"attribute","attribute":"data-record-id","equals":"42"}),
            json!({"target":"@e3","field":"attribute","attribute":"disabled","equals":null}),
        ] {
            let input = json!([condition]);
            let parsed = parse_expectations(&input.to_string()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), input);
        }
        for invalid in [
            json!({"target":"@e1","field":"text","equals":true}),
            json!({"target":"@e1","field":"value","equals":null}),
            json!({"target":"@e1","field":"checked","equals":"true"}),
            json!({"target":"@e1","field":"exists","equals":1}),
            json!({"target":"@e1","field":"attribute","equals":"x"}),
            json!({"target":"@e1","field":"text","attribute":"id","equals":"x"}),
            json!({"target":" ","field":"text","equals":"x"}),
            json!({"target":"@e1","field":"text","equals":"x","extra":true}),
        ] {
            assert!(parse_expectations(&json!([invalid]).to_string()).is_err());
        }
        let condition = json!({"target":"@e1","field":"exists","equals":true});
        assert!(parse_expectations(&serde_json::to_string(&vec![condition; 17]).unwrap()).is_err());
        assert!(parse_expectations("{}").is_err());
    }

    #[test]
    fn expectation_limits_count_unicode_code_points() {
        for character in ["a", "中", "🦀"] {
            for (length, accepted) in [(1024, true), (1025, false)] {
                let value =
                    json!([{"target":character.repeat(length),"field":"exists","equals":true}]);
                assert_eq!(parse_expectations(&value.to_string()).is_ok(), accepted);
            }
            for (length, accepted) in [(256, true), (257, false)] {
                let value = json!([{"target":"@e1","field":"attribute","attribute":character.repeat(length),"equals":null}]);
                assert_eq!(parse_expectations(&value.to_string()).is_ok(), accepted);
            }
        }
    }

    #[test]
    fn action_metadata_preserves_conditions_without_populating_omitted_fields() {
        assert_eq!(
            serde_json::to_value(ActionMetadata::default()).unwrap(),
            json!({})
        );
        let value = json!({
            "context_id":"control", "observation_id":"observation", "depends_on":["@e1"],
            "expect":[{"target":"#price","field":"text","equals":"  $12 [sale]\n"}]
        });
        let metadata: ActionMetadata = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(metadata).unwrap(), value);
        let empty: ActionMetadata = serde_json::from_value(json!({"expect":[]})).unwrap();
        assert_eq!(serde_json::to_value(empty).unwrap(), json!({"expect":[]}));
    }
}
