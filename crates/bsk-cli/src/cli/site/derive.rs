//! Project a recorded `TraceV3` onto a replayable [`Workflow`] (design §4.1).
//!
//! Three rules shape everything here:
//!
//! 1. **No `@eN` ever reaches disk.** `TargetDescriptorV3::element_ref` is a
//!    record-local `backendNodeId` wrapper that dies with the CDP session, so
//!    only the `role` / `name` / `ctx` triple survives derivation.
//! 2. **Redacted values never reach disk.** A `Fill` marked `redacted` becomes
//!    a `secret` parameter with no value, matching the operation-audit promise.
//! 3. **No recorded input value is stored by default.** Design §6 forbids
//!    keeping what the user typed, so every `fill` value becomes a named
//!    parameter and the value itself is dropped. `--inline-values` opts back in
//!    for a flow whose constants really are part of the workflow, and even then
//!    anything that looks like a secret, an address or an identifier is
//!    parameterised anyway. A `<select>` is the exception: an option's `value`
//!    attribute is a constant the site defines, not something the recorder
//!    typed, so it is inlined and only a secret-looking one becomes a parameter.
//!
//! A recording is a raw artefact and contains noise — an `about:blank` left by
//! backing out past the start page, a first action that happens before any
//! navigation. Noise is dropped or repaired, never fatal: one stray step must
//! not cost the user the whole recording.

use bsk_protocol::tools::{
    FillCommit, NavigationCause, SelectedOptionV3, StepV3, TargetDescriptorV3, TraceV3,
};

use super::model::{
    SecretsPolicy, SourceTrace, StepOp, StepTarget, WORKFLOW_SCHEMA_VERSION, Workflow,
    WorkflowParam, WorkflowStep, WorkflowStrategy,
};

/// Outcome of a derivation, carrying the counts the CLI reports back.
#[derive(Debug, Clone)]
pub struct Derived {
    pub workflow: Workflow,
    /// Steps dropped as viewport / session side effects (`scroll`, `switch_tab`).
    pub dropped_steps: usize,
}

/// How recorded `fill` / `select` values are treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ValuePolicy {
    /// Drop every recorded value and expose it as a parameter (the default).
    #[default]
    Parameterise,
    /// Keep values that are demonstrably not personal data as constants.
    Inline,
}

/// Build a workflow from a v3 trace.
pub fn derive_workflow(
    trace: &TraceV3,
    id: &str,
    host: &str,
    purpose: Option<&str>,
    policy: ValuePolicy,
) -> Derived {
    let mut builder = Builder {
        policy,
        ..Builder::default()
    };
    if !starts_with_navigate(&trace.steps) {
        builder.push_entry_navigate(&trace.entry.start_url);
    }
    for step in &trace.steps {
        builder.push(step);
    }
    let needs_review = builder.steps.iter().any(|step| step.needs_review);
    let workflow = Workflow {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        id: id.to_string(),
        host: host.to_string(),
        purpose: purpose
            .map(str::to_string)
            .or_else(|| trace.purpose.clone()),
        strategy: WorkflowStrategy::UiOnly,
        // Derivation is not verification: a fresh workflow is unverified until
        // someone runs `bsk site workflow verify --pass`.
        last_verified: None,
        source_trace: Some(SourceTrace {
            recorded_at: Some(trace.recorded_at.clone()),
            recorder: Some(format!("bsk {}", trace.recorder.bsk)),
            purpose: trace.purpose.clone(),
        }),
        params: builder.params,
        preconditions: Vec::new(),
        steps: builder.steps,
        // Left empty on purpose: design §4.1 forbids lifting a postcondition
        // out of `states[]` without human confirmation.
        postcondition: None,
        secrets_policy: SecretsPolicy {
            store_values: false,
            redacted_fields: builder.redacted_fields,
        },
        needs_review,
        review_notes: {
            let mut notes = builder.notes;
            if builder.effect_navigations > 0 {
                notes.push(format!(
                    "{} navigation(s) the page made in response to a recorded click or submit \
                     were dropped: replaying the action reaches the same page, and landing URLs \
                     can embed typed values",
                    builder.effect_navigations
                ));
            }
            notes
        },
    };
    Derived {
        workflow,
        dropped_steps: builder.dropped,
    }
}

/// Host a trace belongs to: where the recording *started*.
///
/// The entry URL comes first because that is the page a replay has to open.
/// Reading the first `navigate` step instead filed a search on
/// `www.wikipedia.org` under `zh.wikipedia.org` — the article the search landed
/// on — and then rejected `--host www.wikipedia.org` as a mismatch. A trace
/// whose entry URL is not an http(s) page (a recording armed on `about:blank`)
/// falls back to the first real navigation.
pub fn infer_host(trace: &TraceV3) -> Option<String> {
    if let Some(host) = host_of_url(&trace.entry.start_url) {
        return Some(host);
    }
    for step in &trace.steps {
        if let StepV3::Navigate { to, .. } = step
            && let Some(host) = host_of_url(to)
        {
            return Some(host);
        }
    }
    None
}

