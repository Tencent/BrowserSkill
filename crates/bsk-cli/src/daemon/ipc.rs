//! JSON-line IPC server: CLI ↔ daemon transport.
//!
//! On Unix the server binds a `SOCK_STREAM` UDS at
//! [`paths::sock_path`](crate::daemon::paths::sock_path); on Windows it
//! exposes a per-user named pipe from [`paths::pipe_name`].
//!
//! Wire format per connection:
//! * one frame per line (`\n`-terminated UTF-8 JSON);
//! * frames are decoded as [`bsk_protocol::Frame::Request`] and dispatched
//!   to the [`RpcHandler`] callback;
//! * the handler returns a [`ResponseBody`] which is written back as a
//!   single line.
//!
//! Methods served by the production handler:
//! * `system.ping` / `system.status` (M2/M3 lifecycle metadata)
//! * `session.start` / `session.stop` / `session.stop_all` / `session.list` (M5)
//! * `browser.list` (M4)

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bsk_protocol::system::{
    BrowserListParams, BrowserStatusEntry, SessionStatusEntry, StatusParams, StatusResult,
    VersionSkewEntry,
};
use bsk_protocol::tools::{ReturnFailure, WaitMsParams, WaitMsResult};
use bsk_protocol::{
    CancelParams, CancelResult, ErrorCode, Method, PingResult, ResponseBody, RpcError, RpcId,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tracing::{debug, warn};

use super::abort::AbortRegistry;
use super::queue::{DEFAULT_TOOL_TIMEOUT, DispatchError};
use super::sessions::{
    SessionId, StartSessionError, StopSessionError, snapshot_status_entries, start_session,
    stop_session,
};
use super::state::{DAEMON_VERSION, DaemonState, PROTOCOL_VERSION};

/// Handler type: async fn(rpc_id, method, params) -> ResponseBody.
///
/// The `rpc_id` is the wire correlation id the IPC connection
/// allocated; daemon-side long-runners (M9.3 `tool.wait_ms`) register
/// an `AbortToken` against it so a peer `cancel { rpc_id }` can trip
/// them. Handlers that do not need it ignore the argument.
pub type RpcHandler = Arc<
    dyn Fn(RpcId, Method, Value) -> Pin<Box<dyn Future<Output = ResponseBody> + Send>>
        + Send
        + Sync
        + 'static,
>;

const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(15);
/// Upper bound on `wait_for_browser_ms` accepted over IPC.
const MAX_BROWSER_WAIT: Duration = Duration::from_secs(60);
// `session.stop` fast-fails while another tool is active; this budget
// only needs to cover the stop RPC itself and IPC scheduling grace.
const DEFAULT_SESSION_STOP_TIMEOUT: Duration =
    Duration::from_secs(DEFAULT_TOOL_TIMEOUT.as_secs() + DEFAULT_RPC_TIMEOUT.as_secs() + 5);

/// Snapshot of daemon-side bookkeeping needed to answer `system.status`.
///
/// The lifecycle / process metadata (pid, ws_port, sock_path, …) is owned
/// here; the live browser + session lists are read out of [`DaemonState`]
/// at request time so the snapshot never goes stale.
#[derive(Debug, Clone)]
pub struct DaemonStatus {
    pub started_at: Instant,
    pub ws_port: u16,
    pub sock_path: PathBuf,
    pub daemon_version: &'static str,
    pub protocol_version: &'static str,
}

impl DaemonStatus {
    /// Build a `StatusResult` snapshot WITHOUT touching the daemon state
    /// (used by the system-only handler in tests). Browsers and sessions
    /// fields are empty.
    pub fn snapshot(&self) -> StatusResult {
        StatusResult {
            daemon_version: self.daemon_version.to_string(),
            protocol_version: self.protocol_version.to_string(),
            pid: std::process::id(),
            uptime_secs: self.started_at.elapsed().as_secs(),
            ws_port: self.ws_port,
            sock_path: self.sock_path.to_string_lossy().into_owned(),
            browsers: Vec::new(),
            sessions: Vec::new(),
            version_skew_browsers: Vec::new(),
        }
    }

    /// Full snapshot including the current browser + session tables.
    pub fn snapshot_with(&self, state: &DaemonState) -> StatusResult {
        let mut version_skew_browsers: Vec<VersionSkewEntry> = Vec::new();
        let browsers: Vec<BrowserStatusEntry> = state
            .browsers
            .snapshot()
            .into_iter()
            .map(|client| {
                let count = state.sessions.count_for_browser(&client.id);
                if client.version_skew {
                    version_skew_browsers.push(VersionSkewEntry {
                        instance_id: client.id.0.clone(),
                        browser_name: client.browser_name.clone(),
                        label: client.label.clone(),
                        server_version: self.daemon_version.to_string(),
                        client_version: client.extension_version.clone(),
                        server_protocol_version: self.protocol_version.to_string(),
                        client_protocol_version: client.extension_protocol_version.clone(),
                    });
                }
                client.status_entry(count)
            })
            .collect();
        let sessions: Vec<SessionStatusEntry> = state
            .sessions
            .snapshot()
            .into_iter()
            .map(|s| s.status_entry())
            .collect();
        StatusResult {
            daemon_version: self.daemon_version.to_string(),
            protocol_version: self.protocol_version.to_string(),
            pid: std::process::id(),
            uptime_secs: self.started_at.elapsed().as_secs(),
            ws_port: self.ws_port,
            sock_path: self.sock_path.to_string_lossy().into_owned(),
            browsers,
            sessions,
            version_skew_browsers,
        }
    }
}

/// Minimal handler answering only `system.ping`. Used by older tests
/// that don't care about the status payload.
pub fn default_ping_handler() -> RpcHandler {
    Arc::new(|_rpc_id, method, _params| {
        Box::pin(async move {
            match method {
                Method::SystemPing => {
                    let result = PingResult { pong: true };
                    ResponseBody::Ok(serde_json::to_value(result).unwrap_or(Value::Null))
                }
                other => ResponseBody::Err(RpcError {
                    code: ErrorCode::UnknownMethod,
                    message: format!("method not implemented yet: {other:?}"),
                    data: None,
                }),
            }
        })
    })
}

/// Build a system-only handler bound to a daemon status snapshot. The
/// browsers/sessions fields of the reply are empty (test helper for
/// callers that don't carry a [`DaemonState`]).
pub fn system_handler(status: DaemonStatus) -> RpcHandler {
    Arc::new(move |_rpc_id, method, _params| {
        let status = status.clone();
        Box::pin(async move {
            match method {
                Method::SystemPing => {
                    let result = PingResult { pong: true };
                    ResponseBody::Ok(serde_json::to_value(result).unwrap_or(Value::Null))
                }
                Method::SystemStatus => {
                    let result = status.snapshot();
                    ResponseBody::Ok(serde_json::to_value(result).unwrap_or(Value::Null))
                }
                other => ResponseBody::Err(RpcError {
                    code: ErrorCode::UnknownMethod,
                    message: format!("method not implemented yet: {other:?}"),
                    data: None,
                }),
            }
        })
    })
}

/// Build the production handler: `system.*` plus M4 (`browser.list`),
/// M5 (`session.*`), M6–M9 tool methods, and the M9.3 daemon-local
/// `tool.wait_ms` / `cancel` paths.
pub fn full_handler(status: DaemonStatus, state: Arc<DaemonState>) -> RpcHandler {
    Arc::new(move |rpc_id, method, params| {
        let status = status.clone();
        let state = Arc::clone(&state);
        Box::pin(async move {
            match method {
                Method::SystemPing => {
                    let result = PingResult { pong: true };
                    ResponseBody::Ok(serde_json::to_value(result).unwrap_or(Value::Null))
                }
                Method::SystemStatus => match handle_status(&status, &state, params).await {
                    Ok(v) => ResponseBody::Ok(v),
                    Err(e) => ResponseBody::Err(e),
                },
                Method::SessionStart => match handle_session_start(&state, params).await {
                    Ok(v) => ResponseBody::Ok(v),
                    Err(e) => ResponseBody::Err(e),
                },
                Method::SessionStop => match handle_session_stop(&state, params).await {
                    Ok(v) => ResponseBody::Ok(v),
                    Err(e) => ResponseBody::Err(e),
                },
                Method::SessionStopAll => match handle_session_stop_all(&state).await {
                    Ok(v) => ResponseBody::Ok(v),
                    Err(e) => ResponseBody::Err(e),
                },
                Method::SessionList => handle_session_list(&state),
                Method::BrowserList => match handle_browser_list(&state, params).await {
                    Ok(v) => ResponseBody::Ok(v),
                    Err(e) => ResponseBody::Err(e),
                },
                Method::ToolTabList
                | Method::ToolTabCreate
                | Method::ToolTabClose
                | Method::ToolTabSelect
                | Method::ToolTabBorrow
                | Method::ToolTabReturn
                | Method::ToolScreenshot
                | Method::ToolConsole
                | Method::ToolSnapshot
                | Method::ToolGetHtml
                | Method::ToolNavigate
                | Method::ToolNavigateBack
                | Method::ToolNavigateForward
                | Method::ToolReload
                | Method::ToolClick
                | Method::ToolFill
                | Method::ToolPress
                | Method::ToolSelect
                | Method::ToolEvaluate
                | Method::ToolWaitForNavigation
                | Method::ToolRequestHelp => {
                    handle_tool_dispatch(&state, rpc_id, method, params).await
                }
                Method::ToolWaitMs => handle_wait_ms(&state.abort_registry, rpc_id, params).await,
                Method::Cancel => handle_cancel(&state, params),
                other => ResponseBody::Err(RpcError {
                    code: ErrorCode::UnknownMethod,
                    message: format!("method not implemented yet: {other:?}"),
                    data: None,
                }),
            }
        })
    })
}

/// IPC entry point for `tool.*` RPCs (M6+). Looks up the per-session
/// dispatch queue and forwards the call; never touches the
/// BrowserSink directly. `tool.session_start` / `tool.session_stop`
/// stay on the direct path because they manage the queue lifecycle
/// itself.
///
/// Registers a fresh [`super::inflight::ToolInflightEntry`] BEFORE
/// the per-session queue takes over so a `cancel { rpc_id }` arriving
/// while the job is still queued has something to trip — that's the
/// fix for review C2 (queued cancels were previously invisible to
/// `handle_cancel`). The same entry covers the in-flight phase too,
/// so the worker can short-circuit via its cancel token instead of
/// hand-rolling a second mechanism.
async fn handle_tool_dispatch(
    state: &Arc<DaemonState>,
    cli_rpc_id: RpcId,
    method: Method,
    params: Value,
) -> ResponseBody {
    let session_id = match params.get("session_id").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => SessionId(s.to_string()),
        _ => {
            return ResponseBody::Err(RpcError {
                code: ErrorCode::InvalidParams,
                message: "tool.* RPC requires non-empty session_id".into(),
                data: None,
            });
        }
    };
    // Pre-flight: if the user has clicked the agent-window mask's
    // stop button, every session carries a one-shot "pending
    // interrupt" marker. The marker is consumed by the next
    // *mutating* tool call (which is rejected with `UserAborted`).
    // Read-only tools (snapshot / get_html / waits / tab_list) and
    // session-lifecycle RPCs pass through transparently — gating
    // them would prevent the agent from observing page state
    // before asking the user, or from cleanly tearing down the
    // session. Classification lives on `Method::is_mutating()` so
    // adding a new tool variant requires an explicit
    // classification call.
    if method.is_mutating() && state.session_interrupts.try_consume(&session_id) {
        return ResponseBody::Err(RpcError {
            code: ErrorCode::UserAborted,
            message: "tool dispatch rejected: pending user interrupt. The user explicitly requested to stop. Ask the user how to proceed before issuing further actions.".into(),
            data: None,
        });
    }
    let timeout = match tool_dispatch_timeout(&params) {
        Ok(timeout) => timeout,
        Err(err) => return ResponseBody::Err(err),
    };
    let inflight_guard = match state.tool_inflight.register(cli_rpc_id, session_id.clone()) {
        Ok(guard) => guard,
        Err(err) => {
            return ResponseBody::Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: format!("inflight registration rejected: {err}"),
                data: None,
            });
        }
    };
    let entry = inflight_guard.entry();
    let outcome = state
        .tool_queues
        .dispatch(&session_id, method, params, timeout, Some(entry))
        .await;
    drop(inflight_guard);
    match outcome {
        Ok(v) => ResponseBody::Ok(v),
        Err(err) => ResponseBody::Err(err.into_rpc()),
    }
}

