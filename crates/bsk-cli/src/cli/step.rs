//! One explicit action, optional positive readiness condition, then read-only sync.
use super::{
    business_rpc, cooperate,
    ensure_daemon::ensure_daemon_optimistic as ensure_daemon,
    error::{CliError, Format},
    observation_view, orchestration,
};
use anyhow::{Context, ensure};
use bsk_protocol::{Method, tools::*};
use clap::{Args, ValueEnum};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum Action {
    Click,
    Press,
    Fill,
    Hover,
    Select,
    Drag,
    ScrollTo,
    Wheel,
    Navigate,
}

#[derive(Debug, Clone, Args)]
pub struct StepArgs {
    #[arg(long)]
    pub session: Option<String>,
    #[arg(long)]
    pub scope: Option<String>,
    /// Post-action sync policy. Auto preserves an existing choice or starts target control.
    /// Use cooperate sync first when choosing a policy before the action.
    #[arg(long, value_enum, default_value = "auto")]
    pub policy: cooperate::Policy,
    #[arg(long)]
    pub tab_id: Option<i64>,
    /// Exactly one ordinary browser action; never retried.
    #[arg(long, value_enum)]
    pub action: Action,
    /// JSON object using the action's protocol fields (ref/selector/value/key/etc.).
    /// Session, tab, context and dependencies come from CLI flags, not this object.
    #[arg(long)]
    pub params: String,
    /// Known CSS selector (main document and accessible iframes) that should become visible after the action.
    /// Use a positive readiness signal; visibility alone does not prove business success.
    #[arg(long)]
    pub until_visible: Option<String>,
    /// Readiness budget in milliseconds, independent of the action timeout.
    #[arg(long, default_value_t = 5000, value_parser = clap::value_parser!(u32).range(1..=25000))]
    pub wait_timeout_ms: u32,
    /// Token budget for the post-action VOM observation. Keep the same budget across syncs, steps, and plans to preserve cache reuse.
    #[arg(long = "max-tokens")]
    pub max_tokens: Option<u32>,
    /// Save the unfiltered combined result, atomically, without overwriting.
    #[arg(long)]
    pub save_full: Option<PathBuf>,
    /// Exact saved predecessor for an unchanged post-action sync.
    #[arg(long)]
    pub baseline: Option<PathBuf>,
    /// Fold only plain numbered fallback buttons outside literal-match windows (repeatable).
    ///
    /// Only stateless `button "item N"` lines may be omitted. Keeps business text,
    /// named/stateful controls and complete forms/dialogs. Use `bsk view <saved.json>
    /// --find <text>` for text search. A requested full reply is saved before folding.
    #[arg(long)]
    pub match_text: Vec<String>,
    /// Keep numbered fallback buttons within this many lines before/after each match.
    #[arg(long, default_value_t = 12, value_parser = clap::value_parser!(u32).range(0..=200))]
    pub context_lines: u32,
}

