//! Zero-ceremony lifecycle primitives (`RM-02`): `bsk open`, `bsk sync`, `bsk close`.
//!
//! Outputs byte-deterministic state headers (free of elapsed millisecond jitter)
//! to maximize LLM prompt prefix cache hit rates across turns.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Context;
use bsk_protocol::system::{BrowserStatusEntry, SessionStatusEntry};
use bsk_protocol::tools::{
    ControlPolicy, CooperateAction, CooperateParams, NavigateParams, NavigateResult,
    SnapshotParams, SnapshotResult, WaitUntil,
};
use bsk_protocol::{ErrorCode, Method, RpcError};
use clap::Args;
use serde::Deserialize;
use serde_json::{Value, json};

use super::cooperate::{self, Policy};
use super::ensure_daemon::ensure_daemon_optimistic as ensure_daemon;
use super::error::{CliError, Format};
use super::session::{StartReply, StopReply, handle_start_error, window_size};
use super::{TOOL_IPC_TIMEOUT, business_rpc};

const SESSION_START_TIMEOUT: Duration = Duration::from_secs(75);
const SESSION_STOP_TIMEOUT: Duration = Duration::from_secs(55);
const DEFAULT_WAIT_BUDGET_MS: u32 = 5_000;
const DEFAULT_NAV_TIMEOUT_MS: u32 = 30_000;
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Args)]
pub struct OpenArgs {
    /// Destination URL to open.
    pub url: String,

    /// Target browser instance ID or user label.
    #[arg(long)]
    pub browser: Option<String>,

    /// Explicit caller scope name for multi-agent isolation.
    #[arg(long)]
    pub scope: Option<String>,

    /// Explicit live session ID to reuse instead of caller scope resolution.
    #[arg(long)]
    pub session: Option<String>,

    /// Open the Agent Window in an incognito profile.
    #[arg(long)]
    pub incognito: bool,

    /// Bring a newly created Agent Window to the foreground.
    #[arg(long)]
    pub focus: bool,

    /// Keep a newly created Agent Window in the background (default).
    #[arg(long = "no-focus", conflicts_with = "focus")]
    pub no_focus: bool,

    /// Agent Window outer width in CSS pixels (100..=7680). Requires `--height`.
    #[arg(long, value_parser = window_size)]
    pub width: Option<u32>,

    /// Agent Window outer height in CSS pixels (100..=7680). Requires `--width`.
    #[arg(long, value_parser = window_size)]
    pub height: Option<u32>,

    /// Wait until the rendered VOM contains this substring (bounded polling).
    #[arg(long = "wait-for")]
    pub wait_for: Option<String>,

    /// Wait until the rendered VOM no longer contains this substring (bounded polling).
    #[arg(long = "wait-not")]
    pub wait_not: Option<String>,

    /// Bounded readiness / navigation timeout in milliseconds (default 5000ms for wait checks).
    #[arg(long = "timeout-ms", value_parser = clap::value_parser!(u32).range(1..=120_000))]
    pub timeout_ms: Option<u32>,

    /// Token budget for the VOM observation.
    #[arg(long = "max-tokens")]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Args)]
pub struct SyncArgs {
    /// Explicit session ID (omit to resolve via caller scope).
    #[arg(long)]
    pub session: Option<String>,

    /// Explicit caller scope name for multi-agent isolation.
    #[arg(long)]
    pub scope: Option<String>,

    /// Target tab ID (defaults to the session's active/default tab).
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Cooperation control policy (`auto`, `target`, or `strict`).
    #[arg(long, value_enum, default_value_t = Policy::Auto)]
    pub policy: Policy,

    /// Wait until the rendered VOM contains this substring (bounded polling).
    #[arg(long = "wait-for")]
    pub wait_for: Option<String>,

    /// Wait until the rendered VOM no longer contains this substring (bounded polling).
    #[arg(long = "wait-not")]
    pub wait_not: Option<String>,

    /// Bounded wait timeout in milliseconds (default 5000ms for `--wait-for` / `--wait-not`).
    #[arg(long = "timeout-ms", value_parser = clap::value_parser!(u32).range(1..=25_000))]
    pub timeout_ms: Option<u32>,

    /// Token budget for the VOM observation.
    #[arg(long = "max-tokens")]
    pub max_tokens: Option<u32>,

    /// Fold stateless numbered fallback buttons outside literal-match windows (repeatable).
    #[arg(long = "match-text", value_parser = nonempty_single_line)]
    pub match_text: Vec<String>,

    /// Keep numbered fallback buttons within this many lines around each `--match-text`.
    #[arg(long = "context-lines", default_value_t = 12, value_parser = clap::value_parser!(u32).range(0..=200))]
    pub context_lines: u32,
}

#[derive(Debug, Clone, Args)]
pub struct CloseArgs {
    /// Optional positional session ID to close.
    #[arg(value_name = "SESSION_ID", conflicts_with_all = ["session", "all"])]
    pub session_id: Option<String>,

    /// Optional explicit session ID flag.
    #[arg(long, conflicts_with_all = ["session_id", "all"])]
    pub session: Option<String>,

    /// Explicit caller scope name whose bound session should be closed.
    #[arg(long, conflicts_with = "all")]
    pub scope: Option<String>,

    /// Close every active session across the daemon.
    #[arg(long)]
    pub all: bool,
}

fn nonempty_single_line(value: &str) -> Result<String, String> {
    if value.trim().is_empty() || value.contains(['\r', '\n']) {
        return Err("match text must be a nonempty single-line literal".into());
    }
    Ok(value.to_owned())
}

pub fn dispatch_open(args: OpenArgs, format: Format) -> Result<(), CliError> {
    if args.url.trim().is_empty() {
        return Err(CliError::invalid_params(anyhow::anyhow!(
            "open requires a non-empty URL"
        )));
    }
    if args.width.is_some() != args.height.is_some() {
        return Err(CliError::invalid_params(anyhow::anyhow!(
            "--width and --height must be given together"
        )));
    }
    business_rpc::set_caller_scope(args.scope.clone());

    let info = ensure_daemon().context("ensure daemon is running")?;
    let session_id = resolve_or_start_open_session(&info.sock_path, &args, format)?;

    let nav_timeout_ms = args
        .timeout_ms
        .map_or(DEFAULT_NAV_TIMEOUT_MS, |ms| ms.max(DEFAULT_NAV_TIMEOUT_MS));
    let nav_reply: NavigateResult = business_rpc::call(
        info.sock_path.clone(),
        "open-nav",
        Method::ToolNavigate,
        Some(NavigateParams {
            session_id: session_id.clone(),
            url: args.url.clone(),
            tab_id: None,
            wait_until: Some(WaitUntil::Load),
            timeout_ms: Some(nav_timeout_ms),
        }),
        business_rpc::ipc_timeout(nav_timeout_ms),
    )?;

    let wait_budget = args.timeout_ms.unwrap_or(DEFAULT_WAIT_BUDGET_MS);
    let reply = settled_sync_with_conditions(
        &info.sock_path,
        Some(session_id.as_str()),
        Some(nav_reply.tab_id),
        ControlPolicy::Auto,
        args.max_tokens,
        args.wait_for.as_deref(),
        args.wait_not.as_deref(),
        wait_budget,
        "committed",
    )?;

    render_state_receipt(
        reply,
        Some(session_id.as_str()),
        Some(nav_reply.tab_id),
        nav_reply
            .final_url
            .as_deref()
            .or(Some(nav_reply.url.as_str())),
        None,
        &[],
        12,
        false,
        format,
    )
}

pub fn dispatch_sync(args: SyncArgs, format: Format) -> Result<(), CliError> {
    business_rpc::set_caller_scope(args.scope.clone());
    let control_policy = ControlPolicy::from(args.policy);
    if matches!(control_policy, ControlPolicy::Target) {
        business_rpc::set_target_policy_requested();
    }

    let info = ensure_daemon().context("ensure daemon is running")?;
    let wait_budget = args.timeout_ms.unwrap_or(DEFAULT_WAIT_BUDGET_MS);
    let reply = settled_sync_with_conditions(
        &info.sock_path,
        args.session.as_deref(),
        args.tab_id,
        control_policy,
        args.max_tokens,
        args.wait_for.as_deref(),
        args.wait_not.as_deref(),
        wait_budget,
        "none",
    )?;

    render_state_receipt(
        reply,
        args.session.as_deref(),
        args.tab_id,
        None,
        None,
        &args.match_text,
        args.context_lines,
        true,
        format,
    )
}

pub fn dispatch_close(args: CloseArgs, format: Format) -> Result<(), CliError> {
    business_rpc::set_caller_scope(args.scope.clone());
    let info = ensure_daemon().context("ensure daemon is running")?;

    let explicit_sid = args
        .session_id
        .or(args.session)
        .filter(|s| !s.trim().is_empty());

    let mut payload = json!({
        "all": args.all,
    });
    if let Some(ref sid) = explicit_sid {
        payload["session_id"] = Value::String(sid.clone());
    } else if !args.all {
        payload["_caller_scope"] = Value::String(business_rpc::current_caller_scope());
    }

    let reply: StopReply = business_rpc::call(
        info.sock_path,
        "close",
        Method::SessionStop,
        Some(payload),
        SESSION_STOP_TIMEOUT,
    )?;

    if let Some(first_fail) = reply.failed.first() {
        return Err(CliError::from_rpc(RpcError {
            code: first_fail.code,
            message: first_fail.message.clone(),
            data: Some(json!({
                "session_id": first_fail.session_id,
                "return_failures": reply.return_failures,
            })),
        }));
    }

    match format {
        Format::Json => {
            let out = if args.all {
                json!({
                    "closed": true,
                    "all": true,
                    "stopped": reply.stopped,
                    "returned_tab_ids": reply.returned_tab_ids,
                })
            } else {
                let sid = reply
                    .stopped
                    .first()
                    .cloned()
                    .or(explicit_sid)
                    .unwrap_or_default();
                json!({
                    "closed": true,
                    "session_id": sid,
                    "stopped": reply.stopped,
                    "returned_tab_ids": reply.returned_tab_ids,
                })
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&out).map_err(|e| CliError::Local(e.into()))?
            );
        }
        Format::Human => {
            if args.all {
                if reply.stopped.len() == 1 {
                    println!("[closed session={}]", reply.stopped[0]);
                } else if reply.stopped.is_empty() {
                    println!("[closed session=none]");
                } else {
                    println!("[closed sessions={}]", reply.stopped.join(","));
                }
            } else {
                let sid = reply
                    .stopped
                    .first()
                    .cloned()
                    .or(explicit_sid)
                    .unwrap_or_default();
                println!("[closed session={sid}]");
            }
        }
    }
    Ok(())
}

