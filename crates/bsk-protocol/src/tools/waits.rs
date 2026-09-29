//! Timing helpers (`tool.wait_for_navigation`, `tool.wait_for_element`,
//! `tool.wait_ms`).
//!
//! M9.2: `wait_for_navigation` mirrors the `navigate` wire shape — it
//! waits on a CDP `Page.lifecycleEvent` and reports back via `reached`
//! / `error_text` so a timeout still tells the caller which lifecycle
//! phase the page actually reached. `wait_until` defaults to `load`.
//!
//! M9.3: `wait_ms` is a pure daemon-side sleep (no extension hop, no
//! session needed). The result echoes the requested duration so the
//! caller can confirm a 0ms wait still went through the IPC layer.
//!
//! `wait_for_element` is the **element-level** counterpart of
//! `wait_for_navigation`: it asks a question about one target
//! (`visible` / `hidden` / `attached` / `detached`) and answers it as
//! soon as it is true, instead of waiting on a lifecycle phase or
//! burning a fixed sleep. Callers that used to poll `evaluate` +
//! `wait_ms` in a loop get one RPC and one answer.

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
// wait_for_element (element state)
// ---------------------------------------------------------------------------

/// Which state the caller is waiting for.
///
/// `Visible` / `Hidden` ask about **visibility**; `Attached` /
/// `Detached` ask about **presence in the DOM**. They are deliberately
/// not collapsed into one pair: a page that keeps its spinner mounted
/// and merely hides it satisfies `Hidden` long before it satisfies
/// `Detached`, and a caller that cares about "the mask is really gone
/// from the tree" needs to be able to say so.
///
/// `Hidden` means *present but not visible* — an element that was never
/// there does **not** satisfy it (use `Detached` for that). Keeping
/// those two apart is what makes a timeout report useful: "it is still
/// there but hidden" and "it never appeared" are different bugs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum ElementState {
    #[serde(rename = "visible")]
    Visible,
    #[serde(rename = "hidden")]
    Hidden,
    #[serde(rename = "attached")]
    Attached,
    #[serde(rename = "detached")]
    Detached,
}

impl ElementState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Visible => "visible",
            Self::Hidden => "hidden",
            Self::Attached => "attached",
            Self::Detached => "detached",
        }
    }

    /// Does an observation of `(attached, visible)` satisfy this state?
    pub fn satisfied_by(self, attached: bool, visible: bool) -> bool {
        match self {
            Self::Visible => visible,
            Self::Hidden => attached && !visible,
            Self::Attached => attached,
            Self::Detached => !attached,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WaitForElementParams {
    pub session_id: String,
    /// Optional `@e<N>` ref allocated by the last `tool.snapshot`.
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
    /// State to wait for.
    pub state: ElementState,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Hard upper bound on the wait. Defaults to 10s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
    /// Delay between two state probes. Defaults to 100ms; the extension
    /// clamps it into `[16, 2000]` so a caller cannot turn the wait into
    /// a busy loop against the renderer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub poll_ms: Option<u32>,
}

/// Outcome of a `wait_for_element`.
///
/// `satisfied` is the answer and `attached` / `visible` are the
/// evidence: a timeout is **not** an RPC error, because "no, not within
/// 10s — and here is what it looked like when I stopped looking" is a
/// complete answer to the question that was asked. This mirrors
/// `wait_for_navigation`'s `reached: "timeout"`.
///
/// The two booleans are reported separately rather than as one
/// `observed` enum because presence and visibility are orthogonal, and
/// **the reason for a timeout is the whole point of the report**:
/// `attached: true, visible: false` says "it is there but hidden",
/// `attached: false` says "it never appeared". A single enum cannot
/// express both without losing one of them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WaitForElementResult {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_selector: Option<String>,
    /// Whether the requested state was reached before the deadline.
    pub satisfied: bool,
    /// Whether the target was still mounted in the DOM when the wait
    /// returned.
    pub attached: bool,
    /// Whether the target was visible when the wait returned. Always
    /// `false` when `attached` is `false`.
    pub visible: bool,
    /// Wall-clock time spent waiting, including the final probe.
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
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
    fn wait_for_element_state_satisfaction_matrix() {
        // 存在 + 可见
        assert!(ElementState::Visible.satisfied_by(true, true));
        assert!(!ElementState::Hidden.satisfied_by(true, true));
        assert!(ElementState::Attached.satisfied_by(true, true));
        assert!(!ElementState::Detached.satisfied_by(true, true));
        // 存在但不可见
        assert!(!ElementState::Visible.satisfied_by(true, false));
        assert!(ElementState::Hidden.satisfied_by(true, false));
        assert!(ElementState::Attached.satisfied_by(true, false));
        assert!(!ElementState::Detached.satisfied_by(true, false));
        // 不存在：`hidden` **不**成立——「还在 DOM 里但不可见」与「压根没出现过」
        // 是两种不同的 bug，超时报告要靠这个区分。
        for state in [
            ElementState::Visible,
            ElementState::Hidden,
            ElementState::Attached,
        ] {
            assert!(!state.satisfied_by(false, false), "{}", state.as_str());
        }
        assert!(ElementState::Detached.satisfied_by(false, false));
    }

    #[test]
    fn wait_for_element_params_omit_optionals_and_serialise_ref() {
        let p = WaitForElementParams {
            session_id: "abcd".into(),
            ref_: Some("@e3".into()),
            selector: None,
            state: ElementState::Visible,
            tab_id: None,
            timeout_ms: None,
            poll_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["ref"], "@e3");
        assert!(v.get("ref_").is_none());
        assert_eq!(v["state"], "visible");
        assert!(v.get("tab_id").is_none());
        assert!(v.get("timeout_ms").is_none());
        assert!(v.get("poll_ms").is_none());
        let round: WaitForElementParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
        // `ref_` 是别名，老调用方给哪个都要认。
        let aliased: WaitForElementParams = serde_json::from_value(json!({
            "session_id": "s",
            "ref_": "@e1",
            "state": "hidden"
        }))
        .unwrap();
        assert_eq!(aliased.ref_.as_deref(), Some("@e1"));
    }

    #[test]
    fn wait_for_element_rejects_unknown_state() {
        let res = serde_json::from_value::<WaitForElementParams>(json!({
            "session_id": "s",
            "selector": "#a",
            "state": "clickable"
        }));
        assert!(res.is_err());
    }

    #[test]
    fn wait_for_element_result_round_trips_timeout_evidence() {
        let r = WaitForElementResult {
            tab_id: 4,
            used_ref: None,
            used_selector: Some(".el-loading-mask".into()),
            satisfied: false,
            attached: true,
            visible: false,
            elapsed_ms: 10_004,
            dialogs: vec![],
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["satisfied"], false);
        assert_eq!(v["attached"], true);
        assert_eq!(v["visible"], false);
        assert_eq!(v["elapsed_ms"], 10_004);
        let round: WaitForElementResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
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
