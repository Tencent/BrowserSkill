//! One bounded mouse gesture, with element identity at both ends.
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

pub const CLICK_MOVE_CLICK_PROTOCOL: &str = "1.7";

pub fn supports_click_move_click(protocol: &str) -> bool {
    crate::system::compare_protocol(protocol, "2.0") == Some(std::cmp::Ordering::Less)
        && matches!(
            crate::system::compare_protocol(protocol, CLICK_MOVE_CLICK_PROTOCOL),
            Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
        )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DragMode {
    PressMoveRelease,
    ClickMoveClick,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DragParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    pub source: DragTarget,
    /// Defaults to press-move-release. Click-move-click requires target and zero hold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<DragMode>,
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mode_is_optional_and_explicit_on_the_wire() {
        let base =
            serde_json::json!({"session_id":"s", "source":{"ref":"e1"}, "target":{"ref":"e2"}});
        assert_eq!(
            serde_json::from_value::<DragParams>(base.clone())
                .unwrap()
                .mode,
            None
        );
        let mut new = base;
        new["mode"] = "click-move-click".into();
        let params: DragParams = serde_json::from_value(new.clone()).unwrap();
        assert_eq!(params.mode, Some(DragMode::ClickMoveClick));
        assert_eq!(serde_json::to_value(params).unwrap(), new);
        new["mode"] = "auto".into();
        assert!(serde_json::from_value::<DragParams>(new).is_err());
    }
    #[test]
    fn click_mode_requires_the_new_wire_semantics() {
        for old in ["", "garbage", "1.0", "1.6", "2.0"] {
            assert!(!supports_click_move_click(old));
        }
        for new in ["1.7", "1.8"] {
            assert!(supports_click_move_click(new));
        }
    }
}
