//! Daemon control-plane IPC handlers: `system.*`, `browser.*`, `session.*`,
//! `ledger.*`, and `transfer.*`.

use std::sync::Arc;
use std::time::Duration;

use bsk_protocol::system::{
    BrowserListParams, BrowserListResult, BrowserStatusEntry, DaemonSessionStartParams,
    DaemonSessionStartResult, DaemonSessionStopAllParams, DaemonSessionStopFailure,
    DaemonSessionStopParams, DaemonSessionStopResult, LedgerRequestParams, SessionListParams,
    SessionListResult, SessionRunLogParams, StatusParams,
};
use bsk_protocol::tools::{
    TransferBeginParams, TransferChunkParams, TransferIdParams, TransferReadParams,
};
use bsk_protocol::{ErrorCode, Method, ResponseBody, RpcError, RpcId};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;
use tracing::debug;

use crate::ipc_client::IpcRequestMeta;

use super::abort::AbortToken;
use super::ipc::DaemonStatus;
use super::queue::{DEFAULT_TOOL_TIMEOUT, DispatchError};
use super::sessions::{
    AgentWindowOptions, SessionId, StartSessionError, StopSessionError, snapshot_status_entries,
};
use super::state::DaemonState;
use super::tool_pipeline::invalid_params;

pub(super) const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(15);
/// Upper bound on `wait_for_browser_ms` accepted over IPC.
const MAX_BROWSER_WAIT: Duration = Duration::from_secs(60);
// `session.stop` fast-fails while another tool is active; this budget
// only needs to cover the stop RPC itself and IPC scheduling grace.
pub(super) const DEFAULT_SESSION_STOP_TIMEOUT: Duration =
    Duration::from_secs(DEFAULT_TOOL_TIMEOUT.as_secs() + DEFAULT_RPC_TIMEOUT.as_secs() + 5);

pub(super) type CliSessionStopResult = DaemonSessionStopResult;
type CliSessionStopFailure = DaemonSessionStopFailure;
type SessionStopReply = Result<CliSessionStopResult, RpcError>;

#[derive(Debug)]
pub(super) struct RecordSessionStop {
    created_at_ms: i64,
    pub(super) result: watch::Receiver<Option<SessionStopReply>>,
}

pub(super) async fn handle_status(
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

pub(super) fn handle_session_run_log(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
    let p: SessionRunLogParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
    };
    let session = SessionId(p.session_id);
    if state.sessions.touch(&session) {
        ResponseBody::Ok(
            serde_json::to_value(state.run_logs.read(&session.0)).unwrap_or(Value::Null),
        )
    } else {
        ResponseBody::Err(
            DispatchError::SessionNotFound {
                ended: state.sessions.end_info(&session),
            }
            .into_rpc(),
        )
    }
}