/// Upper bound on `tool.wait_ms` (5 minutes). Larger values are
/// rejected as `invalid_params` so a buggy agent cannot wedge a
/// daemon-side sleep beyond a reasonable window. The cap matches the
/// design-doc red-line that long waits should use the queue-based
/// `wait_for_navigation` instead.
pub const MAX_WAIT_MS: u64 = 5 * 60 * 1_000;

/// Daemon-local handler for `tool.wait_ms` (M9.3). Does NOT go
/// through `handle_tool_dispatch` / `tool_queues`: the sleep is
/// answered entirely on this side of the WS link, so no extension
/// hop and no session id required.
async fn handle_wait_ms(
    registry: &Arc<AbortRegistry>,
    rpc_id: RpcId,
    params: Value,
) -> ResponseBody {
    let params: WaitMsParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(err) => {
            return ResponseBody::Err(RpcError {
                code: ErrorCode::InvalidParams,
                message: err.to_string(),
                data: None,
            });
        }
    };
    if params.duration_ms > MAX_WAIT_MS {
        return ResponseBody::Err(RpcError {
            code: ErrorCode::InvalidParams,
            message: format!(
                "wait_ms duration {} exceeds limit {}ms",
                params.duration_ms, MAX_WAIT_MS
            ),
            data: None,
        });
    }
    if params.duration_ms == 0 {
        return ResponseBody::Ok(
            serde_json::to_value(WaitMsResult { waited_ms: 0 }).unwrap_or(Value::Null),
        );
    }
    let guard = match registry.register(rpc_id) {
        Ok(guard) => guard,
        Err(err) => {
            return ResponseBody::Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: format!("cannot register wait_ms cancellation token: {err:?}"),
                data: None,
            });
        }
    };
    let token = guard.token().clone();
    let result = tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(params.duration_ms)) => {
            ResponseBody::Ok(
                serde_json::to_value(WaitMsResult { waited_ms: params.duration_ms })
                    .unwrap_or(Value::Null),
            )
        }
        _ = token.cancelled() => {
            ResponseBody::Err(RpcError {
                code: ErrorCode::Cancelled,
                message: "wait_ms cancelled".into(),
                data: None,
            })
        }
    };
    drop(guard);
    result
}

