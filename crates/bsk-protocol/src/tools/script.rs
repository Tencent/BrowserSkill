//! `tool.evaluate` (design §4 / §7).
//!
//! M9.1 expands the M1 placeholder into the wire shape the extension
//! reports back from `Runtime.evaluate`: the call is sandboxed to the
//! session's Agent Window (borrowed tabs included), `tab_id` is
//! optional and defaults to the Agent Window's active tab, and JS
//! exceptions thrown by the evaluated expression are surfaced as
//! `ok: false` payloads (NOT structured RPC errors) so an agent can
//! inspect the `throw` text in-band.
//!
//! `value` is always a `serde_json::Value` — when the underlying CDP
//! result is unserialisable (`Infinity`, `NaN`, `BigInt`, …) the
//! extension stringifies it before returning so the wire payload stays
//! self-describing.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{ActionExpectation, JavaScriptDialogInfo};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EvaluateParams {
    pub session_id: String,
    pub expression: String,
    /// Target tab. Defaults to the Agent Window's currently active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Await the expression when it resolves to a Promise (CDP
    /// `Runtime.evaluate(awaitPromise=...)`). Defaults to `true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub await_promise: Option<bool>,
    /// Ask CDP to serialise the result by value (vs. returning a
    /// `RemoteObject` id we cannot use). Defaults to `true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_by_value: Option<bool>,
    /// Hard upper bound on the evaluation. Defaults to 30s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
    /// Run without comparing the page with any observation. Control authority,
    /// document identity and tab ownership are still enforced. Cannot be
    /// combined with `expect`, `depends_on` or `observation_id`. Prefer stating
    /// what the script relies on; use this only when that cannot be stated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unverified: Option<bool>,
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

/// Outcome of an `evaluate` call.
///
/// * `ok: true` → expression evaluated successfully; `value` holds the
///   JSON-serialised return value (`null` is meaningful and distinct
///   from "missing").
/// * `ok: false` → the expression threw; `error.text` holds the
///   stringified `exceptionDetails.text` / `exception.description`.
///   The RPC itself still succeeds — the daemon does NOT map JS throws
///   to top-level RPC errors so agents can act on the throw text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvaluateResult {
    pub ok: bool,
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<EvaluateError>,
    /// Native JS dialogs observed and auto-handled during this call.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<JavaScriptDialogInfo>,
    /// Present, and `false`, only when the script ran with `unverified`: nothing
    /// about the page was compared before it ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EvaluateError {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn params_omit_optional_fields() {
        let p = EvaluateParams {
            session_id: "abcd".into(),
            expression: "1+1".into(),
            tab_id: None,
            await_promise: None,
            return_by_value: None,
            timeout_ms: None,
            unverified: None,
            context_id: None,
            observation_id: None,
            depends_on: None,
            expect: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("tab_id").is_none());
        assert!(v.get("await_promise").is_none());
        assert!(v.get("return_by_value").is_none());
        assert!(v.get("timeout_ms").is_none());
        let round: EvaluateParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn result_ok_with_value_round_trips() {
        let r = EvaluateResult {
            ok: true,
            tab_id: 7,
            value: Some(json!(2)),
            error: None,
            dialogs: vec![],
            verified: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v.get("value"), Some(&json!(2)));
        assert!(v.get("error").is_none());
        let round: EvaluateResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }

    #[test]
    fn result_throw_carries_error_text_and_position() {
        let r = EvaluateResult {
            ok: false,
            tab_id: 7,
            value: None,
            error: Some(EvaluateError {
                text: "Uncaught Error: boom".into(),
                line: Some(1),
                column: Some(6),
            }),
            dialogs: vec![],
            verified: None,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("value").is_none());
        let round: EvaluateResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }
}
