//! WebSocket server: accepts extension clients, validates Origin, runs the
//! handshake exchange, and forwards tool responses back through the
//! per-browser `BrowserSink`.
//!
//! **Boundary note** (M2 will replace/absorb): this implementation does
//! not own any lockfile / port-conflict / idle-shutdown logic. It exists
//! solely to give the M4/M5 extension code something concrete to talk to.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, anyhow};
use bsk_protocol::system::{
    HandshakeCompat, HandshakeParams, HandshakeResult, evaluate_handshake_compat,
};
use bsk_protocol::tools::ReturnFailure;
use bsk_protocol::{Frame, RequestFrame, ResponseBody, ResponseFrame, RpcError};
use futures_util::{SinkExt, StreamExt};
use semver::Version;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Message};
use tracing::{debug, info, warn};

use super::browsers::{BrowserClient, BrowserId, BrowserSink, Pending};
use super::state::{
    DaemonState, LEGACY_MIN_COMPATIBLE_PEER, MIN_COMPATIBLE_PROTOCOL, PROTOCOL_VERSION, SERVER_NAME,
};

/// Result of the optional Origin allow-list check.
///
/// TODO(M10/M12): pair v0.1 GA with an actual extension-id allow-list
/// (`DaemonConfig::allowed_extension_ids: HashSet<String>`) populated
/// from a config file / pairing flow, rather than accepting any
/// extension-shaped origin. Review M4/M5 I8 — acceptable defense-in-
/// depth gap for now because pairing happens through the popup, but
/// a side-loaded extension on the same machine currently passes the
/// gate.
fn origin_allowed(origin: &str, allow_any: bool) -> bool {
    if allow_any {
        return true;
    }
    // MV3 extension ids are 32 a–p characters per Chrome spec.
    let prefix = "chrome-extension://";
    if let Some(rest) = origin.strip_prefix(prefix) {
        if rest.len() == 32 && rest.bytes().all(|b| (b'a'..=b'p').contains(&b)) {
            return true;
        }
    }
    false
}

pub struct WsServer {
    state: Arc<DaemonState>,
}

impl WsServer {
    pub fn new(state: Arc<DaemonState>) -> Self {
        Self { state }
    }

    pub async fn bind(self, addr: SocketAddr) -> anyhow::Result<WsHandle> {
        let listener = TcpListener::bind(addr)
            .await
            .with_context(|| format!("bind WS server on {addr}"))?;
        let local_addr = listener
            .local_addr()
            .with_context(|| "failed to read WS server local addr")?;
        let shutdown = Arc::new(Notify::new());
        let task = tokio::spawn(run_accept_loop(self.state, listener, Arc::clone(&shutdown)));
        Ok(WsHandle {
            local_addr,
            shutdown,
            task,
        })
    }
}

pub struct WsHandle {
    pub local_addr: SocketAddr,
    pub shutdown: Arc<Notify>,
    pub task: JoinHandle<()>,
}

async fn run_accept_loop(state: Arc<DaemonState>, listener: TcpListener, shutdown: Arc<Notify>) {
    info!(addr = %listener.local_addr().unwrap(), "ws server listening");
    loop {
        tokio::select! {
            _ = shutdown.notified() => {
                debug!("ws server shutdown signal received");
                break;
            }
            accept = listener.accept() => {
                match accept {
                    Ok((stream, peer)) => {
                        let state = Arc::clone(&state);
                        tokio::spawn(async move {
                            if let Err(err) = handle_connection(state, stream, peer).await {
                                warn!(error = %err, "ws connection error");
                            }
                        });
                    }
                    Err(err) => {
                        warn!(error = %err, "accept failed");
                    }
                }
            }
        }
    }
}

