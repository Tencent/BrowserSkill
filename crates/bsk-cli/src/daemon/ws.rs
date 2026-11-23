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
    AuditRequestParams, HandshakeCompat, HandshakeResult, evaluate_handshake_compat,
};
use bsk_protocol::{
    AuditContextEvent, EventFrame, Frame, RequestFrame, ResponseBody, ResponseFrame, RpcError,
    RpcId, SessionEndedEvent, SessionUserInterruptEvent, SessionWindowClosedEvent,
};
use futures_util::{SinkExt, StreamExt};
use semver::Version;
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::sync::Notify;
use tokio::sync::Semaphore;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Message};
use tracing::{debug, info, warn};

use super::browsers::{BrowserClient, BrowserId, BrowserSink, Pending};
use super::peer_authorization::PeerAuthorization;
use super::state::{DaemonState, MIN_COMPATIBLE_PROTOCOL, PROTOCOL_VERSION, SERVER_NAME};

/// Origin is a filtering layer; local identity is established by HMAC below.
pub(super) fn origin_allowed(origin: &str) -> bool {
    // MV3 extension ids are 32 a–p characters per Chrome spec.
    let prefix = "chrome-extension://";
    if let Some(rest) = origin.strip_prefix(prefix)
        && rest.len() == 32
        && rest.bytes().all(|b| (b'a'..=b'p').contains(&b))
    {
        return true;
    }
    false
}

/// Explain a failed bind on the default daemon port, which the OS — not bsk —
/// usually owns.
///
/// On Windows, WinNAT/Hyper-V/WSL2 reserve blocks inside the TCP dynamic port
/// range after a reboot, so the default port can already be held when no bsk
/// daemon is running: `TcpListener::bind` then fails with `WSAEACCES` (10013) or
/// `WSAEADDRINUSE` (10048) and the bare OS error gives the user no way forward.
fn bind_error_message(addr: SocketAddr, err: &std::io::Error) -> String {
    let base = format!("bind WS server on {addr}: {err}");
    if addr.port() != super::DEFAULT_WS_PORT {
        return base;
    }

    let mut message = format!(
        "{base}\n{} is the default daemon port and could not be bound",
        super::DEFAULT_WS_PORT
    );
    if matches!(err.raw_os_error(), Some(10013) | Some(10048)) {
        message.push_str(
            ". On Windows, WinNAT, Hyper-V and WSL2 reserve blocks inside the TCP dynamic port \
             range (49152-65535) after a reboot, so the default port can be held even when no bsk \
             daemon is running; check `netsh int ipv4 show excludedportrange protocol=tcp`",
        );
    }
    message.push_str(
        ". Start the daemon on a free port with `bsk daemon start --foreground --port <port>` and \
         point the extension at that port",
    );
    message
}

pub(super) fn bind_ws_listener(addr: SocketAddr) -> std::io::Result<TcpListener> {
    let socket = match addr {
        SocketAddr::V4(_) => TcpSocket::new_v4()?,
        SocketAddr::V6(_) => TcpSocket::new_v6()?,
    };
    #[cfg(unix)]
    socket.set_reuseaddr(true)?;
    socket.set_keepalive(true)?;
    socket.bind(addr)?;
    socket.listen(1024)
}

pub(super) fn configure_tcp_keepalive(stream: &TcpStream) {
    let _ = stream.set_nodelay(true);
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let fd = stream.as_raw_fd();
        let enable: libc::c_int = 1;
        let idle_secs: libc::c_int = 30;
        let interval_secs: libc::c_int = 10;
        let count: libc::c_int = 3;
        // SAFETY: `fd` is a valid socket owned by `stream` for the duration of these
        // `setsockopt` calls, and each pointer/length matches a `libc::c_int`.
        unsafe {
            let _ = libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_KEEPALIVE,
                (&enable as *const libc::c_int).cast(),
                std::mem::size_of_val(&enable) as libc::socklen_t,
            );
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            let _ = libc::setsockopt(
                fd,
                libc::IPPROTO_TCP,
                libc::TCP_KEEPALIVE,
                (&idle_secs as *const libc::c_int).cast(),
                std::mem::size_of_val(&idle_secs) as libc::socklen_t,
            );
            #[cfg(any(target_os = "linux", target_os = "android", target_os = "freebsd"))]
            let _ = libc::setsockopt(
                fd,
                libc::IPPROTO_TCP,
                libc::TCP_KEEPIDLE,
                (&idle_secs as *const libc::c_int).cast(),
                std::mem::size_of_val(&idle_secs) as libc::socklen_t,
            );
            #[cfg(any(
                target_os = "macos",
                target_os = "ios",
                target_os = "freebsd",
                target_os = "linux",
                target_os = "android"
            ))]
            {
                let _ = libc::setsockopt(
                    fd,
                    libc::IPPROTO_TCP,
                    libc::TCP_KEEPINTVL,
                    (&interval_secs as *const libc::c_int).cast(),
                    std::mem::size_of_val(&interval_secs) as libc::socklen_t,
                );
                let _ = libc::setsockopt(
                    fd,
                    libc::IPPROTO_TCP,
                    libc::TCP_KEEPCNT,
                    (&count as *const libc::c_int).cast(),
                    std::mem::size_of_val(&count) as libc::socklen_t,
                );
            }
        }
    }
}

pub(super) fn is_fatal_accept_error(err: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        matches!(
            err.raw_os_error(),
            Some(libc::EBADF | libc::EINVAL | libc::ENOTSOCK)
        )
    }
    #[cfg(windows)]
    {
        matches!(err.raw_os_error(), Some(10009 | 10022 | 10038 | 10093))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = err;
        false
    }
}

pub struct WsServer {
    state: Arc<DaemonState>,
}

impl WsServer {
    pub fn new(state: Arc<DaemonState>) -> Self {
        Self { state }
    }

