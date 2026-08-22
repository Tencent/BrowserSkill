//! Semantic user-action recording (`tool.record_start` / `stop` / `await`).
//!
//! Wire traces are either Trace v2 (`pages[]`) or Trace v3 (`version: 3`,
//! `states[]`). Version-specific models live in `record_v2` / `record_v3`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use super::record_common::TraceEntry;
pub use super::record_v2::{
    PageRefV2, SelectedOptionV2, StepCommonV2, StepEffectV2, StepV2, TargetDescriptorV2, TraceV2,
};
pub use super::record_v3::{
    FillCommit, NavigationCause, RecorderInfo, SelectedOptionV3, StepCommonV3, StepResultV3,
    StepV3, StopReason, TRACE_VERSION_V3, TargetDescriptorV3, TraceStateV3, TraceV3,
    VOM_FORMAT_VERSION,
};

/// Logical v2 identifier. Not a wire field — v2 envelopes omit `version`.
pub const TRACE_VERSION_V2: u32 = 2;

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
///
/// Classification matches [`RecordedTrace::classify_value`]: a numeric `version`
/// selects v3 (and forbids `pages[]`); otherwise the envelope is v2 and must
/// not include `states[]`.
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
        // Mirror classify_value: a numeric `version` selects v3; otherwise v2.
        // TraceV2 stays open for unknown extension fields but forbids `states[]`
        // and a numeric `version`. TraceV3 already denies `pages[]`.
        let mut version_props = schemars::Map::new();
        version_props.insert(
            "version".into(),
            schemars::schema::SchemaObject {
                instance_type: Some(schemars::schema::InstanceType::Integer.into()),
                ..Default::default()
            }
            .into(),
        );
        let mut required = schemars::Set::new();
        required.insert("version".into());

        schemars::schema::SchemaObject {
            subschemas: Some(Box::new(schemars::schema::SubschemaValidation {
                if_schema: Some(Box::new(
                    schemars::schema::SchemaObject {
                        object: Some(Box::new(schemars::schema::ObjectValidation {
                            properties: version_props,
                            required,
                            ..Default::default()
                        })),
                        ..Default::default()
                    }
                    .into(),
                )),
                then_schema: Some(Box::new(generator.subschema_for::<TraceV3>())),
                else_schema: Some(Box::new(generator.subschema_for::<TraceV2>())),
                ..Default::default()
            })),
            ..Default::default()
        }
        .into()
    }
}

/// One recorded step — v2 (`page`) or v3 (`state` / `result.state`).
///
/// Classification matches [`RecordedStep::classify_value`]: `state` selects v3
/// (and forbids `page`); otherwise the step is v2 and must include `page`.
#[derive(Debug, Clone, PartialEq)]
pub enum RecordedStep {
    V2(StepV2),
    V3(StepV3),
}

impl RecordedStep {
    pub fn classify_value(v: &serde_json::Value) -> Result<Self, String> {
        if v.get("state").is_some() {
            if v.get("page").is_some() {
                return Err("step v3 must not include legacy page".into());
            }
            return serde_json::from_value(v.clone())
                .map(RecordedStep::V3)
                .map_err(|e| e.to_string());
        }
        if v.get("page").is_some() {
            return serde_json::from_value(v.clone())
                .map(RecordedStep::V2)
                .map_err(|e| e.to_string());
        }
        Err("ambiguous or unparseable step".into())
    }
}