async fn handle_connection(
    state: Arc<DaemonState>,
    stream: TcpStream,
    peer: SocketAddr,
) -> anyhow::Result<()> {
    let allow_any = state.config.allow_any_origin;
    let captured_origin: std::sync::Arc<std::sync::Mutex<Option<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let captured_origin_for_cb = std::sync::Arc::clone(&captured_origin);
    let callback = move |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let origin = req
            .headers()
            .get("Origin")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if !origin_allowed(&origin, allow_any) {
            warn!(?origin, "rejecting WS upgrade with disallowed origin");
            let mut err = ErrorResponse::new(Some(
                "Origin not in chrome-extension allow-list".to_string(),
            ));
            *err.status_mut() = StatusCode::FORBIDDEN;
            return Err(err);
        }
        *captured_origin_for_cb.lock().unwrap() = Some(origin);
        let mut resp = response;
        resp.headers_mut().append(
            "x-bsk-server",
            HeaderValue::from_static("browser-skill-daemon"),
        );
        Ok(resp)
    };

    let ws = match tokio_tungstenite::accept_hdr_async(stream, callback).await {
        Ok(ws) => ws,
        Err(err) => {
            debug!(?peer, %err, "ws handshake rejected");
            return Ok(());
        }
    };

    let origin = captured_origin.lock().unwrap().clone().unwrap_or_default();
    debug!(?peer, %origin, "ws connection upgraded");
    drive_connection(state, ws).await
}

/// Hard cap on how long the daemon will wait for a freshly-upgraded
/// WebSocket client to send its first frame (which MUST be
/// `system.handshake` per §4.2). Without this, a passing-Origin client
/// that completes the WS upgrade but never speaks pins a tokio task +
/// socket FD indefinitely (review M4/M5 round 3 I-R3-1).
const HANDSHAKE_FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);

