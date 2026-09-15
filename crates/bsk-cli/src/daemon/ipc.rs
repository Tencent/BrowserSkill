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
    BrowserListParams, BrowserStatusEntry, DEFAULT_WAIT_CONTROL_MS, MAX_WAIT_CONTROL_MS,
    SessionControl, SessionStatusEntry, SessionStatusParams, SessionStatusResult,
    SessionWaitControlParams, SessionWaitControlResult, StatusParams, StatusResult,
    VersionSkewEntry, WaitControlOutcome,
};
use bsk_protocol::tools::{
    DownloadParams, DownloadResult, ReturnFailure, TransferBeginParams, TransferIdParams,
    UploadParams, WaitMsParams, WaitMsResult,
};
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
use super::session_interrupt::WaitControlResolution;
use super::sessions::{
    AgentWindowOptions, SessionId, StartSessionError, StopSessionError, snapshot_status_entries,
    start_session, stop_session,
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
// The upload transaction owns its operation deadline and may need a bounded
// cleanup before it can return a useful structured error. Keep only that
// transport alive slightly longer so it does not replace the result.
const EXTENSION_RESPONSE_GRACE: Duration = Duration::from_secs(2);
/// Upper bound on `wait_for_browser_ms` accepted over IPC.
const MAX_BROWSER_WAIT: Duration = Duration::from_secs(60);
// `session.stop` fast-fails while another tool is active; this budget
// only needs to cover the stop RPC itself and IPC scheduling grace.
const DEFAULT_SESSION_STOP_TIMEOUT: Duration =
    Duration::from_secs(DEFAULT_TOOL_TIMEOUT.as_secs() + DEFAULT_RPC_TIMEOUT.as_secs() + 5);

/// Exact rejection message emitted when a tool dispatch is gated by a
/// user takeover (`control=user`). Locked by a test because agents parse
/// it to discover the `wait-control` recovery path.
pub const USER_TAKEOVER_REJECTION: &str = "tool dispatch rejected: the user has taken over this session (control=user). Do not retry; run `bsk session wait-control --session <id>` and continue only after it returns control=agent.";

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
            let mut params = params;
            // Internal correlation is minted here, never accepted from a CLI caller.
            if let Some(object) = params.as_object_mut() {
                object.remove("_audit_id");
            }
            let ticket = if serde_json::to_value(&method)
                .ok()
                .and_then(|v| v.as_str().map(|s| s.starts_with("tool.")))
                .unwrap_or(false)
            {
                match state.audit.begin(params.get("session_id").and_then(Value::as_str).unwrap_or(""), &method, &params) {
                    Ok(ticket) => ticket,
                    Err(_) => return ResponseBody::Err(RpcError { code: ErrorCode::ProtocolError, message: "Operation audit could not be saved; action was not dispatched. Check the audit page or turn recording off.".into(), data: None }),
                }
            } else {
                None
            };
            if let Some(ticket) = &ticket
                && let Some(object) = params.as_object_mut()
            {
                object.insert(
                    "_audit_id".into(),
                    Value::String(ticket.operation_id.clone()),
                );
            }
            let body = match method {
                Method::SystemPing => {
                    let result = PingResult { pong: true };
                    ResponseBody::Ok(serde_json::to_value(result).unwrap_or(Value::Null))
                }
                Method::SystemStatus => match handle_status(&status, &state, params).await {
                    Ok(v) => ResponseBody::Ok(v),
                    Err(e) => ResponseBody::Err(e),
                },
                Method::SessionStart => match handle_session_start(&state, rpc_id, params).await {
                    Ok(v) => ResponseBody::Ok(v),
                    Err(e) => ResponseBody::Err(e),
                },
                Method::SessionStop => match handle_session_stop(&state, rpc_id, params).await {
                    Ok(v) => ResponseBody::Ok(v),
                    Err(e) => ResponseBody::Err(e),
                },
                Method::SessionStopAll => match handle_session_stop_all_rpc(&state, rpc_id).await {
                    Ok(v) => ResponseBody::Ok(v),
                    Err(e) => ResponseBody::Err(e),
                },
                Method::SessionList => handle_session_list(&state),
                Method::SessionStatus => match handle_session_status(&state, params) {
                    Ok(v) => ResponseBody::Ok(v),
                    Err(e) => ResponseBody::Err(e),
                },
                Method::SessionWaitControl => {
                    match handle_session_wait_control(&state, rpc_id, params).await {
                        Ok(v) => ResponseBody::Ok(v),
                        Err(e) => ResponseBody::Err(e),
                    }
                }
                Method::BrowserList => match handle_browser_list(&state, params).await {
                    Ok(v) => ResponseBody::Ok(v),
                    Err(e) => ResponseBody::Err(e),
                },
                Method::TransferBegin => handle_transfer_begin(&state, params),
                Method::TransferChunk => handle_transfer_chunk(&state, params),
                Method::TransferFinish => handle_transfer_finish(&state, params),
                Method::TransferRead => handle_transfer_read(&state, params),
                Method::TransferRelease => handle_transfer_release(&state, params),
                Method::ToolTabList
                | Method::ToolTabCreate
                | Method::ToolTabClose
                | Method::ToolTabSelect
                | Method::ToolTabBorrow
                | Method::ToolTabReturn
                | Method::ToolWindowResize
                | Method::ToolEmulate
                | Method::ToolScreenshot
                | Method::ToolScreenshotFullPage
                | Method::ToolScreenshotRead
                | Method::ToolScreenshotRelease
                | Method::ToolConsole
                | Method::ToolNetwork
                | Method::ToolSnapshot
                | Method::ToolObserve
                | Method::ToolGetHtml
                | Method::ToolNavigate
                | Method::ToolNavigateBack
                | Method::ToolNavigateForward
                | Method::ToolReload
                | Method::ToolClick
                | Method::ToolHover
                | Method::ToolWheel
                | Method::ToolScrollTo
                | Method::ToolFocus
                | Method::ToolBlur
                | Method::ToolFill
                | Method::ToolPress
                | Method::ToolSelect
                | Method::ToolUpload
                | Method::ToolDownload
                | Method::ToolEvaluate
                | Method::ToolWaitForNavigation
                | Method::ToolRequestHelp
                | Method::ToolRecordStart
                | Method::ToolRecordStop
                | Method::ToolRecordAwait => {
                    handle_tool_dispatch(&state, rpc_id, method, params).await
                }
                Method::ToolWaitMs => handle_wait_ms(&state.abort_registry, rpc_id, params).await,
                Method::Cancel => handle_cancel(&state, params),
                other => ResponseBody::Err(RpcError {
                    code: ErrorCode::UnknownMethod,
                    message: format!("method not implemented yet: {other:?}"),
                    data: None,
                }),
            };
            if let Some(ticket) = ticket {
                state.audit.finish(ticket, &body);
            }
            body
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
    // Reject before allocating local transfer resources. The extension also
    // enforces this for third-party gateways backed by a local-mode daemon.
    if state.config.server.is_some() && matches!(method, Method::ToolUpload | Method::ToolDownload)
    {
        return ResponseBody::Err(RpcError {
            code: ErrorCode::Unsupported,
            message: "upload and download are not supported for remote browsers".into(),
            data: None,
        });
    }
    // Pre-flight: if the user has clicked the agent-window mask's
    // stop button, every session carries a one-shot "pending
    // interrupt" marker. The marker is consumed by the next method
    // that dispatches browser/page input (which is rejected with
    // `UserAborted`). Passive reads and control-plane RPCs pass through
    // transparently — gating them would prevent the agent from observing
    // page state before asking the user, or from cleanly tearing down the
    // session. Classification lives on `Method::effect()` so adding a new
    // tool variant requires an explicit classification call.
    //
    // Checked *before* the one-shot marker: a takeover is a standing
    // instruction, so it must win over (and not be consumed by) the
    // legacy marker. The held flag is deliberately NOT consumed here —
    // it clears only on `session.control_returned` or session teardown.
    if method.requires_interrupt_gate() && state.session_interrupts.is_held(&session_id) {
        return ResponseBody::Err(RpcError {
            code: ErrorCode::UserAborted,
            message: USER_TAKEOVER_REJECTION.into(),
            data: Some(serde_json::json!({
                "reason": "user_takeover",
                "control": "user",
                "session_id": session_id.0,
            })),
        });
    }
    if method.requires_interrupt_gate() && state.session_interrupts.try_consume(&session_id) {
        return ResponseBody::Err(RpcError {
            code: ErrorCode::UserAborted,
            message: "tool dispatch rejected: pending user interrupt. The user explicitly requested to stop. Ask the user how to proceed before issuing further actions.".into(),
            data: None,
        });
    }
    let timeout = match tool_dispatch_transport_timeout(&method, &params) {
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
    let audit_id = params.get("_audit_id").cloned();
    let mut params = params;
    if method == Method::ToolTabBorrow {
        // Old CLI clients can still send this field. Never forward their
        // override to an older extension that would act on it.
        if let Some(confirm) = params.get("confirm")
            && !confirm.is_boolean()
            && !confirm.is_null()
        {
            return ResponseBody::Err(invalid_params("confirm must be a boolean"));
        }
        if let Some(object) = params.as_object_mut() {
            object.remove("confirm");
        }
        if params
            .get("confirmation_timeout_ms")
            .is_some_and(|v| !v.is_null())
            && let Some(session) = state.sessions.get(&session_id)
            && let Some(browser) = state.browsers.get(&session.browser_id)
            && !bsk_protocol::tools::supports_borrow_confirmation_timeout(
                &browser.extension_protocol_version,
            )
        {
            return ResponseBody::Err(RpcError {
                code: ErrorCode::Unsupported,
                message: "Custom tab-borrow confirmation waits require extension protocol 1.2; update the extension or omit --timeout to use its default wait".into(),
                data: Some(serde_json::json!({
                    "reason": "unsupported_feature", "operation": "tab borrow --timeout",
                    "component": "extension", "required_protocol": bsk_protocol::tools::BORROW_CONFIRMATION_TIMEOUT_PROTOCOL,
                    "actual_protocol": browser.extension_protocol_version,
                })),
            });
        }
    }
    let mut download_transfer_id: Option<String> = None;
    if method == Method::ToolUpload {
        let mut upload: UploadParams = match serde_json::from_value(params) {
            Ok(v) => v,
            Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
        };
        if upload.files.is_empty() || upload.files.len() > super::file_transfer::MAX_UPLOAD_FILES {
            return ResponseBody::Err(invalid_params(format!(
                "upload requires 1..={} files",
                super::file_transfer::MAX_UPLOAD_FILES
            )));
        }
        let ids: Vec<String> = upload.files.iter().map(|f| f.transfer_id.clone()).collect();
        let paths = match state.transfers.resolve_uploads(&session_id.0, &ids) {
            Ok(v) => v,
            Err(err) => return ResponseBody::Err(err),
        };
        for (file, path) in upload.files.iter_mut().zip(paths) {
            file.staged_path = Some(path.to_string_lossy().into_owned());
        }
        params = serde_json::to_value(upload).unwrap_or(Value::Null);
    } else if method == Method::ToolDownload {
        let mut download: DownloadParams = match serde_json::from_value(params) {
            Ok(v) => v,
            Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
        };
        let staging = match state.transfers.begin_download(&session_id.0) {
            Ok(v) => v,
            Err(err) => return ResponseBody::Err(err),
        };
        download.browser_relative_dir = Some(staging.browser_relative_dir);
        download.max_byte_size = Some(super::file_transfer::MAX_TRANSFER_BYTES);
        download_transfer_id = Some(staging.transfer_id);
        params = serde_json::to_value(download).unwrap_or(Value::Null);
    }
    if let Some(audit_id) = audit_id
        && let Some(object) = params.as_object_mut()
    {
        object.insert("_audit_id".into(), audit_id);
    }
    let entry = inflight_guard.entry();
    // `record_stop` must reach the extension while `record_await` holds the
    // serial busy lock — finishing the recording unblocks await.
    let outcome = if method == Method::ToolRecordStop {
        state
            .tool_queues
            .dispatch_unlocked(&session_id, method.clone(), params, timeout, Some(entry))
            .await
    } else {
        state
            .tool_queues
            .dispatch(&session_id, method.clone(), params, timeout, Some(entry))
            .await
    };
    drop(inflight_guard);
    match outcome {
        Ok(v) if method == Method::ToolDownload => {
            let id = download_transfer_id.expect("download transfer allocated");
            let mut result: DownloadResult = match serde_json::from_value(v) {
                Ok(v) => v,
                Err(err) => {
                    state
                        .transfers
                        .release(TransferIdParams { transfer_id: id });
                    return ResponseBody::Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: format!("invalid tool.download result: {err}"),
                        data: None,
                    });
                }
            };
            let Some(path) = result.browser_path.take() else {
                state
                    .transfers
                    .release(TransferIdParams { transfer_id: id });
                return ResponseBody::Err(RpcError {
                    code: ErrorCode::ProtocolError,
                    message: "tool.download returned no browser_path".into(),
                    data: None,
                });
            };
            match state
                .transfers
                .import_download(&id, std::path::Path::new(&path))
            {
                Ok(size) => {
                    result.byte_size = size;
                    result.transfer_id = Some(id);
                    ResponseBody::Ok(serde_json::to_value(result).unwrap_or(Value::Null))
                }
                Err(err) => {
                    state
                        .transfers
                        .release(TransferIdParams { transfer_id: id });
                    ResponseBody::Err(err)
                }
            }
        }
        Ok(v) => ResponseBody::Ok(v),
        Err(err) => {
            if let Some(id) = download_transfer_id {
                state
                    .transfers
                    .release(TransferIdParams { transfer_id: id });
            }
            ResponseBody::Err(err.into_rpc())
        }
    }
}

