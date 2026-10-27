//! Shared-tab coordination. A context is explicit caller evidence, never inferred by the daemon.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CooperateAction {
    Enable,
    Status,
    Sync,
    Wait,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CooperateParams {
    pub session_id: String,
    pub action: CooperateAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}
