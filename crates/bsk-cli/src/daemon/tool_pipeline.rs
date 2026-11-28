//! Unified `tool.*` execution pipeline for the daemon IPC server.
//!
//! Converges implicit session/context resolution, remote-mode policy checks,
//! non-blocking opt-in audit tickets (`AuditTicketGuard`), pending user-interrupt
//! gating, unified [`ToolInflightRegistry`] cancellation registration across all
//! 6 `tool.*` execution shapes (`wait_ms`, `operation_await`/`operation_cancel`,
//! direct `video`, `debug` activity/wait, dialog-gated tools, and queued/unlocked
//! browser tools), non-blocking file staging & WAL persistence, and post-RPC
//! scope/WAL/run-log reconciliation.

use std::sync::Arc;
use std::time::Duration;

use bsk_protocol::tools::{
    DownloadParams, DownloadResult, TransferIdParams, UploadParams, WaitMsParams, WaitMsResult,
};
use bsk_protocol::{
    CancelParams, CancelResult, ErrorCode, Method, RequestFrame, ResponseBody, RpcError, RpcId,
    WsCorrelation,
};
use serde_json::Value;
use tracing::warn;

use crate::ipc_client::{IpcRequestMeta, IpcResponseMeta, ScopeResultMeta};

use super::abort::AbortRegistry;
use super::audit::{AuditStore, Ticket as AuditTicket};
use super::browsers::{BrowserClient, SendError};
use super::inflight::{PromoteOutcome, ToolInflightRegistry};
use super::queue::{DEFAULT_TOOL_TIMEOUT, DispatchError};
use super::sessions::{SessionActivityGuard, SessionId};
use super::state::DaemonState;

// Some tools own their operation deadline and answer exactly at it: the file
// transfers need a bounded cleanup before they can return a useful structured
// error, request-help settles its own wait, and the navigation waits report
// `reached: "timeout"` with the URL the page actually reached. Keep those
// transports alive slightly longer so the transport deadline cannot replace a
// result the extension has already produced.
pub(super) const EXTENSION_RESPONSE_GRACE: Duration = Duration::from_secs(2);

/// Upper bound on `tool.wait_ms` (5 minutes). Larger values are
/// rejected as `invalid_params` so a buggy agent cannot wedge a
/// daemon-side sleep beyond a reasonable window.
pub const MAX_WAIT_MS: u64 = 5 * 60 * 1_000;

pub(super) fn invalid_params(message: impl Into<String>) -> RpcError {
    RpcError {
        code: ErrorCode::InvalidParams,
        message: message.into(),
        data: None,
    }
}

/// RAII wrapper around an optional [`AuditTicket`] so no early return,
/// cancellation branch, or background task panic can leak a pending audit entry.
struct AuditTicketGuard {
    audit: Arc<AuditStore>,
    ticket: Option<AuditTicket>,
}

impl AuditTicketGuard {
    async fn begin(
        state: &Arc<DaemonState>,
        method: &Method,
        params: &Value,
    ) -> Result<Self, RpcError> {
        let session_id = params
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !state.audit.needs_begin(session_id) {
            return Ok(Self {
                audit: Arc::clone(&state.audit),
                ticket: None,
            });
        }
        let audit = Arc::clone(&state.audit);
        let sid_owned = session_id.to_owned();
        let method_owned = method.clone();
        let params_owned = params.clone();
        let res = tokio::task::spawn_blocking(move || {
            audit.begin(&sid_owned, &method_owned, &params_owned)
        })
        .await;
        match res {
            Ok(Ok(ticket)) => Ok(Self {
                audit: Arc::clone(&state.audit),
                ticket,
            }),
            Ok(Err(_)) | Err(_) => Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: "Operation audit could not be saved; action was not dispatched. Check the audit page or turn recording off.".into(),
                data: None,
            }),
        }
    }

    fn operation_id(&self) -> Option<String> {
        self.ticket.as_ref().map(|t| t.operation_id.clone())
    }

    fn take_for_background(&mut self) -> Self {
        Self {
            audit: Arc::clone(&self.audit),
            ticket: self.ticket.take(),
        }
    }

    async fn finish(&mut self, body: &ResponseBody) {
        let Some(ticket) = self.ticket.take() else {
            return;
        };
        let audit = Arc::clone(&self.audit);
        let body_owned = body.clone();
        let _ = tokio::task::spawn_blocking(move || audit.finish(ticket, &body_owned)).await;
    }
}

impl Drop for AuditTicketGuard {
    fn drop(&mut self) {
        let Some(ticket) = self.ticket.take() else {
            return;
        };
        let audit = Arc::clone(&self.audit);
        let fallback = ResponseBody::Err(RpcError {
            code: ErrorCode::Cancelled,
            message: "tool call dropped before completion".into(),
            data: None,
        });
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            drop(handle.spawn_blocking(move || audit.finish(ticket, &fallback)));
        } else {
            audit.finish(ticket, &fallback);
        }
    }
}

#[derive(Debug, Clone)]
struct CooperateSyncPlan {
    session_id: SessionId,
    is_sync: bool,
    req_tab_id: Option<i64>,
    requested_max_tokens: Option<u32>,
}

#[derive(Debug, Clone)]
struct TabTransitionPlan {
    session_id: SessionId,
    method: Method,
    req_params: Value,
}

#[derive(Debug, Clone, Default)]
struct ToolReconcilePlan {
    cooperate: Option<CooperateSyncPlan>,
    tab_transition: Option<TabTransitionPlan>,
    logged: Option<(Method, Value)>,
    return_scope_meta: bool,
}

