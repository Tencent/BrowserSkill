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
use bsk_protocol::system::{HandshakeCompat, HandshakeResult, evaluate_handshake_compat};
use bsk_protocol::tools::ReturnFailure;
use bsk_protocol::{Frame, RequestFrame, ResponseBody, ResponseFrame, RpcError};
use futures_util::{SinkExt, StreamExt};
use semver::Version;
use tokio::net::{TcpListener, TcpStream};
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
use super::state::{
    DaemonState, LEGACY_MIN_COMPATIBLE_PEER, MIN_COMPATIBLE_PROTOCOL, PROTOCOL_VERSION, SERVER_NAME,
};

/// Origin is a filtering layer; local identity is established by HMAC below.
pub(super) fn origin_allowed(origin: &str) -> bool {
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
        if self.state.config.server.is_some() {
            return super::remote::bind(self.state, addr).await;
        }
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
    let connections = Arc::new(Semaphore::new(MAX_LOCAL_WS_CONNECTIONS));
    loop {
        tokio::select! {
            _ = shutdown.notified() => {
                debug!("ws server shutdown signal received");
                break;
            }
            accept = listener.accept() => {
                match accept {
                    Ok((stream, peer)) => {
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
                        tokio::spawn(async move {
                            let _permit = permit;
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

/// Upper bound on plain-HTTP request headers for the `GET /pair` fallback
/// landing page (`RM-09`). Fragment secrets (`#bsk-local.v1...`) are never
/// transmitted by browsers over HTTP.
const PAIR_HTTP_HEADER_CAP: usize = 4096;

const PAIR_LANDING_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BrowserSkill — Extension Required</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f8fafc;
      --card: #ffffff;
      --border: #e2e8f0;
      --text: #0f172a;
      --muted: #475569;
      --accent: #ea580c;
      --accent-fg: #ffffff;
      --secondary-bg: #f1f5f9;
      --code-bg: #f1f5f9;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #090d16;
        --card: #111827;
        --border: #1f2937;
        --text: #f8fafc;
        --muted: #94a3b8;
        --accent: #f97316;
        --accent-fg: #0f172a;
        --secondary-bg: #1e293b;
        --code-bg: #1e293b;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.55;
    }
    main {
      width: 100%;
      max-width: 560px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 28px;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
    }
    .badge {
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 999px;
      background: var(--secondary-bg);
      color: var(--accent);
      margin-bottom: 12px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 20px;
      line-height: 1.35;
    }
    .subtitle {
      margin: 0 0 18px;
      font-size: 14px;
      color: var(--muted);
    }
    p {
      margin: 0 0 14px;
      font-size: 14px;
      color: var(--muted);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 20px 0;
    }
    a.btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 16px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
    }
    a.btn-primary {
      background: var(--accent);
      color: var(--accent-fg);
    }
    a.btn-secondary {
      background: var(--secondary-bg);
      color: var(--text);
      border: 1px solid var(--border);
    }
    .steps {
      margin: 18px 0 0;
      padding: 14px 16px;
      border-radius: 12px;
      background: var(--secondary-bg);
      font-size: 13px;
      color: var(--muted);
    }
    .steps ol {
      margin: 8px 0 0;
      padding-left: 20px;
    }
    .steps li { margin-bottom: 6px; }
    code {
      padding: 2px 6px;
      border-radius: 6px;
      background: var(--code-bg);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <main>
    <span class="badge">BrowserSkill Setup</span>
    <h1>Active BrowserSkill extension not detected</h1>
    <p class="subtitle">未在当前浏览器检测到启用的 BrowserSkill 扩展</p>
    <p>
      When the BrowserSkill extension is installed and enabled in this browser profile, this page automatically opens the extension's trusted confirmation screen.
    </p>
    <p>
      安装并启用新版 BrowserSkill 扩展后，访问此页面会自动跳转至扩展内置的一键配对确认页。若停留在当前页面，说明当前浏览器配置尚未安装、未启用或需更新扩展。
    </p>
    <div class="actions">
      <a class="btn btn-primary" href="https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi" target="_blank" rel="noopener noreferrer">Chrome Web Store</a>
      <a class="btn btn-secondary" href="https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg" target="_blank" rel="noopener noreferrer">Edge Add-ons</a>
    </div>
    <div class="steps">
      <strong>Next steps / 下一步：</strong>
      <ol>
        <li>Install or enable the BrowserSkill extension in your target browser profile.<br />在目标浏览器 Profile 中安装并启用 BrowserSkill 扩展。</li>
        <li>Re-run <code>bsk setup</code> in your terminal, or paste the backup <code>ws://127.0.0.1:…</code> pairing link from your terminal into the extension's Connection Settings.<br />回到终端重新运行 <code>bsk setup</code>，或在扩展「连接设置」中粘贴终端打印的备用 <code>ws://127.0.0.1:…</code> 配对链接。</li>
      </ol>
    </div>
  </main>
</body>
</html>
"#;

fn might_be_pair_get_prefix(bytes: &[u8]) -> bool {
    const P_SPACE: &[u8] = b"GET /pair ";
    const P_QUERY: &[u8] = b"GET /pair?";
    if bytes.len() < P_SPACE.len() {
        P_SPACE.starts_with(bytes) || P_QUERY.starts_with(bytes)
    } else {
        bytes.starts_with(P_SPACE) || bytes.starts_with(P_QUERY)
    }
}

fn find_double_crlf(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn is_plain_pair_get_request(header_bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(header_bytes) else {
        return false;
    };
    let mut lines = text.split("\r\n");
    let Some(request_line) = lines.next() else {
        return false;
    };
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if method != "GET" || !version.starts_with("HTTP/1.") {
        return false;
    }
    if target != "/pair" && !target.starts_with("/pair?") {
        return false;
    }
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.trim().eq_ignore_ascii_case("upgrade")
            && value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("websocket"))
        {
            return false;
        }
    }
    true
}

fn has_websocket_upgrade_header(header_prefix: &[u8]) -> bool {
    let text = String::from_utf8_lossy(header_prefix);
    text.split("\r\n").skip(1).any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.trim().eq_ignore_ascii_case("upgrade")
                && value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("websocket"))
        })
    })
}

/// Inspect the initial bytes on a local loopback TCP socket without consuming
/// WebSocket upgrades. Returns `Ok(true)` when the connection was handled (or
/// timed out / closed cleanly) and `Ok(false)` when normal WebSocket upgrade
/// handling should proceed with zero bytes consumed.
async fn maybe_serve_pair_landing_page(
    stream: &mut TcpStream,
    peer: SocketAddr,
    deadline: tokio::time::Instant,
) -> anyhow::Result<bool> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buf = [0u8; PAIR_HTTP_HEADER_CAP];
    let mut last_len = 0usize;

    loop {
        let peeked = match tokio::time::timeout_at(deadline, stream.peek(&mut buf)).await {
            Ok(Ok(n)) => n,
            Ok(Err(err)) => return Err(err.into()),
            Err(_) => {
                debug!(
                    ?peer,
                    timeout_secs = WS_UPGRADE_TIMEOUT.as_secs(),
                    "ws upgrade timed out; dropping connection"
                );
                return Ok(true);
            }
        };
        if peeked == 0 {
            return Ok(true);
        }
        if !might_be_pair_get_prefix(&buf[..peeked]) {
            return Ok(false);
        }
        if let Some(pos) = find_double_crlf(&buf[..peeked]) {
            let header_len = pos + 4;
            if !is_plain_pair_get_request(&buf[..header_len]) {
                return Ok(false);
            }
            tokio::time::timeout_at(deadline, stream.read_exact(&mut buf[..header_len])).await??;
            let body = PAIR_LANDING_HTML.as_bytes();
            let headers = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: text/html; charset=utf-8\r\n\
                 Cache-Control: no-store\r\n\
                 X-Frame-Options: DENY\r\n\
                 Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
                 Content-Length: {}\r\n\
                 Connection: close\r\n\r\n",
                body.len()
            );
            tokio::time::timeout_at(deadline, async {
                stream.write_all(headers.as_bytes()).await?;
                stream.write_all(body).await?;
                stream.shutdown().await
            })
            .await??;
            return Ok(true);
        }
        if peeked == PAIR_HTTP_HEADER_CAP {
            if has_websocket_upgrade_header(&buf[..peeked]) {
                return Ok(false);
            }
            tokio::time::timeout_at(deadline, stream.read_exact(&mut buf)).await??;
            let resp = b"HTTP/1.1 431 Request Header Fields Too Large\r\n\
                         Cache-Control: no-store\r\n\
                         X-Frame-Options: DENY\r\n\
                         Content-Security-Policy: default-src 'none'\r\n\
                         Content-Length: 0\r\n\
                         Connection: close\r\n\r\n";
            let _ = tokio::time::timeout_at(deadline, async {
                stream.write_all(resp).await?;
                stream.shutdown().await
            })
            .await;
            // Drain a bounded tail briefly so loopback TCP stacks do not send RST
            // before the peer reads the 431 status line.
            let _ = tokio::time::timeout(Duration::from_millis(50), async {
                let mut discard = [0u8; 1024];
                for _ in 0..8 {
                    if matches!(stream.read(&mut discard).await, Ok(0) | Err(_)) {
                        break;
                    }
                }
            })
            .await;
            return Ok(true);
        }
        if peeked == last_len
            && tokio::time::timeout_at(deadline, tokio::time::sleep(Duration::from_millis(5)))
                .await
                .is_err()
        {
            debug!(
                ?peer,
                timeout_secs = WS_UPGRADE_TIMEOUT.as_secs(),
                "ws upgrade timed out; dropping connection"
            );
            return Ok(true);
        }
        last_len = peeked;
    }
}

