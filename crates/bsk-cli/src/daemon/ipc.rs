//! JSON-line IPC server router and handler types for CLI ↔ daemon RPCs.
//!
//! Transport accept/connection loops live in [`super::ipc_transport`],
//! control-plane/session/transfer handlers live in [`super::ipc_sessions`],
//! and the unified `tool.*` execution pipeline lives in [`super::tool_pipeline`].

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;

use bsk_protocol::system::{
    BrowserStatusEntry, SessionStatusEntry, StatusResult, VersionSkewEntry,
};
use bsk_protocol::{ErrorCode, Method, PingResult, ResponseBody, RpcError, RpcId};
use serde_json::Value;

use crate::ipc_client::{IpcRequestMeta, IpcResponseMeta};

pub(super) use super::ipc_sessions::{RecordSessionStop, handle_session_start_scoped};
use super::ipc_sessions::{
    handle_browser_list, handle_ledger_request, handle_session_list, handle_session_run_log,
    handle_session_stop, handle_session_stop_all_rpc, handle_status, handle_transfer_begin,
    handle_transfer_chunk, handle_transfer_finish, handle_transfer_read, handle_transfer_release,
};
pub use super::ipc_transport::{IpcHandle, IpcServer, bind, serve};
use super::sessions::SessionId;
use super::state::DaemonState;
pub use super::tool_pipeline::MAX_WAIT_MS;
use super::tool_pipeline::{execute_tool_rpc, handle_cancel};

/// Handler type: async fn(rpc_id, method, params) -> ResponseBody.
pub type RpcHandler = Arc<
    dyn Fn(RpcId, Method, Value) -> Pin<Box<dyn Future<Output = ResponseBody> + Send>>
        + Send
        + Sync
        + 'static,
>;

/// Envelope-aware IPC handler carrying out-of-band [`IpcRequestMeta`] and
/// [`IpcResponseMeta`] so caller scope and cached observation metadata never
/// pollute business `params` / `result` JSON objects.
pub type EnvelopeRpcHandler = Arc<
    dyn Fn(
            RpcId,
            Method,
            Value,
            IpcRequestMeta,
        ) -> Pin<Box<dyn Future<Output = (ResponseBody, IpcResponseMeta)> + Send>>
        + Send
        + Sync
        + 'static,
>;

/// Adapter allowing `ipc::serve` to accept either a plain [`RpcHandler`] (used
/// by minimal ping/system tests) or the production [`EnvelopeRpcHandler`].
pub trait IntoEnvelopeHandler {
    fn into_envelope_handler(self) -> EnvelopeRpcHandler;
}

impl IntoEnvelopeHandler for EnvelopeRpcHandler {
    fn into_envelope_handler(self) -> EnvelopeRpcHandler {
        self
    }
}

#[derive(Default)]
struct RpcHandlerEnvelopeBridge {
    req_meta: Option<IpcRequestMeta>,
    resp_meta: IpcResponseMeta,
}

tokio::task_local! {
    static RPC_HANDLER_ENVELOPE_BRIDGE: std::sync::Mutex<RpcHandlerEnvelopeBridge>;
}

impl IntoEnvelopeHandler for RpcHandler {
    fn into_envelope_handler(self) -> EnvelopeRpcHandler {
        Arc::new(move |rpc_id, method, params, meta| {
            let handler = Arc::clone(&self);
            Box::pin(async move {
                let bridge = std::sync::Mutex::new(RpcHandlerEnvelopeBridge {
                    req_meta: Some(meta),
                    resp_meta: IpcResponseMeta::default(),
                });
                RPC_HANDLER_ENVELOPE_BRIDGE
                    .scope(bridge, async move {
                        let body = (handler)(rpc_id, method, params).await;
                        let resp_meta = RPC_HANDLER_ENVELOPE_BRIDGE
                            .try_with(|slot| {
                                std::mem::take(
                                    &mut slot.lock().unwrap_or_else(|p| p.into_inner()).resp_meta,
                                )
                            })
                            .unwrap_or_default();
                        (body, resp_meta)
                    })
                    .await
            })
        })
    }
}

