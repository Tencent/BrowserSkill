//! Semantic user-action recording (`tool.record_start` / `stop` / `await`).
//!
//! Trace v2 is a **record-only** log of user actions: what was clicked, filled,
//! selected, and where navigation occurred. No LLM runs during recording, so
//! variable-vs-constant classification is **not** stored — executing agents
//! infer that at run time from raw values and control names.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::interaction::KeyModifier;

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/// Stable semantic handle for an interacted element.
///
/// `name` and `nearby_label` are **untrusted page text**.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TargetDescriptor {
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

// ---------------------------------------------------------------------------
// Trace envelope
// ---------------------------------------------------------------------------

/// Recording entry point — first URL the flow starts from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TraceEntry {
    pub start_url: String,
}

/// Page context dictionary entry — referenced by steps via `page` id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageRef {
    pub id: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// One selected option (`select` op).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SelectedOption {
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Observed navigation after a step (objective fact only).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepEffect {
    /// Reference into `pages[]` for the destination page.
    pub navigated_to: String,
}

/// Fields shared by every step variant (flattened in JSON).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepCommon {
    pub id: u32,
    /// Reference into `pages[]`.
    pub page: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<StepEffect>,
}

// ---------------------------------------------------------------------------
// Step op-specific payloads
// ---------------------------------------------------------------------------

