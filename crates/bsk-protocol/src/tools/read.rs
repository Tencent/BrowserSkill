//! Declarative, synchronous DOM reads. No caller-supplied JavaScript is executed.
use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const DOM_READ_PROTOCOL: &str = "1.9";
pub fn supports_dom_read(protocol: &str) -> bool {
    crate::compatibility::Feature::DomRead.supports(crate::compatibility::Peer::Extension, protocol)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadField {
    #[schemars(length(min = 1, max = 128))]
    pub key: String,
    pub read: DomRead,
    /// Relative selector matching at most one descendant; omitted means the item itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 2048))]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 128))]
    pub attribute: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DomRead {
    Text,
    Attribute,
    Value,
    Checked,
    Exists,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Optional cooperation context validated by the extension without renewing control.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_id: Option<String>,
    /// CSS in the main document. All matches, up to max_nodes; no selector means the root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 2048))]
    pub selector: Option<String>,
    /// Exact observed DOM node, including iframe and shadow nodes. Exclusive with selector.
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub ref_: Option<String>,
    /// Defaults to [{"key":"text","read":"text"}].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 32))]
    pub fields: Option<Vec<ReadField>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 1000))]
    pub max_nodes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1024, max = 1048576))]
    pub max_bytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 100, max = 10000))]
    pub timeout_ms: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ReadItem {
    #[serde(rename = "ref")]
    pub ref_: String,
    pub values: IndexMap<String, serde_json::Value>,
    pub redacted: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ReadResult {
    pub tab_id: i64,
    pub page_url: String,
    pub frame_url: String,
    pub frame_id: String,
    pub title: String,
    pub captured_at: String,
    pub items: Vec<ReadItem>,
    pub truncated: bool,
    /// A live sample, not an action authorization or a complete dataset.
    pub scope: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn no_scripts_or_open_ended_properties() {
        for extra in [json!({"expression":"alert(1)"}), json!({"readonly":true})] {
            let mut input = json!({"session_id":"s"});
            input
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert!(serde_json::from_value::<ReadParams>(input).is_err());
        }
        assert!(serde_json::from_value::<ReadField>(json!({"key":"x","read":"onclick"})).is_err());
        assert!(
            serde_json::from_value::<ReadField>(json!({"key":"x","read":"text","expression":"x"}))
                .is_err()
        );
    }
    #[test]
    fn version_is_explicit_and_compatible() {
        for p in ["1.8", "2.0", "bad"] {
            assert!(!supports_dom_read(p));
        }
        for p in ["1.9", "1.10"] {
            assert!(supports_dom_read(p));
        }
    }
}
