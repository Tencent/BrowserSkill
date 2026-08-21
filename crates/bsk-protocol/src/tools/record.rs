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
    fn standalone_trace_schema_is_recorded_trace_union() {
        let schema = serde_json::to_value(schemars::schema_for!(RecordedTrace)).unwrap();
        assert_eq!(schema["title"], "RecordedTrace");
        let variants = schema["oneOf"]
            .as_array()
            .expect("standalone trace schema should be a v2|v3 oneOf");
        assert_eq!(variants.len(), 2);
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
}
