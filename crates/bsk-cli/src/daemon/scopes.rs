//! Daemon-memory caller scope isolation registry (`RM-02`).
//!
//! Maps each isolated `caller_scope` (`--scope`, `BSK_SESSION`, `BSK_SCOPE`,
//! host subagent IDs, per-process MCP stdio `conn_scope_id`, or guarded
//! `"default"`) to its active [`SessionId`] and maintains per-session
//! short evidence aliases (`c1..cN`, `o1..oN`, capped at 32 entries) plus
//! cached VOM snapshots so `bsk sync` can hydrate `unchanged` and text-`delta`
//! replies without an extra round-trip.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use bsk_protocol::{ErrorCode, Method, RpcError};
use serde_json::{Value, json};

use crate::ipc_client::ScopeResultMeta;

use super::browsers::BrowserId;
use super::queue::DispatchError;
use super::sessions::{Session, SessionId, SessionRegistry};

/// Maximum number of `cN` / `oN` short aliases retained per session.
pub const SHORT_ALIAS_CAP: usize = 32;

/// Maximum number of inactive scope tombstones and idle per-scope start locks
/// retained in memory (active bindings and held locks are never evicted).
pub const INACTIVE_SCOPE_LRU_CAP: usize = 256;

/// Host subagent environment variables probed in deterministic priority order
/// when neither `--scope` nor `BSK_SESSION`/`BSK_SCOPE` is active. Takes
/// priority over transient `mcp:<pid>:<nonce>` connection scopes so `bsk mcp`
/// and `bsk` CLI invocations inside the same host agent thread share one session.
pub const HOST_AGENT_ENV_KEYS: [(&str, &str); 5] = [
    ("CLAUDE_CODE_AGENT_ID", "claude"),
    ("CODEX_THREAD_ID", "codex"),
    ("ANTIGRAVITY_CONVERSATION_ID", "antigravity"),
    ("CURSOR_TRACE_ID", "cursor"),
    ("DSH_SESSION_ID", "dsh"),
];

/// Resolve the caller's implicit scope identifier from explicit CLI `--scope`,
/// process environment variables, and optional MCP connection scope.
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
    for (env_key, tag) in HOST_AGENT_ENV_KEYS {
        if let Some(val) = get_env(env_key).and_then(|v| non_empty_owned(&v)) {
            return format!("agent:{tag}:{val}");
        }
    }
    if let Some(mcp) = non_empty(mcp_scope) {
        return mcp.to_string();
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
    last_vom_next_cursor: Option<String>,
    last_vom_max_tokens: Option<u32>,
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
    last_vom_next_cursor: Option<String>,
    last_vom_max_tokens: Option<u32>,
    last_url: Option<String>,
    last_title: Option<String>,
    tabs: HashMap<i64, TabContextCache>,
}

#[derive(Debug, Default)]
struct RegistryInner {
    scopes: HashMap<String, ScopeSlot>,
    /// LRU order of keys in `scopes` whose `active` binding is `None` (oldest at front).
    inactive_lru: VecDeque<String>,
    sessions: HashMap<SessionId, SessionContextSlot>,
}

#[derive(Debug, Default)]
struct StartLocksInner {
    locks: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
    /// LRU order of keys in `locks` (oldest at front).
    lru: VecDeque<String>,
}

fn remove_lru_key(lru: &mut VecDeque<String>, key: &str) {
    if let Some(pos) = lru.iter().position(|existing| existing == key) {
        lru.remove(pos);
    }
}

fn touch_inactive_scope(inner: &mut RegistryInner, key: &str) {
    remove_lru_key(&mut inner.inactive_lru, key);
    inner.inactive_lru.push_back(key.to_string());
    while inner.inactive_lru.len() > INACTIVE_SCOPE_LRU_CAP {
        let Some(oldest) = inner.inactive_lru.pop_front() else {
            break;
        };
        if inner
            .scopes
            .get(&oldest)
            .is_some_and(|slot| slot.active.is_none())
        {
            inner.scopes.remove(&oldest);
        }
    }
}

fn evict_idle_start_locks(inner: &mut StartLocksInner) {
    while inner.locks.len() > INACTIVE_SCOPE_LRU_CAP {
        let Some(pos) = inner.lru.iter().position(|key| {
            inner
                .locks
                .get(key)
                .is_some_and(|arc| Arc::strong_count(arc) == 1)
        }) else {
            break;
        };
        let oldest = inner.lru.remove(pos).expect("lru position verified");
        inner.locks.remove(&oldest);
    }
}

