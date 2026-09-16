//! Policy checks that gate what may enter active site memory (design §3.3,
//! §3.4, §6).
//!
//! The checks split in two: *promotion* rules run at checkpoint and decide
//! whether a draft may be published, while *capture* rules (sensitive hosts,
//! secret-looking text) run at write time so a bad value never lands on disk
//! in the first place.

use std::collections::BTreeSet;
use std::path::Path;

use super::model::{
    Candidate, CandidateKind, CandidateStatus, SITE_MD_HARD_LINE_BUDGET, SITE_MD_SOFT_LINE_BUDGET,
    StepOp, WORKFLOW_SCHEMA_VERSION, Workflow, WorkflowStrategy, normalize_claim, parse_date,
};
use super::store;

/// Per-file cap for `references/*.md`. Generous for prose, small enough that a
/// pasted page dump is refused.
pub const REFERENCE_MAX_BYTES: usize = 64 * 1024;

/// Result of a validation pass. Warnings are reported but never block.
#[derive(Debug, Default, Clone)]
pub struct Report {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

impl Report {
    pub fn is_ok(&self) -> bool {
        self.errors.is_empty()
    }

    pub fn merge(&mut self, other: Report) {
        self.errors.extend(other.errors);
        self.warnings.extend(other.warnings);
    }
}

// ---------------------------------------------------------------------------
// Sensitive hosts
// ---------------------------------------------------------------------------

/// Hosts whose recordings must never be distilled into a reusable asset.
///
/// `skill/SKILL.md` already forbids *recording* banking, SSO and
/// password-manager pages; this list is the machine-checked half, so a trace
/// captured against the rule cannot become a durable, shareable workflow.
const SENSITIVE_DOMAIN_SUFFIXES: &[&str] = &[
    // Password managers and secret stores
    "1password.com",
    "bitwarden.com",
    "dashlane.com",
    "keepersecurity.com",
    "lastpass.com",
    "vaultproject.io",
    // Identity providers / SSO
    "auth0.com",
    "duosecurity.com",
    "okta.com",
    "onelogin.com",
    "accounts.google.com",
    "login.microsoftonline.com",
    "login.live.com",
    "login.yahoo.com",
    "id.apple.com",
    // Payments and banking
    "paypal.com",
    "stripe.com",
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "citibank.com",
    "hsbc.com",
    "barclays.co.uk",
    "icbc.com.cn",
    "ccb.com",
    "abchina.com",
    "boc.cn",
    "bankcomm.com",
    "cmbchina.com",
    "psbc.com",
    "unionpay.com",
    "alipay.com",
];

/// Host labels that mark a login / secret surface regardless of domain.
///
/// Matched on whole labels (or a `keyword-…` / `…-keyword` label) so
/// `authoring.corp.example` is not mistaken for an auth endpoint.
const SENSITIVE_LABELS: &[&str] = &[
    "auth", "authn", "bank", "banking", "ebank", "netbank", "idp", "keychain", "login", "logon",
    "mfa", "oauth", "openid", "otp", "passwd", "password", "signin", "sso", "2fa", "vault",
];

/// Why a host is refused, in a sentence the agent can relay to the user.
pub fn sensitive_host_reason(host: &str) -> Option<String> {
    let host = host.to_ascii_lowercase();
    for suffix in SENSITIVE_DOMAIN_SUFFIXES {
        if host == *suffix || host.ends_with(&format!(".{suffix}")) {
            return Some(format!(
                "{host} matches the blocked domain {suffix}: banking, SSO and password-manager \
                 flows must not be distilled into reusable site memory"
            ));
        }
    }
    for label in host.split('.') {
        if let Some(keyword) = SENSITIVE_LABELS.iter().find(|k| label_matches(label, k)) {
            return Some(format!(
                "{host} carries the credential-surface label {keyword:?}: banking, SSO and \
                 password-manager flows must not be distilled into reusable site memory"
            ));
        }
    }
    None
}

fn label_matches(label: &str, keyword: &str) -> bool {
    if label == keyword {
        return true;
    }
    label
        .strip_prefix(keyword)
        .is_some_and(|rest| rest.starts_with('-'))
        || label
            .strip_suffix(keyword)
            .is_some_and(|rest| rest.ends_with('-'))
}

// ---------------------------------------------------------------------------
// Secret-looking text
// ---------------------------------------------------------------------------

/// Substrings that mark a value as credential material. Matched
/// case-insensitively against the whole text.
const SECRET_MARKERS: &[(&str, &str)] = &[
    ("bearer ", "a bearer token"),
    ("authorization:", "an Authorization header"),
    ("set-cookie:", "a Set-Cookie header"),
    ("cookie=", "a cookie value"),
    ("password=", "a password"),
    ("passwd=", "a password"),
    ("pwd=", "a password"),
    ("token=", "a token"),
    ("access_token", "an access token"),
    ("refresh_token", "a refresh token"),
    ("client_secret", "a client secret"),
    ("api_key=", "an API key"),
    ("apikey=", "an API key"),
    ("secret=", "a secret"),
    ("-----begin ", "a PEM private key"),
    ("eyj", "a JWT"),
    ("ghp_", "a GitHub token"),
    ("xoxb-", "a Slack token"),
    ("sk_live_", "a live API key"),
];

/// Detect obvious credential material. Returns a human-readable reason.
///
/// Deliberately conservative pattern matching rather than entropy scoring:
/// false positives cost one rephrased claim, a false negative writes a token
/// into a file that is never deleted.
pub fn find_secret(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    for (marker, what) in SECRET_MARKERS {
        if !lower.contains(marker) {
            continue;
        }
        // `eyJ` only means a JWT when a base64 segment and a dot follow it.
        if *marker == "eyj" && !looks_like_jwt(&lower) {
            continue;
        }
        return Some(format!(
            "the text looks like it contains {what} ({marker:?}); site memory records what to do, \
             never credentials"
        ));
    }
    None
}

fn looks_like_jwt(lower: &str) -> bool {
    lower.match_indices("eyj").any(|(idx, _)| {
        let tail = &lower[idx..];
        let segment: String = tail
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        segment.len() >= 12 && tail[segment.len()..].starts_with('.')
    })
}

// ---------------------------------------------------------------------------
// SITE.md
// ---------------------------------------------------------------------------

/// Validate a `SITE.md` body (design §3.3).
///
/// `references` lists the reference file names available next to it, so
/// pointers can be checked for dangling targets.
pub fn validate_site_md(text: &str, references: &[String]) -> Report {
    let mut report = Report::default();
    let lines: Vec<&str> = text.lines().collect();

    if lines.len() > SITE_MD_HARD_LINE_BUDGET {
        report.errors.push(format!(
            "SITE.md is {} lines, over the {SITE_MD_HARD_LINE_BUDGET}-line budget. Rewrite it to \
             {SITE_MD_SOFT_LINE_BUDGET} lines or fewer and move the detail into \
             references/<name>.md, linked as `](references/<name>.md)`.",
            lines.len()
        ));
    } else if lines.len() > SITE_MD_SOFT_LINE_BUDGET {
        report.warnings.push(format!(
            "SITE.md is {} lines, past the {SITE_MD_SOFT_LINE_BUDGET}-line target. Move detail \
             into references/<name>.md before it reaches {SITE_MD_HARD_LINE_BUDGET}.",
            lines.len()
        ));
    }

    report.merge(check_verified_dates(&lines));
    report.merge(check_reference_pointers(text, references));
    report.merge(check_no_secrets(&lines, "SITE.md"));
    report
}

/// Refuse credential material anywhere in a prose memory file.
///
/// `SITE.md` and `references/*.md` are free text an agent writes, which is
/// exactly where a pasted header or token ends up. They live next to
/// `~/.bsk/audit/` and must keep the same promise.
pub fn check_no_secrets(lines: &[&str], label: &str) -> Report {
    let mut report = Report::default();
    for (index, line) in lines.iter().enumerate() {
        if let Some(reason) = find_secret(line) {
            report
                .errors
                .push(format!("{label} line {}: {reason}", index + 1));
        }
    }
    report
}

/// Validate one `references/<name>.md` file.
pub fn validate_reference(name: &str, text: &str) -> Report {
    let mut report = Report::default();
    if text.len() > REFERENCE_MAX_BYTES {
        report.errors.push(format!(
            "references/{name}.md is {} bytes, over the {REFERENCE_MAX_BYTES}-byte limit. A \
             reference holds detail a human reads, not a page dump.",
            text.len()
        ));
    }
    let lines: Vec<&str> = text.lines().collect();
    report.merge(check_no_secrets(&lines, &format!("references/{name}.md")));
    report
}

/// Every persistent fact carries `[verified YYYY-MM-DD]`.
///
/// Facts are folded before they are judged: an indented line continues the
/// fact above it, so a markdown list item wrapped over several lines is one
/// claim carrying one stamp, not N unstamped lines. Exempt entirely:
/// frontmatter, fenced code, table separator and header rows, headings and
/// horizontal rules — a section title is structure, not a claim about the site.
fn check_verified_dates(lines: &[&str]) -> Report {
    let mut report = Report::default();
    let mut state = ScanState::default();
    let mut pending: Option<Fact> = None;
    for (index, raw) in lines.iter().enumerate() {
        match state.classify(index, raw, lines) {
            LineKind::Exempt => {
                if let Some(fact) = pending.take() {
                    fact.check(&mut report);
                }
            }
            // An indented line with nothing above it is not a continuation of
            // anything — it is a claim that tried to hide behind its indent.
            LineKind::Continuation(text) => match pending.as_mut() {
                Some(fact) => fact.push(text),
                None => pending = Some(Fact::new(index, text)),
            },
            LineKind::Fact(text) => {
                if let Some(fact) = pending.replace(Fact::new(index, text)) {
                    fact.check(&mut report);
                }
            }
        }
    }
    if let Some(fact) = pending.take() {
        fact.check(&mut report);
    }
    if let Some(problem) = state.unclosed_fence() {
        report.errors.push(problem);
    }
    report
}

/// One logical claim: a line plus any indented lines that continue it.
struct Fact {
    /// Zero-based index of the line the fact starts on.
    line: usize,
    text: String,
}

impl Fact {
    fn new(line: usize, text: &str) -> Self {
        Self {
            line,
            text: text.to_string(),
        }
    }

