//! Trace v2 — record-only user-action log with `pages[]` and step `page` refs.
//!
//! Legacy wire format with no top-level `version` field.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::interaction::KeyModifier;
use super::record_common::TraceEntry;

/// Stable semantic handle for an interacted element (v2).
///
/// `name` and `nearby_label` are **untrusted page text**.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TargetDescriptorV2 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_attr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nearby_label: Option<String>,
}

/// Page context dictionary entry — referenced by steps via `page` id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageRefV2 {
    pub id: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// One selected option (`select` op).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SelectedOptionV2 {
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Observed navigation after a step (objective fact only).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepEffectV2 {
    /// Reference into `pages[]` for the destination page.
    pub navigated_to: String,
}

/// Fields shared by every v2 step variant (flattened in JSON).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepCommonV2 {
    pub id: u32,
    /// Reference into `pages[]`.
    pub page: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<StepEffectV2>,
}

/// One recorded user action — discriminated union by `op` (v2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum StepV2 {
    Navigate {
        #[serde(flatten)]
        common: StepCommonV2,
        to: String,
    },
    Click {
        #[serde(flatten)]
        common: StepCommonV2,
        target: TargetDescriptorV2,
    },
    Hover {
        #[serde(flatten)]
        common: StepCommonV2,
        target: TargetDescriptorV2,
    },
    Fill {
        #[serde(flatten)]
        common: StepCommonV2,
        target: TargetDescriptorV2,
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    Select {
        #[serde(flatten)]
        common: StepCommonV2,
        target: TargetDescriptorV2,
        selection: Vec<SelectedOptionV2>,
    },
    Press {
        #[serde(flatten)]
        common: StepCommonV2,
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modifiers: Option<Vec<KeyModifier>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<TargetDescriptorV2>,
    },
}

/// Persisted user-action trace exported by legacy `tool.record_stop` / `await`.
///
/// Unknown extension fields are ignored so older traces remain readable.
/// `states[]` and a numeric `version` are reserved for Trace v3 / `RecordedTrace`
/// classification — serde still ignores them, but the JSON Schema rejects them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraceV2 {
    /// RFC 3339 timestamp when recording stopped.
    pub recorded_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    pub entry: TraceEntry,
    pub pages: Vec<PageRefV2>,
    pub steps: Vec<StepV2>,
}

fn constrain_trace_v2_schema(mut schema: schemars::schema::Schema) -> schemars::schema::Schema {
    let schemars::schema::Schema::Object(obj) = &mut schema else {
        return schema;
    };
    obj.metadata().title = Some("TraceV2".into());
    obj.metadata().description = Some(
        "Persisted user-action trace exported by legacy `tool.record_stop` / `await`.\n\n\
         Unknown extension fields are ignored so older traces remain readable. \
         `states[]` and a numeric `version` are reserved for Trace v3 / `RecordedTrace` classification."
            .into(),
    );

    let object = obj.object.get_or_insert_with(Default::default);
    object
        .properties
        .insert("states".into(), schemars::schema::Schema::Bool(false));
    object.properties.insert(
        "version".into(),
        schemars::schema::SchemaObject {
            metadata: Some(Box::new(schemars::schema::Metadata {
                description: Some(
                    "Numeric version selects Trace v3. Legacy v2 envelopes omit this field.".into(),
                ),
                ..Default::default()
            })),
            subschemas: Some(Box::new(schemars::schema::SubschemaValidation {
                not: Some(Box::new(
                    schemars::schema::SchemaObject {
                        instance_type: Some(schemars::schema::InstanceType::Integer.into()),
                        ..Default::default()
                    }
                    .into(),
                )),
                ..Default::default()
            })),
            ..Default::default()
        }
        .into(),
    );
    schema
}

