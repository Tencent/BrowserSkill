//! Human-in-loop tool (`tool.request_help`).
//!
//! Lets an agent pause and ask the human to complete an in-page step
//! (captcha, login, confirmation). The extension brings the target tab
//! to the foreground, highlights the requested components, and blocks
//! until the user clicks Done / Cancel, explicit completion criteria match,
//! or the call times out.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// One component the user is asked to look at / interact with. Exactly
/// one of `ref` / `selector` should be supplied (mirrors the
/// click/fill convention). When neither matches a live element the
/// overlay still shows the prompt and reports the miss via
/// [`ResolvedTarget`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HelpTarget {
    #[serde(
        rename = "ref",
        alias = "ref_",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RequestHelpParams {
    pub session_id: String,
    /// Target tab. Defaults to the Agent Window's active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Message shown to the user explaining what to do.
    pub prompt: String,
    /// Optional custom title for the help overlay. Falls back to the
    /// extension's default localized title when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Optional components to scroll to + flash-highlight.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<HelpTarget>>,
    /// Optional explicit success detector. Navigation by itself is not a
    /// completion signal; these criteria must match before the tool can
    /// auto-complete without the user clicking Done.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_criteria: Option<HelpCompletionCriteria>,
    /// Hard upper bound on the wait. Defaults to 300000 (5 min),
    /// enforced daemon-side via the generic tool timeout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HelpCompletionCriteria {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub any: Option<Vec<HelpCompletionCondition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub all: Option<Vec<HelpCompletionCondition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 0))]
    pub stable_for_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HelpCompletionCondition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_contains: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_matches: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector_exists: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector_missing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_exists: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_missing: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HelpOutcome {
    /// User completed the step and clicked Done / return control.
    Continued,
    /// User declined / aborted via the overlay's Cancel button.
    Cancelled,
    /// The wait expired before the user acted.
    TimedOut,
    /// Explicit success criteria matched while the user had control.
    Completed,
    /// The page navigated while waiting (full reload or SPA URL change).
    /// Deprecated: navigation alone should not end a help request.
    Navigated,
}

impl HelpOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Continued => "continued",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed_out",
            Self::Completed => "completed",
            Self::Navigated => "navigated",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HelpCompletedBy {
    System,
}

/// Per-target resolution status echoed back so the agent can tell which
/// `ref` / `selector` actually matched a live element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ResolvedTarget {
    pub matched: bool,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub ref_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RequestHelpResult {
    pub outcome: HelpOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_by: Option<HelpCompletedBy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_targets: Option<Vec<ResolvedTarget>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn target_serialises_ref_field_name() {
        let t = HelpTarget {
            ref_: Some("@e3".into()),
            selector: None,
        };
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v.get("ref").and_then(|v| v.as_str()), Some("@e3"));
        assert!(v.get("selector").is_none());
    }

    #[test]
    fn target_accepts_legacy_ref_alias() {
        let t: HelpTarget = serde_json::from_value(json!({ "ref_": "e1" })).unwrap();
        assert_eq!(t.ref_.as_deref(), Some("e1"));
    }

    #[test]
    fn params_omit_optional_fields() {
        let p = RequestHelpParams {
            session_id: "abcd".into(),
            tab_id: None,
            prompt: "log in".into(),
            title: None,
            targets: None,
            completion_criteria: None,
            timeout_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("tab_id").is_none());
        assert!(v.get("title").is_none());
        assert!(v.get("targets").is_none());
        assert!(v.get("timeout_ms").is_none());
        let round: RequestHelpParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn outcome_serialises_snake_case() {
        assert_eq!(
            serde_json::to_value(HelpOutcome::TimedOut).unwrap(),
            json!("timed_out")
        );
        assert_eq!(
            serde_json::to_value(HelpOutcome::Completed).unwrap(),
            json!("completed")
        );
        assert_eq!(
            serde_json::to_value(HelpOutcome::Continued).unwrap(),
            json!("continued")
        );
        assert_eq!(
            serde_json::to_value(HelpOutcome::Cancelled).unwrap(),
            json!("cancelled")
        );
        assert_eq!(
            serde_json::to_value(HelpOutcome::Navigated).unwrap(),
            json!("navigated")
        );
    }

    #[test]
    fn result_round_trips() {
        let r = RequestHelpResult {
            outcome: HelpOutcome::Continued,
            completed_by: None,
            note: Some("done".into()),
            tab_id: 7,
            resolved_targets: Some(vec![ResolvedTarget {
                matched: true,
                ref_: Some("@e1".into()),
                selector: None,
            }]),
        };
        let v = serde_json::to_value(&r).unwrap();
        let round: RequestHelpResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }
}
