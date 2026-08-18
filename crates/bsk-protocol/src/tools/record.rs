//! Semantic user-action recording (`tool.record_start` / `stop` / `await`).
//!
//! Trace v3 is a **state-action-state** chain: each step binds to page
//! observations (VOM) captured before and after the action.

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};

use super::interaction::KeyModifier;

pub use super::record_common::TraceEntry;
pub use super::record_v2::{
    PageRefV2, SelectedOptionV2, StepCommonV2, StepEffectV2, StepV2, TargetDescriptorV2, TraceV2,
};

pub const TRACE_VERSION_V3: u32 = 3;
pub const TRACE_VERSION_V2: u32 = 2;
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

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Trace v3 envelope
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Trace v3 step payloads
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Trace v3 root
// ---------------------------------------------------------------------------

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
    /// Desired trace export format. Omitted means v2; `3` requests v3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_version: Option<u32>,
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

/// Wire trace payload — v2 (legacy `pages[]`) or v3 (`version: 3`, `states[]`).
#[derive(Debug, Clone, PartialEq)]
pub enum RecordedTrace {
    V2(TraceV2),
    V3(TraceV3),
}

impl RecordedTrace {
    pub fn classify_value(v: &serde_json::Value) -> Result<Self, String> {
        if let Some(ver) = v.get("version").and_then(|x| x.as_u64()) {
            if ver != u64::from(TRACE_VERSION_V3) {
                return Err(format!("unsupported trace version {ver}"));
            }
            if v.get("pages").is_some() {
                return Err("trace v3 must not include legacy pages[]".into());
            }
            return serde_json::from_value(v.clone())
                .map(RecordedTrace::V3)
                .map_err(|e| e.to_string());
        }
        if v.get("states").is_some() {
            return Err("trace v2 must not include states[]; set version: 3 for Trace v3".into());
        }
        if v.get("pages").is_some() {
            return serde_json::from_value(v.clone())
                .map(RecordedTrace::V2)
                .map_err(|e| e.to_string());
        }
        Err("ambiguous or unparseable trace".into())
    }
}

impl Serialize for RecordedTrace {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            RecordedTrace::V2(t) => t.serialize(serializer),
            RecordedTrace::V3(t) => t.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for RecordedTrace {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Self::classify_value(&value).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for RecordedTrace {
    fn schema_name() -> String {
        "RecordedTrace".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::schema::Schema {
        schemars::schema::SchemaObject {
            subschemas: Some(Box::new(schemars::schema::SubschemaValidation {
                one_of: Some(vec![
                    generator.subschema_for::<TraceV2>(),
                    generator.subschema_for::<TraceV3>(),
                ]),
                ..Default::default()
            })),
            ..Default::default()
        }
        .into()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordStopResult {
    pub trace: RecordedTrace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordAwaitParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordAwaitResult {
    pub trace: RecordedTrace,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    fn record_start_trace_options_are_explicit_and_optional() {
        let legacy = RecordStartParams {
            session_id: "session".into(),
            tab_id: None,
            url: None,
            purpose: None,
            max_page_tokens: None,
            redact_values: None,
            trace_version: None,
        };
        let legacy_value = serde_json::to_value(legacy).unwrap();
        assert!(legacy_value.get("trace_version").is_none());
        assert!(legacy_value.get("max_page_tokens").is_none());

        let v3 = RecordStartParams {
            session_id: "session".into(),
            tab_id: None,
            url: None,
            purpose: None,
            max_page_tokens: Some(4_000),
            redact_values: Some(true),
            trace_version: Some(TRACE_VERSION_V3),
        };
        let v3_value = serde_json::to_value(v3).unwrap();
        assert_eq!(v3_value["trace_version"], TRACE_VERSION_V3);
        assert_eq!(v3_value["max_page_tokens"], 4_000);
        assert_eq!(v3_value["redact_values"], true);
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
    fn recorded_trace_classifies_v2_and_v3() {
        let v2 = json!({
            "recorded_at": "2026-07-21T08:00:00Z",
            "entry": { "start_url": "https://example.com/" },
            "pages": [{ "id": "p1", "url": "https://example.com/" }],
            "steps": []
        });
        match RecordedTrace::classify_value(&v2).unwrap() {
            RecordedTrace::V2(_) => {}
            other => panic!("expected v2, got {other:?}"),
        }

        let v3 = json!({
            "version": 3,
            "recorded_at": "2026-07-21T08:00:00Z",
            "stopped_by": "user_finish",
            "entry": { "start_url": "https://example.com/" },
            "recorder": { "bsk": "0.1.10", "vom": 1 },
            "states": [],
            "steps": []
        });
        match RecordedTrace::classify_value(&v3).unwrap() {
            RecordedTrace::V3(t) => assert_eq!(t.version, 3),
            other => panic!("expected v3, got {other:?}"),
        }
    }

    #[test]
    fn recorded_trace_rejects_mixed_and_unsupported_versions() {
        let v2_with_states = json!({
            "recorded_at": "2026-07-21T08:00:00Z",
            "entry": { "start_url": "https://example.com/" },
            "pages": [{ "id": "p1", "url": "https://example.com/" }],
            "states": [],
            "steps": []
        });
        assert!(RecordedTrace::classify_value(&v2_with_states).is_err());

        let v3_with_pages = json!({
            "version": 3,
            "recorded_at": "2026-07-21T08:00:00Z",
            "stopped_by": "user_finish",
            "entry": { "start_url": "https://example.com/" },
            "recorder": { "bsk": "0.1.10", "vom": 1 },
            "pages": [{ "id": "p1", "url": "https://example.com/" }],
            "states": [],
            "steps": []
        });
        assert!(RecordedTrace::classify_value(&v3_with_pages).is_err());

        let unsupported = json!({
            "version": 2,
            "recorded_at": "2026-07-21T08:00:00Z",
            "stopped_by": "user_finish",
            "entry": { "start_url": "https://example.com/" },
            "recorder": { "bsk": "0.1.10", "vom": 1 },
            "states": [],
            "steps": []
        });
        assert!(RecordedTrace::classify_value(&unsupported).is_err());
        assert!(serde_json::from_value::<TraceV3>(unsupported).is_err());
    }

    #[test]
    fn recorded_trace_schema_includes_v2_and_v3() {
        let schema = serde_json::to_value(schemars::schema_for!(RecordStopResult)).unwrap();
        let variants = schema["definitions"]["RecordedTrace"]["oneOf"]
            .as_array()
            .expect("RecordedTrace schema should use oneOf");

        assert_eq!(variants.len(), 2);
        let trace_schema = schema["definitions"]["TraceV3"].clone();
        assert_eq!(trace_schema["properties"]["version"]["const"], 3);
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