fn known_keys(input: &Value, normalized: &Value) -> anyhow::Result<()> {
    if let Some(fields) = input.as_object() {
        for (key, value) in fields {
            let other = normalized
                .get(key)
                .with_context(|| format!("unknown or null action parameter: {key}"))?;
            known_keys(value, other)?;
        }
    }
    Ok(())
}
pub(crate) fn typed<T: DeserializeOwned + Serialize>(input: &Value) -> anyhow::Result<Value> {
    let typed: T = serde_json::from_value(input.clone()).context("invalid action parameters")?;
    let normalized = serde_json::to_value(typed)?;
    known_keys(input, &normalized)?;
    Ok(normalized)
}
pub(crate) fn target(value: &Value, required: bool) -> anyhow::Result<()> {
    let count = ["ref", "selector"]
        .iter()
        .filter(|k| value.get(**k).is_some())
        .count();
    ensure!(
        count <= 1 && (!required || count == 1),
        "pass exactly one ref or selector for each required target"
    );
    for key in ["ref", "selector"] {
        if let Some(v) = value.get(key) {
            ensure!(
                v.as_str().is_some_and(|s| !s.trim().is_empty()),
                "empty {key}"
            );
        }
    }
    Ok(())
}
/// Arguments of the optional wait and of the presentation that follow actions.
pub(crate) fn check_follow_args(
    until_visible: Option<&str>,
    match_text: &[String],
) -> anyhow::Result<()> {
    ensure!(
        match_text
            .iter()
            .all(|s| !s.trim().is_empty() && !s.contains(['\n', '\r'])),
        "match text must be a nonempty single-line literal"
    );
    ensure!(
        until_visible.is_none_or(|s| !s.trim().is_empty()),
        "empty readiness selector"
    );
    Ok(())
}
/// Identity and evidence are the caller's, never fields of an action.
pub(crate) fn reject_reserved(fields: &serde_json::Map<String, Value>) -> anyhow::Result<()> {
    for key in [
        "session_id",
        "tab_id",
        "context_id",
        "depends_on",
        "expect",
        "observation_id",
    ] {
        ensure!(
            !fields.contains_key(key),
            "{key} must be supplied with CLI flags"
        );
    }
    Ok(())
}
pub(crate) fn prepare(args: &StepArgs) -> anyhow::Result<(Method, Value)> {
    check_follow_args(args.until_visible.as_deref(), &args.match_text)?;
    let params: Value = serde_json::from_str(&args.params).context("parse --params JSON")?;
    action_params(
        args.session.as_deref().unwrap_or_default(),
        args.tab_id,
        args.action,
        params,
    )
}
/// Validate one action's protocol fields against its protocol type.
pub(crate) fn action_params(
    session: &str,
    tab_id: Option<i64>,
    action: Action,
    mut v: Value,
) -> anyhow::Result<(Method, Value)> {
    let object = v
        .as_object_mut()
        .context("--params must be a JSON object")?;
    reject_reserved(object)?;
    object.insert("session_id".into(), session.into());
    if let Some(tab) = tab_id {
        object.insert("tab_id".into(), tab.into());
    }
    if let Some(ms) = v.get("timeout_ms") {
        let raw = ms.as_u64().ok_or_else(|| {
            if matches!(action, Action::Navigate) {
                anyhow::anyhow!("timeout_ms must be 1..=120000")
            } else {
                anyhow::anyhow!("action timeout_ms must be 1..=30000")
            }
        })?;
        if matches!(action, Action::Navigate) {
            orchestration::validate_open_timeout_ms(raw).map_err(anyhow::Error::msg)?;
        } else {
            orchestration::validate_action_timeout_ms(raw).map_err(anyhow::Error::msg)?;
        }
    }
    let result = match action {
        Action::Click => {
            let parsed: ClickParams =
                serde_json::from_value(v.clone()).context("invalid action parameters")?;
            let normalized = serde_json::to_value(&parsed)?;
            known_keys(&v, &normalized)?;
            super::orchestration::validate_click_params(&parsed).map_err(anyhow::Error::msg)?;
            (Method::ToolClick, normalized)
        }
        Action::Press => (Method::ToolPress, typed::<PressParams>(&v)?),
        Action::Fill => (Method::ToolFill, typed::<FillParams>(&v)?),
        Action::Hover => (Method::ToolHover, typed::<HoverParams>(&v)?),
        Action::Select => (Method::ToolSelect, typed::<SelectParams>(&v)?),
        Action::Drag => (Method::ToolDrag, typed::<DragParams>(&v)?),
        Action::ScrollTo => (Method::ToolScrollTo, typed::<ScrollToParams>(&v)?),
        Action::Wheel => (Method::ToolWheel, typed::<WheelParams>(&v)?),
        Action::Navigate => (Method::ToolNavigate, typed::<NavigateParams>(&v)?),
    };
    match action {
        Action::Navigate | Action::Click => {}
        Action::Drag => {
            target(&result.1["source"], true)?;
            ensure!(
                result.1.get("target").is_some() != result.1.get("delta").is_some(),
                "drag requires exactly one target or delta"
            );
            if let Some(t) = result.1.get("target") {
                target(t, true)?;
            }
        }
        Action::Press | Action::Wheel => target(&result.1, false)?,
        _ => target(&result.1, true)?,
    }
    Ok(result)
}
pub(crate) fn failure(error: &CliError) -> Value {
    json!({"message":error.to_string(),"code":error.code(),"data":error.data(),"exit_code":error.exit_code()})
}
pub(crate) fn interrupted(error: &CliError) -> bool {
    matches!(
        error.code(),
        Some(bsk_protocol::ErrorCode::Cancelled | bsk_protocol::ErrorCode::UserAborted)
    )
}