pub(super) async fn handle_session_start_scoped(
    state: &Arc<DaemonState>,
    rpc_id: RpcId,
    params: Value,
    recoverable: bool,
    req_meta: &IpcRequestMeta,
) -> Result<Value, RpcError> {
    let abort_guard = state
        .abort_registry
        .register(rpc_id)
        .map_err(|err| RpcError {
            code: ErrorCode::ProtocolError,
            message: format!("session.start cancellation registration failed: {err:?}"),
            data: None,
        })?;
    let cancel = abort_guard.token().clone();
    let params: DaemonSessionStartParams = parse_params_or_default(params)?;
    if !recoverable && params.request_id.is_some() {
        return Err(invalid_params("request_id requires session.start_tracked"));
    }
    let incognito = params.incognito.unwrap_or(false);
    let task_name = params.task_name;
    if let Some(controller) = &params.controller {
        controller.validate().map_err(|message| RpcError {
            code: ErrorCode::InvalidParams,
            message,
            data: None,
        })?;
    }
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

    let scope = req_meta.caller_scope.as_deref().unwrap_or("default");
    let binds_caller_scope = req_meta.bind_scope || req_meta.reuse_or_start_scope;
    let scope_lock = binds_caller_scope.then(|| state.scopes.scope_start_lock(scope));
    let _scope_guard = match &scope_lock {
        Some(lock) => {
            if cancel.is_cancelled() {
                return Err(map_start_error(StartSessionError::Cancelled));
            }
            let acquire = lock.lock();
            tokio::pin!(acquire);
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    return Err(map_start_error(StartSessionError::Cancelled));
                }
                guard = &mut acquire => Some(guard),
            }
        }
        None => None,
    };
    if req_meta.reuse_or_start_scope
        && let Some((binding, live)) = state.scopes.active_binding(scope, &state.sessions)
    {
        if let Some(ref selector) = params.browser_instance_id {
            match state.browsers.select(Some(selector.as_str())) {
                Ok(selected) if selected.id != binding.browser_id => {
                    return Err(RpcError {
                        code: ErrorCode::InvalidParams,
                        message: format!(
                            "current scope is already bound to session '{}' on browser '{}', which conflicts with --browser '{}'; run 'bsk close' first or pass '--scope <name>'",
                            binding.session_id, binding.browser_id, selector
                        ),
                        data: Some(serde_json::json!({
                            "reason": bsk_protocol::RpcErrorReason::ScopeBrowserConflict.as_str(),
                            "session_id": binding.session_id.0,
                            "bound_browser": binding.browser_id.0,
                            "requested_browser": selected.id.0,
                        })),
                    });
                }
                Ok(_) => {}
                Err(select_err) => {
                    if selector != &binding.browser_id.0 {
                        return Err(map_select_browser_error(&state.browsers, select_err));
                    }
                }
            }
        }
        if (req_meta.explicit_incognito && incognito != binding.incognito)
            || (incognito && !binding.incognito)
        {
            return Err(RpcError {
                code: ErrorCode::InvalidParams,
                message: format!(
                    "current scope is already bound to {} session '{}', which conflicts with --incognito; run 'bsk close' first or pass '--scope <name>'",
                    if binding.incognito {
                        "an incognito"
                    } else {
                        "a normal"
                    },
                    binding.session_id
                ),
                data: Some(serde_json::json!({
                    "reason": bsk_protocol::RpcErrorReason::ScopeIncognitoConflict.as_str(),
                    "session_id": binding.session_id.0,
                })),
            });
        }
        if state.browsers.get(&binding.browser_id).is_some() {
            state.sessions.touch(&binding.session_id);
            let result = DaemonSessionStartResult {
                interaction: live.interaction,
                session_id: live.id.0,
                browser_instance_id: live.browser_id.0,
                agent_window_id: live.agent_window_id,
            };
            return Ok(serde_json::to_value(result).unwrap_or(Value::Null));
        }
        state.teardown_session(
            &binding.session_id,
            bsk_protocol::RpcErrorReason::BrowserDisconnected.as_str(),
        );
    }

    let requested_incognito = incognito;
    match super::sessions::start_session_recoverable(
        &state.browsers,
        &state.sessions,
        &state.tool_queues,
        params.browser_instance_id.as_deref(),
        AgentWindowOptions {
            controller: params.controller,
            incognito,
            size: window_size,
            focused: params.focused,
        },
        state.config.extension_connect_wait,
        DEFAULT_RPC_TIMEOUT,
        Some(cancel),
        recoverable,
    )
    .await
    {
        Ok(session) => {
            if let Some(name) = task_name {
                let audit = Arc::clone(&state.audit);
                let sid_for_audit = session.id.0.clone();
                let _ = tokio::task::spawn_blocking(move || audit.set_name(&sid_for_audit, &name))
                    .await;
            }
            if req_meta.bind_scope || req_meta.reuse_or_start_scope {
                state.scopes.bind_scope(
                    scope,
                    session.id.clone(),
                    session.browser_id.clone(),
                    requested_incognito,
                );
            }
            let result = DaemonSessionStartResult {
                interaction: session.interaction,
                session_id: session.id.0.clone(),
                browser_instance_id: session.browser_id.0.clone(),
                agent_window_id: session.agent_window_id,
            };
            Ok(serde_json::to_value(result).unwrap_or(Value::Null))
        }
        Err(err) => {
            if recoverable && let StartSessionError::CleanupFailed { session_id, .. } = &err {
                state.tool_queues.spawn_if_live(session_id.clone());
            }
            let mut error = map_start_error(err);
            if error.code == ErrorCode::NoBrowserConnected && state.recent_unpaired().is_some() {
                error.data = Some(serde_json::json!({"reason":"local_pairing_required"}));
            }
            Err(error)
        }
    }
}