impl ToolReconcilePlan {
    fn from_request(method: &Method, params: &Value, req_meta: &IpcRequestMeta) -> Self {
        let cooperate = (*method == Method::ToolCooperate)
            .then(|| {
                let action = params.get("action").and_then(Value::as_str)?;
                if matches!(action, "sync" | "enable") {
                    let sid = params
                        .get("session_id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(|s| SessionId(s.to_string()))?;
                    let req_tab_id = params.get("tab_id").and_then(Value::as_i64);
                    let requested_max_tokens = params
                        .get("max_tokens")
                        .and_then(Value::as_u64)
                        .and_then(|n| u32::try_from(n).ok());
                    Some(CooperateSyncPlan {
                        session_id: sid,
                        is_sync: action == "sync",
                        req_tab_id,
                        requested_max_tokens,
                    })
                } else {
                    None
                }
            })
            .flatten();
        let tab_transition = method
            .spec()
            .tab_transition
            .then(|| {
                let sid = params
                    .get("session_id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|s| SessionId(s.to_string()))?;
                Some(TabTransitionPlan {
                    session_id: sid,
                    method: method.clone(),
                    req_params: params.clone(),
                })
            })
            .flatten();
        let logged = (!matches!(
            method,
            Method::ToolOperationAwait | Method::ToolOperationCancel
        ) && method.is_tool())
        .then(|| (method.clone(), params.clone()));
        Self {
            cooperate,
            tab_transition,
            logged,
            return_scope_meta: req_meta.return_scope_meta,
        }
    }
}

/// Unified post-completion reconciliation across `scopes`, `intent_wal`, and
/// `run_logs`. Invoked identically whether a tool RPC finishes synchronously or
/// settles asynchronously after `DialogPending` via `tool.dialog.*` + `operation_await`.
async fn reconcile_completed_tool_rpc(
    state: &DaemonState,
    plan: &ToolReconcilePlan,
    operation_id: Option<&str>,
    body: &ResponseBody,
) -> Option<ScopeResultMeta> {
    let mut recorded_meta = None;
    if let (Some(coop), ResponseBody::Ok(value)) = (&plan.cooperate, body)
        && state.sessions.get(&coop.session_id).is_some()
    {
        let recorded = state.scopes.record_cooperate_result_with_budget(
            &coop.session_id,
            coop.requested_max_tokens,
            value,
        );
        if coop.is_sync {
            let synced_tab_id = value
                .get("tab_id")
                .and_then(Value::as_i64)
                .or(coop.req_tab_id)
                .or_else(|| state.scopes.active_tab_id(&coop.session_id));
            state
                .intent_wal
                .reconcile_tab_async(&coop.session_id, synced_tab_id, "cooperate_sync")
                .await;
        }
        recorded_meta = Some(recorded);
    }
    if let (Some(tab), ResponseBody::Ok(value)) = (&plan.tab_transition, body)
        && state.sessions.get(&tab.session_id).is_some()
    {
        state
            .scopes
            .record_tab_transition(&tab.session_id, &tab.method, &tab.req_params, value);
    }
    if let Some((method, params)) = &plan.logged {
        if let Some(sid) = params
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            let session_id = SessionId(sid.to_owned());
            let req_ctx = params
                .get("context_id")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty());
            let req_tab_id = params.get("tab_id").and_then(Value::as_i64).or_else(|| {
                req_ctx.and_then(|ctx| state.scopes.tab_id_for_context(&session_id, ctx))
            });
            match body {
                ResponseBody::Ok(val)
                    if matches!(
                        method,
                        Method::ToolNavigate
                            | Method::ToolReload
                            | Method::ToolNavigateBack
                            | Method::ToolNavigateForward
                    ) =>
                {
                    let tid = val.get("tab_id").and_then(Value::as_i64).or(req_tab_id);
                    state
                        .scopes
                        .clear_implicit_tab_context(&session_id, tid, None);
                }
                ResponseBody::Err(err) => {
                    let effect = err
                        .data
                        .as_ref()
                        .and_then(|d| d.get("effect_state"))
                        .and_then(Value::as_str);
                    let reason = err
                        .data
                        .as_ref()
                        .and_then(|d| d.get("reason"))
                        .and_then(Value::as_str);
                    let tid = err
                        .data
                        .as_ref()
                        .and_then(|d| d.get("tab_id"))
                        .and_then(Value::as_i64)
                        .or(req_tab_id);
                    if effect == Some("unknown")
                        || matches!(reason, Some("page_load_failed" | "frame_unobservable"))
                    {
                        state
                            .scopes
                            .clear_implicit_tab_context(&session_id, tid, None);
                    } else if matches!(
                        reason,
                        Some(
                            "control_context_invalid"
                                | "document_changed"
                                | "human_intervention"
                                | "control_held"
                                | "cooperation_sync_required"
                        )
                    ) {
                        state
                            .scopes
                            .clear_implicit_tab_context(&session_id, tid, req_ctx);
                    }
                }
                _ => {}
            }
        }
        let hydrated_body;
        let body_for_log = if *method == Method::ToolCooperate
            && let ResponseBody::Ok(val) = body
            && val.pointer("/observation/text").is_none()
            && val.get("kind").and_then(Value::as_str) == Some("delta")
            && let Some(ref meta) = recorded_meta
            && meta.cache_reusable
            && let Some(ref cached_vom) = meta.cached_vom
        {
            let mut cloned = val.clone();
            if !cloned.get("observation").is_some_and(Value::is_object) {
                cloned["observation"] = serde_json::json!({});
            }
            cloned["observation"]["text"] = Value::String(cached_vom.clone());
            hydrated_body = ResponseBody::Ok(cloned);
            &hydrated_body
        } else {
            body
        };
        let is_live = |id: &str| state.sessions.get(&SessionId(id.to_owned())).is_some();
        if let Some(op_id) = operation_id {
            state
                .run_logs
                .resolve_operation(is_live, op_id, method, params, body_for_log);
        } else {
            state.run_logs.record(is_live, method, params, body_for_log);
        }
    }
    if recorded_meta.is_none()
        && plan.return_scope_meta
        && let Some((_, params)) = &plan.logged
        && let Some(sid) = params
            .get("session_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    {
        let applied_ctx = params
            .get("context_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let applied_tab = match body {
            ResponseBody::Ok(val) => val.get("tab_id").and_then(Value::as_i64),
            _ => None,
        }
        .or_else(|| params.get("tab_id").and_then(Value::as_i64));
        recorded_meta = Some(ScopeResultMeta {
            session_id: sid.to_owned(),
            tab_id: applied_tab,
            short_ctx: applied_ctx,
            ..Default::default()
        });
    }
    recorded_meta
}

