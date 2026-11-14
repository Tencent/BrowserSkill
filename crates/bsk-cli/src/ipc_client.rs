//! CLI-side IPC client: reads `~/.bsk/daemon.json` for the socket path
//! and issues typed JSON-line RPCs over it.
//!
//! Each [`Client::call`] is a fresh connection (cheap: UDS is local).
//! Future milestones may pool connections for the long-running `bsk
//! events` / `bsk logs -f` commands.
//!
//! On Windows the same line protocol runs over a per-user named pipe.

use std::fmt;

use anyhow::{Context, Result};
use bsk_protocol::{DecodeError, EventFrame, EventKind, Method, ResponseBody, RpcError, RpcId};
use serde::de::{self, DeserializeOwned, MapAccess, Visitor};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

const LEGACY_CALLER_SCOPE_KEY: &str = "_caller_scope";
const LEGACY_BIND_SCOPE_KEY: &str = "_bind_scope";
const LEGACY_REUSE_OR_START_SCOPE_KEY: &str = "_reuse_or_start_scope";
const LEGACY_EXPLICIT_INCOGNITO_KEY: &str = "_explicit_incognito";
const LEGACY_RETURN_SCOPE_META_KEY: &str = "_return_scope_meta";
pub(crate) const LEGACY_SCOPE_META_KEY: &str = "_scope_meta";

const MAX_ENDPOINT_CAPABILITY_ENTRIES: usize = 512;

static ENDPOINT_IPC_ENVELOPE: std::sync::Mutex<
    std::collections::VecDeque<(std::path::PathBuf, bool)>,
> = std::sync::Mutex::new(std::collections::VecDeque::new());

/// Record whether `sock_path` supports out-of-band [`IpcEnvelope`] `meta` headers.
/// Refreshed by `daemon::probe` (`StatusResult.ipc_envelope`) and optimistic
/// `daemon.json` discovery (`DaemonInfo.ipc_envelope`).
pub(crate) fn record_endpoint_ipc_envelope(sock_path: &std::path::Path, supported: bool) {
    let mut guard = ENDPOINT_IPC_ENVELOPE
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if let Some(pos) = guard.iter().position(|(existing, _)| existing == sock_path) {
        guard.remove(pos);
    } else if guard.len() >= MAX_ENDPOINT_CAPABILITY_ENTRIES {
        guard.pop_front();
    }
    guard.push_back((sock_path.to_path_buf(), supported));
}

/// Look up whether `sock_path` supports out-of-band [`IpcEnvelope`] `meta` headers.
/// Defaults to `true` for direct [`IpcClient::connect`] calls against in-process
/// test daemons that bypass `daemon.json` / `system.status` discovery.
pub(crate) fn endpoint_supports_ipc_envelope(sock_path: &std::path::Path) -> bool {
    ENDPOINT_IPC_ENVELOPE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .find(|(existing, _)| existing == sock_path)
        .map(|(_, supported)| *supported)
        .unwrap_or(true)
}

fn is_false(v: &bool) -> bool {
    !*v
}

/// Request-side transport metadata on the local CLI/MCP ↔ daemon IPC link.
/// Keeps caller scope and implicit session binding directives out of business
/// `params: Value` payloads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IpcRequestMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller_scope: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub bind_scope: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub reuse_or_start_scope: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub explicit_incognito: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub return_scope_meta: bool,
}

impl IpcRequestMeta {
    pub fn is_empty(&self) -> bool {
        self.caller_scope.is_none()
            && !self.bind_scope
            && !self.reuse_or_start_scope
            && !self.explicit_incognito
            && !self.return_scope_meta
    }

    /// Strip legacy `"2.0"` `_`-prefixed scope keys from `params` so they never
    /// spoof non-empty `req_meta`, fail strict `deny_unknown_fields` param
    /// deserializers, or leak onto the extension WebSocket wire. When `req_meta`
    /// is empty (a pre-envelope `"2.0"` CLI/MCP process during a rolling upgrade),
    /// adopt the legacy directives and report whether `_scope_meta` must be
    /// echoed in-band on the response `result`.
    pub fn extract_legacy_from_params(
        params: &mut serde_json::Value,
        req_meta: Self,
    ) -> (Self, bool) {
        let mut legacy = Self::default();
        let mut saw_legacy_key = false;
        if let Some(obj) = params.as_object_mut() {
            if let Some(v) = obj.remove(LEGACY_CALLER_SCOPE_KEY) {
                saw_legacy_key = true;
                legacy.caller_scope = v.as_str().map(str::to_owned);
            }
            if let Some(v) = obj.remove(LEGACY_BIND_SCOPE_KEY) {
                saw_legacy_key = true;
                legacy.bind_scope = v.as_bool().unwrap_or(false);
            }
            if let Some(v) = obj.remove(LEGACY_REUSE_OR_START_SCOPE_KEY) {
                saw_legacy_key = true;
                legacy.reuse_or_start_scope = v.as_bool().unwrap_or(false);
            }
            if let Some(v) = obj.remove(LEGACY_EXPLICIT_INCOGNITO_KEY) {
                saw_legacy_key = true;
                legacy.explicit_incognito = v.as_bool().unwrap_or(false);
            }
            if let Some(v) = obj.remove(LEGACY_RETURN_SCOPE_META_KEY) {
                saw_legacy_key = true;
                legacy.return_scope_meta = v.as_bool().unwrap_or(false);
            }
        }
        if req_meta.is_empty() && saw_legacy_key {
            let return_inband = legacy.return_scope_meta;
            (legacy, return_inband)
        } else {
            (req_meta, false)
        }
    }

