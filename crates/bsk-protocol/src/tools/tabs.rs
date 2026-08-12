//! Tab tools (`tool.tab_*`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// View scope for [`TabListParams`] (§6 sandbox table).
///
/// * `User` — tabs that live in any window other than an Agent Window.
/// * `Agent` — tabs in the requesting session's Agent Window only.
/// * `All` — both of the above; never reveals other sessions' Agent
///   Windows (cross-session isolation per §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Default)]
#[serde(rename_all = "lowercase")]
pub enum TabScope {
    User,
    Agent,
    #[default]
    All,
}

/// A single tab entry returned by [`TabListResult`].
///
/// `scope` reports how the requesting session sees this tab: tabs owned
/// by the session's own Agent Window are tagged `agent`; everything
/// else falls into `user`. (Other sessions' Agent Windows are filtered
/// out before they reach this struct.)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabInfo {
    pub tab_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    /// Where the tab sits relative to the requesting session: `user` or
    /// `agent`. `all` is a request-side filter only and never appears
    /// on an individual tab entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<TabScope>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabListParams {
    #[serde(default)]
    pub scope: TabScope,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabListResult {
    pub tabs: Vec<TabInfo>,
}

// ---------------------------------------------------------------------------
// tab_create (M8.1)
// ---------------------------------------------------------------------------

/// Params for `tool.tab_create`. The new tab is always created inside
/// the requesting session's Agent Window (design §6 sandbox rule —
/// agents never spawn tabs in user windows).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabCreateParams {
    pub session_id: String,
    /// Destination URL. Defaults to `chrome://newtab` when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Focus the new tab? Defaults to `true` (matches `chrome.tabs.create`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    /// Insertion index within the Agent Window's tab strip. Omit to
    /// append at the end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabCreateResult {
    pub tab_id: i64,
    pub window_id: i64,
    /// Best-effort URL of the newly created tab. May be empty if Chrome
    /// has not yet committed the navigation (e.g. pending load).
    #[serde(default)]
    pub url: String,
}

// ---------------------------------------------------------------------------
// tab_close (M8.1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabCloseParams {
    pub tab_id: i64,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabCloseResult {
    pub tab_id: i64,
}

// ---------------------------------------------------------------------------
// tab_select (M8.1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabSelectParams {
    pub tab_id: i64,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabSelectResult {
    pub tab_id: i64,
    pub window_id: i64,
}

// ---------------------------------------------------------------------------
// tab_borrow (M8.2)
// ---------------------------------------------------------------------------

/// Params for `tool.tab_borrow`. Moves a *user* tab into the
/// requesting session's Agent Window, recording its original window /
/// index so `tab_return` (or session_stop) can put it back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabBorrowParams {
    pub tab_id: i64,
    pub session_id: String,
    /// Whether to wait for an inline user confirmation overlay (M10
    /// will introduce the UI). Currently ignored: the M8 stub always
    /// proceeds when `false` and forwards `true` to a no-op approver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabBorrowResult {
    pub tab_id: i64,
    pub original_window_id: i64,
    pub original_index: i32,
    pub agent_window_id: i64,
}

// ---------------------------------------------------------------------------
// tab_return (M8.3)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabReturnParams {
    pub tab_id: i64,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TabReturnResult {
    pub tab_id: i64,
    pub returned_to_window_id: i64,
    pub returned_to_index: i32,
    /// True when the original window had been closed and we fell back
    /// to either the last focused normal window or a newly-created
    /// window. Lets the CLI surface "tab returned to a different
    /// window" hints.
    #[serde(default, skip_serializing_if = "core::ops::Not::not")]
    pub fallback: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tab_info_scope_is_omitted_when_none() {
        let info = TabInfo {
            tab_id: 1,
            title: Some("hi".into()),
            url: None,
            window_id: Some(2),
            active: Some(true),
            scope: None,
        };
        let v = serde_json::to_value(&info).unwrap();
        assert!(v.get("scope").is_none());
        let round: TabInfo = serde_json::from_value(v).unwrap();
        assert_eq!(round, info);
    }

    #[test]
    fn tab_info_scope_renders_as_lowercase_enum() {
        let info = TabInfo {
            tab_id: 1,
            title: None,
            url: None,
            window_id: None,
            active: None,
            scope: Some(TabScope::Agent),
        };
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["scope"], "agent");
        // Round-trip from upstream JSON (no `title` / `url` keys).
        let from_json: TabInfo = serde_json::from_value(json!({
            "tab_id": 1,
            "scope": "user"
        }))
        .unwrap();
        assert_eq!(from_json.scope, Some(TabScope::User));
    }

    #[test]
    fn tab_create_params_default_optional_fields() {
        let v = json!({ "session_id": "aa11" });
        let p: TabCreateParams = serde_json::from_value(v).unwrap();
        assert_eq!(p.session_id, "aa11");
        assert!(p.url.is_none());
        assert!(p.active.is_none());
        assert!(p.index.is_none());
    }

    #[test]
    fn tab_create_params_round_trip_full() {
        let p = TabCreateParams {
            session_id: "aa11".into(),
            url: Some("https://example.com/".into()),
            active: Some(false),
            index: Some(3),
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["url"], "https://example.com/");
        assert_eq!(v["active"], false);
        assert_eq!(v["index"], 3);
        let round: TabCreateParams = serde_json::from_value(v).unwrap();
        assert_eq!(round, p);
    }

    #[test]
    fn tab_create_result_serialises_url_even_when_empty() {
        let r = TabCreateResult {
            tab_id: 7,
            window_id: 100,
            url: String::new(),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["tab_id"], 7);
        assert_eq!(v["url"], "");
    }

    #[test]
    fn tab_close_select_result_round_trips() {
        let c: TabCloseResult = serde_json::from_value(json!({ "tab_id": 9 })).unwrap();
        assert_eq!(c.tab_id, 9);
        let s: TabSelectResult =
            serde_json::from_value(json!({ "tab_id": 9, "window_id": 100 })).unwrap();
        assert_eq!(s.window_id, 100);
    }

    #[test]
    fn tab_borrow_params_confirm_defaults_to_none() {
        let p: TabBorrowParams =
            serde_json::from_value(json!({ "tab_id": 1, "session_id": "aa11" })).unwrap();
        assert!(p.confirm.is_none());
    }

    #[test]
    fn tab_borrow_result_round_trip() {
        let r = TabBorrowResult {
            tab_id: 9,
            original_window_id: 200,
            original_index: 4,
            agent_window_id: 100,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["original_window_id"], 200);
        assert_eq!(v["original_index"], 4);
        let round: TabBorrowResult = serde_json::from_value(v).unwrap();
        assert_eq!(round, r);
    }

    #[test]
    fn tab_return_result_omits_fallback_when_false() {
        let r = TabReturnResult {
            tab_id: 9,
            returned_to_window_id: 200,
            returned_to_index: 4,
            fallback: false,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("fallback").is_none());
        let r2 = TabReturnResult {
            fallback: true,
            ..r
        };
        let v2 = serde_json::to_value(&r2).unwrap();
        assert_eq!(v2["fallback"], true);
    }
}