pub(super) fn prepare_implicit_session_and_evidence(
    state: &DaemonState,
    method: &Method,
    params: &mut Value,
    req_meta: &IpcRequestMeta,
) -> Result<(), RpcError> {
    if !method.implicit_session_with_params(params) {
        return Ok(());
    }
    let auto_inject_context = method.auto_injects_context_with_params(params);
    if params.is_null() {
        *params = serde_json::json!({});
    }
    let Some(obj) = params.as_object_mut() else {
        return Ok(());
    };

    let explicit_sid = obj
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);

    let session_id = match explicit_sid {
        Some(sid) => SessionId(sid),
        None => {
            // Only resolve an implicit session when the caller signalled an implicit
            // CLI/MCP invocation via `req_meta.caller_scope` OR passed an empty
            // `session_id: ""` placeholder from an optional `--session` flag; raw
            // protocol unit tests sending malformed JSON without `session_id` keep InvalidParams.
            let has_empty_placeholder = obj
                .get("session_id")
                .and_then(Value::as_str)
                .is_some_and(|s| s.trim().is_empty());
            if req_meta.caller_scope.is_none() && !has_empty_placeholder {
                return Ok(());
            }
            let scope = req_meta.caller_scope.as_deref().unwrap_or("default");
            let resolved = state
                .scopes
                .resolve_implicit_session(scope, &state.sessions)?;
            obj.insert("session_id".into(), Value::String(resolved.0.clone()));
            resolved
        }
    };

    let tab_id = obj.get("tab_id").and_then(Value::as_i64);

    // Expand explicit `--context c1`, or inject latest target-policy context when omitted.
    match obj.get("context_id").and_then(Value::as_str) {
        Some(raw_ctx) if !raw_ctx.trim().is_empty() => {
            if let Some(uuid) = state.scopes.expand_short_ctx(&session_id, raw_ctx.trim()) {
                obj.insert("context_id".into(), Value::String(uuid));
            }
        }
        _ => {
            obj.remove("context_id");
            if auto_inject_context
                && let Some(uuid) = state.scopes.implicit_target_context(&session_id, tab_id)
            {
                obj.insert("context_id".into(), Value::String(uuid));
            }
        }
    }

    // Expand explicit `--observation o1` ONLY; never fabricate omitted `observation_id`.
    match obj.get("observation_id").and_then(Value::as_str) {
        Some(raw_obs) if !raw_obs.trim().is_empty() => {
            if let Some(uuid) = state.scopes.expand_short_obs(&session_id, raw_obs.trim()) {
                obj.insert("observation_id".into(), Value::String(uuid));
            }
        }
        Some(_) => {
            obj.remove("observation_id");
        }
        None => {}
    }

    Ok(())
}

/// Canonical entry point for every `tool.*` RPC accepted over IPC.
pub(super) async fn execute_tool_rpc(
    state: Arc<DaemonState>,
    cli_rpc_id: RpcId,
    method: Method,
    params: Value,
    req_meta: &IpcRequestMeta,
) -> (ResponseBody, IpcResponseMeta) {
    if state.config.server.is_some() && !method.spec().remote_allowed {
        return (
            ResponseBody::Err(RpcError {
                code: ErrorCode::Unsupported,
                message: format!(
                    "{} is not supported for remote browsers",
                    method.wire_name()
                ),
                data: None,
            }),
            IpcResponseMeta::default(),
        );
    }

    let reconcile_plan = ToolReconcilePlan::from_request(&method, &params, req_meta);
    let mut audit = match AuditTicketGuard::begin(&state, &method, &params).await {
        Ok(guard) => guard,
        Err(err) => return (ResponseBody::Err(err), IpcResponseMeta::default()),
    };
    let correlation = WsCorrelation {
        audit_id: audit.operation_id(),
        operation_id: None,
    };

    match method {
        Method::ToolWaitMs => {
            let wait_sid = req_meta
                .caller_scope
                .as_deref()
                .and_then(|scope| state.scopes.active_binding(scope, &state.sessions))
                .map(|(binding, _)| binding.session_id);
            let _activity_lease = wait_sid
                .as_ref()
                .and_then(|sid| state.sessions.begin_activity(sid));
            let body = handle_wait_ms_with_session(
                &state.abort_registry,
                &state.tool_inflight,
                cli_rpc_id,
                wait_sid,
                params,
            )
            .await;
            let _ = reconcile_completed_tool_rpc(&state, &reconcile_plan, None, &body).await;
            audit.finish(&body).await;
            (body, IpcResponseMeta::default())
        }
        Method::ToolOperationAwait | Method::ToolOperationCancel => {
            let (body, meta) = handle_operation(&state, cli_rpc_id, method, params, req_meta).await;
            audit.finish(&body).await;
            (body, meta)
        }
        Method::ToolVideo => {
            handle_video(
                &state,
                cli_rpc_id,
                params,
                correlation,
                reconcile_plan,
                &mut audit,
            )
            .await
        }
        _ => {
            handle_dialog_aware_dispatch(
                state,
                cli_rpc_id,
                method,
                params,
                correlation,
                reconcile_plan,
                &mut audit,
            )
            .await
        }
    }
}

type ResolvedVideoBrowser = (
    Arc<BrowserClient>,
    Option<SessionId>,
    Option<SessionActivityGuard>,
);