async fn drive_connection(
    state: Arc<DaemonState>,
    ws: WebSocketStream<TcpStream>,
) -> anyhow::Result<()> {
    let (mut writer, mut reader) = ws.split();

    // The first frame MUST be `system.handshake` per §4.2. Bound the
    // wait so a stalled client cannot park resources forever.
    let first = match tokio::time::timeout(HANDSHAKE_FIRST_FRAME_TIMEOUT, reader.next()).await {
        Ok(Some(Ok(msg))) => msg,
        Ok(Some(Err(err))) => return Err(err.into()),
        Ok(None) => return Ok(()),
        Err(_) => {
            warn!(
                timeout_secs = HANDSHAKE_FIRST_FRAME_TIMEOUT.as_secs(),
                "client did not send handshake in time; dropping connection"
            );
            let _ = writer
                .send(Message::Close(Some(CloseFrame {
                    code:
                        tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy,
                    reason: "handshake timeout".into(),
                })))
                .await;
            return Err(anyhow!("handshake first-frame timeout"));
        }
    };
    let first_text = match first {
        Message::Text(t) => t,
        Message::Close(_) => return Ok(()),
        other => {
            let _ = writer
                .send(Message::Close(Some(CloseFrame {
                    code:
                        tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy,
                    reason: "expected text frame".into(),
                })))
                .await;
            return Err(anyhow!("expected text frame, got {other:?}"));
        }
    };

    let request: RequestFrame = serde_json::from_str(&first_text)
        .map_err(|err| anyhow!("invalid handshake JSON: {err}"))?;
    if !matches!(request.method, bsk_protocol::Method::SystemHandshake) {
        let resp = ResponseFrame {
            id: request.id.clone(),
            body: ResponseBody::Err(RpcError {
                code: bsk_protocol::ErrorCode::ProtocolError,
                message: "first frame must be system.handshake".into(),
                data: None,
            }),
        };
        let _ = writer
            .send(Message::Text(serde_json::to_string(&resp)?))
            .await;
        return Err(anyhow!("kicked: non-handshake first frame"));
    }
    let params_raw = request
        .params
        .clone()
        .ok_or_else(|| anyhow!("handshake missing params"))?;
    let params: HandshakeParams = serde_json::from_value(params_raw)
        .map_err(|err| anyhow!("invalid HandshakeParams: {err}"))?;

    // Version compatibility (design §10, M10.4): protocol_version only.
    let our_app_version: Version = env!("CARGO_PKG_VERSION")
        .parse()
        .expect("CARGO_PKG_VERSION must be a valid semver");
    let legacy_min_peer: Version = LEGACY_MIN_COMPATIBLE_PEER
        .parse()
        .expect("LEGACY_MIN_COMPATIBLE_PEER must be a valid semver");
    let compat = evaluate_handshake_compat(
        &params.protocol_version,
        params.min_compatible_protocol.as_deref(),
        PROTOCOL_VERSION,
        MIN_COMPATIBLE_PROTOCOL,
    );
    let version_skew = match compat {
        HandshakeCompat::Reject { reason } => {
            let resp = ResponseFrame {
                id: request.id.clone(),
                body: ResponseBody::Err(RpcError {
                    code: bsk_protocol::ErrorCode::VersionTooOld,
                    message: reason.clone(),
                    data: Some(serde_json::json!({
                        "peer_protocol_version": params.protocol_version,
                        "peer_version": params.version.to_string(),
                        "daemon_protocol_version": PROTOCOL_VERSION,
                        "daemon_version": our_app_version.to_string(),
                        "min_compatible_protocol": MIN_COMPATIBLE_PROTOCOL,
                    })),
                }),
            };
            let _ = writer
                .send(Message::Text(serde_json::to_string(&resp)?))
                .await;
            return Err(anyhow!("kicked: {reason}"));
        }
        HandshakeCompat::Skew => {
            warn!(
                peer = %params.instance_id,
                peer_protocol = %params.protocol_version,
                daemon_protocol = PROTOCOL_VERSION,
                "browser protocol minor drift; flagging version_skew"
            );
            true
        }
        HandshakeCompat::Ok => false,
    };

    // Register browser & build outbound sink. Each registration gets a
    // fresh `generation` so a reconnect under the same `instance_id`
    // can be told apart from the previous BrowserClient — the old
    // socket's cleanup path uses `remove_if_generation_matches` to
    // avoid clobbering the newer entry (review M4/M5 round 2 #1).
    let browser_id = BrowserId(params.instance_id.clone());
    let (tx, mut rx) = mpsc::unbounded_channel::<Frame>();
    let generation = super::browsers::next_browser_generation();
    let connected_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let client = Arc::new(BrowserClient {
        id: browser_id.clone(),
        browser_name: params.browser.name.clone(),
        browser_version: params.browser.version.clone(),
        extension_version: params.version.to_string(),
        extension_protocol_version: params.protocol_version.clone(),
        label: params.label.clone(),
        sink: BrowserSink { tx },
        pending: std::sync::Mutex::new(Pending::default()),
        generation,
        connected_at_ms,
        version_skew,
    });
    state.browsers.insert(Arc::clone(&client));
    info!(
        id = %browser_id,
        name = %params.browser.name,
        generation,
        "browser connected"
    );

    // Reply to handshake.
    let result = HandshakeResult {
        server: SERVER_NAME.to_string(),
        // These are compile-time constants; a parse failure is a
        // packaging bug and must be loud (review M4/M5 round 3
        // m-R3-3).
        version: env!("CARGO_PKG_VERSION")
            .parse()
            .expect("CARGO_PKG_VERSION must be a valid semver"),
        protocol_version: PROTOCOL_VERSION.to_string(),
        min_compatible_peer: Some(legacy_min_peer),
        min_compatible_protocol: Some(MIN_COMPATIBLE_PROTOCOL.to_string()),
    };
    let resp = ResponseFrame {
        id: request.id.clone(),
        body: ResponseBody::Ok(serde_json::to_value(&result).unwrap()),
    };
    writer
        .send(Message::Text(serde_json::to_string(&resp)?))
        .await?;

    // Pump loop: outbound frames from sink → ws; inbound from ws → resolve.
    let pump_state = Arc::clone(&state);
    let pump_browser = Arc::clone(&client);
    let result_outcome: anyhow::Result<()> = async {
        loop {
            tokio::select! {
                outbound = rx.recv() => {
                    match outbound {
                        Some(frame) => {
                            let json = serde_json::to_string(&frame)?;
                            writer.send(Message::Text(json)).await?;
                        }
                        None => break,
                    }
                }
                msg = reader.next() => {
                    match msg {
                        Some(Ok(Message::Text(t))) => {
                            handle_inbound_text(&pump_state, &pump_browser, &t).await;
                        }
                        Some(Ok(Message::Binary(_))) => {
                            warn!("ignoring binary message");
                        }
                        Some(Ok(Message::Ping(p))) => {
                            let _ = writer.send(Message::Pong(p)).await;
                        }
                        Some(Ok(Message::Pong(_))) => {}
                        Some(Ok(Message::Frame(_))) => {}
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Err(err)) => {
                            warn!(%err, "ws read error");
                            break;
                        }
                    }
                }
            }
        }
        Ok(())
    }
    .await;

    // Cleanup: drop browser + purge its sessions, but only if the
    // registry still holds *this* generation. If a reconnect already
    // took over under the same `instance_id` we leave the new entry
    // and its (possibly fresh) sessions alone.
    if state
        .browsers
        .remove_if_generation_matches(&browser_id, generation)
        .is_some()
    {
        info!(id = %browser_id, generation, "browser disconnected");
        for s in state.sessions.purge_browser(&browser_id) {
            state.tool_queues.remove(&s.id);
            state.session_interrupts.drop_session(&s.id);
            debug!(session = %s.id, "purged session on browser disconnect");
        }
    } else {
        info!(
            id = %browser_id,
            generation,
            "browser disconnected; newer reconnect already owns this id, leaving sessions intact"
        );
    }
    result_outcome
}