/// Snapshot of daemon-side bookkeeping needed to answer `system.status`.
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
            local_auth: None,
            daemon_version: self.daemon_version.to_string(),
            protocol_version: self.protocol_version.to_string(),
            pid: std::process::id(),
            uptime_secs: self.started_at.elapsed().as_secs(),
            ws_port: self.ws_port,
            sock_path: self.sock_path.to_string_lossy().into_owned(),
            browsers: Vec::new(),
            sessions: Vec::new(),
            version_skew_browsers: Vec::new(),
            ipc_envelope: true,
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
            local_auth: state.local_auth_status(),
            daemon_version: self.daemon_version.to_string(),
            protocol_version: self.protocol_version.to_string(),
            pid: std::process::id(),
            uptime_secs: self.started_at.elapsed().as_secs(),
            ws_port: self.ws_port,
            sock_path: self.sock_path.to_string_lossy().into_owned(),
            browsers,
            sessions,
            version_skew_browsers,
            ipc_envelope: true,
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

/// Build a system-only handler bound to a daemon status snapshot.
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

/// Build a plain [`RpcHandler`] wrapper around [`full_envelope_handler`].
pub fn full_handler(status: DaemonStatus, state: Arc<DaemonState>) -> RpcHandler {
    let envelope_handler = full_envelope_handler(status, state);
    Arc::new(move |rpc_id, method, params| {
        let envelope_handler = Arc::clone(&envelope_handler);
        Box::pin(async move {
            let req_meta = RPC_HANDLER_ENVELOPE_BRIDGE
                .try_with(|slot| {
                    slot.lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .req_meta
                        .take()
                })
                .ok()
                .flatten()
                .unwrap_or_default();
            let (body, resp_meta) = (envelope_handler)(rpc_id, method, params, req_meta).await;
            let _ = RPC_HANDLER_ENVELOPE_BRIDGE.try_with(|slot| {
                slot.lock().unwrap_or_else(|p| p.into_inner()).resp_meta = resp_meta;
            });
            body
        })
    })
}

/// Build the production envelope handler.
pub fn full_envelope_handler(status: DaemonStatus, state: Arc<DaemonState>) -> EnvelopeRpcHandler {
    Arc::new(move |rpc_id, method, mut params, req_meta| {
        let status = status.clone();
        let state = Arc::clone(&state);
        Box::pin(async move {
            let (req_meta, legacy_inband_scope_meta) =
                IpcRequestMeta::extract_legacy_from_params(&mut params, req_meta);
            let method_for_post = method.clone();
            let (mut body, mut resp_meta) =
                dispatch_envelope_rpc(&status, state, rpc_id, method, params, req_meta).await;
            if legacy_inband_scope_meta {
                attach_legacy_inband_scope_meta(&method_for_post, &mut body, &mut resp_meta);
            }
            (body, resp_meta)
        })
    })
}

fn attach_legacy_inband_scope_meta(
    method: &Method,
    body: &mut ResponseBody,
    resp_meta: &mut IpcResponseMeta,
) {
    let (ResponseBody::Ok(value), Some(mut scope_meta)) = (body, resp_meta.scope_meta.take())
    else {
        return;
    };
    let coop_val = if *method == Method::ToolOperationAwait {
        value.get("result")
    } else {
        Some(&*value)
    };
    let is_slim_non_unchanged = coop_val.is_some_and(|cv| {
        let has_obs_text = cv
            .pointer("/observation/text")
            .and_then(Value::as_str)
            .is_some();
        let is_unchanged = cv.get("kind").and_then(Value::as_str) == Some("unchanged");
        !has_obs_text && !is_unchanged
    });
    if is_slim_non_unchanged {
        scope_meta.cache_reusable = false;
        scope_meta.cached_vom = None;
        scope_meta.cached_vom_truncated = false;
        scope_meta.cached_vom_next_cursor = None;
    }
    if let Some(obj) = value.as_object_mut()
        && let Ok(serialized) = serde_json::to_value(scope_meta)
    {
        obj.insert(crate::ipc_client::LEGACY_SCOPE_META_KEY.into(), serialized);
    }
}

