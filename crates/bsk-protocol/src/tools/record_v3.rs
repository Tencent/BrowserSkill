//! Trace v3 — state-action-state log with `states[]` and step `state` refs.
//!
//! Wire format with top-level `version: 3`.

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

use super::interaction::KeyModifier;
use super::record_common::TraceEntry;

pub const TRACE_VERSION_V3: u32 = 3;
pub const VOM_FORMAT_VERSION: u32 = 1;

fn deserialize_trace_v3_version<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let version = u32::deserialize(deserializer)?;
    if version != TRACE_VERSION_V3 {
        return Err(serde::de::Error::custom(format!(
            "unsupported trace version {version} (expected {TRACE_VERSION_V3})"
        )));
    }
    Ok(version)
}

fn trace_v3_version_schema(_: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    schemars::schema::SchemaObject {
        instance_type: Some(schemars::schema::InstanceType::Integer.into()),
        const_value: Some(serde_json::json!(TRACE_VERSION_V3)),
        ..Default::default()
    }
    .into()
}

/// Stable semantic handle for an interacted element within a page observation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TargetDescriptorV3 {
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
pub struct TraceStateV3 {
    pub id: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Full page observation (front matter + VOM body + annotations).
    pub body: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepResultV3 {
    pub state: String,
}

/// Fields shared by every step variant (flattened in JSON).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepCommonV3 {
    pub id: u32,
    /// Observation id immediately before this action.
    pub state: String,
    pub result: StepResultV3,
}

/// One selected option (`select` op).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SelectedOptionV3 {
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
pub enum StepV3 {
    Navigate {
        #[serde(flatten)]
        common: StepCommonV3,
        to: String,
        cause: NavigationCause,
    },
    Click {
        #[serde(flatten)]
        common: StepCommonV3,
        target: TargetDescriptorV3,
    },
    Hover {
        #[serde(flatten)]
        common: StepCommonV3,
        target: TargetDescriptorV3,
    },
    Fill {
        #[serde(flatten)]
        common: StepCommonV3,
        target: TargetDescriptorV3,
        value: String,
        commit: FillCommit,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        redacted: bool,
    },
    Select {
        #[serde(flatten)]
        common: StepCommonV3,
        target: TargetDescriptorV3,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        selection: Vec<SelectedOptionV3>,
    },
    Press {
        #[serde(flatten)]
        common: StepCommonV3,
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modifiers: Option<Vec<KeyModifier>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<TargetDescriptorV3>,
    },
    Scroll {
        #[serde(flatten)]
        common: StepCommonV3,
    },
}

/// Wire trace returned by `tool.record_stop` / `await`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TraceV3 {
    #[serde(deserialize_with = "deserialize_trace_v3_version")]
    #[schemars(schema_with = "trace_v3_version_schema")]
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    pub recorded_at: String,
    pub stopped_by: StopReason,
    pub entry: TraceEntry,
    pub recorder: RecorderInfo,
    pub states: Vec<TraceStateV3>,
    pub steps: Vec<StepV3>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_common(id: u32, state: &str, result_state: &str) -> StepCommonV3 {
        StepCommonV3 {
            id,
            state: state.into(),
            result: StepResultV3 {
                state: result_state.into(),
            },
        }
    }

    fn sample_target() -> TargetDescriptorV3 {
        TargetDescriptorV3 {
            element_ref: Some("e21".into()),
            role: Some("button".into()),
            name: Some("发布".into()),
            ctx: Some("金桔柠檬 6 号".into()),
            unmatched: false,
        }
    }

    fn sample_trace() -> TraceV3 {
        TraceV3 {
            version: TRACE_VERSION_V3,
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
                TraceStateV3 {
                    id: "s1".into(),
                    url: "https://example.com/".into(),
                    title: Some("Example Domain".into()),
                    body: "@vom 1\nRootWebArea \"Example Domain\"".into(),
                    truncated: false,
                },
                TraceStateV3 {
                    id: "s2".into(),
                    url: "https://shop.example.com/products?status=draft".into(),
                    title: Some("商品管理".into()),
                    body: "@vom 1\nRootWebArea \"商品管理\"".into(),
                    truncated: false,
                },
            ],
            steps: vec![
                StepV3::Navigate {
                    common: sample_common(1, "s1", "s2"),
                    to: "https://shop.example.com/products?status=draft".into(),
                    cause: NavigationCause::UserTyped,
                },
                StepV3::Fill {
                    common: sample_common(2, "s2", "s2"),
                    target: TargetDescriptorV3 {
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
                StepV3::Click {
                    common: sample_common(3, "s2", "s2"),
                    target: sample_target(),
                },
            ],
        }
    }

    #[test]
    fn step_click_round_trips() {
        let step = StepV3::Click {
            common: sample_common(1, "s1", "s2"),
            target: sample_target(),
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v.get("op").and_then(|v| v.as_str()), Some("click"));
        assert_eq!(v.get("state").and_then(|v| v.as_str()), Some("s1"));
        assert_eq!(v["result"]["state"], "s2");
        assert_eq!(v["target"]["ref"], "e21");
        let round: StepV3 = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn step_fill_with_commit_round_trips() {
        let step = StepV3::Fill {
            common: sample_common(2, "s2", "s3"),
            target: TargetDescriptorV3 {
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
        let round: StepV3 = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn step_fill_password_is_redacted() {
        let step = StepV3::Fill {
            common: sample_common(1, "s1", "s1"),
            target: TargetDescriptorV3 {
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
        let step = StepV3::Navigate {
            common: sample_common(1, "s1", "s2"),
            to: "https://example.com".into(),
            cause: NavigationCause::UserTyped,
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["op"], "navigate");
        assert_eq!(v["cause"], "user_typed");
        let round: StepV3 = serde_json::from_value(v).unwrap();
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
        let round: TraceV3 = serde_json::from_value(v).unwrap();
        assert_eq!(round, trace);
    }

    #[test]
    fn default_fields_are_omitted() {
        let step = StepV3::Click {
            common: sample_common(1, "s1", "s1"),
            target: TargetDescriptorV3 {
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
        let step = StepV3::Click {
            common: sample_common(1, "s1", "s2"),
            target: TargetDescriptorV3 {
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
                { "id": "s1", "url": "https://example.com/editor", "body": "@vom 1" },
                { "id": "s2", "url": "https://example.com/p/99", "body": "@vom 1" }
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
        let trace: TraceV3 = serde_json::from_value(v).unwrap();
        assert_eq!(trace.version, 3);
        assert_eq!(trace.states.len(), 2);
        assert_eq!(trace.steps.len(), 2);
    }
}
