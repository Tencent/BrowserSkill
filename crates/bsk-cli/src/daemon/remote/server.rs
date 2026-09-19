use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    Request, Response, StatusCode, body::Incoming, server::conn::http1, service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, watch};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        self,
        pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
    },
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{handshake::server::create_response, protocol::Role},
};
use tracing::warn;

use super::authorization::{AuthorizationRequest, AuthorizationStore, AuthorizedDevice};
use super::rate_limit::AuthorizationRateLimit;
use crate::daemon::{
    DaemonState, paths,
    ws::{WsHandle, drive_connection, origin_allowed},
};

type Body = Full<Bytes>;

struct Gateway {
    state: Arc<DaemonState>,
    stopped: AtomicBool,
    store: AuthorizationStore,
    path: String,
    authorize_path: String,
    active: Mutex<HashMap<String, ActiveConnection>>,
    connections: Arc<Semaphore>,
    attempts: Mutex<AuthorizationRateLimit>,
    capacity_warning: Mutex<Option<Instant>>,
}

struct ActiveConnection {
    cancel: watch::Sender<bool>,
    slot: Arc<OwnedSemaphorePermit>,
}

pub(crate) struct ConnectionAuthorization {
    pub device: AuthorizedDevice,
    gateway: Arc<Gateway>,
    cancelled: watch::Receiver<bool>,
}

impl ConnectionAuthorization {
    pub fn active(&self) -> bool {
        !self.gateway.stopped.load(Ordering::Acquire) && !*self.cancelled.borrow()
    }

    pub async fn authorized(&self) -> bool {
        if !self.active() {
            return false;
        }
        let store = self.gateway.store.clone();
        let device_id = self.device.device_id.clone();
        tokio::task::spawn_blocking(move || store.is_authorized(&device_id))
            .await
            .unwrap_or(false)
            && self.active()
    }

    pub async fn revoked(&self) {
        let mut cancelled = self.cancelled.clone();
        let mut timer = tokio::time::interval(Duration::from_secs(1));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            if !self.active() {
                return;
            }
            tokio::select! {
                _ = cancelled.changed() => return,
                _ = timer.tick() => {
                    tokio::select! {
                        _ = cancelled.changed() => return,
                        allowed = self.authorized() => if !allowed { return; },
                    }
                },
            }
        }
    }
}

impl Drop for ConnectionAuthorization {
    fn drop(&mut self) {
        let mut active = self.gateway.active.lock().unwrap();
        if active
            .get(&self.device.device_id)
            .is_some_and(|entry| entry.cancel.receiver_count() == 1 && !*entry.cancel.borrow())
        {
            // The current receiver still belongs to this connection. A replaced
            // connection has already been cancelled and must not remove its successor.
            if !*self.cancelled.borrow() {
                active.remove(&self.device.device_id);
            }
        }
    }
}