/// Wait for a known selector on the action's tab. Returns whether the wait was
/// interrupted, which ends the operation without a follow-up sync.
pub(crate) fn await_ready(
    session: &str,
    tab: Option<i64>,
    selector: &str,
    wait_timeout_ms: u32,
    result: &mut Value,
    exit: &mut u8,
    call: &mut impl FnMut(Method, Value, Duration) -> Result<Value, CliError>,
) -> bool {
    let wait = call(
        Method::ToolWaitForElement,
        json!({"session_id":session,"tab_id":tab,
        "selector":selector,"state":"visible","timeout_ms":wait_timeout_ms,"poll_ms":100}),
        business_rpc::ipc_timeout(wait_timeout_ms),
    );
    match wait {
        Ok(wait) => {
            if wait["satisfied"] != true {
                *exit = (*exit).max(1);
            }
            result["readiness"] = wait;
            false
        }
        Err(error) => {
            result["readiness"] = json!({"error":failure(&error)});
            *exit = (*exit).max(error.exit_code());
            interrupted(&error)
        }
    }
}

pub(crate) struct PostSyncOptions<'a> {
    pub(crate) session: &'a str,
    pub(crate) policy: cooperate::Policy,
    pub(crate) tab: Option<i64>,
    pub(crate) max_tokens: Option<u32>,
    pub(crate) hydrate_cache: bool,
}

/// The read-only sync that ends an operation, stored as `post` or `post_error`.
/// Requests daemon `ScopeResultMeta` on sync so `unchanged` and text-`delta`
/// replies hydrate `post.observation.text` when `hydrate_cache` is true.
pub(crate) fn post_sync_with_meta(
    opts: PostSyncOptions<'_>,
    result: &mut Value,
    exit: &mut u8,
    call: &mut impl FnMut(
        Method,
        Value,
        Duration,
        bool,
    ) -> Result<(Value, Option<crate::ipc_client::ScopeResultMeta>), CliError>,
) {
    let mut latest_meta = None;
    let sync = cooperate::settle::run(|mode| {
        let is_sync = matches!(mode, CooperateAction::Sync | CooperateAction::Enable);
        let params = CooperateParams {
            control_policy: is_sync.then_some(opts.policy.into()),
            session_id: opts.session.to_owned(),
            action: mode,
            tab_id: opts.tab,
            timeout_ms: Some(1000),
            max_tokens: is_sync.then_some(opts.max_tokens).flatten(),
        };
        let ipc_timeout = cooperate::cooperate_ipc_timeout(params.timeout_ms);
        let (val, scope_meta) = call(
            Method::ToolCooperate,
            serde_json::to_value(params).expect("serializable sync"),
            ipc_timeout,
            is_sync,
        )?;
        if is_sync {
            latest_meta = scope_meta;
        }
        Ok(val)
    })
    .and_then(|reply| {
        cooperate::verify_policy(&reply, Some(opts.policy.into()))?;
        Ok(reply)
    });
    match sync {
        Ok(mut value) => {
            if value["context_id"].as_str().is_none() {
                *exit = (*exit).max(1);
            }
            if opts.hydrate_cache {
                orchestration::hydrate_cached_observation(&mut value, latest_meta.as_ref());
            }
            result["post"] = value;
        }
        Err(error) => {
            *exit = (*exit).max(error.exit_code());
            result["post_error"] = failure(&error);
        }
    }
}

#[cfg(test)]
pub(crate) fn run(
    args: &StepArgs,
    method: Method,
    params: Value,
    mut call: impl FnMut(Method, Value, Duration) -> Result<Value, CliError>,
) -> (Value, u8) {
    run_with_meta(args, method, params, true, |method, params, timeout, _| {
        call(method, params, timeout).map(|val| (val, None))
    })
}