async fn handle_inbound_text(state: &Arc<DaemonState>, client: &Arc<BrowserClient>, text: &str) {
    let frame: Frame = match serde_json::from_str(text) {
        Ok(f) => f,
        Err(err) => {
            warn!(%err, "invalid inbound frame");
            return;
        }
    };
    match frame {
        Frame::Response(resp) => {
            let mut pending = client.pending.lock().unwrap();
            if !pending.resolve(resp.clone()) {
                debug!(id = %resp.id, "response for unknown rpc id (ignored)");
            }
        }
        Frame::Event(ev) => match ev.event {
            bsk_protocol::EventKind::SessionWindowClosed => {
                handle_session_window_closed(state, &client.id, &ev.payload);
            }
            bsk_protocol::EventKind::SessionUserInterrupt => {
                handle_session_user_interrupt(state, &client.id, &ev.payload);
            }
            other => {
                debug!(event = ?other, "event received (no handler yet)");
            }
        },
        Frame::Request(req) => {
            // M5 onwards: support extension-originated requests if needed.
            debug!(method = ?req.method, "extension request not yet handled");
        }
    }
}

fn handle_session_window_closed(
    state: &Arc<DaemonState>,
    sender: &BrowserId,
    payload: &serde_json::Value,
) {
    let Some(session_id) = payload.get("session_id").and_then(|v| v.as_str()) else {
        warn!("session.window_closed event missing session_id");
        return;
    };
    let return_failures: Vec<ReturnFailure> = payload
        .get("return_failures")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .unwrap_or_else(|err| {
            warn!(%err, session = %session_id, "invalid session.window_closed return_failures payload");
            None
        })
        .unwrap_or_default();
    let session_id = super::sessions::SessionId(session_id.to_string());
    // Reject events that target a session owned by a *different* browser.
    // Without this, any connected extension (or any same-machine process
    // that completed the WS handshake) could tear down another browser's
    // session by emitting window_closed with its session_id. A session
    // that is already gone cannot be verified but is harmless to "forget"
    // (forget_session is a no-op), so we only reject when a live owner
    // disagrees.
    if let Some(session) = state.sessions.get(&session_id)
        && session.browser_id != *sender
    {
        warn!(
            session = %session_id,
            sender = %sender,
            owner = %session.browser_id,
            "ignoring session.window_closed from a browser that does not own this session"
        );
        return;
    }
    if super::sessions::forget_session(
        &state.sessions,
        &state.tool_queues,
        &state.session_interrupts,
        &session_id,
    ) {
        info!(session = %session_id, "session removed: user closed Agent Window");
    } else {
        debug!(session = %session_id, "session.window_closed for unknown session id");
    }
    for failure in return_failures {
        warn!(
            session = %session_id,
            tab_id = failure.tab_id,
            code = ?failure.code,
            message = %failure.message,
            "borrowed tab could not be returned before Agent Window closed"
        );
    }
}

