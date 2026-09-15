//! browser-skill wire protocol — frames, methods, tool payloads, handshake.

pub mod cancel;
pub mod error;
pub mod frame;
pub mod method;
pub mod system;
pub mod tools;

pub use cancel::{CancelParams, CancelResult};
pub use error::{DecodeError, ErrorCode, RpcError};
pub use frame::{EventFrame, EventKind, Frame, RequestFrame, ResponseBody, ResponseFrame, RpcId};
pub use method::Method;
pub use system::{
    BrowserListParams, BrowserPeerInfo, BrowserStatusEntry, DEFAULT_WAIT_CONTROL_MS,
    HandshakeCompat, HandshakeParams, HandshakeResult, MAX_WAIT_CONTROL_MS, PingParams, PingResult,
    SessionControl, SessionReturnReceipt, SessionStatusEntry, SessionStatusParams,
    SessionStatusResult, SessionWaitControlParams, SessionWaitControlResult, StatusParams,
    StatusResult, VersionSkewEntry, WaitControlOutcome, compare_protocol,
    evaluate_handshake_compat,
};
pub use tools::*;
