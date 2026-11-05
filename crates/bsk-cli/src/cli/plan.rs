//! Several already-decided actions in one call, then one read-only sync.
//!
//! A plan removes only the model's round trips between actions. Each step is the
//! request its single command would send, so the extension still checks control,
//! the target and `expect` immediately before every input. It is not a transaction:
//! the first step that does not complete ends the plan, and nothing is retried.
use super::{
    GlobalFlags, TOOL_IPC_TIMEOUT, business_rpc, cooperate, ensure_daemon,
    error::{CliError, Format},
    step,
};
use anyhow::{Context, ensure};
use bsk_protocol::{
    ErrorCode, Method,
    tools::{TARGET_CONTROL_PROTOCOL, WaitForElementParams, parse_expectations},
};
use clap::{Args, ValueEnum};
use serde_json::{Map, Value, json};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

const MAX_STEPS: usize = 20;
const DEFAULT_WAIT_MS: u64 = 5000;
/// Checked between steps. A step in flight finishes under its own timeout, because
/// cutting it short would turn a clean result into an unknown effect.
const BUDGET: Duration = Duration::from_secs(120);
/// Receipt fields that only repeat the request or what the final sync shows.
const RECEIPT_NOISE: [&str; 15] = [
    "tab_id",
    "used_ref",
    "used_selector",
    "x",
    "y",
    "key",
    "code",
    "modifiers",
    "multiple",
    "selected_values",
    "selected_labels",
    "value_length",
    "satisfied",
    "attached",
    "elapsed_ms",
];

#[derive(Debug, Clone, Args)]
pub struct PlanArgs {
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub tab_id: Option<i64>,
    /// JSON array of 1-20 steps. Each is an object with `action` (click, fill, select,
    /// press, hover, scroll-to, wheel, drag or wait-for-element), that action's protocol
    /// fields (ref/selector/value/values/key/etc.) and optional `expect`.
    #[arg(long)]
    pub steps: String,
    /// Known main-document CSS selector that should become visible after the last step.
    #[arg(long)]
    pub until_visible: Option<String>,
    /// Readiness budget in milliseconds, independent of the steps' timeouts.
    #[arg(long, default_value_t = 5000, value_parser = clap::value_parser!(u32).range(1..=25000))]
    pub wait_timeout_ms: u32,
    /// Save the unfiltered combined result, atomically, without overwriting.
    #[arg(long)]
    pub save_full: Option<PathBuf>,
    /// Exact saved predecessor for an unchanged post-plan sync.
    #[arg(long)]
    pub baseline: Option<PathBuf>,
    /// Fold only plain numbered fallback buttons outside literal-match windows (repeatable).
    #[arg(long)]
    pub match_text: Vec<String>,
    /// Keep numbered fallback buttons within this many lines before/after each match.
    #[arg(long, default_value_t = 12, value_parser = clap::value_parser!(u32).range(0..=200))]
    pub context_lines: u32,
}

#[derive(Debug)]
pub(crate) struct Step {
    action: String,
    method: Method,
    params: Value,
    /// Untargeted input, which also needs the sync's observation.
    strict: bool,
    /// Read-only, so it carries no evidence.
    wait: bool,
    timeout: Duration,
}

#[derive(Debug)]
pub(crate) struct Plan {
    pub(crate) session: String,
    pub(crate) tab_id: Option<i64>,
    pub(crate) context: Option<String>,
    pub(crate) observation: Option<String>,
    pub(crate) steps: Vec<Step>,
    pub(crate) until_visible: Option<String>,
    pub(crate) wait_timeout_ms: u32,
    pub(crate) budget: Duration,
}

