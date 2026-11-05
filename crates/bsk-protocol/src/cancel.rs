//! Generic JSON-RPC cancellation envelope.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::RpcId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CancelParams {
    pub rpc_id: RpcId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct CancelResult {
    pub cancelled: bool,
}

/// Prepare a one-use, method-bound local RPC ticket. No browser work is started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RpcPrepareParams {
    pub method: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RpcPrepareResult {
    pub rpc_id: RpcId,
    /// Time available to start the RPC; not its execution timeout.
    pub admission_ms: u64,
}