/// Resolve a `cancel { rpc_id }` against the daemon's two
/// cancellation surfaces (M10.2 + review C2):
///
/// 1. [`AbortRegistry`] — answers daemon-local cancellable runners
///    (currently `tool.wait_ms`). If a token is registered we trip it
///    and stop.
/// 2. [`super::inflight::ToolInflightRegistry`] — every IPC-tracked
///    `tool.*` RPC, registered the moment the IPC handler accepts the
///    request. Trips the entry's cancel token regardless of whether
///    the per-session queue worker has dequeued the job yet:
///    * **Queued** — the worker's pre-flight observes the cancelled
///      token and short-circuits with `cancelled` before any WS
///      frame leaves the daemon (review C2 fix).
///    * **Forwarded** — the worker's `tokio::select!` returns
///      `cancelled` immediately, AND we additionally push a WS-side
///      `cancel { rpc_id: ws_rpc_id }` frame so the extension's
///      dispatcher can trip its `AbortController`.
///
/// Returns `{ cancelled }` reflecting whether either surface
/// matched. The RPC itself never errors — a cancelled tool surfaces
/// the `Cancelled` code in its own response.
fn handle_cancel(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
    let params: CancelParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(err) => {
            return ResponseBody::Err(RpcError {
                code: ErrorCode::InvalidParams,
                message: err.to_string(),
                data: None,
            });
        }
    };
    let local = state.abort_registry.cancel(&params.rpc_id);
    let mut cancelled = local;
    if !local && let Some(snap) = state.tool_inflight.cancel(&params.rpc_id) {
        cancelled = true;
        // Forward the WS-side cancel only when the worker has
        // already promoted the entry to "forwarded"; queued entries
        // short-circuit on their own pre-flight without ever
        // touching the extension.
        if let (Some(browser_id), Some(ws_rpc_id)) = (snap.browser_id, snap.ws_rpc_id)
            && let Err(err) =
                super::cancel_forward::forward_cancel_to_browser(state, &browser_id, &ws_rpc_id)
        {
            warn!(
                cli_rpc_id = %params.rpc_id,
                browser = %browser_id,
                ws_rpc_id = %ws_rpc_id,
                %err,
                "failed to forward cancel to extension"
            );
        }
    }
    ResponseBody::Ok(serde_json::to_value(CancelResult { cancelled }).unwrap_or(Value::Null))
}

