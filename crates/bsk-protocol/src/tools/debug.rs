//! Bounded, opt-in website debugging. IDs are scoped to an active task.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DebugAction {
    Performance,
    Aggregate,
    Duplicates,
    Capabilities,
    Activity,
    Wait,
    Pin,
    Unpin,
    Start,
    Stop,
    Status,
    Requests,
    Request,
    Operations,
    Operation,
    Console,
    Pages,
    Export,
    Rules,
    RuleAdd,
    RuleEnable,
    RuleDisable,
    RuleRemove,
    Replay,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugParams {
    pub session_id: String,
    pub action: DebugAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0, max = 65536))]
    pub offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 16384))]
    pub max_chars: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pointer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<DebugRuleSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay: Option<DebugReplaySpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 4096, max = 262144))]
    pub budget: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0, max = 60000))]
    pub slow_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 100, max = 10000))]
    pub window_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_controlled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 100, max = 599))]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0, max = 60000))]
    pub wait_ms: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugBody {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chars: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redacted: Option<bool>,
    /// True only for complete retained text identical to the captured body.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_safe: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugRequestIntegrity {
    pub url: String,
    pub metadata: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugRequest {
    pub id: String,
    pub run_id: String,
    pub sequence: u64,
    pub started_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<f64>,
    pub method: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrity: Option<DebugRequestIntegrity>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_bytes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoded_bytes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_cache: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_service_worker: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirect_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initiator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_headers: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<BTreeMap<String, f64>>,
    pub request_body: DebugBody,
    pub response_body: DebugBody,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intervention: Option<DebugIntervention>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugConsole {
    pub id: String,
    pub at: f64,
    pub level: String,
    pub text: String,
    pub count: u64,
    pub last_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugField {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub state: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugPage {
    pub at: f64,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Vec<DebugField>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields_partial: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub navigation: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugOperation {
    pub id: String,
    pub run_id: String,
    pub sequence: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub started_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_end: Option<f64>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<DebugPage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<DebugPage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observations: Option<Vec<DebugPage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation_end: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation_limited: Option<bool>,
    pub request_ids: Vec<String>,
    pub console_ids: Vec<String>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugRun {
    pub id: String,
    pub session_id: String,
    pub tab_id: i64,
    pub name: String,
    pub url: String,
    pub started_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<f64>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub requests: u64,
    pub operations: u64,
    pub errors: u64,
    pub dropped_requests: u64,
    pub dropped_operations: u64,
    pub dropped_console: u64,
    pub coverage: Vec<String>,
    pub next_since: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_rules: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<BTreeMap<String, String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugRecording {
    pub version: u32,
    pub saved_at: f64,
    pub run: DebugRun,
    pub requests: Vec<DebugRequest>,
    pub operations: Vec<DebugOperation>,
    pub console: Vec<DebugConsole>,
    pub pages: Vec<DebugPage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<DebugRule>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replays: Option<Vec<DebugReplay>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub performance: Option<Vec<DebugPerformance>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugValue {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugFieldTrace {
    pub key: String,
    pub label: String,
    pub before: DebugValue,
    pub input: DebugValue,
    pub submitted: Vec<DebugValue>,
    pub response: Vec<DebugValue>,
    pub later: DebugValue,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugPayload {
    pub request_id: String,
    pub part: String,
    pub path: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugRequestLink {
    pub request_id: String,
    pub relation: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugTextChanges {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugEvidence {
    pub fields: Vec<DebugFieldTrace>,
    pub payloads: Vec<DebugPayload>,
    pub links: Vec<DebugRequestLink>,
    pub gaps: Vec<String>,
    pub changes: DebugTextChanges,
    pub observations: Vec<DebugPage>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggregates: Option<Vec<DebugEndpoint>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicates: Option<Vec<DebugDuplicate>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis: Option<DebugAnalysis>,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<DebugRun>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runs: Option<Vec<DebugRun>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests: Option<Vec<DebugRequest>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<DebugRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operations: Option<Vec<DebugOperation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<DebugOperation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub console: Option<Vec<DebugConsole>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<Vec<DebugPage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording: Option<DebugRecording>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<DebugEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<DebugRule>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replays: Option<Vec<DebugReplay>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub performance: Option<Vec<DebugPerformance>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay: Option<DebugReplay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_since: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity: Option<DebugActivity>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DebugRuleMatch {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DebugJsonEdit {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remove: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rename: Option<BTreeMap<String, String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum DebugRuleEffect {
    Block,
    Modify {
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        method: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        headers: Option<BTreeMap<String, Option<String>>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        json: Option<DebugJsonEdit>,
    },
    Mock {
        status: u16,
        body: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        headers: Option<BTreeMap<String, String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        delay_ms: Option<u32>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugRuleSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(rename = "match")]
    pub matcher: DebugRuleMatch,
    pub effect: DebugRuleEffect,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub times: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugRule {
    #[serde(flatten)]
    pub spec: DebugRuleSpec,
    pub id: String,
    pub state: String,
    pub hits: u32,
    pub failures: u32,
    pub created_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DebugReplaySpec {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, Option<String>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugReplay {
    pub id: String,
    pub key: String,
    pub source_request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugIntervention {
    pub rule_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<Vec<String>>,
}

/// Daemon-owned execution status. Waiting observes completion; it never resends a command.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugActivity {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_timed_out: Option<bool>,
}

pub fn debug_parameter_schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(DebugParams)).expect("debug schema serializes")
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugMetric {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    pub state: String,
    pub reasons: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugVisibility {
    pub at: f64,
    pub state: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugLongTask {
    pub at: f64,
    pub duration_ms: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugPerformance {
    pub id: String,
    pub document_key: String,
    pub sequence: u64,
    pub time_origin: f64,
    pub started_at: f64,
    pub observed_at: f64,
    pub url: String,
    pub navigation: String,
    pub state: String,
    pub early: bool,
    pub scope: String,
    pub visibility: Vec<DebugVisibility>,
    pub visibility_truncated: bool,
    pub metrics: BTreeMap<String, DebugMetric>,
    pub long_tasks: Vec<DebugLongTask>,
    pub long_tasks_truncated: bool,
    pub coverage: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugDurationStats {
    pub min: f64,
    pub mean: f64,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
    pub total: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugEndpoint {
    pub id: String,
    pub method: String,
    pub endpoint: String,
    pub count: u64,
    pub failed: u64,
    pub http_errors: u64,
    pub pending: u64,
    pub interrupted: u64,
    pub statuses: BTreeMap<String, u64>,
    pub slow: u64,
    pub timing_samples: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<DebugDurationStats>,
    pub transfer_bytes: f64,
    pub transfer_samples: u64,
    pub cached: u64,
    pub service_worker: u64,
    pub controlled: u64,
    pub replayed: u64,
    pub request_ids: Vec<String>,
    pub refs_truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugDuplicate {
    pub id: String,
    pub method: String,
    pub url: String,
    pub count: u64,
    pub extra_requests: u64,
    pub started_at: f64,
    pub ended_at: f64,
    pub overlap_count: u64,
    pub possible_retry: bool,
    pub request_ids: Vec<String>,
    pub operation_ids: Vec<String>,
    pub refs_truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugAnalysis {
    pub retained: u64,
    pub matched: u64,
    pub included: u64,
    pub excluded_controlled: u64,
    pub uncomparable: u64,
    pub groups: u64,
    pub suspected_extra_requests: u64,
    pub window_ms: u32,
    pub slow_ms: u32,
    pub coverage: Vec<String>,
    pub semantics: String,
}

#[cfg(test)]
mod fidelity_tests {
    use super::DebugRequest;
    use serde_json::{from_value, json, to_value};

    #[test]
    fn request_fidelity_survives_cli_serialization_and_legacy_fields_stay_absent() {
        let mut value = json!({
            "id": "d:n1", "run_id": "d", "sequence": 1, "started_at": 1.0,
            "method": "POST", "url": "https://site.test/save", "state": "complete",
            "integrity": { "url": "truncated", "metadata": "complete" },
            "request_body": {
                "state": "available", "replay_safe": true,
                "text": "{\"orderId\":9007199254740993}"
            },
            "response_body": { "state": "empty" }
        });
        let request: DebugRequest = from_value(value.clone()).unwrap();
        assert_eq!(to_value(request).unwrap(), value);
        value.as_object_mut().unwrap().remove("integrity");
        value["request_body"]
            .as_object_mut()
            .unwrap()
            .remove("replay_safe");
        let legacy: DebugRequest = from_value(value.clone()).unwrap();
        assert!(legacy.integrity.is_none());
        assert!(legacy.request_body.replay_safe.is_none());
        assert_eq!(to_value(legacy).unwrap(), value);
    }
}