    fn strip_legacy_keys(params: &mut Option<serde_json::Value>) {
        if let Some(obj) = params.as_mut().and_then(serde_json::Value::as_object_mut) {
            obj.remove(LEGACY_CALLER_SCOPE_KEY);
            obj.remove(LEGACY_BIND_SCOPE_KEY);
            obj.remove(LEGACY_REUSE_OR_START_SCOPE_KEY);
            obj.remove(LEGACY_EXPLICIT_INCOGNITO_KEY);
            obj.remove(LEGACY_RETURN_SCOPE_META_KEY);
        }
    }

    fn inject_legacy_into_params(self, params: &mut Option<serde_json::Value>) {
        if self.is_empty() {
            return;
        }
        if params.as_ref().is_none_or(serde_json::Value::is_null) {
            *params = Some(serde_json::Value::Object(serde_json::Map::new()));
        }
        if let Some(obj) = params.as_mut().and_then(serde_json::Value::as_object_mut) {
            if let Some(scope) = self.caller_scope {
                obj.insert(
                    LEGACY_CALLER_SCOPE_KEY.into(),
                    serde_json::Value::String(scope),
                );
            }
            if self.bind_scope {
                obj.insert(LEGACY_BIND_SCOPE_KEY.into(), serde_json::Value::Bool(true));
            }
            if self.reuse_or_start_scope {
                obj.insert(
                    LEGACY_REUSE_OR_START_SCOPE_KEY.into(),
                    serde_json::Value::Bool(true),
                );
            }
            if self.explicit_incognito {
                obj.insert(
                    LEGACY_EXPLICIT_INCOGNITO_KEY.into(),
                    serde_json::Value::Bool(true),
                );
            }
            if self.return_scope_meta {
                obj.insert(
                    LEGACY_RETURN_SCOPE_META_KEY.into(),
                    serde_json::Value::Bool(true),
                );
            }
        }
    }
}

/// Daemon-cached observation metadata returned out-of-band alongside a
/// `tool.cooperate` (or `operation_await`) reply when `return_scope_meta` is requested.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopeResultMeta {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_ctx: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_obs: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_vom: Option<String>,
    #[serde(default)]
    pub cached_vom_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_vom_next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_title: Option<String>,
    #[serde(default)]
    pub cache_reusable: bool,
}

impl ScopeResultMeta {
    pub(crate) fn from_legacy_value(raw: &serde_json::Value) -> Option<Self> {
        let obj = raw.as_object()?;
        let session_id = obj.get("session_id")?.as_str()?.to_owned();
        Some(Self {
            session_id,
            tab_id: obj.get("tab_id").and_then(serde_json::Value::as_i64),
            short_ctx: obj
                .get("short_ctx")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            short_obs: obj
                .get("short_obs")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            cached_vom: obj
                .get("cached_vom")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            cached_vom_truncated: obj
                .get("cached_vom_truncated")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            cached_vom_next_cursor: obj
                .get("cached_vom_next_cursor")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            cached_url: obj
                .get("cached_url")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            cached_title: obj
                .get("cached_title")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            cache_reusable: obj
                .get("cache_reusable")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        })
    }
}

/// Response-side transport metadata on the local CLI/MCP ↔ daemon IPC link.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IpcResponseMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_meta: Option<ScopeResultMeta>,
}