    fn push(&mut self, text: &str) {
        self.text.push(' ');
        self.text.push_str(text);
    }

    fn check(&self, report: &mut Report) {
        match extract_verified_date(&self.text) {
            None => report.errors.push(format!(
                "SITE.md line {}: every persistent fact needs a `[verified YYYY-MM-DD]` stamp — \
                 keep each fact on one line or indent continuation lines — {}",
                self.line + 1,
                truncate(&self.text, 72)
            )),
            Some(date) => {
                if let Some(problem) = bad_date(date) {
                    report.errors.push(format!(
                        "SITE.md line {}: {problem} in `[verified {date}]`",
                        self.line + 1
                    ));
                }
            }
        }
    }
}

/// What one raw line contributes to the fact stream.
enum LineKind<'a> {
    /// Structure or skipped content. Ends any open fact.
    Exempt,
    /// Indented: continues the fact above it.
    Continuation(&'a str),
    /// Starts a new fact.
    Fact(&'a str),
}

#[derive(Default)]
struct ScanState {
    in_frontmatter: bool,
    fence: Option<String>,
}

impl ScanState {
    fn classify<'a>(&mut self, index: usize, raw: &'a str, lines: &[&str]) -> LineKind<'a> {
        let trimmed = raw.trim();
        if index == 0 && trimmed == "---" && lines.len() > 1 {
            self.in_frontmatter = true;
            return LineKind::Exempt;
        }
        if self.in_frontmatter {
            if trimmed == "---" || trimmed == "..." {
                self.in_frontmatter = false;
            }
            return LineKind::Exempt;
        }
        if let Some(fence) = &self.fence {
            if trimmed.starts_with(fence.as_str()) {
                self.fence = None;
            }
            return LineKind::Exempt;
        }
        for marker in ["```", "~~~"] {
            if trimmed.starts_with(marker) {
                self.fence = Some(marker.to_string());
                return LineKind::Exempt;
            }
        }
        if trimmed.is_empty() {
            return LineKind::Exempt;
        }
        let structural = trimmed.starts_with('#')
            || is_horizontal_rule(trimmed)
            || is_table_separator(trimmed)
            // A table header is structure; the separator row below it says so.
            || lines
                .get(index + 1)
                .is_some_and(|next| is_table_separator(next.trim()));
        if structural {
            return LineKind::Exempt;
        }
        // Strip blockquote markers so `> a fact [verified …]` is judged on its
        // content rather than its quoting. A blockquote is quoted material, but
        // it still asserts something about the site, so the rule applies.
        let content = trimmed.trim_start_matches(['>', ' ']).trim();
        if content.is_empty() {
            return LineKind::Exempt;
        }
        if raw.starts_with("  ") || raw.starts_with('\t') {
            return LineKind::Continuation(content);
        }
        LineKind::Fact(content)
    }