fn resolve_video_browser(
    state: &DaemonState,
    params: &Value,
) -> Result<ResolvedVideoBrowser, RpcError> {
    if let Err(error) = serde_json::from_value::<bsk_protocol::tools::VideoParams>(params.clone()) {
        return Err(invalid_params(error.to_string()));
    }
    let mut opt_sid = None;
    let mut activity_lease = None;
    let browser = if let Some(session_id) = params.get("session_id").and_then(Value::as_str) {
        let sid = SessionId(session_id.into());
        let Some(session) = state.sessions.get(&sid) else {
            return Err(invalid_params("Video task session is no longer active"));
        };
        activity_lease = state.sessions.begin_activity(&sid);
        let connected = state.browsers.get(&session.browser_id);
        opt_sid = Some(sid);
        connected
    } else {
        match state
            .browsers
            .select(params.get("browser").and_then(Value::as_str))
        {
            Ok(browser) => Some(browser),
            Err(error) => {
                return Err(invalid_params(format!(
                    "Select a connected browser with --browser: {error:?}"
                )));
            }
        }
    };
    let Some(browser) = browser else {
        return Err(invalid_params(
            "Recording browser is disconnected; reconnect it to retrieve the video",
        ));
    };
    Ok((browser, opt_sid, activity_lease))
}

/// Stored videos remain addressable after session teardown. Only `start` takes
/// the session queue (and is dialog-gated); `status`, `stop`, `list`, `get`, and
/// `delete` bypass the serial page queue while still registering in
/// [`ToolInflightRegistry`] so peer `cancel`, `session.user_interrupt`, and
/// session teardown wake them immediately and forward WS `cancel` frames.
async fn handle_video(
    state: &Arc<DaemonState>,
    rpc_id: RpcId,
    params: Value,
    correlation: WsCorrelation,
    reconcile_plan: ToolReconcilePlan,
    audit: &mut AuditTicketGuard,
) -> (ResponseBody, IpcResponseMeta) {
    let (browser, opt_sid, _video_activity_lease) = match resolve_video_browser(state, &params) {
        Ok(resolved) => resolved,
        Err(err) => {
            let body = ResponseBody::Err(err);
            audit.finish(&body).await;
            return (body, IpcResponseMeta::default());
        }
    };
    if Method::ToolVideo.dialog_gated_with_params(&params) {
        return handle_dialog_aware_dispatch(
            Arc::clone(state),
            rpc_id,
            Method::ToolVideo,
            params,
            correlation,
            reconcile_plan,
            audit,
        )
        .await;
    }

    let inflight_guard = match state.tool_inflight.register_optional(rpc_id, opt_sid) {
        Ok(guard) => guard,
        Err(err) => {
            let body = ResponseBody::Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: format!("inflight registration rejected: {err}"),
                data: None,
            });
            audit.finish(&body).await;
            return (body, IpcResponseMeta::default());
        }
    };

    let ws_id = format!("video-{}", uuid::Uuid::new_v4().simple());
    let mut dispatch_slot = None;
    let promote =
        inflight_guard
            .entry()
            .promote_to_forwarded_with(browser.id.clone(), ws_id.clone(), || {
                let res = browser.dispatch(RequestFrame::for_extension_ws(
                    ws_id.clone(),
                    Method::ToolVideo,
                    params,
                    &correlation,
                ));
                let ok = res.is_ok();
                dispatch_slot = Some(res);
                ok
            });

    let mut result = match promote {
        PromoteOutcome::Cancelled => ResponseBody::Err(
            inflight_guard
                .entry()
                .cancel_error("video command cancelled"),
        ),
        PromoteOutcome::SendFailed => match dispatch_slot.expect("dispatch closure ran") {
            Err(SendError::Terminated(error)) => ResponseBody::Err(error),
            Err(SendError::SinkClosed) => {
                ResponseBody::Err(invalid_params("Recording browser disconnected"))
            }
            Ok(_) => unreachable!("SendFailed implies browser.dispatch returned Err"),
        },
        PromoteOutcome::Promoted => {
            let mut receiver = dispatch_slot
                .expect("dispatch closure ran")
                .expect("Promoted implies browser.dispatch returned Ok");
            let cancel_tok = inflight_guard.entry().cancel_token();
            let outcome = tokio::select! {
                reply = tokio::time::timeout(Duration::from_secs(32), &mut receiver) => {
                    match reply {
                        Ok(Ok(frame)) => frame.body,
                        Ok(Err(_)) => ResponseBody::Err(invalid_params("Recording browser disconnected")),
                        Err(_) => ResponseBody::Err(RpcError {
                            code: ErrorCode::Timeout,
                            message: "Video service timed out; use video list/status before retrying".into(),
                            data: None,
                        }),
                    }
                }
                _ = cancel_tok.cancelled() => {
                    ResponseBody::Err(inflight_guard.entry().cancel_error("video command cancelled"))
                }
            };
            browser
                .pending
                .lock()
                .expect("browser pending poisoned")
                .cancel(&ws_id);
            outcome
        }
    };

    drop(inflight_guard);
    if let ResponseBody::Ok(value) = &mut result {
        value["browser"] = Value::String(browser.id.0.clone());
    }
    let _ = reconcile_completed_tool_rpc(state, &reconcile_plan, None, &result).await;
    audit.finish(&result).await;
    (result, IpcResponseMeta::default())
}

