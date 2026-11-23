//! What each session did, so a finished run can become a recipe draft.
//!
//! Each CLI command is its own process, so only the daemon sees a whole run. This
//! keeps metadata only: an action, the role, name and context its ref had when it was
//! used, and when that ref first appeared. Input values are never kept. Everything
//! stays in memory, is bounded per session, and goes when the session ends.
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

pub use bsk_protocol::system::{LoggedStep, RunLog};
use bsk_protocol::{ErrorCode, Method, ResponseBody, RpcError};
use serde_json::Value;

use crate::cli::recipe::vom::{self, Target};

const MAX_STEPS: usize = 200;
const MAX_REFS: usize = 8000;
const MAX_TEXT: usize = 256;

#[derive(Debug, Clone)]
struct KnownRef {
    role: String,
    name: Option<String>,
    ctx: Option<String>,
    first_seen: u32,
}

#[derive(Debug, Default)]
struct TabLogState {
    known: HashMap<String, KnownRef>,
    current: HashSet<String>,
    masked: HashSet<String>,
    heading: Option<String>,
    context: Option<String>,
}

#[derive(Debug, Default)]
struct SessionLog {
    log: RunLog,
    active_tab: Option<i64>,
    tabs: HashMap<Option<i64>, TabLogState>,
    step_tabs: Vec<Option<i64>>,
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
    fn resolve_observe_tab(&mut self, params: &Value, result: &Value) -> Option<i64> {
        let tid = result["tab_id"]
            .as_i64()
            .or_else(|| params["tab_id"].as_i64())
            .or(self.active_tab);
        if tid.is_some() {
            self.active_tab = tid;
        }
        tid
    }

    fn resolve_action_tab(&self, params: &Value, result: &Value) -> Option<i64> {
        if let Some(tid) = params["tab_id"].as_i64() {
            if self.tabs.contains_key(&Some(tid)) || !self.tabs.contains_key(&None) {
                return Some(tid);
            }
            return None;
        }
        if let Some(ctx) = params["context_id"].as_str().filter(|s| !s.is_empty())
            && let Some((&tid, _)) = self
                .tabs
                .iter()
                .find(|(_, state)| state.context.as_deref() == Some(ctx))
        {
            return tid;
        }
        if let Some(tid) = result["tab_id"].as_i64()
            && self.tabs.contains_key(&Some(tid))
        {
            return Some(tid);
        }
        self.active_tab
    }