    /// Report an unterminated fence at end of input: silently swallowing the
    /// rest of the file would exempt every fact below it.
    fn unclosed_fence(&self) -> Option<String> {
        self.fence
            .as_ref()
            .map(|fence| format!("SITE.md has an unclosed `{fence}` code fence"))
    }
}

fn is_horizontal_rule(line: &str) -> bool {
    line.len() >= 3
        && (line.chars().all(|c| c == '-')
            || line.chars().all(|c| c == '*')
            || line.chars().all(|c| c == '_'))
}

fn is_table_separator(line: &str) -> bool {
    line.starts_with('|')
        && line.contains('-')
        && line
            .chars()
            .all(|c| matches!(c, '|' | '-' | ':' | ' ' | '+'))
}

/// Pull the date out of a `[verified YYYY-MM-DD]` stamp.
fn extract_verified_date(line: &str) -> Option<&str> {
    let start = line.find("[verified ")? + "[verified ".len();
    let rest = &line[start..];
    let end = rest.find(']')?;
    Some(&rest[..end])
}

fn bad_date(date: &str) -> Option<String> {
    let Some(parsed) = parse_date(date) else {
        return Some(format!("{date:?} is not a YYYY-MM-DD date"));
    };
    if parsed > time::OffsetDateTime::now_utc().date() {
        return Some(format!("{date:?} is in the future"));
    }
    None
}