/// Whether a recorded navigation target is a page a workflow can replay.
fn is_replayable_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Whether the derived workflow will already open with a navigation.
///
/// Mirrors what [`Builder::push`] keeps: scrolls, tab switches and
/// unreplayable navigations never become steps, so they cannot be the first
/// one either.
fn starts_with_navigate(steps: &[StepV3]) -> bool {
    for step in steps {
        match step {
            StepV3::Scroll { .. } | StepV3::SwitchTab { .. } => {}
            StepV3::Navigate { to, .. } if !is_replayable_url(to) => {}
            StepV3::Navigate { .. } => return true,
            _ => return false,
        }
    }
    false
}

/// Decode `%XX` escapes, keeping malformed sequences and non-UTF-8 bytes
/// as-is (lossily). Enough to see a typed value inside a query string.
fn percent_decode_lossy(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(hex) = input.get(i + 1..i + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extract the host component of an absolute URL without a URL parser.
pub fn host_of_url(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, rest)| rest)?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = match authority.rsplit_once(':') {
        Some((head, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => head,
        _ => authority,
    };
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

#[derive(Default)]
struct Builder {
    policy: ValuePolicy,
    steps: Vec<WorkflowStep>,
    params: Vec<WorkflowParam>,
    redacted_fields: Vec<String>,
    /// Recorded values that were turned into parameters. A later navigation
    /// whose URL embeds one of them (a search results page, say) would put
    /// the value back on disk through the back door, so it is dropped.
    kept_out: Vec<(String, String)>,
    /// Navigations dropped as the effect of a recorded click / submit.
    effect_navigations: usize,
    effect_urls: Vec<String>,
    notes: Vec<String>,
    dropped: usize,
}

impl Builder {
    fn push(&mut self, step: &StepV3) {
        match step {
            StepV3::Navigate { common, to, cause } => self.push_navigate(to, *cause, common.id),
            StepV3::Click { target, .. } => self.push_pointer(StepOp::Click, target),
            StepV3::Hover { target, .. } => self.push_pointer(StepOp::Hover, target),
            StepV3::Fill {
                target,
                value,
                commit,
                redacted,
                ..
            } => self.push_fill(target, value, *commit, *redacted),
            StepV3::Select {
                target, selection, ..
            } => self.push_select(target, selection),
            StepV3::Press {
                key,
                modifiers,
                target,
                ..
            } => self.push_press(key, modifiers.as_deref(), target.as_ref()),
            // Scrolling is a viewport side effect, not a semantic step, and tab
            // switching is owned by the session in the Agent Window model.
            StepV3::Scroll { .. } | StepV3::SwitchTab { .. } => self.dropped += 1,
        }
    }

    fn next_n(&self) -> u32 {
        self.steps.len() as u32 + 1
    }

    fn blank(&self, op: StepOp) -> WorkflowStep {
        WorkflowStep {
            n: self.next_n(),
            op,
            to: None,
            target: None,
            value: None,
            value_from: None,
            commit: None,
            key: None,
            modifiers: None,
            note: None,
            needs_review: false,
        }
    }

    /// A navigation the recorder captured. Targets a workflow cannot replay —
    /// `about:blank` from backing out past the recording's start page,
    /// `chrome://` pages — are dropped like scrolls rather than failing the
    /// whole derivation: they are ordinary by-products of recording, and one of
    /// them used to make `workflow save` exit 1 and discard the entire bundle.
    fn push_navigate(&mut self, to: &str, cause: NavigationCause, recorded_id: u32) {
        // A navigation the page performed in response to the previous recorded
        // action (a clicked link, a submitted form, a script redirect) is an
        // effect, not a step: replaying the click reaches the same page, and
        // the landing URL often embeds what was typed — the results page of a
        // search, say — which is exactly what site memory must not keep.
        // Address-bar entries, history moves and reloads are the agent's own
        // actions and stay.
        let is_effect = matches!(
            cause,
            NavigationCause::Link
                | NavigationCause::FormSubmit
                | NavigationCause::Script
                | NavigationCause::Browser
        );
        if is_effect && !self.steps.is_empty() {
            self.dropped += 1;
            self.effect_navigations += 1;
            self.effect_urls.push(to.to_string());
            return;
        }
        // A history move back to a page the flow only reached through one of
        // those effects carries the same URL, so it is kept out for the same
        // reason; the agent replays it as `navigate-back`.
        if matches!(cause, NavigationCause::History) && self.effect_urls.iter().any(|u| u == to) {
            self.dropped += 1;
            self.notes.push(format!(
                "recorded step {recorded_id} was a history move back to a page reached by an \
                 earlier action; it was dropped (use `bsk navigate-back` when replaying)"
            ));
            return;
        }
        if !is_replayable_url(to) {
            self.dropped += 1;
            self.notes.push(format!(
                "recorded step {recorded_id} navigated to {to:?}, which is not an http(s) page; \
                 the step was dropped"
            ));
            return;
        }
        if let Some(leak) = self.leaks_kept_out_value(to) {
            self.dropped += 1;
            self.notes.push(format!(
                "recorded step {recorded_id} navigated to a URL that embeds the value typed into                  {leak:?}; the step was dropped because that value is kept out of site memory                  (replaying the fill reaches the same page)"
            ));
            return;
        }
        let mut step = self.blank(StepOp::Navigate);
        step.to = Some(to.to_string());
        self.steps.push(step);
    }

    /// Name of the field whose kept-out value appears in `url`, if any.
    fn leaks_kept_out_value(&self, url: &str) -> Option<String> {
        if self.kept_out.is_empty() {
            return None;
        }
        let decoded = percent_decode_lossy(url);
        let plus_as_space = decoded.replace('+', " ");
        self.kept_out
            .iter()
            .find(|(_, value)| {
                decoded.contains(value.as_str()) || plus_as_space.contains(value.as_str())
            })
            .map(|(label, _)| label.clone())
    }

    fn remember_kept_out(&mut self, target: &TargetDescriptorV3, value: &str) {
        let value = value.trim();
        // One or two characters match almost any URL; that is noise, not a leak.
        if value.chars().count() < 3 {
            return;
        }
        let label = target
            .name
            .as_deref()
            .map(strip_state_annotations)
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "this field".to_string());
        self.kept_out.push((label, value.to_string()));
    }

    /// Give the workflow a starting page when the recording's first captured
    /// action was not a navigation.
    ///
    /// Without it a derived workflow opened with `select` or `fill` and never
    /// said which page to be on — the one thing the next agent cannot guess.
    /// The entry URL is kept verbatim: a query string is part of the address
    /// the flow starts from. Called before the steps are pushed, so the step
    /// numbers every review note quotes are the final ones.
    fn push_entry_navigate(&mut self, start_url: &str) {
        if !is_replayable_url(start_url) {
            self.notes.push(
                "the recording does not start on an http(s) page, so the workflow has no opening \
                 navigate step; add one before relying on it"
                    .to_string(),
            );
            return;
        }
        let mut step = self.blank(StepOp::Navigate);
        step.to = Some(start_url.to_string());
        step.note = Some(
            "added from the recording's entry URL; the recording's first captured action was not \
             a navigation"
                .to_string(),
        );
        self.steps.push(step);
        self.notes.push(format!(
            "step 1 navigate {start_url} was added from the recording's entry URL"
        ));
    }

    fn push_pointer(&mut self, op: StepOp, target: &TargetDescriptorV3) {
        let mut step = self.blank(op);
        self.apply_target(&mut step, target);
        self.steps.push(step);
    }

    fn push_fill(
        &mut self,
        target: &TargetDescriptorV3,
        value: &str,
        commit: FillCommit,
        redacted: bool,
    ) {
        let mut step = self.blank(StepOp::Fill);
        self.apply_target(&mut step, target);
        step.commit = Some(commit_name(commit).to_string());
        if redacted {
            let name = self.declare_secret(target);
            step.value_from = Some(name.clone());
            self.redacted_fields.push(name);
        } else {
            self.apply_value(&mut step, target, value, "the recorded text");
        }
        self.steps.push(step);
    }

    /// Turn a recorded value into either a parameter or an inline constant.
    fn apply_value(
        &mut self,
        step: &mut WorkflowStep,
        target: &TargetDescriptorV3,
        value: &str,
        what: &str,
    ) {
        if self.policy == ValuePolicy::Inline
            && let Some(reason) = must_not_inline(value)
        {
            let name =
                self.declare_value_param(target, Some(&format!("{what} ({reason})")), step.n);
            self.remember_kept_out(target, value);
            step.value_from = Some(name);
            step.needs_review = true;
            step.note = Some(format!(
                "{reason}, so it was kept out of site memory and turned into a parameter"
            ));
            return;
        }
        if self.policy == ValuePolicy::Inline {
            step.value = Some(value.to_string());
            step.needs_review = true;
            step.note = Some(
                "value inlined from the recording with --inline-values; confirm it is a constant \
                 of the flow and not someone's data"
                    .to_string(),
            );
            return;
        }
        let name = self.declare_value_param(target, Some(what), step.n);
        self.remember_kept_out(target, value);
        step.value_from = Some(name);
        step.needs_review = true;
        step.note = Some(
            "the recorded value is not stored; supply it through this parameter, or re-derive \
             with --inline-values if it really is a constant of the flow"
                .to_string(),
        );
    }

    fn push_select(&mut self, target: &TargetDescriptorV3, selection: &[SelectedOptionV3]) {
        let mut step = self.blank(StepOp::Select);
        self.apply_target(&mut step, target);
        match selection.split_first() {
            Some((first, rest)) => {
                // `bsk select` matches an option's `value` attribute, not its
                // label, and that attribute is a constant the site defines
                // ("zh", "P2") rather than anything the recorder typed. So it
                // is inlined: parameterising it forced the next agent to guess
                // a value the recording already knew. A value that looks like
                // credential material is still kept out of memory.
                match super::validate::find_secret(first.value.trim()) {
                    Some(reason) => {
                        let name = self.declare_value_param(
                            target,
                            Some(&format!("the recorded option value ({reason})")),
                            step.n,
                        );
                        step.value_from = Some(name);
                        step.needs_review = true;
                        step.note = Some(format!(
                            "{reason}, so it was kept out of site memory and turned into a \
                             parameter"
                        ));
                    }
                    None => step.value = Some(first.value.clone()),
                }
                if !rest.is_empty() {
                    let extra: Vec<&str> = rest.iter().map(|o| o.value.as_str()).collect();
                    self.notes.push(format!(
                        "step {} recorded a multi-select ({} options: {}); `bsk select` takes one \
                         value per call, so split it into separate steps",
                        step.n,
                        rest.len() + 1,
                        extra.join(", ")
                    ));
                }
            }
            None => {
                step.needs_review = true;
                step.note = Some("the recording captured no selected option".to_string());
            }
        }
        self.steps.push(step);
    }

    fn push_press(
        &mut self,
        key: &str,
        modifiers: Option<&[bsk_protocol::tools::KeyModifier]>,
        target: Option<&TargetDescriptorV3>,
    ) {
        let mut step = self.blank(StepOp::Press);
        step.key = Some(key.to_string());
        if let Some(modifiers) = modifiers
            && !modifiers.is_empty()
        {
            step.modifiers = Some(
                modifiers
                    .iter()
                    .map(|m| modifier_name(*m).to_string())
                    .collect(),
            );
        }
        if let Some(target) = target {
            self.apply_target(&mut step, target);
        }
        self.steps.push(step);
    }

    /// Copy the semantic anchor, dropping `element_ref` and turning an
    /// unmatched target into an explicit `null` that needs review.
    fn apply_target(&mut self, step: &mut WorkflowStep, target: &TargetDescriptorV3) {
        if target.unmatched {
            step.target = None;
            step.needs_review = true;
            step.note = Some(
                "the recorder could not match this element; supply a role/name anchor".to_string(),
            );
            self.notes.push(format!(
                "step {} has no anchor: the recording matched no unique element",
                step.n
            ));
            return;
        }
        // The anchor must survive a state change: `搜索维基百科 [expanded]` at
        // recording time is the same control as `搜索维基百科` on replay.
        let anchor = StepTarget {
            role: target.role.clone(),
            name: target
                .name
                .as_deref()
                .map(strip_state_annotations)
                .filter(|name| !name.is_empty()),
            ctx: target.ctx.clone(),
        };
        if anchor.is_empty() {
            step.target = None;
            step.needs_review = true;
            step.note = Some("the recording carried no semantic anchor".to_string());
        } else {
            step.target = Some(anchor);
        }
    }

    /// Declare (or reuse) an ordinary parameter carrying a field's value.
    ///
    /// A label that slugs to nothing — any non-ASCII name, such as
    /// `搜索维基百科` — falls back to `field_<n>` rather than a shared `value`.
    /// The old fallback silently merged every unnamed field in a flow into one
    /// parameter, so filling two different boxes took the same input.
    fn declare_value_param(
        &mut self,
        target: &TargetDescriptorV3,
        what: Option<&str>,
        n: u32,
    ) -> String {
        let base = target
            .name
            .as_deref()
            .map(slug_param)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("field_{n}"));
        if let Some(existing) = self
            .params
            .iter()
            .find(|p| !p.secret && p.name == base)
            .map(|p| p.name.clone())
        {
            return existing;
        }
        let name = self.unique_param_name(&base);
        let label = target
            .name
            .as_deref()
            .map(strip_state_annotations)
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "this field".to_string());
        self.params.push(WorkflowParam {
            name: name.clone(),
            required: true,
            secret: false,
            description: Some(match what {
                Some(what) => format!("{what} for {label:?}; not stored on disk"),
                None => format!("value for {label:?}; not stored on disk"),
            }),
            enum_values: None,
        });
        name
    }

    /// Declare (or reuse) a secret parameter for a redacted field.
    fn declare_secret(&mut self, target: &TargetDescriptorV3) -> String {
        let base = target
            .name
            .as_deref()
            .map(slug_param)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "secret".to_string());
        if let Some(existing) = self
            .params
            .iter()
            .find(|p| p.secret && p.name == base)
            .map(|p| p.name.clone())
        {
            return existing;
        }
        let name = self.unique_param_name(&base);
        self.params.push(WorkflowParam {
            name: name.clone(),
            required: true,
            secret: true,
            description: target
                .name
                .as_deref()
                .map(strip_state_annotations)
                .filter(|n| !n.is_empty())
                .map(|n| format!("value for the redacted field {n:?}; never stored on disk")),
            enum_values: None,
        });
        name
    }

    fn unique_param_name(&self, base: &str) -> String {
        if !self.params.iter().any(|p| p.name == base) {
            return base.to_string();
        }
        for suffix in 2..1000u32 {
            let candidate = format!("{base}{suffix}");
            if !self.params.iter().any(|p| p.name == candidate) {
                return candidate;
            }
        }
        format!("{base}-{}", self.params.len())
    }
}

