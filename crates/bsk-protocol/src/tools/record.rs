//! Semantic user-action recording (`tool.record_start` / `stop` / `await`).
//!
//! Trace v3 is a **state-action-state** chain: each step binds to page
//! observations (VOM) captured before and after the action.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::interaction::KeyModifier;

pub const TRACE_VERSION: u32 = 3;
pub const VOM_FORMAT_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/// Stable semantic handle for an interacted element within a page observation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TargetDescriptor {
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "ref")]
    pub element_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctx: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unmatched: bool,
}

// ---------------------------------------------------------------------------
// Trace envelope
// ---------------------------------------------------------------------------

/// Recording entry point — first URL the flow starts from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TraceEntry {
    pub start_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecorderInfo {
    pub bsk: String,
    pub vom: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    UserFinish,
    CliStop,
}

/// Page observation dictionary entry — referenced by steps via `state` / `result.state`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TraceState {
    pub id: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Wire-only: full page observation (front matter + VOM body + annotations).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Disk-only: filename under the bundle `pages/` directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepResult {
    pub state: String,
}

/// Fields shared by every step variant (flattened in JSON).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepCommon {
    pub id: u32,
    /// Observation id immediately before this action.
    pub state: String,
    pub result: StepResult,
}

// ---------------------------------------------------------------------------
// Step op-specific payloads
// ---------------------------------------------------------------------------

/// One selected option (`select` op).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SelectedOption {
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum NavigationCause {
    UserTyped,
    Link,
    FormSubmit,
    Reload,
    History,
    Script,
    Browser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FillCommit {
    Enter,
    Suggestion,
    Blur,
}

/// One recorded user action — discriminated union by `op`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Step {
    Navigate {
        #[serde(flatten)]
        common: StepCommon,
        to: String,
        cause: NavigationCause,
    },
    Click {
        #[serde(flatten)]
        common: StepCommon,
        target: TargetDescriptor,
    },
    Hover {
        #[serde(flatten)]
        common: StepCommon,
        target: TargetDescriptor,
    },
    Fill {
        #[serde(flatten)]
        common: StepCommon,
        target: TargetDescriptor,
        value: String,
        commit: FillCommit,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        redacted: bool,
    },
    Select {
        #[serde(flatten)]
        common: StepCommon,
        target: TargetDescriptor,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        selection: Vec<SelectedOption>,
    },
    Press {
        #[serde(flatten)]
        common: StepCommon,
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modifiers: Option<Vec<KeyModifier>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<TargetDescriptor>,
    },
    Scroll {
        #[serde(flatten)]
        common: StepCommon,
    },
}

// ---------------------------------------------------------------------------
// Trace root
// ---------------------------------------------------------------------------

/// Persisted user-action trace exported by `tool.record_stop` / `await`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Trace {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    pub recorded_at: String,
    pub stopped_by: StopReason,
    pub entry: TraceEntry,
    pub recorder: RecorderInfo,
    pub states: Vec<TraceState>,
    pub steps: Vec<Step>,
}

