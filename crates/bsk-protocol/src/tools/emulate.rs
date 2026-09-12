//! Device-emulation tool (`tool.emulate`).
//!
//! Applies CDP Emulation-domain overrides (viewport metrics, user
//! agent, touch) to a single tab so an agent can debug mobile page
//! behaviour. Overrides are per-target: they do not propagate to new
//! tabs, and `off` restores the tab's real environment
//! (`Emulation.clearDeviceMetricsOverride` + touch disabled + UA
//! override cleared).
//!
//! Device presets are resolved CLI-side; the wire only carries the
//! concrete overrides the extension should execute.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// One entry of CDP `Emulation.UserAgentBrandVersion` (UA client hints).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserAgentBrandVersion {
    pub brand: String,
    pub version: String,
}

/// Mirror of CDP `Emulation.UserAgentMetadata`; every field is optional
/// and only sent when present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserAgentMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brands: Option<Vec<UserAgentBrandVersion>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile: Option<bool>,
}

/// Concrete emulation overrides for one tab. Field presence drives the
/// extension: only the overrides whose fields are set are touched, so a
/// call may change just the UA, just the viewport, or any combination.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EmulateOverrides {
    /// Viewport width in CSS pixels. Requires `height`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Viewport height in CSS pixels. Requires `width`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Device scale factor (device pixel ratio). Only meaningful with
    /// `width`/`height`; the extension maps `None` to CDP's `0`
    /// ("use the display's native factor").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_scale_factor: Option<f64>,
    /// Emulate a mobile viewport (meta-viewport handling, overlay
    /// scrollbars). Only meaningful with `width`/`height`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile: Option<bool>,
    /// UA string for `Emulation.setUserAgentOverride`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    /// `Accept-Language` header override. Requires `user_agent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accept_language: Option<String>,
    /// UA client-hints metadata. Requires `user_agent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent_metadata: Option<UserAgentMetadata>,
    /// Enable/disable touch emulation
    /// (`Emulation.setTouchEmulationEnabled`). When omitted while
    /// `max_touch_points` is set, touch is enabled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub touch: Option<bool>,
    /// Touch points reported while touch emulation is on (CDP defaults
    /// to 1 when omitted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_touch_points: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EmulateParams {
    pub session_id: String,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Clear every emulation override on the tab and restore its real
    /// environment. Mutually exclusive with `overrides`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub off: Option<bool>,
    /// Overrides to apply. Required unless `off` is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overrides: Option<EmulateOverrides>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EmulateResult {
    pub tab_id: i64,
    /// True when overrides were cleared (`off`); false when applied.
    pub cleared: bool,
    /// Echo of the overrides that were applied. Absent when cleared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied: Option<EmulateOverrides>,
    /// Scope note: emulation overrides are per-tab (CDP target) and are
    /// not inherited by new tabs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn params_omit_optional_fields() {
        let p = EmulateParams {
            session_id: "abcd".into(),
            tab_id: None,
            off: None,
            overrides: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v, json!({ "session_id": "abcd" }));
        let round: EmulateParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn overrides_round_trip_with_all_fields() {
        let o = EmulateOverrides {
            width: Some(390),
            height: Some(844),
            device_scale_factor: Some(3.0),
            mobile: Some(true),
            user_agent: Some("Mozilla/5.0 (iPhone…)".into()),
            accept_language: Some("zh-CN".into()),
            user_agent_metadata: Some(UserAgentMetadata {
                brands: Some(vec![UserAgentBrandVersion {
                    brand: "Safari".into(),
                    version: "17".into(),
                }]),
                full_version: None,
                platform: Some("iOS".into()),
                platform_version: None,
                architecture: None,
                model: Some("iPhone".into()),
                mobile: Some(true),
            }),
            touch: Some(true),
            max_touch_points: Some(5),
        };
        let v = serde_json::to_value(&o).unwrap();
        assert_eq!(v["width"], json!(390));
        assert_eq!(v["device_scale_factor"], json!(3.0));
        assert_eq!(
            v["user_agent_metadata"]["brands"][0]["brand"],
            json!("Safari")
        );
        // Absent metadata fields stay absent.
        assert!(v["user_agent_metadata"].get("full_version").is_none());
        let round: EmulateOverrides = serde_json::from_value(v).unwrap();
        assert_eq!(round, o);
    }

    #[test]
    fn overrides_default_is_empty_object() {
        let v = serde_json::to_value(EmulateOverrides::default()).unwrap();
        assert_eq!(v, json!({}));
        let round: EmulateOverrides = serde_json::from_value(json!({})).unwrap();
        assert_eq!(round, EmulateOverrides::default());
    }

    #[test]
    fn off_params_round_trip() {
        let p = EmulateParams {
            session_id: "abcd".into(),
            tab_id: Some(7),
            off: Some(true),
            overrides: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v, json!({ "session_id": "abcd", "tab_id": 7, "off": true }));
        let round: EmulateParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn result_round_trips() {
        let r = EmulateResult {
            tab_id: 7,
            cleared: false,
            applied: Some(EmulateOverrides {
                width: Some(390),
                height: Some(844),
                ..EmulateOverrides::default()
            }),
            note: Some("per-tab".into()),
        };
        let v = serde_json::to_value(&r).unwrap();
        let round: EmulateResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }

    #[test]
    fn cleared_result_omits_applied() {
        let r = EmulateResult {
            tab_id: 7,
            cleared: true,
            applied: None,
            note: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v, json!({ "tab_id": 7, "cleared": true }));
    }
}