impl IpcResponseMeta {
    pub fn is_empty(&self) -> bool {
        self.scope_meta.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IpcRequestEnvelope {
    pub id: RpcId,
    pub method: Method,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "IpcRequestMeta::is_empty")]
    pub meta: IpcRequestMeta,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IpcResponseEnvelope {
    pub id: RpcId,
    pub body: ResponseBody,
    pub meta: IpcResponseMeta,
}

impl Serialize for IpcResponseEnvelope {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let fields = if self.meta.is_empty() { 2 } else { 3 };
        let mut s = serializer.serialize_struct("IpcResponseEnvelope", fields)?;
        s.serialize_field("id", &self.id)?;
        match &self.body {
            ResponseBody::Ok(v) => s.serialize_field("result", v)?,
            ResponseBody::Err(e) => s.serialize_field("error", e)?,
        }
        if !self.meta.is_empty() {
            s.serialize_field("meta", &self.meta)?;
        }
        s.end()
    }
}

/// Strongly typed local IPC wire envelope shared by CLI/MCP and the daemon.
/// Wire-compatible with [`bsk_protocol::Frame`] whenever `meta` is empty.
#[derive(Debug, Clone, PartialEq)]
pub enum IpcEnvelope {
    Request(IpcRequestEnvelope),
    Response(IpcResponseEnvelope),
    Event(EventFrame),
}

impl Serialize for IpcEnvelope {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Request(v) => v.serialize(serializer),
            Self::Response(v) => v.serialize(serializer),
            Self::Event(v) => v.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for IpcEnvelope {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(IpcEnvelopeVisitor)
    }
}

struct IpcEnvelopeVisitor;

impl<'de> Visitor<'de> for IpcEnvelopeVisitor {
    type Value = IpcEnvelope;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "an IPC envelope object")
    }

    fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut id = None::<RpcId>;
        let mut method = None::<Method>;
        let mut params = None::<serde_json::Value>;
        let mut result = None::<serde_json::Value>;
        let mut error = None::<RpcError>;
        let mut event = None::<EventKind>;
        let mut payload = None::<serde_json::Value>;
        let mut meta = None::<serde_json::Value>;

        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "id" => {
                    if id.is_some() {
                        return Err(de::Error::duplicate_field("id"));
                    }
                    id = Some(map.next_value()?);
                }
                "method" => {
                    if method.is_some() {
                        return Err(de::Error::duplicate_field("method"));
                    }
                    method = Some(map.next_value()?);
                }
                "params" => {
                    if params.is_some() {
                        return Err(de::Error::duplicate_field("params"));
                    }
                    params = Some(map.next_value()?);
                }
                "result" => {
                    if result.is_some() {
                        return Err(de::Error::duplicate_field("result"));
                    }
                    result = Some(map.next_value()?);
                }
                "error" => {
                    if error.is_some() {
                        return Err(de::Error::duplicate_field("error"));
                    }
                    error = Some(map.next_value()?);
                }
                "event" => {
                    if event.is_some() {
                        return Err(de::Error::duplicate_field("event"));
                    }
                    event = Some(map.next_value()?);
                }
                "payload" => {
                    if payload.is_some() {
                        return Err(de::Error::duplicate_field("payload"));
                    }
                    payload = Some(map.next_value()?);
                }
                "meta" => {
                    if meta.is_some() {
                        return Err(de::Error::duplicate_field("meta"));
                    }
                    meta = Some(map.next_value()?);
                }
                other => {
                    return Err(de::Error::unknown_field(
                        other,
                        &[
                            "id", "method", "params", "result", "error", "event", "payload", "meta",
                        ],
                    ));
                }
            }
        }

        if let Some(event) = event {
            if id.is_some()
                || method.is_some()
                || params.is_some()
                || result.is_some()
                || error.is_some()
                || meta.is_some()
            {
                return Err(de::Error::custom(DecodeError::InvalidFrame(
                    "mixed event and rpc frame fields".into(),
                )));
            }
            return Ok(IpcEnvelope::Event(EventFrame {
                event,
                payload: payload.unwrap_or(serde_json::Value::Null),
            }));
        }

        if payload.is_some() {
            return Err(de::Error::custom(DecodeError::InvalidFrame(
                "unexpected event payload on rpc frame".into(),
            )));
        }

        match (id, method, result, error) {
            (Some(id), Some(method), None, None) => {
                let meta: IpcRequestMeta = match meta {
                    Some(raw) => {
                        // Any explicit wire `"meta"` (including `"meta": {}`) marks an
                        // `IpcEnvelope` sender, so strip legacy `_` scope keys immediately
                        // rather than letting them spoof an empty `IpcRequestMeta`.
                        IpcRequestMeta::strip_legacy_keys(&mut params);
                        serde_json::from_value(raw).map_err(de::Error::custom)?
                    }
                    None => IpcRequestMeta::default(),
                };
                Ok(IpcEnvelope::Request(IpcRequestEnvelope {
                    id,
                    method,
                    params,
                    meta,
                }))
            }
            (Some(id), None, result, error) if params.is_none() => {
                let meta: IpcResponseMeta = match meta {
                    Some(raw) => serde_json::from_value(raw).map_err(de::Error::custom)?,
                    None => IpcResponseMeta::default(),
                };
                let body = match (result, error) {
                    (Some(v), None) => ResponseBody::Ok(v),
                    (None, Some(e)) => ResponseBody::Err(e),
                    _ => return Err(de::Error::custom(DecodeError::AmbiguousResponse)),
                };
                Ok(IpcEnvelope::Response(IpcResponseEnvelope {
                    id,
                    body,
                    meta,
                }))
            }
            _ => Err(de::Error::custom(DecodeError::InvalidFrame(
                "invalid IPC envelope fields".into(),
            ))),
        }
    }
}

