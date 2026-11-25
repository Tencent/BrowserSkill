//! Semantic user-action recording (`tool.record_start` / `stop` / `await`).
//!
//! Wire traces always use Trace v3 (`version: 3`, `states[]`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use super::record_common::TraceEntry;
pub use super::record_v3::{
    FillCommit, NavigationCause, RecorderInfo, SelectedOptionV3, StepCommonV3, StepResultV3,
    StepV3, StopReason, TRACE_VERSION_V3, TargetDescriptorV3, TraceStateV3, TraceV3,
    VOM_FORMAT_VERSION,
};

// ---------------------------------------------------------------------------
// RPC params / results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct RecordStopParams {
    pub session_id: String,
}

/// Wire trace payload (Trace v3, `version: 3`, `states[]`).
pub type RecordedTrace = TraceV3;

/// One recorded user-action step in a Trace v3 recording.
pub type RecordedStep = StepV3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RecordStopResult {
    pub trace: RecordedTrace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
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
    fn step_switch_tab_round_trips() {
        let step = StepV3::SwitchTab {
            common: sample_common(2, "s2", "s5"),
        };
        let v = serde_json::to_value(&step).unwrap();
        assert_eq!(v["op"], "switch_tab");
        assert_eq!(v["state"], "s2");
        assert_eq!(v["result"]["state"], "s5");
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
    fn record_start_rejects_legacy_v2_fields() {
        let minimal = RecordStartParams {
            session_id: "session".into(),
            tab_id: None,
            url: None,
            purpose: None,
            max_page_tokens: Some(4_000),
            redact_values: Some(true),
        };
        let value = serde_json::to_value(minimal).unwrap();
        assert_eq!(value["max_page_tokens"], 4_000);
        assert_eq!(value["redact_values"], true);

        let legacy_wire = json!({
            "session_id": "session",
            "trace_version": 2
        });
        assert!(serde_json::from_value::<RecordStartParams>(legacy_wire).is_err());

        let legacy_switch = json!({
            "session_id": "session",
            "supports_tab_switch_steps": true
        });
        assert!(serde_json::from_value::<RecordStartParams>(legacy_switch).is_err());
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
    fn trace_v3_rejects_unsupported_version() {
        let unsupported = json!({
            "version": 2,
            "recorded_at": "2026-07-21T08:00:00Z",
            "stopped_by": "user_finish",
            "entry": { "start_url": "https://example.com/" },
            "recorder": { "bsk": "0.1.10", "vom": 1 },
            "states": [],
            "steps": []
        });
        assert!(serde_json::from_value::<TraceV3>(unsupported).is_err());
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