pub async fn bind(state: Arc<DaemonState>, addr: SocketAddr) -> Result<WsHandle> {
    let config = state
        .config
        .server
        .as_ref()
        .context("server mode required")?;
    config.validate()?;
    let tls = if let (Some(cert), Some(key)) = (&config.tls_cert, &config.tls_key) {
        let certificates: Vec<_> =
            CertificateDer::pem_file_iter(cert)?.collect::<std::result::Result<_, _>>()?;
        let key = PrivateKeyDer::from_pem_file(key)?;
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let mut tls_config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_single_cert(certificates, key)?;
        tls_config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Some(TlsAcceptor::from(Arc::new(tls_config)))
    } else {
        None
    };
    let url = super::validate_endpoint(&config.public_url)?;
    let listener = TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;
    let store = AuthorizationStore::at_home(&paths::bsk_home()?);
    let configure_store = store.clone();
    let configure = config.clone();
    tokio::task::spawn_blocking(move || configure_store.configure(&configure)).await??;
    let connections = Arc::new(Semaphore::new(config.max_connections));
    let attempts = Mutex::new(AuthorizationRateLimit::new(config.authorize_rate_limit));
    let gateway = Arc::new(Gateway {
        store,
        path: url.path().to_owned(),
        authorize_path: format!(
            "{}/authorize",
            url.path().strip_suffix('/').unwrap_or(url.path())
        ),
        state,
        stopped: AtomicBool::new(false),
        active: Mutex::new(HashMap::new()),
        connections,
        attempts,
        capacity_warning: Mutex::new(None),
    });
    let shutdown = Arc::new(Notify::new());
    let stop = shutdown.clone();
    let task = tokio::spawn(async move {
        let limit = Arc::new(Semaphore::new(64));
        let mut last_capacity_warning: Option<Instant> = None;
        loop {
            tokio::select! {
                _ = stop.notified() => break,
                incoming = listener.accept() => {
                    let Ok((stream, peer)) = incoming else { break; };
                    let Ok(permit) = limit.clone().try_acquire_owned() else {
                        if last_capacity_warning.is_none_or(|last| last.elapsed() >= Duration::from_secs(60)) {
                            warn!("remote HTTP connection capacity reached; dropping new connections");
                            last_capacity_warning = Some(Instant::now());
                        }
                        continue;
                    };
                    let gateway = gateway.clone();
                    let tls = tls.clone();
                    tokio::spawn(async move {
                        if let Some(tls) = tls {
                            if let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(5), tls.accept(stream)).await {
                                serve(stream, gateway, peer.ip(), permit).await;
                            }
                        } else { serve(stream, gateway, peer.ip(), permit).await; }
                    });
                }
            }
        }
        gateway.stopped.store(true, Ordering::Release);
        for (_, entry) in gateway.active.lock().unwrap().drain() {
            let _ = entry.cancel.send(true);
        }
    });
    Ok(WsHandle {
        local_addr,
        shutdown,
        task,
    })
}

async fn serve<T: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    stream: T,
    gateway: Arc<Gateway>,
    peer: IpAddr,
    setup_permit: OwnedSemaphorePermit,
) {
    let setup_permit = Arc::new(setup_permit);
    let service =
        service_fn(move |request| handle(request, gateway.clone(), peer, setup_permit.clone()));
    // Header, body, connection and authorization-rate limits apply before a
    // caller can retain a browser connection or perform durable grant writes.
    let _ = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(Duration::from_secs(5))
        .max_buf_size(16 * 1024)
        .keep_alive(true)
        .serve_connection(TokioIo::new(stream), service)
        .with_upgrades()
        .await;
}

fn response(status: StatusCode, value: serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        // Short HTTP requests must not retain the pre-authentication capacity.
        // Upgrade responses are constructed separately and keep their headers.
        .header("connection", "close")
        .body(Full::new(Bytes::from(value.to_string())))
        .unwrap()
}

fn denied() -> Response<Body> {
    response(
        StatusCode::UNAUTHORIZED,
        serde_json::json!({"error": "invalid_authorization"}),
    )
}

fn retry_response(status: StatusCode, error: &'static str, seconds: u32) -> Response<Body> {
    let mut result = response(status, serde_json::json!({"error": error}));
    result
        .headers_mut()
        .insert("retry-after", seconds.to_string().parse().unwrap());
    result
}

fn one_header<'a>(request: &'a Request<Incoming>, name: &str) -> Option<&'a str> {
    let mut values = request.headers().get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}