/// Test-only re-export of the cancel handler: the system-only handler
/// used by older tests doesn't carry `DaemonState`. Kept private so
/// the production handler in [`full_handler`] is the canonical entry
/// point.
#[cfg(test)]
fn handle_cancel_with_registry_only(registry: &Arc<AbortRegistry>, params: Value) -> ResponseBody {
    let params: CancelParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(err) => {
            return ResponseBody::Err(RpcError {
                code: ErrorCode::InvalidParams,
                message: err.to_string(),
                data: None,
            });
        }
    };
    let cancelled = registry.cancel(&params.rpc_id);
    ResponseBody::Ok(serde_json::to_value(CancelResult { cancelled }).unwrap_or(Value::Null))
}

fn tool_dispatch_timeout(params: &Value) -> Result<Duration, RpcError> {
    let Some(raw) = params.get("timeout_ms") else {
        return Ok(DEFAULT_TOOL_TIMEOUT);
    };
    let Some(ms) = raw.as_u64() else {
        return Err(RpcError {
            code: ErrorCode::InvalidParams,
            message: "timeout_ms must be a positive integer number of milliseconds".into(),
            data: None,
        });
    };
    if ms == 0 {
        return Err(RpcError {
            code: ErrorCode::InvalidParams,
            message: "timeout_ms must be greater than zero".into(),
            data: None,
        });
    }
    let ms = u32::try_from(ms).map_err(|_| RpcError {
        code: ErrorCode::InvalidParams,
        message: "timeout_ms too large for u32 milliseconds".into(),
        data: None,
    })?;
    Ok(Duration::from_millis(u64::from(ms)))
}

