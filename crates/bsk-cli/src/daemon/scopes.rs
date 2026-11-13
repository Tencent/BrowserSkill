//! Daemon-memory caller scope isolation registry (`RM-02`).
//!
//! Maps each isolated `caller_scope` (`--scope`, `BSK_SESSION`, `BSK_SCOPE`,
//! per-process MCP stdio `conn_scope_id`, host subagent IDs, or guarded
//! `"default"`) to its active [`SessionId`] and maintains per-session
//! short evidence aliases (`c1..cN`, `o1..oN`, capped at 32 entries) plus
//! cached VOM snapshots so `bsk sync` can hydrate `unchanged` replies
//! without an extra round-trip.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use bsk_protocol::{ErrorCode, Method, RpcError};
use serde_json::{Value, json};

use super::browsers::BrowserId;
use super::queue::DispatchError;
use super::sessions::{Session, SessionId, SessionRegistry};

/// Maximum number of `cN` / `oN` short aliases retained per session.
pub const SHORT_ALIAS_CAP: usize = 32;

/// Host subagent environment variables probed in deterministic priority order
/// when neither `--scope`, `BSK_SESSION`/`BSK_SCOPE`, nor an MCP stdio scope
/// is active.
pub const HOST_AGENT_ENV_KEYS: [(&str, &str); 4] = [
    ("CLAUDE_CODE_AGENT_ID", "claude"),
    ("CODEX_THREAD_ID", "codex"),
    ("ANTIGRAVITY_CONVERSATION_ID", "antigravity"),
    ("CURSOR_TRACE_ID", "cursor"),
];

/// Resolve the caller's implicit scope identifier from explicit CLI `--scope`,
/// optional MCP connection scope, and process environment variables.
pub fn resolve_caller_scope_from_env(
    explicit_scope: Option<&str>,
    mcp_scope: Option<&str>,
) -> String {
    resolve_caller_scope_with(explicit_scope, mcp_scope, |key| std::env::var(key).ok())
}

/// Pure scope resolver parameterized over environment lookup for unit testing.
pub fn resolve_caller_scope_with<F>(
    explicit_scope: Option<&str>,
    mcp_scope: Option<&str>,
    mut get_env: F,
) -> String
where
    F: FnMut(&str) -> Option<String>,
{
    if let Some(scope) = non_empty(explicit_scope) {
        return format!("scope:{scope}");
    }
    if let Some(session_env) = get_env("BSK_SESSION").and_then(|v| non_empty_owned(&v)) {
        return format!("session_env:{session_env}");
    }
    if let Some(scope_env) = get_env("BSK_SCOPE").and_then(|v| non_empty_owned(&v)) {
        return format!("scope:{scope_env}");
    }
    if let Some(mcp) = non_empty(mcp_scope) {
        return mcp.to_string();
    }
    for (env_key, tag) in HOST_AGENT_ENV_KEYS {
        if let Some(val) = get_env(env_key).and_then(|v| non_empty_owned(&v)) {
            return format!("agent:{tag}:{val}");
        }
    }
    "default".to_string()
}

/// True when `scope` comes from `--scope`, `BSK_SESSION`/`BSK_SCOPE`, MCP, or
/// a host subagent variable rather than the fallback `"default"` slot.
pub fn is_isolated_scope(scope: &str) -> bool {
    !scope.is_empty() && scope != "default"
}