/// `](references/<name>.md)` pointers must resolve.
fn check_reference_pointers(text: &str, references: &[String]) -> Report {
    let mut report = Report::default();
    let known: BTreeSet<&str> = references.iter().map(String::as_str).collect();
    let mut rest = text;
    while let Some(idx) = rest.find("](references/") {
        rest = &rest[idx + "](references/".len()..];
        let Some(end) = rest.find(')') else { break };
        let target = &rest[..end];
        rest = &rest[end..];
        let Some(stem) = target.strip_suffix(".md") else {
            report.errors.push(format!(
                "SITE.md points at references/{target}, but reference files must end in .md"
            ));
            continue;
        };
        if !known.contains(stem) {
            report.errors.push(format!(
                "SITE.md points at references/{target}, which does not exist in this draft"
            ));
        }
    }
    report
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}…")
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/// Validate one workflow document plus its raw JSON.
///
/// `raw` is scanned separately so a rejected field such as `ref` is reported
/// with an actionable message rather than only as a serde parse failure.
pub fn validate_workflow(workflow: &Workflow, raw: &serde_json::Value, host: &str) -> Report {
    let mut report = Report::default();
    let id = &workflow.id;

    if workflow.schema_version != WORKFLOW_SCHEMA_VERSION {
        report.errors.push(format!(
            "workflow {id}: schemaVersion must be {WORKFLOW_SCHEMA_VERSION}, found {}",
            workflow.schema_version
        ));
    }
    if let Err(err) = store::validate_id(id, "workflow") {
        report.errors.push(format!("workflow {id}: {err}"));
    }
    if workflow.host != host {
        report.errors.push(format!(
            "workflow {id}: host is {:?} but it lives under {host:?}",
            workflow.host
        ));
    }
    if workflow.strategy != WorkflowStrategy::UiOnly {
        report
            .errors
            .push(format!("workflow {id}: strategy must be \"ui-only\""));
    }
    if workflow.secrets_policy.store_values {
        report.errors.push(format!(
            "workflow {id}: secretsPolicy.storeValues must be false — site memory never stores \
             recorded input values"
        ));
    }
    if let Some(date) = &workflow.last_verified
        && let Some(problem) = bad_date(date)
    {
        report
            .errors
            .push(format!("workflow {id}: lastVerified {problem}"));
    }
    if let Some(reason) = find_secret(&raw.to_string()) {
        report.errors.push(format!("workflow {id}: {reason}"));
    }
    if let Some(path) = find_ref_key(raw) {
        report.errors.push(format!(
            "workflow {id}: `{path}` carries a record-local element ref. Refs die with the \
             recording session; keep only role/name/ctx."
        ));
    }
    report.merge(validate_steps(workflow));
    report
}

fn validate_steps(workflow: &Workflow) -> Report {
    let mut report = Report::default();
    let id = &workflow.id;
    if workflow.steps.is_empty() {
        report
            .errors
            .push(format!("workflow {id}: steps must not be empty"));
        return report;
    }
    let params: BTreeSet<&str> = workflow.params.iter().map(|p| p.name.as_str()).collect();
    let secrets: BTreeSet<&str> = workflow
        .params
        .iter()
        .filter(|p| p.secret)
        .map(|p| p.name.as_str())
        .collect();

    for (index, step) in workflow.steps.iter().enumerate() {
        let expected = index as u32 + 1;
        if step.n != expected {
            report.errors.push(format!(
                "workflow {id}: step {} is numbered {}, expected {expected}",
                index + 1,
                step.n
            ));
        }
        if let Some(name) = &step.value_from {
            if !params.contains(name.as_str()) {
                report.errors.push(format!(
                    "workflow {id} step {expected}: valueFrom {name:?} is not a declared parameter"
                ));
            }
            if step.value.is_some() && secrets.contains(name.as_str()) {
                report.errors.push(format!(
                    "workflow {id} step {expected}: a secret parameter must not carry an inline \
                     value"
                ));
            }
        }
        report.merge(validate_step_shape(id, step, expected));
    }
    report
}