fn encode_request_envelope<P: Serialize>(
    sock_path: &std::path::Path,
    id: String,
    method: Method,
    params: &P,
    meta: IpcRequestMeta,
) -> Result<(String, bool)> {
    let mut params_val = Some(serde_json::to_value(params).context("serialise params")?);
    let legacy_framing = !endpoint_supports_ipc_envelope(sock_path);
    let wire_meta = if legacy_framing {
        meta.inject_legacy_into_params(&mut params_val);
        IpcRequestMeta::default()
    } else {
        meta
    };
    let frame = IpcEnvelope::Request(IpcRequestEnvelope {
        id,
        method,
        params: params_val,
        meta: wire_meta,
    });
    let mut payload = serde_json::to_string(&frame).context("encode request")?;
    payload.push('\n');
    Ok((payload, legacy_framing))
}

fn decode_response_envelope_with_mode<R: DeserializeOwned>(
    line: &str,
    id: &str,
    legacy_framing: bool,
) -> Result<(RpcOutcome<R>, IpcResponseMeta)> {
    let frame: IpcEnvelope = serde_json::from_str(line).context("decode IPC response")?;
    match frame {
        IpcEnvelope::Response(mut resp) => {
            if resp.id != id {
                return Err(anyhow::anyhow!(
                    "IPC response id mismatch: expected {id}, got {}",
                    resp.id
                ));
            }
            match resp.body {
                ResponseBody::Ok(mut v) => {
                    if legacy_framing
                        && let Some(obj) = v.as_object_mut()
                        && let Some(raw_scope_meta) = obj.remove(LEGACY_SCOPE_META_KEY)
                        && resp.meta.scope_meta.is_none()
                    {
                        resp.meta.scope_meta = ScopeResultMeta::from_legacy_value(&raw_scope_meta);
                    }
                    let value: R = serde_json::from_value(v).context("decode result")?;
                    Ok((Ok(value), resp.meta))
                }
                ResponseBody::Err(e) => Ok((Err(e), resp.meta)),
            }
        }
        other => Err(anyhow::anyhow!("unexpected frame from daemon: {other:?}")),
    }
}

#[cfg(test)]
fn decode_response<R: DeserializeOwned>(line: &str, id: &str) -> Result<RpcOutcome<R>> {
    decode_response_envelope_with_mode(line, id, false).map(|(outcome, _)| outcome)
}

#[cfg(test)]
mod tests {
    use super::{
        IpcRequestMeta, decode_response, decode_response_envelope_with_mode,
        encode_request_envelope, endpoint_supports_ipc_envelope, record_endpoint_ipc_envelope,
    };
    use bsk_protocol::{ErrorCode, Method, PingResult};
    use serde_json::{Value, json};
    use std::path::Path;

    #[test]
    fn shared_decoder_preserves_typed_results_and_rpc_error_details() {
        let result: PingResult = decode_response(r#"{"id":"one","result":{"pong":true}}"#, "one")
            .unwrap()
            .unwrap();
        assert!(result.pong);
        let error = decode_response::<Value>(
            r#"{"id":"one","error":{"code":"cancelled","message":"stopped","data":{"reason":"test"}}}"#,
            "one",
        )
        .unwrap()
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::Cancelled);
        assert_eq!(error.message, "stopped");
        assert_eq!(error.data, Some(json!({"reason": "test"})));
    }

    #[test]
    fn shared_decoder_rejects_wrong_request_ids_and_invalid_response_shapes() {
        for wire in [
            r#"{"id":"other","result":{"pong":true}}"#,
            r#"{"id":"one","method":"system.ping"}"#,
            r#"{"id":"one","result":{"pong":"wrong type"}}"#,
            "not JSON",
        ] {
            assert!(
                decode_response::<PingResult>(wire, "one").is_err(),
                "{wire}"
            );
        }
    }

