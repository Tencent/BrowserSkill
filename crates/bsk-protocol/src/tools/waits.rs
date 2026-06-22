//! Timing helpers (`tool.wait_for_navigation`, `tool.wait_ms`).
//!
//! M9.2: `wait_for_navigation` mirrors the `navigate` wire shape — it
//! waits on a CDP `Page.lifecycleEvent` and reports back via `reached`
//! / `error_text` so a timeout still tells the caller which lifecycle
//! phase the page actually reached. `wait_until` defaults to `load`.
//!
//! M9.3: `wait_ms` is a pure daemon-side sleep (no extension hop, no
//! session needed). The result echoes the requested duration so the
//! caller can confirm a 0ms wait still went through the IPC layer.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::JavaScriptDialogInfo;
use super::navigation::WaitUntil;

// ---------------------------------------------------------------------------
// wait_for_navigation
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WaitForNavigationParams {
    pub session_id: String,
    /// Target tab. Defaults to the Agent Window's currently active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Lifecycle phase to wait on. Defaults to [`WaitUntil::Load`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_until: Option<WaitUntil>,
    /// Hard upper bound on the wait. Defaults to 30s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

/// Outcome of a wait_for_navigation. `reached` is the wire name of the
/// lifecycle phase the extension actually observed before returning —
/// either the requested `wait_until`, or `"timeout"` when the wait
/// expired before that event fired.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WaitForNavigationResult {
    pub tab_id: i64,
    pub reached: WaitForNavigationReached,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum WaitForNavigationReached {
    #[serde(rename = "load")]
    Load,
    #[serde(rename = "domcontentloaded")]
    DomContentLoaded,
    #[serde(rename = "networkidle")]
    NetworkIdle,
    #[serde(rename = "commit")]
    Commit,
    #[serde(rename = "timeout")]
    Timeout,
}

impl WaitForNavigationReached {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Load => "load",
            Self::DomContentLoaded => "domcontentloaded",
            Self::NetworkIdle => "networkidle",
            Self::Commit => "commit",
            Self::Timeout => "timeout",
        }
    }
}

// ---------------------------------------------------------------------------
// wait_ms
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WaitMsParams {
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WaitMsResult {
    pub waited_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wait_for_navigation_params_omit_optional_fields() {
        let p = WaitForNavigationParams {
            session_id: "abcd".into(),
            tab_id: None,
            wait_until: None,
            timeout_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("tab_id").is_none());
        assert!(v.get("wait_until").is_none());
        assert!(v.get("timeout_ms").is_none());
        let round: WaitForNavigationParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn wait_for_navigation_result_round_trips_timeout() {
        let r = WaitForNavigationResult {
            tab_id: 9,
            reached: WaitForNavigationReached::Timeout,
            error_text: Some("timed out waiting for lifecycle \"load\"".into()),
            dialogs: vec![],
        };
        let v = serde_json::to_value(&r).unwrap();
        let round: WaitForNavigationResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }

    #[test]
    fn wait_for_navigation_result_rejects_unknown_reached_value() {
        let res = serde_json::from_value::<WaitForNavigationResult>(json!({
            "tab_id": 9,
            "reached": "painted"
        }));
        assert!(res.is_err());
    }

    #[test]
    fn wait_ms_round_trips() {
        let params: WaitMsParams = serde_json::from_value(json!({ "duration_ms": 250 })).unwrap();
        assert_eq!(params.duration_ms, 250);
        let result = WaitMsResult { waited_ms: 250 };
        let v = serde_json::to_value(&result).unwrap();
        assert_eq!(v, json!({ "waited_ms": 250 }));
    }
}