/// Values that stay out of site memory even under `--inline-values`.
///
/// `--inline-values` says "these constants belong to the flow", but the person
/// running it cannot vet every field, so the obvious personal and credential
/// shapes are still parameterised.
fn must_not_inline(value: &str) -> Option<&'static str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if super::validate::find_secret(trimmed).is_some() {
        return Some("the value looks like credential material");
    }
    if trimmed.contains('@') && trimmed.contains('.') && !trimmed.contains(' ') {
        return Some("the value looks like an email address");
    }
    let digits = trimmed.chars().filter(char::is_ascii_digit).count();
    if digits >= 6
        && trimmed
            .chars()
            .all(|c| c.is_ascii_digit() || "+-() ".contains(c))
    {
        return Some("the value looks like a phone number or an identifier");
    }
    if trimmed.chars().count() > 120 {
        return Some("the value is long enough to be free-text someone typed");
    }
    None
}

fn commit_name(commit: FillCommit) -> &'static str {
    match commit {
        FillCommit::Enter => "enter",
        FillCommit::Suggestion => "suggestion",
        FillCommit::Blur => "blur",
    }
}

fn modifier_name(modifier: bsk_protocol::tools::KeyModifier) -> &'static str {
    use bsk_protocol::tools::KeyModifier as K;
    match modifier {
        K::Alt => "alt",
        K::Ctrl => "ctrl",
        K::Meta => "meta",
        K::Shift => "shift",
    }
}

