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