    #[test]
    fn legacy_endpoint_framing_roundtrips_scope_meta_and_prevents_meta_spoofing() {
        let legacy_sock = Path::new("/tmp/bsk-unit-legacy-2-0.sock");
        record_endpoint_ipc_envelope(legacy_sock, false);
        assert!(!endpoint_supports_ipc_envelope(legacy_sock));

        let req_meta = IpcRequestMeta {
            caller_scope: Some("agent:codex:thr-1".into()),
            bind_scope: true,
            reuse_or_start_scope: true,
            explicit_incognito: true,
            return_scope_meta: true,
        };
        let (wire, legacy_mode) = encode_request_envelope(
            legacy_sock,
            "req-1".into(),
            Method::SessionStart,
            &json!({ "incognito": true }),
            req_meta.clone(),
        )
        .unwrap();
        assert!(legacy_mode);
        let wire_json: Value = serde_json::from_str(wire.trim_end()).unwrap();
        assert!(wire_json.get("meta").is_none(), "{wire_json}");
        assert_eq!(wire_json["params"]["_caller_scope"], "agent:codex:thr-1");
        assert_eq!(wire_json["params"]["_bind_scope"], true);
        assert_eq!(wire_json["params"]["_reuse_or_start_scope"], true);
        assert_eq!(wire_json["params"]["_explicit_incognito"], true);
        assert_eq!(wire_json["params"]["_return_scope_meta"], true);

        // Daemon-side extraction adopts legacy keys when `meta` is empty, and
        // strips legacy keys WITHOUT letting them spoof non-empty `meta`.
        let mut inbound_params = wire_json["params"].clone();
        let (extracted, return_inband) = IpcRequestMeta::extract_legacy_from_params(
            &mut inbound_params,
            IpcRequestMeta::default(),
        );
        assert_eq!(extracted, req_meta);
        assert!(return_inband);
        assert_eq!(inbound_params, json!({ "incognito": true }));

        let mut spoof_params = json!({
            "session_id": "",
            "_caller_scope": "agent:victim",
            "_return_scope_meta": true
        });
        let trusted_meta = IpcRequestMeta {
            caller_scope: Some("agent:trusted".into()),
            ..Default::default()
        };
        let (effective, spoof_inband) =
            IpcRequestMeta::extract_legacy_from_params(&mut spoof_params, trusted_meta.clone());
        assert_eq!(effective, trusted_meta);
        assert!(!spoof_inband);
        assert_eq!(spoof_params, json!({ "session_id": "" }));

        // Explicit empty `"meta": {}` on the wire is still an envelope-mode frame:
        // legacy keys in `params` must be stripped and must NOT spoof empty `meta`.
        let explicit_empty_meta_wire = json!({
            "id": "spoof-empty",
            "method": "tool.click",
            "params": {
                "session_id": "",
                "_caller_scope": "agent:victim",
                "_return_scope_meta": true
            },
            "meta": {}
        })
        .to_string();
        let super::IpcEnvelope::Request(mut req_env) =
            serde_json::from_str(&explicit_empty_meta_wire).unwrap()
        else {
            panic!("expected request envelope");
        };
        let mut req_params = req_env.params.take().unwrap();
        let (empty_effective, empty_inband) =
            IpcRequestMeta::extract_legacy_from_params(&mut req_params, req_env.meta);
        assert_eq!(empty_effective, IpcRequestMeta::default());
        assert!(!empty_inband);
        assert_eq!(req_params, json!({ "session_id": "" }));

        // Client-side legacy response decoder lifts `_scope_meta` into `IpcResponseMeta`
        // and strips it from `result` before typed deserialization.
        let legacy_reply = json!({
            "id": "req-1",
            "result": {
                "pong": true,
                "_scope_meta": {
                    "session_id": "sess-legacy",
                    "tab_id": 9,
                    "short_ctx": "c1",
                    "short_obs": "o1",
                    "cached_vom": "@e1 button \"OK\"",
                    "cached_vom_truncated": false,
                    "cache_reusable": true,
                    "future_unknown_field": 123
                }
            }
        })
        .to_string();
        let (decoded, resp_meta) =
            decode_response_envelope_with_mode::<Value>(&legacy_reply, "req-1", true).unwrap();
        let decoded_val = decoded.unwrap();
        assert!(decoded_val.get("_scope_meta").is_none(), "{decoded_val}");
        let scope_meta = resp_meta.scope_meta.expect("legacy _scope_meta lifted");
        assert_eq!(scope_meta.session_id, "sess-legacy");
        assert_eq!(scope_meta.tab_id, Some(9));
        assert_eq!(scope_meta.short_ctx.as_deref(), Some("c1"));
        assert!(scope_meta.cache_reusable);

        // Live upgrade on the same socket path flips immediately to native `meta`.
        record_endpoint_ipc_envelope(legacy_sock, true);
        assert!(endpoint_supports_ipc_envelope(legacy_sock));
        let (upgraded_wire, upgraded_legacy) = encode_request_envelope(
            legacy_sock,
            "req-2".into(),
            Method::SessionStart,
            &json!({ "incognito": true }),
            req_meta,
        )
        .unwrap();
        assert!(!upgraded_legacy);
        let upgraded_json: Value = serde_json::from_str(upgraded_wire.trim_end()).unwrap();
        assert!(upgraded_json.get("meta").is_some(), "{upgraded_json}");
        assert!(upgraded_json["params"].get("_caller_scope").is_none());
    }
}

