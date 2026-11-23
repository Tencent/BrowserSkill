//! One bounded mouse gesture, with element identity at both ends.
use super::{ActionExpectation, JavaScriptDialogInfo, KeyModifier, MouseButton};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum DragMode {
    PressMoveRelease,
    ClickMoveClick,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
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
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
    /// Context actually returned by sync. Reusable for target-policy DOM actions;
    /// strict policy consumes it after one action. Never fill it from cached state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub context_id: Option<String>,
    /// Sync's single-use baseline for untargeted/visual actions under target policy,
    /// including untargeted keys and displacement-only drags. Drags with a
    /// target ref/selector need only context_id. A script needs it only when it
    /// states no expect facts; passing both checks the whole page as well.
    /// Strict-policy drag instead accepts its legacy ref-map observation token.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
    /// Strict policy only: observed decision regions. Target policy requires exact
    /// business facts in expect; regions cannot be translated to facts automatically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Vec<String>", length(max = 16))]
    pub depends_on: Option<Vec<String>>,
    /// Literal conditions checked before input. Selectors search the main document;
    /// use observed refs for iframe/shadow-root targets. Text includes all whitespace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "Vec<ActionExpectation>", length(max = 16))]
    pub expect: Option<Vec<ActionExpectation>>,
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
}