/// Apply a verified text `delta` line patch onto `text`, returning `None` when the
/// reply is not a pure text delta or any 1-based line replacement fails validation.
pub(crate) fn apply_text_delta_patch(reply: &Value, text: &str) -> Option<String> {
    if reply.get("kind").and_then(Value::as_str) != Some("delta") {
        return None;
    }
    let patch = reply.pointer("/observation_patch/lines")?.as_array()?;
    let changes = reply.get("changes")?.as_array()?;
    // Form field values (`value="..."`) are not covered by line patches; any non-text
    // change invalidates the cached VOM text. Empty `patch`/`changes` arrays remain
    // valid for whitespace-collapsed or neutral-focus text deltas.
    if !changes
        .iter()
        .all(|c| c.get("kind").and_then(Value::as_str) == Some("text"))
    {
        return None;
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    let mut prev_line = 0u64;
    for entry in patch {
        let line_no = entry.get("line")?.as_u64()?;
        if line_no <= prev_line {
            return None;
        }
        prev_line = line_no;
        let index = usize::try_from(line_no.checked_sub(1)?).ok()?;
        let replacement = entry.get("text")?.as_str()?;
        let previous = entry.get("previous")?.as_str()?;
        if *lines.get(index)? != previous || replacement.contains('\n') {
            return None;
        }
        lines[index] = replacement;
    }
    Some(lines.join("\n"))
}

fn budget_compatible(
    cached_max_tokens: Option<u32>,
    cached_truncated: bool,
    requested_max_tokens: Option<u32>,
) -> bool {
    if cached_truncated {
        match (cached_max_tokens, requested_max_tokens) {
            (Some(cached), Some(req)) => cached == req,
            (None, None) => true,
            _ => false,
        }
    } else {
        cached_max_tokens == requested_max_tokens
    }
}

#[derive(Debug, Default)]
pub struct ImplicitScopeRegistry {
    inner: Mutex<RegistryInner>,
    start_locks: Mutex<StartLocksInner>,
}

impl ImplicitScopeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of inactive scope tombstones currently retained (for diagnostics and tests).
    pub fn inactive_scope_count(&self) -> usize {
        let guard = self.inner.lock().expect("implicit scope registry poisoned");
        guard
            .scopes
            .values()
            .filter(|slot| slot.active.is_none())
            .count()
    }

    /// Number of per-scope start locks currently retained (for diagnostics and tests).
    pub fn start_lock_count(&self) -> usize {
        let guard = self
            .start_locks
            .lock()
            .expect("implicit scope start_locks poisoned");
        guard.locks.len()
    }

    /// Number of active per-session observation/alias slots currently retained.
    pub fn tracked_session_count(&self) -> usize {
        let guard = self.inner.lock().expect("implicit scope registry poisoned");
        guard.sessions.len()
    }

    /// Return a per-scope async mutex used to serialize `bsk open` reuse-or-start
    /// checks across concurrent callers sharing the same scope.
    pub fn scope_start_lock(&self, scope: &str) -> Arc<tokio::sync::Mutex<()>> {
        let key = normalize_scope_key(scope);
        let mut guard = self
            .start_locks
            .lock()
            .expect("implicit scope start_locks poisoned");
        remove_lru_key(&mut guard.lru, key);
        guard.lru.push_back(key.to_string());
        let lock = Arc::clone(
            guard
                .locks
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        );
        evict_idle_start_locks(&mut guard);
        lock
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
        remove_lru_key(&mut guard.inactive_lru, key);
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
        touch_inactive_scope(&mut guard, key);
        None
    }

    /// Atomically unbind every scope pointing to `session_id`, leave a tombstone
    /// recording `reason` (bounded by [`INACTIVE_SCOPE_LRU_CAP`]), and drop cached
    /// short tokens / VOM for `session_id`.
    pub fn on_session_ended(&self, session_id: &SessionId, reason: &'static str) {
        {
            let mut guard = self.inner.lock().expect("implicit scope registry poisoned");
            guard.sessions.remove(session_id);
            let mut deactivated = Vec::new();
            for (scope_key, slot) in &mut guard.scopes {
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
                    deactivated.push(scope_key.clone());
                }
            }
            for scope_key in deactivated {
                touch_inactive_scope(&mut guard, &scope_key);
            }
        }
        let mut locks = self
            .start_locks
            .lock()
            .expect("implicit scope start_locks poisoned");
        evict_idle_start_locks(&mut locks);
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
            let mut guard = self.inner.lock().expect("implicit scope registry poisoned");
            let found = guard
                .scopes
                .get(key)
                .filter(|s| s.active.is_none())
                .and_then(|s| s.tombstone.clone());
            if found.is_some() {
                touch_inactive_scope(&mut guard, key);
            }
            found
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

    /// Record a successful `tool.cooperate` (`sync` / `enable`) reply without an
    /// explicit `max_tokens` budget.
    pub fn record_cooperate_result(
        &self,
        session_id: &SessionId,
        result: &Value,
    ) -> ScopeResultMeta {
        self.record_cooperate_result_with_budget(session_id, None, result)
    }

    /// Record a successful `tool.cooperate` (`sync` / `enable`) reply under
    /// `requested_max_tokens`, interning `c<N>` / `o<N>` aliases (reusing existing
    /// alias on identical UUID; capped at 32), validating predecessor & token-budget
    /// compatibility, and updating or patching per-tab VOM / URL / title metadata.
    pub fn record_cooperate_result_with_budget(
        &self,
        session_id: &SessionId,
        requested_max_tokens: Option<u32>,
        result: &Value,
    ) -> ScopeResultMeta {
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

        let (prior_ctx_id, prior_obs_id, prior_max_tokens, prior_truncated) = match effective_tab_id
        {
            Some(tid) => slot.tabs.get(&tid).map_or((None, None, None, false), |t| {
                (
                    t.latest_ctx_id.clone(),
                    t.latest_obs_id.clone(),
                    t.last_vom_max_tokens,
                    t.last_vom_truncated,
                )
            }),
            None => (
                slot.latest_ctx_id.clone(),
                slot.latest_obs_id.clone(),
                slot.last_vom_max_tokens,
                slot.last_vom_truncated,
            ),
        };

        let kind = result.get("kind").and_then(Value::as_str);
        let is_unchanged_kind = kind == Some("unchanged");
        let is_delta_kind = kind == Some("delta");
        let history_ok = result
            .get("history_complete")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let changes_empty = result
            .get("changes")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty);
        let ctx_predecessor_ok = match (
            result.get("previous_context_id").and_then(Value::as_str),
            prior_ctx_id.as_deref(),
        ) {
            (Some(prev), Some(prior)) => prev == prior,
            (Some(_), None) => false,
            (None, _) => true,
        };
        let obs_predecessor_ok = match (
            result
                .get("previous_observation_id")
                .and_then(Value::as_str),
            prior_obs_id.as_deref(),
        ) {
            (Some(prev), Some(prior)) => prev == prior,
            (Some(_), None) => false,
            (None, _) => true,
        };
        let predecessor_ok = ctx_predecessor_ok && obs_predecessor_ok;
        let has_explicit_predecessor = result.get("previous_context_id").is_some()
            || result.get("previous_observation_id").is_some();
        let budget_ok = budget_compatible(prior_max_tokens, prior_truncated, requested_max_tokens);
        let exact_unchanged =
            is_unchanged_kind && history_ok && changes_empty && predecessor_ok && budget_ok;
        let patchable_delta =
            is_delta_kind && history_ok && has_explicit_predecessor && predecessor_ok && budget_ok;

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
        let obs_next_cursor = result
            .pointer("/observation/next_cursor")
            .and_then(Value::as_str);
        let obs_url = result
            .pointer("/observation/url")
            .and_then(Value::as_str)
            .or_else(|| result.pointer("/state/url").and_then(Value::as_str));
        let obs_title = result
            .pointer("/observation/title")
            .and_then(Value::as_str)
            .or_else(|| result.pointer("/state/title").and_then(Value::as_str));

        let (
            cached_vom,
            cached_truncated,
            cached_next_cursor,
            cached_url,
            cached_title,
            cache_reusable,
        ) = if let Some(tid) = effective_tab_id {
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
                tab_cache.last_vom_next_cursor = obs_next_cursor.map(str::to_string);
                tab_cache.last_vom_max_tokens = requested_max_tokens;
                true
            } else if exact_unchanged {
                tab_cache.last_vom.is_some()
            } else if patchable_delta
                && let Some(patched) = tab_cache
                    .last_vom
                    .as_deref()
                    .and_then(|prev| apply_text_delta_patch(result, prev))
            {
                tab_cache.last_vom = Some(patched);
                true
            } else {
                tab_cache.last_vom = None;
                tab_cache.last_vom_truncated = false;
                tab_cache.last_vom_next_cursor = None;
                tab_cache.last_vom_max_tokens = None;
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
                tab_cache.last_vom_next_cursor.clone(),
                tab_cache.last_url.clone(),
                tab_cache.last_title.clone(),
                reusable,
            )
        } else {
            let reusable = if let Some(text) = obs_text {
                slot.last_vom = Some(text.to_string());
                slot.last_vom_truncated = obs_truncated;
                slot.last_vom_next_cursor = obs_next_cursor.map(str::to_string);
                slot.last_vom_max_tokens = requested_max_tokens;
                true
            } else if exact_unchanged {
                slot.last_vom.is_some()
            } else if patchable_delta
                && let Some(patched) = slot
                    .last_vom
                    .as_deref()
                    .and_then(|prev| apply_text_delta_patch(result, prev))
            {
                slot.last_vom = Some(patched);
                true
            } else {
                slot.last_vom = None;
                slot.last_vom_truncated = false;
                slot.last_vom_next_cursor = None;
                slot.last_vom_max_tokens = None;
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
                slot.last_vom_next_cursor.clone(),
                slot.last_url.clone(),
                slot.last_title.clone(),
                reusable,
            )
        };

        ScopeResultMeta {
            session_id: session_id.0.clone(),
            tab_id: effective_tab_id,
            short_ctx: minted_ctx
                .map(|(s, _)| s)
                .or_else(|| slot.latest_short_ctx.clone()),
            short_obs: minted_obs
                .map(|(s, _)| s)
                .or_else(|| slot.latest_short_obs.clone()),
            cached_vom,
            cached_vom_truncated: cached_truncated,
            cached_vom_next_cursor: cached_next_cursor,
            cached_url,
            cached_title,
            cache_reusable,
        }
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
        // Host agent env vars outrank transient `mcp:<pid>:<nonce>` so `bsk mcp`
        // and `bsk` CLI within the same host agent thread share one session.
        let env_host_agent = HashMap::from([
            ("CODEX_THREAD_ID", "codex-9"),
            ("CURSOR_TRACE_ID", "cursor-9"),
        ]);
        assert_eq!(
            resolve_caller_scope_with(None, Some("mcp:1:abc"), |k| {
                env_host_agent.get(k).map(|v| (*v).to_string())
            }),
            "agent:codex:codex-9"
        );
        assert_eq!(
            resolve_caller_scope_with(None, None, |k| {
                env_host_agent.get(k).map(|v| (*v).to_string())
            }),
            "agent:codex:codex-9"
        );
        // Without host agent env vars, MCP connection falls back to its exclusive transient scope.
        assert_eq!(
            resolve_caller_scope_with(None, Some("mcp:1:abc"), |_| None),
            "mcp:1:abc"
        );
        let env_dsh = HashMap::from([("DSH_SESSION_ID", "dsh-42")]);
        assert_eq!(
            resolve_caller_scope_with(None, Some("mcp:1:abc"), |k| {
                env_dsh.get(k).map(|v| (*v).to_string())
            }),
            "agent:dsh:dsh-42"
        );
        assert_eq!(resolve_caller_scope_with(None, None, |_| None), "default");
    }

    #[test]
    fn inactive_tombstones_and_idle_start_locks_evict_at_256_lru_preserving_active() {
        let sessions = SessionRegistry::new();
        let scopes = ImplicitScopeRegistry::new();

        // Pin two active sessions and one held start lock: they MUST NEVER be evicted.
        sessions.insert(live_session("live-a", "b1"));
        sessions.insert(live_session("live-b", "b1"));
        scopes.bind_scope(
            "scope:pinned-a",
            SessionId("live-a".into()),
            BrowserId("b1".into()),
            false,
        );
        scopes.bind_scope(
            "scope:pinned-b",
            SessionId("live-b".into()),
            BrowserId("b1".into()),
            false,
        );
        let held_lock = scopes.scope_start_lock("mcp:held:0");

        for i in 0..300 {
            let transient_scope = format!("mcp:1:{i}");
            let lock = scopes.scope_start_lock(&transient_scope);
            drop(lock);
            let sid = SessionId(format!("s-{i}"));
            scopes.bind_scope(&transient_scope, sid.clone(), BrowserId("b1".into()), false);
            scopes.on_session_ended(&sid, "session_stopped");
            // Refresh `mcp:1:0` periodically so LRU order keeps it alive while `mcp:1:1` ages out.
            if i == 200 {
                let _ = scopes.resolve_implicit_session("mcp:1:0", &sessions);
            }
        }

        assert_eq!(scopes.inactive_scope_count(), INACTIVE_SCOPE_LRU_CAP);
        assert!(scopes.start_lock_count() <= INACTIVE_SCOPE_LRU_CAP);
        assert!(Arc::strong_count(&held_lock) >= 2);
        assert!(Arc::ptr_eq(
            &held_lock,
            &scopes.scope_start_lock("mcp:held:0")
        ));

        // Active bindings remain intact despite 300 transient scopes cycling through.
        assert_eq!(
            scopes
                .resolve_implicit_session("scope:pinned-a", &sessions)
                .unwrap(),
            SessionId("live-a".into())
        );
        assert_eq!(
            scopes
                .resolve_implicit_session("scope:pinned-b", &sessions)
                .unwrap(),
            SessionId("live-b".into())
        );

        // `mcp:1:1` was never touched and must have been evicted back to `no_active_session`,
        // whereas `mcp:1:0` (touched at i=200) and `mcp:1:299` retain their tombstones.
        let evicted = scopes
            .resolve_implicit_session("mcp:1:1", &sessions)
            .unwrap_err();
        assert_eq!(
            evicted.data.unwrap()["reason"],
            bsk_protocol::RpcErrorReason::NoActiveSession.as_str()
        );
        let retained_touched = scopes
            .resolve_implicit_session("mcp:1:0", &sessions)
            .unwrap_err();
        assert_eq!(retained_touched.data.unwrap()["reason"], "session_stopped");
        let retained_recent = scopes
            .resolve_implicit_session("mcp:1:299", &sessions)
            .unwrap_err();
        assert_eq!(retained_recent.data.unwrap()["reason"], "session_stopped");
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
            assert_eq!(meta.short_ctx.as_deref(), Some(format!("c{i}").as_str()));
            assert_eq!(meta.short_obs.as_deref(), Some(format!("o{i}").as_str()));
            assert_eq!(
                meta.cached_vom.as_deref(),
                Some("@vom 1\n@e1 button \"Submit\"")
            );
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
                    "previous_observation_id": format!("uuid-obs-{}", poll - 1),
                    "observation_id": format!("uuid-obs-{poll}"),
                    "control_policy": "target",
                    "kind": "unchanged",
                    "history_complete": true,
                    "changes": []
                })
            };
            let meta = scopes.record_cooperate_result(&sid, &payload);
            assert_eq!(meta.short_ctx.as_deref(), Some("c1"));
            assert_eq!(meta.short_obs.as_deref(), Some(format!("o{poll}").as_str()));
            assert!(meta.cache_reusable);
        }

        assert_eq!(
            scopes.expand_short_ctx(&sid, "c1").as_deref(),
            Some("uuid-stable-ctx")
        );
        assert_eq!(scopes.expand_short_ctx(&sid, "c2"), None);
    }

    #[test]
    fn cached_vom_remembers_a_token_budget_truncation_and_rejects_unbounded_reuse() {
        let scopes = ImplicitScopeRegistry::new();
        let sid = SessionId("s-budget".into());
        let baseline = scopes.record_cooperate_result_with_budget(
            &sid,
            Some(150),
            &json!({
                "tab_id": 7,
                "context_id": "ctx-1",
                "observation_id": "obs-1",
                "kind": "baseline",
                "observation": { "text": "Header", "truncated": true, "next_cursor": "line:20" }
            }),
        );
        assert!(baseline.cached_vom_truncated);
        assert_eq!(baseline.cached_vom_next_cursor.as_deref(), Some("line:20"));

        // Same 150-token budget may reuse the truncated cache and preserves truncation metadata.
        let unchanged_same_budget = scopes.record_cooperate_result_with_budget(
            &sid,
            Some(150),
            &json!({
                "tab_id": 7,
                "context_id": "ctx-2",
                "previous_context_id": "ctx-1",
                "observation_id": "obs-2",
                "previous_observation_id": "obs-1",
                "kind": "unchanged",
                "history_complete": true,
                "changes": []
            }),
        );
        assert!(unchanged_same_budget.cache_reusable);
        assert!(unchanged_same_budget.cached_vom_truncated);
        assert_eq!(
            unchanged_same_budget.cached_vom_next_cursor.as_deref(),
            Some("line:20")
        );

        // Unbounded sync (`None`) MUST NOT reuse the 150-token truncated cache even if a stub sent `unchanged`.
        let rejected_unbounded = scopes.record_cooperate_result_with_budget(
            &sid,
            None,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-3",
                "previous_context_id": "ctx-2",
                "observation_id": "obs-3",
                "previous_observation_id": "obs-2",
                "kind": "unchanged",
                "history_complete": true,
                "changes": []
            }),
        );
        assert!(!rejected_unbounded.cache_reusable);
        assert!(rejected_unbounded.cached_vom.is_none());

        let full = scopes.record_cooperate_result_with_budget(
            &sid,
            None,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-4",
                "observation_id": "obs-4",
                "kind": "baseline",
                "observation": { "text": "Header\nFooter", "truncated": false }
            }),
        );
        assert!(!full.cached_vom_truncated);
        assert!(full.cached_vom_next_cursor.is_none());
    }

    #[test]
    fn text_delta_patches_cached_vom_while_field_delta_invalidates_it() {
        let scopes = ImplicitScopeRegistry::new();
        let sid = SessionId("s-delta".into());

        let baseline = scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-target",
                "observation_id": "obs-1",
                "control_policy": "target",
                "kind": "baseline",
                "observation": {
                    "url": "https://example.test/live",
                    "title": "Live",
                    "text": "@vom 1\n  status \"Order pending\"\n  @e1 textbox \"Email\" value=\"old@example.test\""
                }
            }),
        );
        assert!(baseline.cache_reusable);

        // Verified text delta patches `last_vom` in place so subsequent `sync` / `sync --match` hits updated cache.
        let text_delta = scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-target",
                "previous_context_id": "ctx-target",
                "observation_id": "obs-2",
                "previous_observation_id": "obs-1",
                "control_policy": "target",
                "kind": "delta",
                "history_complete": true,
                "changes": [{
                    "frame_id": 0,
                    "kind": "text",
                    "id": "status",
                    "label": "status",
                    "previous_value": "Order pending",
                    "value": "Order shipped",
                    "lines": [2]
                }],
                "observation_patch": {
                    "lines": [{
                        "line": 2,
                        "previous": "  status \"Order pending\"",
                        "text": "  status \"Order shipped\""
                    }]
                }
            }),
        );
        assert!(text_delta.cache_reusable);
        assert_eq!(
            text_delta.cached_vom.as_deref(),
            Some(
                "@vom 1\n  status \"Order shipped\"\n  @e1 textbox \"Email\" value=\"old@example.test\""
            )
        );

        let unchanged_after_text_delta = scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-target",
                "previous_context_id": "ctx-target",
                "observation_id": "obs-3",
                "previous_observation_id": "obs-2",
                "control_policy": "target",
                "kind": "unchanged",
                "history_complete": true,
                "changes": []
            }),
        );
        assert!(unchanged_after_text_delta.cache_reusable);
        assert!(
            unchanged_after_text_delta
                .cached_vom
                .as_deref()
                .unwrap()
                .contains("Order shipped")
        );

        // Form field delta (without line patch covering `value="..."`) MUST clear `last_vom`.
        let field_delta = scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-4",
                "previous_context_id": "ctx-target",
                "observation_id": "obs-4",
                "previous_observation_id": "obs-3",
                "control_policy": "strict",
                "kind": "delta",
                "history_complete": true,
                "changes": [{"frame_id": 0, "label": "Email", "value": "alice@example.test", "previous_value": "old@example.test"}]
            }),
        );
        assert!(!field_delta.cache_reusable);
        assert!(field_delta.cached_vom.is_none());

        // A follow-up `unchanged` after field `delta` must NOT resurrect stale `value="old@example.test"`.
        let post_field_unchanged = scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-5",
                "previous_context_id": "ctx-4",
                "observation_id": "obs-5",
                "previous_observation_id": "obs-4",
                "control_policy": "strict",
                "kind": "unchanged",
                "history_complete": true,
                "changes": []
            }),
        );
        assert!(!post_field_unchanged.cache_reusable);
        assert!(post_field_unchanged.cached_vom.is_none());
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
