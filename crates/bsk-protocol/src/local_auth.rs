//! Local WebSocket authentication v1. Secrets never travel on the wire.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
use sha2::Sha256;

use crate::RpcId;

pub const MAX_MESSAGE_BYTES: usize = 4096;
pub const MAX_CREDENTIALS: usize = 16;

/// Canonical, unpadded base64url with a fixed decoded length. Debug output is
/// deliberately redacted: the same representation is used for stored keys.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Bytes<const N: usize>(pub [u8; N]);

impl<const N: usize> std::fmt::Debug for Bytes<N> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}
impl<const N: usize> Bytes<N> {
    pub fn encode(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0)
    }
    pub fn decode(value: &str) -> Result<Self, InvalidMessage> {
        if value.len() != (N * 8).div_ceil(6) {
            return Err(InvalidMessage);
        }
        let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| InvalidMessage)?;
        let result = Self(bytes.try_into().map_err(|_| InvalidMessage)?);
        if result.encode() != value {
            return Err(InvalidMessage);
        }
        Ok(result)
    }
}
impl<const N: usize> Serialize for Bytes<N> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.encode())
    }
}
impl<'de, const N: usize> Deserialize<'de> for Bytes<N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::decode(&String::deserialize(deserializer)?)
            .map_err(|_| D::Error::custom("invalid encoded authentication field"))
    }
}