fn resolve_or_start_open_session(
    sock: &Path,
    args: &OpenArgs,
    format: Format,
) -> Result<String, CliError> {
    if let Some(ref explicit_sid) = args.session {
        if args.browser.is_some() {
            verify_explicit_session_browser(sock, explicit_sid, args.browser.as_deref().unwrap())?;
        }
        return Ok(explicit_sid.clone());
    }

    let scope = business_rpc::current_caller_scope();
    let mut start_payload = json!({
        "incognito": args.incognito,
        "focused": args.focus,
        "_caller_scope": scope,
        "_bind_scope": true,
        "_reuse_or_start_scope": true,
        "_explicit_incognito": args.incognito,
    });
    if let Some(ref browser) = args.browser {
        start_payload["browser_instance_id"] = Value::String(browser.clone());
    }
    if let (Some(w), Some(h)) = (args.width, args.height) {
        start_payload["width"] = w.into();
        start_payload["height"] = h.into();
    }

    match business_rpc::call::<Value, StartReply>(
        sock.to_path_buf(),
        "open-start",
        Method::SessionStart,
        Some(start_payload),
        SESSION_START_TIMEOUT,
    ) {
        Ok(reply) => Ok(reply.session_id),
        Err(err) => Err(handle_start_error(err, format)),
    }
}

