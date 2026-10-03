//! `tool.cookies` — export cookies (including httpOnly) for the site
//! open in the session's Agent Window tab, via CDP `Network.getCookies`.
//!
//! Red-line (design §6, same as `tool.evaluate`): the call resolves the
//! target tab through `resolveTargetTab` + `enforceAgentWindow`, so only
//! sites the human has explicitly handed to the agent (opened in the
//! Agent Window) can be exported — never arbitrary user tabs. The cookie query
//! is scoped to the tab's own URL so the export cannot be widened into a
//! browser-wide token-exfil window.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CookiesParams {
    pub session_id: String,
    /// Target tab. Defaults to the Agent Window's currently active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    /// Hard upper bound on the call. Defaults to 30s.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1))]
    pub timeout_ms: Option<u32>,
}

/// One cookie as reported by CDP `Network.getCookies`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CookieEntry {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<f64>,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub secure: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_site: Option<String>,
}

/// Outcome of a `cookies` call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CookiesResult {
    pub tab_id: i64,
    /// The URL the cookies were scoped to (the tab's own URL).
    pub url: String,
    pub cookies: Vec<CookieEntry>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_roundtrip() {
        let p = CookiesParams {
            session_id: "s1".into(),
            tab_id: Some(7),
            timeout_ms: None,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("tab_id").is_some());
        assert!(v.get("timeout_ms").is_none());
        let back: CookiesParams = serde_json::from_value(v).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn result_roundtrip() {
        let r = CookiesResult {
            tab_id: 7,
            url: "https://example.com/".into(),
            cookies: vec![CookieEntry {
                name: "SID".into(),
                value: "v".into(),
                domain: ".example.com".into(),
                path: "/".into(),
                expires: Some(1.0),
                http_only: true,
                secure: true,
                same_site: None,
            }],
        };
        let v = serde_json::to_value(&r).unwrap();
        let back: CookiesResult = serde_json::from_value(v).unwrap();
        assert_eq!(r, back);
        assert!(v["cookies"][0]["http_only"].is_boolean());
    }
}
