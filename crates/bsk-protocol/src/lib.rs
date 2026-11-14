//! browser-skill wire protocol — frames, methods, tool payloads, handshake.

pub mod cancel;
pub mod catalog;
pub mod error;
pub mod frame;
pub mod local_auth;
pub mod method;
pub mod system;
pub mod tools;

pub use cancel::{CancelParams, CancelResult};
pub use catalog::{MIN_COMPATIBLE_PROTOCOL, PROTOCOL_VERSION, is_protocol_compatible};
pub use error::{DecodeError, ErrorCode, RpcError, RpcErrorReason};
pub use frame::{EventFrame, EventKind, Frame, RequestFrame, ResponseBody, ResponseFrame, RpcId};
pub use method::{ActionMetadataPolicy, DeadlineKind, Method, OutcomeKind, RecipeStepKind};
pub use system::{
    BrowserListParams, BrowserPeerInfo, BrowserStatusEntry, HandshakeCompat, HandshakeParams,
    HandshakeResult, PingParams, PingResult, SessionStatusEntry, StatusParams, StatusResult,
    VersionSkewEntry, compare_protocol, evaluate_handshake_compat,
};
pub use tools::*;