fn verify_explicit_session_browser(
    sock: &Path,
    session_id: &str,
    requested_browser: &str,
) -> Result<(), CliError> {
    #[derive(Deserialize)]
    struct SessionsResp {
        sessions: Vec<SessionStatusEntry>,
    }
    #[derive(Deserialize)]
    struct BrowsersResp {
        browsers: Vec<BrowserStatusEntry>,
    }
    let list: SessionsResp = business_rpc::call(
        sock.to_path_buf(),
        "open-sessions",
        Method::SessionList,
        Some(json!({})),
        TOOL_IPC_TIMEOUT,
    )?;
    let Some(entry) = list.sessions.iter().find(|s| s.session_id == session_id) else {
        return Err(CliError::from_rpc(RpcError {
            code: ErrorCode::NotFound,
            message: format!("session '{session_id}' does not exist"),
            data: None,
        }));
    };
    if entry.browser_instance_id == requested_browser {
        return Ok(());
    }
    let browsers: BrowsersResp = business_rpc::call(
        sock.to_path_buf(),
        "open-browsers",
        Method::BrowserList,
        Some(json!({})),
        TOOL_IPC_TIMEOUT,
    )?;
    let matches_label = browsers
        .browsers
        .iter()
        .any(|b| b.instance_id == entry.browser_instance_id && b.label == requested_browser);
    if !matches_label {
        return Err(CliError::from_rpc(RpcError {
            code: ErrorCode::InvalidParams,
            message: format!(
                "session '{session_id}' belongs to browser '{}', which conflicts with --browser '{requested_browser}'",
                entry.browser_instance_id
            ),
            data: Some(json!({
                "reason": crate::rpc_reason::SCOPE_BROWSER_CONFLICT,
                "session_id": session_id,
                "bound_browser": entry.browser_instance_id,
                "requested_browser": requested_browser,
            })),
        }));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn settled_sync_with_conditions(
    sock: &Path,
    explicit_session: Option<&str>,
    tab_id: Option<i64>,
    control_policy: ControlPolicy,
    max_tokens: Option<u32>,
    wait_for: Option<&str>,
    wait_not: Option<&str>,
    wait_budget_ms: u32,
    prior_effect_state: &'static str,
) -> Result<Value, CliError> {
    let sock_buf: PathBuf = sock.to_path_buf();
    settled_sync_with_conditions_using(
        explicit_session,
        tab_id,
        control_policy,
        max_tokens,
        wait_for,
        wait_not,
        wait_budget_ms,
        prior_effect_state,
        |prefix, method, req_val| {
            business_rpc::call(
                sock_buf.clone(),
                prefix,
                method,
                Some(req_val),
                TOOL_IPC_TIMEOUT,
            )
        },
        std::thread::sleep,
    )
}

#[allow(clippy::too_many_arguments)]
fn settled_sync_with_conditions_using(
    explicit_session: Option<&str>,
    tab_id: Option<i64>,
    control_policy: ControlPolicy,
    max_tokens: Option<u32>,
    wait_for: Option<&str>,
    wait_not: Option<&str>,
    wait_budget_ms: u32,
    prior_effect_state: &'static str,
    mut call_rpc: impl FnMut(&'static str, Method, Value) -> Result<Value, CliError>,
    mut pause: impl FnMut(Duration),
) -> Result<Value, CliError> {
    let start = Instant::now();
    let deadline = Duration::from_millis(u64::from(wait_budget_ms));
    // Every sync advances the extension's baseline, so changes, activity and
    // missing history reported by a frame this wait does not return would be lost.
    let mut carried = CarriedObservation::default();
    let mut last_snapshot_error: Option<String> = None;

    loop {
        let mut reply = run_settled_cooperate_sync(
            explicit_session.unwrap_or_default(),
            tab_id,
            explicit_session,
            tab_id,
            control_policy,
            max_tokens,
            prior_effect_state,
            &mut call_rpc,
        )?;

        if wait_for.is_none() && wait_not.is_none() {
            if let Some(obj) = reply.as_object_mut() {
                obj.remove("settle");
            }
            return Ok(reply);
        }

        // Slim `delta` and uncached `unchanged` frames carry no full VOM, and a
        // `max_tokens` budget can cut text off. A substring check against
        // `[change ...]` lines, empty text or a truncated page would pass
        // `--wait-not` while the text is still visible, or time out `--wait-for`
        // when it is in the static page. Read the full page with `tool.snapshot`
        // instead. That replaces the session refs, so a matching wait syncs again
        // for a current context; otherwise the next poll's sync is a baseline.
        let mut refs_replaced = false;
        let mut evaluation = authoritative_full_vom(&reply)
            .map(|(text, truncated)| WaitEvaluation::new(text, truncated, wait_for, wait_not));
        if evaluation.is_none() {
            match read_snapshot(&reply, explicit_session, tab_id, max_tokens, &mut call_rpc) {
                Ok((text, truncated)) => {
                    refs_replaced = true;
                    evaluation = Some(WaitEvaluation::new(&text, truncated, wait_for, wait_not));
                }
                Err(error) => last_snapshot_error = Some(error.to_string()),
            }
        }
        // Absence in a truncated page is not proof; check the whole page once.
        if let Some(found) = evaluation.as_mut()
            && found.met()
            && found.truncated
            && let Some(needle) = wait_not
        {
            match read_snapshot(&reply, explicit_session, tab_id, None, &mut call_rpc) {
                Ok((text, _)) => {
                    refs_replaced = true;
                    found.not_ok = !text.contains(needle);
                }
                Err(error) => {
                    found.not_ok = false;
                    last_snapshot_error = Some(error.to_string());
                }
            }
        }
        let (for_ok, not_ok) = evaluation
            .as_ref()
            .map_or((false, false), |found| (found.for_ok, found.not_ok));

        if for_ok && not_ok {
            if refs_replaced {
                // The snapshot replaced the refs this frame's context names;
                // synchronize the session and tab it read.
                let (session_id, target_tab) = frame_target(&reply, explicit_session, tab_id);
                let resynced = run_settled_cooperate_sync(
                    &session_id,
                    target_tab,
                    explicit_session,
                    tab_id,
                    control_policy,
                    max_tokens,
                    prior_effect_state,
                    &mut call_rpc,
                )?;
                carried.absorb(&reply);
                reply = resynced;
                if authoritative_full_vom(&reply).is_none() && start.elapsed() < deadline {
                    // Another caller synchronized in between; poll again rather
                    // than return a frame without the page it was checked against.
                    carried.absorb(&reply);
                    pause(WAIT_POLL_INTERVAL.min(deadline - start.elapsed()));
                    continue;
                }
            }
            carried.apply(&mut reply);
            if let Some(obj) = reply.as_object_mut() {
                obj.remove("settle");
            }
            return Ok(reply);
        }

        let elapsed = start.elapsed();
        if elapsed >= deadline {
            let mut unmet = Vec::new();
            if !for_ok && let Some(w) = wait_for {
                unmet.push(format!("--wait-for {w:?}"));
            }
            if !not_ok && let Some(w) = wait_not {
                unmet.push(format!("--wait-not {w:?}"));
            }
            let mut data = json!({
                "effect_state": prior_effect_state,
            });
            if let Some(sid) = explicit_session.filter(|s| !s.is_empty()) {
                data["session_id"] = Value::String(sid.to_string());
            }
            if let Some(tid) = tab_id {
                data["tab_id"] = Value::from(tid);
            }
            if let Some(error) = &last_snapshot_error {
                data["last_snapshot_error"] = Value::String(error.clone());
            }
            return Err(CliError::from_rpc(RpcError {
                code: ErrorCode::Timeout,
                message: format!(
                    "timed out after {wait_budget_ms}ms waiting for VOM condition ({})",
                    unmet.join(", ")
                ),
                data: Some(data),
            }));
        }
        carried.absorb(&reply);
        pause(WAIT_POLL_INTERVAL.min(deadline - elapsed));
    }
}

/// `--wait-for` / `--wait-not` outcome on one page text.
struct WaitEvaluation {
    for_ok: bool,
    not_ok: bool,
    truncated: bool,
}

impl WaitEvaluation {
    fn new(text: &str, truncated: bool, wait_for: Option<&str>, wait_not: Option<&str>) -> Self {
        Self {
            for_ok: wait_for.is_none_or(|needle| text.contains(needle)),
            not_ok: wait_not.is_none_or(|needle| !text.contains(needle)),
            truncated,
        }
    }

    fn met(&self) -> bool {
        self.for_ok && self.not_ok
    }
}

/// The session and tab a sync frame describes, falling back to the request.
fn frame_target(
    reply: &Value,
    explicit_session: Option<&str>,
    tab_id: Option<i64>,
) -> (String, Option<i64>) {
    let session_id = reply
        .pointer("/_scope_meta/session_id")
        .and_then(Value::as_str)
        .or_else(|| reply.pointer("/state/session_id").and_then(Value::as_str))
        .or(explicit_session)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
        .to_string();
    let tab_id = reply
        .get("tab_id")
        .and_then(Value::as_i64)
        .or_else(|| reply.pointer("/_scope_meta/tab_id").and_then(Value::as_i64))
        .or(tab_id);
    (session_id, tab_id)
}

/// Reads the full page of the frame's session and tab with `tool.snapshot`.
fn read_snapshot(
    reply: &Value,
    explicit_session: Option<&str>,
    tab_id: Option<i64>,
    max_tokens: Option<u32>,
    call_rpc: &mut impl FnMut(&'static str, Method, Value) -> Result<Value, CliError>,
) -> Result<(String, bool), CliError> {
    let (session_id, tab_id) = frame_target(reply, explicit_session, tab_id);
    let request = serde_json::to_value(SnapshotParams {
        session_id,
        tab_id,
        max_depth: None,
        max_tokens,
    })
    .map_err(|e| CliError::Local(e.into()))?;
    let snapshot: SnapshotResult =
        serde_json::from_value(call_rpc("sync-snapshot", Method::ToolSnapshot, request)?)
            .map_err(|e| CliError::Local(e.into()))?;
    Ok((snapshot.text, snapshot.truncated))
}

/// Changes, activity and history gaps from frames a wait polled but discarded.
#[derive(Default)]
struct CarriedObservation {
    changes: Vec<Value>,
    activity: Vec<Value>,
    history_incomplete: bool,
}

impl CarriedObservation {
    fn absorb(&mut self, reply: &Value) {
        self.history_incomplete |=
            reply.get("history_complete").and_then(Value::as_bool) == Some(false);
        for change in reply
            .get("changes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let key = |c: &Value| {
                (
                    c.get("frame_id").cloned(),
                    c.get("id").or_else(|| c.get("label")).cloned(),
                )
            };
            // A field changed twice keeps its first previous value and its last value.
            match self.changes.iter_mut().find(|old| key(old) == key(change)) {
                Some(old) => {
                    let previous = old.get("previous_value").cloned();
                    *old = change.clone();
                    match previous {
                        Some(previous) => old["previous_value"] = previous,
                        None => {
                            if let Some(obj) = old.as_object_mut() {
                                obj.remove("previous_value");
                            }
                        }
                    }
                }
                None => self.changes.push(change.clone()),
            }
        }
        for event in reply
            .get("activity")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !self.activity.contains(event) {
                self.activity.push(event.clone());
            }
        }
    }

    /// Adds what the discarded frames reported to the frame the wait returns.
    fn apply(mut self, reply: &mut Value) {
        if !reply.is_object()
            || (self.changes.is_empty() && self.activity.is_empty() && !self.history_incomplete)
        {
            return;
        }
        let carried_activity = !self.activity.is_empty();
        self.absorb(reply);
        if !self.changes.is_empty() {
            reply["changes"] = Value::Array(self.changes);
        }
        if !self.activity.is_empty() {
            reply["activity"] = Value::Array(self.activity);
        }
        if carried_activity {
            reply["_carried_activity"] = Value::Bool(true);
        }
        if self.history_incomplete {
            reply["history_complete"] = Value::Bool(false);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_settled_cooperate_sync(
    session_id_param: &str,
    tab_id_param: Option<i64>,
    explicit_session: Option<&str>,
    explicit_tab_id: Option<i64>,
    control_policy: ControlPolicy,
    max_tokens: Option<u32>,
    prior_effect_state: &'static str,
    call_rpc: &mut impl FnMut(&'static str, Method, Value) -> Result<Value, CliError>,
) -> Result<Value, CliError> {
    let reply = cooperate::settle::run(|action| {
        let is_sync = matches!(action, CooperateAction::Sync);
        let is_wait = matches!(action, CooperateAction::Wait);
        let mut req_val = serde_json::to_value(CooperateParams {
            control_policy: is_sync.then_some(control_policy),
            session_id: session_id_param.to_string(),
            tab_id: tab_id_param,
            action,
            timeout_ms: is_wait.then_some(1000),
            max_tokens,
        })
        .map_err(|e| CliError::Local(e.into()))?;
        if is_sync && let Some(obj) = req_val.as_object_mut() {
            obj.insert("_return_scope_meta".into(), Value::Bool(true));
        }
        call_rpc("sync", Method::ToolCooperate, req_val)
    })?;
    cooperate::verify_policy(&reply, Some(control_policy))?;
    if reply["settle"]["outcome"] == "not_ready" {
        let mut data = json!({
            "reason": "control_held",
            "effect_state": prior_effect_state,
        });
        if let Some(sid) = explicit_session.filter(|s| !s.is_empty()) {
            data["session_id"] = Value::String(sid.to_string());
        }
        if let Some(tid) = explicit_tab_id {
            data["tab_id"] = Value::from(tid);
        }
        return Err(CliError::from_rpc(RpcError {
            code: ErrorCode::PermissionDenied,
            message:
                "tab control is currently held by the user; wait for hand-back and run 'bsk sync'"
                    .into(),
            data: Some(data),
        }));
    }
    Ok(reply)
}

/// The frame's full page text, and whether a `max_tokens` budget cut it: a
/// baseline's observation, or the cached VOM of an exact unchanged frame.
fn authoritative_full_vom(reply: &Value) -> Option<(&str, bool)> {
    if let Some(text) = reply.pointer("/observation/text").and_then(Value::as_str) {
        let truncated = reply
            .pointer("/observation/truncated")
            .and_then(Value::as_bool)
            == Some(true);
        return Some((text, truncated));
    }
    let kind = reply.get("kind").and_then(Value::as_str);
    let is_unchanged = kind == Some("unchanged")
        || (kind != Some("delta") && reply.get("unchanged").and_then(Value::as_bool) == Some(true));
    if is_unchanged
        && reply
            .pointer("/_scope_meta/cache_reusable")
            .and_then(Value::as_bool)
            == Some(true)
    {
        let truncated = reply
            .pointer("/_scope_meta/cached_vom_truncated")
            .and_then(Value::as_bool)
            == Some(true);
        return reply
            .pointer("/_scope_meta/cached_vom")
            .and_then(Value::as_str)
            .map(|text| (text, truncated));
    }
    None
}

fn format_delta_change_lines(reply: &Value) -> Vec<String> {
    let Some(changes) = reply.get("changes").and_then(Value::as_array) else {
        return Vec::new();
    };
    changes
        .iter()
        .map(|change| {
            let label = change.get("label").and_then(Value::as_str).unwrap_or("");
            let value = change.get("value").and_then(Value::as_str).unwrap_or("");
            let quoted_label = serde_json::to_string(label).unwrap_or_else(|_| "\"\"".into());
            let quoted_value = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into());
            let mut parts = Vec::with_capacity(4);
            if let Some(id) = change
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                let quoted_id = serde_json::to_string(id).unwrap_or_else(|_| "\"\"".into());
                parts.push(format!("id={quoted_id}"));
            }
            parts.push(format!("label={quoted_label}"));
            if let Some(prev) = change.get("previous_value").and_then(Value::as_str) {
                let quoted_prev = serde_json::to_string(prev).unwrap_or_else(|_| "\"\"".into());
                parts.push(format!("previous={quoted_prev}"));
            }
            parts.push(format!("value={quoted_value}"));
            format!("[change {}]", parts.join(" "))
        })
        .collect()
}

fn format_activity_lines(reply: &Value) -> Vec<String> {
    let Some(activity) = reply.get("activity").and_then(Value::as_array) else {
        return Vec::new();
    };
    activity
        .iter()
        .map(|event| {
            let kind = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("activity");
            let label = event.get("label").and_then(Value::as_str).unwrap_or("");
            let quoted_label = serde_json::to_string(label).unwrap_or_else(|_| "\"\"".into());
            format!("[activity type={kind} label={quoted_label}]")
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn render_state_receipt(
    reply: Value,
    fallback_session: Option<&str>,
    fallback_tab_id: Option<i64>,
    fallback_url: Option<&str>,
    fallback_title: Option<&str>,
    match_text: &[String],
    context_lines: u32,
    emit_unchanged_flag: bool,
    format: Format,
) -> Result<(), CliError> {
    let rendered = format_state_receipt(
        reply,
        fallback_session,
        fallback_tab_id,
        fallback_url,
        fallback_title,
        match_text,
        context_lines,
        emit_unchanged_flag,
        format,
    )?;
    print!("{rendered}");
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn format_state_receipt(
    mut reply: Value,
    fallback_session: Option<&str>,
    fallback_tab_id: Option<i64>,
    fallback_url: Option<&str>,
    fallback_title: Option<&str>,
    match_text: &[String],
    context_lines: u32,
    emit_unchanged_flag: bool,
    format: Format,
) -> Result<String, CliError> {
    let meta = reply
        .as_object_mut()
        .and_then(|obj| obj.remove("_scope_meta"))
        .unwrap_or(Value::Null);

    let kind = reply.get("kind").and_then(Value::as_str).map(str::to_owned);
    let is_delta = kind.as_deref() == Some("delta");
    let unchanged = kind.as_deref() == Some("unchanged")
        || reply.get("unchanged").and_then(Value::as_bool) == Some(true);
    let cache_reusable = meta
        .get("cache_reusable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let history_incomplete = reply.get("history_complete").and_then(Value::as_bool) == Some(false);
    // Activity from frames a wait discarded is reported even with a full page.
    let carried_activity = reply
        .as_object_mut()
        .and_then(|obj| obj.remove("_carried_activity"))
        .is_some();

    // Hydrate `observation.text` from cached `last_vom` ONLY when `_scope_meta`
    // confirms an exact unchanged predecessor (`cache_reusable == true`). Never
    // hydrate stale VOM onto a `delta` or incomplete-history reply.
    if reply.pointer("/observation/text").is_none()
        && cache_reusable
        && let Some(cached_vom) = meta.get("cached_vom").and_then(Value::as_str)
    {
        if !reply.get("observation").is_some_and(Value::is_object) {
            reply["observation"] = json!({});
        }
        reply["observation"]["text"] = Value::String(cached_vom.to_string());
    }

    if !match_text.is_empty() {
        cooperate::presentation::filter(&mut reply, match_text, context_lines as usize);
    }

    let session_id = meta
        .get("session_id")
        .and_then(Value::as_str)
        .or_else(|| reply.pointer("/state/session_id").and_then(Value::as_str))
        .or(fallback_session)
        .unwrap_or("");

    let tab_id = reply
        .get("tab_id")
        .and_then(Value::as_i64)
        .or_else(|| meta.get("tab_id").and_then(Value::as_i64))
        .or(fallback_tab_id)
        .unwrap_or(0);

    let context_id = reply
        .get("context_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let short_ctx = meta
        .get("short_ctx")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(context_id);

    let observation_id = reply.get("observation_id").and_then(Value::as_str);
    let short_obs = meta
        .get("short_obs")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());

    let url = reply
        .pointer("/observation/url")
        .and_then(Value::as_str)
        .or_else(|| reply.pointer("/state/url").and_then(Value::as_str))
        .or_else(|| meta.get("cached_url").and_then(Value::as_str))
        .or(fallback_url)
        .unwrap_or("");

    let title = reply
        .pointer("/observation/title")
        .and_then(Value::as_str)
        .or_else(|| reply.pointer("/state/title").and_then(Value::as_str))
        .or_else(|| meta.get("cached_title").and_then(Value::as_str))
        .or(fallback_title)
        .unwrap_or("");

    let vom = reply
        .pointer("/observation/text")
        .and_then(Value::as_str)
        .unwrap_or("");

    match format {
        Format::Json => {
            let mut out = json!({
                "session_id": session_id,
                "tab_id": tab_id,
                "ctx": short_ctx,
                "context_id": context_id,
                "observation_id": observation_id,
                "url": url,
                "title": title,
                "vom": vom,
            });
            if let Some(obs) = short_obs {
                out["obs"] = Value::String(obs.to_string());
            }
            if emit_unchanged_flag || unchanged {
                out["unchanged"] = Value::Bool(unchanged);
            }
            if is_delta {
                out["kind"] = Value::String("delta".into());
            }
            if let Some(changes) = reply.get("changes").and_then(Value::as_array)
                && (is_delta || !changes.is_empty())
            {
                out["changes"] = Value::Array(changes.clone());
            }
            if let Some(activity) = reply.get("activity").and_then(Value::as_array)
                && !activity.is_empty()
            {
                out["activity"] = Value::Array(activity.clone());
            }
            if history_incomplete {
                out["history_complete"] = Value::Bool(false);
            }
            let mut rendered =
                serde_json::to_string_pretty(&out).map_err(|e| CliError::Local(e.into()))?;
            rendered.push('\n');
            Ok(rendered)
        }
        Format::Human => {
            let mut rendered = String::new();
            let quoted_url = serde_json::to_string(url).unwrap_or_else(|_| "\"\"".into());
            let quoted_title = serde_json::to_string(title).unwrap_or_else(|_| "\"\"".into());
            let mut extra_flags = String::new();
            if emit_unchanged_flag && unchanged {
                extra_flags.push_str(" unchanged=true");
            } else if is_delta {
                extra_flags.push_str(" delta=true");
            }
            if history_incomplete {
                extra_flags.push_str(" history_complete=false");
            }
            let _ = writeln!(
                rendered,
                "[state session={session_id} tab={tab_id} ctx={short_ctx}{extra_flags} url={quoted_url} title={quoted_title}]"
            );
            if !vom.is_empty() {
                let _ = writeln!(rendered, "{vom}");
            }
            if is_delta
                || reply
                    .get("changes")
                    .and_then(Value::as_array)
                    .is_some_and(|c| !c.is_empty())
            {
                for line in format_delta_change_lines(&reply) {
                    let _ = writeln!(rendered, "{line}");
                }
            }
            if is_delta || vom.is_empty() || carried_activity {
                for line in format_activity_lines(&reply) {
                    let _ = writeln!(rendered, "{line}");
                }
            }
            Ok(rendered)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::scopes::ImplicitScopeRegistry;
    use crate::daemon::sessions::SessionId;

    fn authoritative_full_vom_is_some(reply: &Value) -> bool {
        authoritative_full_vom(reply).is_some()
    }

    fn attach_recorded_meta(
        scopes: &ImplicitScopeRegistry,
        sid: &SessionId,
        mut reply: Value,
    ) -> Value {
        let meta = scopes.record_cooperate_result(sid, &reply);
        reply["_scope_meta"] = meta;
        reply
    }

    #[test]
    fn has_authoritative_full_vom_distinguishes_baseline_cached_unchanged_and_slim_frames() {
        assert!(authoritative_full_vom_is_some(&json!({
            "kind": "baseline",
            "observation": { "text": "@e1 button \"Ready\"" }
        })));
        assert!(authoritative_full_vom_is_some(&json!({
            "kind": "unchanged",
            "_scope_meta": {
                "cache_reusable": true,
                "cached_vom": "@e1 button \"Ready\""
            }
        })));
        assert!(authoritative_full_vom_is_some(&json!({
            "unchanged": true,
            "_scope_meta": {
                "cache_reusable": true,
                "cached_vom": "@e1 button \"Ready\""
            }
        })));

        // Delta frames never carry authoritative full VOM, even if changes exist.
        assert!(!authoritative_full_vom_is_some(&json!({
            "kind": "delta",
            "changes": [{ "label": "Query", "value": "foo" }],
            "_scope_meta": {
                "cache_reusable": false,
                "cached_vom": null
            }
        })));
        // Uncached `unchanged` frames (e.g. post-delta or incomplete history) are not authoritative.
        assert!(!authoritative_full_vom_is_some(&json!({
            "kind": "unchanged",
            "_scope_meta": {
                "cache_reusable": false,
                "cached_vom": null
            }
        })));
        assert!(!authoritative_full_vom_is_some(&json!({
            "kind": "unchanged"
        })));
        assert!(!authoritative_full_vom_is_some(&json!({
            "kind": "delta",
            "unchanged": true,
            "_scope_meta": {
                "cache_reusable": true,
                "cached_vom": "@e1 button \"Stale\""
            }
        })));
    }

    #[test]
    fn wait_not_on_delta_promotes_to_full_baseline_and_reuses_cached_vom_until_gone() {
        let scopes = ImplicitScopeRegistry::new();
        let sid = SessionId("s1a2".into());

        // Seed an earlier strict baseline in ScopeRegistry before the field delta happens.
        scopes.record_cooperate_result(
            &sid,
            &json!({
                "tab_id": 7,
                "context_id": "ctx-0",
                "control_policy": "strict",
                "kind": "baseline",
                "observation": {
                    "url": "https://app.test/search",
                    "title": "Search",
                    "text": "Status: Loading...\n@e1 textbox \"Query\" value=\"\""
                }
            }),
        );

        let mut calls: Vec<(Method, Value)> = Vec::new();
        let mut sync_call = 0usize;

        let reply = settled_sync_with_conditions_using(
            None,
            None,
            ControlPolicy::Strict,
            Some(4096),
            None,
            Some("Loading..."),
            5_000,
            "none",
            |_prefix, method, req| {
                calls.push((method.clone(), req.clone()));
                match method {
                    Method::ToolSnapshot => Ok(json!({
                        "text": "Status: Loading...\n@e1 textbox \"Query\" value=\"foo\"",
                        "ref_count": 1,
                        "tab_id": 7,
                        "truncated": false
                    })),
                    Method::ToolCooperate => {
                        sync_call += 1;
                        let raw = match sync_call {
                            // Poll 1 initial sync: slim delta with unrelated field change,
                            // while "Loading..." is STILL visible in static page VOM!
                            1 => json!({
                                "tab_id": 7,
                                "context_id": "ctx-1-delta",
                                "previous_context_id": "ctx-0",
                                "control_policy": "strict",
                                "kind": "delta",
                                "history_complete": true,
                                "changes": [{
                                    "frame_id": 0,
                                    "label": "Query",
                                    "previous_value": "",
                                    "value": "foo"
                                }],
                                "state": { "mode": "ready", "revision": 2 }
                            }),
                            // Poll 1 post-snapshot sync: refStore.revision bumped -> full baseline!
                            // Still contains "Loading...", so --wait-not must NOT succeed yet.
                            2 => json!({
                                "tab_id": 7,
                                "context_id": "ctx-2-promoted",
                                "control_policy": "strict",
                                "kind": "baseline",
                                "observation": {
                                    "url": "https://app.test/search",
                                    "title": "Search",
                                    "text": "Status: Loading...\n@e1 textbox \"Query\" value=\"foo\""
                                },
                                "state": { "mode": "ready", "revision": 2 }
                            }),
                            // Poll 2 sync: nothing changed yet -> `unchanged` with `cache_reusable: true`.
                            // Must reuse `_scope_meta.cached_vom` with ZERO extra ToolSnapshot calls!
                            3 => json!({
                                "tab_id": 7,
                                "context_id": "ctx-3-unchanged",
                                "previous_context_id": "ctx-2-promoted",
                                "control_policy": "strict",
                                "kind": "unchanged",
                                "history_complete": true,
                                "changes": [],
                                "state": { "mode": "ready", "revision": 2 }
                            }),
                            // Poll 3 sync: "Loading..." finally disappears from the page!
                            4 => json!({
                                "tab_id": 7,
                                "context_id": "ctx-4-done",
                                "control_policy": "strict",
                                "kind": "baseline",
                                "observation": {
                                    "url": "https://app.test/search",
                                    "title": "Search",
                                    "text": "Status: Results ready\n@e1 textbox \"Query\" value=\"foo\""
                                },
                                "state": { "mode": "ready", "revision": 3 }
                            }),
                            other => panic!("unexpected sync_call #{other}"),
                        };
                        Ok(attach_recorded_meta(&scopes, &sid, raw))
                    }
                    other => panic!("unexpected RPC method: {other:?}"),
                }
            },
            |_| {},
        )
        .expect("wait-not should succeed once Loading... disappears");

        let methods: Vec<Method> = calls.iter().map(|(m, _)| m.clone()).collect();
        assert_eq!(
            methods,
            vec![
                Method::ToolCooperate,
                Method::ToolSnapshot,
                Method::ToolCooperate,
                Method::ToolCooperate,
                Method::ToolCooperate,
            ],
            "ToolSnapshot must be called once for baseline promotion and skipped on cached unchanged poll"
        );
        // Verify resolved session_id, tab_id, and max_tokens were forwarded to ToolSnapshot.
        assert_eq!(calls[1].1["session_id"], "s1a2");
        assert_eq!(calls[1].1["tab_id"], 7);
        assert_eq!(calls[1].1["max_tokens"], 4096);
        // "Loading..." is still in the full page, so this poll does not sync
        // again: the next poll's sync returns the baseline.
        assert_eq!(calls[2].1["_return_scope_meta"], true);

        assert_eq!(reply["context_id"], "ctx-4-done");
        assert_eq!(
            reply["observation"]["text"],
            "Status: Results ready\n@e1 textbox \"Query\" value=\"foo\""
        );
        assert!(reply.get("settle").is_none());
    }

    #[test]
    fn wait_for_on_uncached_unchanged_and_delta_promotes_immediately_without_timeout() {
        // Case A: `kind: "unchanged"` with `cache_reusable: false` (e.g. post-delta or uncached session)
        let scopes = ImplicitScopeRegistry::new();
        let sid = SessionId("s-uncached".into());
        let mut calls_a = Vec::new();
        let mut coop_a = 0usize;

        let reply_a = settled_sync_with_conditions_using(
            Some("s-uncached"),
            Some(9),
            ControlPolicy::Auto,
            None,
            Some("Ready"),
            None,
            5_000,
            "committed",
            |_prefix, method, req| {
                calls_a.push((method.clone(), req));
                match method {
                    Method::ToolSnapshot => Ok(json!({
                        "text": "Banner: Ready\n@e1 button \"Continue\"",
                        "ref_count": 1,
                        "tab_id": 9,
                        "truncated": false
                    })),
                    Method::ToolCooperate => {
                        coop_a += 1;
                        let raw = match coop_a {
                            1 => json!({
                                "tab_id": 9,
                                "context_id": "ctx-u1",
                                "previous_context_id": "ctx-prior-unknown",
                                "control_policy": "target",
                                "observation_id": "obs-u1",
                                "kind": "unchanged",
                                "history_complete": true,
                                "changes": [],
                                "state": { "mode": "ready", "revision": 1 }
                            }),
                            2 => json!({
                                "tab_id": 9,
                                "context_id": "ctx-u1",
                                "control_policy": "target",
                                "observation_id": "obs-u2",
                                "kind": "baseline",
                                "observation": {
                                    "url": "https://app.test/ready",
                                    "title": "ReadyPage",
                                    "text": "Banner: Ready\n@e1 button \"Continue\""
                                },
                                "state": { "mode": "ready", "revision": 1 }
                            }),
                            other => panic!("unexpected cooperate call #{other}"),
                        };
                        Ok(attach_recorded_meta(&scopes, &sid, raw))
                    }
                    other => panic!("unexpected method: {other:?}"),
                }
            },
            |_| panic!("must succeed on first poll without sleeping"),
        )
        .expect("uncached unchanged should promote and match Ready immediately");

        assert_eq!(calls_a.len(), 3);
        assert_eq!(calls_a[0].0, Method::ToolCooperate);
        assert_eq!(calls_a[1].0, Method::ToolSnapshot);
        assert_eq!(calls_a[2].0, Method::ToolCooperate);
        assert_eq!(reply_a["observation_id"], "obs-u2");
        assert_eq!(
            reply_a["observation"]["text"],
            "Banner: Ready\n@e1 button \"Continue\""
        );

        // Case B: `kind: "delta"` where "Ready" is in static VOM, NOT in `changes`.
        let scopes_b = ImplicitScopeRegistry::new();
        let sid_b = SessionId("s-delta".into());
        let mut calls_b = Vec::new();
        let mut coop_b = 0usize;

        let reply_b = settled_sync_with_conditions_using(
            None,
            None,
            ControlPolicy::Strict,
            None,
            Some("Ready"),
            None,
            5_000,
            "none",
            |_prefix, method, req| {
                calls_b.push((method.clone(), req));
                match method {
                    Method::ToolSnapshot => Ok(json!({
                        "text": "Heading: Ready\n@e1 textbox \"Note\" value=\"typed\"",
                        "ref_count": 1,
                        "tab_id": 4,
                        "truncated": false
                    })),
                    Method::ToolCooperate => {
                        coop_b += 1;
                        let raw = match coop_b {
                            1 => json!({
                                "tab_id": 4,
                                "context_id": "ctx-d1",
                                "control_policy": "strict",
                                "kind": "delta",
                                "history_complete": true,
                                "changes": [{
                                    "frame_id": 0,
                                    "label": "Note",
                                    "previous_value": "",
                                    "value": "typed"
                                }],
                                "state": { "mode": "ready", "revision": 2 }
                            }),
                            2 => json!({
                                "tab_id": 4,
                                "context_id": "ctx-d2-fresh",
                                "control_policy": "strict",
                                "kind": "baseline",
                                "observation": {
                                    "url": "https://app.test/note",
                                    "title": "Note",
                                    "text": "Heading: Ready\n@e1 textbox \"Note\" value=\"typed\""
                                },
                                "state": { "mode": "ready", "revision": 2 }
                            }),
                            other => panic!("unexpected cooperate call #{other}"),
                        };
                        Ok(attach_recorded_meta(&scopes_b, &sid_b, raw))
                    }
                    other => panic!("unexpected method: {other:?}"),
                }
            },
            |_| panic!("must succeed on first poll without sleeping"),
        )
        .expect("delta should promote to baseline and match static Ready text");

        assert_eq!(calls_b.len(), 3);
        assert_eq!(reply_b["context_id"], "ctx-d2-fresh");
        assert_eq!(reply_b["kind"], "baseline");
    }

    #[test]
    fn sync_without_wait_conditions_preserves_slim_delta_and_unchanged_with_zero_snapshots() {
        let mut methods = Vec::new();
        let reply = settled_sync_with_conditions_using(
            None,
            None,
            ControlPolicy::Strict,
            None,
            None,
            None,
            5_000,
            "none",
            |_prefix, method, _req| {
                methods.push(method.clone());
                Ok(json!({
                    "tab_id": 7,
                    "context_id": "ctx-slim-delta",
                    "control_policy": "strict",
                    "kind": "delta",
                    "history_complete": true,
                    "changes": [{
                        "frame_id": 0,
                        "label": "Email",
                        "previous_value": "old@app.test",
                        "value": "new@app.test"
                    }],
                    "_scope_meta": {
                        "session_id": "s1",
                        "tab_id": 7,
                        "short_ctx": "c2",
                        "cached_vom": null,
                        "cached_url": "https://app.test/form",
                        "cached_title": "Form",
                        "cache_reusable": false
                    }
                }))
            },
            |_| panic!("must not sleep when no wait conditions are given"),
        )
        .unwrap();

        assert_eq!(methods, vec![Method::ToolCooperate]);
        assert_eq!(reply["kind"], "delta");
        assert!(reply.pointer("/observation/text").is_none());

        let human =
            format_state_receipt(reply, None, None, None, None, &[], 12, true, Format::Human)
                .unwrap();
        assert_eq!(
            human,
            "[state session=s1 tab=7 ctx=c2 delta=true url=\"https://app.test/form\" title=\"Form\"]\n[change label=\"Email\" previous=\"old@app.test\" value=\"new@app.test\"]\n"
        );
    }

    #[test]
    fn cached_unchanged_wait_match_hydrates_vom_cleanly_in_human_and_json_formats() {
        let mut methods = Vec::new();
        let reply = settled_sync_with_conditions_using(
            None,
            None,
            ControlPolicy::Auto,
            None,
            Some("Ready"),
            Some("Loading..."),
            5_000,
            "none",
            |_prefix, method, _req| {
                methods.push(method);
                Ok(json!({
                    "tab_id": 7,
                    "context_id": "uuid-ctx-2",
                    "observation_id": "uuid-obs-2",
                    "control_policy": "target",
                    "kind": "unchanged",
                    "_scope_meta": {
                        "session_id": "s1",
                        "tab_id": 7,
                        "short_ctx": "c1",
                        "short_obs": "o2",
                        "cached_vom": "Status: Ready\n@e1 button \"Submit\"",
                        "cached_url": "https://app.test/dashboard",
                        "cached_title": "Dashboard",
                        "cache_reusable": true
                    }
                }))
            },
            |_| panic!("must not sleep"),
        )
        .unwrap();

        assert_eq!(methods, vec![Method::ToolCooperate]);

        let human = format_state_receipt(
            reply.clone(),
            None,
            None,
            None,
            None,
            &[],
            12,
            true,
            Format::Human,
        )
        .unwrap();
        assert_eq!(
            human,
            "[state session=s1 tab=7 ctx=c1 unchanged=true url=\"https://app.test/dashboard\" title=\"Dashboard\"]\nStatus: Ready\n@e1 button \"Submit\"\n"
        );

        let json_out: Value = serde_json::from_str(
            &format_state_receipt(reply, None, None, None, None, &[], 12, true, Format::Json)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json_out["unchanged"], true);
        assert_eq!(json_out["ctx"], "c1");
        assert_eq!(json_out["obs"], "o2");
        assert_eq!(json_out["vom"], "Status: Ready\n@e1 button \"Submit\"");
    }

    #[test]
    fn a_frame_without_the_checked_page_after_the_snapshot_is_polled_again() {
        // Another caller can sync between the snapshot and the wait's own sync,
        // so that sync is a delta again. Return only a frame with the page.
        let mut coop_count = 0usize;
        let mut pauses = 0usize;
        let reply = settled_sync_with_conditions_using(
            Some("s-mock"),
            Some(5),
            ControlPolicy::Strict,
            None,
            Some("Ready"),
            Some("Spinner"),
            5_000,
            "none",
            |_prefix, method, _req| match method {
                Method::ToolSnapshot => Ok(json!({
                    "text": "Banner: Ready\n@e1 textbox \"Field\" value=\"v2\"",
                    "ref_count": 1,
                    "tab_id": 5,
                    "truncated": false
                })),
                Method::ToolCooperate => {
                    coop_count += 1;
                    if coop_count < 3 {
                        return Ok(json!({
                            "tab_id": 5,
                            "context_id": format!("ctx-{coop_count}"),
                            "control_policy": "strict",
                            "kind": "delta",
                            "changes": [{ "label": "Field", "value": "v2" }],
                        }));
                    }
                    Ok(json!({
                        "tab_id": 5,
                        "context_id": "ctx-3",
                        "control_policy": "strict",
                        "kind": "baseline",
                        "observation": { "text": "Banner: Ready\n@e1 textbox \"Field\" value=\"v2\"" },
                    }))
                }
                other => panic!("unexpected method: {other:?}"),
            },
            |_| pauses += 1,
        )
        .unwrap();

        assert_eq!(coop_count, 3);
        assert_eq!(pauses, 1);
        assert_eq!(reply["context_id"], "ctx-3");
        assert_eq!(reply["kind"], "baseline");
        // Both discarded deltas reported the field; it is still listed once.
        assert_eq!(
            reply["changes"],
            json!([{ "label": "Field", "value": "v2" }])
        );
    }

    #[test]
    fn discarded_frames_keep_human_changes_activity_and_missing_history() {
        let mut coop_count = 0usize;
        let reply = settled_sync_with_conditions_using(
            Some("s1"),
            Some(7),
            ControlPolicy::Strict,
            None,
            Some("Total 1000"),
            None,
            5_000,
            "none",
            |_prefix, method, _req| match method {
                Method::ToolSnapshot => Ok(json!({
                    "text": "Total 10\n@e1 textbox \"Amount\" value=\"1000\"",
                    "ref_count": 1,
                    "tab_id": 7,
                    "truncated": false
                })),
                Method::ToolCooperate => {
                    coop_count += 1;
                    Ok(match coop_count {
                        // The user changed Amount; the extension reports it once.
                        1 => json!({
                            "tab_id": 7,
                            "context_id": "ctx-1",
                            "control_policy": "strict",
                            "kind": "delta",
                            "history_complete": false,
                            "changes": [{ "frame_id": 0, "label": "Amount", "previous_value": "10", "value": "100" }],
                            "activity": [{ "kind": "human_input", "label": "Amount" }],
                        }),
                        2 => json!({
                            "tab_id": 7,
                            "context_id": "ctx-2",
                            "control_policy": "strict",
                            "kind": "delta",
                            "changes": [{ "frame_id": 0, "label": "Amount", "previous_value": "100", "value": "1000" }],
                        }),
                        _ => json!({
                            "tab_id": 7,
                            "context_id": "ctx-3",
                            "control_policy": "strict",
                            "kind": "baseline",
                            "history_complete": true,
                            "activity": [],
                            "observation": { "text": "Total 1000\n@e1 textbox \"Amount\" value=\"1000\"" },
                        }),
                    })
                }
                other => panic!("unexpected method: {other:?}"),
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(reply["context_id"], "ctx-3");
        assert_eq!(
            reply["changes"],
            json!([{ "frame_id": 0, "label": "Amount", "previous_value": "10", "value": "1000" }])
        );
        assert_eq!(
            reply["activity"],
            json!([{ "kind": "human_input", "label": "Amount" }])
        );
        assert_eq!(reply["history_complete"], false);
        let human = format_state_receipt(
            reply.clone(),
            None,
            None,
            None,
            None,
            &[],
            12,
            true,
            Format::Human,
        )
        .unwrap();
        assert!(human.contains("history_complete=false"), "{human}");
        assert!(human.contains("Amount"), "{human}");
        let json_out: Value = serde_json::from_str(
            &format_state_receipt(reply, None, None, None, None, &[], 12, true, Format::Json)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(json_out["activity"][0]["kind"], "human_input");
        assert!(json_out.get("_carried_activity").is_none());
    }

    #[test]
    fn a_nonmatching_delta_snapshot_defers_sync_until_the_next_poll() {
        let poll = std::cell::Cell::new(1);
        let mut calls = Vec::new();
        let reply = settled_sync_with_conditions_using(
            Some("s1"),
            Some(7),
            ControlPolicy::Strict,
            None,
            Some("Done"),
            None,
            DEFAULT_WAIT_BUDGET_MS,
            "none",
            |_prefix, method, _req| {
                let poll_number = poll.get();
                calls.push((method.clone(), poll_number));
                match (poll_number, method) {
                    (1, Method::ToolCooperate) => Ok(json!({
                        "tab_id": 7,
                        "context_id": "ctx-1",
                        "kind": "delta",
                        "changes": [{ "label": "Clock", "value": "1" }]
                    })),
                    (1, Method::ToolSnapshot) => Ok(json!({
                        "text": "Progress",
                        "ref_count": 0,
                        "tab_id": 7,
                        "truncated": false
                    })),
                    (2, Method::ToolCooperate) => Ok(json!({
                        "tab_id": 7,
                        "context_id": "ctx-2",
                        "kind": "baseline",
                        "observation": { "text": "Done" }
                    })),
                    (_, other) => panic!("unexpected method in poll {poll_number}: {other:?}"),
                }
            },
            |_| poll.set(poll.get() + 1),
        )
        .unwrap();

        assert_eq!(reply["context_id"], "ctx-2");
        assert_eq!(
            calls,
            [
                (Method::ToolCooperate, 1),
                (Method::ToolSnapshot, 1),
                (Method::ToolCooperate, 2),
            ]
        );
    }

    #[test]
    fn a_failed_snapshot_keeps_waiting_instead_of_ending_the_wait() {
        let mut snapshots = 0usize;
        let mut coop_count = 0usize;
        let reply = settled_sync_with_conditions_using(
            Some("s1"),
            Some(7),
            ControlPolicy::Strict,
            None,
            Some("Ready"),
            None,
            5_000,
            "committed",
            |_prefix, method, _req| match method {
                Method::ToolSnapshot => {
                    snapshots += 1;
                    Err(CliError::from_rpc(RpcError {
                        code: ErrorCode::CdpFailed,
                        message: "Execution context was destroyed".into(),
                        data: None,
                    }))
                }
                Method::ToolCooperate => {
                    coop_count += 1;
                    Ok(if coop_count == 1 {
                        json!({ "tab_id": 7, "context_id": "ctx-1", "kind": "delta", "changes": [] })
                    } else {
                        json!({ "tab_id": 7, "context_id": "ctx-2", "kind": "baseline", "observation": { "text": "Ready" } })
                    })
                }
                other => panic!("unexpected method: {other:?}"),
            },
            |_| {},
        )
        .unwrap();
        assert_eq!(snapshots, 1);
        assert_eq!(reply["context_id"], "ctx-2");
    }

    #[test]
    fn wait_not_checks_the_whole_page_when_the_budget_truncated_it() {
        let scopes = ImplicitScopeRegistry::new();
        let sid = SessionId("s1".into());
        let mut frames = [
            json!({
                "tab_id": 7,
                "context_id": "ctx-1",
                "kind": "baseline",
                "observation": { "text": "Header", "truncated": true }
            }),
            json!({
                "tab_id": 7,
                "context_id": "ctx-2",
                "previous_context_id": "ctx-1",
                "kind": "unchanged",
                "history_complete": true,
                "changes": []
            }),
            json!({
                "tab_id": 7,
                "context_id": "ctx-3",
                "kind": "baseline",
                "observation": { "text": "Ready", "truncated": false }
            }),
        ]
        .into_iter();
        let mut snapshot_budgets = Vec::new();
        let reply = settled_sync_with_conditions_using(
            None,
            None,
            ControlPolicy::Strict,
            Some(20),
            None,
            Some("Loading"),
            DEFAULT_WAIT_BUDGET_MS,
            "none",
            |_prefix, method, req| match method {
                Method::ToolSnapshot => {
                    snapshot_budgets.push(req["max_tokens"].clone());
                    // The spinner is below the token budget.
                    Ok(json!({
                        "text": "Header\nLoading...",
                        "ref_count": 0,
                        "tab_id": 7,
                        "truncated": false
                    }))
                }
                Method::ToolCooperate => {
                    let frame = frames.next().expect("unexpected sync");
                    Ok(attach_recorded_meta(&scopes, &sid, frame))
                }
                other => panic!("unexpected method: {other:?}"),
            },
            |_| {},
        )
        .unwrap();

        // The truncated baseline and the cached, truncated unchanged frame were
        // both checked against the untruncated page.
        assert_eq!(reply["context_id"], "ctx-3");
        assert_eq!(snapshot_budgets, [Value::Null, Value::Null]);
    }

    #[test]
    fn wait_not_on_uncached_unchanged_does_not_falsely_pass_on_empty_text() {
        let scopes = ImplicitScopeRegistry::new();
        let sid = SessionId("s-wait-not".into());
        let mut coop_count = 0usize;

        let reply = settled_sync_with_conditions_using(
            Some("s-wait-not"),
            Some(3),
            ControlPolicy::Strict,
            None,
            None,
            Some("Loading..."),
            5_000,
            "none",
            |_prefix, method, _req| match method {
                Method::ToolSnapshot => Ok(json!({
                    "text": "Overlay: Loading...\n@e1 button \"Cancel\"",
                    "ref_count": 1,
                    "tab_id": 3,
                    "truncated": false
                })),
                Method::ToolCooperate => {
                    coop_count += 1;
                    let raw = match coop_count {
                        // Uncached `unchanged` frame (`cache_reusable: false`): must NOT evaluate
                        // `!"Loading...".contains` against `""`!
                        1 => json!({
                            "tab_id": 3,
                            "context_id": "ctx-u1",
                            "previous_context_id": "ctx-missing",
                            "control_policy": "strict",
                            "kind": "unchanged",
                            "history_complete": true,
                            "changes": []
                        }),
                        // Promoted baseline confirms "Loading..." is still present.
                        2 => json!({
                            "tab_id": 3,
                            "context_id": "ctx-u2",
                            "control_policy": "strict",
                            "kind": "baseline",
                            "observation": {
                                "url": "https://app.test/wait",
                                "title": "Wait",
                                "text": "Overlay: Loading...\n@e1 button \"Cancel\""
                            }
                        }),
                        // Next poll: overlay clears.
                        3 => json!({
                            "tab_id": 3,
                            "context_id": "ctx-u3",
                            "control_policy": "strict",
                            "kind": "baseline",
                            "observation": {
                                "url": "https://app.test/wait",
                                "title": "Wait",
                                "text": "Main content\n@e2 button \"Save\""
                            }
                        }),
                        other => panic!("unexpected cooperate call #{other}"),
                    };
                    Ok(attach_recorded_meta(&scopes, &sid, raw))
                }
                other => panic!("unexpected method: {other:?}"),
            },
            |_| {},
        )
        .unwrap();

        assert_eq!(coop_count, 3);
        assert_eq!(reply["context_id"], "ctx-u3");
        assert_eq!(
            reply["observation"]["text"],
            "Main content\n@e2 button \"Save\""
        );
    }

    #[test]
    fn control_held_during_baseline_promotion_preserves_prior_effect_state() {
        let mut coop_step = 0usize;
        let err = settled_sync_with_conditions_using(
            Some("s-open"),
            Some(7),
            ControlPolicy::Auto,
            None,
            Some("Dashboard"),
            None,
            5_000,
            "committed",
            |_prefix, method, _req| match method {
                Method::ToolSnapshot => Ok(json!({
                    "text": "Dashboard",
                    "ref_count": 0,
                    "tab_id": 7,
                    "truncated": false
                })),
                Method::ToolCooperate => {
                    coop_step += 1;
                    match coop_step {
                        1 => Ok(json!({
                            "tab_id": 7,
                            "context_id": "ctx-1",
                            "control_policy": "target",
                            "kind": "unchanged",
                            "_scope_meta": {
                                "session_id": "s-open",
                                "tab_id": 7,
                                "cache_reusable": false,
                                "cached_vom": null
                            }
                        })),
                        // Post-snapshot sync hits transient recoverable refusal, then Wait sees human hold!
                        2 => Err(CliError::from_rpc(RpcError {
                            code: ErrorCode::PermissionDenied,
                            message: "The user is still operating this tab; wait for hand-back"
                                .into(),
                            data: Some(json!({
                                "reason": "cooperation_sync_required",
                                "effect_state": "none"
                            })),
                        })),
                        3 => Ok(json!({
                            "ready": false,
                            "state": { "mode": "held" }
                        })),
                        other => panic!("unexpected cooperate step #{other}"),
                    }
                }
                other => panic!("unexpected method: {other:?}"),
            },
            |_| {},
        )
        .unwrap_err();

        assert_eq!(err.code(), Some(ErrorCode::PermissionDenied));
        let data = err.data().expect("error data");
        assert_eq!(data["reason"], "control_held");
        assert_eq!(data["effect_state"], "committed");
        assert_eq!(data["session_id"], "s-open");
        assert_eq!(data["tab_id"], 7);
    }
}