    pub async fn bind(self, addr: SocketAddr) -> anyhow::Result<WsHandle> {
        if self.state.config.server.is_some() {
            return super::remote::bind(self.state, addr).await;
        }
        let listener =
            bind_ws_listener(addr).map_err(|err| anyhow!("{}", bind_error_message(addr, &err)))?;
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
    let connections = Arc::new(Semaphore::new(MAX_LOCAL_WS_CONNECTIONS));
    let accept_stop = super::abort::AbortToken::new();
    let mut active_tasks = tokio::task::JoinSet::new();
    // Pin and register the shutdown waiter once before entering the loop so a
    // `notify_waiters()` call arriving while another `select!` branch runs
    // (such as `active_tasks.join_next()` on client disconnect) can never be lost.
    let shutdown_notified = shutdown.notified();
    tokio::pin!(shutdown_notified);
    shutdown_notified.as_mut().enable();
    loop {
        while active_tasks.try_join_next().is_some() {}
        tokio::select! {
            biased;
            _ = &mut shutdown_notified => {
                debug!("ws server shutdown signal received");
                break;
            }
            Some(_) = active_tasks.join_next(), if !active_tasks.is_empty() => {}
            accept = listener.accept() => {
                match accept {
                    Ok((stream, peer)) => {
                        configure_tcp_keepalive(&stream);
                        // Each spawned task pins a slot until the connection
                        // closes — including a client that never completes
                        // the HTTP Upgrade. At the cap, close the fresh TCP
                        // stream right away instead of queueing another
                        // task (#421).
                        let Ok(permit) = Arc::clone(&connections).try_acquire_owned() else {
                            warn!(%peer, "ws connection limit reached; rejecting connection");
                            continue;
                        };
                        let state = Arc::clone(&state);
                        let stop = accept_stop.clone();
                        active_tasks.spawn(async move {
                            let _permit = permit;
                            if let Err(err) = handle_connection(state, stream, peer, stop).await {
                                warn!(error = %err, "ws connection error");
                            }
                        });
                    }
                    Err(err) => {
                        if is_fatal_accept_error(&err) {
                            tracing::error!(error = %err, "fatal ws accept error; stopping listener");
                            break;
                        }
                        warn!(error = %err, "transient ws accept error; backing off");
                        tokio::select! {
                            biased;
                            _ = &mut shutdown_notified => break,
                            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
                        }
                    }
                }
            }
        }
    }
    // Cancel in-flight handshakes BEFORE snapshotting registered browsers, then
    // drain spawned connection tasks so no late socket can register after
    // `WsHandle` exits.
    accept_stop.cancel();
    for client in state.browsers.snapshot() {
        client.close();
    }
    let drain = async { while active_tasks.join_next().await.is_some() {} };
    if tokio::time::timeout(Duration::from_secs(2), drain)
        .await
        .is_err()
    {
        active_tasks.abort_all();
        while active_tasks.join_next().await.is_some() {}
    }
}

/// Cap on concurrently alive local WebSocket connections, TCP accept
/// through full close. Each one holds a tokio task and a socket FD; a
/// local client that keeps opening connections must not exhaust them
/// (#421). The extension and concurrent CLI clients need only a handful.
const MAX_LOCAL_WS_CONNECTIONS: usize = 64;

/// Bound on the HTTP Upgrade phase: a client that opens a TCP connection
/// but stalls before finishing the upgrade must release its task and FD
/// like any other dead connection (#421). Aligned with the post-upgrade
/// first-frame timeout below.
const WS_UPGRADE_TIMEOUT: Duration = Duration::from_secs(5);

async fn handle_connection(
    state: Arc<DaemonState>,
    stream: TcpStream,
    peer: SocketAddr,
    stop: super::abort::AbortToken,
) -> anyhow::Result<()> {
    if stop.is_cancelled() {
        return Ok(());
    }
    let captured_origin: std::sync::Arc<std::sync::Mutex<Option<String>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let captured_origin_for_cb = std::sync::Arc::clone(&captured_origin);
    #[allow(clippy::result_large_err)]
    let callback = move |req: &Request, response: Response| {
        let origin = req
            .headers()
            .get("Origin")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if !origin_allowed(&origin) {
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

    let (stream, read_limit) = super::local_auth::read_limit::AuthReadLimit::new(stream);
    let mut ws = tokio::select! {
        biased;
        _ = stop.cancelled() => return Ok(()),
        res = tokio::time::timeout(
            WS_UPGRADE_TIMEOUT,
            tokio_tungstenite::accept_hdr_async(stream, callback),
        ) => match res {
            Ok(Ok(ws)) => ws,
            Ok(Err(err)) => {
                debug!(?peer, %err, "ws handshake rejected");
                return Ok(());
            }
            Err(_) => {
                debug!(
                    ?peer,
                    timeout_secs = WS_UPGRADE_TIMEOUT.as_secs(),
                    "ws upgrade timed out; dropping connection"
                );
                return Ok(());
            }
        },
    };
    let origin = captured_origin.lock().unwrap().clone().unwrap_or_default();
    let authentication = tokio::select! {
        biased;
        _ = stop.cancelled() => {
            let _ = tokio::time::timeout(Duration::from_millis(100), ws.close(None)).await;
            return Ok(());
        }
        res = tokio::time::timeout(
            HANDSHAKE_FIRST_FRAME_TIMEOUT,
            super::local_auth::handshake::accept(state.clone(), &mut ws, &origin),
        ) => res,
    };
    let (authorization, first) = match authentication {
        Ok(Ok(value)) => value,
        _ => {
            // Do not log peer-controlled authentication frames or parser errors.
            debug!(?peer, "local authentication ended before completion");
            let _ = tokio::time::timeout(Duration::from_millis(100), ws.close(None)).await;
            return Ok(());
        }
    };
    read_limit.store(true, std::sync::atomic::Ordering::Release);
    drive_connection(state, ws, authorization, first, stop).await
}

/// Hard cap on how long the daemon will wait for a freshly-upgraded
/// WebSocket client to send its first frame (which MUST be
/// `system.handshake` per §4.2). Without this, a passing-Origin client
/// that completes the WS upgrade but never speaks pins a tokio task +
/// socket FD indefinitely (review M4/M5 round 3 I-R3-1).
const HANDSHAKE_FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);

/// Periodic server-side WS Ping interval to detect half-open or dead peers
/// (including legacy extensions that do not send `system.heartbeat`).
const WS_PING_INTERVAL: Duration = Duration::from_secs(30);

/// Bound on a single WS write so a stalled/blackholed TCP peer cannot park
/// `drive_connection` indefinitely.
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(15);

/// Consecutive unanswered WS Pings before closing a dead connection.
const MAX_MISSED_WS_PONGS: u8 = 2;

/// Bounded per-connection FIFO queue for background audit disk operations so
/// slow 16 MiB audit reads/writes never head-of-line-block the WS pump loop.
const AUDIT_WORKER_QUEUE_CAP: usize = 128;

enum AuditWork {
    Context {
        ticket: super::audit::Ticket,
        ctx: AuditContextEvent,
    },
    Marker {
        session_id: String,
        kind: &'static str,
    },
    Request {
        id: RpcId,
        params: serde_json::Value,
    },
}

#[derive(serde::Deserialize)]
struct LocalAuthTypeProbe<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<std::borrow::Cow<'a, str>>,
}

fn is_post_handshake_local_auth(text: &str) -> bool {
    serde_json::from_str::<LocalAuthTypeProbe<'_>>(text)
        .ok()
        .and_then(|probe| probe.kind)
        .is_some_and(|kind| kind.starts_with("local.auth."))
}

pub(super) async fn drive_connection<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    state: Arc<DaemonState>,
    ws: WebSocketStream<S>,
    mut authorization: PeerAuthorization,
    first_message: Option<Message>,
    listener_stop: super::abort::AbortToken,
) -> anyhow::Result<()> {
    let (mut writer, mut reader) = ws.split();

    if listener_stop.is_cancelled() {
        let _ = tokio::time::timeout(
            Duration::from_millis(100),
            writer.send(Message::Close(None)),
        )
        .await;
        return Ok(());
    }

    // The first frame MUST be `system.handshake` per §4.2. Bound the
    // wait so a stalled client cannot park resources forever.
    let first = if let Some(message) = first_message {
        Ok(Some(Ok(message)))
    } else {
        tokio::select! {
            biased;
            _ = listener_stop.cancelled() => {
                let _ = tokio::time::timeout(Duration::from_millis(100), writer.send(Message::Close(None))).await;
                return Ok(());
            }
            _ = authorization.revoked() => return Err(anyhow!("device authorization ended before handshake")),
            first = tokio::time::timeout(HANDSHAKE_FIRST_FRAME_TIMEOUT, reader.next()) => first,
        }
    };
    let first = match first {
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
    let handshake: bsk_protocol::system::HandshakeRequest = serde_json::from_value(params_raw)
        .map_err(|err| anyhow!("invalid HandshakeRequest: {err}"))?;
    let audit_enabled = handshake.audit_enabled.unwrap_or(false);
    let params = handshake.identity;

    // Version compatibility (design §10, M10.4): protocol_version only.
    let our_app_version: Version = env!("CARGO_PKG_VERSION")
        .parse()
        .expect("CARGO_PKG_VERSION must be a valid semver");
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
    let registration = authorization.registration_guard().await;
    if listener_stop.is_cancelled() {
        let _ = tokio::time::timeout(
            Duration::from_millis(100),
            writer.send(Message::Close(None)),
        )
        .await;
        return Ok(());
    }
    if !authorization.bind_instance(&params.instance_id) || !authorization.authorized().await {
        return Err(anyhow!(
            "device authorization ended or browser identity mismatch"
        ));
    }
    if listener_stop.is_cancelled() {
        let _ = tokio::time::timeout(
            Duration::from_millis(100),
            writer.send(Message::Close(None)),
        )
        .await;
        return Ok(());
    }
    let browser_id = BrowserId(authorization.browser_id(&params.instance_id).to_owned());
    // Evict any prior socket for this browser FIRST before purging stale
    // sessions and running `audit.configure`, so no CLI caller can attach a
    // ghost session to the dying connection while `audit.configure` runs, and
    // no tool RPC can dispatch on the new connection before opt-in is restored.
    state.browsers.evict_for_reconnect(&browser_id);
    // A fresh socket represents a fresh extension control plane. The
    // extension tears down its local sessions before reconnecting, so any
    // daemon-side sessions left under the same instance id are stale. Purge
    // them before registering the new browser entry.
    state.purge_sessions_of_browser(
        &browser_id,
        bsk_protocol::RpcErrorReason::BrowserDisconnected.as_str(),
        "purged stale session before browser reconnect",
    );
    // Restore opt-in before making the browser available to CLI callers.
    let audit_ready = {
        let state = Arc::clone(&state);
        let browser = browser_id.0.clone();
        let configure_task = tokio::task::spawn_blocking(move || {
            state.audit.configure(&browser, audit_enabled).is_ok()
        });
        tokio::select! {
            biased;
            _ = listener_stop.cancelled() => {
                let _ = tokio::time::timeout(Duration::from_millis(100), writer.send(Message::Close(None))).await;
                return Ok(());
            }
            res = configure_task => res.unwrap_or(false),
        }
    };
    if listener_stop.is_cancelled() {
        let _ = tokio::time::timeout(
            Duration::from_millis(100),
            writer.send(Message::Close(None)),
        )
        .await;
        return Ok(());
    }
    if !authorization.active() {
        return Err(anyhow!("device authorization ended during registration"));
    }
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
        liveness: super::browsers::Liveness::default(),
    });
    let client_closed = client.closed_token();
    state.browsers.insert(Arc::clone(&client));
    authorization.register(&client);
    drop(registration);
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
        min_compatible_peer: None,
        min_compatible_protocol: Some(MIN_COMPATIBLE_PROTOCOL.to_string()),
    };
    let result = serde_json::to_value(bsk_protocol::system::HandshakeResponse {
        identity: result,
        audit_version: Some(1),
        audit_ready: Some(audit_ready),
    })?;
    let resp = ResponseFrame {
        id: request.id.clone(),
        body: ResponseBody::Ok(result),
    };

    // Dedicated per-connection FIFO worker for audit disk I/O so slow audit
    // reads/writes (up to 16 MiB) never stall tool responses, cancel frames,
    // or heartbeats on the WS pump loop, while preserving strict arrival order
    // between `audit.context`, markers, and subsequent `audit.request` calls.
    let (audit_tx, mut audit_rx) = mpsc::channel::<AuditWork>(AUDIT_WORKER_QUEUE_CAP);
    {
        let worker_state = Arc::clone(&state);
        let worker_client = Arc::clone(&client);
        let worker_closed = client_closed.clone();
        tokio::spawn(async move {
            while let Some(work) = audit_rx.recv().await {
                match work {
                    AuditWork::Context { ticket, ctx } => {
                        let state = Arc::clone(&worker_state);
                        let _ = tokio::task::spawn_blocking(move || {
                            state.audit.write_context_with_ticket(ticket, &ctx);
                        })
                        .await;
                    }
                    AuditWork::Marker { session_id, kind } => {
                        let state = Arc::clone(&worker_state);
                        let _ = tokio::task::spawn_blocking(move || {
                            state.audit.marker(&session_id, kind);
                        })
                        .await;
                    }
                    AuditWork::Request { id, params } => {
                        if worker_closed.is_cancelled() {
                            continue;
                        }
                        let state = Arc::clone(&worker_state);
                        let browser = worker_client.id.0.clone();
                        let body = tokio::task::spawn_blocking(move || {
                            handle_audit_request(&state, &browser, params)
                        })
                        .await
                        .unwrap_or_else(|_| {
                            ResponseBody::Err(RpcError {
                                code: bsk_protocol::ErrorCode::ProtocolError,
                                message: "Audit request failed. Check local storage, task availability, or retry.".into(),
                                data: None,
                            })
                        });
                        let _ = worker_client
                            .sink
                            .send(Frame::Response(ResponseFrame { id, body }));
                    }
                }
            }
        });
    }

    // Pump loop: outbound frames from sink → ws; inbound from ws → resolve.
    let pump_state = Arc::clone(&state);
    let pump_browser = Arc::clone(&client);
    let pump = async {
        tokio::time::timeout(
            WS_WRITE_TIMEOUT,
            writer.send(Message::Text(serde_json::to_string(&resp)?)),
        )
        .await
        .map_err(|_| anyhow!("ws handshake response write timed out"))??;
        let mut ping_interval = tokio::time::interval_at(
            tokio::time::Instant::now() + WS_PING_INTERVAL,
            WS_PING_INTERVAL,
        );
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut missed_pongs: u8 = 0;
        loop {
            tokio::select! {
                outbound = rx.recv() => {
                    if !authorization.active() { break; }
                    match outbound {
                        Some(frame) => {
                            let json = serde_json::to_string(&frame)?;
                            match tokio::time::timeout(
                                WS_WRITE_TIMEOUT,
                                writer.send(Message::Text(json)),
                            )
                            .await
                            {
                                Ok(Ok(())) => {}
                                Ok(Err(err)) => return Err(err.into()),
                                Err(_) => return Err(anyhow!("ws outbound write timed out")),
                            }
                        }
                        None => break,
                    }
                }
                _ = ping_interval.tick() => {
                    if !authorization.active() { break; }
                    if missed_pongs >= MAX_MISSED_WS_PONGS {
                        warn!(
                            id = %pump_browser.id,
                            missed_pongs,
                            "ws peer missed consecutive ping responses; closing connection"
                        );
                        break;
                    }
                    missed_pongs = missed_pongs.saturating_add(1);
                    match tokio::time::timeout(
                        WS_WRITE_TIMEOUT,
                        writer.send(Message::Ping(Vec::new())),
                    )
                    .await
                    {
                        Ok(Ok(())) => {}
                        Ok(Err(err)) => {
                            warn!(id = %pump_browser.id, %err, "ws ping write failed");
                            break;
                        }
                        Err(_) => {
                            warn!(id = %pump_browser.id, "ws ping write timed out");
                            break;
                        }
                    }
                }
                msg = reader.next() => {
                    if !authorization.active() { break; }
                    match msg {
                        Some(Ok(Message::Text(t))) => {
                            missed_pongs = 0;
                            match serde_json::from_str::<Frame>(&t) {
                                Ok(frame) => {
                                    if t.contains("\"local.auth.")
                                        && is_post_handshake_local_auth(&t)
                                    {
                                        break;
                                    }
                                    // Any inbound frame — tool response, event, or the
                                    // ~20s heartbeat — counts as proof of life.
                                    pump_browser.touch();
                                    handle_inbound_frame(
                                        &pump_state,
                                        &pump_browser,
                                        frame,
                                        &audit_tx,
                                    );
                                }
                                Err(err) => {
                                    if is_post_handshake_local_auth(&t) {
                                        break;
                                    }
                                    pump_browser.touch();
                                    warn!(%err, "invalid inbound frame");
                                }
                            }
                        }
                        Some(Ok(Message::Binary(_))) => {
                            warn!("ignoring binary message");
                        }
                        Some(Ok(Message::Ping(p))) => {
                            missed_pongs = 0;
                            if !pump_browser.has_heartbeat() {
                                pump_browser.touch();
                            }
                            let _ = tokio::time::timeout(
                                WS_WRITE_TIMEOUT,
                                writer.send(Message::Pong(p)),
                            )
                            .await;
                        }
                        Some(Ok(Message::Pong(_))) => {
                            missed_pongs = 0;
                            // For heartbeat-capable MV3 extensions, browser-level WS
                            // Pongs can keep arriving even after the service worker
                            // freezes; only touch liveness for legacy peers.
                            if !pump_browser.has_heartbeat() {
                                pump_browser.touch();
                            }
                        }
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
    };
    enum PumpExit {
        Pump(anyhow::Result<()>),
        Revoked,
        Closed,
    }
    // Revocation and explicit eviction/shutdown must also interrupt a blocked
    // socket write or idle pump, not rely on `rx.recv()` returning `None`
    // (which cannot happen while this task still holds `Arc<BrowserClient>`).
    let exit = tokio::select! {
        biased;
        _ = listener_stop.cancelled() => PumpExit::Closed,
        _ = authorization.revoked() => PumpExit::Revoked,
        _ = client_closed.cancelled() => PumpExit::Closed,
        result = pump => PumpExit::Pump(result),
    };
    drop(audit_tx);
    let (result_outcome, send_close) = match exit {
        PumpExit::Pump(result) => (result, false),
        PumpExit::Revoked | PumpExit::Closed => (Ok(()), true),
    };
    if send_close {
        let _ = tokio::time::timeout(
            Duration::from_millis(500),
            writer.send(Message::Close(None)),
        )
        .await;
    }
    // Responses for this socket can only arrive on it, so calls still
    // waiting here would otherwise sit until their own deadline.
    client.close();

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
        state.purge_sessions_of_browser(
            &browser_id,
            bsk_protocol::RpcErrorReason::BrowserDisconnected.as_str(),
            "purged session on browser disconnect",
        );
    } else {
        info!(
            id = %browser_id,
            generation,
            "browser disconnected; newer reconnect already owns this id, leaving sessions intact"
        );
    }
    result_outcome
}

fn handle_inbound_frame(
    state: &Arc<DaemonState>,
    client: &Arc<BrowserClient>,
    frame: Frame,
    audit_tx: &mpsc::Sender<AuditWork>,
) {
    match frame {
        Frame::Response(resp) => {
            let mut pending = client.pending.lock().unwrap();
            if !pending.resolve(resp.clone()) {
                debug!(id = %resp.id, "response for unknown rpc id (ignored)");
            }
        }
        Frame::Event(ev) => match ev {
            EventFrame::AuditContext(ctx) => {
                if let Some(ticket) = state.audit.prepare_context(&client.id.0, &ctx)
                    && let Err(err) = audit_tx.try_send(AuditWork::Context { ticket, ctx })
                {
                    warn!(browser = %client.id, %err, "dropping audit context: worker queue full");
                }
            }
            EventFrame::DialogChanged(dlg) => {
                if state
                    .sessions
                    .get(&super::sessions::SessionId(dlg.session_id.clone()))
                    .is_some_and(|s| s.browser_id == client.id)
                {
                    state.dialog_operations.dialog_changed(&dlg);
                    if let Some(id) = dlg.operation_id.as_deref()
                        && let Some(operation) = state.dialog_operations.get(&dlg.session_id, id)
                        && let Some(inflight) = state.tool_inflight.get(&operation.cli_rpc_id)
                    {
                        inflight.dialog_pending.send_replace(dlg.dialog.is_some());
                    }
                }
            }
            EventFrame::SystemHeartbeat(_) => {
                // `touch()` already ran for this frame in the read loop;
                // additionally opt this browser in to liveness reaping now
                // that we know it speaks the heartbeat.
                client.mark_heartbeat_seen();
                debug!(id = %client.id, "heartbeat");
            }
            EventFrame::SessionActivity(activity) => {
                state.sessions.update_activity(
                    &super::sessions::SessionId(activity.session_id),
                    &client.id,
                    activity.idle_protected,
                );
            }
            EventFrame::SessionInteractionChanged(change) => {
                state.sessions.update_interaction(
                    &super::sessions::SessionId(change.session_id),
                    &client.id,
                    change.interaction,
                );
            }
            EventFrame::SessionWindowClosed(closed) => {
                handle_session_window_closed(state, &client.id, &closed);
            }
            EventFrame::SessionEnded(ended) => {
                handle_session_ended(state, &client.id, &ended);
            }
            EventFrame::SessionUserInterrupt(interrupt) => {
                if let Some(sid) = apply_session_user_interrupt(state, &client.id, &interrupt)
                    && state.audit.needs_marker(&sid)
                    && let Err(err) = audit_tx.try_send(AuditWork::Marker {
                        session_id: sid,
                        kind: "user_interrupt",
                    })
                {
                    warn!(browser = %client.id, %err, "dropping audit marker: worker queue full");
                }
            }
            other @ (EventFrame::BrowserConnected(_) | EventFrame::BrowserDisconnected(_)) => {
                debug!(event = ?other.kind(), "event received (no handler yet)");
            }
        },
        Frame::Request(req) => {
            if req.method == bsk_protocol::Method::AuditRequest {
                let id = req.id;
                let params = req.params.unwrap_or_default();
                let is_disable = params.get("action").and_then(serde_json::Value::as_str)
                    == Some("configure")
                    && params.get("enabled").and_then(serde_json::Value::as_bool) == Some(false);
                // Apply opt-out immediately in memory before enqueueing disk work
                // so a slow preceding `audit.request` cannot let subsequent tool
                // RPCs keep recording after the user disables audit.
                if is_disable {
                    state.audit.disable_in_memory(&client.id.0);
                }
                if audit_tx
                    .try_send(AuditWork::Request {
                        id: id.clone(),
                        params,
                    })
                    .is_err()
                {
                    let _ = client.sink.send(Frame::Response(ResponseFrame {
                        id,
                        body: ResponseBody::Err(RpcError {
                            code: bsk_protocol::ErrorCode::ProtocolError,
                            message: "Audit worker is busy; retry shortly.".into(),
                            data: None,
                        }),
                    }));
                }
            } else {
                let _ = client.sink.send(Frame::Response(ResponseFrame {
                    id: req.id,
                    body: ResponseBody::Err(RpcError {
                        code: bsk_protocol::ErrorCode::UnknownMethod,
                        message: "Unsupported extension request".into(),
                        data: None,
                    }),
                }));
            }
        }
    }
}

fn handle_audit_request(
    state: &DaemonState,
    browser: &str,
    params: serde_json::Value,
) -> ResponseBody {
    let result = serde_json::from_value::<AuditRequestParams>(params)
        .map_err(|err| anyhow!(err))
        .and_then(|params| {
            let id = params.id.as_deref().unwrap_or("");
            let offset = params.offset.unwrap_or(0).min(1_000_000) as usize;
            let limit = params.limit.unwrap_or(100).min(500) as usize;
            match params.action.as_str() {
                "configure" => match params.enabled {
                    Some(enabled) => state.audit.configure(browser, enabled),
                    None => Err(anyhow!("Missing enabled preference")),
                },
                "list" => state.audit.list(browser, offset, limit),
                "get" => state.audit.get(browser, id, offset, limit),
                "delete" => state.audit.delete(browser, id),
                "open_directory" => open_audit_directory(&state.audit),
                _ => Err(anyhow!("Unknown audit action")),
            }
        });
    match result {
        Ok(value) => ResponseBody::Ok(value),
        Err(_) => ResponseBody::Err(RpcError {
            code: bsk_protocol::ErrorCode::ProtocolError,
            message: "Audit request failed. Check local storage, task availability, or retry."
                .into(),
            data: None,
        }),
    }
}

fn open_audit_directory(audit: &super::audit::AuditStore) -> anyhow::Result<serde_json::Value> {
    let path = audit.directory()?;
    std::fs::create_dir_all(path)?;
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(windows)]
    let program = "explorer.exe";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program).arg(path).spawn()?;
    Ok(serde_json::json!({"opened": true}))
}