fn validate_step_shape(id: &str, step: &super::model::WorkflowStep, n: u32) -> Report {
    let mut report = Report::default();
    let mut require_value = |what: &str| {
        if step.value.is_none() && step.value_from.is_none() {
            report.errors.push(format!(
                "workflow {id} step {n}: op {what} requires `value` or `valueFrom`"
            ));
        }
    };
    match step.op {
        StepOp::Navigate => match step.to.as_deref() {
            None => report
                .errors
                .push(format!("workflow {id} step {n}: op navigate requires `to`")),
            Some(to) if !to.starts_with("http://") && !to.starts_with("https://") => {
                report.errors.push(format!(
                    "workflow {id} step {n}: navigate target {to:?} must be an http(s) URL"
                ));
            }
            Some(_) => {}
        },
        StepOp::Click | StepOp::Hover => {
            if step.target.is_none() && !step.needs_review {
                report.errors.push(format!(
                    "workflow {id} step {n}: op {} has no target; an anchorless step must be \
                     flagged needsReview",
                    step.op.as_str()
                ));
            }
        }
        StepOp::Fill => require_value("fill"),
        StepOp::Select => require_value("select"),
        StepOp::Press => {
            if step.key.as_deref().unwrap_or_default().is_empty() {
                report
                    .errors
                    .push(format!("workflow {id} step {n}: op press requires `key`"));
            }
        }
    }
    report
}

/// Locate any `ref` key anywhere in the document, reporting its JSON path.
fn find_ref_key(value: &serde_json::Value) -> Option<String> {
    fn walk(value: &serde_json::Value, path: &str) -> Option<String> {
        match value {
            serde_json::Value::Object(map) => {
                for (key, child) in map {
                    let next = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    };
                    if key == "ref" {
                        return Some(next);
                    }
                    if let Some(found) = walk(child, &next) {
                        return Some(found);
                    }
                }
                None
            }
            serde_json::Value::Array(items) => items
                .iter()
                .enumerate()
                .find_map(|(i, child)| walk(child, &format!("{path}[{i}]"))),
            _ => None,
        }
    }
    walk(value, "")
}

/// Parse and validate every workflow JSON file in a directory.
pub fn validate_workflow_dir(dir: &Path, host: &str) -> Report {
    let mut report = Report::default();
    let stems = match store::list_stems(dir, "json") {
        Ok(stems) => stems,
        Err(err) => {
            report.errors.push(format!("{}: {err:#}", dir.display()));
            return report;
        }
    };
    for stem in stems {
        let name = format!("{stem}.json");
        let path = match store::resolve_in(dir, &[name.as_str()]) {
            Ok(path) => path,
            Err(err) => {
                report.errors.push(format!("{name}: {err:#}"));
                continue;
            }
        };
        let raw: serde_json::Value = match store::read_json(&path) {
            Ok(raw) => raw,
            Err(err) => {
                report.errors.push(format!("{name}: {err:#}"));
                continue;
            }
        };
        match serde_json::from_value::<Workflow>(raw.clone()) {
            Ok(workflow) => {
                if workflow.id != stem {
                    report.errors.push(format!(
                        "{name}: workflow id is {:?} but the file is named {stem}.json",
                        workflow.id
                    ));
                }
                report.merge(validate_workflow(&workflow, &raw, host));
            }
            Err(err) => report.errors.push(format!("{name}: {err}")),
        }
    }
    report
}

// ---------------------------------------------------------------------------
// Candidate promotion
// ---------------------------------------------------------------------------

/// Whether `candidate` may be ingested, given every candidate on this host.
///
/// Ordinary kinds need a second independent observation on a different UTC
/// day; `high_consequence` is exempt because waiting for a repeat means
/// letting the damage happen twice (design §3.4).
pub fn check_corroboration(candidate: &Candidate, all: &[Candidate]) -> Result<(), String> {
    if !candidate.kind.needs_corroboration() {
        return Ok(());
    }
    let claim = normalize_claim(&candidate.claim);
    let days: BTreeSet<&str> = all
        .iter()
        .filter(|other| {
            other.host == candidate.host
                && other.status != CandidateStatus::Rejected
                && normalize_claim(&other.claim) == claim
        })
        .map(|other| other.observed_date_utc.as_str())
        .collect();
    if days.len() >= 2 {
        return Ok(());
    }
    Err(format!(
        "candidate {} ({}) was observed on {} day(s); an ordinary claim needs two independent \
         observations on different UTC dates before it may change site memory. Record the second \
         sighting with `bsk site candidate add`, or use kind high_consequence when one sighting is \
         already decisive.",
        candidate.id,
        candidate.kind.as_str(),
        days.len().max(1)
    ))
}