async fn handle(
    mut request: Request<Incoming>,
    gateway: Arc<Gateway>,
    peer: IpAddr,
    setup_permit: Arc<OwnedSemaphorePermit>,
) -> std::result::Result<Response<Body>, Infallible> {
    if gateway.stopped.load(Ordering::Acquire) {
        return Ok(denied());
    }
    if request.uri().query().is_some() {
        return Ok(denied());
    }
    if request.method() == hyper::Method::POST && request.uri().path() == gateway.authorize_path {
        let allowed = gateway.attempts.lock().unwrap().allow(peer, Instant::now());
        if !allowed {
            return Ok(retry_response(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                60,
            ));
        }
        let Some(credential) = one_header(&request, "authorization")
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| super::authorization::valid_token(value))
            .map(str::to_owned)
        else {
            return Ok(denied());
        };
        let body = tokio::time::timeout(
            Duration::from_secs(5),
            Limited::new(request.into_body(), 4096).collect(),
        )
        .await;
        let Ok(Ok(body)) = body else {
            return Ok(response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({"error": "invalid_request"}),
            ));
        };
        let Ok(parameters) = serde_json::from_slice::<AuthorizationRequest>(&body.to_bytes())
        else {
            return Ok(response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({"error": "invalid_request"}),
            ));
        };
        let store = gateway.store.clone();
        return Ok(
            match tokio::task::spawn_blocking(move || store.exchange(&credential, parameters)).await
            {
                Ok(Ok(grant)) => response(StatusCode::OK, serde_json::to_value(grant).unwrap()),
                Ok(Err(error))
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock) =>
                {
                    retry_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "authorization_store_busy",
                        1,
                    )
                }
                _ => denied(),
            },
        );
    }
    if request.method() != hyper::Method::GET || request.uri().path() != gateway.path {
        return Ok(response(
            StatusCode::NOT_FOUND,
            serde_json::json!({"error": "not_found"}),
        ));
    }
    if !one_header(&request, "origin").is_some_and(|origin| origin_allowed(origin, false)) {
        return Ok(denied());
    }
    let Some(protocol) = one_header(&request, "sec-websocket-protocol").map(str::to_owned) else {
        return Ok(denied());
    };
    let Some(credential) = protocol.strip_prefix("bsk-auth.") else {
        return Ok(denied());
    };
    let store = gateway.store.clone();
    let credential = credential.to_owned();
    let Ok(Ok(device)) = tokio::task::spawn_blocking(move || store.authenticate(&credential)).await
    else {
        return Ok(denied());
    };
    // Replacement sockets reuse their device's slot, including at capacity.
    // The short-lived HTTP permit is released after the upgrade completes.
    let slot = {
        let active = gateway.active.lock().unwrap();
        if let Some(entry) = active.get(&device.device_id) {
            entry.slot.clone()
        } else {
            match gateway.connections.clone().try_acquire_owned() {
                Ok(permit) => Arc::new(permit),
                Err(_) => {
                    let mut last = gateway.capacity_warning.lock().unwrap();
                    if last.is_none_or(|time| time.elapsed() >= Duration::from_secs(60)) {
                        warn!(
                            "remote browser capacity reached; rejecting new devices with HTTP 503"
                        );
                        *last = Some(Instant::now());
                    }
                    return Ok(retry_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "connection_capacity_reached",
                        5,
                    ));
                }
            }
        }
    };
    let mut upgrade_request = Request::new(());
    *upgrade_request.method_mut() = request.method().clone();
    *upgrade_request.version_mut() = request.version();
    *upgrade_request.uri_mut() = request.uri().clone();
    *upgrade_request.headers_mut() = request.headers().clone();
    let Ok(mut upgrade_response) = create_response(&upgrade_request) else {
        return Ok(response(
            StatusCode::BAD_REQUEST,
            serde_json::json!({"error": "invalid_upgrade"}),
        ));
    };
    upgrade_response
        .headers_mut()
        .insert("sec-websocket-protocol", protocol.parse().unwrap());
    let upgrade = hyper::upgrade::on(&mut request);
    tokio::spawn(async move {
        let _slot = slot.clone();
        let Ok(Ok(stream)) = tokio::time::timeout(Duration::from_secs(5), upgrade).await else {
            return;
        };
        let store = gateway.store.clone();
        let device_id = device.device_id.clone();
        if gateway.stopped.load(Ordering::Acquire)
            || !tokio::task::spawn_blocking(move || store.is_authorized(&device_id))
                .await
                .unwrap_or(false)
        {
            return;
        }
        let (cancel, cancelled) = watch::channel(false);
        if let Some(previous) = gateway
            .active
            .lock()
            .unwrap()
            .insert(device.device_id.clone(), ActiveConnection { cancel, slot })
        {
            let _ = previous.cancel.send(true);
        }
        let authorization = ConnectionAuthorization {
            device,
            gateway: gateway.clone(),
            cancelled,
        };
        // Retain setup capacity through the post-upgrade authorization check,
        // then keep only the independent browser slot for the socket lifetime.
        drop(setup_permit);
        let ws = WebSocketStream::from_raw_socket(TokioIo::new(stream), Role::Server, None).await;
        // The native dispatcher supplies session isolation and cancellation.
        // The authenticated device, rather than a self-reported instance ID,
        // supplies the browser identity used by that dispatcher.
        let _ = drive_connection(gateway.state.clone(), ws, Some(authorization)).await;
    });
    Ok(upgrade_response.map(|_| Full::new(Bytes::new())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::remote::ServerConfig;
    use crate::daemon::start::DaemonConfig;
    use http_body_util::BodyExt;

    const EXTENSION_ORIGIN: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn server_config(authorize_rate_limit: u32) -> ServerConfig {
        ServerConfig {
            listen: "127.0.0.1".parse().unwrap(),
            public_url: "wss://127.0.0.1/extension".into(),
            tls_cert: None,
            tls_key: None,
            pairing_ttl: Duration::from_secs(300),
            device_ttl: Duration::from_secs(90 * 86400),
            renew_after: Duration::from_secs(30 * 86400),
            max_connections: 64,
            authorize_rate_limit,
        }
    }

    fn daemon(server: ServerConfig) -> Arc<DaemonState> {
        let mut config = DaemonConfig::new(0);
        config.server = Some(server);
        Arc::new(DaemonState::new(config))
    }

    async fn body_json(response: Response<Body>) -> serde_json::Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn response_sets_json_no_store_headers_and_body() {
        let response = response(StatusCode::OK, serde_json::json!({"ok": true}));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        assert_eq!(response.headers().get("connection").unwrap(), "close");
        assert_eq!(body_json(response).await, serde_json::json!({"ok": true}));
    }

    #[tokio::test]
    async fn denied_returns_401_with_error_body() {
        let response = denied();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/json"
        );
        assert_eq!(
            body_json(response).await,
            serde_json::json!({"error": "invalid_authorization"})
        );
    }

    #[tokio::test]
    async fn retry_response_sets_retry_after() {
        let response = retry_response(StatusCode::TOO_MANY_REQUESTS, "rate_limited", 60);
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers().get("retry-after").unwrap(), "60");
        assert_eq!(
            body_json(response).await,
            serde_json::json!({"error": "rate_limited"})
        );
    }

    #[test]
    fn remote_gateway_rejects_unauthenticated_requests() {
        crate::daemon::test_support::isolated(
            "daemon::remote::server::tests::remote_gateway_rejects_unauthenticated_requests",
            || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(async {
                    let state = daemon(server_config(2));
                    let handle = bind(state, "127.0.0.1:0".parse().unwrap()).await.unwrap();
                    let base = format!("http://{}", handle.local_addr);
                    let client = reqwest::Client::new();

                    // Missing Origin on the browser path fails closed.
                    let res = client
                        .get(format!("{base}/extension"))
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(res.status().as_u16(), 401);

                    // Query strings are rejected outright.
                    let res = client
                        .get(format!("{base}/extension?device=1"))
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(res.status().as_u16(), 401);

                    // Unknown paths and non-browser methods are 404.
                    let res = client.get(format!("{base}/other")).send().await.unwrap();
                    assert_eq!(res.status().as_u16(), 404);
                    let res = client
                        .post(format!("{base}/extension"))
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(res.status().as_u16(), 404);

                    // Missing and malformed credentials are denied.
                    let res = client
                        .post(format!("{base}/extension/authorize"))
                        .body("{}")
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(res.status().as_u16(), 401);
                    let res = client
                        .post(format!("{base}/extension/authorize"))
                        .header("authorization", "Bearer bad token with spaces")
                        .body("{}")
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(res.status().as_u16(), 401);

                    // Non-JSON bodies are rejected with 400.
                    let res = client
                        .post(format!("{base}/extension/authorize"))
                        .header("authorization", format!("Bearer {}", "a".repeat(43)))
                        .body("this is not json")
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(res.status().as_u16(), 400);

                    // The authorize endpoint is rate limited per peer.
                    let res = client
                        .post(format!("{base}/extension/authorize"))
                        .header("authorization", format!("Bearer {}", "a".repeat(43)))
                        .body("{}")
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(res.status().as_u16(), 429);
                    assert_eq!(res.headers().get("retry-after").unwrap(), "60");

                    handle.shutdown.notify_waiters();
                    let _ = handle.task.await;
                });
            },
        );
    }

    #[test]
    fn remote_gateway_pairs_device_over_http() {
        crate::daemon::test_support::isolated(
            "daemon::remote::server::tests::remote_gateway_pairs_device_over_http",
            || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(async {
                    let state = daemon(server_config(60));
                    let handle = bind(state, "127.0.0.1:0".parse().unwrap()).await.unwrap();
                    let base = format!("http://{}", handle.local_addr);
                    let client = reqwest::Client::new();

                    let store = AuthorizationStore::at_home(&paths::bsk_home().unwrap());
                    let link = store.pair().unwrap().rsplit_once('#').unwrap().1.to_owned();
                    let next = "b".repeat(43);
                    let res = client
                        .post(format!("{base}/extension/authorize"))
                        .header("authorization", format!("Bearer {link}"))
                        .header("content-type", "application/json")
                        .body(
                            serde_json::json!({
                                "action": "pair",
                                "next_token": next,
                                "label": "Browser\nlabel"
                            })
                            .to_string(),
                        )
                        .send()
                        .await
                        .unwrap();
                    assert_eq!(res.status().as_u16(), 200);
                    let grant: serde_json::Value =
                        serde_json::from_str(&res.text().await.unwrap()).unwrap();
                    assert_eq!(grant["action"], "pair");
                    assert!(!grant["device_id"].as_str().unwrap().is_empty());
                    assert_eq!(store.devices().unwrap().len(), 1);

                    handle.shutdown.notify_waiters();
                    let _ = handle.task.await;
                });
            },
        );
    }

    #[test]
    fn remote_gateway_upgrades_authorized_device() {
        crate::daemon::test_support::isolated(
            "daemon::remote::server::tests::remote_gateway_upgrades_authorized_device",
            || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(async {
                    let state = daemon(server_config(60));
                    let handle = bind(state, "127.0.0.1:0".parse().unwrap()).await.unwrap();

                    let store = AuthorizationStore::at_home(&paths::bsk_home().unwrap());
                    let credential = "c".repeat(43);
                    store
                        .exchange(
                            &store.pair().unwrap().rsplit_once('#').unwrap().1.to_owned(),
                            AuthorizationRequest {
                                action: "pair".into(),
                                next_token: credential.clone(),
                                label: "Browser\nlabel".into(),
                            },
                        )
                        .unwrap();

                    let request = Request::builder()
                        .uri(format!("ws://{}/extension", handle.local_addr))
                        .header("origin", EXTENSION_ORIGIN)
                        .header("sec-websocket-protocol", format!("bsk-auth.{credential}"))
                        .body(())
                        .unwrap();
                    let tcp = tokio::net::TcpStream::connect(handle.local_addr)
                        .await
                        .unwrap();
                    let (ws, response) =
                        tokio_tungstenite::client_async_with_config(request, tcp, None)
                            .await
                            .unwrap();
                    assert_eq!(response.status().as_u16(), 101);
                    assert_eq!(
                        response.headers().get("sec-websocket-protocol").unwrap(),
                        &format!("bsk-auth.{credential}")
                    );
                    drop(ws);

                    handle.shutdown.notify_waiters();
                    let _ = handle.task.await;
                });
            },
        );
    }
}