pub(crate) fn run_with_meta(
    args: &StepArgs,
    method: Method,
    params: Value,
    hydrate_cache: bool,
    mut call: impl FnMut(
        Method,
        Value,
        Duration,
        bool,
    ) -> Result<(Value, Option<crate::ipc_client::ScopeResultMeta>), CliError>,
) -> (Value, u8) {
    let start = Instant::now();
    let mut pinned_session = args
        .session
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let action_timeout = orchestration::tool_ipc_timeout(&method, &params);
    let (action, action_meta) = match call(method, params, action_timeout, pinned_session.is_none())
    {
        Ok((value, meta)) => (value, meta),
        Err(error) => {
            return (
                json!({"ok":false,"phase":"action","action":{"error":failure(&error)},
                "action_replayed":false,"rpc_calls":1,"elapsed_ms":start.elapsed().as_millis()}),
                error.exit_code(),
            );
        }
    };
    if pinned_session.is_none()
        && let Some(sm) = action_meta.filter(|m| !m.session_id.trim().is_empty())
    {
        pinned_session = Some(sm.session_id);
    }
    let action_ms = start.elapsed().as_millis();
    // Pin all reads to the action's actual session and tab; never follow a concurrent scope rebind or human's active tab.
    let tab = action["tab_id"].as_i64().or(args.tab_id);
    // Navigation timeout is an RPC result, but the navigate command exits 4.
    let mut exit = if matches!(args.action, Action::Navigate) && action["reached"] == "timeout" {
        4
    } else {
        0
    };
    let mut result = json!({"ok":false,"action":{"result":action},"action_replayed":false});
    let mut rpc_calls = 1;
    let mut counted_call = |method, params, timeout, want_meta| {
        rpc_calls += 1;
        call(method, params, timeout, want_meta)
    };
    let session = pinned_session.as_deref().unwrap_or_default();
    if let Some(selector) = &args.until_visible {
        let mut plain_call = |method, params, timeout| {
            counted_call(method, params, timeout, false).map(|(val, _)| val)
        };
        if await_ready(
            session,
            tab,
            selector,
            args.wait_timeout_ms,
            &mut result,
            &mut exit,
            &mut plain_call,
        ) {
            result["phase"] = "readiness".into();
            result["rpc_calls"] = rpc_calls.into();
            result["elapsed_ms"] = json!(start.elapsed().as_millis());
            return (result, exit);
        }
    } else {
        result["readiness"] = json!({"requested":false});
    }
    let ready_ms = start.elapsed().as_millis() - action_ms;
    post_sync_with_meta(
        PostSyncOptions {
            session,
            policy: args.policy,
            tab,
            max_tokens: args.max_tokens,
            hydrate_cache,
        },
        &mut result,
        &mut exit,
        &mut counted_call,
    );
    result["phase"] = if exit == 0 {
        "observed"
    } else {
        "needs_attention"
    }
    .into();
    result["ok"] = (exit == 0).into();
    result["rpc_calls"] = rpc_calls.into();
    result["timing_ms"] = json!({"action":action_ms,"readiness":ready_ms,
        "sync":start.elapsed().as_millis()-action_ms-ready_ms,"total":start.elapsed().as_millis()});
    (result, exit)
}

/// Saving and folding shared by the commands that end in a synchronized reply.
pub(crate) struct Output<'a> {
    session: &'a str,
    baseline: Option<Value>,
    saved: Option<cooperate::saved_reply::SavedReply>,
    save_full: Option<&'a Path>,
    match_text: &'a [String],
    context_lines: u32,
}

impl<'a> Output<'a> {
    /// Preflight output before the action. A post-action I/O failure must retain its result.
    pub(crate) fn prepare(
        session: &'a str,
        baseline: Option<&Path>,
        save_full: Option<&'a Path>,
        match_text: &'a [String],
        context_lines: u32,
    ) -> Result<Self, CliError> {
        Ok(Self {
            session,
            baseline: baseline
                .map(observation_view::read)
                .transpose()
                .map_err(|error| {
                    CliError::file_validation(
                        error,
                        "check --baseline: provide a readable, valid saved reply",
                    )
                })?,
            saved: save_full
                .map(cooperate::saved_reply::SavedReply::prepare)
                .transpose()
                .map_err(|error| {
                    CliError::file_validation(
                        error,
                        "check --save-full: use a new path in a writable directory",
                    )
                })?,
            save_full,
            match_text,
            context_lines,
        })
    }