/// Kinds accepted by `workflow verify --fail`.
pub fn is_failure_kind(kind: CandidateKind) -> bool {
    matches!(kind, CandidateKind::RepeatedMistake | CandidateKind::Access)
}

#[cfg(test)]
mod tests {
    use super::super::model::{Candidate, SecretsPolicy, StepTarget, WorkflowParam, WorkflowStep};
    use super::*;

    fn workflow(steps: Vec<WorkflowStep>, params: Vec<WorkflowParam>) -> Workflow {
        Workflow {
            schema_version: WORKFLOW_SCHEMA_VERSION,
            id: "submit-ticket".into(),
            host: "corp.example".into(),
            purpose: None,
            strategy: WorkflowStrategy::UiOnly,
            last_verified: None,
            source_trace: None,
            params,
            preconditions: Vec::new(),
            steps,
            postcondition: None,
            secrets_policy: SecretsPolicy::default(),
            needs_review: false,
            review_notes: Vec::new(),
        }
    }

    fn step(n: u32, op: StepOp) -> WorkflowStep {
        WorkflowStep {
            n,
            op,
            to: None,
            target: Some(StepTarget {
                role: Some("button".into()),
                name: Some("提交".into()),
                ctx: None,
            }),
            value: None,
            value_from: None,
            commit: None,
            key: None,
            modifiers: None,
            note: None,
            needs_review: false,
        }
    }

    fn check(wf: &Workflow) -> Report {
        let raw = serde_json::to_value(wf).unwrap();
        validate_workflow(wf, &raw, "corp.example")
    }

    #[test]
    fn sensitive_hosts_are_refused_without_blocking_lookalikes() {
        assert!(sensitive_host_reason("login.microsoftonline.com").is_some());
        assert!(sensitive_host_reason("www.paypal.com").is_some());
        assert!(sensitive_host_reason("sso.corp.example").is_some());
        assert!(sensitive_host_reason("my-bank.corp.example").is_some());
        assert!(sensitive_host_reason("netbank.example.co.uk").is_some());

        assert!(sensitive_host_reason("ticket.corp.example").is_none());
        // "authoring" merely starts with "auth"; label matching must not fire.
        assert!(sensitive_host_reason("authoring.corp.example").is_none());
        assert!(sensitive_host_reason("notpaypal.com.example").is_none());
    }

    #[test]
    fn secret_markers_are_detected_and_plain_text_passes() {
        assert!(find_secret("Authorization: Bearer abc123").is_some());
        assert!(find_secret("set the cookie=session_id").is_some());
        assert!(find_secret("password=hunter2").is_some());
        assert!(find_secret("eyJhbGciOiJIUzI1NiJ9.payload").is_some());
        assert!(find_secret("-----BEGIN RSA PRIVATE KEY-----").is_some());

        assert!(find_secret("the submit button lives in the bottom bar").is_none());
        // A bare `eyj` without a JWT-shaped tail is not a token.
        assert!(find_secret("eyj is not a token").is_none());
    }

    #[test]
    fn site_md_requires_verified_stamps_outside_exempt_blocks() {
        let text = "---\ntitle: x\n---\n\n# Heading\n\n\
                    Submitting needs the P2 dropdown. [verified 2026-09-15]\n\n\
                    ```sh\nbsk observe\n```\n\n\
                    | a | b |\n|---|---|\n| one | two | [verified 2026-09-15]\n\n\
                    > quoted note [verified 2026-09-15]\n\
                    - a fact with no stamp\n";
        let report = validate_site_md(text, &[]);
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(report.errors[0].contains("a fact with no stamp"));
    }

    /// M10: a blockquote asserts something about the site too, so quoting a
    /// claim must not exempt it.
    #[test]
    fn blockquotes_still_need_a_stamp() {
        let report = validate_site_md("> submit is at the bottom\n", &[]);
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(report.errors[0].contains("submit is at the bottom"));
        assert!(validate_site_md("> submit is at the bottom [verified 2026-09-15]\n", &[]).is_ok());
    }

    /// M10: indenting a claim must not exempt it — only a continuation of a
    /// line that already carried a stamp is exempt.
    #[test]
    fn indented_lines_only_continue_a_stamped_fact() {
        let continuation = "a fact [verified 2026-09-15]\n  and its continuation\n";
        assert!(validate_site_md(continuation, &[]).is_ok());

        let smuggled = "# Heading\n\n  an indented claim with no stamp\n";
        let report = validate_site_md(smuggled, &[]);
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(report.errors[0].contains("an indented claim"));
    }