impl Plan {
    /// Validate everything before anything reaches the daemon.
    pub(crate) fn prepare(
        session: String,
        steps: &Value,
        context: Option<String>,
        observation: Option<String>,
    ) -> anyhow::Result<Self> {
        let list = steps.as_array().context("steps must be a JSON array")?;
        ensure!(
            (1..=MAX_STEPS).contains(&list.len()),
            "a plan needs 1 to {MAX_STEPS} steps"
        );
        let steps = list
            .iter()
            .enumerate()
            .map(|(index, step)| {
                prepare_step(&session, step).with_context(|| format!("step {index}"))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        // A strict observation authorizes one action against the page as observed,
        // and any earlier step of the plan could already have changed that page.
        if let Some(index) = steps.iter().skip(1).position(|step| step.strict) {
            anyhow::bail!(
                "step {}: only the first step may be untargeted; give it a ref or selector",
                index + 1
            );
        }
        ensure!(
            !steps[0].strict || observation.is_some(),
            "step 0: an untargeted {} also needs the sync's observation_id",
            steps[0].action
        );
        Ok(Self {
            session,
            tab_id: None,
            context,
            observation,
            steps,
            until_visible: None,
            wait_timeout_ms: DEFAULT_WAIT_MS as u32,
            budget: BUDGET,
        })
    }

    fn request(&self, step: &Step, tab: Option<i64>) -> Value {
        let mut params = step.params.clone();
        if let Some(tab) = tab {
            params["tab_id"] = tab.into();
        }
        if !step.wait
            && let Some(context) = &self.context
        {
            params["context_id"] = context.as_str().into();
        }
        if step.strict
            && let Some(observation) = &self.observation
        {
            params["observation_id"] = observation.as_str().into();
        }
        params
    }
}

fn prepare_step(session: &str, step: &Value) -> anyhow::Result<Step> {
    let mut fields = step
        .as_object()
        .context("a step must be a JSON object")?
        .clone();
    let action = fields
        .remove("action")
        .and_then(|action| action.as_str().map(str::to_owned))
        .context("a step needs an action")?;
    let name = action.replace('_', "-");
    if name == "wait-for-element" {
        return wait_step(session, action, fields);
    }
    let expect = fields.remove("expect");
    let kind = step::Action::from_str(&name, true)
        .ok()
        .filter(|kind| !matches!(kind, step::Action::Navigate))
        .with_context(|| {
            format!(
                "unsupported action {action}; use click, fill, select, press, hover, scroll-to, \
                 wheel, drag or wait-for-element, and navigate or evaluate on their own"
            )
        })?;
    let (method, mut params) = step::action_params(session, None, kind, Value::Object(fields))?;
    let strict = is_strict(kind, &params);
    if let Some(expect) = expect {
        let conditions = parse_expectations(&expect.to_string()).map_err(anyhow::Error::msg)?;
        params["expect"] = serde_json::to_value(conditions)?;
    }
    Ok(Step {
        action,
        method,
        params,
        strict,
        wait: false,
        timeout: TOOL_IPC_TIMEOUT,
    })
}

fn wait_step(
    session: &str,
    action: String,
    mut fields: Map<String, Value>,
) -> anyhow::Result<Step> {
    step::reject_reserved(&fields)?;
    let timeout_ms = fields
        .get("timeout_ms")
        .map_or(Some(DEFAULT_WAIT_MS), Value::as_u64)
        .filter(|ms| (1..=25_000).contains(ms))
        .context("wait timeout_ms must be 1..=25000")?;
    fields.insert("timeout_ms".into(), timeout_ms.into());
    fields.insert("session_id".into(), session.into());
    fields
        .entry("state")
        .or_insert_with(|| Value::from("visible"));
    let params = step::typed::<WaitForElementParams>(&Value::Object(fields))?;
    step::target(&params, true)?;
    Ok(Step {
        action,
        method: Method::ToolWaitForElement,
        params,
        strict: false,
        wait: true,
        timeout: Duration::from_millis(timeout_ms + 5000),
    })
}

/// Mirrors what the extension's target policy treats as a DOM-targeted action.
fn is_strict(kind: step::Action, params: &Value) -> bool {
    let targeted = |value: &Value| value.get("ref").is_some() || value.get("selector").is_some();
    let visual = ["capture_id", "image_x", "image_y"]
        .iter()
        .any(|key| params.get(*key).is_some());
    visual
        || match kind {
            step::Action::Press | step::Action::Wheel => !targeted(params),
            step::Action::Drag => params.get("target").is_none(),
            _ => false,
        }
}

fn effect_state(error: &CliError) -> Value {
    let data = error.data();
    match data {
        Some(data) if data["effect_state"].is_string() => data["effect_state"].clone(),
        Some(data) if data["reason"] == "cancelled_before_dispatch" => "none".into(),
        // Without evidence that nothing was sent, the caller must not assume so.
        _ => "unknown".into(),
    }
}

/// Reading after a failed step lets the caller replan in the same reply. Not after
/// a stop request, while a dialog blocks the page, or when the page or link is gone.
fn can_read_after(error: &CliError) -> bool {
    !step::interrupted(error)
        && error.code().is_some_and(|code| code != ErrorCode::Timeout)
        && error.data().is_none_or(|data| {
            !["dialog_pending", "input_outcome_unknown"]
                .contains(&data["reason"].as_str().unwrap_or_default())
        })
}

/// Keep only what a completed step's receipt adds, such as a handled dialog.
fn receipt_note(index: usize, step: &Step, mut receipt: Value) -> Option<Value> {
    let fields = receipt.as_object_mut()?;
    for key in RECEIPT_NOISE {
        fields.remove(key);
    }
    if step.wait {
        fields.remove("visible");
    }
    (!fields.is_empty()).then(|| json!({"index":index,"action":step.action,"result":receipt}))
}

pub(crate) fn run(
    plan: &Plan,
    mut call: impl FnMut(Method, Value, Duration) -> Result<Value, CliError>,
) -> (Value, u8) {
    let start = Instant::now();
    // Pin every request to the plan's tab; never follow a human's active tab.
    let mut tab = plan.tab_id;
    let mut completed = 0;
    let mut notes = Vec::new();
    let mut stopped = None;
    let mut exit = 0;
    let mut read_after = true;
    for (index, step) in plan.steps.iter().enumerate() {
        if index > 0 && start.elapsed() > plan.budget {
            exit = 1;
            stopped = Some((
                index,
                json!({"index":index,"action":step.action,"effect_state":"none",
                    "reason":"plan_budget_exceeded"}),
            ));
            break;
        }
        match call(step.method.clone(), plan.request(step, tab), step.timeout) {
            Ok(receipt) => {
                tab = tab.or(receipt["tab_id"].as_i64());
                if step.wait && receipt["satisfied"] != true {
                    exit = 1;
                    stopped = Some((
                        index,
                        json!({"index":index,"action":step.action,"effect_state":"none",
                            "reason":"wait_unsatisfied"}),
                    ));
                    break;
                }
                completed += 1;
                notes.extend(receipt_note(index, step, receipt));
            }
            Err(error) => {
                exit = error.exit_code();
                read_after = can_read_after(&error);
                stopped = Some((
                    index,
                    json!({"index":index,"action":step.action,"effect_state":effect_state(&error),
                        "error":step::failure(&error)}),
                ));
                break;
            }
        }
    }
    let mut reply = json!({"ok":false,"completed":completed,"total":plan.steps.len()});
    if !notes.is_empty() {
        reply["notes"] = notes.into();
    }
    let finished = stopped.is_none();
    if let Some((index, stop)) = stopped {
        let not_run = plan.steps.len();
        reply["stopped"] = stop;
        reply["not_run"] = (index + 1..not_run).collect::<Vec<_>>().into();
    }
    if finished
        && let Some(selector) = &plan.until_visible
        && step::await_ready(
            &plan.session,
            tab,
            selector,
            plan.wait_timeout_ms,
            &mut reply,
            &mut exit,
            &mut call,
        )
    {
        read_after = false;
    }
    if read_after {
        step::post_sync(
            &plan.session,
            cooperate::Policy::Auto,
            tab,
            &mut reply,
            &mut exit,
            &mut call,
        );
    }
    reply["ok"] = (exit == 0).into();
    reply["elapsed_ms"] = json!(start.elapsed().as_millis());
    (reply, exit)
}

/// A plan reuses one context across actions, which only target control allows.
pub(crate) fn check_protocol(protocol: &str) -> anyhow::Result<()> {
    ensure!(
        bsk_protocol::tools::supports_target_control(protocol),
        "plan requires daemon protocol {TARGET_CONTROL_PROTOCOL} or a later compatible 1.x version; update the CLI and restart its daemon"
    );
    Ok(())
}

fn prepare(args: &PlanArgs, flags: &GlobalFlags) -> anyhow::Result<Plan> {
    ensure!(
        flags.expect.is_none() && flags.depends_on.is_empty(),
        "--expect and --depends-on do not apply to a plan; put expect on the steps it protects"
    );
    step::check_follow_args(args.until_visible.as_deref(), &args.match_text)?;
    let steps: Value = serde_json::from_str(&args.steps).context("parse --steps JSON")?;
    let mut plan = Plan::prepare(
        args.session.clone(),
        &steps,
        flags.context.clone(),
        flags.observation.clone(),
    )?;
    plan.tab_id = args.tab_id;
    plan.until_visible = args.until_visible.clone();
    plan.wait_timeout_ms = args.wait_timeout_ms;
    Ok(plan)
}

pub fn dispatch(args: PlanArgs, flags: &GlobalFlags, _format: Format) -> Result<(), CliError> {
    let plan = prepare(&args, flags)?;
    let output = step::Output::prepare(
        &args.session,
        args.baseline.as_deref(),
        args.save_full.as_deref(),
        &args.match_text,
        args.context_lines,
    )?;
    let (daemon, protocol) =
        ensure_daemon::ensure_daemon_with_protocol().context("ensure daemon is running")?;
    check_protocol(&protocol)?;
    let (reply, exit) = run(&plan, |method, params, timeout| {
        business_rpc::call(
            daemon.sock_path.clone(),
            "plan",
            method,
            Some(params),
            timeout,
        )
    });
    output.finish(reply, exit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::RpcError;

    fn prepared(steps: Value) -> Plan {
        Plan::prepare("s".into(), &steps, Some("c".into()), Some("o".into())).unwrap()
    }
    fn form() -> Plan {
        prepared(json!([
            {"action":"fill","ref":"@e1","value":"Ada"},
            {"action":"select","ref":"@e2","values":["CN"]},
            {"action":"click","ref":"@e3"},
        ]))
    }
    fn refused(code: ErrorCode, effect: &str) -> CliError {
        CliError::from_rpc(RpcError {
            code,
            message: "refused".into(),
            data: Some(json!({"reason":"target_unavailable","effect_state":effect})),
        })
    }
    fn sync() -> Value {
        json!({"tab_id":42,"context_id":"next","control_policy":"target","observation":{"text":"done"}})
    }

    #[test]
    fn steps_run_in_order_with_one_context_on_one_tab_then_sync() {
        let plan = form();
        let mut calls = Vec::new();
        let (reply, exit) = run(&plan, |method, params, _| {
            calls.push((method.clone(), params));
            Ok(match method {
                Method::ToolCooperate => sync(),
                _ => json!({"tab_id":42,"used_ref":"e1","x":1,"y":2}),
            })
        });
        assert_eq!(exit, 0);
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["completed"], 3);
        assert_eq!(reply["post"]["context_id"], "next");
        assert!(reply.get("stopped").is_none() && reply.get("notes").is_none());
        let methods: Vec<_> = calls.iter().map(|(method, _)| method.clone()).collect();
        assert_eq!(
            methods,
            [
                Method::ToolFill,
                Method::ToolSelect,
                Method::ToolClick,
                Method::ToolCooperate
            ]
        );
        for (_, params) in &calls[..3] {
            assert_eq!(params["context_id"], "c");
            assert!(params.get("observation_id").is_none());
        }
        // The first reply pins the tab for every later request.
        assert!(calls[0].1.get("tab_id").is_none());
        for (_, params) in &calls[1..] {
            assert_eq!(params["tab_id"], 42);
        }
    }

    #[test]
    fn the_first_failure_stops_the_plan_and_nothing_is_retried() {
        for effect in ["none", "committed", "unknown"] {
            let plan = form();
            let mut calls = Vec::new();
            let (reply, exit) = run(&plan, |method, _, _| {
                calls.push(method.clone());
                match method {
                    Method::ToolSelect => Err(refused(ErrorCode::PermissionDenied, effect)),
                    Method::ToolCooperate => Ok(sync()),
                    _ => Ok(json!({"tab_id":42})),
                }
            });
            assert_ne!(exit, 0);
            assert_eq!(reply["ok"], false);
            assert_eq!(reply["completed"], 1);
            assert_eq!(reply["stopped"]["index"], 1);
            assert_eq!(reply["stopped"]["action"], "select");
            assert_eq!(reply["stopped"]["effect_state"], effect);
            assert_eq!(reply["not_run"], json!([2]));
            assert_eq!(
                calls,
                [Method::ToolFill, Method::ToolSelect, Method::ToolCooperate],
                "effect {effect}"
            );
            // The caller can replan from the same reply.
            assert_eq!(reply["post"]["context_id"], "next");
        }
    }

    #[test]
    fn no_read_follows_a_stop_a_dialog_a_timeout_or_a_lost_link() {
        type Failure = fn() -> CliError;
        let cases: [(Failure, &str); 5] = [
            (|| refused(ErrorCode::Cancelled, "none"), "none"),
            (|| refused(ErrorCode::UserAborted, "unknown"), "unknown"),
            (|| refused(ErrorCode::Timeout, "unknown"), "unknown"),
            (
                || {
                    CliError::from_rpc(RpcError {
                        code: ErrorCode::Unsupported,
                        message: "blocked".into(),
                        data: Some(json!({"reason":"dialog_pending","operation_id":"op"})),
                    })
                },
                "unknown",
            ),
            (
                || CliError::Local(anyhow::anyhow!("connection reset")),
                "unknown",
            ),
        ];
        for (error, effect) in cases {
            let plan = form();
            let mut calls = 0;
            let (reply, exit) = run(&plan, |_, _, _| {
                calls += 1;
                Err(error())
            });
            assert_eq!(calls, 1);
            assert_ne!(exit, 0);
            assert!(reply.get("post").is_none());
            assert_eq!(reply["stopped"]["effect_state"], effect);
            assert_eq!(reply["not_run"], json!([1, 2]));
        }
    }

    #[test]
    fn an_unsatisfied_wait_stops_the_plan_without_claiming_an_effect() {
        let plan = prepared(json!([
            {"action":"select","ref":"@e1","values":["ZJ"]},
            {"action":"wait_for_element","selector":"#city option","state":"attached","timeout_ms":100},
            {"action":"select","ref":"@e2","values":["HZ"]},
        ]));
        let mut calls = Vec::new();
        let (reply, exit) = run(&plan, |method, params, _| {
            calls.push((method.clone(), params));
            Ok(match method {
                Method::ToolCooperate => sync(),
                Method::ToolWaitForElement => json!({"tab_id":42,"satisfied":false}),
                _ => json!({"tab_id":42}),
            })
        });
        assert_eq!(exit, 1);
        assert_eq!(reply["completed"], 1);
        assert_eq!(reply["stopped"]["reason"], "wait_unsatisfied");
        assert_eq!(reply["stopped"]["effect_state"], "none");
        assert_eq!(reply["post"]["context_id"], "next");
        assert_eq!(calls.len(), 3);
        // A wait is a read: it carries no authority.
        assert!(calls[1].1.get("context_id").is_none());
        assert_eq!(calls[1].1["timeout_ms"], 100);
    }

    #[test]
    fn evidence_goes_only_on_the_step_it_protects() {
        let plan = prepared(json!([
            {"action":"wheel","delta_y":100},
            {"action":"fill","ref":"@e1","value":"x",
             "expect":[{"target":"@e9","field":"text","equals":"Price 12"}]},
            {"action":"click","selector":"#go"},
        ]));
        let mut requests = Vec::new();
        run(&plan, |method, params, _| {
            requests.push(params);
            Ok(match method {
                Method::ToolCooperate => sync(),
                _ => json!({"tab_id":42}),
            })
        });
        assert_eq!(requests[0]["observation_id"], "o");
        assert!(requests[1].get("observation_id").is_none());
        assert_eq!(requests[1]["expect"][0]["equals"], "Price 12");
        assert!(requests[2].get("expect").is_none());
        assert!(requests[3].get("context_id").is_none());
        assert_eq!(requests[3]["action"], "sync");
    }

    #[test]
    fn readiness_runs_only_after_every_step_completed() {
        let mut plan = form();
        plan.until_visible = Some("#done".into());
        let mut calls = Vec::new();
        let (reply, exit) = run(&plan, |method, params, _| {
            calls.push(method.clone());
            Ok(match method {
                Method::ToolCooperate => sync(),
                Method::ToolWaitForElement => {
                    assert_eq!(params["selector"], "#done");
                    json!({"tab_id":42,"satisfied":false})
                }
                _ => json!({"tab_id":42}),
            })
        });
        assert_eq!(exit, 1);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["completed"], 3);
        assert_eq!(reply["readiness"]["satisfied"], false);
        assert_eq!(reply["post"]["context_id"], "next");

        let mut calls = Vec::new();
        run(&plan, |method, _, _| {
            calls.push(method.clone());
            match method {
                Method::ToolFill => Err(refused(ErrorCode::PermissionDenied, "none")),
                _ => Ok(sync()),
            }
        });
        assert_eq!(calls, [Method::ToolFill, Method::ToolCooperate]);
    }

    #[test]
    fn interruption_during_readiness_prevents_the_sync() {
        let mut plan = prepared(json!([{"action":"click","ref":"@e1"}]));
        plan.until_visible = Some("#done".into());
        let mut calls = Vec::new();
        let (reply, exit) = run(&plan, |method, _, _| {
            calls.push(method.clone());
            match method {
                Method::ToolClick => Ok(json!({"tab_id":42})),
                _ => Err(refused(ErrorCode::Cancelled, "none")),
            }
        });
        assert_ne!(exit, 0);
        assert_eq!(calls, [Method::ToolClick, Method::ToolWaitForElement]);
        assert!(reply.get("post").is_none());
        assert_eq!(reply["completed"], 1);
    }

    #[test]
    fn a_spent_budget_stops_between_steps() {
        let mut plan = form();
        plan.budget = Duration::ZERO;
        let mut calls = Vec::new();
        let (reply, exit) = run(&plan, |method, _, _| {
            calls.push(method.clone());
            std::thread::sleep(Duration::from_millis(2));
            Ok(match method {
                Method::ToolCooperate => sync(),
                _ => json!({"tab_id":42}),
            })
        });
        assert_eq!(exit, 1);
        assert_eq!(calls, [Method::ToolFill, Method::ToolCooperate]);
        assert_eq!(reply["stopped"]["reason"], "plan_budget_exceeded");
        assert_eq!(reply["stopped"]["effect_state"], "none");
        assert_eq!(reply["not_run"], json!([2]));
    }

    #[test]
    fn receipts_keep_only_what_the_final_state_cannot_say() {
        let plan = form();
        let (reply, _) = run(&plan, |method, _, _| {
            Ok(match method {
                Method::ToolFill => json!({"tab_id":42,"used_ref":"e1","value_length":3}),
                Method::ToolSelect => {
                    json!({"tab_id":42,"multiple":false,"selected_values":["CN"],"selected_labels":["China"]})
                }
                Method::ToolClick => json!({"tab_id":42,"x":1,"y":2,
                    "dialogs":[{"type":"alert","message":"saved"}]}),
                _ => sync(),
            })
        });
        assert_eq!(
            reply["notes"],
            json!([{"index":2,"action":"click",
                "result":{"dialogs":[{"type":"alert","message":"saved"}]}}])
        );
    }

    #[test]
    fn every_supported_action_uses_its_protocol_shape() {
        for (step, method) in [
            (json!({"action":"click","ref":"@e1"}), Method::ToolClick),
            (
                json!({"action":"fill","ref":"e1","value":"x"}),
                Method::ToolFill,
            ),
            (
                json!({"action":"select","selector":"#a","values":["a"]}),
                Method::ToolSelect,
            ),
            (
                json!({"action":"press","key":"Enter","ref":"@e1"}),
                Method::ToolPress,
            ),
            (json!({"action":"hover","ref":"@e1"}), Method::ToolHover),
            (
                json!({"action":"scroll-to","ref":"@e1"}),
                Method::ToolScrollTo,
            ),
            (
                json!({"action":"scroll_to","ref":"@e1"}),
                Method::ToolScrollTo,
            ),
            (
                json!({"action":"wheel","ref":"@e1","delta_y":1,"delta_x":0}),
                Method::ToolWheel,
            ),
            (
                json!({"action":"drag","source":{"ref":"@e1"},"target":{"ref":"@e2"}}),
                Method::ToolDrag,
            ),
            (
                json!({"action":"wait-for-element","selector":"#a"}),
                Method::ToolWaitForElement,
            ),
        ] {
            let plan = prepared(json!([step]));
            assert_eq!(plan.steps[0].method, method);
            assert!(!plan.steps[0].strict);
            assert_eq!(plan.steps[0].params["session_id"], "s");
        }
    }

    #[test]
    fn an_invalid_plan_is_rejected_before_anything_is_sent() {
        let too_many: Vec<Value> = (0..21)
            .map(|_| json!({"action":"click","ref":"@e1"}))
            .collect();
        for steps in [
            json!({"action":"click","ref":"@e1"}),
            json!([]),
            Value::Array(too_many),
            json!(["click"]),
            json!([{"ref":"@e1"}]),
            json!([{"action":"teleport","ref":"@e1"}]),
            json!([{"action":"navigate","url":"https://example.org/"}]),
            json!([{"action":"evaluate","expression":"1"}]),
            json!([{"action":"click"}]),
            json!([{"action":"click","ref":"@e1","selector":"#a"}]),
            json!([{"action":"click","ref":"@e1","typo":1}]),
            json!([{"action":"fill","ref":"@e1"}]),
            json!([{"action":"click","ref":"@e1","timeout_ms":30001}]),
            json!([{"action":"click","ref":"@e1","context_id":"old"}]),
            json!([{"action":"click","ref":"@e1","session_id":"other"}]),
            json!([{"action":"click","ref":"@e1","observation_id":"old"}]),
            json!([{"action":"click","ref":"@e1","expect":{}}]),
            json!([{"action":"click","ref":"@e1","expect":[{"target":"@e1","field":"nope"}]}]),
            json!([{"action":"wait_for_element"}]),
            json!([{"action":"wait_for_element","selector":"#a","expect":[]}]),
            json!([{"action":"wait_for_element","selector":"#a","timeout_ms":25001}]),
            json!([{"action":"wait_for_element","selector":"#a","state":"gone"}]),
            // A strict observation authorizes one action on the page as observed.
            json!([{"action":"click","ref":"@e1"},{"action":"press","key":"Tab"}]),
            json!([{"action":"wheel","delta_y":1},{"action":"wheel","delta_y":1}]),
            json!([{"action":"click","ref":"@e1"},{"action":"drag","source":{"ref":"@e1"},"delta":{"x":1,"y":0}}]),
        ] {
            assert!(
                Plan::prepare("s".into(), &steps, Some("c".into()), Some("o".into())).is_err(),
                "{steps}"
            );
        }
        let untargeted = json!([{"action":"press","key":"Tab"}]);
        let error = Plan::prepare("s".into(), &untargeted, Some("c".into()), None).unwrap_err();
        assert!(error.to_string().contains("observation_id"));
    }
}