    pub(crate) fn with_resolved_session(mut self, resolved: Option<&'a str>) -> Self {
        if self.session.trim().is_empty()
            && let Some(sid) = resolved.filter(|s| !s.trim().is_empty())
        {
            self.session = sid;
        }
        self
    }

    pub(crate) fn finish(self, mut reply: Value, mut exit: u8) -> Result<(), CliError> {
        if business_rpc::cancel_requested() {
            reply["ok"] = false.into();
            reply["cancelled"] = true.into();
            reply["phase"] = "cancelled".into();
            exit = super::error::exit_code_for(bsk_protocol::ErrorCode::Cancelled);
        }
        if let Some(post) = reply.get_mut("post") {
            observation_view::attach(post, self.session, self.baseline.as_ref());
            if self.baseline.is_none() && post.get("observation").is_some() {
                if post["kind"] == "unchanged" {
                    post["observation_origin"]["kind"] = "reused".into();
                } else if post["kind"] == "delta" && post.get("observation_patch").is_some() {
                    post["observation_origin"]["kind"] = "merged".into();
                }
            }
        }
        if let Some(saved) = self.saved {
            match saved.finish(&reply) {
                Ok(()) => {
                    reply["full_output_path"] = json!(self.save_full);
                    if let Some(post) = reply.get_mut("post") {
                        observation_view::omit_saved_merge(post);
                    }
                }
                Err(e) => {
                    reply["storage_error"] = e.to_string().into();
                    reply["ok"] = false.into();
                    exit = exit.max(2);
                }
            }
        }
        if let Some(post) = reply.get_mut("post")
            && !self.match_text.is_empty()
        {
            cooperate::presentation::filter(post, self.match_text, self.context_lines as usize);
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&reply).context("render step result")?
        );
        if exit == 0 {
            Ok(())
        } else {
            Err(CliError::RenderedExit { exit_code: exit })
        }
    }
}