#[cfg(unix)]
mod platform {
    use std::path::PathBuf;
    use std::time::Duration;

    use anyhow::{Context, Result};
    use bsk_protocol::Method;
    use serde::{Serialize, de::DeserializeOwned};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::time::timeout;

    use crate::ipc_client::{
        IpcRequestMeta, IpcResponseMeta, RpcOutcome, decode_response_envelope_with_mode,
        encode_request_envelope, random_id,
    };

    /// Connected IPC client. Holds an open UDS connection plus a buffered
    /// reader/writer pair.
    pub struct Client {
        stream: BufReader<tokio::net::unix::OwnedReadHalf>,
        write: tokio::net::unix::OwnedWriteHalf,
        sock_path: PathBuf,
    }

    impl Client {
        /// PID in the caller's namespace, supplied by the kernel, not JSON.
        pub(crate) fn peer_pid(&self) -> std::io::Result<Option<u32>> {
            let credentials = self.stream.get_ref().as_ref().peer_cred()?;
            Ok(credentials
                .pid()
                .and_then(|pid| u32::try_from(pid).ok())
                .filter(|pid| *pid > 0))
        }

        /// Connect directly to a UDS path (used by tests + auto-spawn
        /// after the parent has just written daemon.json).
        pub async fn connect_path(sock_path: PathBuf) -> Result<Self> {
            let stream = UnixStream::connect(&sock_path)
                .await
                .with_context(|| format!("connect IPC socket {}", sock_path.display()))?;
            let (read, write) = stream.into_split();
            Ok(Self {
                stream: BufReader::new(read),
                write,
                sock_path,
            })
        }

        /// Issue a typed RPC: serialise `params`, send one JSON line, read
        /// one JSON line back, deserialise into `R`. Honours an overall
        /// `timeout`.
        pub async fn call<P: Serialize, R: DeserializeOwned>(
            &mut self,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            self.call_with_id(random_id(), method, params, call_timeout)
                .await
        }

        /// Same as [`Client::call`] but uses the caller-provided
        /// `id` as the wire correlation id. Lets the SIGINT cancel
        /// helper refer back to a known id without racing the
        /// random_id() generator (M10.2).
        pub async fn call_with_id<P: Serialize, R: DeserializeOwned>(
            &mut self,
            id: String,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            self.call_envelope_with_id(id, method, params, IpcRequestMeta::default(), call_timeout)
                .await
                .map(|(outcome, _)| outcome)
        }

        pub async fn call_envelope<P: Serialize, R: DeserializeOwned>(
            &mut self,
            method: Method,
            params: &P,
            meta: IpcRequestMeta,
            call_timeout: Duration,
        ) -> Result<(RpcOutcome<R>, IpcResponseMeta)> {
            self.call_envelope_with_id(random_id(), method, params, meta, call_timeout)
                .await
        }

        pub async fn call_envelope_with_id<P: Serialize, R: DeserializeOwned>(
            &mut self,
            id: String,
            method: Method,
            params: &P,
            meta: IpcRequestMeta,
            call_timeout: Duration,
        ) -> Result<(RpcOutcome<R>, IpcResponseMeta)> {
            let (payload, legacy_framing) =
                encode_request_envelope(&self.sock_path, id.clone(), method, params, meta)?;

            timeout(call_timeout, async {
                self.write.write_all(payload.as_bytes()).await?;
                self.write.flush().await?;
                Result::<()>::Ok(())
            })
            .await
            .context("IPC write timed out")??;

            let mut line = String::new();
            timeout(call_timeout, self.stream.read_line(&mut line))
                .await
                .context("IPC read timed out")??;

            decode_response_envelope_with_mode(line.trim_end(), &id, legacy_framing)
        }

