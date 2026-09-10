//! Observation tools (`tool.snapshot`, `tool.observe`, `tool.get_html`, `tool.screenshot`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::JavaScriptDialogInfo;

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

/// Parameters for `tool.snapshot` — produce an indented accessibility
/// tree for one tab plus a fresh `@e<N>` ref-store on the extension
/// side (design §4 / §7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SnapshotParams {
    pub session_id: String,
    /// Optional target tab. Defaults to the Agent Window's currently
    /// active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Cap the depth of the rendered tree (defense against very deep
    /// pages). Implementation-defined default; agents typically use
    /// `Some(16)` for "browse and read" prompts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    /// Soft cap on rendered tokens (approximate; extension uses a
    /// best-effort heuristic based on character count).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SnapshotResult {
    /// Indented aria-snapshot text. Refs are rendered as `@e<N>` so the
    /// agent can copy them into subsequent `tool.click` / `tool.fill`
    /// selectors.
    pub text: String,
    /// Number of `@e<N>` refs registered for this session by this
    /// snapshot. Equivalent to the size of the new ref-store map.
    pub ref_count: u32,
    /// Tab the snapshot was actually computed for (after resolving the
    /// optional `tab_id` default).
    pub tab_id: i64,
    /// Whether the rendered tree was truncated because of `max_depth` /
    /// `max_tokens`. Agents may re-run with looser caps.
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

