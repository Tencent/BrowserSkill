//! Authentication is isolated from browser registration and business dispatch.
use super::{
    LocalAuth,
    store::{ActivationRejected, DeviceStatus, Pending, now, random},
};
use crate::daemon::peer_authorization::{LocalPeer, PeerAuthorization};
use anyhow::{Result, anyhow, bail, ensure};
use bsk_protocol::local_auth::{
    AuthMessage, ChallengeResponse, Commit, Probe, Purpose, Rotation, Transcript, V1, prove, verify,
};
use bsk_protocol::{ErrorCode, Method, RequestFrame, ResponseBody, ResponseFrame, RpcError};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};

pub(crate) async fn accept<S: AsyncRead + AsyncWrite + Unpin>(
    local: Arc<LocalAuth>,
    ws: &mut WebSocketStream<S>,
    origin: &str,
) -> Result<(PeerAuthorization, Option<Message>)> {
    let first = text(ws).await?;
    let request: RequestFrame =
        serde_json::from_str(&first).map_err(|_| anyhow!("invalid authentication probe"))?;
    if request.method == Method::SystemHandshake {
        if !local.mode().accepts_legacy() {
            reply(
                ws,
                &request.id,
                ResponseBody::Err(RpcError {
                    code: ErrorCode::PairingRequired,
                    message: "update the extension and run `bsk daemon pair` to connect".into(),
                    data: None,
                }),
            )
            .await?;
            bail!("local pairing required");
        }
        return Ok((PeerAuthorization::Legacy, Some(Message::Text(first))));
    }
    if request.method != Method::SystemPing
        || request
            .params
            .as_ref()
            .and_then(|p| p.get("local_auth"))
            .is_none()
    {
        reply(
            ws,
            &request.id,
            ResponseBody::Err(RpcError {
                code: ErrorCode::ProtocolError,
                message: "first frame must be system.handshake or a local authentication probe"
                    .into(),
                data: None,
            }),
        )
        .await?;
        bail!("invalid first frame");
    }
    let probe = Probe::parse(&first)?;
    let hello = probe.params.local_auth;
    let Some(initial) = local.store.select(&hello.credentials) else {
        challenge(
            ws,
            &probe.id,
            ChallengeResponse::PairingRequired {
                daemon_id: local.store.daemon_id(),
                legacy_accepted: local.mode().accepts_legacy(),
            },
        )
        .await?;
        bail!("local pairing required");
    };
    let device_id = initial.device_id.encode();
    let gate = local.device_gate(&device_id);
    let Ok(_guard) = gate.try_lock_owned() else {
        challenge(
            ws,
            &probe.id,
            ChallengeResponse::Busy {
                retry_after_ms: 1000,
            },
        )
        .await?;
        bail!("local device authentication busy");
    };
    // Selection preceded the gate; re-read under it before issuing a proof.
    let selected = local
        .store
        .select(&hello.credentials)
        .filter(|s| s.device_id == initial.device_id)
        .ok_or_else(|| anyhow!("local authorization changed"))?;
    let server_nonce = random();
    let daemon_id = local.store.daemon_id();
    let transcript = Transcript {
        daemon_id: &daemon_id,
        device_id: &selected.device_id,
        r#gen: selected.r#gen,
        instance_id: &hello.instance_id,
        origin,
        client_nonce: &hello.client_nonce,
        server_nonce: &server_nonce,
    }
    .encode();
    challenge(
        ws,
        &probe.id,
        ChallengeResponse::Challenge {
            daemon_id,
            device_id: selected.device_id,
            r#gen: selected.r#gen,
            server_nonce,
            server_proof: prove(&selected.key, Purpose::Server, &transcript, None),
        },
    )
    .await?;
    let AuthMessage::Prove { client_proof, .. } = AuthMessage::parse(&text(ws).await?)? else {
        bail!("expected client proof");
    };
    ensure!(
        verify(
            &selected.key,
            Purpose::Client,
            &transcript,
            None,
            &client_proof
        ),
        "local client proof rejected"
    );
    if let Err(error) = local.store.check_activation(&device_id, &hello.instance_id) {
        if let Some(rejected) = error.downcast_ref::<ActivationRejected>() {
            send(
                ws,
                &AuthMessage::Rejected {
                    v: V1,
                    reason: rejected.reason,
                    browser_id: rejected.browser_id.clone(),
                },
            )
            .await?;
        }
        return Err(error);
    }
    if let Some(commit) = selected.commit {
        if selected
            .device
            .pending
            .as_ref()
            .is_some_and(|p| p.txn == commit.txn)
        {
            durable_commit(
                local.clone(),
                device_id.clone(),
                commit.txn,
                hello.instance_id.clone(),
            )
            .await?;
        }
        send(
            ws,
            &AuthMessage::Ready {
                v: V1,
                rotation: None,
                commit: Some(Commit {
                    txn: commit.txn,
                    r#gen: commit.r#gen,
                    proof: prove(
                        &selected.key,
                        Purpose::Committed,
                        &transcript,
                        Some(&commit.txn),
                    ),
                }),
            },
        )
        .await?;
    } else if selected.device.status == DeviceStatus::Unactivated
        || selected.device.rotate_requested
        || selected.device.pending.is_some()
    {
        let txn = random();
        let generation = selected
            .r#gen
            .checked_add(1)
            .ok_or_else(|| anyhow!("local key generation exhausted"))?;
        let candidate = prove(&selected.key, Purpose::Rotate, &transcript, Some(&txn));
        let pending = Pending {
            txn,
            r#gen: generation,
            key: candidate,
            created_at: now(),
        };
        let store = local.clone();
        let id = device_id.clone();
        let instance = hello.instance_id.clone();
        tokio::task::spawn_blocking(move || {
            store.store.stage_rotation(
                &id,
                selected.r#gen,
                selected.device.pending.map(|p| p.txn),
                pending,
                &instance,
            )
        })
        .await??;
        send(
            ws,
            &AuthMessage::Ready {
                v: V1,
                commit: None,
                rotation: Some(Rotation {
                    txn,
                    r#gen: generation,
                }),
            },
        )
        .await?;
        let AuthMessage::RotateConfirm {
            txn: confirmed,
            proof,
            ..
        } = AuthMessage::parse(&text(ws).await?)?
        else {
            bail!("expected rotation confirmation");
        };
        ensure!(
            confirmed == txn
                && verify(
                    &candidate,
                    Purpose::Confirm,
                    &transcript,
                    Some(&txn),
                    &proof
                ),
            "local rotation confirmation rejected"
        );
        durable_commit(
            local.clone(),
            device_id.clone(),
            txn,
            hello.instance_id.clone(),
        )
        .await?;
        send(
            ws,
            &AuthMessage::Committed {
                v: V1,
                r#gen: generation,
                proof: prove(&candidate, Purpose::Committed, &transcript, Some(&txn)),
            },
        )
        .await?;
    } else {
        send(
            ws,
            &AuthMessage::Ready {
                v: V1,
                commit: None,
                rotation: None,
            },
        )
        .await?;
    }
    let browser_id = local
        .store
        .device(&device_id)
        .and_then(|d| d.browser_id)
        .ok_or_else(|| anyhow!("local activation incomplete"))?;
    Ok((
        PeerAuthorization::Local(LocalPeer {
            device_id,
            browser_id,
            local,
        }),
        None,
    ))
}