/// True when `token` has the canonical monotonic short alias syntax (`c1`, `o2`, ...).
pub fn is_short_alias(token: &str, prefix: char) -> bool {
    let Some(digits) = token.strip_prefix(prefix) else {
        return false;
    };
    !digits.is_empty()
        && !digits.starts_with('0')
        && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn non_empty_owned(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn normalize_scope_key(scope: &str) -> &str {
    let trimmed = scope.trim();
    if trimmed.is_empty() {
        "default"
    } else {
        trimmed
    }
}

fn display_scope(scope: &str) -> &str {
    scope
        .strip_prefix("scope:")
        .or_else(|| scope.strip_prefix("session_env:"))
        .unwrap_or(scope)
}

#[derive(Debug, Clone)]
pub struct ScopeBinding {
    pub session_id: SessionId,
    pub browser_id: BrowserId,
    pub incognito: bool,
}

#[derive(Debug, Clone)]
pub struct ScopeTombstone {
    pub session_id: SessionId,
    pub reason: &'static str,
}

#[derive(Debug, Default, Clone)]
struct ScopeSlot {
    active: Option<ScopeBinding>,
    tombstone: Option<ScopeTombstone>,
}

#[derive(Debug, Default, Clone)]
struct TabContextCache {
    latest_ctx_id: Option<String>,
    latest_short_ctx: Option<String>,
    latest_obs_id: Option<String>,
    latest_short_obs: Option<String>,
    last_vom: Option<String>,
    /// The cached VOM was cut to a `max_tokens` budget.
    last_vom_truncated: bool,
    last_url: Option<String>,
    last_title: Option<String>,
}

#[derive(Debug, Default)]
struct SessionContextSlot {
    control_policy: Option<String>,
    active_tab_id: Option<i64>,
    has_tab_history: bool,
    ctx_seq: u64,
    obs_seq: u64,
    short_ctx_ring: VecDeque<(String, String)>,
    short_obs_ring: VecDeque<(String, String)>,
    latest_ctx_id: Option<String>,
    latest_short_ctx: Option<String>,
    latest_obs_id: Option<String>,
    latest_short_obs: Option<String>,
    last_vom: Option<String>,
    last_vom_truncated: bool,
    last_url: Option<String>,
    last_title: Option<String>,
    tabs: HashMap<i64, TabContextCache>,
}

#[derive(Debug, Default)]
struct RegistryInner {
    scopes: HashMap<String, ScopeSlot>,
    sessions: HashMap<SessionId, SessionContextSlot>,
}

#[derive(Debug, Default)]
pub struct ImplicitScopeRegistry {
    inner: Mutex<RegistryInner>,
    start_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl ImplicitScopeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return a per-scope async mutex used to serialize `bsk open` reuse-or-start
    /// checks across concurrent callers sharing the same scope.
    pub fn scope_start_lock(&self, scope: &str) -> Arc<tokio::sync::Mutex<()>> {
        let key = normalize_scope_key(scope);
        let mut guard = self
            .start_locks
            .lock()
            .expect("implicit scope start_locks poisoned");
        Arc::clone(
            guard
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    /// Bind `scope` to a newly started live session and clear any prior tombstone.
    pub fn bind_scope(
        &self,
        scope: &str,
        session_id: SessionId,
        browser_id: BrowserId,
        incognito: bool,
    ) {
        let key = normalize_scope_key(scope);
        let mut guard = self.inner.lock().expect("implicit scope registry poisoned");
        guard.scopes.insert(
            key.to_string(),
            ScopeSlot {
                active: Some(ScopeBinding {
                    session_id,
                    browser_id,
                    incognito,
                }),
                tombstone: None,
            },
        );
    }

    /// Return the live session bound to `scope`, or self-heal into a tombstone
    /// if the underlying session is no longer registered in `sessions`.
    pub fn active_binding(
        &self,
        scope: &str,
        sessions: &SessionRegistry,
    ) -> Option<(ScopeBinding, Session)> {
        let key = normalize_scope_key(scope);
        let mut guard = self.inner.lock().expect("implicit scope registry poisoned");
        let slot = guard.scopes.get_mut(key)?;
        let binding = slot.active.clone()?;
        if let Some(live) = sessions.get(&binding.session_id) {
            return Some((binding, live));
        }
        let reason = sessions.end_info(&binding.session_id).map_or(
            bsk_protocol::RpcErrorReason::SessionStopped.as_str(),
            |end| end.reason,
        );
        let dead_id = binding.session_id;
        slot.active = None;
        slot.tombstone = Some(ScopeTombstone {
            session_id: dead_id.clone(),
            reason,
        });
        guard.sessions.remove(&dead_id);
        None
    }

    /// Atomically unbind every scope pointing to `session_id`, leave a tombstone
    /// recording `reason`, and drop cached short tokens / VOM for `session_id`.
    pub fn on_session_ended(&self, session_id: &SessionId, reason: &'static str) {
        let mut guard = self.inner.lock().expect("implicit scope registry poisoned");
        guard.sessions.remove(session_id);
        for slot in guard.scopes.values_mut() {
            if slot
                .active
                .as_ref()
                .is_some_and(|binding| &binding.session_id == session_id)
            {
                slot.active = None;
                slot.tombstone = Some(ScopeTombstone {
                    session_id: session_id.clone(),
                    reason,
                });
            }
        }
    }

    /// Resolve a missing/empty `session_id` using `scope` and enforce the
    /// `"default"` anti-silent-hijack guard when other live sessions exist.
    pub fn resolve_implicit_session(
        &self,
        scope: &str,
        sessions: &SessionRegistry,
    ) -> Result<SessionId, RpcError> {
        let key = normalize_scope_key(scope);

        // `BSK_SESSION=<id>` can directly name a live (or recently ended) session id,
        // or act as a named scope when used with `bsk open`.
        if let Some(raw_session) = key.strip_prefix("session_env:") {
            let candidate = SessionId(raw_session.to_string());
            if sessions.get(&candidate).is_some() {
                return Ok(candidate);
            }
            if let Some((binding, _)) = self.active_binding(key, sessions) {
                return Ok(binding.session_id);
            }
            if let Some(ended) = sessions.end_info(&candidate) {
                return Err(DispatchError::SessionNotFound { ended: Some(ended) }.into_rpc());
            }
        }

        if let Some((binding, _)) = self.active_binding(key, sessions) {
            return Ok(binding.session_id);
        }

        let live_sessions = sessions.len();
        if key == "default" && live_sessions > 0 {
            return Err(RpcError {
                code: ErrorCode::InvalidParams,
                message: format!(
                    "default scope has no bound session while {live_sessions} active session(s) exist; \
                     pass --session <id>, set BSK_SCOPE=<name>, or run 'bsk open --scope <name> <url>' (refusing to hijack an existing session)"
                ),
                data: Some(json!({
                    "reason": bsk_protocol::RpcErrorReason::AmbiguousImplicitSession.as_str(),
                    "active_sessions": live_sessions,
                })),
            });
        }

        let tombstone = {
            let guard = self.inner.lock().expect("implicit scope registry poisoned");
            guard.scopes.get(key).and_then(|s| s.tombstone.clone())
        };
        if let Some(ended) = tombstone {
            return Err(RpcError {
                code: ErrorCode::NotFound,
                message: format!(
                    "session '{}' in scope '{}' has ended ({}); run 'bsk open <url>' first to start a new session",
                    ended.session_id,
                    display_scope(key),
                    ended.reason
                ),
                data: Some(json!({
                    "reason": ended.reason,
                    "session_id": ended.session_id.0,
                })),
            });
        }

        Err(RpcError {
            code: ErrorCode::NotFound,
            message: format!(
                "no active session in scope '{}'; run 'bsk open <url>' first (or pass --session <id>)",
                display_scope(key)
            ),
            data: Some(json!({
                "reason": bsk_protocol::RpcErrorReason::NoActiveSession.as_str(),
            })),
        })
    }

    /// Expand a short context alias (`c1..cN`) to its 36-char UUID if registered.
    pub fn expand_short_ctx(&self, session_id: &SessionId, token: &str) -> Option<String> {
        if !is_short_alias(token, 'c') {
            return None;
        }
        let guard = self.inner.lock().expect("implicit scope registry poisoned");
        let slot = guard.sessions.get(session_id)?;
        slot.short_ctx_ring
            .iter()
            .rev()
            .find(|(alias, _)| alias == token)
            .map(|(_, uuid)| uuid.clone())
    }

    /// Expand a short observation alias (`o1..oN`) to its 36-char UUID if registered.
    pub fn expand_short_obs(&self, session_id: &SessionId, token: &str) -> Option<String> {
        if !is_short_alias(token, 'o') {
            return None;
        }
        let guard = self.inner.lock().expect("implicit scope registry poisoned");
        let slot = guard.sessions.get(session_id)?;
        slot.short_obs_ring
            .iter()
            .rev()
            .find(|(alias, _)| alias == token)
            .map(|(_, uuid)| uuid.clone())
    }

    /// Return the session's currently tracked active `tab_id` when known.
    pub fn active_tab_id(&self, session_id: &SessionId) -> Option<i64> {
        let guard = self.inner.lock().expect("implicit scope registry poisoned");
        guard.sessions.get(session_id)?.active_tab_id
    }

    /// Return the latest reusable `context_id` for the target tab ONLY when the
    /// session's negotiated cooperation policy is `target`. Never injects another
    /// tab's context when `tab_id` is omitted after tab switches/creation/closure.
    pub fn implicit_target_context(
        &self,
        session_id: &SessionId,
        tab_id: Option<i64>,
    ) -> Option<String> {
        let guard = self.inner.lock().expect("implicit scope registry poisoned");
        let slot = guard.sessions.get(session_id)?;
        if slot.control_policy.as_deref() != Some("target") {
            return None;
        }
        if let Some(tid) = tab_id.or(slot.active_tab_id) {
            return slot
                .tabs
                .get(&tid)
                .and_then(|tab| tab.latest_ctx_id.clone());
        }
        if slot.has_tab_history || !slot.tabs.is_empty() {
            return None;
        }
        slot.latest_ctx_id.clone()
    }

    /// Track active-tab transitions (`tab_create`, `tab_select`, `tab_borrow`,
    /// `tab_close`, `tab_return`) so omitted `tab_id` never injects a previous
    /// tab's `context_id` onto a newly created/selected tab.
    pub fn record_tab_transition(
        &self,
        session_id: &SessionId,
        method: &Method,
        req_params: &Value,
        result: &Value,
    ) {
        let mut guard = self.inner.lock().expect("implicit scope registry poisoned");
        let slot = guard.sessions.entry(session_id.clone()).or_default();
        match method {
            Method::ToolTabCreate => {
                if let Some(tid) = result.get("tab_id").and_then(Value::as_i64) {
                    slot.has_tab_history = true;
                    let active = req_params
                        .get("active")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    if active || slot.active_tab_id.is_none() {
                        slot.active_tab_id = Some(tid);
                    }
                }
            }
            Method::ToolTabSelect | Method::ToolTabBorrow => {
                if let Some(tid) = result
                    .get("tab_id")
                    .and_then(Value::as_i64)
                    .or_else(|| req_params.get("tab_id").and_then(Value::as_i64))
                {
                    slot.has_tab_history = true;
                    slot.active_tab_id = Some(tid);
                }
            }
            Method::ToolTabClose | Method::ToolTabReturn => {
                if let Some(tid) = result
                    .get("tab_id")
                    .and_then(Value::as_i64)
                    .or_else(|| req_params.get("tab_id").and_then(Value::as_i64))
                {
                    slot.has_tab_history = true;
                    slot.tabs.remove(&tid);
                    if slot.active_tab_id == Some(tid) {
                        slot.active_tab_id = None;
                    }
                }
            }
            _ => {}
        }
    }

    /// Record a successful `tool.cooperate` (`sync` / `enable`) reply, interning
    /// `c<N>` / `o<N>` aliases (reusing existing alias on identical UUID; capped
    /// at 32) and updating per-tab VOM / URL / title metadata. Returns `_scope_meta`.
    pub fn record_cooperate_result(&self, session_id: &SessionId, result: &Value) -> Value {
        let mut guard = self.inner.lock().expect("implicit scope registry poisoned");
        let slot = guard.sessions.entry(session_id.clone()).or_default();

        if let Some(policy) = result.get("control_policy").and_then(Value::as_str)
            && !policy.is_empty()
        {
            slot.control_policy = Some(policy.to_string());
        }

        let tab_id = result.get("tab_id").and_then(Value::as_i64);
        if let Some(tid) = tab_id {
            slot.has_tab_history = true;
            slot.active_tab_id = Some(tid);
        }
        let effective_tab_id = tab_id.or(slot.active_tab_id);

        let prior_ctx_id = match effective_tab_id {
            Some(tid) => slot.tabs.get(&tid).and_then(|t| t.latest_ctx_id.clone()),
            None => slot.latest_ctx_id.clone(),
        };

        let kind = result.get("kind").and_then(Value::as_str);
        let is_unchanged_kind = kind == Some("unchanged");
        let history_ok = result
            .get("history_complete")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let changes_empty = result
            .get("changes")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty);
        let predecessor_ok = match (
            result.get("previous_context_id").and_then(Value::as_str),
            prior_ctx_id.as_deref(),
        ) {
            (Some(prev), Some(prior)) => prev == prior,
            (Some(_), None) => false,
            (None, _) => true,
        };
        let exact_unchanged = is_unchanged_kind && history_ok && changes_empty && predecessor_ok;

        let minted_ctx = if let Some(ctx_id) = result
            .get("context_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            let short = intern_alias(&mut slot.short_ctx_ring, &mut slot.ctx_seq, 'c', ctx_id);
            slot.latest_ctx_id = Some(ctx_id.to_string());
            slot.latest_short_ctx = Some(short.clone());
            Some((short, ctx_id.to_string()))
        } else {
            None
        };

        let minted_obs = if let Some(obs_id) = result
            .get("observation_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            let short = intern_alias(&mut slot.short_obs_ring, &mut slot.obs_seq, 'o', obs_id);
            slot.latest_obs_id = Some(obs_id.to_string());
            slot.latest_short_obs = Some(short.clone());
            Some((short, obs_id.to_string()))
        } else {
            None
        };

        let obs_text = result.pointer("/observation/text").and_then(Value::as_str);
        let obs_truncated = result
            .pointer("/observation/truncated")
            .and_then(Value::as_bool)
            == Some(true);
        let obs_url = result
            .pointer("/observation/url")
            .and_then(Value::as_str)
            .or_else(|| result.pointer("/state/url").and_then(Value::as_str));
        let obs_title = result
            .pointer("/observation/title")
            .and_then(Value::as_str)
            .or_else(|| result.pointer("/state/title").and_then(Value::as_str));

        let (cached_vom, cached_truncated, cached_url, cached_title, cache_reusable) =
            if let Some(tid) = effective_tab_id {
                let tab_cache = slot.tabs.entry(tid).or_default();
                if let Some((ref short, ref uuid)) = minted_ctx {
                    tab_cache.latest_short_ctx = Some(short.clone());
                    tab_cache.latest_ctx_id = Some(uuid.clone());
                }
                if let Some((ref short, ref uuid)) = minted_obs {
                    tab_cache.latest_short_obs = Some(short.clone());
                    tab_cache.latest_obs_id = Some(uuid.clone());
                }
                let reusable = if let Some(text) = obs_text {
                    tab_cache.last_vom = Some(text.to_string());
                    tab_cache.last_vom_truncated = obs_truncated;
                    true
                } else if exact_unchanged {
                    tab_cache.last_vom.is_some()
                } else {
                    tab_cache.last_vom = None;
                    tab_cache.last_vom_truncated = false;
                    false
                };
                if let Some(url) = obs_url {
                    tab_cache.last_url = Some(url.to_string());
                }
                if let Some(title) = obs_title {
                    tab_cache.last_title = Some(title.to_string());
                }
                (
                    tab_cache.last_vom.clone(),
                    tab_cache.last_vom_truncated,
                    tab_cache.last_url.clone(),
                    tab_cache.last_title.clone(),
                    reusable,
                )
            } else {
                let reusable = if let Some(text) = obs_text {
                    slot.last_vom = Some(text.to_string());
                    slot.last_vom_truncated = obs_truncated;
                    true
                } else if exact_unchanged {
                    slot.last_vom.is_some()
                } else {
                    slot.last_vom = None;
                    slot.last_vom_truncated = false;
                    false
                };
                if let Some(url) = obs_url {
                    slot.last_url = Some(url.to_string());
                }
                if let Some(title) = obs_title {
                    slot.last_title = Some(title.to_string());
                }
                (
                    slot.last_vom.clone(),
                    slot.last_vom_truncated,
                    slot.last_url.clone(),
                    slot.last_title.clone(),
                    reusable,
                )
            };

        json!({
            "session_id": session_id.0,
            "tab_id": effective_tab_id,
            "short_ctx": minted_ctx.map(|(s, _)| s).or_else(|| slot.latest_short_ctx.clone()),
            "short_obs": minted_obs.map(|(s, _)| s).or_else(|| slot.latest_short_obs.clone()),
            "cached_vom": cached_vom,
            "cached_vom_truncated": cached_truncated,
            "cached_url": cached_url,
            "cached_title": cached_title,
            "cache_reusable": cache_reusable,
        })
    }
}

fn intern_alias(
    ring: &mut VecDeque<(String, String)>,
    seq: &mut u64,
    prefix: char,
    uuid: &str,
) -> String {
    if let Some(pos) = ring.iter().position(|(_, existing)| existing == uuid) {
        let (alias, owned_uuid) = ring.remove(pos).expect("ring position verified");
        ring.push_back((alias.clone(), owned_uuid));
        return alias;
    }
    *seq += 1;
    let alias = format!("{prefix}{}", *seq);
    push_ring(ring, (alias.clone(), uuid.to_string()));
    alias
}

fn push_ring(ring: &mut VecDeque<(String, String)>, entry: (String, String)) {
    if ring.len() >= SHORT_ALIAS_CAP {
        ring.pop_front();
    }
    ring.push_back(entry);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::sessions::Session;

    fn live_session(id: &str, browser: &str) -> Session {
        Session {
            controller: None,
            interaction: None,
            id: SessionId(id.into()),
            browser_id: BrowserId(browser.into()),
            agent_window_id: Some(10),
            created_at_ms: 1,
        }
    }

    #[test]
    fn caller_scope_priority_is_deterministic() {
        let env = HashMap::from([
            ("BSK_SESSION", "env-sess"),
            ("BSK_SCOPE", "env-scope"),
            ("CLAUDE_CODE_AGENT_ID", "claude-1"),
            ("CODEX_THREAD_ID", "codex-1"),
        ]);
        assert_eq!(
            resolve_caller_scope_with(Some("cli-scope"), Some("mcp:1:abc"), |k| {
                env.get(k).map(|v| (*v).to_string())
            }),
            "scope:cli-scope"
        );
        assert_eq!(
            resolve_caller_scope_with(None, Some("mcp:1:abc"), |k| {
                env.get(k).map(|v| (*v).to_string())
            }),
            "session_env:env-sess"
        );
        let env_no_sess = HashMap::from([
            ("BSK_SCOPE", "env-scope"),
            ("CLAUDE_CODE_AGENT_ID", "claude-1"),
        ]);
        assert_eq!(
            resolve_caller_scope_with(None, Some("mcp:1:abc"), |k| {
                env_no_sess.get(k).map(|v| (*v).to_string())
            }),
            "scope:env-scope"
        );
        assert_eq!(
            resolve_caller_scope_with(None, Some("mcp:1:abc"), |_| None),
            "mcp:1:abc"
        );
        let env_agents = HashMap::from([
            ("CODEX_THREAD_ID", "codex-9"),
            ("CURSOR_TRACE_ID", "cursor-9"),
        ]);
        assert_eq!(
            resolve_caller_scope_with(None, None, |k| {
                env_agents.get(k).map(|v| (*v).to_string())
            }),
            "agent:codex:codex-9"
        );
        assert_eq!(resolve_caller_scope_with(None, None, |_| None), "default");
    }

    #[test]
    fn default_scope_refuses_silent_hijack_when_other_sessions_exist() {
        let sessions = SessionRegistry::new();
        let scopes = ImplicitScopeRegistry::new();
        sessions.insert(live_session("s1", "b1"));

        let err = scopes
            .resolve_implicit_session("default", &sessions)
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidParams);
        assert_eq!(
            err.data.unwrap()["reason"],
            bsk_protocol::RpcErrorReason::AmbiguousImplicitSession.as_str()
        );
    }

    #[test]
    fn short_aliases_cap_at_32_and_preserve_cached_vom_across_unchanged_sync() {
        let scopes = ImplicitScopeRegistry::new();
        let sid = SessionId("s1".into());

        for i in 1..=35 {
            let payload = if i == 1 {
                json!({
                    "tab_id": 7,
                    "context_id": format!("uuid-ctx-{i}"),
                    "observation_id": format!("uuid-obs-{i}"),
                    "control_policy": "target",
                    "kind": "baseline",
                    "observation": {
                        "url": "https://example.test/",
                        "title": "Example",
                        "text": "@vom 1\n@e1 button \"Submit\""
                    }
                })
            } else {
                json!({
                    "tab_id": 7,
                    "context_id": format!("uuid-ctx-{i}"),
                    "observation_id": format!("uuid-obs-{i}"),
                    "control_policy": "target",
                    "kind": "unchanged"
                })
            };
            let meta = scopes.record_cooperate_result(&sid, &payload);
            assert_eq!(meta["short_ctx"], format!("c{i}"));
            assert_eq!(meta["short_obs"], format!("o{i}"));
            assert_eq!(meta["cached_vom"], "@vom 1\n@e1 button \"Submit\"");
        }

        // c1..c3 evicted, c4..c35 retained.
        assert_eq!(scopes.expand_short_ctx(&sid, "c3"), None);
        assert_eq!(
            scopes.expand_short_ctx(&sid, "c4").as_deref(),
            Some("uuid-ctx-4")
        );
        assert_eq!(
            scopes.expand_short_ctx(&sid, "c35").as_deref(),
            Some("uuid-ctx-35")
        );
        assert_eq!(
            scopes.expand_short_obs(&sid, "o35").as_deref(),
            Some("uuid-obs-35")
        );
        assert_eq!(
            scopes.implicit_target_context(&sid, Some(7)).as_deref(),
            Some("uuid-ctx-35")
        );
    }

    #[test]
    fn identical_context_uuid_reuses_short_alias_without_ring_churn() {
        let scopes = ImplicitScopeRegistry::new();
        let sid = SessionId("s-reuse".into());

        for poll in 1..=50 {
            let payload = if poll == 1 {
                json!({
                    "tab_id": 7,
                    "context_id": "uuid-stable-ctx",
                    "observation_id": format!("uuid-obs-{poll}"),
                    "control_policy": "target",
                    "kind": "baseline",
                    "observation": {
                        "url": "https://example.test/",
                        "title": "Example",
                        "text": "@e1 button \"Submit\""
                    }
                })
            } else {
                json!({
                    "tab_id": 7,
                    "context_id": "uuid-stable-ctx",
                    "previous_context_id": "uuid-stable-ctx",
                    "observation_id": format!("uuid-obs-{poll}"),
                    "control_policy": "target",
                    "kind": "unchanged",
                    "history_complete": true,
                    "changes": []
                })
            };
            let meta = scopes.record_cooperate_result(&sid, &payload);
            assert_eq!(meta["short_ctx"], "c1");
            assert_eq!(meta["short_obs"], format!("o{poll}"));
            assert_eq!(meta["cache_reusable"], true);
        }

        assert_eq!(
            scopes.expand_short_ctx(&sid, "c1").as_deref(),
            Some("uuid-stable-ctx")
        );
        assert_eq!(scopes.expand_short_ctx(&sid, "c2"), None);
    }

    #[test]
    fn cached_vom_remembers_a_token_budget_truncation() {
        let scopes = ImplicitScopeRegistry::new();
        let sid = SessionId("s-budget".into());
        let baseline = scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-1",
                "kind": "baseline",
                "observation": { "text": "Header", "truncated": true }
            }),
        );
        assert_eq!(baseline["cached_vom_truncated"], true);
        let unchanged = scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-2",
                "previous_context_id": "ctx-1",
                "kind": "unchanged",
                "history_complete": true,
                "changes": []
            }),
        );
        assert_eq!(unchanged["cache_reusable"], true);
        assert_eq!(unchanged["cached_vom_truncated"], true);
        let full = scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-3",
                "kind": "baseline",
                "observation": { "text": "Header\nFooter", "truncated": false }
            }),
        );
        assert_eq!(full["cached_vom_truncated"], false);
    }

    #[test]
    fn delta_and_incomplete_history_clear_cached_vom_until_next_full_capture() {
        let scopes = ImplicitScopeRegistry::new();
        let sid = SessionId("s-strict".into());

        let baseline = scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-1",
                "control_policy": "strict",
                "kind": "baseline",
                "observation": {
                    "url": "https://example.test/form",
                    "title": "Form",
                    "text": "@e1 textbox \"Email\" value=\"\""
                }
            }),
        );
        assert_eq!(baseline["cache_reusable"], true);

        let delta = scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-2",
                "previous_context_id": "ctx-1",
                "control_policy": "strict",
                "kind": "delta",
                "history_complete": true,
                "changes": [{"frame_id": 0, "label": "Email", "value": "alice@example.test", "previous_value": ""}]
            }),
        );
        assert_eq!(delta["cache_reusable"], false);
        assert!(delta["cached_vom"].is_null());

        // A follow-up `unchanged` after `delta` must NOT resurrect pre-delta stale VOM.
        let post_delta_unchanged = scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-3",
                "previous_context_id": "ctx-2",
                "control_policy": "strict",
                "kind": "unchanged",
                "history_complete": true,
                "changes": []
            }),
        );
        assert_eq!(post_delta_unchanged["cache_reusable"], false);
        assert!(post_delta_unchanged["cached_vom"].is_null());
    }

    #[test]
    fn tab_transitions_prevent_cross_tab_implicit_context_injection() {
        let scopes = ImplicitScopeRegistry::new();
        let sid = SessionId("s-tabs".into());

        scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-tab-7",
                "control_policy": "target",
                "kind": "baseline",
                "observation": { "text": "@e1 button \"Tab 7\"" }
            }),
        );
        assert_eq!(
            scopes.implicit_target_context(&sid, None).as_deref(),
            Some("ctx-tab-7")
        );

        // Creating an active tab 8 switches active_tab_id to 8; omitted tab_id must NOT inject tab 7's context!
        scopes.record_tab_transition(
            &sid,
            &Method::ToolTabCreate,
            &json!({ "session_id": "s-tabs" }),
            &json!({ "tab_id": 8, "window_id": 1, "url": "https://other.test/" }),
        );
        assert_eq!(scopes.implicit_target_context(&sid, None), None);
        assert_eq!(
            scopes.implicit_target_context(&sid, Some(7)).as_deref(),
            Some("ctx-tab-7")
        );

        // Selecting tab 7 restores tab 7's context for omitted tab_id; closing tab 7 clears it.
        scopes.record_tab_transition(
            &sid,
            &Method::ToolTabSelect,
            &json!({ "session_id": "s-tabs", "tab_id": 7 }),
            &json!({ "tab_id": 7, "window_id": 1 }),
        );
        assert_eq!(
            scopes.implicit_target_context(&sid, None).as_deref(),
            Some("ctx-tab-7")
        );
        scopes.record_tab_transition(
            &sid,
            &Method::ToolTabClose,
            &json!({ "session_id": "s-tabs", "tab_id": 7 }),
            &json!({ "tab_id": 7 }),
        );
        assert_eq!(scopes.implicit_target_context(&sid, None), None);
        assert_eq!(scopes.implicit_target_context(&sid, Some(7)), None);
    }
}
