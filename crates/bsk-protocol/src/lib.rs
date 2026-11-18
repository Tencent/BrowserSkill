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
    AuditContextEvent, DialogChangedEvent, EmptyEventPayload, EventFrame, EventKind, Frame,
    RequestFrame, ResponseBody, ResponseFrame, RpcId, SessionActivityEvent, SessionEndedEvent,
    SessionEndedReason, SessionInteractionChangedEvent, SessionUserInterruptEvent,
    SessionWindowClosedEvent, SessionWindowClosedReason, WsCorrelation,
};
pub use local_auth::{
    LOCAL_AUTH_KDF_DOMAIN, LocalAuthDevicesParams, LocalAuthDevicesResult, LocalAuthMode,
    LocalAuthPairParams, LocalAuthPairResult, LocalAuthRevokeParams, LocalAuthRevokeResult,
    LocalAuthRotateParams, LocalAuthRotateResult, LocalAuthSetModeParams, LocalAuthSetModeResult,
    PairedDeviceStatus, PairedDeviceSummary,
};
pub use method::{ActionMetadataPolicy, DeadlineKind, Method, OutcomeKind, RecipeStepKind};
pub use system::{
    AuditEvent, AuditRequestParams, AuditRequestResult, AuditRun, BrowserListParams,
    BrowserListResult, BrowserPeerInfo, BrowserStatusEntry, DaemonSessionStartParams,
    DaemonSessionStartResult, DaemonSessionStartTrackedParams, DaemonSessionStopAllParams,
    DaemonSessionStopFailure, DaemonSessionStopParams, DaemonSessionStopResult, HandshakeCompat,
    HandshakeParams, HandshakeResult, IntentState, LedgerEntry, LedgerRequestParams,
    LedgerRequestResult, LedgerResolveReply, LedgerStatusReply, LoggedStep, LoggedTarget,
    PingParams, PingResult, RunLog, SessionListParams, SessionListResult, SessionRequestAction,
    SessionRequestParams, SessionRequestResult, SessionRequestState, SessionRunLogParams,
    SessionStatusEntry, StatusParams, StatusResult, VersionSkewEntry, compare_protocol,
    evaluate_handshake_compat,
};
pub use tools::*;