    /// A markdown list item wrapped over several lines is one fact carrying
    /// one stamp. Validating line-by-line used to make that impossible to write.
    #[test]
    fn a_wrapped_list_item_is_one_fact() {
        let wrapped = "- the search box is in the header, and submitting it\n                         jumps straight to the article [verified 2026-09-15]\n";
        assert!(
            validate_site_md(wrapped, &[]).is_ok(),
            "{:?}",
            validate_site_md(wrapped, &[])
        );

        let stamped_on_the_first_line = "- the search box is in the header [verified 2026-09-15]\n                                           and submitting it jumps to the article\n";
        assert!(validate_site_md(stamped_on_the_first_line, &[]).is_ok());
    }

    /// Folding must not become an escape hatch: a wrapped fact with no stamp
    /// anywhere still fails, and it is reported once, on the line it starts on.
    #[test]
    fn a_wrapped_fact_without_a_stamp_fails_once() {
        let report = validate_site_md(
            "# Heading\n\n- the search box is in the header\n  and submitting it jumps\n",
            &[],
        );
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(
            report.errors[0].contains("SITE.md line 3"),
            "{:?}",
            report.errors
        );
        assert!(
            report.errors[0].contains("keep each fact on one line or indent continuation lines"),
            "{:?}",
            report.errors
        );
        assert!(
            report.errors[0].contains("and submitting it jumps"),
            "{:?}",
            report.errors
        );
    }

    /// Two separate list items stay two separate facts.
    #[test]
    fn sibling_list_items_are_judged_separately() {
        let report = validate_site_md(
            "- first fact [verified 2026-09-15]\n- second fact with no stamp\n",
            &[],
        );
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
        assert!(
            report.errors[0].contains("second fact"),
            "{:?}",
            report.errors
        );
    }

    /// M10: an unclosed fence used to swallow the rest of the file.
    #[test]
    fn an_unclosed_code_fence_is_an_error() {
        let report = validate_site_md("```sh\nbsk observe\na fact with no stamp\n", &[]);
        assert!(
            report.errors.iter().any(|e| e.contains("unclosed")),
            "{:?}",
            report.errors
        );
    }

    /// H4: SITE.md is free text an agent writes; it must not carry secrets.
    #[test]
    fn site_md_refuses_credential_material() {
        let report = validate_site_md(
            "send Authorization: Bearer abc123def456 [verified 2026-09-15]\n",
            &[],
        );
        assert!(
            report.errors.iter().any(|e| e.contains("bearer token")),
            "{:?}",
            report.errors
        );
    }

    #[test]
    fn references_are_size_capped_and_secret_scanned() {
        assert!(validate_reference("checkout", "plain prose").is_ok());

        let secret = validate_reference("checkout", "cookie=session_id=abc");
        assert!(
            secret.errors.iter().any(|e| e.contains("cookie")),
            "{:?}",
            secret.errors
        );

        let huge = "x".repeat(REFERENCE_MAX_BYTES + 1);
        let big = validate_reference("dump", &huge);
        assert!(
            big.errors.iter().any(|e| e.contains("over the")),
            "{:?}",
            big.errors
        );
    }

    #[test]
    fn site_md_rejects_bad_and_future_verified_dates() {
        let report = validate_site_md("a fact [verified 2026-13-40]\n", &[]);
        assert!(
            report.errors[0].contains("not a YYYY-MM-DD"),
            "{:?}",
            report
        );

        let report = validate_site_md("a fact [verified 2099-01-01]\n", &[]);
        assert!(report.errors[0].contains("future"), "{:?}", report);
    }

    #[test]
    fn site_md_line_budget_warns_then_rejects() {
        let line = "a fact [verified 2026-09-15]\n";
        let under = line.repeat(SITE_MD_SOFT_LINE_BUDGET);
        assert!(validate_site_md(&under, &[]).is_ok());
        assert!(validate_site_md(&under, &[]).warnings.is_empty());

        let soft = line.repeat(SITE_MD_SOFT_LINE_BUDGET + 1);
        let report = validate_site_md(&soft, &[]);
        assert!(report.is_ok());
        assert_eq!(report.warnings.len(), 1);

        let hard = line.repeat(SITE_MD_HARD_LINE_BUDGET + 1);
        let report = validate_site_md(&hard, &[]);
        assert!(!report.is_ok());
        assert!(report.errors[0].contains("references/<name>.md"));
    }

    #[test]
    fn site_md_reference_pointers_must_resolve() {
        let text = "See [detail](references/checkout.md) [verified 2026-09-15]\n";
        assert!(validate_site_md(text, &["checkout".to_string()]).is_ok());
        let report = validate_site_md(text, &[]);
        assert!(report.errors[0].contains("does not exist"), "{:?}", report);
    }