async fn handle_dialog_aware_dispatch(
    state: Arc<DaemonState>,
    cli_rpc_id: RpcId,
    method: Method,
    params: Value,
    mut correlation: WsCorrelation,
    reconcile_plan: ToolReconcilePlan,
    audit: &mut AuditTicketGuard,
) -> (ResponseBody, IpcResponseMeta) {
    let return_scope_meta = reconcile_plan.return_scope_meta;
    if !method.dialog_gated_with_params(&params) {
        let body = handle_tool_dispatch(&state, cli_rpc_id, method, params, correlation).await;
        let scope_meta = reconcile_completed_tool_rpc(&state, &reconcile_plan, None, &body).await;
        audit.finish(&body).await;
        return (
            body,
            IpcResponseMeta {
                scope_meta: return_scope_meta.then_some(scope_meta).flatten(),
            },
        );
    }
    let session = params
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let operation = match state
        .dialog_operations
        .register(session, &cli_rpc_id, method.clone())
    {
        Ok(operation) => operation,
        Err(error) => {
            let body = ResponseBody::Err(error);
            audit.finish(&body).await;
            return (body, IpcResponseMeta::default());
        }
    };
    correlation.operation_id = Some(operation.id.clone());
    let mut bg_audit = audit.take_for_background();
    let work = Arc::clone(&operation);
    let background = Arc::clone(&state);
    let op_id_for_reconcile = operation.id.clone();
    let plan_for_bg = reconcile_plan.clone();
    let method_for_pending = method.clone();
    let params_for_pending = params.clone();
    let cli_rpc_id_for_suspend = cli_rpc_id.clone();
    tokio::spawn(async move {
        use futures_util::FutureExt;
        let body = std::panic::AssertUnwindSafe(handle_tool_dispatch(
            &background,
            cli_rpc_id,
            method,
            params,
            correlation,
        ))
        .catch_unwind()
        .await
        .unwrap_or_else(|_| {
            ResponseBody::Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: "operation task failed; browser effect is unknown".into(),
                data: None,
            })
        });
        let scope_meta = reconcile_completed_tool_rpc(
            &background,
            &plan_for_bg,
            Some(&op_id_for_reconcile),
            &body,
        )
        .await;
        if let Some(meta) = scope_meta {
            work.set_scope_meta(Some(meta));
        }
        bg_audit.finish(&body).await;
        work.finish(body);
    });
    let (body, suspended) = operation.initial_response().await;
    if !suspended {
        let scope_meta = return_scope_meta.then(|| operation.scope_meta()).flatten();
        state.dialog_operations.remove(&operation.id);
        (body, IpcResponseMeta { scope_meta })
    } else {
        if let Some(entry) = state.tool_inflight.get(&cli_rpc_id_for_suspend) {
            entry.mark_dialog_retained();
        }
        state.run_logs.record_dialog_pending(
            |id| state.sessions.get(&SessionId(id.to_owned())).is_some(),
            &operation.id,
            &method_for_pending,
            &params_for_pending,
        );
        (body, IpcResponseMeta::default())
    }
}

async fn handle_operation(
    state: &Arc<DaemonState>,
    cli_rpc_id: RpcId,
    method: Method,
    params: Value,
    req_meta: &IpcRequestMeta,
) -> (ResponseBody, IpcResponseMeta) {
    let p: bsk_protocol::tools::OperationParams = match serde_json::from_value(params) {
        Ok(p) => p,
        Err(error) => {
            return (
                ResponseBody::Err(invalid_params(error.to_string())),
                IpcResponseMeta::default(),
            );
        }
    };
    if p.wait_ms.is_some_and(|ms| ms > 60000) {
        return (
            ResponseBody::Err(invalid_params("wait_ms must be 0..60000")),
            IpcResponseMeta::default(),
        );
    }
    let op_sid = SessionId(p.session_id.clone());
    let Some(session) = state.sessions.get(&op_sid) else {
        return (
            ResponseBody::Err(RpcError {
                code: ErrorCode::NotFound,
                message: "session no longer exists".into(),
                data: None,
            }),
            IpcResponseMeta::default(),
        );
    };
    let _activity_lease = state.sessions.begin_activity(&op_sid);
    if state.browsers.get(&session.browser_id).is_none() {
        return (
            ResponseBody::Err(RpcError {
                code: ErrorCode::NotFound,
                message: "owning browser disconnected; original effect is unknown".into(),
                data: None,
            }),
            IpcResponseMeta::default(),
        );
    }
    let Some(operation) = state.dialog_operations.get(&p.session_id, &p.operation_id) else {
        return (
            ResponseBody::Err(RpcError {
                code: ErrorCode::NotFound,
                message: "operation not found in this session or its retained result expired; do not replay an action with unknown effects".into(),
                data: None,
            }),
            IpcResponseMeta::default(),
        );
    };
    if method == Method::ToolOperationCancel {
        let body = handle_cancel(state, serde_json::json!({"rpc_id": operation.cli_rpc_id}));
        return (body, IpcResponseMeta::default());
    }
    let guard = match state.tool_inflight.register(cli_rpc_id, op_sid) {
        Ok(guard) => guard,
        Err(error) => {
            return (
                ResponseBody::Err(RpcError {
                    code: ErrorCode::ProtocolError,
                    message: format!("operation await registration failed: {error}"),
                    data: None,
                }),
                IpcResponseMeta::default(),
            );
        }
    };
    let cancel_tok = guard.entry().cancel_token();
    let body = tokio::select! {
        body = operation.await_result(p.wait_ms.unwrap_or(10000)) => body,
        _ = cancel_tok.cancelled() => ResponseBody::Err(
            guard.entry().cancel_error(
                "Result wait cancelled; the original operation continues. Use operation cancel to stop it",
            ),
        ),
    };
    let scope_meta = if req_meta.return_scope_meta
        && matches!(&body, ResponseBody::Ok(val) if val.get("state").and_then(Value::as_str) == Some("completed"))
    {
        operation.scope_meta()
    } else {
        None
    };
    (body, IpcResponseMeta { scope_meta })
}

async fn release_transfer_async(state: &Arc<DaemonState>, transfer_id: String) {
    let transfers = Arc::clone(&state.transfers);
    let _ = tokio::task::spawn_blocking(move || {
        transfers.release(TransferIdParams { transfer_id });
    })
    .await;
}

