//! Bounded, opt-in website debugging. IDs are scoped to an active task.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DebugAction {
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
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pointer: Option<String>,
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
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_id: Option<String>,
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
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugOperation {
    pub id: String,
    pub run_id: String,
    pub sequence: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
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
    pub saved_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_error: Option<String>,
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
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DebugResult {
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
    pub next_since: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}