async fn dispatch_envelope_rpc(
    status: &DaemonStatus,
    state: Arc<DaemonState>,
    rpc_id: RpcId,
    method: Method,
    mut params: Value,
    req_meta: IpcRequestMeta,
) -> (ResponseBody, IpcResponseMeta) {
    if let Err(err) = super::tool_pipeline::prepare_implicit_session_and_evidence(
        &state,
        &method,
        &mut params,
        &req_meta,
    ) {
        return (ResponseBody::Err(err), IpcResponseMeta::default());
    }
    // Daemon-side `tool.*` RPCs (`tool.session_start` / `tool.session_stop` are
    // extension-bound WS methods, not daemon IPC RPCs, so `UnknownMethod` stays
    // authoritative for them).
    if method.is_tool() && !matches!(method, Method::ToolSessionStart | Method::ToolSessionStop) {
        return execute_tool_rpc(state, rpc_id, method, params, &req_meta).await;
    }

    let body = match method {
        Method::LocalAuthPair
        | Method::LocalAuthDevices
        | Method::LocalAuthRevoke
        | Method::LocalAuthRotate
        | Method::LocalAuthSetMode => {
            super::local_auth::maintenance::handle(state.clone(), status.ws_port, method, params)
                .await
        }
        Method::SystemPing => {
            let result = PingResult { pong: true };
            ResponseBody::Ok(serde_json::to_value(result).unwrap_or(Value::Null))
        }
        Method::SessionRunLog => handle_session_run_log(&state, params),
        Method::SystemStatus => match handle_status(status, &state, params).await {
            Ok(v) => ResponseBody::Ok(v),
            Err(e) => ResponseBody::Err(e),
        },
        Method::SessionStartTracked => {
            let tracked_incognito = params
                .get("incognito")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let body = super::session_requests::start(&state, rpc_id, params, &req_meta).await;
            if req_meta.bind_scope
                && let Some(scope) = req_meta.caller_scope.as_deref()
                && let ResponseBody::Ok(ref value) = body
                && let Some(sid_str) = value.get("session_id").and_then(Value::as_str)
            {
                let sid = SessionId(sid_str.to_owned());
                if let Some(session) = state.sessions.get(&sid) {
                    state
                        .scopes
                        .bind_scope(scope, sid, session.browser_id, tracked_incognito);
                }
            }
            body
        }
        Method::SessionRequest => super::session_requests::operate(&state, params).await,
        Method::SessionStart => {
            match handle_session_start_scoped(&state, rpc_id, params, false, &req_meta).await {
                Ok(v) => ResponseBody::Ok(v),
                Err(e) => ResponseBody::Err(e),
            }
        }
        Method::SessionStop => match handle_session_stop(&state, rpc_id, params, &req_meta).await {
            Ok(v) => ResponseBody::Ok(v),
            Err(e) => ResponseBody::Err(e),
        },
        Method::SessionStopAll => match handle_session_stop_all_rpc(&state, rpc_id, params).await {
            Ok(v) => ResponseBody::Ok(v),
            Err(e) => ResponseBody::Err(e),
        },
        Method::SessionList => handle_session_list(&state, params),
        Method::LedgerRequest => handle_ledger_request(&state, params, &req_meta).await,
        Method::BrowserList => match handle_browser_list(&state, params).await {
            Ok(v) => ResponseBody::Ok(v),
            Err(e) => ResponseBody::Err(e),
        },
        Method::TransferBegin => handle_transfer_begin(&state, params).await,
        Method::TransferChunk => handle_transfer_chunk(&state, params).await,
        Method::TransferFinish => handle_transfer_finish(&state, params).await,
        Method::TransferRead => handle_transfer_read(&state, params).await,
        Method::TransferRelease => handle_transfer_release(&state, params).await,
        Method::Cancel => handle_cancel(&state, params),
        other => ResponseBody::Err(RpcError {
            code: ErrorCode::UnknownMethod,
            message: format!("method not implemented yet: {other:?}"),
            data: None,
        }),
    };
    (body, IpcResponseMeta::default())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::daemon::DaemonConfig;
    use crate::daemon::inflight::ToolInflightRegistry;
    use crate::daemon::ipc_sessions::{DEFAULT_RPC_TIMEOUT, DEFAULT_SESSION_STOP_TIMEOUT};
    use crate::daemon::queue::DEFAULT_TOOL_TIMEOUT;
    use crate::daemon::tool_pipeline::{
        EXTENSION_RESPONSE_GRACE, handle_wait_ms, tool_dispatch_timeout,
        tool_dispatch_transport_timeout,
    };
    use bsk_protocol::{Frame, Method, RequestFrame};
    use std::time::Duration;
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
            Method::ToolNavigate,
            Method::ToolNavigateBack,
            Method::ToolNavigateForward,
            Method::ToolReload,
            Method::ToolWaitForNavigation,
        ] {
            let dispatch_timeout = tool_dispatch_transport_timeout(&method, &params).unwrap();
            assert_eq!(dispatch_timeout, Duration::from_secs(62));
        }
    }

    #[test]
    fn default_navigation_deadline_allows_extension_timeout_response() {
        for method in [
            Method::ToolNavigate,
            Method::ToolNavigateBack,
            Method::ToolNavigateForward,
            Method::ToolReload,
            Method::ToolWaitForNavigation,
        ] {
            assert_eq!(
                tool_dispatch_transport_timeout(&method, &serde_json::json!({})).unwrap(),
                DEFAULT_TOOL_TIMEOUT + EXTENSION_RESPONSE_GRACE,
            );
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

    #[test]
    fn cooperation_wait_deadline_leaves_time_for_the_renderer_reply() {
        for wait_ms in [0, 900, 25_000] {
            let params =
                serde_json::json!({"session_id":"s1", "action":"wait", "timeout_ms":wait_ms});
            assert!(
                tool_dispatch_transport_timeout(&Method::ToolCooperate, &params).unwrap()
                    > Duration::from_millis(wait_ms)
            );
        }
        assert!(
            tool_dispatch_transport_timeout(
                &Method::ToolCooperate,
                &serde_json::json!({"session_id":"s1", "action":"wait", "timeout_ms":25_001})
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn wait_ms_zero_short_circuits_without_registering() {
        let registry = Arc::new(ToolInflightRegistry::new());
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
        let registry = Arc::new(ToolInflightRegistry::new());
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
        let registry = Arc::new(ToolInflightRegistry::new());
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
        let registry = Arc::new(ToolInflightRegistry::new());
        let reg_for_cancel = Arc::clone(&registry);
        let task = tokio::spawn(async move {
            handle_wait_ms(
                &registry,
                "rpc-cancel".into(),
                serde_json::json!({"duration_ms": 5_000}),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(reg_for_cancel.len(), 1);
        assert!(reg_for_cancel.cancel(&"rpc-cancel".to_string()).is_some());
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
        let state = Arc::new(DaemonState::new(DaemonConfig::new(0)));
        let body = handle_cancel(&state, serde_json::json!({"rpc_id": "ghost"}));
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
            audit_id: None,
            operation_id: None,
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
            audit_id: None,
            operation_id: None,
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

/// Platform-neutral coverage for the `session.start` selector-miss payload.
#[cfg(test)]
mod selector_miss_payload_tests {
    use super::*;
    use crate::daemon::browsers::{
        BrowserClient, BrowserId, BrowserRegistry, BrowserSink, Liveness, Pending,
        next_browser_generation,
    };
    use crate::daemon::ipc_sessions::map_start_error;
    use crate::daemon::queue::ToolQueueRegistry;
    use crate::daemon::sessions::{
        AgentWindowOptions, SessionRegistry, StartSessionError, start_session_recoverable,
    };
    use std::sync::Mutex;
    use std::time::Duration;

    fn status_entry(instance_id: &str, label: &str) -> BrowserStatusEntry {
        BrowserStatusEntry {
            instance_id: instance_id.into(),
            browser_name: "chrome".into(),
            browser_version: "131".into(),
            extension_version: "0.1.0-dev.0".into(),
            label: label.into(),
            session_count: 0,
            connected_at_ms: 1,
            version_skew: false,
            extension_protocol_version: String::new(),
            unresponsive: false,
        }
    }

    #[test]
    fn browser_selector_miss_lists_connected_candidates() {
        let err = map_start_error(StartSessionError::BrowserNotFound {
            browsers: vec![status_entry("alpha", "Personal"), status_entry("beta", "")],
        });
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(err.message, "requested browser is not connected");
        let data = err.data.expect("selector miss must carry candidates");
        let browsers = data["browsers"].as_array().expect("browsers array");
        assert_eq!(browsers.len(), 2);
        assert_eq!(browsers[0]["instance_id"], "alpha");
        assert_eq!(browsers[0]["label"], "Personal");
        assert_eq!(browsers[1]["instance_id"], "beta");
    }

    #[test]
    fn browser_selector_miss_without_browsers_keeps_message_only_payload() {
        let err = map_start_error(StartSessionError::BrowserNotFound { browsers: vec![] });
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(err.message, "requested browser is not connected");
        assert!(
            err.data.is_none(),
            "an empty registry must not invent a `browsers` payload"
        );
    }

    fn connected_browser(instance_id: &str, label: &str) -> Arc<BrowserClient> {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        Arc::new(BrowserClient {
            id: BrowserId(instance_id.into()),
            browser_name: "chrome".into(),
            browser_version: "131".into(),
            extension_version: "0.1.0-dev.0".into(),
            extension_protocol_version: "2.0".into(),
            label: label.into(),
            sink: BrowserSink { tx },
            pending: Mutex::new(Pending::default()),
            generation: next_browser_generation(),
            connected_at_ms: 0,
            version_skew: false,
            liveness: Liveness::default(),
        })
    }

    #[tokio::test]
    async fn selector_miss_reaches_caller_and_creates_no_session() {
        let registry = Arc::new(BrowserRegistry::new());
        registry.insert(connected_browser("alpha", "Personal"));
        registry.insert(connected_browser("beta", ""));
        let sessions = Arc::new(SessionRegistry::new());
        let queues = Arc::new(ToolQueueRegistry::new(registry.clone(), sessions.clone()));

        assert!(sessions.is_empty(), "fixture must start with no sessions");

        let error = start_session_recoverable(
            &registry,
            &sessions,
            &queues,
            Some("no-such-browser"),
            AgentWindowOptions::default(),
            Duration::from_secs(1),
            Duration::from_secs(1),
            None,
            false,
        )
        .await
        .expect_err("a selector that matches nothing must not start a session");

        assert!(
            sessions.is_empty(),
            "a selector miss must not leave a session behind"
        );

        let rpc = map_start_error(error);
        assert_eq!(rpc.code, ErrorCode::NotFound);
        let data = rpc
            .data
            .expect("a miss with browsers online must carry candidates");
        let browsers = data["browsers"].as_array().expect("browsers array");
        let seen: Vec<(&str, &str)> = browsers
            .iter()
            .map(|b| {
                (
                    b["instance_id"].as_str().expect("instance_id"),
                    b["label"].as_str().expect("label"),
                )
            })
            .collect();
        assert_eq!(
            seen.len(),
            2,
            "both connected browsers must be listed, got {seen:?}"
        );
        assert!(seen.contains(&("alpha", "Personal")), "got {seen:?}");
        assert!(seen.contains(&("beta", "")), "got {seen:?}");
    }
}
