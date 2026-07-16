//! Semantic user-action recording (`tool.record_start` / `stop` / `await`).
//!
//! Traces describe what the user did in human/LLM-readable terms (role, visible
//! name, tag) — not CSS selectors or `@eN` refs. There is no mechanical replay
//! in this phase. Variable inputs are left for a downstream LLM to infer from
//! control names + example values (no `parameters[]` slot extraction here).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::interaction::KeyModifier;

/// Stable semantic handle for an interacted element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TargetDescriptor {
    /// Accessibility / ARIA role when known (`button`, `textbox`, `link`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Visible accessible name (label, button text, `aria-label`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// HTML tag name, lowercased (`input`, `button`, `a`, …).
    pub tag: String,
    /// `name` attribute when present (form fields).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_attr: Option<String>,
    /// Placeholder text when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// Nearby visible label text when inferred.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nearby_label: Option<String>,
}

/// Entry-point context for the recorded flow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TraceEntry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_url_pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
}

/// Coarse page role for LLM textbook steps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PageRole {
    Home,
    List,
    Editor,
    Dialog,
    Other,
}

/// Page context attached to a step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PageContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<PageRole>,
}

/// Side effect of a step (typically navigation).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StepEffect {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub navigated_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_pattern_after: Option<String>,
}

/// Navigate destination.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NavDestination {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_pattern: Option<String>,
}

/// High-level intent of a textbook step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TraceIntent {
    OpenEntry,
    Navigate,
    Search,
    OpenItem,
    ProvideInput,
    Toggle,
    Confirm,
    SubmitKey,
    Other,
}

/// Whether the step should stay in the exported textbook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TraceImportance {
    Essential,
    Optional,
}

/// Action kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TraceOp {
    Click,
    Fill,
    Press,
    Select,
    Navigate,
}

/// One recorded user action (trace v3 flat textbook step).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TraceStep {
    pub id: u32,
    pub op: TraceOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<TraceIntent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub importance: Option<TraceImportance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<PageContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<TargetDescriptor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<StepEffect>,
    /// fill
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
    /// press
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    /// select
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    /// navigate
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<NavDestination>,
}

/// Persisted semantic action trace exported by `tool.record_stop` / `await`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Trace {
    /// Schema version — LLM textbook traces are `3`.
    pub version: u32,
    /// Optional user-provided goal for post-hoc LLM context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    /// RFC 3339 timestamp when recording stopped.
    pub recorded_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<TraceEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    pub steps: Vec<TraceStep>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordStartParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Optional URL to navigate before recording begins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Optional goal text stored on the exported trace for LLM context.
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
    /// Max wait for the user to finish recording in the browser (milliseconds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordAwaitResult {
    pub trace: Trace,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    #[test]
    fn trace_step_click_round_trips() {
        let step = TraceStep {
            id: 1,
            op: TraceOp::Click,
            intent: Some(TraceIntent::Confirm),
            importance: Some(TraceImportance::Essential),
            page: None,
            summary: Some("点击「发布」按钮".into()),
            target: Some(sample_target()),
            effect: Some(StepEffect {
                navigated_to: Some("https://example.com/p/1".into()),
                url_pattern_after: Some("https://example.com/p/*".into()),
            }),
            value: None,
            redacted: None,
            key: None,
            modifiers: None,
            values: None,
            labels: None,
            destination: None,
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v.get("op").and_then(|v| v.as_str()), Some("click"));
        assert!(v.get("selector").is_none());
        let round: TraceStep = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn trace_step_fill_round_trips() {
        let step = TraceStep {
            id: 2,
            op: TraceOp::Fill,
            intent: Some(TraceIntent::ProvideInput),
            importance: Some(TraceImportance::Essential),
            page: None,
            summary: Some("在「服务名称」输入框填入 my-svc".into()),
            target: Some(TargetDescriptor {
                role: Some("textbox".into()),
                name: Some("服务名称".into()),
                tag: "input".into(),
                name_attr: Some("serviceName".into()),
                placeholder: None,
                nearby_label: None,
            }),
            effect: None,
            value: Some("my-svc".into()),
            redacted: None,
            key: None,
            modifiers: None,
            values: None,
            labels: None,
            destination: None,
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v.get("op").and_then(|v| v.as_str()), Some("fill"));
        let round: TraceStep = serde_json::from_value(v).unwrap();
        assert_eq!(round, step);
    }

    #[test]
    fn purpose_omitted_when_none() {
        let trace = Trace {
            version: 3,
            purpose: None,
            recorded_at: "2026-07-13T03:00:00Z".into(),
            entry: Some(TraceEntry {
                start_url: Some("https://example.com".into()),
                start_url_pattern: Some("https://example.com/".into()),
                site: Some("example.com".into()),
            }),
            tab_id: Some(1),
            steps: vec![],
        };
        let v = serde_json::to_value(&trace).unwrap();
        assert!(v.get("purpose").is_none());
        assert!(v.get("parameters").is_none());
        assert_eq!(v.get("version").and_then(|v| v.as_u64()), Some(3));
    }

    #[test]
    fn purpose_serialized_when_set() {
        let trace = Trace {
            version: 3,
            purpose: Some("这是一个在 p6n 发布服务的操作流程。".into()),
            recorded_at: "2026-07-13T03:00:00Z".into(),
            entry: None,
            tab_id: None,
            steps: vec![TraceStep {
                id: 1,
                op: TraceOp::Navigate,
                intent: Some(TraceIntent::OpenEntry),
                importance: Some(TraceImportance::Essential),
                page: None,
                summary: Some("打开起始页".into()),
                target: None,
                effect: None,
                value: None,
                redacted: None,
                key: None,
                modifiers: None,
                values: None,
                labels: None,
                destination: Some(NavDestination {
                    url: "https://example.com".into(),
                    url_pattern: Some("https://example.com/".into()),
                }),
            }],
        };
        let v = serde_json::to_value(&trace).unwrap();
        assert_eq!(
            v.get("purpose").and_then(|v| v.as_str()),
            Some("这是一个在 p6n 发布服务的操作流程。")
        );
        let round: Trace = serde_json::from_value(v).unwrap();
        assert_eq!(round, trace);
    }

    #[test]
    fn press_with_target_and_modifiers_round_trips() {
        let step = TraceStep {
            id: 3,
            op: TraceOp::Press,
            intent: Some(TraceIntent::SubmitKey),
            importance: Some(TraceImportance::Essential),
            page: None,
            summary: Some("按下 Enter".into()),
            target: Some(sample_target()),
            effect: Some(StepEffect {
                navigated_to: Some("https://example.com/next".into()),
                url_pattern_after: None,
            }),
            value: None,
            redacted: None,
            key: Some("Enter".into()),
            modifiers: Some(vec![KeyModifier::Ctrl, KeyModifier::Shift]),
            values: None,
            labels: None,
            destination: None,
        };
        let value = serde_json::to_value(&step).unwrap();
        assert_eq!(value["key"], "Enter");
        assert_eq!(value["modifiers"], json!(["ctrl", "shift"]));
        let round: TraceStep = serde_json::from_value(value).unwrap();
        assert_eq!(round, step);
    }
}