pub fn dispatch(
    args: StepArgs,
    ctx: &business_rpc::ClientContext,
    _format: Format,
) -> Result<(), CliError> {
    let (method, params) = prepare(&args).map_err(CliError::invalid_params)?;
    let session = args.session.as_deref().unwrap_or_default();
    let output = Output::prepare(
        session,
        args.baseline.as_deref(),
        args.save_full.as_deref(),
        &args.match_text,
        args.context_lines,
    )?;
    let op_ctx = ctx.with_scope(args.scope.as_deref());
    let aux_ctx = op_ctx.without_action_metadata();
    let mut first_rpc = true;
    let daemon = ensure_daemon().context("ensure daemon is running")?;
    let hydrate_cache = args.baseline.is_none();
    let mut resolved_session: Option<String> = None;
    let (reply, exit) = run_with_meta(
        &args,
        method,
        params,
        hydrate_cache,
        |method, params, timeout, want_meta| {
            let rpc_ctx = if std::mem::take(&mut first_rpc) {
                &op_ctx
            } else {
                &aux_ctx
            };
            let meta = crate::ipc_client::IpcRequestMeta {
                return_scope_meta: want_meta,
                ..Default::default()
            };
            let (val, resp_meta) = rpc_ctx.call_envelope(
                daemon.sock_path.clone(),
                "step",
                method,
                Some(params),
                meta,
                timeout,
            )?;
            if let Some(ref sm) = resp_meta.scope_meta
                && !sm.session_id.is_empty()
            {
                resolved_session = Some(sm.session_id.clone());
            }
            Ok((val, resp_meta.scope_meta))
        },
    );
    output
        .with_resolved_session(resolved_session.as_deref())
        .finish(reply, exit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::{ErrorCode, RpcError};
    use clap::Parser;
    fn args() -> StepArgs {
        let cli = super::super::Cli::parse_from([
            "bsk",
            "step",
            "--session",
            "s",
            "--action",
            "click",
            "--params",
            r#"{"ref":"e1"}"#,
            "--until-visible",
            "#ready",
        ]);
        let super::super::Command::Step(args) = cli.command else {
            panic!()
        };
        args
    }
    fn err(code: ErrorCode, effect: &str) -> CliError {
        CliError::from_rpc(RpcError {
            code,
            message: "interrupted".into(),
            data: Some(json!({"reason":"cooperation_sync_required","effect_state":effect})),
        })
    }
    #[test]
    fn one_action_wait_and_sync_are_serial_and_pin_the_actual_tab() {
        let a = args();
        let (m, p) = prepare(&a).unwrap();
        let mut calls = Vec::new();
        let (r, exit) = run(&a, m, p, |m, p, _| {
            calls.push((m, p.clone()));
            match calls.len() {
                1 => Ok(json!({"tab_id":42,"used_ref":"e1"})),
                2 => {
                    assert_eq!(p["tab_id"], 42);
                    assert_eq!(p["selector"], "#ready");
                    Ok(json!({"satisfied":true}))
                }
                3 => {
                    assert_eq!(p["tab_id"], 42);
                    assert_eq!(p["action"], "sync");
                    Ok(json!({"context_id":"new","control_policy":"target"}))
                }
                _ => panic!("unexpected call"),
            }
        });
        assert_eq!(exit, 0);
        assert_eq!(r["ok"], true);
        assert_eq!(r["post"]["context_id"], "new");
        assert_eq!(r["rpc_calls"], 3);
        assert_eq!(
            calls
                .iter()
                .filter(|(m, _)| *m == Method::ToolClick)
                .count(),
            1
        );
    }
    #[test]
    fn failed_or_uncertain_action_is_never_followed_or_replayed() {
        for code in [
            ErrorCode::PermissionDenied,
            ErrorCode::Cancelled,
            ErrorCode::UserAborted,
            ErrorCode::Timeout,
        ] {
            let a = args();
            let (m, p) = prepare(&a).unwrap();
            let mut n = 0;
            let (r, exit) = run(&a, m, p, |_, _, _| {
                n += 1;
                Err(err(code, "unknown"))
            });
            assert_eq!(n, 1);
            assert_ne!(exit, 0);
            assert!(r.get("post").is_none());
            assert_eq!(r["action"]["error"]["data"]["effect_state"], "unknown");
        }
    }
    #[test]
    fn readiness_timeout_still_returns_fresh_state_but_not_success() {
        let a = args();
        let (m, p) = prepare(&a).unwrap();
        let mut n = 0;
        let (r, exit) = run(&a, m, p, |_, _, _| {
            n += 1;
            Ok(match n {
                1 => json!({"tab_id":42}),
                2 => json!({"satisfied":false,"visible":false}),
                _ => {
                    json!({"context_id":"new","control_policy":"target","observation":{"text":"login required"}})
                }
            })
        });
        assert_eq!(n, 3);
        assert_ne!(exit, 0);
        assert_eq!(r["ok"], false);
        assert_eq!(r["post"]["observation"]["text"], "login required");
    }
    #[test]
    fn navigation_timeout_keeps_its_exit_status_after_successful_reads() {
        for reached in ["timeout", "load"] {
            let mut a = args();
            a.action = Action::Navigate;
            a.params = r#"{"url":"https://example.com/"}"#.into();
            let (m, p) = prepare(&a).unwrap();
            let mut calls = Vec::new();
            let (r, exit) = run(&a, m, p, |m, _, _| {
                calls.push(m.clone());
                Ok(match m {
                    Method::ToolNavigate => json!({"tab_id":42,"reached":reached}),
                    Method::ToolWaitForElement => json!({"satisfied":true}),
                    Method::ToolCooperate => json!({"context_id":"new","control_policy":"target"}),
                    _ => panic!("unexpected call"),
                })
            });
            assert_eq!(exit, if reached == "timeout" { 4 } else { 0 });
            assert_eq!(r["ok"], reached != "timeout");
            assert_eq!(r["action"]["result"]["reached"], reached);
            assert_eq!(r["post"]["context_id"], "new");
            assert_eq!(
                calls.iter().filter(|m| **m == Method::ToolNavigate).count(),
                1
            );
        }
    }
    #[test]
    fn cancellation_during_readiness_prevents_followup_sync() {
        for code in [ErrorCode::Cancelled, ErrorCode::UserAborted] {
            let a = args();
            let (m, p) = prepare(&a).unwrap();
            let mut n = 0;
            let (r, exit) = run(&a, m, p, |_, _, _| {
                n += 1;
                if n == 1 {
                    Ok(json!({"tab_id":42}))
                } else {
                    Err(err(code, "none"))
                }
            });
            assert_eq!(n, 2);
            assert_ne!(exit, 0);
            assert!(r.get("post").is_none());
            assert!(r["action"]["result"].is_object());
        }
    }
    #[test]
    fn transient_post_sync_retries_only_reads_and_preserves_action() {
        let a = args();
        let (m, p) = prepare(&a).unwrap();
        let mut seen = Vec::new();
        let (r, exit) = run(&a, m, p, |m, p, _| {
            seen.push((m, p.clone()));
            match seen.len() {
                1 => Ok(json!({"tab_id":42})),
                2 => Ok(json!({"satisfied":true})),
                3 => Err(err(ErrorCode::PermissionDenied, "none")),
                4 => {
                    assert_eq!(p["action"], "wait");
                    Ok(json!({"ready":true}))
                }
                _ => Ok(json!({"context_id":"new","control_policy":"target"})),
            }
        });
        assert_eq!(exit, 0);
        assert_eq!(r["post"]["settle"]["sync_attempts"], 2);
        assert_eq!(
            seen.iter().filter(|(m, _)| *m == Method::ToolClick).count(),
            1
        );
    }
    #[test]
    fn post_sync_failure_and_human_hold_do_not_hide_delivered_action() {
        for held in [false, true] {
            let mut a = args();
            a.until_visible = None;
            let (m, p) = prepare(&a).unwrap();
            let mut n = 0;
            let (r, exit) = run(&a, m, p, |_, p, _| {
                n += 1;
                if n == 1 {
                    Ok(json!({"tab_id":42,"delivered":true}))
                } else if held && p["action"] == "wait" {
                    Ok(json!({"ready":false,"state":{"mode":"human"}}))
                } else {
                    Err(err(
                        if held {
                            ErrorCode::PermissionDenied
                        } else {
                            ErrorCode::NotFound
                        },
                        "none",
                    ))
                }
            });
            assert_ne!(exit, 0);
            assert_eq!(r["action"]["result"]["delivered"], true);
            assert!(r["post"].get("context_id").is_none());
            assert!(n <= 3);
        }
    }
    #[test]
    fn invalid_input_is_rejected_before_dispatch() {
        for params in [
            "[]",
            r##"{"ref":"e1","selector":"#a"}"##,
            r#"{"ref":""}"#,
            r#"{"ref":"e1","typo":1}"#,
            r#"{"session_id":"other","ref":"e1"}"#,
            r#"{"ref":"e1","context_id":"old"}"#,
            r#"{"ref":"e1","timeout_ms":30001}"#,
        ] {
            let mut a = args();
            a.params = params.into();
            assert!(prepare(&a).is_err(), "{params}");
        }
        let mut a = args();
        a.action = Action::Fill;
        assert!(prepare(&a).is_err());
        a.action = Action::Drag;
        a.params = r#"{"source":{"ref":"e1","unexpected":1},"target":{"ref":"e2"}}"#.into();
        assert!(prepare(&a).is_err());
    }
    #[test]
    fn existing_output_is_rejected_before_daemon_or_action() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("out.json");
        std::fs::write(&p, "keep").unwrap();
        let mut a = args();
        a.save_full = Some(p.clone());
        assert!(dispatch(a, &business_rpc::ClientContext::default(), Format::Json).is_err());
        assert_eq!(std::fs::read_to_string(p).unwrap(), "keep");
    }
    #[test]
    fn all_supported_actions_use_existing_protocol_shapes() {
        for (action, params) in [
            (Action::Click, r#"{"ref":"e1"}"#),
            (Action::Press, r#"{"key":"Enter","ref":"e1"}"#),
            (Action::Fill, r#"{"ref":"e1","value":"sample"}"#),
            (Action::Hover, r#"{"ref":"e1"}"#),
            (Action::Select, r#"{"ref":"e1","values":["a"]}"#),
            (
                Action::Drag,
                r#"{"source":{"ref":"e1"},"target":{"ref":"e2"},"mode":"click-move-click"}"#,
            ),
            (Action::ScrollTo, r#"{"ref":"e1"}"#),
            (Action::Wheel, r#"{"delta_y":100,"delta_x":0}"#),
            (Action::Navigate, r#"{"url":"https://example.org/"}"#),
        ] {
            let mut a = args();
            a.action = action;
            a.params = params.into();
            assert!(prepare(&a).is_ok(), "{action:?}");
        }
    }
    #[test]
    fn first_step_negotiates_target_default_without_overriding_an_existing_policy() {
        for policy in ["target", "strict"] {
            let mut args = args();
            args.until_visible = None;
            let mut calls = 0;
            let (reply, exit) = run(&args, Method::ToolClick, json!({}), |method, params, _| {
                calls += 1;
                if method == Method::ToolCooperate {
                    assert_eq!(params["control_policy"], "auto");
                    Ok(json!({"context_id":"c", "control_policy":policy}))
                } else {
                    Ok(json!({"tab_id":7}))
                }
            });
            assert_eq!(exit, 0);
            assert_eq!(calls, 2);
            assert_eq!(reply["post"]["control_policy"], policy);
        }
    }

    #[test]
    fn step_retains_action_receipt_when_legacy_sync_cannot_acknowledge_policy() {
        let mut args = args();
        args.until_visible = None;
        let (reply, exit) = run(&args, Method::ToolClick, json!({}), |method, _, _| {
            if method == Method::ToolCooperate {
                Ok(json!({"context_id":"legacy"}))
            } else {
                Ok(json!({"tab_id":7, "delivered":true}))
            }
        });
        assert_ne!(exit, 0);
        assert_eq!(reply["action"]["result"]["delivered"], true);
        assert_eq!(reply["post_error"]["code"], "unsupported");
        assert_eq!(reply["action_replayed"], false);
        assert!(reply.get("post").is_none());
    }
    #[test]
    fn explicit_step_policy_is_applied_only_to_post_sync() {
        let mut args = args();
        args.until_visible = None;
        args.policy = cooperate::Policy::Strict;
        let (reply, exit) = run(
            &args,
            Method::ToolClick,
            json!({"ref":"e1"}),
            |method, params, _| {
                if method == Method::ToolCooperate {
                    assert_eq!(params["control_policy"], "strict");
                    Ok(json!({"context_id":"legacy"}))
                } else {
                    assert!(params.get("control_policy").is_none());
                    Ok(json!({"tab_id":7}))
                }
            },
        );
        assert_eq!(exit, 0);
        assert_eq!(reply["post"]["context_id"], "legacy");
        assert_eq!(reply["action_replayed"], false);
    }

    #[test]
    fn implicit_session_resolved_by_action_is_pinned_for_readiness_and_post_sync() {
        let mut args = args();
        args.session = None;
        args.until_visible = Some("#done".into());
        let mut seen = Vec::new();
        let (reply, exit) = run_with_meta(
            &args,
            Method::ToolClick,
            json!({"session_id": "", "ref": "@e1"}),
            true,
            |method, params, _, want_meta| {
                seen.push((
                    method.clone(),
                    params["session_id"].as_str().unwrap_or("").to_owned(),
                    want_meta,
                ));
                match method {
                    Method::ToolClick => Ok((
                        json!({"tab_id": 7}),
                        Some(crate::ipc_client::ScopeResultMeta {
                            session_id: "sess-a".into(),
                            ..Default::default()
                        }),
                    )),
                    Method::ToolWaitForElement => Ok((json!({"satisfied": true}), None)),
                    Method::ToolCooperate => Ok((
                        json!({
                            "tab_id": 7,
                            "context_id": "ctx-a",
                            "control_policy": "target",
                            "kind": "baseline",
                            "observation": {"text": "@vom 1\nL1 page"}
                        }),
                        None,
                    )),
                    other => panic!("unexpected method {other:?}"),
                }
            },
        );
        assert_eq!(exit, 0, "{reply}");
        assert_eq!(
            seen,
            vec![
                (Method::ToolClick, "".into(), true),
                (Method::ToolWaitForElement, "sess-a".into(), false),
                (Method::ToolCooperate, "sess-a".into(), true),
            ]
        );
    }
}