// Local CLI-facing shapes. Intentionally distinct from
// `bsk_protocol::tools::SessionStart*` (which describes the WS-facing
// `tool.session_*` round-trip with the extension) so the two sides can
// evolve independently.

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CliSessionStartParams {
    #[serde(default)]
    pub browser_instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CliSessionStartResult {
    pub session_id: String,
    pub browser_instance_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_window_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CliSessionStopParams {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CliSessionStopResult {
    pub stopped: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed: Vec<CliSessionStopFailure>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub returned_tab_ids: Vec<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub return_failures: Vec<ReturnFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CliSessionStopFailure {
    pub session_id: String,
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionListResult {
    pub sessions: Vec<SessionStatusEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BrowserListResult {
    pub browsers: Vec<BrowserStatusEntry>,
}

async fn handle_status(
    status: &DaemonStatus,
    state: &Arc<DaemonState>,
    params: Value,
) -> Result<Value, RpcError> {
    let params: StatusParams = parse_params_or_default(params)?;
    maybe_wait_for_browser(state, params.wait_for_browser_ms).await;
    Ok(serde_json::to_value(status.snapshot_with(state)).unwrap_or(Value::Null))
}

fn parse_params_or_default<T>(params: Value) -> Result<T, RpcError>
where
    T: DeserializeOwned + Default,
{
    if params.is_null() {
        Ok(T::default())
    } else {
        serde_json::from_value(params).map_err(|err| RpcError {
            code: ErrorCode::InvalidParams,
            message: err.to_string(),
            data: None,
        })
    }
}

async fn maybe_wait_for_browser(state: &Arc<DaemonState>, wait_ms: Option<u64>) {
    if let Some(wait) = clamp_browser_wait(wait_ms) {
        state.browsers.wait_for_any_connected(wait).await;
    }
}

fn clamp_browser_wait(wait_ms: Option<u64>) -> Option<Duration> {
    let ms = wait_ms?;
    if ms == 0 {
        return None;
    }
    Some(Duration::from_millis(
        ms.min(MAX_BROWSER_WAIT.as_millis() as u64),
    ))
}

async fn handle_session_start(state: &Arc<DaemonState>, params: Value) -> Result<Value, RpcError> {
    let params: CliSessionStartParams = if params.is_null() {
        CliSessionStartParams {
            browser_instance_id: None,
        }
    } else {
        serde_json::from_value(params).map_err(|err| RpcError {
            code: ErrorCode::InvalidParams,
            message: err.to_string(),
            data: None,
        })?
    };
    match start_session(
        &state.browsers,
        &state.sessions,
        &state.tool_queues,
        params.browser_instance_id.as_deref(),
        state.config.extension_connect_wait,
        DEFAULT_RPC_TIMEOUT,
    )
    .await
    {
        Ok(session) => {
            let result = CliSessionStartResult {
                session_id: session.id.0.clone(),
                browser_instance_id: session.browser_id.0.clone(),
                agent_window_id: session.agent_window_id,
            };
            Ok(serde_json::to_value(result).unwrap_or(Value::Null))
        }
        Err(err) => Err(map_start_error(err)),
    }
}

fn map_start_error(err: StartSessionError) -> RpcError {
    let code = match &err {
        StartSessionError::NoBrowserConnected => ErrorCode::NoBrowserConnected,
        StartSessionError::MultipleBrowsersOnline { .. } => ErrorCode::MultipleBrowsersOnline,
        StartSessionError::BrowserNotFound => ErrorCode::NotFound,
        StartSessionError::AmbiguousBrowserLabel { .. } => ErrorCode::InvalidParams,
        StartSessionError::IdExhausted => ErrorCode::ProtocolError,
        StartSessionError::Timeout => ErrorCode::Timeout,
        StartSessionError::TransportClosed => ErrorCode::ProtocolError,
        StartSessionError::ExtensionError(inner) => inner.code,
    };
    let message = err.to_string();
    let data = match &err {
        StartSessionError::MultipleBrowsersOnline { browsers } => {
            Some(serde_json::json!({ "browsers": browsers }))
        }
        StartSessionError::AmbiguousBrowserLabel {
            label,
            instance_ids,
        } => Some(serde_json::json!({
            "label": label,
            "instance_ids": instance_ids,
        })),
        _ => None,
    };
    RpcError {
        code,
        message,
        data,
    }
}

async fn handle_session_stop(state: &Arc<DaemonState>, params: Value) -> Result<Value, RpcError> {
    let params: CliSessionStopParams = if params.is_null() {
        CliSessionStopParams {
            session_id: None,
            all: false,
        }
    } else {
        serde_json::from_value(params).map_err(|err| RpcError {
            code: ErrorCode::InvalidParams,
            message: err.to_string(),
            data: None,
        })?
    };
    if params.all {
        return handle_session_stop_all(state).await;
    }
    let session_id = match params.session_id {
        Some(s) => SessionId(s),
        None => {
            return Err(RpcError {
                code: ErrorCode::InvalidParams,
                message: "session.stop requires session_id or all=true".into(),
                data: None,
            });
        }
    };
    match stop_session(
        &state.browsers,
        &state.sessions,
        &state.tool_queues,
        &state.session_interrupts,
        &session_id,
        DEFAULT_SESSION_STOP_TIMEOUT,
    )
    .await
    {
        Ok(stop) => {
            let result = CliSessionStopResult {
                stopped: vec![session_id.0],
                failed: Vec::new(),
                returned_tab_ids: stop.returned_tab_ids,
                return_failures: stop.return_failures,
            };
            Ok(serde_json::to_value(result).unwrap_or(Value::Null))
        }
        Err(StopSessionError::ReturnFailures(stop)) => {
            let message = format!(
                "failed to return borrowed tabs during session stop ({} failure(s)); session left running",
                stop.return_failures.len()
            );
            let result = CliSessionStopResult {
                stopped: Vec::new(),
                failed: vec![CliSessionStopFailure {
                    session_id: session_id.0,
                    code: ErrorCode::CdpFailed,
                    message,
                }],
                returned_tab_ids: stop.returned_tab_ids,
                return_failures: stop.return_failures,
            };
            Ok(serde_json::to_value(result).unwrap_or(Value::Null))
        }
        Err(err) => Err(map_stop_error(err)),
    }
}

fn map_stop_error(err: StopSessionError) -> RpcError {
    let code = match &err {
        StopSessionError::NotFound => ErrorCode::NotFound,
        StopSessionError::Stopping => ErrorCode::Timeout,
        StopSessionError::SessionBusy => return DispatchError::SessionBusy.into_rpc(),
        StopSessionError::BrowserGone => ErrorCode::NotFound,
        StopSessionError::Timeout => ErrorCode::Timeout,
        StopSessionError::TransportClosed => ErrorCode::ProtocolError,
        StopSessionError::ExtensionError(inner) => inner.code,
        StopSessionError::ReturnFailures(_) => ErrorCode::CdpFailed,
    };
    RpcError {
        code,
        message: err.to_string(),
        data: None,
    }
}

async fn handle_session_stop_all(state: &Arc<DaemonState>) -> Result<Value, RpcError> {
    let ids: Vec<SessionId> = state
        .sessions
        .snapshot()
        .into_iter()
        .map(|s| s.id)
        .collect();
    let mut stopped = Vec::new();
    let mut failed = Vec::new();
    let mut returned_tab_ids = Vec::new();
    let mut return_failures = Vec::new();
    for id in ids {
        match stop_session(
            &state.browsers,
            &state.sessions,
            &state.tool_queues,
            &state.session_interrupts,
            &id,
            DEFAULT_SESSION_STOP_TIMEOUT,
        )
        .await
        {
            Ok(stop) => {
                stopped.push(id.0);
                returned_tab_ids.extend(stop.returned_tab_ids);
                return_failures.extend(stop.return_failures);
            }
            Err(StopSessionError::ReturnFailures(stop)) => {
                debug!(
                    session = %id,
                    failures = stop.return_failures.len(),
                    "session.stop_all: borrowed tab return failure (leaving session running)"
                );
                failed.push(CliSessionStopFailure {
                    session_id: id.0,
                    code: ErrorCode::CdpFailed,
                    message: format!(
                        "failed to return borrowed tabs during session stop ({} failure(s)); session left running",
                        stop.return_failures.len()
                    ),
                });
                returned_tab_ids.extend(stop.returned_tab_ids);
                return_failures.extend(stop.return_failures);
            }
            Err(err) => {
                debug!(session = %id, ?err, "session.stop_all: failure (continuing)");
                let rpc = map_stop_error(err);
                failed.push(CliSessionStopFailure {
                    session_id: id.0,
                    code: rpc.code,
                    message: rpc.message,
                });
            }
        }
    }
    let result = CliSessionStopResult {
        stopped,
        failed,
        returned_tab_ids,
        return_failures,
    };
    Ok(serde_json::to_value(result).unwrap_or(Value::Null))
}

fn handle_session_list(state: &Arc<DaemonState>) -> ResponseBody {
    let sessions: Vec<_> = state
        .sessions
        .snapshot()
        .into_iter()
        .map(|s| s.status_entry())
        .collect();
    ResponseBody::Ok(serde_json::to_value(SessionListResult { sessions }).unwrap_or(Value::Null))
}

async fn handle_browser_list(state: &Arc<DaemonState>, params: Value) -> Result<Value, RpcError> {
    let params: BrowserListParams = parse_params_or_default(params)?;
    maybe_wait_for_browser(state, params.wait_for_browser_ms).await;
    // Reuse the same helper that produces the
    // `multiple_browsers_online.error.data.browsers` payload so the
    // two surfaces always agree on order — sorted by `connected_at_ms`
    // ascending, with `instance_id` as a deterministic tiebreaker
    // (review I1).
    let browsers = snapshot_status_entries(&state.browsers, &state.sessions);
    Ok(serde_json::to_value(BrowserListResult { browsers }).unwrap_or(Value::Null))
}

// ----- Test-helper IpcServer wrapper around the transport layer -----

/// Owning handle around a spawned IPC server task. Returned by
/// [`IpcServer::bind`] and the public [`super::run`] helper.
pub struct IpcHandle {
    pub sock_path: PathBuf,
    pub shutdown: Arc<Notify>,
    pub task: JoinHandle<()>,
}

pub struct IpcServer {
    state: Arc<DaemonState>,
}

impl IpcServer {
    pub fn new(state: Arc<DaemonState>) -> Self {
        Self { state }
    }

    /// Bind `sock_path` and spawn the serve loop. The returned
    /// [`IpcHandle`] can be used to wait for / shut down the task.
    pub async fn bind(self, sock_path: PathBuf) -> anyhow::Result<IpcHandle> {
        let started_at = Instant::now();
        let status = DaemonStatus {
            started_at,
            ws_port: 0,
            sock_path: sock_path.clone(),
            daemon_version: DAEMON_VERSION,
            protocol_version: PROTOCOL_VERSION,
        };
        let handler = full_handler(status, Arc::clone(&self.state));
        let listener = bind(&sock_path).await?;
        let shutdown = Arc::new(Notify::new());
        let shutdown_signal = Arc::clone(&shutdown);
        let task = tokio::spawn(serve(listener, handler, || {}, || {}, || {}, async move {
            shutdown_signal.notified().await;
        }));
        Ok(IpcHandle {
            sock_path,
            shutdown,
            task,
        })
    }
}

// ----- Transport: UDS / Named Pipe accept loops (M2/M3) -----

#[cfg(unix)]
mod unix {
    use std::path::Path;
    use std::sync::Arc;

    use anyhow::{Context, Result};
    use bsk_protocol::{ErrorCode, Frame, RequestFrame, ResponseBody, RpcError};
    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{UnixListener, UnixStream};
    use tracing::{debug, info, warn};

    use super::RpcHandler;

    /// Bind the IPC server. Unbinds a stale socket if present (the daemon
    /// lock has already prevented two daemons running, so this is safe).
    pub async fn bind(path: &Path) -> Result<UnixListener> {
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let listener =
            UnixListener::bind(path).with_context(|| format!("bind UDS {}", path.display()))?;
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        Ok(listener)
    }

    /// Run the IPC server loop until `shutdown` resolves.
    pub async fn serve<S>(
        listener: UnixListener,
        handler: RpcHandler,
        on_open: impl Fn() + Send + Sync + 'static,
        on_activity: impl Fn() + Send + Sync + 'static,
        on_close: impl Fn() + Send + Sync + 'static,
        shutdown: S,
    ) where
        S: std::future::Future<Output = ()> + Send + 'static,
    {
        info!("ipc server listening");
        let on_open = Arc::new(on_open);
        let on_activity = Arc::new(on_activity);
        let on_close = Arc::new(on_close);
        tokio::pin!(shutdown);
        loop {
            tokio::select! {
                _ = &mut shutdown => {
                    info!("ipc server shutdown requested");
                    break;
                }
                accepted = listener.accept() => {
                    match accepted {
                        Ok((stream, _addr)) => {
                            on_open();
                            let handler = handler.clone();
                            let on_act = on_activity.clone();
                            let on_done = on_close.clone();
                            tokio::spawn(async move {
                                if let Err(err) = handle_connection(stream, handler, on_act).await {
                                    debug!(?err, "ipc connection ended with error");
                                }
                                on_done();
                            });
                        }
                        Err(err) => {
                            warn!(?err, "ipc accept failed");
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                    }
                }
            }
        }
    }

    async fn handle_connection(
        stream: UnixStream,
        handler: RpcHandler,
        on_activity: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader.read_line(&mut line).await?;
            if n == 0 {
                break;
            }
            on_activity();
            let trimmed = line.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                continue;
            }

            let response = match serde_json::from_str::<Frame>(trimmed) {
                Ok(Frame::Request(RequestFrame { id, method, params })) => {
                    let params = params.unwrap_or(Value::Null);
                    let body = (handler)(id.clone(), method, params).await;
                    let frame = bsk_protocol::ResponseFrame { id, body };
                    serde_json::to_string(&Frame::Response(frame))?
                }
                Ok(other) => {
                    debug!(?other, "ipc client sent non-request frame");
                    continue;
                }
                Err(err) => serde_json::to_string(&Frame::Response(bsk_protocol::ResponseFrame {
                    id: "0".into(),
                    body: ResponseBody::Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: format!("invalid frame: {err}"),
                        data: None,
                    }),
                }))?,
            };

            write_half.write_all(response.as_bytes()).await?;
            write_half.write_all(b"\n").await?;
            write_half.flush().await?;
        }
        Ok(())
    }
}

#[cfg(unix)]
pub use unix::{bind, serve};

#[cfg(windows)]
mod windows {
    use std::path::Path;
    use std::sync::Arc;

    use anyhow::{Context, Result};
    use bsk_protocol::{ErrorCode, Frame, RequestFrame, ResponseBody, RpcError};
    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use tracing::{debug, info, warn};

    use super::RpcHandler;

    pub struct NamedPipeListener {
        pipe_name: String,
        first: Option<NamedPipeServer>,
    }

    pub async fn bind(_path: &Path) -> Result<NamedPipeListener> {
        let pipe_name = crate::daemon::paths::pipe_name();
        let first = ServerOptions::new()
            .first_pipe_instance(true)
            .access_inbound(true)
            .access_outbound(true)
            .create(&pipe_name)
            .with_context(|| format!("create first named-pipe instance {pipe_name}"))?;
        Ok(NamedPipeListener {
            pipe_name,
            first: Some(first),
        })
    }

    pub async fn serve<S>(
        mut listener: NamedPipeListener,
        handler: RpcHandler,
        on_open: impl Fn() + Send + Sync + 'static,
        on_activity: impl Fn() + Send + Sync + 'static,
        on_close: impl Fn() + Send + Sync + 'static,
        shutdown: S,
    ) where
        S: std::future::Future<Output = ()> + Send + 'static,
    {
        info!(pipe = %listener.pipe_name, "ipc named-pipe server listening");
        let on_open = Arc::new(on_open);
        let on_activity = Arc::new(on_activity);
        let on_close = Arc::new(on_close);
        tokio::pin!(shutdown);
        loop {
            let pipe = match listener.first.take() {
                Some(pipe) => pipe,
                None => match ServerOptions::new()
                    .first_pipe_instance(false)
                    .access_inbound(true)
                    .access_outbound(true)
                    .create(&listener.pipe_name)
                {
                    Ok(pipe) => pipe,
                    Err(err) => {
                        warn!(?err, "create named-pipe instance failed");
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        continue;
                    }
                },
            };

            tokio::select! {
                _ = &mut shutdown => {
                    info!("ipc named-pipe server shutdown requested");
                    break;
                }
                connected = pipe.connect() => {
                    match connected {
                        Ok(()) => {
                            on_open();
                            let handler = handler.clone();
                            let on_act = on_activity.clone();
                            let on_done = on_close.clone();
                            tokio::spawn(async move {
                                if let Err(err) = handle_connection(pipe, handler, on_act).await {
                                    debug!(?err, "named-pipe connection ended with error");
                                }
                                on_done();
                            });
                        }
                        Err(err) => {
                            warn!(?err, "named-pipe connect failed");
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        }
                    }
                }
            }
        }
    }

    async fn handle_connection(
        pipe: NamedPipeServer,
        handler: RpcHandler,
        on_activity: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<()> {
        let (read_half, mut write_half) = tokio::io::split(pipe);
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader.read_line(&mut line).await?;
            if n == 0 {
                break;
            }
            on_activity();
            let trimmed = line.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                continue;
            }

            let response = match serde_json::from_str::<Frame>(trimmed) {
                Ok(Frame::Request(RequestFrame { id, method, params })) => {
                    let params = params.unwrap_or(Value::Null);
                    let body = (handler)(id.clone(), method, params).await;
                    let frame = bsk_protocol::ResponseFrame { id, body };
                    serde_json::to_string(&Frame::Response(frame))?
                }
                Ok(other) => {
                    debug!(?other, "named-pipe client sent non-request frame");
                    continue;
                }
                Err(err) => serde_json::to_string(&Frame::Response(bsk_protocol::ResponseFrame {
                    id: "0".into(),
                    body: ResponseBody::Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: format!("invalid frame: {err}"),
                        data: None,
                    }),
                }))?,
            };

            write_half.write_all(response.as_bytes()).await?;
            write_half.write_all(b"\n").await?;
            write_half.flush().await?;
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use windows::{bind, serve};

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use bsk_protocol::{Frame, Method, RequestFrame};
    use tempfile::TempDir;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;

    #[test]
    fn session_stop_timeout_covers_stop_round_trip() {
        assert!(DEFAULT_SESSION_STOP_TIMEOUT > DEFAULT_TOOL_TIMEOUT + DEFAULT_RPC_TIMEOUT);
    }

    #[test]
    fn tool_dispatch_timeout_uses_params_timeout_ms() {
        let params = serde_json::json!({
            "session_id": "abcd",
            "timeout_ms": 60_000,
        });

        assert_eq!(
            tool_dispatch_timeout(&params).unwrap(),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn tool_dispatch_timeout_honours_request_help_long_timeout() {
        let params = serde_json::json!({
            "session_id": "abcd",
            "prompt": "log in",
            "timeout_ms": 300_000,
        });
        let got = tool_dispatch_timeout(&params).expect("timeout parses");
        assert_eq!(got, std::time::Duration::from_millis(300_000));
    }

    #[test]
    fn tool_dispatch_timeout_rejects_zero_timeout_ms() {
        let params = serde_json::json!({
            "session_id": "abcd",
            "timeout_ms": 0,
        });

        let err = tool_dispatch_timeout(&params).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidParams);
    }

    #[tokio::test]
    async fn wait_ms_zero_short_circuits_without_registering() {
        let registry = Arc::new(AbortRegistry::new());
        let body = handle_wait_ms(
            &registry,
            "rpc-zero".into(),
            serde_json::json!({"duration_ms": 0}),
        )
        .await;
        match body {
            ResponseBody::Ok(v) => assert_eq!(v, serde_json::json!({"waited_ms": 0})),
            other => panic!("expected ok, got {other:?}"),
        }
        assert!(
            registry.is_empty(),
            "0ms wait must not leak a registry entry"
        );
    }

    #[tokio::test]
    async fn wait_ms_rejects_durations_over_five_minutes() {
        let registry = Arc::new(AbortRegistry::new());
        let body = handle_wait_ms(
            &registry,
            "rpc-too-long".into(),
            serde_json::json!({"duration_ms": MAX_WAIT_MS + 1}),
        )
        .await;
        match body {
            ResponseBody::Err(err) => {
                assert_eq!(err.code, ErrorCode::InvalidParams);
                assert!(err.message.contains("exceeds"));
            }
            other => panic!("expected err, got {other:?}"),
        }
        assert!(registry.is_empty());
    }

    #[tokio::test]
    async fn wait_ms_completes_for_short_duration() {
        let registry = Arc::new(AbortRegistry::new());
        let body = handle_wait_ms(
            &registry,
            "rpc-50".into(),
            serde_json::json!({"duration_ms": 50}),
        )
        .await;
        match body {
            ResponseBody::Ok(v) => assert_eq!(v, serde_json::json!({"waited_ms": 50})),
            other => panic!("expected ok, got {other:?}"),
        }
        assert!(registry.is_empty(), "guard must auto-clean on completion");
    }

    #[tokio::test]
    async fn wait_ms_cancellation_returns_cancelled_and_unregisters() {
        let registry = Arc::new(AbortRegistry::new());
        let reg_for_cancel = Arc::clone(&registry);
        let task = tokio::spawn(async move {
            handle_wait_ms(
                &registry,
                "rpc-cancel".into(),
                serde_json::json!({"duration_ms": 5_000}),
            )
            .await
        });
        // Give the handler a moment to register before we cancel.
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(reg_for_cancel.len(), 1);
        assert!(reg_for_cancel.cancel(&"rpc-cancel".to_string()));
        let body = tokio::time::timeout(Duration::from_millis(500), task)
            .await
            .expect("cancellation should propagate quickly")
            .expect("task succeeds");
        match body {
            ResponseBody::Err(err) => assert_eq!(err.code, ErrorCode::Cancelled),
            other => panic!("expected cancelled, got {other:?}"),
        }
        assert!(reg_for_cancel.is_empty(), "guard cleans entry on cancel");
    }

    #[test]
    fn cancel_unknown_rpc_returns_false_flag() {
        let registry = Arc::new(AbortRegistry::new());
        let body =
            handle_cancel_with_registry_only(&registry, serde_json::json!({"rpc_id": "ghost"}));
        match body {
            ResponseBody::Ok(v) => assert_eq!(v, serde_json::json!({"cancelled": false})),
            other => panic!("expected ok, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn ping_round_trip() {
        let tmp = TempDir::new().unwrap();
        let sock = tmp.path().join("daemon.sock");
        let listener = bind(&sock).await.unwrap();
        let handler = default_ping_handler();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        let server = tokio::spawn(serve(listener, handler, || {}, || {}, || {}, async move {
            let _ = rx.await;
        }));

        let stream = UnixStream::connect(&sock).await.expect("connect");
        let (read, mut write) = stream.into_split();
        let frame = Frame::Request(RequestFrame {
            id: "p1".into(),
            method: Method::SystemPing,
            params: None,
        });
        let mut line = serde_json::to_string(&frame).unwrap();
        line.push('\n');
        write.write_all(line.as_bytes()).await.unwrap();
        write.flush().await.unwrap();

        let mut reader = BufReader::new(read);
        let mut buf = String::new();
        reader.read_line(&mut buf).await.unwrap();
        let frame: Frame = serde_json::from_str(buf.trim_end()).unwrap();
        match frame {
            Frame::Response(resp) => {
                assert_eq!(resp.id, "p1");
                match resp.body {
                    ResponseBody::Ok(v) => {
                        assert_eq!(v, serde_json::json!({ "pong": true }));
                    }
                    other => panic!("expected ok, got {other:?}"),
                }
            }
            other => panic!("unexpected frame {other:?}"),
        }

        drop(write);
        drop(reader);
        let _ = tx.send(());
        let _ = server.await;
    }

    #[tokio::test]
    async fn unknown_method_returns_error() {
        let tmp = TempDir::new().unwrap();
        let sock = tmp.path().join("daemon.sock");
        let listener = bind(&sock).await.unwrap();
        let handler = default_ping_handler();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        let server = tokio::spawn(serve(listener, handler, || {}, || {}, || {}, async move {
            let _ = rx.await;
        }));

        let stream = UnixStream::connect(&sock).await.expect("connect");
        let (read, mut write) = stream.into_split();
        let frame = Frame::Request(RequestFrame {
            id: "p2".into(),
            method: Method::SystemHandshake,
            params: None,
        });
        let mut line = serde_json::to_string(&frame).unwrap();
        line.push('\n');
        write.write_all(line.as_bytes()).await.unwrap();
        write.flush().await.unwrap();

        let mut reader = BufReader::new(read);
        let mut buf = String::new();
        reader.read_line(&mut buf).await.unwrap();
        let frame: Frame = serde_json::from_str(buf.trim_end()).unwrap();
        match frame {
            Frame::Response(resp) => match resp.body {
                ResponseBody::Err(e) => {
                    assert_eq!(e.code, ErrorCode::UnknownMethod);
                }
                other => panic!("expected error, got {other:?}"),
            },
            other => panic!("unexpected frame {other:?}"),
        }

        drop(write);
        drop(reader);
        let _ = tx.send(());
        let _ = server.await;
    }
}