async fn handle_tool_dispatch(
    state: &Arc<DaemonState>,
    cli_rpc_id: RpcId,
    method: Method,
    params: Value,
    correlation: WsCorrelation,
) -> ResponseBody {
    let session_id = match params.get("session_id").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => SessionId(s.to_string()),
        _ => {
            return ResponseBody::Err(RpcError {
                code: ErrorCode::InvalidParams,
                message: "tool.* RPC requires non-empty session_id".into(),
                data: None,
            });
        }
    };
    if method.requires_interrupt_gate_with_params(&params)
        && state.session_interrupts.try_consume(&session_id)
    {
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
    let _dialog_decision_guard =
        if matches!(method, Method::ToolDialogAccept | Method::ToolDialogDismiss) {
            let lock = state.dialog_operations.decision_lock(&session_id.0);
            let cancel_token = inflight_guard.entry().cancel_token();
            tokio::select! {
                guard = lock.lock_owned() => Some(guard),
                _ = cancel_token.cancelled() => {
                    let mut err = inflight_guard
                        .entry()
                        .cancel_error("dialog decision cancelled before dispatch");
                    let mut data = err
                        .data
                        .take()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| serde_json::json!({}));
                    if data.get("reason").is_none() {
                        data["reason"] = serde_json::json!(
                            bsk_protocol::RpcErrorReason::CancelledBeforeDispatch.as_str()
                        );
                    }
                    data["dispatched"] = serde_json::json!(false);
                    data["effect_state"] = serde_json::json!("none");
                    data["phase"] = serde_json::json!("precondition");
                    err.data = Some(data);
                    return ResponseBody::Err(err);
                }
                _ = tokio::time::sleep(timeout) => {
                    return ResponseBody::Err(RpcError {
                        code: ErrorCode::Timeout,
                        message: "timed out waiting for in-flight dialog decision".into(),
                        data: Some(serde_json::json!({
                            "reason": bsk_protocol::RpcErrorReason::SessionBusy.as_str(),
                            "dispatched": false,
                            "effect_state": "none",
                            "phase": "precondition",
                        })),
                    });
                }
            }
        } else {
            None
        };
    let wal_mutating = super::intent_wal::IntentWal::is_wal_tracked(&method, &params);
    let wal_tab_id = wal_mutating
        .then(|| {
            if method == Method::ToolDialogAccept {
                state.dialog_operations.active_dialog_tab_id(&session_id.0)
            } else {
                params
                    .get("tab_id")
                    .and_then(Value::as_i64)
                    .or_else(|| {
                        params
                            .get("context_id")
                            .and_then(Value::as_str)
                            .and_then(|ctx| state.scopes.tab_id_for_context(&session_id, ctx))
                    })
                    .or_else(|| state.scopes.active_tab_id(&session_id))
            }
        })
        .flatten();
    if wal_mutating && let Err(err) = state.intent_wal.check_gate(&session_id, wal_tab_id) {
        return ResponseBody::Err(err);
    }
    if method == Method::ToolDebug
        && matches!(
            params.get("action").and_then(Value::as_str),
            Some("activity" | "wait")
        )
    {
        state.sessions.touch(&session_id);
        let p: bsk_protocol::tools::DebugParams = match serde_json::from_value(params) {
            Ok(value) => value,
            Err(error) => return ResponseBody::Err(invalid_params(error.to_string())),
        };
        if p.wait_ms.is_some_and(|ms| ms > 60000)
            || p.command_id.as_ref().is_some_and(|id| id.len() > 200)
        {
            return ResponseBody::Err(invalid_params(
                "wait_ms must be 0..60000; command_id up to 200 characters",
            ));
        }
        let activity = if p.action == bsk_protocol::tools::DebugAction::Activity {
            state.tool_queues.activity(&session_id)
        } else {
            state
                .tool_queues
                .wait_idle(
                    &session_id,
                    p.command_id.as_deref(),
                    p.wait_ms.unwrap_or(10000),
                    inflight_guard.entry().cancel_token(),
                )
                .await
        };
        return match activity {
            Ok(activity) => ResponseBody::Ok(
                serde_json::json!({"session_id": session_id.0, "activity": activity}),
            ),
            Err(DispatchError::Rpc(ref rpc)) if rpc.code == ErrorCode::Cancelled => {
                ResponseBody::Err(inflight_guard.entry().cancel_error(&rpc.message))
            }
            Err(error) => ResponseBody::Err(error.into_rpc()),
        };
    }

    let mut params = params;
    if method == Method::ToolTabBorrow {
        if let Some(confirm) = params.get("confirm")
            && !confirm.is_boolean()
            && !confirm.is_null()
        {
            return ResponseBody::Err(invalid_params("confirm must be a boolean"));
        }
        if let Some(object) = params.as_object_mut() {
            object.remove("confirm");
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
        let transfers = Arc::clone(&state.transfers);
        let sid_owned = session_id.0.clone();
        let paths =
            match tokio::task::spawn_blocking(move || transfers.resolve_uploads(&sid_owned, &ids))
                .await
            {
                Ok(Ok(v)) => v,
                Ok(Err(err)) => return ResponseBody::Err(err),
                Err(join_err) => {
                    return ResponseBody::Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: format!("upload staging worker failed: {join_err}"),
                        data: None,
                    });
                }
            };
        // A sandboxed Safari extension cannot read `staged_path`, so for Safari
        // browsers the bytes travel inline too (bounded; see SAFARI_INLINE_UPLOAD_MAX).
        let inline_bytes = state
            .sessions
            .get(&session_id)
            .and_then(|s| state.browsers.get(&s.browser_id))
            .is_some_and(|b| b.browser_name.eq_ignore_ascii_case("safari"));
        let inlined: Vec<Option<String>> = if inline_bytes {
            let read_paths = paths.clone();
            match tokio::task::spawn_blocking(move || {
                super::file_transfer::inline_upload_bytes(
                    &read_paths,
                    super::file_transfer::SAFARI_INLINE_UPLOAD_MAX,
                )
            })
            .await
            {
                Ok(Ok(v)) => v.into_iter().map(Some).collect(),
                Ok(Err(err)) => return ResponseBody::Err(err),
                Err(join_err) => {
                    return ResponseBody::Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: format!("upload read worker failed: {join_err}"),
                        data: None,
                    });
                }
            }
        } else {
            vec![None; paths.len()]
        };
        for ((file, path), data) in upload.files.iter_mut().zip(paths).zip(inlined) {
            file.data_base64 = data;
            file.staged_path = Some(path.to_string_lossy().into_owned());
        }
        params = serde_json::to_value(upload).unwrap_or(Value::Null);
    } else if method == Method::ToolDownload {
        let mut download: DownloadParams = match serde_json::from_value(params) {
            Ok(v) => v,
            Err(err) => return ResponseBody::Err(invalid_params(err.to_string())),
        };
        let transfers = Arc::clone(&state.transfers);
        let sid_owned = session_id.0.clone();
        let staging =
            match tokio::task::spawn_blocking(move || transfers.begin_download(&sid_owned)).await {
                Ok(Ok(v)) => v,
                Ok(Err(err)) => return ResponseBody::Err(err),
                Err(join_err) => {
                    return ResponseBody::Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: format!("download staging worker failed: {join_err}"),
                        data: None,
                    });
                }
            };
        download.browser_relative_dir = Some(staging.browser_relative_dir);
        download.max_byte_size = Some(staging.max_byte_size);
        download_transfer_id = Some(staging.transfer_id);
        params = serde_json::to_value(download).unwrap_or(Value::Null);
    }

    let entry = inflight_guard.entry();
    let wal_ticket = if wal_mutating {
        Some(
            state
                .intent_wal
                .begin_dispatch_async(
                    &session_id,
                    wal_tab_id,
                    correlation.operation_id.as_deref(),
                    &method,
                    &params,
                )
                .await,
        )
    } else {
        None
    };

    let outcome = if method.queue_unlocked_with_params(&params) {
        state
            .tool_queues
            .dispatch_unlocked_with_context(
                &session_id,
                method.clone(),
                params,
                correlation,
                timeout,
                Some(entry),
            )
            .await
    } else {
        state
            .tool_queues
            .dispatch_with_context(
                &session_id,
                method.clone(),
                params,
                correlation,
                timeout,
                Some(entry),
            )
            .await
    };
    drop(inflight_guard);
    if let Some(wal_ticket) = wal_ticket {
        state
            .intent_wal
            .finish_dispatch_async(wal_ticket, &method, &outcome)
            .await;
    }
    drop(_dialog_decision_guard);

    match outcome {
        Ok(v) if method == Method::ToolDownload => {
            let id = download_transfer_id.expect("download transfer allocated");
            let mut result: DownloadResult = match serde_json::from_value(v) {
                Ok(v) => v,
                Err(err) => {
                    release_transfer_async(state, id).await;
                    return ResponseBody::Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: format!("invalid tool.download result: {err}"),
                        data: None,
                    });
                }
            };
            let Some(path) = result.browser_path.take() else {
                release_transfer_async(state, id).await;
                return ResponseBody::Err(RpcError {
                    code: ErrorCode::ProtocolError,
                    message: "tool.download returned no browser_path".into(),
                    data: None,
                });
            };
            let transfers = Arc::clone(&state.transfers);
            let id_for_import = id.clone();
            let import_res = tokio::task::spawn_blocking(move || {
                transfers.import_download(&id_for_import, std::path::Path::new(&path))
            })
            .await;
            match import_res {
                Ok(Ok(size)) => {
                    result.byte_size = size;
                    result.transfer_id = Some(id);
                    ResponseBody::Ok(serde_json::to_value(result).unwrap_or(Value::Null))
                }
                Ok(Err(err)) => {
                    release_transfer_async(state, id).await;
                    ResponseBody::Err(err)
                }
                Err(join_err) => {
                    release_transfer_async(state, id).await;
                    ResponseBody::Err(RpcError {
                        code: ErrorCode::ProtocolError,
                        message: format!("download import worker failed: {join_err}"),
                        data: None,
                    })
                }
            }
        }
        Ok(mut v) => {
            if method == Method::ToolVideo
                && let Some(sess) = state.sessions.get(&session_id)
            {
                v["browser"] = Value::String(sess.browser_id.0);
            }
            ResponseBody::Ok(v)
        }
        Err(err) => {
            if let Some(id) = download_transfer_id {
                release_transfer_async(state, id).await;
            }
            let busy = matches!(err, DispatchError::SessionBusy);
            let mut error = err.into_rpc();
            if busy {
                error.data = Some(serde_json::json!({
                    "reason": bsk_protocol::RpcErrorReason::SessionBusy.as_str(),
                    "dispatched": false,
                    "activity": state.tool_queues.activity(&session_id).ok(),
                    "wait": { "action": "wait", "session_id": session_id.0, "wait_ms": 10000 },
                }));
            } else if let Some(tid) = wal_tab_id
                && let Some(obj) = error.data.as_mut().and_then(Value::as_object_mut)
                && obj.contains_key("effect_state")
                && !obj.contains_key("tab_id")
            {
                obj.insert("tab_id".into(), Value::from(tid));
            }
            ResponseBody::Err(error)
        }
    }
}