/// Parameters for `tool.observe` — produce a semantic VOM observation
/// for one tab plus a fresh `@e<N>` ref-store on the extension side.
///
/// Unlike `tool.snapshot`, this path may run bounded perception probes
/// such as hover-surface discovery, but only when `probe_hover` asks for
/// them. It must not submit input, click, navigate, or otherwise commit
/// page state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ObserveParams {
    pub session_id: String,
    /// Optional target tab. Defaults to the Agent Window's currently
    /// active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Cap the depth of the rendered VOM tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    /// Soft cap on rendered tokens (approximate; extension uses a
    /// best-effort heuristic based on character count).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// Include implementation diagnostics for conditional surface probes.
    #[serde(default)]
    pub debug_surfaces: bool,
    /// Opt in to active hover probing: the extension moves the real cursor
    /// over a bounded set of controls to discover hover-only menus and
    /// tooltips.
    ///
    /// Off by default. Probing costs seconds of wall clock, mutates the live
    /// page, and pays off only on pages whose content is genuinely hidden
    /// behind hover. Request it when a static observation looks like it is
    /// missing hover-revealed structure.
    #[serde(default)]
    pub probe_hover: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SurfaceProbePoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SurfaceProbeDebug {
    pub trigger_backend_node_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_point: Option<SurfaceProbePoint>,
    pub trigger_action: String,
    pub sub_items: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ObserveDebug {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub surface_probes: Vec<SurfaceProbeDebug>,
}

/// Reports what active hover probing did during an observation, so the agent
/// can judge how far the live page may have drifted from the returned text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HoverProbeReport {
    /// The real cursor was moved over page content during this observation.
    pub performed: bool,
    /// Hovering surfaced content the static tree does not contain, so the page
    /// reacts to the cursor and may not have fully reverted.
    pub revealed_content: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ObserveResult {
    /// Semantic VOM observation text. Refs are rendered as `@e<N>` so
    /// the agent can copy them into subsequent interaction tools.
    pub text: String,
    /// Number of `@e<N>` refs registered for this session by this
    /// observation. Equivalent to the size of the new ref-store map.
    pub ref_count: u32,
    /// Tab the observation was computed for.
    pub tab_id: i64,
    /// Whether the rendered tree was truncated because of `max_depth` /
    /// `max_tokens`. Agents may re-run with looser caps.
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
    /// Present only when `probe_hover` was requested and probing actually ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hover_probe: Option<HoverProbeReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debug: Option<ObserveDebug>,
}

// ---------------------------------------------------------------------------
// get_html
// ---------------------------------------------------------------------------

/// Parameters for `tool.get_html`. Either give a tab and (optionally) a
/// snapshot ref to scope the dump to one subtree, or leave both empty
/// to fall back to the Agent Window's active tab and the document
/// root.
///
/// The wire field is `"ref"` (a Rust keyword); the Rust binding lives
/// in [`Self::ref_`] and uses serde rename / alias so JSON stays clean.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GetHtmlParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Optional `@e<N>` ref allocated by the last `tool.snapshot`.
    /// Accepts both `"e3"` and `"@e3"`. When given the extension calls
    /// `DOM.getOuterHTML({ backendNodeId })` for the matching node;
    /// otherwise it fetches the document element.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    /// Truncate the HTML to at most this many bytes. Optional;
    /// extension applies a sensible default (`524288` = 512 KiB) when
    /// omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct GetHtmlResult {
    pub html: String,
    /// True when `html` was truncated to honour `max_bytes`. Agents
    /// should treat the missing tail as elided.
    #[serde(default)]
    pub truncated: bool,
    /// Total byte length of the original (un-truncated) HTML payload.
    pub byte_size: u64,
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// screenshot
// ---------------------------------------------------------------------------

/// Parameters for `tool.screenshot`. Omit `ref` to capture the visible
/// tab; pass an `@e<N>` ref from the last `tool.snapshot` to crop to
/// that element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ScreenshotParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Optional `@e<N>` ref allocated by the last `tool.snapshot`.
    /// Accepts both `"e3"` and `"@e3"`.
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ScreenshotResult {
    /// Base64-encoded PNG payload (no `data:` prefix).
    pub image_base64: String,
    /// Pixel width parsed from the PNG IHDR. May be `0` when parsing
    /// fails (extension only logs a warning in that case so the agent
    /// still gets the image).
    #[serde(default)]
    pub width: u32,
    /// Pixel height (see [`Self::width`]).
    #[serde(default)]
    pub height: u32,
    /// Always `"png"` in v0.1; reserved for future JPEG / WebP support.
    pub format: String,
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn get_html_params_serialises_with_ref_field_name() {
        let p = GetHtmlParams {
            session_id: "abcd".into(),
            tab_id: Some(7),
            ref_: Some("@e3".into()),
            max_bytes: Some(1024),
        };
        let v = serde_json::to_value(&p).unwrap();
        // Wire field name is `ref`, never `ref_`.
        assert_eq!(v.get("ref").and_then(|v| v.as_str()), Some("@e3"));
        assert!(v.get("ref_").is_none());
        let round: GetHtmlParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn get_html_params_accepts_both_ref_aliases() {
        let from_wire: GetHtmlParams =
            serde_json::from_value(json!({ "session_id": "a", "ref": "e1" })).unwrap();
        assert_eq!(from_wire.ref_.as_deref(), Some("e1"));

        let from_alias: GetHtmlParams =
            serde_json::from_value(json!({ "session_id": "a", "ref_": "e2" })).unwrap();
        assert_eq!(from_alias.ref_.as_deref(), Some("e2"));
    }

    #[test]
    fn snapshot_result_round_trips_with_ref_count() {
        let r = SnapshotResult {
            text: "root\n  @e1 button \"submit\"\n".into(),
            ref_count: 1,
            tab_id: 42,
            truncated: false,
            dialogs: vec![],
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["ref_count"], 1);
        assert_eq!(v["text"], "root\n  @e1 button \"submit\"\n");
        let round: SnapshotResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }

    #[test]
    fn screenshot_params_serialises_with_ref_field_name() {
        let p = ScreenshotParams {
            session_id: "abcd".into(),
            tab_id: Some(7),
            ref_: Some("@e3".into()),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("ref").and_then(|v| v.as_str()), Some("@e3"));
        assert!(v.get("ref_").is_none());
        let round: ScreenshotParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn screenshot_params_accepts_both_ref_aliases() {
        let from_wire: ScreenshotParams =
            serde_json::from_value(json!({ "session_id": "a", "ref": "e1" })).unwrap();
        assert_eq!(from_wire.ref_.as_deref(), Some("e1"));

        let from_alias: ScreenshotParams =
            serde_json::from_value(json!({ "session_id": "a", "ref_": "e2" })).unwrap();
        assert_eq!(from_alias.ref_.as_deref(), Some("e2"));
    }

    #[test]
    fn screenshot_result_round_trips_with_image_fields() {
        let r = ScreenshotResult {
            image_base64: "iVBORw0KGgo=".into(),
            width: 800,
            height: 600,
            format: "png".into(),
            tab_id: 7,
            dialogs: vec![],
        };
        let v = serde_json::to_value(&r).unwrap();
        let round: ScreenshotResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }

    #[test]
    fn observe_result_round_trips_with_ref_count() {
        let r = ObserveResult {
            text: "@vom 1\n  @e1 button \"submit\"\n".into(),
            ref_count: 1,
            tab_id: 42,
            truncated: false,
            dialogs: Vec::new(),
            hover_probe: None,
            debug: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v.get("ref_count").and_then(|v| v.as_u64()), Some(1));
        let round: ObserveResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }

    #[test]
    fn observe_params_default_to_no_hover_probing() {
        let params: ObserveParams =
            serde_json::from_value(serde_json::json!({ "session_id": "s1" })).unwrap();
        assert!(!params.probe_hover);
    }

    #[test]
    fn observe_result_round_trips_with_hover_probe_report() {
        let r = ObserveResult {
            text: "@vom 1\n".into(),
            ref_count: 0,
            tab_id: 42,
            truncated: false,
            dialogs: Vec::new(),
            hover_probe: Some(HoverProbeReport {
                performed: true,
                revealed_content: true,
            }),
            debug: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        let round: ObserveResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }
}
