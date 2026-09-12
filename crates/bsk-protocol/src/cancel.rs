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
