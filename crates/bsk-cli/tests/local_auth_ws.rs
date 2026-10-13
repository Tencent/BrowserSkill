//! Real WebSocket peers exercise the prelude separately from business traffic.
mod support;
use bsk::daemon::{
    self, DaemonConfig,
    local_auth::{LocalAuthMode, store::DeviceStatus},
};
use bsk_protocol::local_auth::*;
use bsk_protocol::{ResponseBody, ResponseFrame};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{Message, client::IntoClientRequest},
};
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
const INSTANCE: &str = "a1b2c3d4";
const ORIGIN: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

#[derive(Clone)]
struct Pairing {
    daemon: Bytes<16>,
    device: Bytes<16>,
    key: Bytes<32>,
    generation: u32,
    pending: Option<(Rotation, Bytes<32>)>,
    role: CredentialRole,
}
impl Pairing {
    fn create(handle: &daemon::DaemonHandle, replace: Option<&str>) -> Self {
        let link = handle
            .state()
            .local_auth
            .store
            .pair(handle.ws_addr().port(), replace)
            .unwrap();
        let parts: Vec<_> = link
            .split("#bsk-local.v1.")
            .nth(1)
            .unwrap()
            .split('.')
            .collect();
        Self {
            daemon: Bytes::decode(parts[0]).unwrap(),
            device: Bytes::decode(parts[1]).unwrap(),
            key: Bytes::decode(parts[2]).unwrap(),
            generation: 0,
            pending: None,
            role: CredentialRole::Staged,
        }
    }
    fn offer(&self) -> Credential {
        Credential {
            role: self.role,
            device_id: self.device,
            r#gen: self.generation,
            pending: self.pending.as_ref().map(|(r, _)| r.clone()),
        }
    }
}
async fn daemon() -> daemon::DaemonHandle {
    daemon::run(
        DaemonConfig::new(0).with_local_auth(LocalAuthMode::Required),
        None,
    )
    .await
    .unwrap()
}
async fn connect(handle: &daemon::DaemonHandle) -> Socket {
    let mut request = format!("ws://{}/", handle.ws_addr())
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Origin", ORIGIN.parse().unwrap());
    tokio_tungstenite::connect_async(request).await.unwrap().0
}
async fn send(socket: &mut Socket, value: impl serde::Serialize) {
    socket
        .send(Message::Text(serde_json::to_string(&value).unwrap()))
        .await
        .unwrap();
}
async fn receive(socket: &mut Socket) -> String {
    tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_text()
        .unwrap()
}
async fn closed(socket: &mut Socket) {
    let result = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap();
    assert!(matches!(
        result,
        None | Some(Ok(Message::Close(_))) | Some(Err(_))
    ));
}
async fn probe(
    socket: &mut Socket,
    offers: Vec<Credential>,
    instance: &str,
) -> (Hello, ChallengeResponse) {
    let hello = Hello {
        v: V1,
        client_nonce: bsk::daemon::local_auth::store::random(),
        instance_id: instance.into(),
        credentials: offers,
    };
    send(
        socket,
        Probe {
            id: "probe".into(),
            method: ProbeMethod::Ping,
            params: ProbeParams {
                local_auth: hello.clone(),
            },
        },
    )
    .await;
    let reply: ResponseFrame = serde_json::from_str(&receive(socket).await).unwrap();
    let ResponseBody::Ok(value) = reply.body else {
        panic!("expected probe response")
    };
    (
        hello,
        serde_json::from_value(value["local_auth"].clone()).unwrap(),
    )
}
fn challenge(hello: &Hello, response: ChallengeResponse, pair: &Pairing) -> (Vec<u8>, Bytes<32>) {
    let ChallengeResponse::Challenge {
        daemon_id,
        device_id,
        r#gen,
        server_nonce,
        server_proof,
    } = response
    else {
        panic!("expected challenge")
    };
    assert_eq!(daemon_id, pair.daemon);
    assert_eq!(device_id, pair.device);
    let key = pair
        .pending
        .as_ref()
        .filter(|(r, _)| r.r#gen == r#gen)
        .map(|(_, key)| *key)
        .unwrap_or(pair.key);
    let t = Transcript {
        daemon_id: &daemon_id,
        device_id: &device_id,
        r#gen,
        instance_id: &hello.instance_id,
        origin: ORIGIN,
        client_nonce: &hello.client_nonce,
        server_nonce: &server_nonce,
    }
    .encode();
    assert!(verify(&key, Purpose::Server, &t, None, &server_proof));
    (t, key)
}
async fn proved(
    socket: &mut Socket,
    pair: &Pairing,
    instance: &str,
) -> (Vec<u8>, Bytes<32>, AuthMessage) {
    let (hello, response) = probe(socket, vec![pair.offer()], instance).await;
    let (t, key) = challenge(&hello, response, pair);
    send(
        socket,
        AuthMessage::Prove {
            v: V1,
            client_proof: prove(&key, Purpose::Client, &t, None),
        },
    )
    .await;
    let next = AuthMessage::parse(&receive(socket).await).unwrap();
    (t, key, next)
}
async fn authenticate(socket: &mut Socket, pair: &mut Pairing) {
    let (t, key, message) = proved(socket, pair, INSTANCE).await;
    match message {
        AuthMessage::Ready {
            rotation: Some(rotation),
            commit: None,
            ..
        } => {
            let candidate = prove(&key, Purpose::Rotate, &t, Some(&rotation.txn));
            pair.pending = Some((rotation.clone(), candidate));
            send(
                socket,
                AuthMessage::RotateConfirm {
                    v: V1,
                    txn: rotation.txn,
                    proof: prove(&candidate, Purpose::Confirm, &t, Some(&rotation.txn)),
                },
            )
            .await;
            let AuthMessage::Committed { r#gen, proof, .. } =
                AuthMessage::parse(&receive(socket).await).unwrap()
            else {
                panic!("expected commit")
            };
            assert!(verify(
                &candidate,
                Purpose::Committed,
                &t,
                Some(&rotation.txn),
                &proof
            ));
            pair.key = candidate;
            pair.generation = r#gen;
            pair.pending = None;
        }
        AuthMessage::Ready {
            commit: Some(commit),
            rotation: None,
            ..
        } => {
            let (rotation, candidate) = pair.pending.take().unwrap();
            assert_eq!(rotation.txn, commit.txn);
            assert!(verify(
                &candidate,
                Purpose::Committed,
                &t,
                Some(&commit.txn),
                &commit.proof
            ));
            pair.key = candidate;
            pair.generation = commit.r#gen;
        }
        AuthMessage::Ready {
            commit: None,
            rotation: None,
            ..
        } => {}
        _ => panic!("unexpected authentication result"),
    }
    pair.role = CredentialRole::Active;
}
async fn handshake(socket: &mut Socket, instance: &str) -> Value {
    send(socket,json!({"id":"handshake","method":"system.handshake","params":{"client":"browser-skill-extension","version":"0.4.0","protocol_version":"1.3","instance_id":instance,"browser":{"name":"Chrome","version":"130"},"label":"test"}})).await;
    serde_json::from_str(&receive(socket).await).unwrap()
}

#[tokio::test]
async fn l01_l02_no_registration_or_session_purge_without_a_valid_proof() {
    let handle = daemon().await;
    let state = handle.state();
    let session = state
        .sessions
        .reserve_id(daemon::browsers::BrowserId(INSTANCE.into()), 1, || 0)
        .unwrap();
    let mut socket = connect(&handle).await;
    assert!(matches!(
        probe(&mut socket, vec![], INSTANCE).await.1,
        ChallengeResponse::PairingRequired {
            legacy_accepted: false,
            ..
        }
    ));
    closed(&mut socket).await;
    let pair = Pairing::create(&handle, None);
    let mut socket = connect(&handle).await;
    assert!(matches!(
        probe(&mut socket, vec![pair.offer()], INSTANCE).await.1,
        ChallengeResponse::Challenge { .. }
    ));
    send(
        &mut socket,
        AuthMessage::Prove {
            v: V1,
            client_proof: Bytes([0; 32]),
        },
    )
    .await;
    closed(&mut socket).await;
    assert!(state.browsers.is_empty());
    assert!(state.sessions.get(&session).is_some());
    assert!(
        state
            .local_auth
            .store
            .device(&pair.device.encode())
            .unwrap()
            .pending
            .is_none()
    );
    handle.shutdown().await;
}
#[tokio::test]
async fn l05_replayed_client_proof_and_l09_busy_are_rejected() {
    let handle = daemon().await;
    let pair = Pairing::create(&handle, None);
    let mut first = connect(&handle).await;
    let (hello, response) = probe(&mut first, vec![pair.offer()], INSTANCE).await;
    let (t, key) = challenge(&hello, response, &pair);
    let mut second = connect(&handle).await;
    assert!(matches!(
        probe(&mut second, vec![pair.offer()], INSTANCE).await.1,
        ChallengeResponse::Busy { .. }
    ));
    first.close(None).await.unwrap();
    closed(&mut first).await;
    let mut next = connect(&handle).await;
    let _ = probe(&mut next, vec![pair.offer()], INSTANCE).await;
    send(
        &mut next,
        AuthMessage::Prove {
            v: V1,
            client_proof: prove(&key, Purpose::Client, &t, None),
        },
    )
    .await;
    closed(&mut next).await;
    assert!(handle.state().browsers.is_empty());
    handle.shutdown().await;
}
#[tokio::test]
async fn l07_activation_invalidates_link_before_the_online_connection_ends() {
    let handle = daemon().await;
    let mut pair = Pairing::create(&handle, None);
    let old = pair.clone();
    let mut socket = connect(&handle).await;
    authenticate(&mut socket, &mut pair).await;
    assert!(
        handshake(&mut socket, INSTANCE)
            .await
            .get("result")
            .is_some()
    );
    let mut replay = connect(&handle).await;
    assert!(matches!(
        probe(&mut replay, vec![old.offer()], INSTANCE).await.1,
        ChallengeResponse::PairingRequired { .. }
    ));
    closed(&mut replay).await;
    assert_eq!(handle.state().browsers.len(), 1);
    socket.close(None).await.unwrap();
    handle.shutdown().await;
}
#[tokio::test]
async fn l08_recovery_before_save_after_save_and_after_daemon_commit() {
    for point in 0..3 {
        let handle = daemon().await;
        let mut pair = Pairing::create(&handle, None);
        let mut socket = connect(&handle).await;
        let (t, key, message) = proved(&mut socket, &pair, INSTANCE).await;
        let AuthMessage::Ready {
            rotation: Some(rotation),
            ..
        } = message
        else {
            panic!("rotation")
        };
        let candidate = prove(&key, Purpose::Rotate, &t, Some(&rotation.txn));
        if point > 0 {
            pair.pending = Some((rotation.clone(), candidate));
        }
        if point == 2 {
            send(
                &mut socket,
                AuthMessage::RotateConfirm {
                    v: V1,
                    txn: rotation.txn,
                    proof: prove(&candidate, Purpose::Confirm, &t, Some(&rotation.txn)),
                },
            )
            .await;
            let _lost = receive(&mut socket).await;
        }
        socket.close(None).await.unwrap();
        closed(&mut socket).await;
        let mut recovered = connect(&handle).await;
        authenticate(&mut recovered, &mut pair).await;
        assert_eq!(
            pair.key,
            handle
                .state()
                .local_auth
                .store
                .device(&pair.device.encode())
                .unwrap()
                .key
        );
        assert!(
            handshake(&mut recovered, INSTANCE)
                .await
                .get("result")
                .is_some()
        );
        recovered.close(None).await.unwrap();
        handle.shutdown().await;
    }
}
#[tokio::test]
async fn l13_l14_l14a_reject_before_rotation_and_replace_atomically() {
    let handle = daemon().await;
    let mut pair = Pairing::create(&handle, None);
    let mut main = connect(&handle).await;
    authenticate(&mut main, &mut pair).await;
    handshake(&mut main, INSTANCE).await;
    let state = handle.state();
    let session = state
        .sessions
        .reserve_id(daemon::browsers::BrowserId(INSTANCE.into()), 1, || 0)
        .unwrap();
    let duplicate = Pairing::create(&handle, None);
    let mut verifier = connect(&handle).await;
    assert!(matches!(
        proved(&mut verifier, &duplicate, INSTANCE).await.2,
        AuthMessage::Rejected {
            reason: RejectionReason::AlreadyPaired,
            ..
        }
    ));
    assert!(state.sessions.get(&session).is_some());
    assert_eq!(state.browsers.len(), 1);
    let mut replacement = Pairing::create(&handle, Some(INSTANCE));
    let mut mismatch = connect(&handle).await;
    assert!(matches!(
        proved(&mut mismatch, &replacement, "12345678").await.2,
        AuthMessage::Rejected {
            reason: RejectionReason::ReplaceMismatch,
            ..
        }
    ));
    closed(&mut mismatch).await;
    assert_eq!(
        state
            .local_auth
            .store
            .device(&pair.device.encode())
            .unwrap()
            .status,
        DeviceStatus::Active
    );
    let mut verifier = connect(&handle).await;
    authenticate(&mut verifier, &mut replacement).await;
    closed(&mut main).await;
    support::wait_for_browser_count(&state, 0).await;
    assert!(state.sessions.get(&session).is_none());
    assert_eq!(
        state
            .local_auth
            .store
            .device(&pair.device.encode())
            .unwrap()
            .status,
        DeviceStatus::Revoked
    );
    verifier.close(None).await.unwrap();
    handle.shutdown().await;
}
#[tokio::test]
async fn l15_oversized_unknown_duplicate_and_business_before_commit_are_closed() {
    let handle = daemon().await;
    for bad in [
        "x".repeat(4097),
        r#"{"id":"x","method":"system.ping","params":{"local_auth":{"v":1,"v":1}}}"#.into(),
        r#"{"id":"x","method":"system.ping","params":{"local_auth":{"unknown":true}}}"#.into(),
    ] {
        let mut socket = connect(&handle).await;
        socket.send(Message::Text(bad)).await.unwrap();
        closed(&mut socket).await;
    }
    let pair = Pairing::create(&handle, None);
    let mut socket = connect(&handle).await;
    let _ = proved(&mut socket, &pair, INSTANCE).await;
    send(
        &mut socket,
        json!({"id":"hs","method":"system.handshake","params":{}}),
    )
    .await;
    closed(&mut socket).await;
    assert!(handle.state().browsers.is_empty());
    assert_eq!(
        handle
            .state()
            .local_auth
            .store
            .device(&pair.device.encode())
            .unwrap()
            .status,
        DeviceStatus::Unactivated
    );
    handle.shutdown().await;
}
#[tokio::test]
async fn l08a_auth_messages_after_final_never_reach_business_dispatch() {
    let handle = daemon().await;
    let mut pair = Pairing::create(&handle, None);
    let mut socket = connect(&handle).await;
    authenticate(&mut socket, &mut pair).await;
    handshake(&mut socket, INSTANCE).await;
    send(
        &mut socket,
        AuthMessage::Ready {
            v: V1,
            commit: None,
            rotation: None,
        },
    )
    .await;
    closed(&mut socket).await;
    support::wait_for_browser_count(&handle.state(), 0).await;
    handle.shutdown().await;
}

#[tokio::test]
async fn l14b_committed_staged_credential_wins_over_the_old_active_record() {
    let handle = daemon().await;
    let mut active = Pairing::create(&handle, None);
    let mut main = connect(&handle).await;
    authenticate(&mut main, &mut active).await;
    handshake(&mut main, INSTANCE).await;
    let mut staged = Pairing::create(&handle, Some(INSTANCE));
    let mut verifier = connect(&handle).await;
    let (t, key, message) = proved(&mut verifier, &staged, INSTANCE).await;
    let AuthMessage::Ready {
        rotation: Some(rotation),
        ..
    } = message
    else {
        panic!("rotation")
    };
    let candidate = prove(&key, Purpose::Rotate, &t, Some(&rotation.txn));
    staged.pending = Some((rotation.clone(), candidate));
    send(
        &mut verifier,
        AuthMessage::RotateConfirm {
            v: V1,
            txn: rotation.txn,
            proof: prove(&candidate, Purpose::Confirm, &t, Some(&rotation.txn)),
        },
    )
    .await;
    let _lost = receive(&mut verifier).await;
    verifier.close(None).await.unwrap();
    closed(&mut verifier).await;
    let mut recovered = connect(&handle).await;
    let (hello, response) = probe(
        &mut recovered,
        vec![active.offer(), staged.offer()],
        INSTANCE,
    )
    .await;
    let (t, key) = challenge(&hello, response, &staged);
    send(
        &mut recovered,
        AuthMessage::Prove {
            v: V1,
            client_proof: prove(&key, Purpose::Client, &t, None),
        },
    )
    .await;
    let AuthMessage::Ready {
        commit: Some(commit),
        rotation: None,
        ..
    } = AuthMessage::parse(&receive(&mut recovered).await).unwrap()
    else {
        panic!("recovery commit")
    };
    assert!(verify(
        &candidate,
        Purpose::Committed,
        &t,
        Some(&commit.txn),
        &commit.proof
    ));
    assert!(
        handshake(&mut recovered, INSTANCE)
            .await
            .get("result")
            .is_some()
    );
    recovered.close(None).await.unwrap();
    handle.shutdown().await;
}

#[tokio::test]
async fn identity_binding_rejects_a_different_business_handshake() {
    let handle = daemon().await;
    let mut pair = Pairing::create(&handle, None);
    let mut socket = connect(&handle).await;
    authenticate(&mut socket, &mut pair).await;
    send(&mut socket,json!({"id":"hs","method":"system.handshake","params":{"client":"browser-skill-extension","version":"0.4.0","protocol_version":"1.3","instance_id":"12345678","browser":{"name":"Chrome","version":"130"},"label":"test"}})).await;
    closed(&mut socket).await;
    assert!(handle.state().browsers.is_empty());
    handle.shutdown().await;
}

#[tokio::test]
async fn l17_legacy_handshake_obeys_daemon_policy() {
    for mode in [
        LocalAuthMode::Warn,
        LocalAuthMode::Required,
        LocalAuthMode::TrustLocal,
    ] {
        let handle = daemon::run(DaemonConfig::new(0).with_local_auth(mode), None)
            .await
            .unwrap();
        let mut socket = connect(&handle).await;
        let result = handshake(&mut socket, INSTANCE).await;
        if mode == LocalAuthMode::Required {
            assert_eq!(result["error"]["code"], "pairing_required");
            closed(&mut socket).await;
        } else {
            assert!(result.get("result").is_some());
            socket.close(None).await.unwrap();
        }
        handle.shutdown().await;
    }
}

#[tokio::test]
async fn l11_pair_activate_call_and_revoke_cleans_up_before_success() {
    let handle = daemon().await;
    let mut pair = Pairing::create(&handle, None);
    let mut socket = connect(&handle).await;
    authenticate(&mut socket, &mut pair).await;
    handshake(&mut socket, INSTANCE).await;
    let state = handle.state();
    let browser = state.browsers.select(Some(INSTANCE)).unwrap();
    let session = state
        .sessions
        .reserve_id(browser.id.clone(), 1, || 0)
        .unwrap();
    let waiter = browser
        .dispatch(bsk_protocol::RequestFrame {
            id: "snapshot".into(),
            method: bsk_protocol::Method::ToolSnapshot,
            params: Some(json!({"session_id":session})),
        })
        .unwrap();
    let request: Value = serde_json::from_str(&receive(&mut socket).await).unwrap();
    assert_eq!(request["method"], "tool.snapshot");
    send(
        &mut socket,
        json!({"id":"snapshot", "result":{"text":"page"}}),
    )
    .await;
    assert!(matches!(waiter.await.unwrap().body, ResponseBody::Ok(_)));
    let pending = browser
        .dispatch(bsk_protocol::RequestFrame {
            id: "unfinished".into(),
            method: bsk_protocol::Method::ToolSnapshot,
            params: None,
        })
        .unwrap();
    let _ = receive(&mut socket).await;
    daemon::local_auth::lifecycle::revoke(state.clone(), Some(pair.device.encode()))
        .await
        .unwrap();
    assert!(state.browsers.is_empty());
    assert!(state.sessions.get(&session).is_none());
    assert!(pending.await.is_err());
    closed(&mut socket).await;
    let mut replay = connect(&handle).await;
    assert!(matches!(
        probe(&mut replay, vec![pair.offer()], INSTANCE).await.1,
        ChallengeResponse::PairingRequired { .. }
    ));
    closed(&mut replay).await;
    handle.shutdown().await;
}

#[tokio::test]
async fn l10_revocation_after_authentication_prevents_late_registration() {
    let handle = daemon().await;
    let mut pair = Pairing::create(&handle, None);
    let mut socket = connect(&handle).await;
    authenticate(&mut socket, &mut pair).await;
    daemon::local_auth::lifecycle::revoke(handle.state(), Some(pair.device.encode()))
        .await
        .unwrap();
    send(
        &mut socket,
        json!({"id":"late","method":"system.handshake","params":{
        "client":"browser-skill-extension","version":"0.4.0","protocol_version":"1.3",
        "instance_id":INSTANCE,"browser":{"name":"Chrome","version":"130"}}}),
    )
    .await;
    closed(&mut socket).await;
    assert!(handle.state().browsers.is_empty());
    handle.shutdown().await;
}

#[tokio::test]
async fn warn_records_only_pairing_capable_unpaired_attempts() {
    let state = daemon::DaemonState::new(DaemonConfig::new(0).with_local_auth(LocalAuthMode::Warn));
    state.record_unpaired(Some("0.3.0"), false);
    assert!(state.recent_unpaired().is_none());
    state.record_unpaired(Some("0.4.0"), true);
    let status = state.local_auth_status().unwrap();
    assert_eq!(status.mode, "warn");
    assert_eq!(status.paired_devices, 0);
    assert_eq!(
        status
            .last_unpaired_attempt
            .unwrap()
            .extension_version
            .as_deref(),
        Some("0.4.0")
    );
}