pub(super) fn map_start_error(err: StartSessionError) -> RpcError {
    let code = match &err {
        StartSessionError::NoBrowserConnected => ErrorCode::NoBrowserConnected,
        StartSessionError::MultipleBrowsersOnline { .. } => ErrorCode::MultipleBrowsersOnline,
        StartSessionError::BrowserNotFound { .. } => ErrorCode::NotFound,
        StartSessionError::AmbiguousBrowserLabel { .. } => ErrorCode::InvalidParams,
        StartSessionError::IdExhausted => ErrorCode::ProtocolError,
        StartSessionError::Timeout => ErrorCode::Timeout,
        StartSessionError::Cancelled => ErrorCode::Cancelled,
        StartSessionError::CleanupFailed { .. } => ErrorCode::ProtocolError,
        StartSessionError::TransportClosed => ErrorCode::ProtocolError,
        StartSessionError::ExtensionUnresponsive => ErrorCode::Timeout,
        StartSessionError::DaemonRestarting => ErrorCode::ProtocolError,
        StartSessionError::ExtensionError(inner) => inner.code,
    };
    let message = err.to_string();
    let data = match &err {
        StartSessionError::MultipleBrowsersOnline { browsers } => {
            Some(serde_json::json!({ "browsers": browsers }))
        }
        // A selector miss lists the candidates it could have meant, so
        // the caller can pick a connected instance or label instead of
        // probing every browser in turn. Emitted only when at least one
        // browser is online, so a miss against an empty registry keeps
        // the historical `code` + `message`-only payload.
        StartSessionError::BrowserNotFound { browsers } if !browsers.is_empty() => {
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
        StartSessionError::ExtensionUnresponsive => {
            Some(serde_json::json!({ "reason": "extension_unresponsive" }))
        }
        StartSessionError::TransportClosed => Some(super::browsers::extension_disconnected_data()),
        _ => None,
    };
    RpcError {
        code,
        message,
        data,
    }
}

fn map_select_browser_error(
    browsers: &super::browsers::BrowserRegistry,
    err: super::browsers::SelectError,
) -> RpcError {
    let entries: Vec<BrowserStatusEntry> = browsers
        .snapshot()
        .into_iter()
        .map(|b| b.status_entry(0))
        .collect();
    match err {
        super::browsers::SelectError::NoBrowserConnected => {
            map_start_error(StartSessionError::NoBrowserConnected)
        }
        super::browsers::SelectError::MultipleBrowsersOnline => {
            map_start_error(StartSessionError::MultipleBrowsersOnline { browsers: entries })
        }
        super::browsers::SelectError::NotFound => {
            map_start_error(StartSessionError::BrowserNotFound { browsers: entries })
        }
        super::browsers::SelectError::AmbiguousLabel {
            label,
            instance_ids,
        } => map_start_error(StartSessionError::AmbiguousBrowserLabel {
            label,
            instance_ids,
        }),
    }
}

pub(super) async fn handle_session_stop(
    state: &Arc<DaemonState>,
    rpc_id: RpcId,
    params: Value,
    req_meta: &IpcRequestMeta,
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
    let params: DaemonSessionStopParams = parse_params_or_default(params)?;
    if params.all {
        return handle_session_stop_all(state, Some(cancel)).await;
    }
    let session_id = match params.session_id.filter(|s| !s.trim().is_empty()) {
        Some(s) => SessionId(s),
        None => {
            if let Some(scope) = req_meta.caller_scope.as_deref() {
                state
                    .scopes
                    .resolve_implicit_session(scope, &state.sessions)?
            } else {
                return Err(RpcError {
                    code: ErrorCode::InvalidParams,
                    message: "session.stop requires session_id or all=true".into(),
                    data: None,
                });
            }
        }
    };
    let result = if params.recording {
        stop_record_session(state, &session_id, cancel).await?
    } else {
        stop_one_session(state, &session_id, Some(cancel)).await?
    };
    Ok(serde_json::to_value(result).unwrap_or(Value::Null))
}

async fn stop_record_session(
    state: &Arc<DaemonState>,
    session_id: &SessionId,
    cancel: AbortToken,
) -> SessionStopReply {
    let mut pending = {
        let mut stops = state.record_session_stops.lock().unwrap();
        // Keep failed outcomes while the session is live so the other
        // recorder observes the same failure. Explicit session.stop can retry.
        stops.retain(|id, stop| {
            stop.result.borrow().is_none()
                || state
                    .sessions
                    .get(id)
                    .is_some_and(|session| session.created_at_ms == stop.created_at_ms)
        });
        if let Some(pending) = stops.get(session_id) {
            pending.result.clone()
        } else {
            let Some(session) = state.sessions.get(session_id) else {
                if state.sessions.end_info(session_id).is_some_and(|end| {
                    end.reason == bsk_protocol::RpcErrorReason::SessionStopped.as_str()
                }) {
                    return Ok(CliSessionStopResult {
                        stopped: vec![session_id.0.clone()],
                        ..Default::default()
                    });
                }
                return Err(map_stop_error(StopSessionError::NotFound));
            };

            let (finished, pending) = watch::channel(None);
            stops.insert(
                session_id.clone(),
                RecordSessionStop {
                    created_at_ms: session.created_at_ms,
                    result: pending.clone(),
                },
            );
            let state = Arc::clone(state);
            let session_id = session_id.clone();
            // The caller owns its wait. The daemon owns teardown, even if
            // the first CLI cancels or disconnects.
            tokio::spawn(async move {
                let result = finish_record_session(&state, &session_id).await;
                let mut stops = state.record_session_stops.lock().unwrap();
                if result.as_ref().is_ok_and(|stop| stop.failed.is_empty()) {
                    stops.remove(&session_id);
                }
                finished.send_replace(Some(result));
            });
            pending
        }
    };

    tokio::select! {
        biased;
        result = pending.wait_for(Option::is_some) => match result {
            Ok(result) => result.as_ref().expect("completed stop result").clone(),
            Err(_) => Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: "recording session cleanup ended without a result".into(),
                data: None,
            }),
        },
        _ = cancel.cancelled() => Err(RpcError {
            code: ErrorCode::Cancelled,
            message: "recording session cleanup wait cancelled; cleanup continues".into(),
            data: None,
        }),
    }
}

