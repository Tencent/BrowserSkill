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

use super::JavaScriptDialogInfo;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
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
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("value").is_none());
        let round: EvaluateResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }
}