/// Daemon-local handler for `tool.wait_ms` registered in both [`AbortRegistry`]
/// and [`ToolInflightRegistry`] so peer `cancel`, `session.user_interrupt`, and
/// session teardown all wake it.
#[cfg(test)]
pub(super) async fn handle_wait_ms(
    inflight: &Arc<ToolInflightRegistry>,
    rpc_id: RpcId,
    params: Value,
) -> ResponseBody {
    let abort = Arc::new(AbortRegistry::new());
    handle_wait_ms_with_session(&abort, inflight, rpc_id, None, params).await
}

pub(super) async fn handle_wait_ms_with_session(
    abort_registry: &Arc<AbortRegistry>,
    inflight: &Arc<ToolInflightRegistry>,
    rpc_id: RpcId,
    opt_sid: Option<SessionId>,
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
    let abort_guard = match abort_registry.register(rpc_id.clone()) {
        Ok(guard) => guard,
        Err(err) => {
            return ResponseBody::Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: format!("cannot register wait_ms abort token: {err:?}"),
                data: None,
            });
        }
    };
    let inflight_guard = match inflight.register_optional(rpc_id, opt_sid) {
        Ok(guard) => guard,
        Err(err) => {
            return ResponseBody::Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: format!("cannot register wait_ms cancellation token: {err}"),
                data: None,
            });
        }
    };
    let abort_tok = abort_guard.token().clone();
    let inflight_tok = inflight_guard.entry().cancel_token();
    let result = tokio::select! {
        biased;
        _ = inflight_tok.cancelled() => {
            ResponseBody::Err(inflight_guard.entry().cancel_error("wait_ms cancelled"))
        }
        _ = abort_tok.cancelled() => {
            if inflight_guard.entry().is_cancelled() {
                ResponseBody::Err(inflight_guard.entry().cancel_error("wait_ms cancelled"))
            } else {
                ResponseBody::Err(RpcError {
                    code: ErrorCode::Cancelled,
                    message: "wait_ms cancelled".into(),
                    data: None,
                })
            }
        }
        _ = tokio::time::sleep(Duration::from_millis(params.duration_ms)) => {
            ResponseBody::Ok(
                serde_json::to_value(WaitMsResult { waited_ms: params.duration_ms })
                    .unwrap_or(Value::Null),
            )
        }
    };
    drop(inflight_guard);
    drop(abort_guard);
    result
}