// ---------------------------------------------------------------------------
// RPC params / results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordStartParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_page_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redact_values: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordStartResult {
    pub tab_id: i64,
    pub recording: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordStopParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordStopResult {
    pub trace: Trace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordAwaitParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordAwaitResult {
    pub trace: Trace,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_common(id: u32, state: &str, result_state: &str) -> StepCommon {
        StepCommon {
            id,
            state: state.into(),
            result: StepResult {
                state: result_state.into(),
            },
        }
    }

    fn sample_target() -> TargetDescriptor {
        TargetDescriptor {
            element_ref: Some("e21".into()),
            role: Some("button".into()),
            name: Some("发布".into()),
            ctx: Some("金桔柠檬 6 号".into()),
            unmatched: false,
        }
    }

    fn sample_trace() -> Trace {
        Trace {
            version: TRACE_VERSION,
            purpose: Some("把草稿商品发布上架".into()),
            started_at: Some("2026-08-10T02:10:41.080Z".into()),
            recorded_at: "2026-08-10T02:12:55.360Z".into(),
            stopped_by: StopReason::UserFinish,
            entry: TraceEntry {
                start_url: "https://example.com/".into(),
            },
            recorder: RecorderInfo {
                bsk: "0.1.10".into(),
                vom: VOM_FORMAT_VERSION,
            },
            states: vec![
                TraceState {
                    id: "s1".into(),
                    url: "https://example.com/".into(),
                    title: Some("Example Domain".into()),
                    body: None,
                    page: Some("s1.vom.txt".into()),
                    truncated: false,
                },
                TraceState {
                    id: "s2".into(),
                    url: "https://shop.example.com/products?status=draft".into(),
                    title: Some("商品管理".into()),
                    body: None,
                    page: Some("s2.vom.txt".into()),
                    truncated: false,
                },
            ],
            steps: vec![
                Step::Navigate {
                    common: sample_common(1, "s1", "s2"),
                    to: "https://shop.example.com/products?status=draft".into(),
                    cause: NavigationCause::UserTyped,
                },
                Step::Fill {
                    common: sample_common(2, "s2", "s2"),
                    target: TargetDescriptor {
                        element_ref: Some("e12".into()),
                        role: Some("textbox".into()),
                        name: Some("搜索商品".into()),
                        ctx: None,
                        unmatched: false,
                    },
                    value: "金桔柠檬".into(),
                    commit: FillCommit::Enter,
                    redacted: false,
                },
                Step::Click {
                    common: sample_common(3, "s2", "s2"),
                    target: sample_target(),
                },
            ],
        }
    }

    #[test]
    fn step_click_round_trips() {
        let step = Step::Click {
            common: sample_common(1, "s1", "s2"),
            target: sample_target(),
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v.get("op").and_then(|v| v.as_str()), Some("click"));
        assert_eq!(v.get("state").and_then(|v| v.as_str()), Some("s1"));
        assert_eq!(v["result"]["state"], "s2");
        assert_eq!(v["target"]["ref"], "e21");
        let round: Step = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn step_fill_with_commit_round_trips() {
        let step = Step::Fill {
            common: sample_common(2, "s2", "s3"),
            target: TargetDescriptor {
                element_ref: Some("e12".into()),
                role: Some("textbox".into()),
                name: Some("搜索商品".into()),
                ctx: None,
                unmatched: false,
            },
            value: "browser skill".into(),
            commit: FillCommit::Enter,
            redacted: false,
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["op"], "fill");
        assert_eq!(v["commit"], "enter");
        assert!(v.get("redacted").is_none());
        let round: Step = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn step_fill_password_is_redacted() {
        let step = Step::Fill {
            common: sample_common(1, "s1", "s1"),
            target: TargetDescriptor {
                element_ref: Some("e3".into()),
                role: Some("textbox".into()),
                name: Some("密码".into()),
                ctx: None,
                unmatched: false,
            },
            value: "***".into(),
            commit: FillCommit::Blur,
            redacted: true,
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["value"], "***");
        assert_eq!(v["redacted"], true);
    }

    #[test]
    fn step_navigate_with_cause_round_trips() {
        let step = Step::Navigate {
            common: sample_common(1, "s1", "s2"),
            to: "https://example.com".into(),
            cause: NavigationCause::UserTyped,
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["op"], "navigate");
        assert_eq!(v["cause"], "user_typed");
        let round: Step = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn trace_v3_round_trips() {
        let trace = sample_trace();
        let v = serde_json::to_value(&trace).unwrap();
        assert_eq!(v.get("version").and_then(|v| v.as_u64()), Some(3));
        assert!(v.get("pages").is_none());
        assert_eq!(v["recorder"]["vom"], 1);
        assert_eq!(v["states"].as_array().unwrap().len(), 2);
        let round: Trace = serde_json::from_value(v).unwrap();
        assert_eq!(round, trace);
    }

    #[test]
    fn default_fields_are_omitted() {
        let step = Step::Click {
            common: sample_common(1, "s1", "s1"),
            target: TargetDescriptor {
                element_ref: Some("e1".into()),
                role: Some("button".into()),
                name: Some("OK".into()),
                ctx: None,
                unmatched: false,
            },
        };
        let v = serde_json::to_value(&step).unwrap();
        assert!(v.get("unmatched").is_none());
        assert!(v["target"].get("ctx").is_none());
        assert!(v["target"].get("unmatched").is_none());
    }

    #[test]
    fn unmatched_target_serializes_flag() {
        let step = Step::Click {
            common: sample_common(1, "s1", "s2"),
            target: TargetDescriptor {
                element_ref: None,
                role: Some("button".into()),
                name: Some("发布".into()),
                ctx: None,
                unmatched: true,
            },
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["target"]["unmatched"], true);
        assert!(v["target"].get("ref").is_none());
    }

    #[test]
    fn extension_trace_deserializes() {
        let v = json!({
            "version": 3,
            "recorded_at": "2026-07-21T08:00:00Z",
            "started_at": "2026-07-21T07:59:00Z",
            "purpose": "demo",
            "stopped_by": "user_finish",
            "entry": { "start_url": "https://example.com/editor" },
            "recorder": { "bsk": "0.1.10", "vom": 1 },
            "states": [
                { "id": "s1", "url": "https://example.com/editor", "page": "s1.vom.txt" },
                { "id": "s2", "url": "https://example.com/p/99", "page": "s2.vom.txt" }
            ],
            "steps": [
                {
                    "op": "fill",
                    "id": 1,
                    "state": "s1",
                    "result": { "state": "s1" },
                    "target": { "ref": "e1", "role": "textbox", "name": "标题" },
                    "value": "hello",
                    "commit": "blur"
                },
                {
                    "op": "click",
                    "id": 2,
                    "state": "s1",
                    "result": { "state": "s2" },
                    "target": { "ref": "e2", "role": "button", "name": "发布" }
                }
            ]
        });
        let trace: Trace = serde_json::from_value(v).unwrap();
        assert_eq!(trace.version, 3);
        assert_eq!(trace.states.len(), 2);
        assert_eq!(trace.steps.len(), 2);
    }
}