fn handle_transfer_begin(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
    let p: TransferBeginParams = match serde_json::from_value(params) {
        Ok(v) => v,
        Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
    };
    if state
        .sessions
        .get(&SessionId(p.session_id.clone()))
        .is_none()
    {
        return ResponseBody::Err(RpcError {
            code: ErrorCode::NotFound,
            message: format!("session {} unknown", p.session_id),
            data: None,
        });
    }
    match state.transfers.begin_upload(p) {
        Ok(v) => ResponseBody::Ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Err(err) => ResponseBody::Err(err),
    }
}

fn handle_transfer_chunk(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
    let p = match serde_json::from_value(params) {
        Ok(v) => v,
        Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
    };
    match state.transfers.write_chunk(p) {
        Ok(v) => ResponseBody::Ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Err(err) => ResponseBody::Err(err),
    }
}

fn handle_transfer_finish(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
    let p = match serde_json::from_value(params) {
        Ok(v) => v,
        Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
    };
    match state.transfers.finish_upload(p) {
        Ok(v) => ResponseBody::Ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Err(err) => ResponseBody::Err(err),
    }
}

fn handle_transfer_read(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
    let p = match serde_json::from_value(params) {
        Ok(v) => v,
        Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
    };
    match state.transfers.read_chunk(p) {
        Ok(v) => ResponseBody::Ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Err(err) => ResponseBody::Err(err),
    }
}