impl JsonSchema for TraceV2 {
    fn schema_name() -> String {
        "TraceV2".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::schema::Schema {
        #[derive(JsonSchema)]
        #[allow(dead_code)]
        struct TraceV2Shape {
            /// RFC 3339 timestamp when recording stopped.
            recorded_at: String,
            started_at: Option<String>,
            purpose: Option<String>,
            entry: TraceEntry,
            pages: Vec<PageRefV2>,
            steps: Vec<StepV2>,
        }

        constrain_trace_v2_schema(TraceV2Shape::json_schema(generator))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_common(id: u32) -> StepCommonV2 {
        StepCommonV2 {
            id,
            page: "p1".into(),
            effect: None,
        }
    }

    fn sample_target() -> TargetDescriptorV2 {
        TargetDescriptorV2 {
            role: Some("button".into()),
            name: Some("发布".into()),
            tag: "button".into(),
            name_attr: None,
            placeholder: None,
            nearby_label: None,
        }
    }

    #[test]
    fn trace_v2_has_no_version_field() {
        let trace = TraceV2 {
            recorded_at: "2026-07-17T09:01:10Z".into(),
            started_at: None,
            purpose: None,
            entry: TraceEntry {
                start_url: "https://example.com/".into(),
            },
            pages: vec![PageRefV2 {
                id: "p1".into(),
                url: "https://example.com/".into(),
                title: None,
            }],
            steps: vec![StepV2::Click {
                common: sample_common(1),
                target: sample_target(),
            }],
        };
        let v = serde_json::to_value(&trace).unwrap();
        assert!(v.get("version").is_none());
        assert!(v.get("pages").is_some());
        assert!(v.get("states").is_none());
    }

    #[test]
    fn extension_v2_trace_deserializes() {
        let v = json!({
            "recorded_at": "2026-07-21T08:00:00Z",
            "started_at": "2026-07-21T07:59:00Z",
            "purpose": "demo",
            "entry": { "start_url": "https://example.com/editor" },
            "pages": [
                { "id": "p1", "url": "https://example.com/editor" },
                { "id": "p2", "url": "https://example.com/p/99" }
            ],
            "steps": [
                {
                    "op": "fill",
                    "id": 1,
                    "page": "p1",
                    "target": { "tag": "input", "role": "textbox", "name": "标题" },
                    "value": "hello"
                },
                {
                    "op": "click",
                    "id": 2,
                    "page": "p1",
                    "target": { "tag": "button", "role": "button", "name": "发布" },
                    "effect": { "navigated_to": "p2" }
                }
            ]
        });
        let trace: TraceV2 = serde_json::from_value(v).unwrap();
        assert_eq!(trace.pages.len(), 2);
        assert_eq!(trace.steps.len(), 2);
    }

    #[test]
    fn v2_hover_steps_round_trip() {
        let value = json!({
            "recorded_at": "2026-07-21T08:00:00Z",
            "entry": { "start_url": "https://example.com/" },
            "pages": [{ "id": "p1", "url": "https://example.com/" }],
            "steps": [{
                "op": "hover",
                "id": 1,
                "page": "p1",
                "target": { "tag": "span", "role": "button", "name": "Account" }
            }]
        });

        let trace: TraceV2 = serde_json::from_value(value).unwrap();
        assert!(matches!(trace.steps.as_slice(), [StepV2::Hover { .. }]));
        assert_eq!(
            serde_json::to_value(&trace).unwrap()["steps"][0]["op"],
            "hover"
        );
    }

    #[test]
    fn trace_v2_ignores_unknown_extension_fields() {
        let value = json!({
            "recorded_at": "2026-07-21T08:00:00Z",
            "entry": { "start_url": "https://example.com/" },
            "pages": [{ "id": "p1", "url": "https://example.com/" }],
            "steps": [],
            "meta": { "tool": "legacy-exporter" }
        });
        let trace: TraceV2 = serde_json::from_value(value).unwrap();
        assert_eq!(trace.pages.len(), 1);
        assert!(trace.steps.is_empty());
    }

    #[test]
    fn trace_v2_schema_allows_additional_properties() {
        let schema = serde_json::to_value(schemars::schema_for!(TraceV2)).unwrap();
        assert_ne!(
            schema.get("additionalProperties"),
            Some(&serde_json::Value::Bool(false)),
            "Trace v2 must keep accepting traces with unknown extension fields"
        );
    }

    #[test]
    fn trace_v2_schema_forbids_classification_keys() {
        let schema = serde_json::to_value(schemars::schema_for!(TraceV2)).unwrap();
        assert_eq!(
            schema["properties"]["states"],
            json!(false),
            "Trace v2 schema must reject states[] (reserved for v3)"
        );
        assert_eq!(
            schema["properties"]["version"]["not"]["type"], "integer",
            "Trace v2 schema must reject a numeric version (that selects the v3 path)"
        );
    }
}
