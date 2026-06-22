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
    #[serde(rename = "session.activity")]
    SessionActivity,
    #[serde(rename = "session.window_closed")]
    SessionWindowClosed,
    #[serde(rename = "session.user_interrupt")]
    SessionUserInterrupt,
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
            result: Option<serde_json::Value>,
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
}