/// Resolve a `cancel { rpc_id }` against `abort_registry` (`session.*` lifecycle
/// and `tool.wait_ms`) and `tool_inflight` (every `tool.*` RPC, forwarding WS
/// `cancel` if promoted).
pub(super) fn handle_cancel(state: &Arc<DaemonState>, params: Value) -> ResponseBody {
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
    if let Some(snap) = state.tool_inflight.cancel(&params.rpc_id) {
        cancelled = true;
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

pub(super) fn tool_dispatch_timeout(params: &Value) -> Result<Duration, RpcError> {
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

pub(super) fn tool_dispatch_transport_timeout(
    method: &Method,
    params: &Value,
) -> Result<Duration, RpcError> {
    if *method == Method::ToolCooperate {
        let parsed: bsk_protocol::tools::CooperateParams =
            serde_json::from_value(params.clone())
                .map_err(|error| invalid_params(error.to_string()))?;
        if parsed.timeout_ms.is_some_and(|ms| ms > 25_000) {
            return Err(invalid_params("cooperation wait is bounded to 25000ms"));
        }
        let timeout = match parsed.action {
            bsk_protocol::tools::CooperateAction::Sync
            | bsk_protocol::tools::CooperateAction::Enable => {
                parsed.timeout_ms.map_or(DEFAULT_TOOL_TIMEOUT, |ms| {
                    DEFAULT_TOOL_TIMEOUT
                        .max(Duration::from_millis(ms).saturating_add(Duration::from_secs(20)))
                })
            }
            _ => DEFAULT_TOOL_TIMEOUT,
        };
        return Ok(timeout);
    }
    let policy = super::tool_policy::execution_policy(method, params);
    if policy.deadline == super::tool_policy::Deadline::BorrowConfirmation {
        let ms = params
            .get("confirmation_timeout_ms")
            .map_or(Some(60_000), Value::as_u64)
            .filter(|ms| (1..=2_147_000_000).contains(ms))
            .ok_or_else(|| {
                invalid_params("confirmation_timeout_ms must be a positive bounded integer")
            })?;
        return Ok(Duration::from_millis(ms).saturating_add(Duration::from_secs(15)));
    }
    let timeout = if policy.deadline == super::tool_policy::Deadline::FullPage
        && params.get("timeout_ms").is_none()
    {
        Ok(Duration::from_secs(120))
    } else {
        tool_dispatch_timeout(params)
    };
    timeout.map(|timeout| {
        if policy.response_grace {
            timeout.saturating_add(EXTENSION_RESPONSE_GRACE)
        } else {
            timeout
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn wait_ms_with_session_id_cancels_on_session_teardown_and_user_interrupt() {
        let abort = Arc::new(AbortRegistry::new());
        let inflight = Arc::new(ToolInflightRegistry::new());
        let sid = SessionId("sess-w".into());

        // 1. Session user interrupt wakes session-scoped wait_ms with UserAborted
        let abort1 = Arc::clone(&abort);
        let reg1 = Arc::clone(&inflight);
        let sid1 = sid.clone();
        let t1 = tokio::spawn(async move {
            handle_wait_ms_with_session(
                &abort1,
                &reg1,
                "w-int".into(),
                Some(sid1),
                serde_json::json!({"duration_ms": 10_000}),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(15)).await;
        assert_eq!(inflight.cancel_session(&sid).len(), 1);
        match t1.await.unwrap() {
            ResponseBody::Err(err) => assert_eq!(err.code, ErrorCode::UserAborted),
            other => panic!("expected UserAborted, got {other:?}"),
        }
        assert!(abort.is_empty(), "abort guard must auto-clean on interrupt");

        // 2. Session teardown wakes session-scoped wait_ms with NotFound + reason
        let abort2 = Arc::clone(&abort);
        let reg2 = Arc::clone(&inflight);
        let sid2 = sid.clone();
        let t2 = tokio::spawn(async move {
            handle_wait_ms_with_session(
                &abort2,
                &reg2,
                "w-end".into(),
                Some(sid2),
                serde_json::json!({"duration_ms": 10_000}),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(15)).await;
        assert_eq!(
            inflight
                .cancel_session_filtered(
                    &sid,
                    crate::daemon::inflight::CancelReason::SessionEnded("session_window_closed"),
                    true,
                )
                .len(),
            1
        );
        match t2.await.unwrap() {
            ResponseBody::Err(err) => {
                assert_eq!(err.code, ErrorCode::NotFound);
                assert_eq!(err.data.unwrap()["reason"], "session_window_closed");
            }
            other => panic!("expected NotFound(session_window_closed), got {other:?}"),
        }
        assert!(abort.is_empty(), "abort guard must auto-clean on teardown");
    }
}