fn handle_transfer_release(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
    let p: TransferIdParams = match serde_json::from_value(params) {
        Ok(v) => v,
        Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
    };
    ResponseBody::Ok(serde_json::to_value(state.transfers.release(p)).unwrap_or(Value::Null))
}

fn invalid_params(message: impl Into<String>) -> RpcError {
    RpcError {
        code: ErrorCode::InvalidParams,
        message: message.into(),
        data: None,
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
///    (`tool.wait_ms` and `session.*` lifecycle calls). If a token is
///    registered we trip it and stop. Lifecycle handlers forward their
///    own WS cancel after preserving request-before-cancel ordering.
/// 2. [`super::inflight::ToolInflightRegistry`] — every IPC-tracked
///    `tool.*` RPC, registered the moment the IPC handler accepts the
///    request. Trips the entry's cancel token regardless of whether
///    the per-session queue worker has dequeued the job yet:
///    * **Queued** — the worker's pre-flight observes the cancelled
///      token and short-circuits with `cancelled` before any WS
///      frame leaves the daemon (review C2 fix).
///    * **Forwarded** — we push a WS-side `cancel { rpc_id: ws_rpc_id }`
///      frame so the extension's dispatcher can trip its
///      `AbortController`; the worker keeps the session busy until the
///      extension returns its final result or the cleanup timeout expires.
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

fn tool_dispatch_transport_timeout(method: &Method, params: &Value) -> Result<Duration, RpcError> {
    if *method == Method::ToolTabBorrow {
        let ms = params
            .get("confirmation_timeout_ms")
            .map_or(Some(60_000), Value::as_u64)
            .filter(|ms| (1..=2_147_000_000).contains(ms))
            .ok_or_else(|| {
                invalid_params("confirmation_timeout_ms must be a positive bounded integer")
            })?;
        // Include the UI countdown/fade and Chrome move before deadline cancellation.
        return Ok(Duration::from_millis(ms).saturating_add(Duration::from_secs(15)));
    }
    let timeout = if *method == Method::ToolScreenshotFullPage && params.get("timeout_ms").is_none()
    {
        Ok(Duration::from_secs(120))
    } else {
        tool_dispatch_timeout(params)
    };
    timeout.map(|timeout| {
        if matches!(
            method,
            Method::ToolUpload | Method::ToolDownload | Method::ToolRequestHelp
        ) {
            timeout.saturating_add(EXTENSION_RESPONSE_GRACE)
        } else {
            timeout
        }
    })
}

// Local CLI-facing shapes. Intentionally distinct from
// `bsk_protocol::tools::SessionStart*` (which describes the WS-facing
// `tool.session_*` round-trip with the extension) so the two sides can
// evolve independently.

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CliSessionStartParams {
    #[serde(default)]
    pub browser_instance_id: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub focused: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CliSessionStartResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction: Option<bsk_protocol::tools::InteractionPolicy>,
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

async fn handle_session_start(
    state: &Arc<DaemonState>,
    rpc_id: RpcId,
    params: Value,
) -> Result<Value, RpcError> {
    let task_name = params
        .get("task_name")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let abort_guard = state
        .abort_registry
        .register(rpc_id)
        .map_err(|err| RpcError {
            code: ErrorCode::ProtocolError,
            message: format!("session.start cancellation registration failed: {err:?}"),
            data: None,
        })?;
    let cancel = abort_guard.token().clone();
    let params: CliSessionStartParams = if params.is_null() {
        CliSessionStartParams {
            browser_instance_id: None,
            width: None,
            height: None,
            focused: None,
        }
    } else {
        serde_json::from_value(params).map_err(|err| RpcError {
            code: ErrorCode::InvalidParams,
            message: err.to_string(),
            data: None,
        })?
    };
    // `--width` without `--height` (or vice versa) is rejected: the
    // extension only accepts a complete size pair.
    let window_size = match (params.width, params.height) {
        (Some(width), Some(height)) => Some((width, height)),
        (None, None) => None,
        _ => {
            return Err(RpcError {
                code: ErrorCode::InvalidParams,
                message: "width and height must be given together".into(),
                data: None,
            });
        }
    };
    match start_session(
        &state.browsers,
        &state.sessions,
        &state.tool_queues,
        params.browser_instance_id.as_deref(),
        AgentWindowOptions {
            size: window_size,
            focused: params.focused,
        },
        state.config.extension_connect_wait,
        DEFAULT_RPC_TIMEOUT,
        Some(cancel),
    )
    .await
    {
        Ok(session) => {
            if let Some(name) = task_name {
                state.audit.set_name(&session.id.0, &name);
            }
            let result = CliSessionStartResult {
                interaction: session.interaction,
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
        StartSessionError::Cancelled => ErrorCode::Cancelled,
        StartSessionError::CleanupFailed { .. } => ErrorCode::ProtocolError,
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
        StartSessionError::CleanupFailed {
            session_id,
            agent_window_id,
            ..
        } => Some(serde_json::json!({
            "reason": "cleanup_failed",
            "session_id": session_id.0,
            "agent_window_id": agent_window_id,
        })),
        StartSessionError::ExtensionError(inner) => inner.data.clone(),
        _ => None,
    };
    RpcError {
        code,
        message,
        data,
    }
}

async fn handle_session_stop(
    state: &Arc<DaemonState>,
    rpc_id: RpcId,
    params: Value,
) -> Result<Value, RpcError> {
    let abort_guard = state
        .abort_registry
        .register(rpc_id)
        .map_err(|err| RpcError {
            code: ErrorCode::ProtocolError,
            message: format!("session.stop cancellation registration failed: {err:?}"),
            data: None,
        })?;
    let cancel = abort_guard.token().clone();
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
        return handle_session_stop_all(state, Some(cancel)).await;
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
        Some(cancel),
    )
    .await
    {
        Ok(stop) => {
            state.transfers.release_session(&session_id.0);
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

async fn handle_session_stop_all_rpc(
    state: &Arc<DaemonState>,
    rpc_id: RpcId,
) -> Result<Value, RpcError> {
    let abort_guard = state
        .abort_registry
        .register(rpc_id)
        .map_err(|err| RpcError {
            code: ErrorCode::ProtocolError,
            message: format!("session.stop_all cancellation registration failed: {err:?}"),
            data: None,
        })?;
    handle_session_stop_all(state, Some(abort_guard.token().clone())).await
}

async fn handle_session_stop_all(
    state: &Arc<DaemonState>,
    cancel: Option<super::abort::AbortToken>,
) -> Result<Value, RpcError> {
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
        if cancel
            .as_ref()
            .is_some_and(super::abort::AbortToken::is_cancelled)
        {
            return Err(RpcError {
                code: ErrorCode::Cancelled,
                message: "session.stop_all was cancelled".into(),
                data: None,
            });
        }
        match stop_session(
            &state.browsers,
            &state.sessions,
            &state.tool_queues,
            &state.session_interrupts,
            &id,
            DEFAULT_SESSION_STOP_TIMEOUT,
            cancel.clone(),
        )
        .await
        {
            Ok(stop) => {
                state.transfers.release_session(&id.0);
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
            Err(err)
                if matches!(
                    &err,
                    StopSessionError::ExtensionError(inner)
                        if inner.code == ErrorCode::Cancelled
                ) =>
            {
                return Err(map_stop_error(err));
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

/// `session.status`: non-consuming read of a session's takeover state.
///
/// Daemon-local (never forwarded to the extension) so it works while
/// the extension is busy or the session is held. Returns `not_found` for
/// an unknown session id so the caller can distinguish "agent in
/// control" from "session gone" — both of which have
/// `control = agent`.
fn handle_session_status(state: &Arc<DaemonState>, params: Value) -> Result<Value, RpcError> {
    let params: SessionStatusParams = serde_json::from_value(params).map_err(|err| RpcError {
        code: ErrorCode::InvalidParams,
        message: format!("session.status requires {{session_id}}: {err}"),
        data: None,
    })?;
    if params.session_id.is_empty() {
        return Err(invalid_params(
            "session.status requires a non-empty session_id",
        ));
    }
    let sid = SessionId(params.session_id.clone());
    if state.sessions.get(&sid).is_none() {
        return Err(RpcError {
            code: ErrorCode::NotFound,
            message: format!("session {} unknown", params.session_id),
            data: Some(serde_json::json!({
                "reason": "session_gone",
                "session_id": params.session_id,
            })),
        });
    }
    let snap = state.session_interrupts.snapshot(&sid);
    let result = SessionStatusResult {
        session_id: params.session_id,
        control: snap.control,
        pending_interrupt: snap.pending_interrupt,
        held_for_ms: snap.held_for_ms,
        last_return: snap.last_return,
    };
    Ok(serde_json::to_value(result).unwrap_or(Value::Null))
}

/// `session.wait_control`: block until control returns to `agent`,
/// the timeout expires, or the session disappears.
///
/// Registered against [`AbortRegistry`] under the CLI's `rpc_id` so a
/// SIGINT-driven `cancel { rpc_id }` (the same path `request-help`
/// uses) can unblock the waiter instead of leaving the CLI hanging.
///
/// `released` consumes the return receipt, so the user's note reaches the
/// agent exactly once. A winner/timed-out race is resolved inside the
/// registry under one lock, so two concurrent waiters can never both
/// report `released`.
async fn handle_session_wait_control(
    state: &Arc<DaemonState>,
    rpc_id: RpcId,
    params: Value,
) -> Result<Value, RpcError> {
    let params: SessionWaitControlParams =
        serde_json::from_value(params).map_err(|err| RpcError {
            code: ErrorCode::InvalidParams,
            message: format!("session.wait_control requires {{session_id, timeout_ms?}}: {err}"),
            data: None,
        })?;
    if params.session_id.is_empty() {
        return Err(invalid_params(
            "session.wait_control requires a non-empty session_id",
        ));
    }
    let timeout_ms = params.timeout_ms.unwrap_or(DEFAULT_WAIT_CONTROL_MS);
    if timeout_ms > MAX_WAIT_CONTROL_MS {
        return Err(invalid_params(format!(
            "timeout_ms {timeout_ms} exceeds the {} ms maximum",
            MAX_WAIT_CONTROL_MS
        )));
    }
    let sid = SessionId(params.session_id.clone());
    // A timeout of zero (or a session that is already gone) resolves as a
    // fast snapshot rather than parking a task.
    if state.sessions.get(&sid).is_none() {
        let snap = state.session_interrupts.snapshot(&sid);
        let result = SessionWaitControlResult {
            outcome: WaitControlOutcome::SessionGone,
            control: snap.control,
            note: None,
            held_ms: None,
        };
        return Ok(serde_json::to_value(result).unwrap_or(Value::Null));
    }
    let abort_guard = state
        .abort_registry
        .register(rpc_id)
        .map_err(|err| RpcError {
            code: ErrorCode::ProtocolError,
            message: format!("session.wait_control cancellation registration failed: {err:?}"),
            data: None,
        })?;
    let cancel = abort_guard.token().clone();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    let sessions = Arc::clone(&state.sessions);
    let sid_for_exists = sid.clone();
    let resolution = tokio::select! {
        resolution = state.session_interrupts.wait_for_release(&sid, deadline, move || {
            sessions.get(&sid_for_exists).is_some()
        }) => resolution,
        _ = cancel.cancelled() => {
            drop(abort_guard);
            return Err(RpcError {
                code: ErrorCode::Cancelled,
                message: "session.wait_control cancelled".into(),
                data: None,
            });
        }
    };
    drop(abort_guard);
    // `session_gone` needs no hold/receipt data; re-read the (possibly
    // removed) control entry only for the remaining outcomes.
    let snap = state.session_interrupts.snapshot(&sid);
    let result = match resolution {
        WaitControlResolution::Released(receipt) => SessionWaitControlResult {
            outcome: WaitControlOutcome::Released,
            control: SessionControl::Agent,
            note: Some(receipt.note),
            held_ms: Some(receipt.held_ms),
        },
        WaitControlResolution::AlreadyAgent => SessionWaitControlResult {
            outcome: WaitControlOutcome::AlreadyAgent,
            control: SessionControl::Agent,
            note: None,
            held_ms: None,
        },
        WaitControlResolution::TimedOut { held_for_ms } => SessionWaitControlResult {
            outcome: WaitControlOutcome::TimedOut,
            control: SessionControl::User,
            note: None,
            held_ms: Some(held_for_ms),
        },
        WaitControlResolution::SessionGone => SessionWaitControlResult {
            outcome: WaitControlOutcome::SessionGone,
            control: snap.control,
            note: None,
            held_ms: None,
        },
    };
    Ok(serde_json::to_value(result).unwrap_or(Value::Null))
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
                            // Keep the connected instance alive until its replacement
                            // exists. Otherwise a fast handler can close the last
                            // instance and make new clients fail with NotFound.
                            loop {
                                match ServerOptions::new()
                                    .access_inbound(true)
                                    .access_outbound(true)
                                    .create(&listener.pipe_name)
                                {
                                    Ok(next) => {
                                        listener.first = Some(next);
                                        break;
                                    }
                                    Err(err) => {
                                        warn!(?err, "create next named-pipe instance failed");
                                        tokio::select! {
                                            _ = &mut shutdown => return,
                                            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
                                        }
                                    }
                                }
                            }
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
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::Mutex;
        use std::time::Duration;
        use tokio::net::windows::named_pipe::ClientOptions;
        use tokio::sync::oneshot;

        fn isolated_listener() -> NamedPipeListener {
            let pipe_name = format!(r"\\.\pipe\bsk-test-{}", uuid::Uuid::new_v4());
            let first = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe_name)
                .unwrap();
            NamedPipeListener {
                pipe_name,
                first: Some(first),
            }
        }

        #[tokio::test]
        async fn next_instance_exists_before_connection_is_handed_off() {
            let listener = isolated_listener();
            let name = listener.pipe_name.clone();
            let probe_name = name.clone();
            let (probe_tx, probe_rx) = oneshot::channel();
            let probe_tx = Mutex::new(Some(probe_tx));
            let (stop_tx, stop_rx) = oneshot::channel();
            let server = tokio::spawn(serve(
                listener,
                crate::daemon::ipc::default_ping_handler(),
                move || {
                    if let Some(tx) = probe_tx.lock().unwrap().take() {
                        // This callback runs before the connection task can finish.
                        // A second client must already have an instance to open.
                        let result = ClientOptions::new().open(&probe_name).map(drop);
                        let _ = tx.send(result);
                    }
                },
                || {},
                || {},
                async {
                    let _ = stop_rx.await;
                },
            ));
            let client = ClientOptions::new().open(&name).unwrap();
            let result = tokio::time::timeout(Duration::from_secs(5), probe_rx).await;
            drop(client);
            let _ = stop_tx.send(());
            server.await.unwrap();
            result
                .expect("accept callback ran")
                .unwrap()
                .expect("next pipe instance is ready");
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn rapid_disconnects_and_concurrent_rpc_connections() {
            let listener = isolated_listener();
            let name = listener.pipe_name.clone();
            let (stop_tx, stop_rx) = oneshot::channel();
            let server = tokio::spawn(serve(
                listener,
                crate::daemon::ipc::default_ping_handler(),
                || {},
                || {},
                || {},
                async {
                    let _ = stop_rx.await;
                },
            ));
            let exercise = async {
                // Include clients that close without sending any request.
                for _ in 0..64 {
                    drop(
                        crate::ipc_client::Client::connect_path(name.clone().into())
                            .await
                            .unwrap(),
                    );
                }
                let mut clients = tokio::task::JoinSet::new();
                for _ in 0..8 {
                    let name = name.clone();
                    clients.spawn(async move {
                        for _ in 0..32 {
                            let mut client =
                                crate::ipc_client::Client::connect_path(name.clone().into())
                                    .await
                                    .unwrap();
                            let reply: bsk_protocol::PingResult = client
                                .call(
                                    bsk_protocol::Method::SystemPing,
                                    &serde_json::json!({}),
                                    Duration::from_secs(5),
                                )
                                .await
                                .unwrap()
                                .unwrap();
                            assert!(reply.pong);
                        }
                    });
                }
                while let Some(result) = clients.join_next().await {
                    result.unwrap();
                }
            };
            let result = tokio::time::timeout(Duration::from_secs(30), exercise).await;
            let _ = stop_tx.send(());
            server.await.unwrap();
            result.expect("connection exercise completed");
        }
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
    fn borrow_wait_budget_covers_the_confirmation_and_browser_move() {
        let ordinary =
            tool_dispatch_transport_timeout(&Method::ToolTabBorrow, &serde_json::json!({}))
                .unwrap();
        assert_eq!(ordinary, Duration::from_secs(75));
        let custom = tool_dispatch_transport_timeout(
            &Method::ToolTabBorrow,
            &serde_json::json!({"confirmation_timeout_ms": 120_000}),
        )
        .unwrap();
        assert_eq!(custom, Duration::from_secs(135));
        for invalid in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!("60s"),
            serde_json::json!(2_147_000_001_u64),
        ] {
            assert!(
                tool_dispatch_transport_timeout(
                    &Method::ToolTabBorrow,
                    &serde_json::json!({"confirmation_timeout_ms": invalid})
                )
                .is_err()
            );
        }
        assert_eq!(
            tool_dispatch_transport_timeout(&Method::ToolClick, &serde_json::json!({})).unwrap(),
            DEFAULT_TOOL_TIMEOUT
        );
    }

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
    fn full_page_screenshot_uses_its_capture_deadline() {
        assert_eq!(
            tool_dispatch_transport_timeout(
                &Method::ToolScreenshotFullPage,
                &serde_json::json!({})
            )
            .unwrap(),
            Duration::from_secs(120)
        );
        assert_eq!(
            tool_dispatch_transport_timeout(
                &Method::ToolScreenshotFullPage,
                &serde_json::json!({"timeout_ms": 300_000}),
            )
            .unwrap(),
            Duration::from_secs(300)
        );
        for invalid in [
            serde_json::json!(0),
            serde_json::json!(-1),
            serde_json::json!(null),
            serde_json::json!("120s"),
            serde_json::json!(u64::from(u32::MAX) + 1),
        ] {
            let err = tool_dispatch_transport_timeout(
                &Method::ToolScreenshotFullPage,
                &serde_json::json!({"timeout_ms": invalid}),
            )
            .unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidParams);
        }
    }

    #[test]
    fn extension_transport_outlives_the_operation_deadline() {
        let params = serde_json::json!({
            "session_id": "abcd",
            "timeout_ms": 60_000,
        });
        for method in [
            Method::ToolUpload,
            Method::ToolDownload,
            Method::ToolRequestHelp,
        ] {
            let dispatch_timeout = tool_dispatch_transport_timeout(&method, &params).unwrap();
            assert_eq!(dispatch_timeout, Duration::from_secs(62));
        }
    }

    #[test]
    fn extension_response_grace_does_not_change_other_tools() {
        let params = serde_json::json!({
            "session_id": "abcd",
            "timeout_ms": 60_000,
        });
        let dispatch_timeout =
            tool_dispatch_transport_timeout(&Method::ToolClick, &params).unwrap();

        assert_eq!(dispatch_timeout, Duration::from_secs(60));
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

    // ----- user-takeover gate + session.status / session.wait_control -----

    /// Build a `DaemonState` with one live session (id `abcd`) owned by a
    /// browser that is *not* registered, so nothing can be forwarded to an
    /// extension — which is exactly what lets these tests assert "rejected
    /// without reaching the extension".
    fn state_with_session() -> (Arc<DaemonState>, SessionId) {
        use crate::daemon::start::DaemonConfig;
        let state = Arc::new(DaemonState::new(DaemonConfig::new(0)));
        // Reserve under a browser id; `get` only checks the session table.
        let sid = state
            .sessions
            .reserve_id(crate::daemon::browsers::BrowserId("b-1".into()), 8, || 0)
            .expect("reserved session id");
        (state, sid)
    }

    #[test]
    fn user_takeover_rejection_message_is_locked() {
        // Agents parse this string to discover the `wait-control` recovery
        // path; lock it verbatim.
        assert_eq!(
            USER_TAKEOVER_REJECTION,
            "tool dispatch rejected: the user has taken over this session (control=user). Do not retry; run `bsk session wait-control --session <id>` and continue only after it returns control=agent."
        );
    }

    #[tokio::test]
    async fn held_session_rejects_input_tool_with_exact_message() {
        let (state, sid) = state_with_session();
        state.session_interrupts.take_control(&sid);
        for method in [
            Method::ToolClick,
            Method::ToolObserve,
            Method::ToolScreenshotFullPage,
            Method::ToolNavigate,
        ] {
            let body = handle_tool_dispatch(
                &state,
                "rpc-held".into(),
                method.clone(),
                serde_json::json!({"session_id": sid.0}),
            )
            .await;
            match body {
                ResponseBody::Err(err) => {
                    assert_eq!(err.code, ErrorCode::UserAborted, "method {method:?}");
                    assert_eq!(err.message, USER_TAKEOVER_REJECTION, "method {method:?}");
                    let data = err.data.expect("structured takeover payload");
                    assert_eq!(data["reason"], serde_json::json!("user_takeover"));
                    assert_eq!(data["control"], serde_json::json!("user"));
                }
                other => panic!("expected held rejection for {method:?}, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn returned_control_clears_the_one_shot_marker_so_the_next_input_tool_passes() {
        // Real-session bug: the takeover handshake sets *both* the held flag
        // and the legacy one-shot marker, then `control_returned` cleared
        // only the flag. The agent's first input tool after the return was
        // therefore rejected once with "pending user interrupt" even though
        // `wait_control` had already told it control=agent.
        let (state, sid) = state_with_session();
        state.session_interrupts.mark(&sid);
        state.session_interrupts.take_control(&sid);
        state
            .session_interrupts
            .release_control(&sid, Some("done".into()));

        assert!(
            !state.session_interrupts.is_pending(&sid),
            "returning control must drop the one-shot marker"
        );
        assert!(!state.session_interrupts.is_held(&sid));

        // `session.status` agrees: control=agent, no pending interrupt.
        let value = handle_session_status(&state, serde_json::json!({"session_id": sid.0}))
            .expect("status for a live session");
        let result: SessionStatusResult = serde_json::from_value(value).unwrap();
        assert_eq!(result.control, SessionControl::Agent);
        assert!(!result.pending_interrupt);

        // The gate must now pass. Whatever failure comes back (no dispatch
        // queue / no owning browser) must be neither of the two rejections.
        let body = handle_tool_dispatch(
            &state,
            "rpc-after-return".into(),
            Method::ToolClick,
            serde_json::json!({"session_id": sid.0}),
        )
        .await;
        if let ResponseBody::Err(err) = &body {
            assert_ne!(err.code, ErrorCode::UserAborted, "gate must pass: {err:?}");
            assert!(
                !err.message.contains("pending user interrupt"),
                "no leftover marker may fire after a return: {err:?}"
            );
            assert_ne!(err.message, USER_TAKEOVER_REJECTION);
        }
    }

    #[tokio::test]
    async fn held_rejection_is_not_consuming() {
        // Unlike the one-shot marker, the held flag must survive an
        // unbounded number of rejected dispatches and only clear on an
        // explicit `control_returned`.
        let (state, sid) = state_with_session();
        state.session_interrupts.take_control(&sid);
        for i in 0..5 {
            let body = handle_tool_dispatch(
                &state,
                format!("rpc-held-{i}"),
                Method::ToolClick,
                serde_json::json!({"session_id": sid.0}),
            )
            .await;
            assert!(
                matches!(body, ResponseBody::Err(ref e) if e.code == ErrorCode::UserAborted),
                "rejection {i} must be UserAborted"
            );
            assert!(
                state.session_interrupts.is_held(&sid),
                "held flag must survive rejection {i}"
            );
        }
        state
            .session_interrupts
            .release_control(&sid, Some("done".into()));
        assert!(!state.session_interrupts.is_held(&sid));
    }

    #[tokio::test]
    async fn held_session_lets_passive_read_pass() {
        // Passive reads must stay transparent: the agent needs to observe
        // the page before asking the user a coherent question.
        let (state, sid) = state_with_session();
        state.session_interrupts.take_control(&sid);
        // `tool.snapshot` is a passive read; it must NOT be rejected by the
        // takeover gate. It will fail later for lack of a dispatch queue,
        // but never with the takeover message.
        let body = handle_tool_dispatch(
            &state,
            "rpc-passive".into(),
            Method::ToolSnapshot,
            serde_json::json!({"session_id": sid.0}),
        )
        .await;
        if let ResponseBody::Err(err) = &body {
            assert_ne!(
                err.message, USER_TAKEOVER_REJECTION,
                "passive reads must not be takeover-gated"
            );
            assert_ne!(err.code, ErrorCode::UserAborted);
        }
    }

    #[tokio::test]
    async fn one_shot_marker_still_rejects_with_interrupt_message() {
        // Regression guard: the legacy marker path must keep working and
        // keep its own message after the takeover gate was inserted before it.
        let (state, sid) = state_with_session();
        state.session_interrupts.mark(&sid);
        let body = handle_tool_dispatch(
            &state,
            "rpc-once".into(),
            Method::ToolClick,
            serde_json::json!({"session_id": sid.0}),
        )
        .await;
        match body {
            ResponseBody::Err(err) => {
                assert_eq!(err.code, ErrorCode::UserAborted);
                assert!(
                    err.message
                        .starts_with("tool dispatch rejected: pending user interrupt")
                );
                assert_ne!(err.message, USER_TAKEOVER_REJECTION);
            }
            other => panic!("expected interrupt rejection, got {other:?}"),
        }
        assert!(
            !state.session_interrupts.is_pending(&sid),
            "one-shot marker is consumed by the rejection"
        );
    }

    #[tokio::test]
    async fn control_taken_supersedes_pending_interrupt_marker() {
        // A takeover sets both the held flag and the one-shot marker. The
        // takeover message must win and the marker must remain set, so that
        // once control returns an old pending stop still fires.
        let (state, sid) = state_with_session();
        state.session_interrupts.mark(&sid);
        state.session_interrupts.take_control(&sid);
        let body = handle_tool_dispatch(
            &state,
            "rpc-both".into(),
            Method::ToolClick,
            serde_json::json!({"session_id": sid.0}),
        )
        .await;
        match body {
            ResponseBody::Err(err) => assert_eq!(err.message, USER_TAKEOVER_REJECTION),
            other => panic!("expected takeover rejection, got {other:?}"),
        }
        assert!(
            state.session_interrupts.is_pending(&sid),
            "takeover rejection must not consume the one-shot marker"
        );
    }

    #[tokio::test]
    async fn session_status_reports_agent_by_default() {
        let (state, sid) = state_with_session();
        let value = handle_session_status(&state, serde_json::json!({"session_id": sid.0}))
            .expect("status for a live session");
        let result: SessionStatusResult = serde_json::from_value(value).unwrap();
        assert_eq!(result.control, SessionControl::Agent);
        assert!(!result.pending_interrupt);
        assert!(result.held_for_ms.is_none());
        assert!(result.last_return.is_none());
    }

    #[tokio::test]
    async fn session_status_is_non_consuming() {
        let (state, sid) = state_with_session();
        state.session_interrupts.take_control(&sid);
        state
            .session_interrupts
            .release_control(&sid, Some("looked at the page".into()));
        // A standalone Stop marker set *after* the return is unrelated to the
        // takeover, so it must survive repeated status reads. (The takeover's
        // own marker is dropped by `release_control`.)
        state.session_interrupts.mark(&sid);

        for _ in 0..3 {
            let value = handle_session_status(&state, serde_json::json!({"session_id": sid.0}))
                .expect("status");
            let result: SessionStatusResult = serde_json::from_value(value).unwrap();
            assert_eq!(result.control, SessionControl::Agent);
            assert!(
                result.pending_interrupt,
                "status must not consume the marker"
            );
            let receipt = result.last_return.as_ref().expect("receipt still visible");
            assert_eq!(receipt.note, "looked at the page");
        }
    }

    #[tokio::test]
    async fn session_status_reports_hold_duration_while_held() {
        let (state, sid) = state_with_session();
        state
            .session_interrupts
            .force_held_since(&sid, 1_600_000_000_000);
        let value = handle_session_status(&state, serde_json::json!({"session_id": sid.0}))
            .expect("status");
        let result: SessionStatusResult = serde_json::from_value(value).unwrap();
        assert_eq!(result.control, SessionControl::User);
        assert!(result.held_for_ms.is_some_and(|ms| ms > 0));
    }

    #[tokio::test]
    async fn session_status_unknown_session_is_not_found() {
        let (state, _sid) = state_with_session();
        let err = handle_session_status(&state, serde_json::json!({"session_id": "ghost"}))
            .expect_err("unknown session must be not_found");
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(
            err.data.unwrap()["reason"],
            serde_json::json!("session_gone")
        );
    }

    #[tokio::test]
    async fn session_status_requires_session_id() {
        let (state, _sid) = state_with_session();
        for params in [serde_json::json!({}), serde_json::json!({"session_id": ""})] {
            let err = handle_session_status(&state, params).expect_err("invalid params");
            assert_eq!(err.code, ErrorCode::InvalidParams);
        }
    }

    #[tokio::test]
    async fn wait_control_returns_already_agent_when_not_held() {
        let (state, sid) = state_with_session();
        let value = handle_session_wait_control(
            &state,
            "rpc-wait".into(),
            serde_json::json!({"session_id": sid.0, "timeout_ms": 50}),
        )
        .await
        .expect("wait_control");
        let result: SessionWaitControlResult = serde_json::from_value(value).unwrap();
        assert_eq!(result.outcome, WaitControlOutcome::AlreadyAgent);
        assert_eq!(result.control, SessionControl::Agent);
        assert!(result.note.is_none());
    }

    #[tokio::test]
    async fn wait_control_released_path_returns_note() {
        let (state, sid) = state_with_session();
        state.session_interrupts.take_control(&sid);
        let state_for_release = Arc::clone(&state);
        let sid_for_release = sid.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            state_for_release
                .session_interrupts
                .release_control(&sid_for_release, Some("handled the captcha".into()));
        });
        let value = handle_session_wait_control(
            &state,
            "rpc-wait".into(),
            serde_json::json!({"session_id": sid.0, "timeout_ms": 2_000}),
        )
        .await
        .expect("wait_control");
        let result: SessionWaitControlResult = serde_json::from_value(value).unwrap();
        assert_eq!(result.outcome, WaitControlOutcome::Released);
        assert_eq!(result.control, SessionControl::Agent);
        assert_eq!(result.note.as_deref(), Some("handled the captcha"));
        assert!(result.held_ms.is_some());

        // The receipt is delivered exactly once.
        let second = handle_session_wait_control(
            &state,
            "rpc-wait-2".into(),
            serde_json::json!({"session_id": sid.0, "timeout_ms": 50}),
        )
        .await
        .expect("wait_control");
        let second: SessionWaitControlResult = serde_json::from_value(second).unwrap();
        assert_eq!(second.outcome, WaitControlOutcome::AlreadyAgent);
        assert!(second.note.is_none());
    }

    #[tokio::test]
    async fn wait_control_timeout_path_keeps_hold() {
        let (state, sid) = state_with_session();
        state.session_interrupts.take_control(&sid);
        let value = handle_session_wait_control(
            &state,
            "rpc-wait".into(),
            serde_json::json!({"session_id": sid.0, "timeout_ms": 50}),
        )
        .await
        .expect("wait_control");
        let result: SessionWaitControlResult = serde_json::from_value(value).unwrap();
        assert_eq!(result.outcome, WaitControlOutcome::TimedOut);
        assert_eq!(result.control, SessionControl::User);
        assert!(result.held_ms.is_some_and(|ms| ms <= 5_000));
        assert!(
            state.session_interrupts.is_held(&sid),
            "timeout must not clear the user's hold"
        );
    }

    #[tokio::test]
    async fn wait_control_session_gone_path() {
        let (state, _sid) = state_with_session();
        let value = handle_session_wait_control(
            &state,
            "rpc-wait".into(),
            serde_json::json!({"session_id": "ghost", "timeout_ms": 50}),
        )
        .await
        .expect("wait_control");
        let result: SessionWaitControlResult = serde_json::from_value(value).unwrap();
        assert_eq!(result.outcome, WaitControlOutcome::SessionGone);
    }

    #[tokio::test]
    async fn wait_control_cancel_unblocks_the_waiter() {
        let (state, sid) = state_with_session();
        state.session_interrupts.take_control(&sid);
        let waiter = {
            let state = Arc::clone(&state);
            let sid = sid.clone();
            tokio::spawn(async move {
                handle_session_wait_control(
                    &state,
                    "rpc-wait".into(),
                    serde_json::json!({"session_id": sid.0, "timeout_ms": 30_000}),
                )
                .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(state.abort_registry.cancel(&"rpc-wait".to_string()));
        let value = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("cancel must unblock the waiter promptly")
            .unwrap()
            .expect_err("cancelled wait returns an error");
        assert_eq!(value.code, ErrorCode::Cancelled);
        assert!(
            state.abort_registry.is_empty(),
            "abort guard must clean up on the cancel path"
        );
    }

    #[tokio::test]
    async fn wait_control_enforces_the_30_minute_maximum() {
        let (state, sid) = state_with_session();
        let err = handle_session_wait_control(
            &state,
            "rpc-wait".into(),
            serde_json::json!({"session_id": sid.0, "timeout_ms": MAX_WAIT_CONTROL_MS + 1}),
        )
        .await
        .expect_err("over-max timeout rejected");
        assert_eq!(err.code, ErrorCode::InvalidParams);
        assert!(err.message.contains("exceeds"));
        assert!(state.abort_registry.is_empty(), "no token leaked");
    }

    #[tokio::test]
    async fn wait_control_defaults_to_five_minutes() {
        assert_eq!(DEFAULT_WAIT_CONTROL_MS, 5 * 60 * 1_000);
        assert_eq!(MAX_WAIT_CONTROL_MS, 30 * 60 * 1_000);
        // A request without `timeout_ms` must be accepted (and must not be
        // rejected for exceeding the cap).
        let (state, sid) = state_with_session();
        let value = handle_session_wait_control(
            &state,
            "rpc-wait".into(),
            serde_json::json!({"session_id": sid.0}),
        )
        .await;
        // Session is `agent`, so this resolves immediately rather than
        // waiting the full default.
        let result: SessionWaitControlResult =
            serde_json::from_value(value.expect("default timeout accepted")).unwrap();
        assert_eq!(result.outcome, WaitControlOutcome::AlreadyAgent);
    }

    #[tokio::test]
    async fn wait_control_requires_session_id() {
        let (state, _sid) = state_with_session();
        let err = handle_session_wait_control(
            &state,
            "rpc-wait".into(),
            serde_json::json!({"timeout_ms": 10}),
        )
        .await
        .expect_err("missing session_id");
        assert_eq!(err.code, ErrorCode::InvalidParams);
    }
}
