//! JSON-RPC–style frames shared by CLI↔daemon and daemon↔extension (§4.1).

use std::fmt;

use schemars::JsonSchema;
use serde::de::{self, MapAccess, Visitor};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{DecodeError, RpcError};
use crate::method::Method;

pub type RpcId = String;

/// Daemon-to-extension WS correlation identifiers carried alongside an
/// outbound [`RequestFrame`] at the frame envelope level, keeping `params`
/// bit-for-bit clean for schema validation and downstream dispatch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WsCorrelation {
    pub audit_id: Option<String>,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequestFrame {
    pub id: RpcId,
    pub method: Method,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
    /// Daemon-issued operation audit correlation id on outbound WS requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_id: Option<String>,
    /// Daemon-issued dialog-retention operation correlation id on outbound WS requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

impl RequestFrame {
    /// Build an outbound daemon→extension WS request frame with top-level
    /// [`WsCorrelation`] fields without mutating `params`.
    pub fn for_extension_ws(
        id: RpcId,
        method: Method,
        params: serde_json::Value,
        correlation: &WsCorrelation,
    ) -> Self {
        Self {
            id,
            method,
            params: Some(params),
            audit_id: correlation.audit_id.clone(),
            operation_id: correlation.operation_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResponseFrame {
    pub id: RpcId,
    pub body: ResponseBody,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ResponseBody {
    Ok(serde_json::Value),
    Err(RpcError),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct EmptyEventPayload {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AuditContextEvent {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DialogChangedEvent {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default)]
    pub dialog: Option<crate::tools::PendingJavaScriptDialog>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionActivityEvent {
    pub session_id: String,
    pub idle_protected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionWindowClosedReason {
    UserClosedWindow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionWindowClosedEvent {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<SessionWindowClosedReason>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub return_failures: Vec<crate::tools::ReturnFailure>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionEndedReason {
    UserMovedTab,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionEndedEvent {
    pub session_id: String,
    pub reason: SessionEndedReason,
    pub tab_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionUserInterruptEvent {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SessionInteractionChangedEvent {
    pub session_id: String,
    pub interaction: crate::tools::InteractionPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
#[serde(tag = "event", content = "payload")]
pub enum EventFrame {
    #[serde(rename = "audit.context")]
    AuditContext(AuditContextEvent),
    #[serde(rename = "dialog.changed")]
    DialogChanged(DialogChangedEvent),
    #[serde(rename = "system.heartbeat")]
    SystemHeartbeat(EmptyEventPayload),
    #[serde(rename = "session.activity")]
    SessionActivity(SessionActivityEvent),
    #[serde(rename = "session.window_closed")]
    SessionWindowClosed(SessionWindowClosedEvent),
    #[serde(rename = "session.ended")]
    SessionEnded(SessionEndedEvent),
    #[serde(rename = "session.user_interrupt")]
    SessionUserInterrupt(SessionUserInterruptEvent),
    #[serde(rename = "session.interaction_changed")]
    SessionInteractionChanged(SessionInteractionChangedEvent),
    #[serde(rename = "browser.disconnected")]
    BrowserDisconnected(EmptyEventPayload),
    #[serde(rename = "browser.connected")]
    BrowserConnected(EmptyEventPayload),
}

impl EventFrame {
    pub const fn kind(&self) -> EventKind {
        match self {
            Self::AuditContext(_) => EventKind::AuditContext,
            Self::DialogChanged(_) => EventKind::DialogChanged,
            Self::SystemHeartbeat(_) => EventKind::SystemHeartbeat,
            Self::SessionActivity(_) => EventKind::SessionActivity,
            Self::SessionWindowClosed(_) => EventKind::SessionWindowClosed,
            Self::SessionEnded(_) => EventKind::SessionEnded,
            Self::SessionUserInterrupt(_) => EventKind::SessionUserInterrupt,
            Self::SessionInteractionChanged(_) => EventKind::SessionInteractionChanged,
            Self::BrowserDisconnected(_) => EventKind::BrowserDisconnected,
            Self::BrowserConnected(_) => EventKind::BrowserConnected,
        }
    }

    pub fn from_parts(
        kind: EventKind,
        payload: serde_json::Value,
    ) -> Result<Self, serde_json::Error> {
        Ok(match kind {
            EventKind::AuditContext => Self::AuditContext(serde_json::from_value(payload)?),
            EventKind::DialogChanged => Self::DialogChanged(serde_json::from_value(payload)?),
            EventKind::SystemHeartbeat => Self::SystemHeartbeat(serde_json::from_value(payload)?),
            EventKind::SessionActivity => Self::SessionActivity(serde_json::from_value(payload)?),
            EventKind::SessionWindowClosed => {
                Self::SessionWindowClosed(serde_json::from_value(payload)?)
            }
            EventKind::SessionEnded => Self::SessionEnded(serde_json::from_value(payload)?),
            EventKind::SessionUserInterrupt => {
                Self::SessionUserInterrupt(serde_json::from_value(payload)?)
            }
            EventKind::SessionInteractionChanged => {
                Self::SessionInteractionChanged(serde_json::from_value(payload)?)
            }
            EventKind::BrowserDisconnected => {
                Self::BrowserDisconnected(serde_json::from_value(payload)?)
            }
            EventKind::BrowserConnected => Self::BrowserConnected(serde_json::from_value(payload)?),
        })
    }
}

impl<'de> Deserialize<'de> for EventFrame {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct WireEventFrame {
            event: EventKind,
            #[serde(default = "empty_json_object")]
            payload: serde_json::Value,
        }
        let wire = WireEventFrame::deserialize(deserializer)?;
        Self::from_parts(wire.event, wire.payload).map_err(de::Error::custom)
    }
}

fn empty_json_object() -> serde_json::Value {
    serde_json::Value::Object(Default::default())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
pub enum EventKind {
    #[serde(rename = "audit.context")]
    AuditContext,
    #[serde(rename = "dialog.changed")]
    DialogChanged,
    /// Application-level keepalive emitted by the extension roughly
    /// every 20s while the WS link is up. Two purposes: (1) the
    /// send/receive activity resets the MV3 service-worker idle timer
    /// (Chrome 116+), keeping the worker — and therefore the socket —
    /// alive during use; (2) the daemon treats it as a liveness signal
    /// so a silently-dead browser can be reaped. Carries no payload.
    #[serde(rename = "system.heartbeat")]
    SystemHeartbeat,
    #[serde(rename = "session.activity")]
    SessionActivity,
    #[serde(rename = "session.window_closed")]
    SessionWindowClosed,
    /// The extension ended the session after a user moved a controlled tab.
    #[serde(rename = "session.ended")]
    SessionEnded,
    #[serde(rename = "session.user_interrupt")]
    SessionUserInterrupt,
    #[serde(rename = "session.interaction_changed")]
    SessionInteractionChanged,
    #[serde(rename = "browser.disconnected")]
    BrowserDisconnected,
    #[serde(rename = "browser.connected")]
    BrowserConnected,
}

impl EventKind {
    pub const ALL: &'static [Self] = &[
        Self::AuditContext,
        Self::DialogChanged,
        Self::SystemHeartbeat,
        Self::SessionActivity,
        Self::SessionWindowClosed,
        Self::SessionEnded,
        Self::SessionUserInterrupt,
        Self::SessionInteractionChanged,
        Self::BrowserDisconnected,
        Self::BrowserConnected,
    ];

    pub const fn wire_name(&self) -> &'static str {
        match self {
            Self::AuditContext => "audit.context",
            Self::DialogChanged => "dialog.changed",
            Self::SystemHeartbeat => "system.heartbeat",
            Self::SessionActivity => "session.activity",
            Self::SessionWindowClosed => "session.window_closed",
            Self::SessionEnded => "session.ended",
            Self::SessionUserInterrupt => "session.user_interrupt",
            Self::SessionInteractionChanged => "session.interaction_changed",
            Self::BrowserDisconnected => "browser.disconnected",
            Self::BrowserConnected => "browser.connected",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Request(RequestFrame),
    Response(ResponseFrame),
    Event(EventFrame),
}

impl Serialize for ResponseFrame {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut s = serializer.serialize_struct("ResponseFrame", 2)?;
        s.serialize_field("id", &self.id)?;
        match &self.body {
            ResponseBody::Ok(v) => s.serialize_field("result", v)?,
            ResponseBody::Err(e) => s.serialize_field("error", e)?,
        }
        s.end()
    }
}

impl<'de> Deserialize<'de> for ResponseFrame {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Flat {
            id: RpcId,
            #[serde(default, deserialize_with = "de_present_field")]
            result: Option<serde_json::Value>,
            #[serde(default, deserialize_with = "de_present_field")]
            error: Option<RpcError>,
        }

        let Flat { id, result, error } = Flat::deserialize(deserializer)?;
        match (result, error) {
            (Some(v), None) => Ok(ResponseFrame {
                id,
                body: ResponseBody::Ok(v),
            }),
            (None, Some(e)) => Ok(ResponseFrame {
                id,
                body: ResponseBody::Err(e),
            }),
            (None, None) => Err(de::Error::custom(DecodeError::AmbiguousResponse)),
            (Some(_), Some(_)) => Err(de::Error::custom(DecodeError::AmbiguousResponse)),
        }
    }
}

// Deserialize present fields as their actual type: Value accepts null, but
// RpcError requires an error object. Missing fields use #[serde(default)].
fn de_present_field<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl Serialize for Frame {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Frame::Request(v) => v.serialize(serializer),
            Frame::Response(v) => v.serialize(serializer),
            Frame::Event(v) => v.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Frame {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(FrameVisitor)
    }
}

struct FrameVisitor;

impl<'de> Visitor<'de> for FrameVisitor {
    type Value = Frame;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "a protocol frame object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut id = None::<RpcId>;
        let mut method = None::<Method>;
        let mut params = None::<serde_json::Value>;
        let mut audit_id = None::<String>;
        let mut operation_id = None::<String>;
        let mut result = None::<serde_json::Value>;
        let mut error = None::<RpcError>;
        let mut event = None::<EventKind>;
        let mut payload = None::<serde_json::Value>;

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
                "audit_id" => {
                    if audit_id.is_some() {
                        return Err(de::Error::duplicate_field("audit_id"));
                    }
                    audit_id = Some(map.next_value()?);
                }
                "operation_id" => {
                    if operation_id.is_some() {
                        return Err(de::Error::duplicate_field("operation_id"));
                    }
                    operation_id = Some(map.next_value()?);
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
                other => {
                    let _: de::IgnoredAny = map.next_value()?;
                    let _ = other;
                }
            }
        }

        if event.is_some() {
            let event = event.ok_or_else(|| de::Error::missing_field("event"))?;
            let payload = payload.unwrap_or_else(empty_json_object);
            let event_frame = EventFrame::from_parts(event, payload).map_err(de::Error::custom)?;
            return Ok(Frame::Event(event_frame));
        }

        if method.is_some() {
            let id = id.ok_or_else(|| de::Error::missing_field("id"))?;
            let method = method.ok_or_else(|| de::Error::missing_field("method"))?;
            return Ok(Frame::Request(RequestFrame {
                id,
                method,
                params,
                audit_id,
                operation_id,
            }));
        }

        let id = id.ok_or_else(|| de::Error::missing_field("id"))?;
        match (result, error) {
            (Some(v), None) => Ok(Frame::Response(ResponseFrame {
                id,
                body: ResponseBody::Ok(v),
            })),
            (None, Some(e)) => Ok(Frame::Response(ResponseFrame {
                id,
                body: ResponseBody::Err(e),
            })),
            (None, None) => Err(de::Error::custom(DecodeError::InvalidFrame(
                "expected result or error".into(),
            ))),
            (Some(_), Some(_)) => Err(de::Error::custom(DecodeError::AmbiguousResponse)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_heartbeat_serialises_as_dotted_name() {
        // The extension hardcodes the literal string "system.heartbeat"
        // when it emits the keepalive event; this locks the daemon-side
        // serde name to the same wire value so a rename cannot silently
        // break liveness/keepalive.
        let v = serde_json::to_value(EventKind::SystemHeartbeat).unwrap();
        assert_eq!(v, serde_json::json!("system.heartbeat"));
    }

    #[test]
    fn system_heartbeat_event_frame_round_trips_from_extension_shape() {
        // Mirrors exactly what the extension sends: { event, payload: {} }.
        let wire = serde_json::json!({ "event": "system.heartbeat", "payload": {} });
        let frame: EventFrame = serde_json::from_value(wire).unwrap();
        assert_eq!(frame.kind(), EventKind::SystemHeartbeat);
        assert_eq!(frame, EventFrame::SystemHeartbeat(EmptyEventPayload {}));
    }

    #[test]
    fn session_user_interrupt_serialises_as_snake_case() {
        let v = serde_json::to_value(EventKind::SessionUserInterrupt).unwrap();
        assert_eq!(v, serde_json::json!("session.user_interrupt"));
    }

    #[test]
    fn session_user_interrupt_event_frame_round_trips() {
        let frame = EventFrame::SessionUserInterrupt(SessionUserInterruptEvent {
            session_id: "sess-1".into(),
        });
        let v = serde_json::to_value(&frame).unwrap();
        let back: EventFrame = serde_json::from_value(v).unwrap();
        assert_eq!(back.kind(), EventKind::SessionUserInterrupt);
        assert_eq!(
            back,
            EventFrame::SessionUserInterrupt(SessionUserInterruptEvent {
                session_id: "sess-1".into(),
            })
        );
    }

    #[test]
    fn session_ended_round_trips_from_extension_shape() {
        let wire = serde_json::json!({
            "event": "session.ended",
            "payload": { "session_id": "sess-1", "reason": "user_moved_tab", "tab_id": 42 },
        });
        let frame: Frame = serde_json::from_value(wire.clone()).unwrap();
        assert!(matches!(
            &frame,
            Frame::Event(EventFrame::SessionEnded(ev))
                if ev.session_id == "sess-1"
                    && ev.reason == SessionEndedReason::UserMovedTab
                    && ev.tab_id == 42
        ));
        assert_eq!(serde_json::to_value(frame).unwrap(), wire);
    }

    #[test]
    fn request_frame_for_extension_ws_carries_correlation_out_of_band() {
        let original_params = serde_json::json!({ "session_id": "s1", "selector": "#go" });
        let req = RequestFrame::for_extension_ws(
            "rpc-9".into(),
            Method::ToolClick,
            original_params.clone(),
            &WsCorrelation {
                audit_id: Some("aud-1".into()),
                operation_id: Some("op-1".into()),
            },
        );
        let wire = serde_json::to_value(Frame::Request(req.clone())).unwrap();
        assert_eq!(wire["params"], original_params);
        assert_eq!(wire["audit_id"], "aud-1");
        assert_eq!(wire["operation_id"], "op-1");
        assert!(wire["params"].get("_audit_id").is_none());
        assert!(wire["params"].get("_operation_id").is_none());
        let decoded: Frame = serde_json::from_value(wire).unwrap();
        assert_eq!(decoded, Frame::Request(req));
    }

    #[test]
    fn event_kind_all_matches_wire_names_uniquely() {
        let mut seen = std::collections::HashSet::new();
        for &kind in EventKind::ALL {
            assert!(seen.insert(kind), "duplicate EventKind in ALL: {kind:?}");
            assert_eq!(
                serde_json::to_value(kind).unwrap(),
                serde_json::Value::String(kind.wire_name().to_owned()),
            );
        }
    }

    #[test]
    fn explicit_null_result_decodes_as_ok_null() {
        let wire = serde_json::json!({ "id": "rpc-1", "result": null });
        let frame: Frame = serde_json::from_value(wire).unwrap();
        assert_eq!(
            frame,
            Frame::Response(ResponseFrame {
                id: "rpc-1".into(),
                body: ResponseBody::Ok(serde_json::Value::Null),
            })
        );
    }

    #[test]
    fn explicit_null_result_response_frame_decodes_as_ok_null() {
        let wire = r#"{"id":"rpc-2","result":null}"#;
        let resp: ResponseFrame = serde_json::from_str(wire).unwrap();
        assert_eq!(resp.id, "rpc-2");
        assert_eq!(resp.body, ResponseBody::Ok(serde_json::Value::Null));
    }

    #[test]
    fn null_result_round_trips_through_serialise() {
        let response = ResponseFrame {
            id: "rpc-3".into(),
            body: ResponseBody::Ok(serde_json::Value::Null),
        };
        let wire = serde_json::to_value(&response).unwrap();
        assert_eq!(wire, serde_json::json!({ "id": "rpc-3", "result": null }));
        let back: ResponseFrame = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(back, response);
        let frame: Frame = serde_json::from_value(wire).unwrap();
        assert_eq!(frame, Frame::Response(response));
    }

    #[test]
    fn missing_result_and_error_still_rejected() {
        let wire = serde_json::json!({ "id": "rpc-4" });
        assert!(serde_json::from_value::<Frame>(wire.clone()).is_err());
        assert!(serde_json::from_value::<ResponseFrame>(wire).is_err());
    }

    #[test]
    fn result_and_error_together_rejected() {
        for result in [serde_json::Value::Null, serde_json::json!({ "pong": true })] {
            let wire = serde_json::json!({
                "id": "rpc-5",
                "result": result,
                "error": { "code": "protocol_error", "message": "test error" },
            });
            assert!(serde_json::from_value::<Frame>(wire.clone()).is_err());
            assert!(serde_json::from_value::<ResponseFrame>(wire).is_err());
        }
    }

    #[test]
    fn duplicate_result_including_null_rejected() {
        for wire in [
            r#"{"id":"rpc-6","result":null,"result":1}"#,
            r#"{"id":"rpc-6","result":1,"result":null}"#,
        ] {
            assert!(serde_json::from_str::<Frame>(wire).is_err());
            assert!(serde_json::from_str::<ResponseFrame>(wire).is_err());
        }
    }

    #[test]
    fn null_error_is_rejected() {
        for wire in [
            r#"{"id":"rpc-null-error","error":null}"#,
            r#"{"id":"rpc-null-error","result":null,"error":null}"#,
            r#"{"id":"rpc-null-error","result":true,"error":null}"#,
        ] {
            assert!(serde_json::from_str::<Frame>(wire).is_err());
            assert!(serde_json::from_str::<ResponseFrame>(wire).is_err());
        }
    }

    #[test]
    fn non_null_results_and_errors_decode_consistently() {
        for wire in [
            serde_json::json!({ "id": "rpc-7", "result": false }),
            serde_json::json!({ "id": "rpc-7", "result": 0 }),
            serde_json::json!({ "id": "rpc-7", "result": "" }),
            serde_json::json!({ "id": "rpc-7", "result": [] }),
            serde_json::json!({ "id": "rpc-7", "result": {} }),
            serde_json::json!({
                "id": "rpc-7",
                "error": { "code": "protocol_error", "message": "test error" },
            }),
        ] {
            let response: ResponseFrame = serde_json::from_value(wire.clone()).unwrap();
            let frame: Frame = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(frame, Frame::Response(response.clone()));
            assert_eq!(serde_json::to_value(response).unwrap(), wire);
        }
    }
}
