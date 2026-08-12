//! DOM interaction tools (`tool.click`, `tool.fill`, `tool.press`,
//! `tool.select`).
//!
//! Element-targeted tools accept either a snapshot `ref` (`@e<N>` form,
//! normalised against the session's RefStore) **or** a CSS selector
//! resolved at call time. Modifiers / mouse buttons are encoded as
//! lowercase JSON strings so the same wire shape works for CLI flags and
//! the extension's CDP bridge.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::JavaScriptDialogInfo;

/// Keyboard modifier flags. Multiple flags may be combined; the
/// extension folds them into CDP's bitfield (`alt=1, ctrl=2, meta=4,
/// shift=8`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum KeyModifier {
    Alt,
    Ctrl,
    Meta,
    Shift,
}

/// Mouse button selector for `tool.click`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    #[default]
    Left,
    Middle,
    Right,
}

// ---------------------------------------------------------------------------
// click
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ClickParams {
    pub session_id: String,
    /// Optional `@e<N>` ref allocated by the last `tool.snapshot`.
    /// Mutually exclusive with `selector` (caller must supply exactly
    /// one). Accepts both `"e3"` and `"@e3"`.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<MouseButton>,
    /// Number of consecutive mouse presses (double-click = 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub click_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ClickResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Viewport-relative click coordinates (CSS pixels). Reported so
    /// agents can correlate with a follow-up `tool.screenshot`.
    pub x: f64,
    pub y: f64,
    /// Native JS dialogs observed and auto-handled during this call.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// hover
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HoverParams {
    pub session_id: String,
    /// Optional `@e<N>` ref allocated by the last observation.
    /// Mutually exclusive with `selector`.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    /// Wait after the mouse move so hover-triggered UI can settle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0))]
    pub settle_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HoverResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Viewport-relative hover coordinates (CSS pixels).
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// fill
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FillParams {
    pub session_id: String,
    pub value: String,
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Clear the field before typing. Defaults to `true`; pass `false`
    /// to append instead of replacing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_before: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FillResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// UTF-16 code-unit length of the value that was finally typed
    /// (matches what `input.value.length` would report in the page).
    pub value_length: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// press
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PressParams {
    pub session_id: String,
    /// Logical key name. Accepts CDP `key` strings (`Enter`, `Escape`,
    /// `ArrowDown`, single characters like `a`), or a compound
    /// expression such as `Ctrl+A` / `Meta+Shift+P`. Modifiers in the
    /// compound form combine with anything supplied via `modifiers`.
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    /// Optional target to focus before dispatching the key.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Hold the key down for this many milliseconds between `keyDown`
    /// and `keyUp`. Useful for testing long-press handlers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PressResult {
    pub tab_id: i64,
    pub key: String,
    pub code: String,
    #[serde(default)]
    pub modifiers: Vec<KeyModifier>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SelectParams {
    pub session_id: String,
    /// Option `value` strings to set as the final selection. For a
    /// single-select `<select>` exactly one value is required; for
    /// `<select multiple>` the list replaces the current selection
    /// (an empty list clears all selections).
    pub values: Vec<String>,
    /// Optional `@e<N>` ref allocated by the last `tool.snapshot`.
    /// Mutually exclusive with `selector`. Accepts both `"e3"` and
    /// `"@e3"`.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    /// CSS selector resolved against the live DOM. Mutually exclusive
    /// with `ref_`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Maximum time the daemon waits for the tool call before timing out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SelectResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Whether the target `<select>` had the `multiple` attribute.
    pub multiple: bool,
    /// Final selected option `value` attributes after the call.
    pub selected_values: Vec<String>,
    /// Visible labels of the selected options (same order as
    /// `selected_values`).
    pub selected_labels: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// drag
// ---------------------------------------------------------------------------

/// Drag parameters. Supports three targeting modes:
///
/// 1. **Element drag** (`ref` / `selector` + `dx` / `dy`): press the
///    element's centre, move by the given pixel delta (CSS pixels), then
///    release. `steps` interpolates a human-like curved path (default 30).
/// 2. **Coordinate drag** (`from_x` / `from_y` + `dx` / `dy`): raw
///    viewport-coordinate drag, no element lookup. Useful for slider
///    CAPTCHAs inside cross-origin iframes where DOM access is blocked.
/// 3. **Absolute path** (`points`): explicit list of `[x, y]` viewport
///    points; press at the first, move through the rest, release at the
///    last.
///
/// The drag is dispatched through CDP `Input.dispatchMouseEvent`
/// (`mousePressed` → `mouseMoved` × N → `mouseReleased`), so events are
/// trusted (native `isTrusted=true`), which is what slider CAPTCHA
/// services such as Aliyun `nc_1_nocaptcha` check for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DragParams {
    pub session_id: String,
    /// Optional `@e<N>` ref for element-targeted drags. Mutually
    /// exclusive with `selector` / `from_x` / `points`.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Start X (viewport CSS px) for coordinate drags. Requires `from_y`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_x: Option<f64>,
    /// Start Y (viewport CSS px) for coordinate drags. Requires `from_x`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_y: Option<f64>,
    /// Horizontal delta in CSS px (element & coordinate modes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dx: Option<f64>,
    /// Vertical delta in CSS px (element & coordinate modes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dy: Option<f64>,
    /// Explicit viewport points `[x, y]` for absolute-path drags.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<Vec<f64>>>,
    /// Number of interpolation steps for delta drags (default 30).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub steps: Option<u32>,
    /// Per-step delay in ms (default 8). Slightly randomises timing to
    /// look human.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_delay_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<MouseButton>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<KeyModifier>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DragResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Start point of the drag (viewport CSS px).
    pub from_x: f64,
    pub from_y: f64,
    /// End point of the drag (viewport CSS px).
    pub to_x: f64,
    pub to_y: f64,
    /// Number of mouseMoved steps actually dispatched.
    pub steps: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn click_params_serialise_ref_field_name() {
        let p = ClickParams {
            session_id: "abcd".into(),
            ref_: Some("@e3".into()),
            selector: None,
            tab_id: Some(42),
            button: Some(MouseButton::Left),
            click_count: Some(1),
            modifiers: Some(vec![KeyModifier::Ctrl]),
            timeout_ms: Some(5_000),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("ref").and_then(|v| v.as_str()), Some("@e3"));
        assert!(v.get("ref_").is_none());
        let round: ClickParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn click_params_accept_legacy_ref_alias() {
        let p: ClickParams = serde_json::from_value(json!({
            "session_id": "a",
            "ref_": "e1",
            "selector": null,
        }))
        .unwrap();
        assert_eq!(p.ref_.as_deref(), Some("e1"));
    }

    #[test]
    fn hover_params_serialise_ref_field_name() {
        let p = HoverParams {
            session_id: "abcd".into(),
            ref_: Some("@e3".into()),
            selector: None,
            tab_id: Some(42),
            modifiers: Some(vec![KeyModifier::Shift]),
            settle_ms: Some(200),
            timeout_ms: Some(5_000),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("ref").and_then(|v| v.as_str()), Some("@e3"));
        assert!(v.get("ref_").is_none());
        let round: HoverParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn modifiers_render_as_lowercase_strings() {
        let v = serde_json::to_value(KeyModifier::Ctrl).unwrap();
        assert_eq!(v, json!("ctrl"));
        let v = serde_json::to_value(KeyModifier::Meta).unwrap();
        assert_eq!(v, json!("meta"));
    }

    #[test]
    fn press_result_round_trips() {
        let r = PressResult {
            tab_id: 5,
            key: "a".into(),
            code: "KeyA".into(),
            modifiers: vec![KeyModifier::Ctrl, KeyModifier::Shift],
            dialogs: vec![],
        };
        let v = serde_json::to_value(&r).unwrap();
        let round: PressResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }

    #[test]
    fn fill_params_default_clear_before_is_omitted() {
        let p = FillParams {
            session_id: "abcd".into(),
            value: "hello".into(),
            ref_: Some("@e1".into()),
            selector: None,
            tab_id: None,
            clear_before: None,
            timeout_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("clear_before").is_none());
    }

    #[test]
    fn select_params_round_trips_values() {
        let p = SelectParams {
            session_id: "abcd".into(),
            values: vec!["us".into(), "ca".into()],
            ref_: Some("@e3".into()),
            selector: None,
            tab_id: Some(12),
            timeout_ms: Some(5_000),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("values").cloned(), Some(json!(["us", "ca"])));
        let round: SelectParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }
}