    fn observe(
        &mut self,
        tab_key: Option<i64>,
        text: &str,
        context: Option<&str>,
        partial: bool,
        incremental: bool,
    ) {
        let page = vom::parse(text);
        self.log.observations += 1;
        let seen = self.log.observations;
        let tab = self.tabs.entry(tab_key).or_default();
        // A new context on a full capture means a new document: same-numbered refs
        // are new elements. Incremental text deltas on the same document keep
        // prior `first_seen` stamps even when strict policy rotates `context_id`.
        if context.is_some() && context != tab.context.as_deref() {
            if tab.context.is_some() && !incremental {
                tab.known.clear();
                tab.current.clear();
            }
            tab.context = context.map(str::to_owned);
        }
        if !partial {
            tab.current.clear();
            tab.heading = page
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
                tab.masked.insert(element.clone());
            }
            let name = bounded(line.name);
            let ctx = bounded(line.ctx);
            let first_seen = match tab.known.get(&element) {
                Some(known) if known.role == line.role && known.name == name => known.first_seen,
                _ => seen,
            };
            tab.current.insert(element.clone());
            tab.known.insert(
                element,
                KnownRef {
                    role: line.role,
                    name,
                    ctx,
                    first_seen,
                },
            );
        }
        if tab.known.len() > MAX_REFS {
            let current = &tab.current;
            tab.known.retain(|element, _| current.contains(element));
        }
        let total_known: usize = self.tabs.values().map(|t| t.known.len()).sum();
        if total_known > MAX_REFS {
            for (&k, other) in &mut self.tabs {
                if k != tab_key {
                    other.known.clear();
                    other.current.clear();
                }
            }
        }
    }

    fn push(&mut self, step: LoggedStep, tab_key: Option<i64>) {
        if self.log.steps.len() >= MAX_STEPS {
            self.log.truncated = true;
        } else {
            self.log.steps.push(step);
            self.step_tabs.push(tab_key);
        }
    }

    fn skip(&mut self, method: &Method, reason: &str) {
        self.push(
            LoggedStep::Skipped {
                method: method_name(method),
                reason: reason.to_owned(),
            },
            None,
        );
    }

    /// The fewest fields that identify the element in the page it was used on.
    fn minimal_target(tab: &TabLogState, known: &KnownRef) -> Option<Target> {
        let name = known.name.clone()?;
        let matching: Vec<&KnownRef> = tab
            .current
            .iter()
            .filter_map(|element| tab.known.get(element))
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

    fn action(&mut self, method: &Method, action: &str, params: &Value, result: &Value) {
        let Some(element) = params["ref"].as_str() else {
            let reason = if params.get("selector").is_some() {
                "css_selector"
            } else {
                "untargeted"
            };
            return self.skip(method, reason);
        };
        let element = element.trim_start_matches('@').to_owned();
        let tab_key = self.resolve_action_tab(params, result);
        let (known, target, heading) = {
            let Some(tab) = self.tabs.get(&tab_key) else {
                return self.skip(method, "unknown_ref");
            };
            let Some(known) = tab.known.get(&element).cloned() else {
                return self.skip(method, "unknown_ref");
            };
            if known.name.is_none() {
                return self.skip(method, "unnamed");
            };
            let Some(target) = Self::minimal_target(tab, &known) else {
                return self.skip(method, "ambiguous");
            };
            (known, target, tab.heading.clone())
        };
        let key = params["key"].as_str().map(str::to_owned);
        let modifiers = (action == "press")
            .then(|| {
                params
                    .get("modifiers")
                    .and_then(|v| {
                        serde_json::from_value::<Vec<bsk_protocol::tools::KeyModifier>>(v.clone())
                            .ok()
                    })
                    .filter(|mods| !mods.is_empty())
            })
            .flatten();
        let has_shortcut_modifier = modifiers.as_deref().is_some_and(|mods| {
            mods.iter().any(|m| {
                matches!(
                    m,
                    bsk_protocol::tools::KeyModifier::Alt
                        | bsk_protocol::tools::KeyModifier::Ctrl
                        | bsk_protocol::tools::KeyModifier::Meta
                )
            })
        });
        // A single character without Ctrl/Alt/Meta is typed text, which is an input value.
        if key
            .as_deref()
            .is_some_and(|key| key.chars().count() == 1 && !has_shortcut_modifier)
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
            heading,
            sensitive: false,
        };
        self.push(step, tab_key);
    }

    fn navigated(&mut self, params: &Value, result: &Value) {
        let url = params["url"]
            .as_str()
            .and_then(|url| reqwest::Url::parse(url).ok());
        let tab_key = self.resolve_observe_tab(params, result);
        self.push(
            LoggedStep::Navigate {
                origin: url
                    .as_ref()
                    .map(|url| url.origin().ascii_serialization())
                    .filter(|origin| origin.starts_with("http")),
                path: url.as_ref().map(|url| url.path().to_owned()),
                dropped_query: url.as_ref().is_some_and(|url| url.query().is_some()),
            },
            tab_key,
        );
        if let Some(tab) = self.tabs.get_mut(&tab_key) {
            tab.current.clear();
            tab.known.clear();
        }
    }

    fn finished_ok(&mut self, method: &Method, params: &Value, result: &Value) {
        use bsk_protocol::RecipeStepKind;
        match method {
            Method::ToolTabCreate => {
                if let Some(tid) = result["tab_id"].as_i64()
                    && (params["active"].as_bool().unwrap_or(true) || self.active_tab.is_none())
                {
                    self.active_tab = Some(tid);
                }
            }
            Method::ToolTabSelect => {
                if let Some(tid) = result["tab_id"]
                    .as_i64()
                    .or_else(|| params["tab_id"].as_i64())
                {
                    self.active_tab = Some(tid);
                }
            }
            Method::ToolTabClose => {
                if let Some(tid) = result["tab_id"]
                    .as_i64()
                    .or_else(|| params["tab_id"].as_i64())
                {
                    if let Some(tab) = self.tabs.get_mut(&Some(tid)) {
                        tab.known.clear();
                        tab.current.clear();
                    }
                    if self.active_tab == Some(tid) {
                        self.active_tab = None;
                    }
                }
            }
            _ => {}
        }
        if *method == Method::ToolDebug
            && matches!(
                result.pointer("/replay/state").and_then(Value::as_str),
                Some("failed" | "interrupted")
            )
        {
            self.push(
                LoggedStep::Uncertain {
                    method: method_name(method),
                },
                None,
            );
            return;
        }
        match method.spec().recipe_step {
            RecipeStepKind::Ignore => {}
            RecipeStepKind::Cooperate => {
                let tab_key = self.resolve_observe_tab(params, result);
                if let Some(text) = result.pointer("/observation/text").and_then(Value::as_str) {
                    let incremental =
                        matches!(result["kind"].as_str(), Some("delta" | "unchanged"));
                    self.observe(
                        tab_key,
                        text,
                        result["context_id"].as_str(),
                        false,
                        incremental,
                    );
                } else if result["kind"].as_str() == Some("unchanged")
                    && let Some(ctx) = result["context_id"].as_str()
                {
                    self.tabs.entry(tab_key).or_default().context = Some(ctx.to_owned());
                }
            }
            RecipeStepKind::Observe => {
                if let Some(text) = result["text"].as_str() {
                    let tab_key = self.resolve_observe_tab(params, result);
                    self.observe(tab_key, text, None, params.get("cursor").is_some(), false);
                }
            }
            RecipeStepKind::Extract { action } => self.action(method, action, params, result),
            RecipeStepKind::Navigate => self.navigated(params, result),
            RecipeStepKind::WaitElement => {
                if result["satisfied"] == true {
                    self.push(LoggedStep::Wait, None);
                }
            }
            RecipeStepKind::TabBorrow => {
                if let Some(tab) = result["tab_id"]
                    .as_i64()
                    .or_else(|| params["tab_id"].as_i64())
                {
                    self.active_tab = Some(tab);
                    self.log.borrowed_tabs.push(tab);
                }
            }
            RecipeStepKind::TabReturn => {
                let tab = result["tab_id"]
                    .as_i64()
                    .or_else(|| params["tab_id"].as_i64());
                self.log.borrowed_tabs.retain(|other| Some(*other) != tab);
                if let Some(tid) = tab {
                    if let Some(state) = self.tabs.get_mut(&Some(tid)) {
                        state.known.clear();
                        state.current.clear();
                    }
                    if self.active_tab == Some(tid) {
                        self.active_tab = None;
                    }
                }
            }
            RecipeStepKind::Skip { reason } => self.skip(method, reason),
        }
    }

    /// A refused action did nothing. One with a possible effect makes the run unsafe to copy.
    fn finished_err(&mut self, method: &Method, params: &Value, error: &RpcError) {
        if !method.is_mutating_with_params(params) && !matches!(method, Method::ToolHover) {
            return;
        }
        if error
            .data
            .as_ref()
            .and_then(|data| data["dispatched"].as_bool())
            == Some(false)
        {
            return;
        }
        let reason = error.data.as_ref().and_then(|data| data["reason"].as_str());
        let effect = error
            .data
            .as_ref()
            .and_then(|data| data["effect_state"].as_str());
        let possible = match effect {
            Some(effect) => effect != "none",
            None => {
                reason == Some(bsk_protocol::RpcErrorReason::DialogPending.as_str())
                    || matches!(
                        reason,
                        Some(
                            "input_outcome_unknown"
                                | "transfer_outcome_unknown"
                                | "transfer_timeout"
                                | "cancel_cleanup_timeout"
                                | "borrow_outcome_unknown"
                        )
                    )
                    || (matches!(
                        error.code,
                        ErrorCode::Timeout
                            | ErrorCode::Cancelled
                            | ErrorCode::UserAborted
                            | ErrorCode::NoBrowserConnected
                            | ErrorCode::ProtocolError
                    ) && !matches!(
                        reason,
                        Some(r)
                            if r == bsk_protocol::RpcErrorReason::SessionBusy.as_str()
                                || r == bsk_protocol::RpcErrorReason::CancelledBeforeDispatch.as_str()
                    ))
            }
        };
        if possible {
            self.push(
                LoggedStep::Uncertain {
                    method: method_name(method),
                },
                None,
            );
        }
    }

    fn record_dialog_pending(&mut self, operation_id: &str, method: &Method, params: &Value) {
        if self.resolved_ops.iter().any(|done| done == operation_id)
            || self.pending_ops.contains_key(operation_id)
        {
            return;
        }
        if !method.is_mutating_with_params(params) && !matches!(method, Method::ToolHover) {
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
        self.step_tabs.push(None);
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
                ResponseBody::Err(error) => self.finished_err(method, params, error),
            }
            return;
        };

        let saved_steps = std::mem::take(&mut self.log.steps);
        let saved_tabs = std::mem::take(&mut self.step_tabs);
        let saved_truncated = self.log.truncated;
        self.log.truncated = false;
        match body {
            ResponseBody::Ok(result) => self.finished_ok(method, params, result),
            ResponseBody::Err(error) => self.finished_err(method, params, error),
        }
        let produced_steps = std::mem::replace(&mut self.log.steps, saved_steps);
        let produced_tabs = std::mem::replace(&mut self.step_tabs, saved_tabs);
        self.log.truncated = saved_truncated;

        if pending_idx < self.log.steps.len() {
            let mut iter = produced_steps.into_iter().zip(produced_tabs);
            if let Some((first_step, first_tab)) = iter.next() {
                self.log.steps[pending_idx] = first_step;
                self.step_tabs[pending_idx] = first_tab;
                for (extra_step, extra_tab) in iter {
                    self.push(extra_step, extra_tab);
                }
            } else {
                self.log.steps.remove(pending_idx);
                self.step_tabs.remove(pending_idx);
                for idx in self.pending_ops.values_mut() {
                    if *idx > pending_idx {
                        *idx -= 1;
                    }
                }
            }
        } else {
            for (step, tab_key) in produced_steps.into_iter().zip(produced_tabs) {
                self.push(step, tab_key);
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
            .record_dialog_pending(operation_id, method, params);
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
            ResponseBody::Err(error) => log.finished_err(method, params, error),
        }
    }

    pub fn read(&self, session: &str) -> RunLog {
        let logs = self.0.lock().expect("run log poisoned");
        let Some(entry) = logs.get(session) else {
            return RunLog::default();
        };
        let mut log = entry.log.clone();
        for (idx, step) in log.steps.iter_mut().enumerate() {
            if let LoggedStep::Action {
                element, sensitive, ..
            } = step
            {
                let tab_key = entry.step_tabs.get(idx).copied().unwrap_or(None);
                *sensitive = entry
                    .tabs
                    .get(&tab_key)
                    .is_some_and(|tab| tab.masked.contains(element));
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

    #[test]
    fn character_key_privacy_filter_rejects_empty_null_or_shift_modifiers_while_keeping_shortcuts()
    {
        let logs = RunLogs::default();
        sync(&logs, PAGE, "c");
        for bypass_attempt in [
            json!({"session_id":"s","ref":"@e2","key":"s","modifiers":[]}),
            json!({"session_id":"s","ref":"@e2","key":"s","modifiers":null}),
            json!({"session_id":"s","ref":"@e2","key":"s","modifiers":["shift"]}),
        ] {
            record(&logs, Method::ToolPress, bypass_attempt, json!({}));
        }
        record(
            &logs,
            Method::ToolPress,
            json!({"session_id":"s","ref":"@e2","key":"a","modifiers":["ctrl"]}),
            json!({}),
        );
        record(
            &logs,
            Method::ToolClick,
            json!({"session_id":"s","ref":"@e3","modifiers":["shift"]}),
            json!({}),
        );
        let steps = logs.read("s").steps;
        assert_eq!(steps.len(), 5, "{steps:?}");
        for step in &steps[0..3] {
            assert_eq!(
                *step,
                LoggedStep::Skipped {
                    method: "tool.press".into(),
                    reason: "character_key".into(),
                }
            );
        }
        assert!(matches!(
            &steps[3],
            LoggedStep::Action {
                action,
                key: Some(key),
                modifiers: Some(mods),
                ..
            } if action == "press"
                && key == "a"
                && mods == &[bsk_protocol::tools::KeyModifier::Ctrl]
        ));
        assert!(matches!(
            &steps[4],
            LoggedStep::Action {
                action,
                modifiers: None,
                ..
            } if action == "click"
        ));
    }

    #[test]
    fn debug_replay_failed_or_interrupted_ok_records_uncertain_step() {
        let logs = RunLogs::default();
        record(
            &logs,
            Method::ToolDebug,
            json!({"session_id": "s", "action": "replay"}),
            json!({"replay": {"state": "complete"}}),
        );
        assert!(
            logs.read("s").steps.is_empty(),
            "complete debug replay should stay ignored for recipe extraction"
        );

        for state in ["interrupted", "failed"] {
            record(
                &logs,
                Method::ToolDebug,
                json!({"session_id": "s", "action": "replay"}),
                json!({"replay": {"state": state}}),
            );
        }
        let steps = logs.read("s").steps;
        assert_eq!(steps.len(), 2, "{steps:?}");
        for step in &steps {
            assert_eq!(
                *step,
                LoggedStep::Uncertain {
                    method: "tool.debug".into(),
                }
            );
        }
    }
}