    #[test]
    fn workflow_rejects_refs_anywhere_in_the_document() {
        let wf = workflow(vec![step(1, StepOp::Click)], Vec::new());
        let mut raw = serde_json::to_value(&wf).unwrap();
        raw["steps"][0]["target"]["ref"] = serde_json::json!("e12");
        let report = validate_workflow(&wf, &raw, "corp.example");
        assert!(
            report.errors[0].contains("record-local element ref"),
            "{report:?}"
        );
    }

    #[test]
    fn workflow_rejects_non_ui_only_and_stored_values() {
        let mut wf = workflow(vec![step(1, StepOp::Click)], Vec::new());
        wf.secrets_policy.store_values = true;
        let report = check(&wf);
        assert!(report.errors.iter().any(|e| e.contains("storeValues")));
    }

    #[test]
    fn workflow_requires_dense_numbering_and_declared_parameters() {
        let mut fill = step(2, StepOp::Fill);
        fill.value_from = Some("title".into());
        let wf = workflow(vec![step(1, StepOp::Click), fill], Vec::new());
        let report = check(&wf);
        assert!(
            report
                .errors
                .iter()
                .any(|e| e.contains("not a declared parameter"))
        );

        let mut misnumbered =
            workflow(vec![step(1, StepOp::Click), step(3, StepOp::Click)], vec![]);
        misnumbered.steps[1].n = 3;
        let report = check(&misnumbered);
        assert!(report.errors.iter().any(|e| e.contains("expected 2")));
    }

    #[test]
    fn workflow_requires_op_specific_fields() {
        let wf = workflow(vec![step(1, StepOp::Navigate)], Vec::new());
        assert!(
            check(&wf)
                .errors
                .iter()
                .any(|e| e.contains("requires `to`"))
        );

        let mut nav = step(1, StepOp::Navigate);
        nav.to = Some("ftp://corp.example".into());
        let wf = workflow(vec![nav], Vec::new());
        assert!(check(&wf).errors.iter().any(|e| e.contains("http(s) URL")));

        let wf = workflow(vec![step(1, StepOp::Fill)], Vec::new());
        assert!(
            check(&wf)
                .errors
                .iter()
                .any(|e| e.contains("`value` or `valueFrom`"))
        );

        let wf = workflow(vec![step(1, StepOp::Press)], Vec::new());
        assert!(
            check(&wf)
                .errors
                .iter()
                .any(|e| e.contains("requires `key`"))
        );
    }

    #[test]
    fn anchorless_step_must_be_flagged_for_review() {
        let mut anchorless = step(1, StepOp::Click);
        anchorless.target = None;
        let wf = workflow(vec![anchorless.clone()], Vec::new());
        assert!(check(&wf).errors.iter().any(|e| e.contains("needsReview")));

        anchorless.needs_review = true;
        let wf = workflow(vec![anchorless], Vec::new());
        assert!(check(&wf).is_ok());
    }

    fn candidate(id: &str, date: &str, kind: CandidateKind, claim: &str) -> Candidate {
        Candidate {
            id: id.into(),
            host: "corp.example".into(),
            observed_date_utc: date.into(),
            kind,
            claim: claim.into(),
            evidence: None,
            consequence: None,
            status: CandidateStatus::Pending,
            workflow_id: None,
        }
    }

    #[test]
    fn ordinary_candidates_need_two_distinct_days() {
        let one = candidate(
            "c1",
            "2026-09-15",
            CandidateKind::BetterPath,
            "Use the P2 dropdown",
        );
        assert!(check_corroboration(&one, std::slice::from_ref(&one)).is_err());

        let same_day = candidate(
            "c2",
            "2026-09-15",
            CandidateKind::BetterPath,
            "use the p2 dropdown",
        );
        assert!(check_corroboration(&one, &[one.clone(), same_day]).is_err());

        let other_day = candidate(
            "c3",
            "2026-09-16",
            CandidateKind::BetterPath,
            "use the  P2 DROPDOWN",
        );
        assert!(check_corroboration(&one, &[one.clone(), other_day]).is_ok());
    }

    #[test]
    fn high_consequence_candidates_skip_corroboration() {
        let one = candidate(
            "c1",
            "2026-09-15",
            CandidateKind::HighConsequence,
            "deletes silently",
        );
        assert!(check_corroboration(&one, std::slice::from_ref(&one)).is_ok());
    }

    #[test]
    fn rejected_candidates_do_not_corroborate() {
        let one = candidate("c1", "2026-09-15", CandidateKind::Access, "needs VPN");
        let mut rejected = candidate("c2", "2026-09-16", CandidateKind::Access, "needs VPN");
        rejected.status = CandidateStatus::Rejected;
        assert!(check_corroboration(&one, &[one.clone(), rejected]).is_err());
    }
}
