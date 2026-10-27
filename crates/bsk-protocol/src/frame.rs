//! JSON-RPC–style frames shared by CLI↔daemon and daemon↔extension (§4.1).

use std::fmt;

use serde::de::{self, MapAccess, Visitor};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{DecodeError, RpcError};
use crate::method::Method;

pub type RpcId = String;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RequestFrame {
    pub id: RpcId,
    pub method: Method,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventFrame {
    pub event: EventKind,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    #[serde(rename = "session.user_interrupt")]
    SessionUserInterrupt,
    #[serde(rename = "session.interaction_changed")]
    SessionInteractionChanged,
    #[serde(rename = "browser.disconnected")]
    BrowserDisconnected,
    #[serde(rename = "browser.connected")]
    BrowserConnected,
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
            let payload = payload.unwrap_or(serde_json::Value::Object(Default::default()));
            return Ok(Frame::Event(EventFrame { event, payload }));
        }

        if method.is_some() {
            let id = id.ok_or_else(|| de::Error::missing_field("id"))?;
            let method = method.ok_or_else(|| de::Error::missing_field("method"))?;
            return Ok(Frame::Request(RequestFrame { id, method, params }));
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
        assert_eq!(frame.event, EventKind::SystemHeartbeat);
    }

    #[test]
    fn session_user_interrupt_serialises_as_snake_case() {
        let v = serde_json::to_value(EventKind::SessionUserInterrupt).unwrap();
        assert_eq!(v, serde_json::json!("session.user_interrupt"));
    }

    #[test]
    fn session_user_interrupt_event_frame_round_trips() {
        let frame = EventFrame {
            event: EventKind::SessionUserInterrupt,
            payload: serde_json::json!({ "session_id": "sess-1" }),
        };
        let v = serde_json::to_value(&frame).unwrap();
        let back: EventFrame = serde_json::from_value(v).unwrap();
        assert_eq!(back.event, EventKind::SessionUserInterrupt);
        assert_eq!(
            back.payload.get("session_id").and_then(|v| v.as_str()),
            Some("sess-1"),
        );
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
