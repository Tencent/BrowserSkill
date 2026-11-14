//! What each session did, so a finished run can become a recipe draft.
//!
//! Each CLI command is its own process, so only the daemon sees a whole run. This
//! keeps metadata only: an action, the role, name and context its ref had when it was
//! used, and when that ref first appeared. Input values are never kept. Everything
//! stays in memory, is bounded per session, and goes when the session ends.
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use bsk_protocol::{ErrorCode, Method, ResponseBody, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli::recipe::vom::{self, Target};

const MAX_STEPS: usize = 200;
const MAX_REFS: usize = 8000;
const MAX_TEXT: usize = 256;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LoggedStep {
    /// An explicit navigation. A query string may hold data, so only its presence is kept.
    Navigate {
        origin: Option<String>,
        path: Option<String>,
        dropped_query: bool,
    },
    Action {
        action: String,
        target: Target,
        element: String,
        /// The observation this ref first appeared in.
        first_seen: u32,
        /// How many option values a select chose, never which.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        values: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modifiers: Option<Value>,
        /// The first heading of the page it acted on.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        heading: Option<String>,
        #[serde(default)]
        sensitive: bool,
    },
    /// The caller waited for a condition here, so the page changed in between.
    Wait,
    /// An action a recipe cannot hold.
    Skipped { method: String, reason: String },
    /// An action whose effect is not known.
    Uncertain { method: String },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RunLog {
    pub steps: Vec<LoggedStep>,
    pub observations: u32,
    /// Steps were dropped after the bound.
    pub truncated: bool,
    pub borrowed_tabs: Vec<i64>,
}

#[derive(Debug, Clone)]
struct KnownRef {
    role: String,
    name: Option<String>,
    ctx: Option<String>,
    first_seen: u32,
}

#[derive(Debug, Default)]
struct SessionLog {
    log: RunLog,
    known: HashMap<String, KnownRef>,
    current: HashSet<String>,
    masked: HashSet<String>,
    heading: Option<String>,
    context: Option<String>,
    pending_ops: HashMap<String, usize>,
    resolved_ops: VecDeque<String>,
}

#[derive(Debug, Default)]
pub struct RunLogs(Mutex<HashMap<String, SessionLog>>);

fn bounded(text: Option<String>) -> Option<String> {
    text.filter(|text| text.chars().count() <= MAX_TEXT)
}

fn method_name(method: &Method) -> String {
    serde_json::to_value(method)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

impl SessionLog {
    fn observe(&mut self, text: &str, context: Option<&str>, partial: bool) {
        // A new context means a new document: same-numbered refs are new elements.
        if context.is_some() && context != self.context.as_deref() {
            if self.context.is_some() {
                self.known.clear();
                self.current.clear();
            }
            self.context = context.map(str::to_owned);
        }
        let page = vom::parse(text);
        self.log.observations += 1;
        let seen = self.log.observations;
        if !partial {
            self.current.clear();
            self.heading = page
                .lines
                .iter()
                .find(|line| line.role.eq_ignore_ascii_case("heading"))
                .and_then(|line| bounded(line.name.clone()));
        }
        for line in page.lines {
            let Some(element) = line.element else {
                continue;
            };
            if line.value.as_deref() == Some(vom::SENSITIVE_MASK) {
                self.masked.insert(element.clone());
            }
            let name = bounded(line.name);
            let ctx = bounded(line.ctx);
            let first_seen = match self.known.get(&element) {
                Some(known) if known.role == line.role && known.name == name => known.first_seen,
                _ => seen,
            };
            self.current.insert(element.clone());
            self.known.insert(
                element,
                KnownRef {
                    role: line.role,
                    name,
                    ctx,
                    first_seen,
                },
            );
        }
        if self.known.len() > MAX_REFS {
            let current = &self.current;
            self.known.retain(|element, _| current.contains(element));
        }
    }

    fn push(&mut self, step: LoggedStep) {
        if self.log.steps.len() >= MAX_STEPS {
            self.log.truncated = true;
        } else {
            self.log.steps.push(step);
        }
    }

    fn skip(&mut self, method: &Method, reason: &str) {
        self.push(LoggedStep::Skipped {
            method: method_name(method),
            reason: reason.to_owned(),
        });
    }

    /// The fewest fields that identify the element in the page it was used on.
    fn minimal_target(&self, known: &KnownRef) -> Option<Target> {
        let name = known.name.clone()?;
        let matching: Vec<&KnownRef> = self
            .current
            .iter()
            .filter_map(|element| self.known.get(element))
            .filter(|other| other.role == known.role && other.name.as_ref() == Some(&name))
            .collect();
        if matching.len() <= 1 {
            return Some(Target {
                role: known.role.clone(),
                name,
                ctx: None,
            });
        }
        let ctx = known.ctx.clone()?;
        let same_context = matching
            .iter()
            .filter(|other| other.ctx.as_ref() == Some(&ctx))
            .count();
        (same_context == 1).then(|| Target {
            role: known.role.clone(),
            name,
            ctx: Some(ctx),
        })
    }

    fn action(&mut self, method: &Method, action: &str, params: &Value) {
        let Some(element) = params["ref"].as_str() else {
            let reason = if params.get("selector").is_some() {
                "css_selector"
            } else {
                "untargeted"
            };
            return self.skip(method, reason);
        };
        let element = element.trim_start_matches('@').to_owned();
        let Some(known) = self.known.get(&element).cloned() else {
            return self.skip(method, "unknown_ref");
        };
        if known.name.is_none() {
            return self.skip(method, "unnamed");
        }
        let Some(target) = self.minimal_target(&known) else {
            return self.skip(method, "ambiguous");
        };
        let key = params["key"].as_str().map(str::to_owned);
        let modifiers = params.get("modifiers").cloned();
        // A single character is typed text, which is an input value.
        if key
            .as_deref()
            .is_some_and(|key| key.chars().count() == 1 && modifiers.is_none())
        {
            return self.skip(method, "character_key");
        }
        let step = LoggedStep::Action {
            action: action.to_owned(),
            target,
            element,
            first_seen: known.first_seen,
            values: params["values"].as_array().map(Vec::len),
            key,
            modifiers,
            heading: self.heading.clone(),
            sensitive: false,
        };
        self.push(step);
    }

    fn navigated(&mut self, params: &Value) {
        let url = params["url"]
            .as_str()
            .and_then(|url| reqwest::Url::parse(url).ok());
        self.push(LoggedStep::Navigate {
            origin: url
                .as_ref()
                .map(|url| url.origin().ascii_serialization())
                .filter(|origin| origin.starts_with("http")),
            path: url.as_ref().map(|url| url.path().to_owned()),
            dropped_query: url.as_ref().is_some_and(|url| url.query().is_some()),
        });
        self.current.clear();
        self.known.clear();
    }

    fn finished_ok(&mut self, method: &Method, params: &Value, result: &Value) {
        use bsk_protocol::RecipeStepKind;
        match method.spec().recipe_step {
            RecipeStepKind::Ignore => {}
            RecipeStepKind::Cooperate => {
                if let Some(text) = result.pointer("/observation/text").and_then(Value::as_str) {
                    self.observe(text, result["context_id"].as_str(), false);
                }
            }
            RecipeStepKind::Observe => {
                if let Some(text) = result["text"].as_str() {
                    self.observe(text, None, params.get("cursor").is_some());
                }
            }
            RecipeStepKind::Extract { action } => self.action(method, action, params),
            RecipeStepKind::Navigate => self.navigated(params),
            RecipeStepKind::WaitElement => {
                if result["satisfied"] == true {
                    self.push(LoggedStep::Wait);
                }
            }
            RecipeStepKind::TabBorrow => {
                if let Some(tab) = params["tab_id"].as_i64() {
                    self.log.borrowed_tabs.push(tab);
                }
            }
            RecipeStepKind::TabReturn => {
                let tab = params["tab_id"].as_i64();
                self.log.borrowed_tabs.retain(|other| Some(*other) != tab);
            }
            RecipeStepKind::Skip { reason } => self.skip(method, reason),
        }
    }

    /// A refused action did nothing. One with a possible effect makes the run unsafe to copy.
    fn finished_err(&mut self, method: &Method, error: &RpcError) {
        if !method.is_mutating() && !matches!(method, Method::ToolHover) {
            return;
        }
        let reason = error.data.as_ref().and_then(|data| data["reason"].as_str());
        let effect = error
            .data
            .as_ref()
            .and_then(|data| data["effect_state"].as_str());
        let possible = match effect {
            Some(effect) => effect != "none",
            // Without a stated effect, only a timeout or a suspended action may have run.
            None => {
                reason == Some(bsk_protocol::RpcErrorReason::DialogPending.as_str())
                    || (error.code == ErrorCode::Timeout
                        && reason != Some(bsk_protocol::RpcErrorReason::SessionBusy.as_str()))
            }
        };
        if possible {
            self.push(LoggedStep::Uncertain {
                method: method_name(method),
            });
        }
    }

    fn record_dialog_pending(&mut self, operation_id: &str, method: &Method) {
        if self.resolved_ops.iter().any(|done| done == operation_id)
            || self.pending_ops.contains_key(operation_id)
        {
            return;
        }
        if !method.is_mutating() && !matches!(method, Method::ToolHover) {
            return;
        }
        if self.log.steps.len() >= MAX_STEPS {
            self.log.truncated = true;
            return;
        }
        let idx = self.log.steps.len();
        self.log.steps.push(LoggedStep::Uncertain {
            method: method_name(method),
        });
        self.pending_ops.insert(operation_id.to_owned(), idx);
    }

    fn resolve_operation(
        &mut self,
        operation_id: &str,
        method: &Method,
        params: &Value,
        body: &ResponseBody,
    ) {
        if self.resolved_ops.iter().any(|done| done == operation_id) {
            return;
        }
        if self.resolved_ops.len() >= 64 {
            self.resolved_ops.pop_front();
        }
        self.resolved_ops.push_back(operation_id.to_owned());

        let Some(pending_idx) = self.pending_ops.remove(operation_id) else {
            match body {
                ResponseBody::Ok(result) => self.finished_ok(method, params, result),
                ResponseBody::Err(error) => self.finished_err(method, error),
            }
            return;
        };

        let saved_steps = std::mem::take(&mut self.log.steps);
        let saved_truncated = self.log.truncated;
        self.log.truncated = false;
        match body {
            ResponseBody::Ok(result) => self.finished_ok(method, params, result),
            ResponseBody::Err(error) => self.finished_err(method, error),
        }
        let produced = std::mem::replace(&mut self.log.steps, saved_steps);
        self.log.truncated = saved_truncated;

        if pending_idx < self.log.steps.len() {
            let mut iter = produced.into_iter();
            if let Some(first) = iter.next() {
                self.log.steps[pending_idx] = first;
                for extra in iter {
                    self.push(extra);
                }
            } else {
                self.log.steps.remove(pending_idx);
                for idx in self.pending_ops.values_mut() {
                    if *idx > pending_idx {
                        *idx -= 1;
                    }
                }
            }
        } else {
            for step in produced {
                self.push(step);
            }
        }
    }
}

impl RunLogs {
    pub fn remove_session(&self, session: &str) {
        self.0.lock().expect("run log poisoned").remove(session);
    }

    /// Record a dialog-suspended action as temporarily `Uncertain` keyed by
    /// `operation_id` so final resolution via [`Self::resolve_operation`]
    /// replaces it in place with the true outcome.
    pub fn record_dialog_pending(
        &self,
        live: impl Fn(&str) -> bool,
        operation_id: &str,
        method: &Method,
        params: &Value,
    ) {
        let Some(session) = params["session_id"].as_str() else {
            return;
        };
        let mut logs = self.0.lock().expect("run log poisoned");
        logs.retain(|id, _| live(id));
        if !live(session) {
            return;
        }
        logs.entry(session.to_owned())
            .or_default()
            .record_dialog_pending(operation_id, method);
    }

    /// Reconcile a completed dialog-gated operation, replacing any prior
    /// `DialogPending` `Uncertain` placeholder in place.
    pub fn resolve_operation(
        &self,
        live: impl Fn(&str) -> bool,
        operation_id: &str,
        method: &Method,
        params: &Value,
        body: &ResponseBody,
    ) {
        let Some(session) = params["session_id"].as_str() else {
            return;
        };
        let mut logs = self.0.lock().expect("run log poisoned");
        logs.retain(|id, _| live(id));
        if !live(session) {
            return;
        }
        logs.entry(session.to_owned())
            .or_default()
            .resolve_operation(operation_id, method, params, body);
    }
    /// Called for every finished RPC. `live` says whether a session still exists.
    pub fn record(
        &self,
        live: impl Fn(&str) -> bool,
        method: &Method,
        params: &Value,
        body: &ResponseBody,
    ) {
        let Some(session) = params["session_id"].as_str() else {
            return;
        };
        let mut logs = self.0.lock().expect("run log poisoned");
        logs.retain(|id, _| live(id));
        if !live(session) {
            return;
        }
        let log = logs.entry(session.to_owned()).or_default();
        match body {
            ResponseBody::Ok(result) => log.finished_ok(method, params, result),
            ResponseBody::Err(error) => log.finished_err(method, error),
        }
    }

    pub fn read(&self, session: &str) -> RunLog {
        let logs = self.0.lock().expect("run log poisoned");
        let Some(entry) = logs.get(session) else {
            return RunLog::default();
        };
        let mut log = entry.log.clone();
        for step in &mut log.steps {
            if let LoggedStep::Action {
                element, sensitive, ..
            } = step
            {
                *sensitive = entry.masked.contains(element);
            }
        }
        log
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PAGE: &str = "@vom 1\nL1 page\n  heading \"Sales\"\n  @e1 combobox \"Region\"\n  @e2 textbox \"Note\" =\"hello\"\n  @e3 button \"Search\"\n  @e4 button \"Open\" [ctx: A]\n  @e5 button \"Open\" [ctx: B]\n  @e6 button \"Same\" [ctx: C]\n  @e7 button \"Same\" [ctx: C]\n  @e8 button";

    fn ok(result: Value) -> ResponseBody {
        ResponseBody::Ok(result)
    }

    fn record(logs: &RunLogs, method: Method, params: Value, result: Value) {
        logs.record(|_| true, &method, &params, &ok(result));
    }

    fn sync(logs: &RunLogs, text: &str, context: &str) {
        record(
            logs,
            Method::ToolCooperate,
            json!({"session_id":"s"}),
            json!({"context_id":context,"observation":{"text":text}}),
        );
    }

    fn click(logs: &RunLogs, element: &str) {
        record(
            logs,
            Method::ToolClick,
            json!({"session_id":"s","ref":element}),
            json!({}),
        );
    }

    #[test]
    fn actions_keep_the_smallest_description_that_is_unique() {
        let logs = RunLogs::default();
        sync(&logs, PAGE, "c");
        click(&logs, "@e3");
        click(&logs, "e5");
        let steps = logs.read("s").steps;
        let LoggedStep::Action {
            target, heading, ..
        } = &steps[0]
        else {
            panic!("{steps:?}");
        };
        assert_eq!(target.name, "Search");
        // The context is unnecessary here, and fewer fields survive more change.
        assert_eq!(target.ctx, None);
        assert_eq!(heading.as_deref(), Some("Sales"));
        let LoggedStep::Action { target, .. } = &steps[1] else {
            panic!("{steps:?}");
        };
        assert_eq!(target.ctx.as_deref(), Some("B"));
    }

    #[test]
    fn what_cannot_be_named_uniquely_is_skipped_with_the_reason() {
        let logs = RunLogs::default();
        sync(&logs, PAGE, "c");
        click(&logs, "@e6");
        click(&logs, "@e8");
        click(&logs, "@e99");
        record(
            &logs,
            Method::ToolClick,
            json!({"session_id":"s","selector":"#go"}),
            json!({}),
        );
        record(
            &logs,
            Method::ToolPress,
            json!({"session_id":"s","key":"Tab"}),
            json!({}),
        );
        record(
            &logs,
            Method::ToolPress,
            json!({"session_id":"s","ref":"@e2","key":"x"}),
            json!({}),
        );
        for method in [Method::ToolEvaluate, Method::ToolWheel, Method::ToolUpload] {
            record(&logs, method, json!({"session_id":"s"}), json!({}));
        }
        let reasons: Vec<String> = logs
            .read("s")
            .steps
            .iter()
            .map(|step| match step {
                LoggedStep::Skipped { reason, .. } => reason.clone(),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(
            reasons,
            [
                "ambiguous",
                "unnamed",
                "unknown_ref",
                "css_selector",
                "untargeted",
                "character_key",
                "script",
                "wheel",
                "file_transfer"
            ]
        );
    }

    #[test]
    fn input_values_are_never_kept() {
        let logs = RunLogs::default();
        sync(&logs, PAGE, "c");
        record(
            &logs,
            Method::ToolFill,
            json!({"session_id":"s","ref":"@e2","value":"secret-input"}),
            json!({}),
        );
        record(
            &logs,
            Method::ToolSelect,
            json!({"session_id":"s","ref":"@e1","values":["secret-option"]}),
            json!({}),
        );
        record(
            &logs,
            Method::ToolNavigate,
            json!({"session_id":"s","url":"https://a.test/x?token=secret-query#secret"}),
            json!({}),
        );
        let log = logs.read("s");
        let rendered = serde_json::to_string(&log).unwrap();
        assert!(!rendered.contains("secret"), "{rendered}");
        assert!(!rendered.contains("hello"), "{rendered}");
        let LoggedStep::Action { values, .. } = &log.steps[1] else {
            panic!();
        };
        assert_eq!(*values, Some(1));
        assert_eq!(
            log.steps[2],
            LoggedStep::Navigate {
                origin: Some("https://a.test".into()),
                path: Some("/x".into()),
                dropped_query: true
            }
        );
    }

    #[test]
    fn a_ref_is_dated_by_when_it_appeared_and_a_new_document_restarts_that() {
        let logs = RunLogs::default();
        sync(&logs, "@vom 1\n  @e1 button \"A\"", "c");
        sync(&logs, "@vom 1\n  @e1 button \"A\"\n  @e2 button \"B\"", "c");
        click(&logs, "@e1");
        click(&logs, "@e2");
        sync(&logs, "@vom 1\n  @e1 button \"A\"", "next-document");
        click(&logs, "@e1");
        let seen: Vec<u32> = logs
            .read("s")
            .steps
            .iter()
            .map(|step| match step {
                LoggedStep::Action { first_seen, .. } => *first_seen,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(seen, [1, 2, 3]);
    }

    #[test]
    fn a_field_later_shown_masked_marks_the_steps_that_used_it() {
        let logs = RunLogs::default();
        sync(&logs, "@vom 1\n  @e1 textbox \"Code\" [empty]", "c");
        record(
            &logs,
            Method::ToolFill,
            json!({"session_id":"s","ref":"@e1","value":"1"}),
            json!({}),
        );
        sync(
            &logs,
            "@vom 1\n  @e1 textbox \"Code\" [filled] =\"•••\"",
            "c",
        );
        assert!(matches!(
            logs.read("s").steps[0],
            LoggedStep::Action {
                sensitive: true,
                ..
            }
        ));
    }

    #[test]
    fn refused_actions_leave_no_step_and_unknown_effects_leave_a_warning() {
        let logs = RunLogs::default();
        sync(&logs, PAGE, "c");
        let params = json!({"session_id":"s","ref":"@e3"});
        let refused = |effect: &str| {
            ResponseBody::Err(RpcError {
                code: ErrorCode::PermissionDenied,
                message: "refused".into(),
                data: Some(json!({"effect_state":effect})),
            })
        };
        logs.record(|_| true, &Method::ToolClick, &params, &refused("none"));
        assert!(logs.read("s").steps.is_empty());
        logs.record(|_| true, &Method::ToolClick, &params, &refused("unknown"));
        assert!(matches!(
            logs.read("s").steps[0],
            LoggedStep::Uncertain { .. }
        ));
        let failure = |code, data: Value| {
            ResponseBody::Err(RpcError {
                code,
                message: "failed".into(),
                data: Some(data),
            })
        };
        let before = logs.read("s").steps.len();
        let busy = failure(
            ErrorCode::Timeout,
            json!({"reason": bsk_protocol::RpcErrorReason::SessionBusy.as_str()}),
        );
        logs.record(|_| true, &Method::ToolClick, &params, &busy);
        assert_eq!(logs.read("s").steps.len(), before, "never reached the page");
        for suspended in [
            failure(
                ErrorCode::Unsupported,
                json!({"reason": bsk_protocol::RpcErrorReason::DialogPending.as_str()}),
            ),
            failure(ErrorCode::Timeout, json!({})),
        ] {
            logs.record(|_| true, &Method::ToolClick, &params, &suspended);
        }
        assert_eq!(logs.read("s").steps.len(), before + 2);
    }

    #[test]
    fn logs_are_bounded_and_end_with_their_session() {
        let logs = RunLogs::default();
        sync(&logs, PAGE, "c");
        for _ in 0..MAX_STEPS + 5 {
            click(&logs, "@e3");
        }
        let log = logs.read("s");
        assert_eq!(log.steps.len(), MAX_STEPS);
        assert!(log.truncated);
        let params = json!({"session_id":"other"});
        logs.record(
            |id| id == "other",
            &Method::ToolTabList,
            &params,
            &ok(json!({})),
        );
        assert_eq!(logs.read("s"), RunLog::default());
    }

    #[test]
    fn borrowed_tabs_are_tracked_until_returned() {
        let logs = RunLogs::default();
        record(
            &logs,
            Method::ToolTabBorrow,
            json!({"session_id":"s","tab_id":9}),
            json!({}),
        );
        assert_eq!(logs.read("s").borrowed_tabs, [9]);
        record(
            &logs,
            Method::ToolTabReturn,
            json!({"session_id":"s","tab_id":9}),
            json!({}),
        );
        assert!(logs.read("s").borrowed_tabs.is_empty());
    }

    #[test]
    fn dialog_pending_resolution_is_idempotent() {
        let logs = RunLogs::default();
        sync(&logs, PAGE, "c");
        let params = json!({"session_id":"s","ref":"@e3"});
        logs.record_dialog_pending(|_| true, "op-dup-1", &Method::ToolClick, &params);
        assert_eq!(logs.read("s").steps.len(), 1);
        assert!(matches!(
            logs.read("s").steps[0],
            LoggedStep::Uncertain { .. }
        ));

        let done = ok(json!({"tab_id":1}));
        logs.resolve_operation(|_| true, "op-dup-1", &Method::ToolClick, &params, &done);
        logs.resolve_operation(|_| true, "op-dup-1", &Method::ToolClick, &params, &done);
        let view = logs.read("s");
        assert_eq!(
            view.steps.len(),
            1,
            "duplicate resolve_operation must not append a second step: {view:?}"
        );
        assert!(matches!(view.steps[0], LoggedStep::Action { .. }));
    }
}