fn handle_session_window_closed(
    state: &Arc<DaemonState>,
    sender: &BrowserId,
    closed: &SessionWindowClosedEvent,
) {
    if closed.session_id.is_empty() {
        warn!("session.window_closed event missing session_id");
        return;
    }
    let session_id = super::sessions::SessionId(closed.session_id.clone());
    // Reject events that target a session owned by a *different* browser.
    // Without this, any connected extension (or any same-machine process
    // that completed the WS handshake) could tear down another browser's
    // session by emitting window_closed with its session_id. A session
    // that is already gone cannot be verified and `teardown_session` is
    // a safe no-op, so we only reject when a live owner disagrees.
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
    if state.teardown_session(
        &session_id,
        bsk_protocol::RpcErrorReason::SessionWindowClosed.as_str(),
    ) {
        info!(session = %session_id, "session removed: user closed Agent Window");
    } else {
        debug!(session = %session_id, "session.window_closed for unknown session id");
    }
    for failure in &closed.return_failures {
        warn!(
            session = %session_id,
            tab_id = failure.tab_id,
            code = ?failure.code,
            message = %failure.message,
            "borrowed tab could not be returned before Agent Window closed"
        );
    }
}

fn handle_session_ended(state: &Arc<DaemonState>, sender: &BrowserId, ended: &SessionEndedEvent) {
    if ended.session_id.is_empty()
        || ended.reason != bsk_protocol::SessionEndedReason::UserMovedTab
        || ended.tab_id <= 0
    {
        warn!("invalid session.ended reason or resource identity");
        return;
    }
    let sid = super::sessions::SessionId(ended.session_id.clone());
    let Some(session) = state.sessions.get(&sid) else {
        // Duplicates and late events must not cancel work for an unverified id.
        debug!(session = %sid, "session.ended for unknown session id");
        return;
    };
    if session.browser_id != *sender {
        warn!(session = %sid, %sender, "ignoring session.ended from a browser that does not own this session");
        return;
    }

    if state.teardown_session(&sid, bsk_protocol::RpcErrorReason::UserMovedTab.as_str()) {
        info!(session = %sid, tab_id = ended.tab_id, "session ended: user moved a controlled tab");
    }
}