fn extract_session_id(payload: &serde_json::Value) -> Option<super::sessions::SessionId> {
    payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| super::sessions::SessionId(s.to_string()))
}

/// Extension-originated request to interrupt every inflight + queued
/// `tool.*` call for a session. Maps to `cancel_session` on the
/// inflight registry, which trips each entry's cancel token AND
/// records `CancelReason::UserAborted` so the worker surfaces
/// `ErrorCode::UserAborted` to the IPC peer. For entries already
/// forwarded over WS we additionally push a per-RPC cancel frame so
/// the extension's dispatcher can abort its `AbortController` —
/// this is the same shape `handle_cancel` uses, just iterated.
fn handle_session_user_interrupt(
    state: &Arc<DaemonState>,
    sender: &BrowserId,
    payload: &serde_json::Value,
) {
    let Some(sid) = extract_session_id(payload) else {
        warn!("session.user_interrupt event missing session_id");
        return;
    };
    // Same ownership guard as window_closed: a browser must not be able
    // to cancel another browser's inflight tools or trip its interrupt
    // marker by sending user_interrupt with a foreign session_id.
    if let Some(session) = state.sessions.get(&sid)
        && session.browser_id != *sender
    {
        warn!(
            session = %sid,
            sender = %sender,
            owner = %session.browser_id,
            "ignoring session.user_interrupt from a browser that does not own this session"
        );
        return;
    }
    let snapshots = state.tool_inflight.cancel_session(&sid);
    info!(session = %sid, count = snapshots.len(), "user-interrupt: cancelled inflight tools");

    for snap in snapshots {
        if let (Some(browser_id), Some(ws_rpc_id)) = (snap.browser_id, snap.ws_rpc_id)
            && let Err(err) =
                super::cancel_forward::forward_cancel_to_browser(state, &browser_id, &ws_rpc_id)
        {
            warn!(
                browser = %browser_id,
                ws_rpc_id = %ws_rpc_id,
                %err,
                "failed to forward user-interrupt cancel to extension"
            );
        }
    }

    state.session_interrupts.mark(&sid);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_allowlist_accepts_valid_extension_id() {
        let id = "a".repeat(32);
        assert!(origin_allowed(&format!("chrome-extension://{id}"), false));
    }

    #[test]
    fn origin_allowlist_rejects_uppercase() {
        let id = "A".repeat(32);
        assert!(!origin_allowed(&format!("chrome-extension://{id}"), false));
    }

    #[test]
    fn origin_allowlist_rejects_unknown_scheme() {
        let id = "a".repeat(32);
        assert!(!origin_allowed(&format!("http://{id}.example"), false));
    }

    #[test]
    fn origin_allowlist_rejects_chars_outside_ap() {
        let id = "z".repeat(32); // 'z' > 'p'
        assert!(!origin_allowed(&format!("chrome-extension://{id}"), false));
    }

    #[test]
    fn origin_allowlist_bypassed_when_allow_any() {
        assert!(origin_allowed("http://localhost", true));
    }
}

#[cfg(test)]
mod session_user_interrupt_tests {
    use super::*;
    use crate::daemon::browsers::BrowserId;
    use crate::daemon::inflight::CancelReason;
    use crate::daemon::sessions::SessionId;

    #[test]
    fn session_user_interrupt_payload_extracts_session_id() {
        let payload = serde_json::json!({ "session_id": "sess-9" });
        let sid = extract_session_id(&payload).expect("session id present");
        assert_eq!(sid.0, "sess-9");
    }

    #[test]
    fn session_user_interrupt_payload_missing_session_id_returns_none() {
        let payload = serde_json::json!({});
        assert!(extract_session_id(&payload).is_none());
    }

    #[test]
    fn session_user_interrupt_payload_empty_session_id_returns_none() {
        assert!(extract_session_id(&serde_json::json!({"session_id": ""})).is_none());
    }

    #[test]
    fn session_user_interrupt_payload_non_string_session_id_returns_none() {
        assert!(extract_session_id(&serde_json::json!({"session_id": 42})).is_none());
    }

