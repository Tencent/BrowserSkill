//! Zero-ceremony lifecycle primitives (`RM-02`): `bsk open`, `bsk sync`, `bsk close`.
//!
//! Outputs byte-deterministic state headers (free of elapsed millisecond jitter)
//! to maximize LLM prompt prefix cache hit rates across turns.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Context;
use bsk_protocol::system::{BrowserStatusEntry, SessionStatusEntry};
use bsk_protocol::tools::{
    ControlPolicy, CooperateAction, CooperateParams, NavigateParams, NavigateResult, WaitUntil,
};
use bsk_protocol::{ErrorCode, Method, RpcError};
use clap::Args;
use serde::Deserialize;
use serde_json::{Value, json};

use super::cooperate::{self, Policy};
use super::ensure_daemon::ensure_daemon;
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
) -> Result<Value, CliError> {
    let sock_buf: PathBuf = sock.to_path_buf();
    let start = Instant::now();
    let deadline = Duration::from_millis(u64::from(wait_budget_ms));

    loop {
        let mut reply = cooperate::settle::run(|action| {
            let is_sync = matches!(action, CooperateAction::Sync);
            let is_wait = matches!(action, CooperateAction::Wait);
            let mut req_val = serde_json::to_value(CooperateParams {
                control_policy: is_sync.then_some(control_policy),
                session_id: explicit_session.unwrap_or_default().to_string(),
                tab_id,
                action,
                timeout_ms: is_wait.then_some(1000),
                max_tokens,
            })
            .map_err(|e| CliError::Local(e.into()))?;
            if is_sync && let Some(obj) = req_val.as_object_mut() {
                obj.insert("_return_scope_meta".into(), Value::Bool(true));
            }
            business_rpc::call(
                sock_buf.clone(),
                "sync",
                Method::ToolCooperate,
                Some(req_val),
                TOOL_IPC_TIMEOUT,
            )
        })?;
        cooperate::verify_policy(&reply, Some(control_policy))?;
        if reply["settle"]["outcome"] == "not_ready" {
            return Err(CliError::from_rpc(RpcError {
                code: ErrorCode::PermissionDenied,
                message: "tab control is currently held by the user; wait for hand-back and run 'bsk sync'".into(),
                data: Some(json!({
                    "reason": "control_held",
                    "effect_state": "none",
                })),
            }));
        }

        let vom_text = extract_vom_text(&reply);
        let for_ok = wait_for.is_none_or(|needle| vom_text.contains(needle));
        let not_ok = wait_not.is_none_or(|needle| !vom_text.contains(needle));
        if for_ok && not_ok {
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
            return Err(CliError::from_rpc(RpcError {
                code: ErrorCode::Timeout,
                message: format!(
                    "timed out after {wait_budget_ms}ms waiting for VOM condition ({})",
                    unmet.join(", ")
                ),
                data: Some(json!({
                    "effect_state": "none",
                })),
            }));
        }
        std::thread::sleep(WAIT_POLL_INTERVAL.min(deadline - elapsed));
    }
}

fn extract_vom_text(reply: &Value) -> &str {
    reply
        .pointer("/observation/text")
        .and_then(Value::as_str)
        .or_else(|| {
            reply
                .pointer("/_scope_meta/cached_vom")
                .and_then(Value::as_str)
        })
        .unwrap_or("")
}

#[allow(clippy::too_many_arguments)]
fn render_state_receipt(
    mut reply: Value,
    fallback_session: Option<&str>,
    fallback_tab_id: Option<i64>,
    fallback_url: Option<&str>,
    fallback_title: Option<&str>,
    match_text: &[String],
    context_lines: u32,
    emit_unchanged_flag: bool,
    format: Format,
) -> Result<(), CliError> {
    let meta = reply
        .as_object_mut()
        .and_then(|obj| obj.remove("_scope_meta"))
        .unwrap_or(Value::Null);

    let unchanged = reply.get("kind").and_then(Value::as_str) == Some("unchanged")
        || reply.get("unchanged").and_then(Value::as_bool) == Some(true);

    // Hydrate `observation.text` from cached `last_vom` when the extension returned
    // `unchanged` (or delta without text) so Agent never suffers an empty-VOM re-read.
    if reply.pointer("/observation/text").is_none()
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
            println!(
                "{}",
                serde_json::to_string_pretty(&out).map_err(|e| CliError::Local(e.into()))?
            );
        }
        Format::Human => {
            let quoted_url = serde_json::to_string(url).unwrap_or_else(|_| "\"\"".into());
            let quoted_title = serde_json::to_string(title).unwrap_or_else(|_| "\"\"".into());
            if emit_unchanged_flag && unchanged {
                println!(
                    "[state session={session_id} tab={tab_id} ctx={short_ctx} unchanged=true url={quoted_url} title={quoted_title}]"
                );
            } else {
                println!(
                    "[state session={session_id} tab={tab_id} ctx={short_ctx} url={quoted_url} title={quoted_title}]"
                );
            }
            if !vom.is_empty() {
                println!("{vom}");
            }
        }
    }
    Ok(())
}
