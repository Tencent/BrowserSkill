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
pub use catalog::{
    DEFAULT_DAEMON_PORT, DEFAULT_DAEMON_WS_URL, EXTENSION_CLIENT_ID, INSTANCE_ID_HEX_LENGTH,
    LOCAL_PAIRING_FRAGMENT_PREFIX, MIN_COMPATIBLE_PROTOCOL, PROTOCOL_VERSION,
    REMOTE_AUTH_SUBPROTOCOL_PREFIX, is_protocol_compatible,
};
pub use error::{
    DecodeError, ErrorCode, JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS,
    JSONRPC_INVALID_REQUEST, JSONRPC_METHOD_NOT_FOUND, JSONRPC_PARSE_ERROR, RpcError,
    RpcErrorReason,
};
pub use frame::{
    EventFrame, EventKind, Frame, RequestFrame, ResponseBody, ResponseFrame, RpcId, WsCorrelation,
};
pub use local_auth::LOCAL_AUTH_KDF_DOMAIN;
pub use method::{ActionMetadataPolicy, DeadlineKind, Method, OutcomeKind, RecipeStepKind};
pub use system::{
    BrowserListParams, BrowserPeerInfo, BrowserStatusEntry, HandshakeCompat, HandshakeParams,
    HandshakeResult, PingParams, PingResult, SessionStatusEntry, StatusParams, StatusResult,
    VersionSkewEntry, compare_protocol, evaluate_handshake_compat,
};
pub use tools::*;