    #[test]
    fn handle_session_user_interrupt_cancels_inflight_for_target_session() {
        let state = test_only_daemon_state();
        let sid_a = SessionId("A".into());
        let sid_b = SessionId("B".into());
        let g_a = state
            .tool_inflight
            .register("a".into(), sid_a.clone())
            .unwrap();
        let g_b = state
            .tool_inflight
            .register("b".into(), sid_b.clone())
            .unwrap();

        // No live session is registered, so the ownership guard treats the
        // session as unknown and lets the interrupt through (legacy path).
        handle_session_user_interrupt(
            &state,
            &BrowserId("sender".into()),
            &serde_json::json!({"session_id": "A"}),
        );

        assert_eq!(g_a.entry().cancel_reason(), Some(CancelReason::UserAborted));
        assert!(g_b.entry().cancel_reason().is_none());
    }

    #[test]
    fn handle_session_user_interrupt_marks_pending_for_target_session() {
        let state = test_only_daemon_state();
        let sid_a = SessionId("A".into());
        let sid_b = SessionId("B".into());

        handle_session_user_interrupt(
            &state,
            &BrowserId("sender".into()),
            &serde_json::json!({"session_id": "A"}),
        );

        assert!(
            state.session_interrupts.try_consume(&sid_a),
            "session A must have a pending interrupt set"
        );
        assert!(
            !state.session_interrupts.try_consume(&sid_b),
            "session B must not be marked"
        );
    }

    #[test]
    fn handle_session_user_interrupt_honoured_from_owning_browser() {
        let state = test_only_daemon_state();
        let owner = BrowserId("owner-browser".into());
        let sid = state
            .sessions
            .reserve_id(owner.clone(), 8, || 0)
            .expect("reserved session id");
        let guard = state
            .tool_inflight
            .register("rpc-1".into(), sid.clone())
            .unwrap();

        handle_session_user_interrupt(&state, &owner, &serde_json::json!({"session_id": sid.0}));

        assert_eq!(
            guard.entry().cancel_reason(),
            Some(CancelReason::UserAborted),
            "owning browser may interrupt its own session"
        );
    }

    #[test]
    fn handle_session_user_interrupt_ignored_from_non_owning_browser() {
        let state = test_only_daemon_state();
        let owner = BrowserId("owner-browser".into());
        let attacker = BrowserId("attacker-browser".into());
        let sid = state
            .sessions
            .reserve_id(owner.clone(), 8, || 0)
            .expect("reserved session id");
        let guard = state
            .tool_inflight
            .register("rpc-1".into(), sid.clone())
            .unwrap();

        handle_session_user_interrupt(&state, &attacker, &serde_json::json!({"session_id": sid.0}));

        assert!(
            guard.entry().cancel_reason().is_none(),
            "non-owning browser must not cancel another session's tools"
        );
        assert!(
            !state.session_interrupts.try_consume(&sid),
            "interrupt marker must not be set by a non-owning browser"
        );
    }

    #[test]
    fn handle_session_window_closed_honoured_from_owning_browser() {
        let state = test_only_daemon_state();
        let owner = BrowserId("owner-browser".into());
        let sid = state
            .sessions
            .reserve_id(owner.clone(), 8, || 0)
            .expect("reserved session id");

        handle_session_window_closed(&state, &owner, &serde_json::json!({"session_id": sid.0}));

        assert!(
            state.sessions.get(&sid).is_none(),
            "owning browser may close its own session"
        );
    }

    #[test]
    fn handle_session_window_closed_ignored_from_non_owning_browser() {
        let state = test_only_daemon_state();
        let owner = BrowserId("owner-browser".into());
        let attacker = BrowserId("attacker-browser".into());
        let sid = state
            .sessions
            .reserve_id(owner.clone(), 8, || 0)
            .expect("reserved session id");

        handle_session_window_closed(&state, &attacker, &serde_json::json!({"session_id": sid.0}));

        assert!(
            state.sessions.get(&sid).is_some(),
            "non-owning browser must not be able to tear down another session"
        );
    }

    fn test_only_daemon_state() -> std::sync::Arc<DaemonState> {
        use crate::daemon::start::DaemonConfig;
        std::sync::Arc::new(DaemonState::new(DaemonConfig::new(0)))
    }
}
