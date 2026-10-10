//! Bounded, sequential interactions against one observed page. A receipt records
//! execution, not business success; callers must inspect the final observation.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{KeyModifier, MouseButton, ObserveResult};
use crate::RpcError;

pub const BATCH_MAX_STEPS: usize = 20;
pub const BATCH_MAX_BYTES: usize = 65_536;
pub const BATCH_DEFAULT_TIMEOUT_MS: u32 = 30_000;
pub const BATCH_MAX_TIMEOUT_MS: u32 = 120_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum BatchStep {
    Fill {
        target: String,
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clear_before: Option<bool>,
    },
    Select {
        target: String,
        values: Vec<String>,
    },
    Click {
        target: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        button: Option<MouseButton>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        click_count: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modifiers: Option<Vec<KeyModifier>>,
    },
    Press {
        target: String,
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modifiers: Option<Vec<KeyModifier>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hold_ms: Option<u32>,
    },
    Focus {
        target: String,
    },
    Blur {
        target: String,
    },
    Hover {
        target: String,
    },
    ScrollTo {
        target: String,
    },
}

impl BatchStep {
    pub fn target(&self) -> &str {
        match self {
            Self::Fill { target, .. }
            | Self::Select { target, .. }
            | Self::Click { target, .. }
            | Self::Press { target, .. }
            | Self::Focus { target }
            | Self::Blur { target }
            | Self::Hover { target }
            | Self::ScrollTo { target } => target,
        }
    }
}

/// File input for `bsk batch`. Session ownership is supplied separately.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BatchPlan {
    pub observation_id: String,
    pub steps: Vec<BatchStep>,
}

impl BatchPlan {
    pub fn validate(&self) -> Result<(), String> {
        if self.observation_id.is_empty() || self.observation_id.len() > 128 {
            return Err("observation_id must be copied from a fresh observe or snapshot".into());
        }
        if self.steps.is_empty() || self.steps.len() > BATCH_MAX_STEPS {
            return Err(format!("batch requires 1..={BATCH_MAX_STEPS} steps"));
        }
        for (index, step) in self.steps.iter().enumerate() {
            let target = step.target().trim_start_matches('@');
            if !target.strip_prefix('e').is_some_and(|digits| {
                !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit())
            }) || step.target().starts_with("@@")
            {
                return Err(format!(
                    "step {index}: batch targets must be observed DOM refs; use single actions for selectors or Canvas"
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BatchParams {
    pub session_id: String,
    /// Caller-chosen id. Reusing it only retrieves the existing receipt.
    pub request_id: String,
    pub observation_id: String,
    pub steps: Vec<BatchStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BatchStatusParams {
    pub session_id: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BatchStatus {
    Running,
    Completed,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BatchStepStatus {
    NotRun,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BatchEffectState {
    None,
    Committed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BatchStepResult {
    pub index: usize,
    pub action: String,
    pub status: BatchStepStatus,
    pub effect_state: BatchEffectState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BatchResult {
    pub request_id: String,
    pub status: BatchStatus,
    pub steps: Vec<BatchStepResult>,
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<ObserveResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_error: Option<RpcError>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unknown_actions_and_fields_before_any_execution() {
        for step in [
            json!({"action":"evaluate","expression":"submit()"}),
            json!({"action":"click","target":"@e1","tab_id":9}),
            json!({"action":"fill","target":"@e1"}),
            json!({"action":"batch","steps":[]}),
        ] {
            assert!(serde_json::from_value::<BatchStep>(step).is_err());
        }
    }

    #[test]
    fn plan_requires_bounded_steps_and_observed_targets() {
        let mut plan = BatchPlan {
            observation_id: "observation-1".into(),
            steps: vec![],
        };
        assert!(plan.validate().is_err());
        plan.steps.push(BatchStep::Focus {
            target: "#new-field".into(),
        });
        assert!(plan.validate().is_err());
        plan.steps[0] = BatchStep::Focus {
            target: "@e1".into(),
        };
        assert!(plan.validate().is_ok());
        plan.steps = vec![plan.steps[0].clone(); BATCH_MAX_STEPS + 1];
        assert!(plan.validate().is_err());
    }
}
