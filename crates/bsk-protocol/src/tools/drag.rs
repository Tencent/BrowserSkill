//! One bounded mouse drag, with element identity at both ends.
use super::{JavaScriptDialogInfo, KeyModifier, MouseButton};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DragPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DragTarget {
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Offset from the visible action point, in top-level viewport CSS pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<DragPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DragParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    pub source: DragTarget,
    /// Exactly one of target or delta is required.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<DragTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<DragPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<MouseButton>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    /// Delay after pressing and before moving. Defaults to zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0, max = 5000))]
    pub hold_ms: Option<u32>,
    /// Travel duration, excluding hold. Defaults to 500 ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 5000))]
    pub duration_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DragResult {
    pub tab_id: i64,
    pub source: DragPoint,
    pub target: DragPoint,
    /// Input delivery completed; application acceptance must be observed separately.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}