/// One recorded user action — discriminated union by `op`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Step {
    Navigate {
        #[serde(flatten)]
        common: StepCommon,
        to: String,
    },
    Click {
        #[serde(flatten)]
        common: StepCommon,
        target: TargetDescriptor,
    },
    Fill {
        #[serde(flatten)]
        common: StepCommon,
        target: TargetDescriptor,
        value: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    Select {
        #[serde(flatten)]
        common: StepCommon,
        target: TargetDescriptor,
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
}

// ---------------------------------------------------------------------------
// Trace root
// ---------------------------------------------------------------------------

/// Persisted user-action trace exported by `tool.record_stop` / `await`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Trace {
    /// RFC 3339 timestamp when recording stopped.
    pub recorded_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// Optional user-provided goal from `--purpose` (metadata only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    pub entry: TraceEntry,
    pub pages: Vec<PageRef>,
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

    fn sample_common(id: u32) -> StepCommon {
        StepCommon {
            id,
            page: "p1".into(),
            effect: None,
        }
    }

    fn sample_target() -> TargetDescriptor {
        TargetDescriptor {
            role: Some("button".into()),
            name: Some("发布".into()),
            tag: "button".into(),
            name_attr: None,
            placeholder: None,
            nearby_label: None,
        }
    }

    fn sample_trace() -> Trace {
        Trace {
            recorded_at: "2026-07-17T09:01:10Z".into(),
            started_at: Some("2026-07-17T09:00:00Z".into()),
            purpose: Some("发布一篇文章".into()),
            entry: TraceEntry {
                start_url: "https://x.com/editor".into(),
            },
            pages: vec![
                PageRef {
                    id: "p1".into(),
                    url: "https://x.com/editor".into(),
                    title: Some("写文章".into()),
                },
                PageRef {
                    id: "p2".into(),
                    url: "https://x.com/p/99".into(),
                    title: None,
                },
            ],
            steps: vec![
                Step::Fill {
                    common: sample_common(1),
                    target: TargetDescriptor {
                        role: Some("textbox".into()),
                        name: Some("标题".into()),
                        tag: "input".into(),
                        name_attr: None,
                        placeholder: None,
                        nearby_label: None,
                    },
                    value: "我的第一篇文章".into(),
                    redacted: None,
                },
                Step::Select {
                    common: sample_common(3),
                    target: TargetDescriptor {
                        role: Some("combobox".into()),
                        name: Some("分类".into()),
                        tag: "select".into(),
                        name_attr: None,
                        placeholder: None,
                        nearby_label: None,
                    },
                    selection: vec![SelectedOption {
                        value: "tech".into(),
                        label: Some("技术分享".into()),
                    }],
                },
                Step::Click {
                    common: StepCommon {
                        effect: Some(StepEffect {
                            navigated_to: "p2".into(),
                        }),
                        ..sample_common(4)
                    },
                    target: sample_target(),
                },
            ],
        }
    }

    #[test]
    fn step_click_round_trips() {
        let step = Step::Click {
            common: sample_common(1),
            target: sample_target(),
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v.get("op").and_then(|v| v.as_str()), Some("click"));
        assert_eq!(v.get("page").and_then(|v| v.as_str()), Some("p1"));
        assert!(v.get("key").is_none());
        let round: Step = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn step_fill_with_raw_value_round_trips() {
        let step = Step::Fill {
            common: sample_common(2),
            target: TargetDescriptor {
                role: Some("textbox".into()),
                name: Some("服务名称".into()),
                tag: "input".into(),
                name_attr: Some("serviceName".into()),
                placeholder: None,
                nearby_label: None,
            },
            value: "my-svc".into(),
            redacted: None,
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["op"], "fill");
        assert_eq!(v["value"], "my-svc");
        let round: Step = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn step_fill_password_is_redacted() {
        let step = Step::Fill {
            common: sample_common(1),
            target: TargetDescriptor {
                role: Some("textbox".into()),
                name: Some("密码".into()),
                tag: "input".into(),
                name_attr: None,
                placeholder: None,
                nearby_label: None,
            },
            value: "***".into(),
            redacted: Some(true),
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["value"], "***");
        assert_eq!(v["redacted"], true);
    }

    #[test]
    fn step_select_uses_object_array() {
        let step = Step::Select {
            common: sample_common(3),
            target: TargetDescriptor {
                role: Some("combobox".into()),
                name: Some("分类".into()),
                tag: "select".into(),
                name_attr: None,
                placeholder: None,
                nearby_label: None,
            },
            selection: vec![SelectedOption {
                value: "tech".into(),
                label: Some("技术分享".into()),
            }],
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["selection"][0]["value"], "tech");
        assert_eq!(v["selection"][0]["label"], "技术分享");
        let round: Step = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn step_navigate_round_trips() {
        let step = Step::Navigate {
            common: sample_common(1),
            to: "https://example.com".into(),
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["op"], "navigate");
        assert_eq!(v["to"], "https://example.com");
        let round: Step = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn step_press_with_modifiers_round_trips() {
        let step = Step::Press {
            common: StepCommon {
                effect: Some(StepEffect {
                    navigated_to: "p2".into(),
                }),
                ..sample_common(2)
            },
            key: "Enter".into(),
            modifiers: Some(vec![KeyModifier::Ctrl, KeyModifier::Shift]),
            target: Some(sample_target()),
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["key"], "Enter");
        assert_eq!(v["modifiers"], json!(["ctrl", "shift"]));
        assert_eq!(v["effect"]["navigated_to"], "p2");
        let round: Step = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn trace_record_only_round_trips() {
        let trace = sample_trace();
        let v = serde_json::to_value(&trace).unwrap();
        assert!(v.get("version").is_none());
        assert_eq!(
            v.get("purpose").and_then(|v| v.as_str()),
            Some("发布一篇文章")
        );
        assert!(v.get("parameters").is_none());
        assert!(v.get("site").is_none());
        assert!(v.get("goal").is_none());
        assert_eq!(
            v.get("entry")
                .and_then(|e| e.get("start_url"))
                .and_then(|u| u.as_str()),
            Some("https://x.com/editor")
        );
        let round: Trace = serde_json::from_value(v).unwrap();
        assert_eq!(round, trace);
    }

    #[test]
    fn discriminated_union_click_ignores_extra_key_field() {
        let bad = json!({
            "op": "click",
            "id": 1,
            "page": "p1",
            "target": { "tag": "button", "name": "OK" },
            "key": "Enter"
        });
        let step: Step = serde_json::from_value(bad).unwrap();
        assert!(matches!(step, Step::Click { .. }));
        let v = serde_json::to_value(&step).unwrap();
        assert!(v.get("key").is_none());
    }

    #[test]
    fn extension_trace_deserializes() {
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
        let trace: Trace = serde_json::from_value(v).unwrap();
        assert_eq!(trace.entry.start_url, "https://example.com/editor");
        assert_eq!(trace.pages.len(), 2);
        assert_eq!(trace.steps.len(), 2);
    }
}