async fn durable_commit(
    local: Arc<LocalAuth>,
    id: String,
    txn: bsk_protocol::local_auth::Bytes<16>,
    instance: String,
) -> Result<()> {
    tokio::task::spawn_blocking(move || local.store.commit(&id, txn, &instance)).await??;
    Ok(())
}
async fn text<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>) -> Result<String> {
    match ws.next().await {
        Some(Ok(Message::Text(text)))
            if text.len() <= bsk_protocol::local_auth::MAX_MESSAGE_BYTES =>
        {
            Ok(text)
        }
        _ => bail!("invalid local authentication frame"),
    }
}
async fn send<S: AsyncRead + AsyncWrite + Unpin>(
    ws: &mut WebSocketStream<S>,
    message: &AuthMessage,
) -> Result<()> {
    ws.send(Message::Text(serde_json::to_string(message)?))
        .await?;
    Ok(())
}
async fn challenge<S: AsyncRead + AsyncWrite + Unpin>(
    ws: &mut WebSocketStream<S>,
    id: &str,
    value: ChallengeResponse,
) -> Result<()> {
    reply(
        ws,
        id,
        ResponseBody::Ok(serde_json::json!({"local_auth":value})),
    )
    .await
}
async fn reply<S: AsyncRead + AsyncWrite + Unpin>(
    ws: &mut WebSocketStream<S>,
    id: &str,
    body: ResponseBody,
) -> Result<()> {
    ws.send(Message::Text(serde_json::to_string(&ResponseFrame {
        id: id.into(),
        body,
    })?))
    .await?;
    Ok(())
}
