//! Shared-tab coordination. A context is explicit caller evidence, never inferred by the daemon.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CooperateAction {
    Enable,
    Status,
    Sync,
    Wait,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CooperateParams {
    /// A negotiated policy remains fixed for the session.
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
#[serde(deny_unknown_fields)]
pub struct ActionMetadata {
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CooperateMode {
    Ready,
    Human,
    Held,
    Yielding,
    Syncing,
    Acting,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CooperateTargetPoint {
    pub x: f64,
    pub y: f64,
    pub expires: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CooperateView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<CooperateTargetPoint>,
    pub revision: u64,
    pub mode: CooperateMode,
    pub editing: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CooperateEventTimeWindow {
    pub earliest: f64,
    pub latest: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CooperateActivityAttribution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_time: Option<f64>,
    pub event_time: f64,
    pub expected_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_event_time: Option<CooperateEventTimeWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_timestamp: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CooperateActivity {
    pub sequence: u64,
    #[serde(rename = "type")]
    pub activity_type: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribution: Option<CooperateActivityAttribution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    pub frame_id: i64,
    pub document: String,
    pub cursor: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CooperateFrameGapReason {
    LoadError,
    InactiveDocument,
    HiddenFrame,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CooperateFrameGap {
    pub frame_id: i64,
    pub url: String,
    pub reason: CooperateFrameGapReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CooperateBaselineReason {
    NoPreviousObservation,
    FrameReplaced,
    FieldsIncomplete,
    RefsReplaced,
    MediaChanged,
    TokenBudgetChanged,
    StructureChanged,
    FocusChanged,
    NoHeldText,
    DocumentReplaced,
    MultipleFrames,
    HumanActivity,
    FieldsChanged,
    TextLogGap,
    UnloggedActivity,
    TextOutsideObservation,
    TextAmbiguous,
    TextNamesOtherContent,
    TextCutByTruncation,
    TokenBudgetShift,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CooperateChangeKind {
    Text,
    MediaProgress,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CooperateDeltaChange {
    pub frame_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub label: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<CooperateChangeKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<u32>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CooperateLinePatch {
    pub line: u32,
    pub previous: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CooperateObservationPatch {
    pub lines: Vec<CooperateLinePatch>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CooperateSyncResult {
    Baseline {
        tab_id: i64,
        context_id: String,
        control_policy: ControlPolicy,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame_gaps: Option<Vec<CooperateFrameGap>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        baseline_reason: Option<CooperateBaselineReason>,
        observation: super::SnapshotResult,
        activity: Vec<CooperateActivity>,
        history_complete: bool,
        state: CooperateView,
    },
    Unchanged {
        tab_id: i64,
        context_id: String,
        control_policy: ControlPolicy,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame_gaps: Option<Vec<CooperateFrameGap>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        baseline_reason: Option<CooperateBaselineReason>,
        previous_context_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        previous_observation_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_patch: Option<CooperateObservationPatch>,
        changes: Vec<CooperateDeltaChange>,
        activity: Vec<CooperateActivity>,
        history_complete: bool,
        state: CooperateView,
    },
    Delta {
        tab_id: i64,
        context_id: String,
        control_policy: ControlPolicy,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        frame_gaps: Option<Vec<CooperateFrameGap>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        baseline_reason: Option<CooperateBaselineReason>,
        previous_context_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        previous_observation_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        observation_patch: Option<CooperateObservationPatch>,
        changes: Vec<CooperateDeltaChange>,
        activity: Vec<CooperateActivity>,
        history_complete: bool,
        state: CooperateView,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CooperateStatusResult {
    pub tab_id: i64,
    pub stopped: bool,
    pub activity: Vec<CooperateActivity>,
    pub state: CooperateView,
    pub ready: bool,
    #[serde(default)]
    pub control_policy: Option<ControlPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_gaps: Option<Vec<CooperateFrameGap>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum CooperateResult {
    Sync(CooperateSyncResult),
    Status(CooperateStatusResult),
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