impl Serialize for RecordedStep {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            RecordedStep::V2(s) => s.serialize(serializer),
            RecordedStep::V3(s) => s.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for RecordedStep {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Self::classify_value(&value).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for RecordedStep {
    fn schema_name() -> String {
        "RecordedStep".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::schema::Schema {
        // Mirror classify_value: `state` selects v3; otherwise v2.
        // Mixed page + state is rejected at this layer because StepV2/StepV3
        // still allow unknown extension fields.
        let mut required = schemars::Set::new();
        required.insert("state".into());
        let mut mixed_keys = schemars::Set::new();
        mixed_keys.insert("page".into());
        mixed_keys.insert("state".into());

        schemars::schema::SchemaObject {
            subschemas: Some(Box::new(schemars::schema::SubschemaValidation {
                if_schema: Some(Box::new(
                    schemars::schema::SchemaObject {
                        object: Some(Box::new(schemars::schema::ObjectValidation {
                            required,
                            ..Default::default()
                        })),
                        ..Default::default()
                    }
                    .into(),
                )),
                then_schema: Some(Box::new(generator.subschema_for::<StepV3>())),
                else_schema: Some(Box::new(generator.subschema_for::<StepV2>())),
                not: Some(Box::new(
                    schemars::schema::SchemaObject {
                        object: Some(Box::new(schemars::schema::ObjectValidation {
                            required: mixed_keys,
                            ..Default::default()
                        })),
                        ..Default::default()
                    }
                    .into(),
                )),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    fn assert_classifies_by_integer_version(schema: &serde_json::Value) {
        assert_eq!(
            schema["if"]["required"],
            json!(["version"]),
            "numeric version is the RecordedTrace classification key"
        );
        assert_eq!(schema["if"]["properties"]["version"]["type"], "integer");
        assert_eq!(schema["then"]["$ref"], "#/definitions/TraceV3");
        assert_eq!(schema["else"]["$ref"], "#/definitions/TraceV2");
    }

    #[test]
    fn recorded_trace_schema_includes_v2_and_v3() {
        let schema = serde_json::to_value(schemars::schema_for!(RecordStopResult)).unwrap();
        assert_classifies_by_integer_version(&schema["definitions"]["RecordedTrace"]);
        assert_eq!(
            schema["definitions"]["TraceV3"]["properties"]["version"]["const"],
            3
        );
    }

    #[test]
    fn recorded_trace_schema_follows_classify_value() {
        let standalone = serde_json::to_value(schemars::schema_for!(RecordedTrace)).unwrap();
        assert_classifies_by_integer_version(&standalone);
        assert!(standalone["definitions"].get("TraceV2").is_some());
        assert!(standalone["definitions"].get("TraceV3").is_some());

        let stop_result = serde_json::to_value(schemars::schema_for!(RecordStopResult)).unwrap();
        assert_classifies_by_integer_version(&stop_result["definitions"]["RecordedTrace"]);
    }

    #[test]
    fn standalone_trace_schema_is_recorded_trace_union() {
        let schema = serde_json::to_value(schemars::schema_for!(RecordedTrace)).unwrap();
        assert_eq!(schema["title"], "RecordedTrace");
        assert_classifies_by_integer_version(&schema);
        assert!(schema["definitions"].get("TraceV2").is_some());
        assert!(schema["definitions"].get("TraceV3").is_some());
    }

    #[test]
    fn recorded_trace_accepts_v2_with_unknown_extension_fields() {
        let v2 = json!({
            "recorded_at": "2026-07-21T08:00:00Z",
            "entry": { "start_url": "https://example.com/" },
            "pages": [{ "id": "p1", "url": "https://example.com/" }],
            "steps": [],
            "meta": { "tool": "legacy-exporter" }
        });
        match RecordedTrace::classify_value(&v2).unwrap() {
            RecordedTrace::V2(trace) => assert_eq!(trace.pages.len(), 1),
            other => panic!("expected v2, got {other:?}"),
        }
    }

    fn v2_click() -> serde_json::Value {
        json!({
            "op": "click",
            "id": 1,
            "page": "p1",
            "target": { "tag": "button", "role": "button", "name": "发布" }
        })
    }

    fn v3_click() -> serde_json::Value {
        json!({
            "op": "click",
            "id": 1,
            "state": "s1",
            "result": { "state": "s2" },
            "target": { "ref": "e1", "role": "button", "name": "发布" }
        })
    }

    fn assert_step_classifies_by_state(schema: &serde_json::Value) {
        assert_eq!(
            schema["if"]["required"],
            json!(["state"]),
            "state is the RecordedStep classification key"
        );
        assert_eq!(schema["then"]["$ref"], "#/definitions/StepV3");
        assert_eq!(schema["else"]["$ref"], "#/definitions/StepV2");
        let mut forbidden = schema["not"]["required"]
            .as_array()
            .expect("RecordedStep schema must reject mixed page + state steps")
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>();
        forbidden.sort_unstable();
        assert_eq!(forbidden, ["page", "state"]);
    }

    #[test]
    fn recorded_step_classifies_v2_and_v3() {
        match RecordedStep::classify_value(&v2_click()).unwrap() {
            RecordedStep::V2(StepV2::Click { .. }) => {}
            other => panic!("expected v2 click, got {other:?}"),
        }
        match RecordedStep::classify_value(&v3_click()).unwrap() {
            RecordedStep::V3(StepV3::Click { .. }) => {}
            other => panic!("expected v3 click, got {other:?}"),
        }
    }

    #[test]
    fn recorded_step_rejects_mixed_page_and_state() {
        let mut mixed = v2_click();
        mixed["state"] = json!("s1");
        mixed["result"] = json!({ "state": "s2" });
        assert!(RecordedStep::classify_value(&mixed).is_err());
    }

    #[test]
    fn recorded_step_schema_follows_classify_value() {
        let schema = serde_json::to_value(schemars::schema_for!(RecordedStep)).unwrap();
        assert_eq!(schema["title"], "RecordedStep");
        assert_step_classifies_by_state(&schema);
        assert!(schema["definitions"].get("StepV2").is_some());
        assert!(schema["definitions"].get("StepV3").is_some());
    }
}