/// Drop the bracketed state annotations the VOM appends to an accessible name.
///
/// An observation renders a control as `ZH [has-submenu]` or
/// `搜索维基百科 [expanded]`: the bracketed part describes the widget's state at
/// recording time, not its identity, and carrying it into a parameter name
/// produced identifiers like `zh_has_submenu` that mean nothing on replay.
fn strip_state_annotations(name: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for ch in name.chars() {
        match ch {
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Turn an accessible name into a parameter identifier. Non-ASCII names (a
/// Chinese label, say) slug down to nothing; the caller supplies the fallback.
fn slug_param(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in strip_state_annotations(name).chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !out.is_empty() && !prev_dash {
            out.push('_');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    let mut trimmed = trimmed;
    trimmed.truncate(32);
    trimmed.trim_matches('_').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::tools::{
        NavigationCause, RecorderInfo, StepCommonV3, StepResultV3, StopReason, TRACE_VERSION_V3,
        TraceEntry, VOM_FORMAT_VERSION,
    };

    fn common(id: u32) -> StepCommonV3 {
        StepCommonV3 {
            id,
            state: "s1".into(),
            result: StepResultV3 { state: "s1".into() },
        }
    }

    fn target(role: &str, name: &str) -> TargetDescriptorV3 {
        TargetDescriptorV3 {
            element_ref: Some("e12".into()),
            role: Some(role.into()),
            name: Some(name.into()),
            ctx: Some("表单".into()),
            unmatched: false,
        }
    }

    fn trace(steps: Vec<StepV3>) -> TraceV3 {
        TraceV3 {
            version: TRACE_VERSION_V3,
            purpose: Some("提交工单".into()),
            started_at: None,
            recorded_at: "2026-09-12T09:31:00Z".into(),
            stopped_by: StopReason::UserFinish,
            entry: TraceEntry {
                start_url: "https://ticket.corp.example/".into(),
            },
            recorder: RecorderInfo {
                bsk: "0.2.1".into(),
                vom: VOM_FORMAT_VERSION,
            },
            states: Vec::new(),
            steps,
        }
    }

    #[test]
    fn element_refs_never_survive_derivation() {
        let derived = derive_workflow(
            &trace(vec![StepV3::Click {
                common: common(1),
                target: target("button", "提交"),
            }]),
            "submit",
            "ticket.corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        let json = serde_json::to_string(&derived.workflow).unwrap();
        assert!(!json.contains("\"ref\""), "{json}");
        assert!(!json.contains("e12"), "{json}");
        let step = &derived.workflow.steps[1];
        assert_eq!(
            step.target.as_ref().unwrap().role.as_deref(),
            Some("button")
        );
        assert_eq!(step.target.as_ref().unwrap().ctx.as_deref(), Some("表单"));
    }

    #[test]
    fn redacted_fill_becomes_a_valueless_secret_parameter() {
        let derived = derive_workflow(
            &trace(vec![StepV3::Fill {
                common: common(1),
                target: target("textbox", "password"),
                value: "hunter2".into(),
                commit: FillCommit::Blur,
                redacted: true,
            }]),
            "login",
            "corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        let json = serde_json::to_string(&derived.workflow).unwrap();
        assert!(!json.contains("hunter2"), "{json}");
        let param = &derived.workflow.params[0];
        assert_eq!(param.name, "password");
        assert!(param.secret && param.required);
        assert_eq!(derived.workflow.steps[1].value, None);
        assert_eq!(
            derived.workflow.steps[1].value_from.as_deref(),
            Some("password")
        );
        assert!(!derived.workflow.secrets_policy.store_values);
        assert_eq!(
            derived.workflow.secrets_policy.redacted_fields,
            vec!["password".to_string()]
        );
    }

    fn fill_trace(name: &str, value: &str) -> TraceV3 {
        trace(vec![StepV3::Fill {
            common: common(1),
            target: target("textbox", name),
            value: value.into(),
            commit: FillCommit::Enter,
            redacted: false,
        }])
    }

    /// Design §6: nothing the user typed is stored. The default policy turns
    /// every recorded value into a parameter and drops the value itself.
    #[test]
    fn recorded_values_become_parameters_by_default() {
        let derived = derive_workflow(
            &fill_trace("title", "打印机坏了"),
            "submit",
            "corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        let json = serde_json::to_string(&derived.workflow).unwrap();
        assert!(!json.contains("打印机坏了"), "{json}");
        let step = &derived.workflow.steps[1];
        assert_eq!(step.value, None);
        assert_eq!(step.value_from.as_deref(), Some("title"));
        assert!(step.needs_review);
        assert_eq!(step.commit.as_deref(), Some("enter"));
        let param = &derived.workflow.params[0];
        assert_eq!(param.name, "title");
        assert!(param.required && !param.secret);
    }

    #[test]
    fn inline_values_keeps_ordinary_constants() {
        let derived = derive_workflow(
            &fill_trace("title", "打印机坏了"),
            "submit",
            "corp.example",
            None,
            ValuePolicy::Inline,
        );
        let step = &derived.workflow.steps[1];
        assert_eq!(step.value.as_deref(), Some("打印机坏了"));
        assert!(step.value_from.is_none());
        assert!(step.needs_review);
        assert!(derived.workflow.params.is_empty());
    }

    /// `--inline-values` is not a licence to store personal data: the obvious
    /// shapes are parameterised even when inlining was requested.
    #[test]
    fn inline_values_still_refuses_personal_and_credential_shapes() {
        for (label, value, reason) in [
            ("email", "someone@corp.example", "email address"),
            ("phone", "+86 138 0013 8000", "phone number"),
            (
                "token",
                "Authorization: Bearer abc123def456",
                "credential material",
            ),
        ] {
            let derived = derive_workflow(
                &fill_trace(label, value),
                "x",
                "corp.example",
                None,
                ValuePolicy::Inline,
            );
            let json = serde_json::to_string(&derived.workflow).unwrap();
            assert!(!json.contains(value), "{label} leaked: {json}");
            let step = &derived.workflow.steps[1];
            assert_eq!(step.value, None, "{label}");
            assert!(step.value_from.is_some(), "{label}");
            assert!(
                step.note.as_deref().unwrap_or_default().contains(reason),
                "{label}: {:?}",
                step.note
            );
        }
    }

    fn select_trace(name: &str, value: &str) -> TraceV3 {
        use bsk_protocol::tools::SelectedOptionV3;
        trace(vec![StepV3::Select {
            common: common(1),
            target: target("combobox", name),
            selection: vec![SelectedOptionV3 {
                value: value.into(),
                label: Some("中文".into()),
            }],
        }])
    }

    /// S2: an option's `value` attribute is a constant the site defines, not
    /// the recorder's data. Parameterising it made the next agent guess a value
    /// the recording already knew, so a select inlines under either policy.
    #[test]
    fn select_values_are_inlined_under_either_policy() {
        for policy in [ValuePolicy::Parameterise, ValuePolicy::Inline] {
            let derived = derive_workflow(
                &select_trace("priority", "P2"),
                "x",
                "corp.example",
                None,
                policy,
            );
            let step = &derived.workflow.steps[1];
            assert_eq!(step.value.as_deref(), Some("P2"), "{policy:?}");
            assert_eq!(step.value_from, None, "{policy:?}");
            assert!(derived.workflow.params.is_empty(), "{policy:?}");
            assert!(!step.needs_review, "{policy:?}");
        }
    }

    /// Inlining a select value is not a licence to store credential material.
    #[test]
    fn a_secret_looking_select_value_still_becomes_a_parameter() {
        let derived = derive_workflow(
            &select_trace("token", "Authorization: Bearer abc123def456"),
            "x",
            "corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        let json = serde_json::to_string(&derived.workflow).unwrap();
        assert!(!json.contains("abc123def456"), "{json}");
        let step = &derived.workflow.steps[1];
        assert_eq!(step.value, None);
        assert_eq!(step.value_from.as_deref(), Some("token"));
        assert!(step.needs_review);
    }

    /// S2: the VOM appends widget state to an accessible name. Carrying it into
    /// the identifier produced `zh_has_submenu`, which describes nothing the
    /// next agent can act on.
    /// D4: the typed search term never lands on disk as a value, but the
    /// results page URL the recorder captured next embeds it percent-encoded.
    #[test]
    fn a_navigation_that_embeds_a_kept_out_value_is_dropped() {
        let derived = derive_workflow(
            &trace(vec![
                StepV3::Fill {
                    common: common(1),
                    target: target("searchbox", "搜索维基百科"),
                    value: "珠穆朗玛峰".into(),
                    commit: FillCommit::Enter,
                    redacted: false,
                },
                StepV3::Navigate {
                    common: common(2),
                    to: "https://zh.wikipedia.org/w/index.php?search=%E7%8F%A0%E7%A9%86%E6%9C%97%E7%8E%9B%E5%B3%B0&go=Go".into(),
                    cause: NavigationCause::FormSubmit,
                },
                // Typed into the address bar, so it is the agent's own step —
                // but the URL still carries the kept-out value.
                StepV3::Navigate {
                    common: common(3),
                    to: "https://zh.wikipedia.org/w/index.php?search=珠穆朗玛峰".into(),
                    cause: NavigationCause::UserTyped,
                },
                StepV3::Navigate {
                    common: common(4),
                    to: "https://zh.wikipedia.org/wiki/Main".into(),
                    cause: NavigationCause::UserTyped,
                },
            ]),
            "wf",
            "ticket.corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        let json = serde_json::to_string(&derived.workflow).unwrap();
        assert!(!json.contains("search="), "{json}");
        assert!(!json.contains("珠穆朗玛峰"), "{json}");
        assert!(json.contains("wiki/Main"), "{json}");
        // one effect navigation + one address-bar URL embedding the value
        assert_eq!(derived.dropped_steps, 2);
        let notes = &derived.workflow.review_notes;
        assert!(
            notes.iter().any(|n| n.contains("embeds the value")),
            "{notes:?}"
        );
        assert!(
            notes
                .iter()
                .any(|n| n.contains("in response to a recorded click")),
            "{notes:?}"
        );
    }

    #[test]
    fn state_annotations_never_reach_a_step_anchor() {
        let derived = derive_workflow(
            &fill_trace("搜索维基百科 [expanded]", "x"),
            "wf",
            "ticket.corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        let json = serde_json::to_string(&derived.workflow).unwrap();
        assert!(json.contains("\"name\":\"搜索维基百科\""), "{json}");
        assert!(!json.contains("[expanded]"), "{json}");
    }

    #[test]
    fn state_annotations_never_reach_a_parameter_name() {
        let derived = derive_workflow(
            &fill_trace("ZH [has-submenu]", "x"),
            "x",
            "corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        assert_eq!(derived.workflow.params[0].name, "zh");
    }

    /// A label that slugs to nothing gets a per-step name. The old shared
    /// `value` fallback merged every unnamed field in a flow into one
    /// parameter, so two different boxes took the same input.
    #[test]
    fn unsluggable_labels_get_one_parameter_per_step() {
        let derived = derive_workflow(
            &trace(vec![
                StepV3::Fill {
                    common: common(1),
                    target: target("searchbox", "搜索维基百科"),
                    value: "a".into(),
                    commit: FillCommit::Blur,
                    redacted: false,
                },
                StepV3::Fill {
                    common: common(2),
                    target: target("textbox", "备注"),
                    value: "b".into(),
                    commit: FillCommit::Blur,
                    redacted: false,
                },
            ]),
            "x",
            "corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        let names: Vec<&str> = derived
            .workflow
            .params
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        assert_eq!(names, vec!["field_2", "field_3"]);
        assert_eq!(
            derived.workflow.steps[1].value_from.as_deref(),
            Some("field_2")
        );
        assert_eq!(
            derived.workflow.steps[2].value_from.as_deref(),
            Some("field_3")
        );
    }

    #[test]
    fn unmatched_target_becomes_null_and_needs_review() {
        let derived = derive_workflow(
            &trace(vec![StepV3::Click {
                common: common(1),
                target: TargetDescriptorV3 {
                    element_ref: None,
                    role: Some("button".into()),
                    name: Some("提交".into()),
                    ctx: None,
                    unmatched: true,
                },
            }]),
            "submit",
            "corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        assert!(derived.workflow.steps[1].target.is_none());
        assert!(derived.workflow.steps[1].needs_review);
        assert!(
            derived
                .workflow
                .review_notes
                .iter()
                .any(|note| note.contains("step 2 has no anchor")),
            "{:?}",
            derived.workflow.review_notes
        );
    }

    /// S2: a recording routinely ends up on `about:blank` — backing out past
    /// the page it started on does exactly that. One such step used to fail the
    /// whole derivation and throw the bundle away.
    #[test]
    fn unreplayable_navigations_are_dropped_not_fatal() {
        let derived = derive_workflow(
            &trace(vec![
                StepV3::Navigate {
                    common: common(1),
                    to: "https://corp.example/new".into(),
                    cause: NavigationCause::UserTyped,
                },
                StepV3::Navigate {
                    common: common(2),
                    to: "about:blank".into(),
                    cause: NavigationCause::History,
                },
                StepV3::Click {
                    common: common(3),
                    target: target("button", "提交"),
                },
            ]),
            "submit",
            "corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        assert_eq!(derived.dropped_steps, 1);
        let ops: Vec<StepOp> = derived.workflow.steps.iter().map(|s| s.op).collect();
        assert_eq!(ops, vec![StepOp::Navigate, StepOp::Click]);
        assert!(
            derived
                .workflow
                .review_notes
                .iter()
                .any(|note| note.contains("about:blank")),
            "{:?}",
            derived.workflow.review_notes
        );
        // The dropped step must not be validated as a navigate target either.
        let raw = serde_json::to_value(&derived.workflow).unwrap();
        let report =
            super::super::validate::validate_workflow(&derived.workflow, &raw, "corp.example");
        assert!(report.is_ok(), "{:?}", report.errors);
    }

    /// S2: a workflow whose first step is a `select` never says which page to
    /// be on. The entry URL is the one thing the recording knows and the next
    /// agent cannot guess.
    #[test]
    fn a_workflow_that_does_not_start_on_a_navigation_gets_the_entry_url() {
        let derived = derive_workflow(
            &select_trace("lang", "zh"),
            "x",
            "wikipedia.org",
            None,
            ValuePolicy::Parameterise,
        );
        let first = &derived.workflow.steps[0];
        assert_eq!(first.op, StepOp::Navigate);
        assert_eq!(first.to.as_deref(), Some("https://ticket.corp.example/"));
        assert_eq!(derived.workflow.steps[1].op, StepOp::Select);

        // A recording that already opens with a navigation is left alone.
        let native = derive_workflow(
            &trace(vec![StepV3::Navigate {
                common: common(1),
                to: "https://corp.example/new".into(),
                cause: NavigationCause::UserTyped,
            }]),
            "x",
            "corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        assert_eq!(native.workflow.steps.len(), 1);
        assert_eq!(
            native.workflow.steps[0].to.as_deref(),
            Some("https://corp.example/new")
        );
    }

    #[test]
    fn scroll_and_switch_tab_are_dropped_and_steps_renumbered() {
        let derived = derive_workflow(
            &trace(vec![
                StepV3::Navigate {
                    common: common(1),
                    to: "https://corp.example/new".into(),
                    cause: NavigationCause::UserTyped,
                },
                StepV3::Scroll { common: common(2) },
                StepV3::SwitchTab { common: common(3) },
                StepV3::Click {
                    common: common(4),
                    target: target("button", "提交"),
                },
            ]),
            "submit",
            "corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        assert_eq!(derived.dropped_steps, 2);
        let ns: Vec<u32> = derived.workflow.steps.iter().map(|s| s.n).collect();
        assert_eq!(ns, vec![1, 2]);
        assert_eq!(derived.workflow.steps[1].op, StepOp::Click);
    }

    #[test]
    fn press_keeps_key_and_modifiers() {
        use bsk_protocol::tools::KeyModifier;
        let derived = derive_workflow(
            &trace(vec![StepV3::Press {
                common: common(1),
                key: "Enter".into(),
                modifiers: Some(vec![KeyModifier::Ctrl, KeyModifier::Shift]),
                target: None,
            }]),
            "x",
            "corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        let step = &derived.workflow.steps[1];
        assert_eq!(step.key.as_deref(), Some("Enter"));
        assert_eq!(
            step.modifiers.as_deref(),
            Some(["ctrl".to_string(), "shift".to_string()].as_slice())
        );
    }

    /// S2: the host is where the recording *started*. Reading the first
    /// navigate instead filed a search begun on `www.wikipedia.org` under the
    /// article host it landed on, and then rejected the real start host.
    #[test]
    fn host_comes_from_the_entry_url_before_any_navigation() {
        let mut wandered = trace(vec![StepV3::Navigate {
            common: common(1),
            to: "https://zh.wikipedia.org/wiki/x".into(),
            cause: NavigationCause::Browser,
        }]);
        wandered.entry.start_url = "https://www.wikipedia.org/".into();
        assert_eq!(infer_host(&wandered).as_deref(), Some("www.wikipedia.org"));

        assert_eq!(
            infer_host(&trace(Vec::new())).as_deref(),
            Some("ticket.corp.example")
        );

        // A recording armed on a blank tab falls back to the first real page.
        let mut blank = trace(vec![StepV3::Navigate {
            common: common(1),
            to: "https://ticket.corp.example:8443/new?a=1".into(),
            cause: NavigationCause::Link,
        }]);
        blank.entry.start_url = "about:blank".into();
        assert_eq!(infer_host(&blank).as_deref(), Some("ticket.corp.example"));

        let mut nothing = trace(Vec::new());
        nothing.entry.start_url = "about:blank".into();
        assert_eq!(infer_host(&nothing), None);
    }

    #[test]
    fn secret_parameter_names_are_unique_and_ascii() {
        let derived = derive_workflow(
            &trace(vec![
                StepV3::Fill {
                    common: common(1),
                    target: target("textbox", "密码"),
                    value: "a".into(),
                    commit: FillCommit::Blur,
                    redacted: true,
                },
                StepV3::Fill {
                    common: common(2),
                    target: target("textbox", "确认密码"),
                    value: "a".into(),
                    commit: FillCommit::Blur,
                    redacted: true,
                },
            ]),
            "login",
            "corp.example",
            None,
            ValuePolicy::Parameterise,
        );
        // Both labels slug to nothing, so the second reuses the first's name.
        assert_eq!(derived.workflow.params.len(), 1);
        assert_eq!(derived.workflow.params[0].name, "secret");
    }

    #[test]
    fn slug_param_keeps_ascii_words_only() {
        assert_eq!(slug_param("Ticket Title!"), "ticket_title");
        assert_eq!(slug_param("密码"), "");
        assert_eq!(slug_param("  "), "");
        // VOM state annotations describe the widget, not the field.
        assert_eq!(slug_param("ZH [has-submenu]"), "zh");
        assert_eq!(slug_param("Search [expanded] [empty]"), "search");
        assert_eq!(slug_param("搜索维基百科 [expanded]"), "");
        assert_eq!(strip_state_annotations("a [x] b"), "a  b");
        // An unclosed bracket swallows the rest rather than leaking it.
        assert_eq!(strip_state_annotations("name [oops"), "name");
    }
}