/// Extension-originated request to interrupt every inflight + queued
/// `tool.*` call for a session. Maps to `cancel_session` on the
/// inflight registry, which trips each entry's cancel token AND
/// records `CancelReason::UserAborted` so the worker surfaces
/// `ErrorCode::UserAborted` to the IPC peer. For entries already
/// forwarded over WS we additionally push a per-RPC cancel frame so
/// the extension's dispatcher can abort its `AbortController` —
/// this is the same shape `handle_cancel` uses, just iterated.
fn apply_session_user_interrupt(
    state: &Arc<DaemonState>,
    sender: &BrowserId,
    interrupt: &SessionUserInterruptEvent,
) -> Option<String> {
    if interrupt.session_id.is_empty() {
        warn!("session.user_interrupt event missing session_id");
        return None;
    }
    let sid = super::sessions::SessionId(interrupt.session_id.clone());
    // Require a live session owned by `sender`: a foreign browser must not
    // interrupt another browser's session, and late events for an already-ended
    // session must not leak a `SessionId` into `SessionInterruptRegistry`.
    let Some(session) = state.sessions.get(&sid) else {
        debug!(session = %sid, sender = %sender, "ignoring session.user_interrupt for unknown or ended session");
        return None;
    };
    if session.browser_id != *sender {
        warn!(
            session = %sid,
            sender = %sender,
            owner = %session.browser_id,
            "ignoring session.user_interrupt from a browser that does not own this session"
        );
        return None;
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
    Some(sid.0)
}

#[cfg(test)]
fn handle_session_user_interrupt(
    state: &Arc<DaemonState>,
    sender: &BrowserId,
    interrupt: &SessionUserInterruptEvent,
) {
    if let Some(sid) = apply_session_user_interrupt(state, sender, interrupt) {
        state.audit.marker(&sid, "user_interrupt");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_allowlist_accepts_valid_extension_id() {
        let id = "a".repeat(32);
        assert!(origin_allowed(&format!("chrome-extension://{id}")));
    }

    #[test]
    fn origin_allowlist_rejects_uppercase() {
        let id = "A".repeat(32);
        assert!(!origin_allowed(&format!("chrome-extension://{id}")));
    }

    #[test]
    fn origin_allowlist_rejects_unknown_scheme() {
        let id = "a".repeat(32);
        assert!(!origin_allowed(&format!("http://{id}.example")));
    }

    #[test]
    fn origin_allowlist_rejects_chars_outside_ap() {
        let id = "z".repeat(32); // 'z' > 'p'
        assert!(!origin_allowed(&format!("chrome-extension://{id}")));
    }

    #[test]
    fn default_port_bind_failure_names_the_os_owner_of_the_port() {
        let addr = SocketAddr::from(([127, 0, 0, 1], super::super::DEFAULT_WS_PORT));
        let message = bind_error_message(addr, &std::io::Error::from_raw_os_error(10048));

        assert!(message.contains("bind WS server on 127.0.0.1:52800"));
        assert!(message.contains("netsh int ipv4 show excludedportrange protocol=tcp"));
        assert!(message.contains("bsk daemon start --foreground --port <port>"));
    }

    #[test]
    fn default_port_bind_failure_without_a_windows_code_skips_the_win_nat_hint() {
        let addr = SocketAddr::from(([127, 0, 0, 1], super::super::DEFAULT_WS_PORT));
        let message = bind_error_message(addr, &std::io::Error::from_raw_os_error(13));

        assert!(!message.contains("netsh int ipv4 show excludedportrange protocol=tcp"));
        assert!(message.contains("bsk daemon start --foreground --port <port>"));
    }

    #[test]
    fn explicit_port_bind_failure_reports_the_plain_os_error() {
        let addr = SocketAddr::from(([127, 0, 0, 1], 42800));
        let message = bind_error_message(addr, &std::io::Error::from_raw_os_error(10048));

        assert!(message.starts_with("bind WS server on 127.0.0.1:42800"));
        assert!(!message.contains("default daemon port"));
        assert!(!message.contains("netsh int ipv4 show excludedportrange protocol=tcp"));
    }

    #[test]
    fn origin_allowlist_rejects_local_web_pages() {
        assert!(!origin_allowed("http://localhost"));
    }
}

#[cfg(test)]
mod session_user_interrupt_tests {
    use super::*;
    use crate::daemon::browsers::BrowserId;
    use crate::daemon::inflight::CancelReason;
    use crate::daemon::sessions::SessionId;

    #[test]
    fn session_user_interrupt_payload_decodes_session_id() {
        let ev = EventFrame::from_parts(
            bsk_protocol::EventKind::SessionUserInterrupt,
            serde_json::json!({ "session_id": "sess-9" }),
        )
        .expect("session id present");
        assert!(matches!(ev, EventFrame::SessionUserInterrupt(ref i) if i.session_id == "sess-9"));
    }

    #[test]
    fn session_user_interrupt_payload_missing_or_non_string_session_id_is_rejected() {
        for payload in [
            serde_json::json!({}),
            serde_json::json!({ "session_id": 42 }),
        ] {
            assert!(
                EventFrame::from_parts(bsk_protocol::EventKind::SessionUserInterrupt, payload)
                    .is_err()
            );
        }
    }

    #[test]
    fn session_user_interrupt_empty_session_id_is_ignored() {
        let state = test_only_daemon_state();
        let sid_a = SessionId("A".into());
        let g_a = state
            .tool_inflight
            .register("a".into(), sid_a.clone())
            .unwrap();
        handle_session_user_interrupt(
            &state,
            &BrowserId("sender".into()),
            &SessionUserInterruptEvent {
                session_id: String::new(),
            },
        );
        assert!(g_a.entry().cancel_reason().is_none());
        assert!(!state.session_interrupts.try_consume(&sid_a));
    }

    #[test]
    fn handle_session_user_interrupt_cancels_inflight_for_target_session() {
        let state = test_only_daemon_state();
        let owner = BrowserId("sender".into());
        let sid_a = SessionId("A".into());
        let sid_b = SessionId("B".into());
        state.sessions.insert(crate::daemon::sessions::Session {
            controller: None,
            interaction: None,
            id: sid_a.clone(),
            browser_id: owner.clone(),
            agent_window_id: Some(1),
            created_at_ms: 0,
        });
        state.sessions.insert(crate::daemon::sessions::Session {
            controller: None,
            interaction: None,
            id: sid_b.clone(),
            browser_id: owner.clone(),
            agent_window_id: Some(2),
            created_at_ms: 0,
        });
        let g_a = state
            .tool_inflight
            .register("a".into(), sid_a.clone())
            .unwrap();
        let g_b = state
            .tool_inflight
            .register("b".into(), sid_b.clone())
            .unwrap();

        handle_session_user_interrupt(
            &state,
            &owner,
            &SessionUserInterruptEvent {
                session_id: "A".into(),
            },
        );

        assert_eq!(g_a.entry().cancel_reason(), Some(CancelReason::UserAborted));
        assert!(g_b.entry().cancel_reason().is_none());
    }

    #[test]
    fn handle_session_user_interrupt_marks_pending_for_target_session() {
        let state = test_only_daemon_state();
        let owner = BrowserId("sender".into());
        let sid_a = SessionId("A".into());
        let sid_b = SessionId("B".into());
        state.sessions.insert(crate::daemon::sessions::Session {
            controller: None,
            interaction: None,
            id: sid_a.clone(),
            browser_id: owner.clone(),
            agent_window_id: Some(1),
            created_at_ms: 0,
        });

        handle_session_user_interrupt(
            &state,
            &owner,
            &SessionUserInterruptEvent {
                session_id: "A".into(),
            },
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
    fn handle_session_user_interrupt_ignores_ended_session_without_leaking() {
        let state = test_only_daemon_state();
        let sid_ended = SessionId("gone".into());
        handle_session_user_interrupt(
            &state,
            &BrowserId("sender".into()),
            &SessionUserInterruptEvent {
                session_id: sid_ended.0.clone(),
            },
        );
        assert!(
            !state.session_interrupts.try_consume(&sid_ended),
            "late user_interrupt for an ended/unknown session must not leak a SessionId"
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

        handle_session_user_interrupt(
            &state,
            &owner,
            &SessionUserInterruptEvent {
                session_id: sid.0.clone(),
            },
        );

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

        handle_session_user_interrupt(
            &state,
            &attacker,
            &SessionUserInterruptEvent {
                session_id: sid.0.clone(),
            },
        );

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

        handle_session_window_closed(
            &state,
            &owner,
            &SessionWindowClosedEvent {
                session_id: sid.0.clone(),
                reason: None,
                return_failures: Vec::new(),
            },
        );

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

        handle_session_window_closed(
            &state,
            &attacker,
            &SessionWindowClosedEvent {
                session_id: sid.0.clone(),
                reason: None,
                return_failures: Vec::new(),
            },
        );

        assert!(
            state.sessions.get(&sid).is_some(),
            "non-owning browser must not be able to tear down another session"
        );
    }

    fn user_moved_tab_payload(sid: &SessionId) -> SessionEndedEvent {
        SessionEndedEvent {
            session_id: sid.0.clone(),
            reason: bsk_protocol::SessionEndedReason::UserMovedTab,
            tab_id: 42,
        }
    }

    #[tokio::test]
    async fn session_ended_cancels_running_and_queued_tools_and_retains_reason() {
        use crate::daemon::browsers::{Liveness, next_browser_generation};
        use crate::daemon::inflight::PromoteOutcome;
        use bsk_protocol::{ErrorCode, Method};
        use std::sync::Mutex;

        let state = test_only_daemon_state();
        let owner = BrowserId("owner-browser".into());
        let (tx, mut rx) = mpsc::unbounded_channel();
        let browser = Arc::new(BrowserClient {
            id: owner.clone(),
            browser_name: "test".into(),
            browser_version: "1".into(),
            extension_version: "1".into(),
            extension_protocol_version: "1".into(),
            label: "test".into(),
            sink: BrowserSink { tx },
            pending: Mutex::new(Pending::default()),
            generation: next_browser_generation(),
            connected_at_ms: 0,
            version_skew: false,
            liveness: Liveness::default(),
        });
        state.browsers.insert(Arc::clone(&browser));
        let sid = state.sessions.reserve_id(owner.clone(), 8, || 0).unwrap();
        state.tool_queues.spawn(sid.clone());
        let running = state
            .tool_inflight
            .register("running".into(), sid.clone())
            .unwrap();
        let queued = state
            .tool_inflight
            .register("queued".into(), sid.clone())
            .unwrap();
        let unrelated = state
            .tool_inflight
            .register("other".into(), SessionId("other".into()))
            .unwrap();
        let queues = Arc::clone(&state.tool_queues);
        let current_sid = sid.clone();
        let current_entry = running.entry();
        let command = tokio::spawn(async move {
            queues
                .dispatch(
                    &current_sid,
                    Method::ToolTabList,
                    serde_json::json!({ "session_id": current_sid.0 }),
                    Duration::from_secs(5),
                    Some(current_entry),
                )
                .await
        });
        let Frame::Request(request) = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap()
        else {
            panic!("tool request expected");
        };
        assert_eq!(request.method, Method::ToolTabList);

        handle_session_ended(&state, &owner, &user_moved_tab_payload(&sid));
        assert_eq!(
            running.entry().cancel_reason(),
            Some(CancelReason::UserMovedTab)
        );
        assert_eq!(
            queued.entry().cancel_reason(),
            Some(CancelReason::UserMovedTab)
        );
        assert!(!unrelated.entry().is_cancelled());
        assert_eq!(
            queued
                .entry()
                .promote_to_forwarded_with(owner.clone(), "never".into(), || panic!(
                    "queued work must not reach Chrome"
                )),
            PromoteOutcome::Cancelled
        );
        assert!(state.sessions.get(&sid).is_none());
        assert!(!state.tool_queues.is_accepting(&sid));
        assert!(!state.session_interrupts.try_consume(&sid));
        let ended = state.sessions.end_info(&sid).unwrap();
        assert_eq!(
            ended.reason,
            bsk_protocol::RpcErrorReason::UserMovedTab.as_str()
        );

        let Frame::Request(cancel) = rx.recv().await.unwrap() else {
            panic!("cancel expected")
        };
        assert_eq!(cancel.method, Method::Cancel);
        assert_eq!(cancel.params.unwrap()["rpc_id"], request.id);
        browser.pending.lock().unwrap().resolve(ResponseFrame {
            id: request.id,
            body: ResponseBody::Err(RpcError {
                code: ErrorCode::Cancelled,
                message: "stopped".into(),
                data: None,
            }),
        });
        let error = command.await.unwrap().unwrap_err().into_rpc();
        assert_eq!(error.code, ErrorCode::UserAborted);
        assert_eq!(
            error.data.unwrap()["reason"],
            bsk_protocol::RpcErrorReason::UserMovedTab.as_str()
        );

        let later = state
            .tool_queues
            .dispatch(
                &sid,
                Method::ToolTabList,
                serde_json::json!({ "session_id": sid.0 }),
                Duration::from_secs(1),
                None,
            )
            .await
            .unwrap_err()
            .into_rpc();
        assert_eq!(later.code, ErrorCode::NotFound);
        assert_eq!(
            later.data.unwrap()["reason"],
            bsk_protocol::RpcErrorReason::UserMovedTab.as_str()
        );
        handle_session_ended(&state, &owner, &user_moved_tab_payload(&sid));
        assert_eq!(
            state.sessions.end_info(&sid).unwrap().ended_unix_ms,
            ended.ended_unix_ms
        );
        assert!(state.sessions.get(&sid).is_none());
    }

    #[test]
    fn session_ended_rejects_foreign_browser_and_invalid_payloads() {
        let state = test_only_daemon_state();
        let owner = BrowserId("owner-browser".into());
        let sid = state.sessions.reserve_id(owner.clone(), 8, || 0).unwrap();
        let guard = state
            .tool_inflight
            .register("pending".into(), sid.clone())
            .unwrap();
        handle_session_ended(
            &state,
            &BrowserId("foreign".into()),
            &user_moved_tab_payload(&sid),
        );
        for raw in [
            serde_json::json!({ "session_id": sid.0, "reason": "unknown", "tab_id": 42 }),
            serde_json::json!({ "session_id": sid.0, "reason": "user_moved_tab" }),
        ] {
            assert!(EventFrame::from_parts(bsk_protocol::EventKind::SessionEnded, raw).is_err());
        }
        for invalid in [
            SessionEndedEvent {
                session_id: sid.0.clone(),
                reason: bsk_protocol::SessionEndedReason::UserMovedTab,
                tab_id: 0,
            },
            SessionEndedEvent {
                session_id: String::new(),
                reason: bsk_protocol::SessionEndedReason::UserMovedTab,
                tab_id: 42,
            },
        ] {
            handle_session_ended(&state, &owner, &invalid);
        }
        assert!(state.sessions.get(&sid).is_some());
        assert!(state.sessions.end_info(&sid).is_none());
        assert!(!guard.entry().is_cancelled());
        assert!(!state.session_interrupts.try_consume(&sid));
    }

    #[test]
    fn session_ended_does_not_cancel_an_unknown_session() {
        let state = test_only_daemon_state();
        let sid = SessionId("unknown".into());
        let guard = state
            .tool_inflight
            .register("pending".into(), sid.clone())
            .unwrap();
        handle_session_ended(
            &state,
            &BrowserId("sender".into()),
            &user_moved_tab_payload(&sid),
        );
        assert!(!guard.entry().is_cancelled());
        assert!(state.sessions.end_info(&sid).is_none());
    }

    fn test_only_daemon_state() -> std::sync::Arc<DaemonState> {
        use crate::daemon::start::DaemonConfig;
        std::sync::Arc::new(DaemonState::new(DaemonConfig::new(0)))
    }
}

#[cfg(test)]
mod ws_connection_limit_tests {
    use super::*;
    use crate::daemon::start::DaemonConfig;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};

    fn extension_origin_request(url: &str) -> impl IntoClientRequest {
        let mut request = url.into_client_request().expect("valid ws url");
        request.headers_mut().insert(
            HeaderName::from_static("origin"),
            // MV3 extension ids are 32 a-p characters (see origin_allowed).
            HeaderValue::from_static("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaap"),
        );
        request
    }

    async fn bind_test_server() -> (WsHandle, std::sync::Arc<DaemonState>) {
        let state = std::sync::Arc::new(DaemonState::new(DaemonConfig::new(0)));
        let handle = WsServer::new(std::sync::Arc::clone(&state))
            .bind("127.0.0.1:0".parse().expect("loopback addr"))
            .await
            .expect("bound test ws server");
        (handle, state)
    }

    #[tokio::test]
    async fn ws_upgrade_times_out_for_silent_clients() {
        let (handle, _state) = bind_test_server().await;

        // A client that connects but never starts the HTTP Upgrade pins a
        // task + socket only until WS_UPGRADE_TIMEOUT, then the daemon
        // drops it (#421).
        let mut silent = tokio::net::TcpStream::connect(handle.local_addr)
            .await
            .expect("tcp connected");
        let dropped = tokio::time::timeout(WS_UPGRADE_TIMEOUT + Duration::from_secs(5), {
            let read_half = &mut silent;
            async move {
                let mut buf = [0u8; 64];
                loop {
                    match tokio::io::AsyncReadExt::read(read_half, &mut buf).await {
                        Ok(0) => break true,
                        Ok(_) => continue,
                        Err(_) => break true,
                    }
                }
            }
        })
        .await
        .expect("connection dropped within upgrade timeout + slack");
        assert!(dropped, "silent TCP client must eventually be dropped");
        handle.shutdown.notify_one();
    }

    #[tokio::test]
    async fn ws_connection_limit_rejects_then_releases_slots() {
        let (handle, _state) = bind_test_server().await;
        let url = format!("ws://{}/", handle.local_addr);

        // Fill every slot with an upgraded client that stays silent after
        // connecting (each sits in the 5s first-frame wait, holding its
        // slot). Opened concurrently so the whole batch upgrades well
        // within that first-frame window.
        let mut held = Vec::new();
        let mut pending = Vec::new();
        for _ in 0..MAX_LOCAL_WS_CONNECTIONS {
            pending.push(tokio_tungstenite::connect_async(extension_origin_request(
                &url,
            )));
        }
        for result in futures_util::future::join_all(pending).await {
            let (ws, _resp) = result.expect("upgraded within the connection cap");
            held.push(ws);
        }

        // The next connection must be closed by the daemon right away.
        let mut rejected = tokio::net::TcpStream::connect(handle.local_addr)
            .await
            .expect("tcp connected");
        let mut buf = [0u8; 64];
        let rejected_closed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match tokio::io::AsyncReadExt::read(&mut rejected, &mut buf).await {
                    Ok(0) => break true,
                    Ok(_) => continue,
                    Err(_) => break true,
                }
            }
        })
        .await
        .expect("over-cap connection closed promptly");
        assert!(
            rejected_closed,
            "connection beyond the cap must be rejected"
        );

        // Release every slot; a fresh client must get in again.
        for mut ws in held {
            ws.close(None).await.ok();
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match tokio_tungstenite::connect_async(extension_origin_request(&url)).await {
                    Ok(_) => break,
                    Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                }
            }
        })
        .await
        .expect("slot released after clients closed");
        handle.shutdown.notify_one();
    }
}