        /// Path of the socket this client connected through (debug helper).
        pub fn sock_path(&self) -> &std::path::Path {
            &self.sock_path
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use anyhow::{Context, Result};
    use bsk_protocol::Method;
    use serde::{Serialize, de::DeserializeOwned};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
    use tokio::time::{sleep, timeout};
    use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY};

    use crate::ipc_client::{
        IpcRequestMeta, IpcResponseMeta, RpcOutcome, decode_response_envelope_with_mode,
        encode_request_envelope, random_id,
    };

    pub struct Client {
        stream: BufReader<tokio::io::ReadHalf<NamedPipeClient>>,
        write: tokio::io::WriteHalf<NamedPipeClient>,
        pipe_name: PathBuf,
        peer_pid: std::io::Result<Option<u32>>,
    }

    impl Client {
        pub(crate) fn peer_pid(&self) -> std::io::Result<Option<u32>> {
            self.peer_pid
                .as_ref()
                .copied()
                .map_err(|err| std::io::Error::new(err.kind(), err.to_string()))
        }

        /// Total budget for retrying `ERROR_PIPE_BUSY` while connecting
        /// to the daemon's named pipe. Long enough to ride out a
        /// short-lived burst of clients, short enough that a wedged or
        /// preempted pipe surfaces as a clear error rather than a
        /// silent hang.
        const CONNECT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

        pub async fn connect_path(pipe_name: PathBuf) -> Result<Self> {
            let name = pipe_name.to_string_lossy().into_owned();
            let connect_loop = async {
                loop {
                    match ClientOptions::new().open(&name) {
                        Ok(client) => return Ok::<NamedPipeClient, anyhow::Error>(client),
                        Err(err) if err.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                            sleep(Duration::from_millis(50)).await;
                        }
                        Err(err) if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) => {
                            return Err(anyhow::Error::from(err).context(format!(
                                "connect IPC named pipe {name}: access denied. The current account \
                                 or access token lacks permission to open the daemon's pipe. This \
                                 can happen when a sandbox uses a different account or a restricted \
                                 token. See https://github.com/Tencent/BrowserSkill/blob/main/docs/\
                                 sandboxed-agents.md#windows-sandbox-users-access-denied-on-the-pipe"
                            )));
                        }
                        Err(err) => {
                            return Err(anyhow::Error::from(err)
                                .context(format!("connect IPC named pipe {name}")));
                        }
                    }
                }
            };
            let client = timeout(Self::CONNECT_BUSY_TIMEOUT, connect_loop)
                .await
                .map_err(|_| {
                    anyhow::anyhow!(
                        "named pipe {name} still busy after {:?}; daemon may be wedged or preempted",
                        Self::CONNECT_BUSY_TIMEOUT
                    )
                })??;
            // Fetch while the pipe handle is directly available; an identity
            // lookup failure affects management only, not normal IPC use.
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
            let mut pid = 0;
            let peer_pid =
                if unsafe { GetNamedPipeServerProcessId(client.as_raw_handle(), &mut pid) } != 0 {
                    Ok((pid > 0).then_some(pid))
                } else {
                    Err(std::io::Error::last_os_error())
                };
            let (read, write) = tokio::io::split(client);
            Ok(Self {
                stream: BufReader::new(read),
                write,
                pipe_name,
                peer_pid,
            })
        }

        pub async fn call<P: Serialize, R: DeserializeOwned>(
            &mut self,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            self.call_with_id(random_id(), method, params, call_timeout)
                .await
        }

        pub async fn call_with_id<P: Serialize, R: DeserializeOwned>(
            &mut self,
            id: String,
            method: Method,
            params: &P,
            call_timeout: Duration,
        ) -> Result<RpcOutcome<R>> {
            self.call_envelope_with_id(id, method, params, IpcRequestMeta::default(), call_timeout)
                .await
                .map(|(outcome, _)| outcome)
        }

        pub async fn call_envelope<P: Serialize, R: DeserializeOwned>(
            &mut self,
            method: Method,
            params: &P,
            meta: IpcRequestMeta,
            call_timeout: Duration,
        ) -> Result<(RpcOutcome<R>, IpcResponseMeta)> {
            self.call_envelope_with_id(random_id(), method, params, meta, call_timeout)
                .await
        }

        pub async fn call_envelope_with_id<P: Serialize, R: DeserializeOwned>(
            &mut self,
            id: String,
            method: Method,
            params: &P,
            meta: IpcRequestMeta,
            call_timeout: Duration,
        ) -> Result<(RpcOutcome<R>, IpcResponseMeta)> {
            let (payload, legacy_framing) =
                encode_request_envelope(&self.pipe_name, id.clone(), method, params, meta)?;

            timeout(call_timeout, async {
                self.write.write_all(payload.as_bytes()).await?;
                self.write.flush().await?;
                Result::<()>::Ok(())
            })
            .await
            .context("IPC write timed out")??;

            let mut line = String::new();
            timeout(call_timeout, self.stream.read_line(&mut line))
                .await
                .context("IPC read timed out")??;

            decode_response_envelope_with_mode(line.trim_end(), &id, legacy_framing)
        }