async fn handle_connection(
    state: Arc<DaemonState>,
    mut stream: TcpStream,
    peer: SocketAddr,
) -> anyhow::Result<()> {
    let upgrade_deadline = tokio::time::Instant::now() + WS_UPGRADE_TIMEOUT;
    if maybe_serve_pair_landing_page(&mut stream, peer, upgrade_deadline).await? {
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
    let mut ws = match tokio::time::timeout_at(
        upgrade_deadline,
        tokio_tungstenite::accept_hdr_async(stream, callback),
    )
    .await
    {
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
    };
    let origin = captured_origin.lock().unwrap().clone().unwrap_or_default();
    let authentication = tokio::time::timeout(
        HANDSHAKE_FIRST_FRAME_TIMEOUT,
        super::local_auth::handshake::accept(state.clone(), &mut ws, &origin),
    )
    .await;
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
    drive_connection(state, ws, authorization, first).await
}

/// Hard cap on how long the daemon will wait for a freshly-upgraded
/// WebSocket client to send its first frame (which MUST be
/// `system.handshake` per §4.2). Without this, a passing-Origin client
/// that completes the WS upgrade but never speaks pins a tokio task +
/// socket FD indefinitely (review M4/M5 round 3 I-R3-1).
const HANDSHAKE_FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) async fn drive_connection<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    state: Arc<DaemonState>,
    ws: WebSocketStream<S>,
    mut authorization: PeerAuthorization,
    first_message: Option<Message>,
) -> anyhow::Result<()> {
    let (mut writer, mut reader) = ws.split();

    // The first frame MUST be `system.handshake` per §4.2. Bound the
    // wait so a stalled client cannot park resources forever.
    let first = if let Some(message) = first_message {
        Ok(Some(Ok(message)))
    } else {
        tokio::select! {
            first = tokio::time::timeout(HANDSHAKE_FIRST_FRAME_TIMEOUT, reader.next()) => first,
            _ = authorization.revoked() => return Err(anyhow!("device authorization ended before handshake")),
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
    let registration = authorization.registration_guard().await;
    if !authorization.bind_instance(&params.instance_id) || !authorization.authorized().await {
        return Err(anyhow!(
            "device authorization ended or browser identity mismatch"
        ));
    }
    let browser_id = BrowserId(authorization.browser_id(&params.instance_id).to_owned());
    // A fresh socket represents a fresh extension control plane. The
    // extension tears down its local sessions before reconnecting, so any
    // daemon-side sessions left under the same instance id are stale. Purge
    // them before replacing the browser registration; otherwise an old WS
    // cleanup racing with this handshake can preserve rows that no longer
    // have an Agent Window on the extension side.
    state.purge_sessions_of_browser(
        &browser_id,
        crate::rpc_reason::BROWSER_DISCONNECTED,
        "purged stale session before browser reconnect",
    );
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
    // Restore opt-in before making the browser available to CLI callers.
    let audit_ready = state.audit.configure(&browser_id.0, audit_enabled).is_ok();
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
        min_compatible_peer: Some(legacy_min_peer),
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
    // Pump loop: outbound frames from sink → ws; inbound from ws → resolve.
    let pump_state = Arc::clone(&state);
    let pump_browser = Arc::clone(&client);
    let pump = async {
        writer
            .send(Message::Text(serde_json::to_string(&resp)?))
            .await?;
        loop {
            tokio::select! {
                outbound = rx.recv() => {
                    if !authorization.active() { break; }
                    match outbound {
                        Some(frame) => {
                            let json = serde_json::to_string(&frame)?;
                            writer.send(Message::Text(json)).await?;
                        }
                        None => break,
                    }
                }
                msg = reader.next() => {
                    if !authorization.active() { break; }
                    match msg {
                        Some(Ok(Message::Text(t))) => {
                            if serde_json::from_str::<serde_json::Value>(&t).ok()
                                .and_then(|value|value.get("type").and_then(|v|v.as_str()).map(|s|s.starts_with("local.auth."))).unwrap_or(false) {
                                break;
                            }
                            // Any inbound frame — tool response, event, or the
                            // ~20s heartbeat — counts as proof of life.
                            pump_browser.touch();
                            handle_inbound_text(&pump_state, &pump_browser, &t).await;
                        }
                        Some(Ok(Message::Binary(_))) => {
                            warn!("ignoring binary message");
                        }
                        Some(Ok(Message::Ping(p))) => {
                            pump_browser.touch();
                            let _ = writer.send(Message::Pong(p)).await;
                        }
                        Some(Ok(Message::Pong(_))) => {
                            pump_browser.touch();
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
    // Revocation must also interrupt a blocked socket write or slow inbound
    // handler, not just an idle iteration of the message pump.
    let (result_outcome, revoked): (anyhow::Result<()>, bool) = tokio::select! {
        result = pump => (result, false),
        _ = authorization.revoked() => (Ok(()), true),
    };
    if revoked {
        let _ =
            tokio::time::timeout(Duration::from_secs(1), writer.send(Message::Close(None))).await;
    }
    // Responses for this socket can only arrive on it, so calls still
    // waiting here would otherwise sit until their own deadline.
    client
        .pending
        .lock()
        .expect("browser pending poisoned")
        .close();

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
            crate::rpc_reason::BROWSER_DISCONNECTED,
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
            bsk_protocol::EventKind::AuditContext => state.audit.context(&client.id.0, &ev.payload),
            bsk_protocol::EventKind::DialogChanged => {
                if let Some(sid) = ev.payload["session_id"].as_str()
                    && state
                        .sessions
                        .get(&super::sessions::SessionId(sid.into()))
                        .is_some_and(|s| s.browser_id == client.id)
                {
                    state.dialog_operations.dialog_changed(&ev.payload);
                    if let Some(id) = ev.payload["operation_id"].as_str()
                        && let Some(operation) = state.dialog_operations.get(sid, id)
                        && let Some(inflight) = state.tool_inflight.get(&operation.cli_rpc_id)
                    {
                        inflight
                            .dialog_pending
                            .send_replace(ev.payload["dialog"].is_object());
                    }
                }
            }
            bsk_protocol::EventKind::SystemHeartbeat => {
                // `touch()` already ran for this frame in the read loop;
                // additionally opt this browser in to liveness reaping now
                // that we know it speaks the heartbeat.
                client.mark_heartbeat_seen();
                debug!(id = %client.id, "heartbeat");
            }
            bsk_protocol::EventKind::SessionActivity => {
                #[derive(serde::Deserialize)]
                struct Activity {
                    session_id: String,
                    idle_protected: bool,
                }
                if let Ok(activity) = serde_json::from_value::<Activity>(ev.payload) {
                    state.sessions.update_activity(
                        &super::sessions::SessionId(activity.session_id),
                        &client.id,
                        activity.idle_protected,
                    );
                }
            }
            bsk_protocol::EventKind::SessionInteractionChanged => {
                #[derive(serde::Deserialize)]
                struct Change {
                    session_id: String,
                    interaction: bsk_protocol::tools::InteractionPolicy,
                }
                if let Ok(change) = serde_json::from_value::<Change>(ev.payload) {
                    state.sessions.update_interaction(
                        &super::sessions::SessionId(change.session_id),
                        &client.id,
                        change.interaction,
                    );
                }
            }
            bsk_protocol::EventKind::SessionWindowClosed => {
                handle_session_window_closed(state, &client.id, &ev.payload);
            }
            bsk_protocol::EventKind::SessionEnded => {
                handle_session_ended(state, &client.id, &ev.payload);
            }
            bsk_protocol::EventKind::SessionUserInterrupt => {
                handle_session_user_interrupt(state, &client.id, &ev.payload);
            }
            other => {
                debug!(event = ?other, "event received (no handler yet)");
            }
        },
        Frame::Request(req) => {
            let body = if req.method == bsk_protocol::Method::AuditRequest {
                handle_audit_request(state, &client.id.0, req.params.unwrap_or_default())
            } else {
                ResponseBody::Err(RpcError {
                    code: bsk_protocol::ErrorCode::UnknownMethod,
                    message: "Unsupported extension request".into(),
                    data: None,
                })
            };
            let _ = client
                .sink
                .send(Frame::Response(ResponseFrame { id: req.id, body }));
        }
    }
}

fn handle_audit_request(
    state: &DaemonState,
    browser: &str,
    params: serde_json::Value,
) -> ResponseBody {
    let action = params
        .get("action")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let id = params
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let offset = params
        .get("offset")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
        .min(1_000_000) as usize;
    let limit = params
        .get("limit")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(100)
        .min(500) as usize;
    let result = match action {
        "configure" => match params.get("enabled").and_then(serde_json::Value::as_bool) {
            Some(enabled) => state.audit.configure(browser, enabled),
            None => Err(anyhow!("Missing enabled preference")),
        },
        "list" => state.audit.list(browser, offset, limit),
        "get" => state.audit.get(browser, id, offset, limit),
        "delete" => state.audit.delete(browser, id),
        "open_directory" => open_audit_directory(&state.audit),
        _ => Err(anyhow!("Unknown audit action")),
    };
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
    if forget_browser_session(state, &session_id, crate::rpc_reason::SESSION_WINDOW_CLOSED) {
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

/// Logical termination is independent of whether the browser window stays open.
fn forget_browser_session(
    state: &Arc<DaemonState>,
    session_id: &super::sessions::SessionId,
    reason: &'static str,
) -> bool {
    let removed = super::sessions::forget_session(
        &state.sessions,
        &state.tool_queues,
        &state.session_interrupts,
        session_id,
        Some(reason),
    );
    if removed {
        state.transfers.release_session(&session_id.0);
        state.dialog_operations.remove_session(&session_id.0);
    }
    removed
}

fn handle_session_ended(state: &Arc<DaemonState>, sender: &BrowserId, payload: &serde_json::Value) {
    #[derive(serde::Deserialize)]
    struct Ended {
        session_id: String,
        reason: String,
        tab_id: u64,
    }
    let Ok(ended) = serde_json::from_value::<Ended>(payload.clone()) else {
        warn!("invalid session.ended payload");
        return;
    };
    if ended.session_id.is_empty()
        || ended.reason != crate::rpc_reason::SESSION_USER_MOVED_TAB
        || ended.tab_id == 0
    {
        warn!("invalid session.ended reason or resource identity");
        return;
    }
    let sid = super::sessions::SessionId(ended.session_id);
    let Some(session) = state.sessions.get(&sid) else {
        // Duplicates and late events must not cancel work for an unverified id.
        debug!(session = %sid, "session.ended for unknown session id");
        return;
    };
    if session.browser_id != *sender {
        warn!(session = %sid, %sender, "ignoring session.ended from a browser that does not own this session");
        return;
    }

    // Record the terminal cause on queued and forwarded calls before dropping
    // the queue. This is not the resumable, one-shot user-interrupt marker.
    cancel_session_tools(state, &sid, super::inflight::CancelReason::UserMovedTab);
    if forget_browser_session(state, &sid, crate::rpc_reason::SESSION_USER_MOVED_TAB) {
        info!(session = %sid, tab_id = ended.tab_id, "session ended: user moved a controlled tab");
    }
}

fn cancel_session_tools(
    state: &Arc<DaemonState>,
    sid: &super::sessions::SessionId,
    reason: super::inflight::CancelReason,
) {
    let snapshots = state.tool_inflight.cancel_session_with_reason(sid, reason);
    for snap in snapshots {
        if let (Some(browser_id), Some(ws_rpc_id)) = (snap.browser_id, snap.ws_rpc_id)
            && let Err(err) =
                super::cancel_forward::forward_cancel_to_browser(state, &browser_id, &ws_rpc_id)
        {
            warn!(%browser_id, %ws_rpc_id, %err, "failed to forward session cancellation to extension");
        }
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

    state.audit.marker(&sid.0, "user_interrupt");
    state.session_interrupts.mark(&sid);
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

    fn user_moved_tab_payload(sid: &SessionId) -> serde_json::Value {
        serde_json::json!({ "session_id": sid.0, "reason": "user_moved_tab", "tab_id": 42 })
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
        assert_eq!(ended.reason, crate::rpc_reason::SESSION_USER_MOVED_TAB);

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
            crate::rpc_reason::SESSION_USER_MOVED_TAB
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
            crate::rpc_reason::SESSION_USER_MOVED_TAB
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
        for payload in [
            serde_json::json!({ "session_id": sid.0, "reason": "unknown", "tab_id": 42 }),
            serde_json::json!({ "session_id": sid.0, "reason": "user_moved_tab", "tab_id": 0 }),
            serde_json::json!({ "session_id": sid.0, "reason": "user_moved_tab" }),
        ] {
            handle_session_ended(&state, &owner, &payload);
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

#[cfg(test)]
mod pair_landing_page_tests {
    use super::*;
    use crate::daemon::start::DaemonConfig;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::header::{HeaderName, HeaderValue};

    async fn bind_test_server() -> WsHandle {
        let state = std::sync::Arc::new(DaemonState::new(DaemonConfig::new(0)));
        WsServer::new(state)
            .bind("127.0.0.1:0".parse().expect("loopback addr"))
            .await
            .expect("bound test ws server")
    }

    #[tokio::test]
    async fn pair_landing_page_serves_strict_csp_static_html_for_get_pair_and_query() {
        let handle = bind_test_server().await;

        for path in ["/pair", "/pair?from=cli"] {
            let mut conn = tokio::net::TcpStream::connect(handle.local_addr)
                .await
                .expect("tcp connect");
            // Split across two writes to exercise partial TCP peek handling.
            conn.write_all(b"GET /pa").await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
            let rest = format!(
                "{} HTTP/1.1\r\nHost: {}\r\nAccept: text/html\r\n\r\n",
                &path[3..],
                handle.local_addr
            );
            conn.write_all(rest.as_bytes()).await.unwrap();

            let mut raw = Vec::new();
            conn.read_to_end(&mut raw).await.unwrap();
            let text = String::from_utf8(raw).expect("utf-8 html response");
            let (head, body) = text.split_once("\r\n\r\n").expect("http header/body split");
            assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "head was: {head}");
            let lower_head = head.to_ascii_lowercase();
            assert!(lower_head.contains("content-type: text/html; charset=utf-8"));
            assert!(lower_head.contains("cache-control: no-store"));
            assert!(lower_head.contains("x-frame-options: deny"));
            assert!(lower_head.contains(
                "content-security-policy: default-src 'none'; style-src 'unsafe-inline'"
            ));
            assert!(
                !body.to_ascii_lowercase().contains("<script"),
                "fallback HTML must never embed JavaScript"
            );
            assert!(
                body.contains("chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi")
            );
            assert!(body.contains("microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg"));
            assert!(body.contains("bsk setup"));
        }

        handle.shutdown.notify_one();
    }

    #[tokio::test]
    async fn pair_landing_page_preserves_websocket_upgrades_and_rejects_oversized_headers() {
        let handle = bind_test_server().await;

        for ws_path in ["/", "/pair"] {
            let url = format!("ws://{}{ws_path}", handle.local_addr);
            let mut req = url.into_client_request().unwrap();
            req.headers_mut().insert(
                HeaderName::from_static("origin"),
                HeaderValue::from_static("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaap"),
            );
            let (mut ws, resp) = tokio_tungstenite::connect_async(req)
                .await
                .expect("ws upgrade should still succeed");
            assert_eq!(
                resp.headers()
                    .get("x-bsk-server")
                    .and_then(|v| v.to_str().ok()),
                Some("browser-skill-daemon")
            );
            let _ = ws.close(None).await;
        }

        // Plain GET / (not /pair) must not return the 200 landing page.
        let mut root_http = tokio::net::TcpStream::connect(handle.local_addr)
            .await
            .unwrap();
        root_http
            .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut root_resp = Vec::new();
        root_http.read_to_end(&mut root_resp).await.unwrap();
        let root_text = String::from_utf8_lossy(&root_resp);
        assert!(!root_text.starts_with("HTTP/1.1 200 OK"));

        // Oversized (> 4 KiB) headers on GET /pair return 431 cleanly.
        let mut huge = tokio::net::TcpStream::connect(handle.local_addr)
            .await
            .unwrap();
        let filler = "a".repeat(PAIR_HTTP_HEADER_CAP);
        let req = format!("GET /pair HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Pad: {filler}\r\n\r\n");
        let _ = huge.write_all(req.as_bytes()).await;
        let mut huge_resp = Vec::new();
        huge.read_to_end(&mut huge_resp).await.unwrap();
        let huge_text = String::from_utf8_lossy(&huge_resp);
        assert!(
            huge_text.starts_with("HTTP/1.1 431 "),
            "unexpected oversized response: {huge_text}"
        );

        handle.shutdown.notify_one();
    }
}