async fn finish_record_session(
    state: &Arc<DaemonState>,
    session_id: &SessionId,
) -> SessionStopReply {
    // record_stop bypasses the busy gate and can return its trace just
    // before the queued record_await has delivered the same trace.
    if let Ok(activity) = state.tool_queues.activity(session_id)
        && activity.method.as_deref() == Some(Method::ToolRecordAwait.wire_name())
    {
        state
            .tool_queues
            .wait_idle(
                session_id,
                activity.command_id.as_deref(),
                DEFAULT_SESSION_STOP_TIMEOUT.as_millis() as u32,
                AbortToken::default(),
            )
            .await
            .map_err(DispatchError::into_rpc)?;
    }
    stop_one_session(state, session_id, None).await
}

async fn stop_one_session(
    state: &Arc<DaemonState>,
    session_id: &SessionId,
    cancel: Option<AbortToken>,
) -> SessionStopReply {
    match state
        .stop_session_with_reason(
            session_id,
            bsk_protocol::RpcErrorReason::SessionStopped.as_str(),
            DEFAULT_SESSION_STOP_TIMEOUT,
            cancel,
        )
        .await
    {
        Ok(stop) => Ok(CliSessionStopResult {
            stopped: vec![session_id.0.clone()],
            failed: Vec::new(),
            returned_tab_ids: stop.returned_tab_ids,
            return_failures: stop.return_failures,
        }),
        Err(StopSessionError::ReturnFailures(stop)) => {
            let message = format!(
                "failed to return borrowed tabs during session stop ({} failure(s)); session left running",
                stop.return_failures.len()
            );
            Ok(CliSessionStopResult {
                stopped: Vec::new(),
                failed: vec![CliSessionStopFailure {
                    session_id: session_id.0.clone(),
                    code: ErrorCode::CdpFailed,
                    message,
                }],
                returned_tab_ids: stop.returned_tab_ids,
                return_failures: stop.return_failures,
            })
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
    let message = err.to_string();
    let data = match &err {
        StopSessionError::TransportClosed => Some(super::browsers::extension_disconnected_data()),
        StopSessionError::ExtensionError(inner) => inner.data.clone(),
        _ => None,
    };
    RpcError {
        code,
        message,
        data,
    }
}

pub(super) async fn handle_session_stop_all_rpc(
    state: &Arc<DaemonState>,
    rpc_id: RpcId,
    params: Value,
) -> Result<Value, RpcError> {
    let _: DaemonSessionStopAllParams = parse_params_or_default(params)?;
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
    cancel: Option<AbortToken>,
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
        if cancel.as_ref().is_some_and(AbortToken::is_cancelled) {
            return Err(RpcError {
                code: ErrorCode::Cancelled,
                message: "session.stop_all was cancelled".into(),
                data: None,
            });
        }
        match state
            .stop_session_with_reason(
                &id,
                bsk_protocol::RpcErrorReason::SessionStopped.as_str(),
                DEFAULT_SESSION_STOP_TIMEOUT,
                cancel.clone(),
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

pub(super) fn handle_session_list(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
    if let Err(err) = parse_params_or_default::<SessionListParams>(params) {
        return ResponseBody::Err(err);
    }
    let sessions: Vec<_> = state
        .sessions
        .snapshot()
        .into_iter()
        .map(|s| s.status_entry())
        .collect();
    ResponseBody::Ok(serde_json::to_value(SessionListResult { sessions }).unwrap_or(Value::Null))
}

pub(super) async fn handle_ledger_request(
    state: &Arc<DaemonState>,
    params: Value,
    req_meta: &IpcRequestMeta,
) -> ResponseBody {
    let p: LedgerRequestParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
    };
    let explicit_sid = p
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| SessionId(s.to_owned()));

    match p.action.as_str() {
        "status" => {
            let sid = match explicit_sid {
                Some(sid) => Some(sid),
                None => match req_meta.caller_scope.as_deref() {
                    Some(scope) => {
                        match state
                            .scopes
                            .resolve_implicit_session(scope, &state.sessions)
                        {
                            Ok(sid) => Some(sid),
                            Err(_) if scope == "default" || state.sessions.is_empty() => None,
                            Err(_) if scope.starts_with("session_env:") => scope
                                .strip_prefix("session_env:")
                                .map(|raw| SessionId(raw.to_owned())),
                            Err(err) => return ResponseBody::Err(err),
                        }
                    }
                    None => None,
                },
            };
            if let Some(ref sid) = sid {
                state.sessions.touch(sid);
            }
            let reply = state.intent_wal.status(sid.as_ref());
            ResponseBody::Ok(serde_json::to_value(reply).unwrap_or(Value::Null))
        }
        "resolve" => {
            let sid = match explicit_sid {
                Some(sid) => sid,
                None => {
                    let scope_res = req_meta
                        .caller_scope
                        .as_deref()
                        .ok_or_else(|| {
                            invalid_params("ledger.resolve requires session_id or caller scope")
                        })
                        .and_then(|scope| {
                            state
                                .scopes
                                .resolve_implicit_session(scope, &state.sessions)
                        });
                    match scope_res {
                        Ok(sid) => sid,
                        Err(err) => {
                            if let Some(op_id) = p.operation_id.as_deref()
                                && let Some(sid) =
                                    state.intent_wal.find_unknown_session_by_operation(op_id)
                            {
                                sid
                            } else if let Some(raw) = req_meta
                                .caller_scope
                                .as_deref()
                                .and_then(|sc| sc.strip_prefix("session_env:"))
                            {
                                SessionId(raw.to_owned())
                            } else {
                                return ResponseBody::Err(err);
                            }
                        }
                    }
                }
            };
            state.sessions.touch(&sid);
            let reply = state
                .intent_wal
                .resolve_async(&sid, p.tab_id, p.operation_id.as_deref())
                .await;
            ResponseBody::Ok(serde_json::to_value(reply).unwrap_or(Value::Null))
        }
        other => ResponseBody::Err(invalid_params(format!(
            "unsupported ledger action '{other}'; expected 'status' or 'resolve'"
        ))),
    }
}

pub(super) async fn handle_browser_list(
    state: &Arc<DaemonState>,
    params: Value,
) -> Result<Value, RpcError> {
    let params: BrowserListParams = parse_params_or_default(params)?;
    maybe_wait_for_browser(state, params.wait_for_browser_ms).await;
    let browsers = snapshot_status_entries(&state.browsers, &state.sessions);
    Ok(serde_json::to_value(BrowserListResult { browsers }).unwrap_or(Value::Null))
}

pub(super) async fn handle_transfer_begin(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
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
    let transfers = Arc::clone(&state.transfers);
    match tokio::task::spawn_blocking(move || transfers.begin_upload(p)).await {
        Ok(Ok(v)) => ResponseBody::Ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Ok(Err(err)) => ResponseBody::Err(err),
        Err(join_err) => ResponseBody::Err(RpcError {
            code: ErrorCode::ProtocolError,
            message: format!("transfer.begin worker failed: {join_err}"),
            data: None,
        }),
    }
}

pub(super) async fn handle_transfer_chunk(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
    let p: TransferChunkParams = match serde_json::from_value(params) {
        Ok(v) => v,
        Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
    };
    let transfers = Arc::clone(&state.transfers);
    match tokio::task::spawn_blocking(move || transfers.write_chunk(p)).await {
        Ok(Ok(v)) => ResponseBody::Ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Ok(Err(err)) => ResponseBody::Err(err),
        Err(join_err) => ResponseBody::Err(RpcError {
            code: ErrorCode::ProtocolError,
            message: format!("transfer.chunk worker failed: {join_err}"),
            data: None,
        }),
    }
}

pub(super) async fn handle_transfer_finish(
    state: &Arc<DaemonState>,
    params: Value,
) -> ResponseBody {
    let p: TransferIdParams = match serde_json::from_value(params) {
        Ok(v) => v,
        Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
    };
    let transfers = Arc::clone(&state.transfers);
    match tokio::task::spawn_blocking(move || transfers.finish_upload(p)).await {
        Ok(Ok(v)) => ResponseBody::Ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Ok(Err(err)) => ResponseBody::Err(err),
        Err(join_err) => ResponseBody::Err(RpcError {
            code: ErrorCode::ProtocolError,
            message: format!("transfer.finish worker failed: {join_err}"),
            data: None,
        }),
    }
}

pub(super) async fn handle_transfer_read(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
    let p: TransferReadParams = match serde_json::from_value(params) {
        Ok(v) => v,
        Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
    };
    let transfers = Arc::clone(&state.transfers);
    match tokio::task::spawn_blocking(move || transfers.read_chunk(p)).await {
        Ok(Ok(v)) => ResponseBody::Ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Ok(Err(err)) => ResponseBody::Err(err),
        Err(join_err) => ResponseBody::Err(RpcError {
            code: ErrorCode::ProtocolError,
            message: format!("transfer.read worker failed: {join_err}"),
            data: None,
        }),
    }
}

pub(super) async fn handle_transfer_release(
    state: &Arc<DaemonState>,
    params: Value,
) -> ResponseBody {
    let p: TransferIdParams = match serde_json::from_value(params) {
        Ok(v) => v,
        Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
    };
    let transfers = Arc::clone(&state.transfers);
    match tokio::task::spawn_blocking(move || transfers.release(p)).await {
        Ok(v) => ResponseBody::Ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Err(join_err) => ResponseBody::Err(RpcError {
            code: ErrorCode::ProtocolError,
            message: format!("transfer.release worker failed: {join_err}"),
            data: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_error_keeps_the_extension_error_data() {
        let data = serde_json::json!({
            "reason": "cleanup_failed",
            "resource_type": "agent_window",
            "resource_id": 100,
        });
        let err = map_stop_error(StopSessionError::ExtensionError(RpcError {
            code: ErrorCode::ProtocolError,
            message: "Agent tabs could not be closed".into(),
            data: Some(data.clone()),
        }));
        assert_eq!(err.code, ErrorCode::ProtocolError);
        assert_eq!(err.data, Some(data));
    }
}