        pub fn sock_path(&self) -> &Path {
            &self.pipe_name
        }
    }
}

pub use platform::Client;

impl Client {
    /// Discover and verify the existing daemon without starting one.
    pub async fn connect() -> anyhow::Result<Self> {
        use crate::daemon::probe::{Probe, probe_async};
        match probe_async(
            std::time::Duration::from_secs(2),
            bsk_protocol::StatusParams::default(),
        )
        .await?
        {
            Probe::Ready(daemon) => Ok(daemon.client),
            Probe::Absent(_) => {
                anyhow::bail!("no listening daemon (daemon.json or IPC endpoint missing)")
            }
        }
    }
}

/// Result of a typed RPC: either the deserialised happy-path result or
/// the structured `RpcError` returned by the daemon.
pub type RpcOutcome<T> = std::result::Result<T, RpcError>;

/// Test/embed helper that exposes the M4/M5 `IpcClient` API on top of the
/// production [`Client`]. Skips the `daemon.json` pid-verification step
/// so integration tests can talk to an ad-hoc daemon spawned via
/// [`crate::daemon::run`].
pub struct IpcClient {
    inner: Client,
}

impl IpcClient {
    pub async fn connect(sock_path: impl AsRef<std::path::Path>) -> anyhow::Result<Self> {
        let inner = Client::connect_path(sock_path.as_ref().to_path_buf()).await?;
        Ok(Self { inner })
    }

    /// Issue a single RPC. The `_id` argument exists for API parity with
    /// the M4/M5 surface; the underlying [`Client::call`] generates its
    /// own correlation id since the wire id is only meaningful inside
    /// one connection.
    pub async fn call<P, R>(
        &mut self,
        _id: impl Into<bsk_protocol::RpcId>,
        method: bsk_protocol::Method,
        params: Option<P>,
        call_timeout: std::time::Duration,
    ) -> anyhow::Result<std::result::Result<R, RpcError>>
    where
        P: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        match params {
            Some(p) => self.inner.call::<P, R>(method, &p, call_timeout).await,
            None => self.inner.call::<(), R>(method, &(), call_timeout).await,
        }
    }

    /// Same as [`IpcClient::call`] but pins the wire correlation id
    /// so the SIGINT cancel helper can refer back to it (M10.2).
    pub async fn call_with_id<P, R>(
        &mut self,
        id: bsk_protocol::RpcId,
        method: bsk_protocol::Method,
        params: Option<P>,
        call_timeout: std::time::Duration,
    ) -> anyhow::Result<std::result::Result<R, RpcError>>
    where
        P: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        match params {
            Some(p) => {
                self.inner
                    .call_with_id::<P, R>(id, method, &p, call_timeout)
                    .await
            }
            None => {
                self.inner
                    .call_with_id::<(), R>(id, method, &(), call_timeout)
                    .await
            }
        }
    }

    pub async fn call_envelope<P, R>(
        &mut self,
        id: impl Into<bsk_protocol::RpcId>,
        method: bsk_protocol::Method,
        params: Option<P>,
        meta: IpcRequestMeta,
        call_timeout: std::time::Duration,
    ) -> anyhow::Result<(std::result::Result<R, RpcError>, IpcResponseMeta)>
    where
        P: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        self.call_envelope_with_id(id.into(), method, params, meta, call_timeout)
            .await
    }

    pub async fn call_envelope_with_id<P, R>(
        &mut self,
        id: bsk_protocol::RpcId,
        method: bsk_protocol::Method,
        params: Option<P>,
        meta: IpcRequestMeta,
        call_timeout: std::time::Duration,
    ) -> anyhow::Result<(std::result::Result<R, RpcError>, IpcResponseMeta)>
    where
        P: serde::Serialize,
        R: serde::de::DeserializeOwned,
    {
        match params {
            Some(p) => {
                self.inner
                    .call_envelope_with_id::<P, R>(id, method, &p, meta, call_timeout)
                    .await
            }
            None => {
                self.inner
                    .call_envelope_with_id::<(), R>(id, method, &(), meta, call_timeout)
                    .await
            }
        }
    }
}

/// Generate an opaque RPC correlation id (12 lowercase hex chars).
fn random_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; 6];
    rng.fill(&mut bytes[..]);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