#[derive(Debug, thiserror::Error)]
#[error("invalid local authentication message")]
pub struct InvalidMessage;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct V1;
impl TryFrom<u8> for V1 {
    type Error = InvalidMessage;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        if value == 1 {
            Ok(Self)
        } else {
            Err(InvalidMessage)
        }
    }
}
impl From<V1> for u8 {
    fn from(_: V1) -> Self {
        1
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialRole {
    Active,
    Staged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rotation {
    pub txn: Bytes<16>,
    pub r#gen: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credential {
    pub role: CredentialRole,
    pub device_id: Bytes<16>,
    pub r#gen: u32,
    pub pending: Option<Rotation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    pub v: V1,
    pub client_nonce: Bytes<32>,
    pub instance_id: String,
    pub credentials: Vec<Credential>,
}
impl Hello {
    pub fn validate(&self) -> Result<(), InvalidMessage> {
        if self.instance_id.len() != 8
            || !self.instance_id.bytes().all(|b| b.is_ascii_hexdigit())
            || self.credentials.len() > MAX_CREDENTIALS
        {
            return Err(InvalidMessage);
        }
        let mut ids = std::collections::BTreeSet::new();
        for credential in &self.credentials {
            if !ids.insert(credential.device_id)
                || credential
                    .pending
                    .as_ref()
                    .is_some_and(|p| credential.r#gen.checked_add(1) != Some(p.r#gen))
            {
                return Err(InvalidMessage);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ProbeMethod {
    #[serde(rename = "system.ping")]
    Ping,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProbeParams {
    pub local_auth: Hello,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub id: RpcId,
    pub method: ProbeMethod,
    pub params: ProbeParams,
}
impl Probe {
    pub fn parse(text: &str) -> Result<Self, InvalidMessage> {
        let probe: Self = parse(text)?;
        probe.params.local_auth.validate()?;
        Ok(probe)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChallengeResponse {
    Challenge {
        daemon_id: Bytes<16>,
        device_id: Bytes<16>,
        r#gen: u32,
        server_nonce: Bytes<32>,
        server_proof: Bytes<32>,
    },
    PairingRequired {
        daemon_id: Bytes<16>,
        legacy_accepted: bool,
    },
    Busy {
        retry_after_ms: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Commit {
    pub txn: Bytes<16>,
    pub r#gen: u32,
    pub proof: Bytes<32>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectionReason {
    AlreadyPaired,
    ReplaceMismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum AuthMessage {
    #[serde(rename = "local.auth.prove")]
    Prove { v: V1, client_proof: Bytes<32> },
    #[serde(rename = "local.auth.ready")]
    Ready {
        v: V1,
        commit: Option<Commit>,
        rotation: Option<Rotation>,
    },
    #[serde(rename = "local.auth.rejected")]
    Rejected {
        v: V1,
        reason: RejectionReason,
        browser_id: String,
    },
    #[serde(rename = "local.auth.rotate_confirm")]
    RotateConfirm {
        v: V1,
        txn: Bytes<16>,
        proof: Bytes<32>,
    },
    #[serde(rename = "local.auth.committed")]
    Committed { v: V1, r#gen: u32, proof: Bytes<32> },
}
impl AuthMessage {
    pub fn parse(text: &str) -> Result<Self, InvalidMessage> {
        let message: Self = parse(text)?;
        if matches!(
            &message,
            Self::Ready {
                commit: Some(_),
                rotation: Some(_),
                ..
            }
        ) {
            return Err(InvalidMessage);
        }
        Ok(message)
    }
}
fn parse<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, InvalidMessage> {
    if text.len() > MAX_MESSAGE_BYTES {
        return Err(InvalidMessage);
    }
    // Parse the original text, never an intermediate Value: serde then rejects
    // duplicate fields instead of silently retaining the last occurrence.
    serde_json::from_str(text).map_err(|_| InvalidMessage)
}

pub fn fields(parts: &[&[u8]]) -> Vec<u8> {
    let mut result = Vec::new();
    for part in parts {
        result.extend_from_slice(
            &u32::try_from(part.len())
                .expect("bounded field")
                .to_be_bytes(),
        );
        result.extend_from_slice(part);
    }
    result
}

pub struct Transcript<'a> {
    pub daemon_id: &'a Bytes<16>,
    pub device_id: &'a Bytes<16>,
    pub r#gen: u32,
    pub instance_id: &'a str,
    pub origin: &'a str,
    pub client_nonce: &'a Bytes<32>,
    pub server_nonce: &'a Bytes<32>,
}
impl Transcript<'_> {
    pub fn encode(&self) -> Vec<u8> {
        fields(&[
            b"bsk-local-auth-v1",
            &self.daemon_id.0,
            &self.device_id.0,
            &self.r#gen.to_be_bytes(),
            self.instance_id.as_bytes(),
            self.origin.as_bytes(),
            &self.client_nonce.0,
            &self.server_nonce.0,
        ])
    }
}

#[derive(Clone, Copy)]
pub enum Purpose {
    Server,
    Client,
    Rotate,
    Confirm,
    Committed,
}
impl Purpose {
    fn label(self) -> &'static [u8] {
        match self {
            Self::Server => b"server",
            Self::Client => b"client",
            Self::Rotate => b"rotate",
            Self::Confirm => b"confirm",
            Self::Committed => b"committed",
        }
    }
}

fn mac(
    key: &Bytes<32>,
    purpose: Purpose,
    transcript: &[u8],
    txn: Option<&Bytes<16>>,
) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(&key.0).expect("32-byte HMAC key");
    let data = match txn {
        Some(txn) => fields(&[purpose.label(), transcript, &txn.0]),
        None => fields(&[purpose.label(), transcript]),
    };
    mac.update(&data);
    mac
}
pub fn prove(
    key: &Bytes<32>,
    purpose: Purpose,
    transcript: &[u8],
    txn: Option<&Bytes<16>>,
) -> Bytes<32> {
    Bytes(
        mac(key, purpose, transcript, txn)
            .finalize()
            .into_bytes()
            .into(),
    )
}
pub fn verify(
    key: &Bytes<32>,
    purpose: Purpose,
    transcript: &[u8],
    txn: Option<&Bytes<16>>,
    proof: &Bytes<32>,
) -> bool {
    mac(key, purpose, transcript, txn)
        .verify_slice(&proof.0)
        .is_ok()
}
