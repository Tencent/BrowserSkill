//! Navigation tools (`tool.navigate*`, `tool.reload`).
//!
//! M7 expands each method with `wait_until`, `timeout_ms`, and a
//! richer result shape that lets the daemon / CLI know which lifecycle
//! phase actually fired (so a `--wait-until=load` that times out still
//! reports `reached: "commit"` instead of an empty success). All
//! `tab_id` fields are optional and resolve to the requesting
//! session's Agent Window active tab when omitted (design §7).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::JavaScriptDialogInfo;

/// Page-lifecycle checkpoint a navigation should wait on.
///
/// Mapping to CDP `Page.lifecycleEvent` names:
/// * `Load` → `load`
/// * `DomContentLoaded` → `DOMContentLoaded`
/// * `NetworkIdle` → `networkIdle`
/// * `Commit` → `commit` (earliest event after the navigation actually
///   commits to a new document)
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum WaitUntil {
    #[default]
    Load,
    DomContentLoaded,
    NetworkIdle,
    Commit,
}

// ---------------------------------------------------------------------------
// navigate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NavigateParams {
    pub session_id: String,
    pub url: String,
    /// Target tab. Defaults to the Agent Window's currently active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Lifecycle phase to wait on. Defaults to [`WaitUntil::Load`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_until: Option<WaitUntil>,
    /// Hard upper bound on the wait; the extension also enforces its
    /// own AbortController hookup (M7 stops listening for further
    /// lifecycle events once exceeded). Defaults to 30s if omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

/// Outcome of a navigation. `reached` is the lifecycle name the
/// extension actually observed before returning — either the requested
/// `wait_until` value, or `"timeout"` when the wait expired before
/// that event fired.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NavigateResult {
    pub tab_id: i64,
    pub url: String,
    /// Tab URL after the navigation settles. May differ from `url` if
    /// the server redirected (e.g. http → https) or `wait_until=commit`
    /// raced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    pub reached: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// navigate_back / navigate_forward
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NavigateBackParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_until: Option<WaitUntil>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NavigateBackResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    pub reached: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NavigateForwardParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_until: Option<WaitUntil>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct NavigateForwardResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    pub reached: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

// ---------------------------------------------------------------------------
// reload
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ReloadParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_until: Option<WaitUntil>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
    /// When `true`, bypass the HTTP cache (CDP `Page.reload(ignoreCache=true)`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hard: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ReloadResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
    pub reached: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wait_until_round_trips_through_lowercase() {
        for v in [
            WaitUntil::Load,
            WaitUntil::DomContentLoaded,
            WaitUntil::NetworkIdle,
            WaitUntil::Commit,
        ] {
            let s = serde_json::to_string(&v).unwrap();
            let parsed: WaitUntil = serde_json::from_str(&s).unwrap();
            assert_eq!(v, parsed);
        }
        assert_eq!(
            serde_json::to_string(&WaitUntil::Commit).unwrap(),
            "\"commit\""
        );
        assert_eq!(
            serde_json::to_string(&WaitUntil::DomContentLoaded).unwrap(),
            "\"domcontentloaded\"",
        );
    }

    #[test]
    fn navigate_params_omit_tab_id_when_none() {
        let p = NavigateParams {
            session_id: "abcd".into(),
            url: "https://example.com/".into(),
            tab_id: None,
            wait_until: Some(WaitUntil::Load),
            timeout_ms: Some(30_000),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("tab_id").is_none());
        let round: NavigateParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn navigate_result_round_trips_with_optional_fields() {
        let r = NavigateResult {
            tab_id: 7,
            url: "https://example.com/".into(),
            final_url: Some("https://www.example.com/".into()),
            reached: "load".into(),
            error_text: None,
            dialogs: vec![],
        };
        let v = serde_json::to_value(&r).unwrap();
        let round: NavigateResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }

    #[test]
    fn reload_params_accept_hard_flag() {
        let raw = json!({
            "session_id": "abcd",
            "hard": true,
        });
        let parsed: ReloadParams = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.hard, Some(true));
    }
}
