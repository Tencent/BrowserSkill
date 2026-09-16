//! Output shapes for `bsk site`.
//!
//! Human and `--json` renderings are built from the same payload structs so
//! the two never drift, following the split in `crates/bsk-cli/src/cli/network.rs`.

use serde::Serialize;

use super::model::{
    Candidate, STALE_AFTER_DAYS, Workflow, WorkflowStep, WorkflowStrategy, today_utc,
};

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowIndexEntry {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_verified: Option<String>,
    /// Verified once, but longer than `STALE_AFTER_DAYS` ago.
    pub stale: bool,
    /// Never verified against the live site. Distinct from `stale`: a workflow
    /// saved a minute ago is unverified, not out of date.
    pub unverified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days_since_verified: Option<i64>,
    pub needs_review: bool,
    pub steps: usize,
    /// True for a workflow that only exists in this task's draft. It is real
    /// and readable, but it is not part of active memory until a checkpoint,
    /// and the agent that just saved it would otherwise not see it listed.
    #[serde(skip_serializing_if = "is_false")]
    pub draft: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl WorkflowIndexEntry {
    pub fn from_workflow(workflow: &Workflow) -> Self {
        Self {
            id: workflow.id.clone(),
            purpose: workflow.purpose.clone(),
            last_verified: workflow.last_verified.clone(),
            stale: workflow.is_stale(),
            unverified: workflow.is_unverified(),
            days_since_verified: workflow.days_since_verified(),
            needs_review: workflow.needs_review,
            steps: workflow.steps.len(),
            draft: false,
        }
    }

    /// Same entry, marked as staged rather than published.
    pub fn from_draft_workflow(workflow: &Workflow) -> Self {
        Self {
            draft: true,
            ..Self::from_workflow(workflow)
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInfo {
    pub path: String,
    pub task_id: String,
    pub base_revision: u64,
    pub read_only: bool,
    pub created: bool,
    /// True when this call re-seeded the draft from a newer published revision
    /// because another writer committed first. The staged prose is now theirs,
    /// not this task's: `hint` says what to do about it.
    #[serde(skip_serializing_if = "is_false")]
    pub rebased: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextOutput {
    pub host: String,
    pub revision: u64,
    pub read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_md: Option<String>,
    pub references: Vec<String>,
    pub workflows: Vec<WorkflowIndexEntry>,
    pub pending_candidates: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<DraftInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutput {
    pub id: String,
    pub host: String,
    pub path: String,
    pub steps: usize,
    pub dropped_steps: usize,
    pub params: Vec<String>,
    pub needs_review: bool,
    pub review_notes: Vec<String>,
    pub draft: DraftInfo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOutput {
    pub id: String,
    pub host: String,
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_verified: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    /// True when `--pass` also cleared `needsReview` on the workflow or a step.
    pub cleared_review: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateAddOutput {
    pub id: String,
    pub host: String,
    pub path: String,
    pub kind: &'static str,
    pub observed_date_utc: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CheckpointOutput {
    #[serde(rename = "committed")]
    Committed {
        revision: u64,
        host: String,
        reason: String,
        paths: Vec<String>,
        ingested: Vec<String>,
        rejected: Vec<String>,
        warnings: Vec<String>,
    },
    #[serde(rename = "conflict")]
    Conflict { expected: u64, actual: u64 },
}

// ---------------------------------------------------------------------------
// Human rendering
// ---------------------------------------------------------------------------

pub fn print_context(out: &ContextOutput) {
    println!("host: {}  revision: {}", out.host, out.revision);
    if out.read_only {
        println!(
            "read-only: this host could not be normalised, so drafts cannot be promoted into \
             active memory"
        );
    }
    match &out.site_md {
        Some(text) if !text.trim().is_empty() => {
            println!("\n--- SITE.md ---");
            print!("{text}");
            if !text.ends_with('\n') {
                println!();
            }
            println!("--- end SITE.md ---");
        }
        _ => println!("\nSITE.md: (empty — nothing has been learned about this host yet)"),
    }

    println!("\nreferences ({}):", out.references.len());
    if out.references.is_empty() {
        println!("  (none)");
    } else {
        for name in &out.references {
            println!("  references/{name}.md");
        }
    }

    println!("\nworkflows ({}):", out.workflows.len());
    if out.workflows.is_empty() {
        println!("  (none)");
    } else {
        for entry in &out.workflows {
            println!("  {}", render_index_entry(entry));
        }
    }

    println!("\npending candidates: {}", out.pending_candidates);
    match &out.draft {
        Some(draft) => {
            println!(
                "draft: {} (task {}, base revision {}{})",
                draft.path,
                draft.task_id,
                draft.base_revision,
                if draft.created { ", created now" } else { "" }
            );
            if let Some(hint) = &draft.hint {
                println!("  {hint}");
            }
        }
        None => println!("draft: (none — pass --task <id> to stage edits)"),
    }
}

pub fn render_index_entry(entry: &WorkflowIndexEntry) -> String {
    let verified = match (&entry.last_verified, entry.days_since_verified) {
        (Some(date), Some(days)) => format!("verified {date} ({days}d ago)"),
        (Some(date), None) => format!("verified {date}"),
        _ => "never verified".to_string(),
    };
    let mut flags = Vec::new();
    if entry.draft {
        flags.push("DRAFT");
    }
    if entry.stale {
        flags.push("STALE");
    } else if entry.unverified {
        // Not the same claim as STALE: nothing here has expired, it has simply
        // never been run back. Say so, so the agent still trusts what it saved.
        flags.push("UNVERIFIED");
    }
    if entry.needs_review {
        flags.push("NEEDS REVIEW");
    }
    let suffix = if flags.is_empty() {
        String::new()
    } else {
        format!("  [{}]", flags.join(", "))
    };
    format!(
        "{}  {} steps, {verified}{suffix}{}",
        entry.id,
        entry.steps,
        entry
            .purpose
            .as_deref()
            .map(|p| format!("\n      purpose: {p}"))
            .unwrap_or_default()
    )
}

pub fn print_workflow(workflow: &Workflow) {
    println!("workflow: {}", workflow.id);
    println!("host: {}", workflow.host);
    if let Some(purpose) = &workflow.purpose {
        println!("purpose: {purpose}");
    }
    println!(
        "strategy: {}",
        match workflow.strategy {
            WorkflowStrategy::UiOnly => "ui-only (replay by observe/act only)",
        }
    );
    match (&workflow.last_verified, workflow.days_since_verified()) {
        (Some(date), Some(days)) => {
            println!("last verified: {date} ({days} days ago)");
            if days > STALE_AFTER_DAYS {
                println!(
                    "warning: unverified for more than {STALE_AFTER_DAYS} days. Confirm each step \
                     against the live page, then run `bsk site workflow verify {} --host {} \
                     --pass`.",
                    workflow.id, workflow.host
                );
            }
        }
        _ => println!(
            "last verified: never — treat every step as unconfirmed (today is {})",
            today_utc()
        ),
    }

    if !workflow.params.is_empty() {
        println!("\nparameters:");
        for param in &workflow.params {
            let mut tags = Vec::new();
            if param.required {
                tags.push("required".to_string());
            }
            if param.secret {
                tags.push("secret, never stored".to_string());
            }
            if let Some(values) = &param.enum_values {
                tags.push(format!("one of {}", values.join(" | ")));
            }
            println!(
                "  {}{}{}",
                param.name,
                if tags.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", tags.join("; "))
                },
                param
                    .description
                    .as_deref()
                    .map(|d| format!("\n      {d}"))
                    .unwrap_or_default()
            );
        }
    }

    if !workflow.preconditions.is_empty() {
        println!("\npreconditions:");
        for pre in &workflow.preconditions {
            let detail = pre
                .value
                .as_deref()
                .or(pre.evidence.as_deref())
                .map(|d| format!(": {d}"))
                .unwrap_or_default();
            println!("  {}{detail}", pre.kind);
        }
    }

    println!("\nsteps:");
    for step in &workflow.steps {
        println!("{}", render_step(step));
    }

    if let Some(post) = &workflow.postcondition {
        println!("\npostcondition ({}):", post.kind);
        for expect in &post.expect {
            let mut parts = Vec::new();
            if let Some(role) = &expect.role {
                parts.push(format!("role={role}"));
            }
            if let Some(name) = &expect.name {
                parts.push(format!("name={name:?}"));
            }
            if let Some(pattern) = &expect.name_pattern {
                parts.push(format!("namePattern={pattern:?}"));
            }
            println!("  {}", parts.join(" "));
        }
    }

    if !workflow.review_notes.is_empty() {
        println!("\nreview notes:");
        for note in &workflow.review_notes {
            println!("  - {note}");
        }
    }
    if workflow.needs_review {
        println!(
            "\nThis workflow still needs review. Confirm the flagged steps against the live page \
             before relying on them."
        );
    }
}

pub fn render_step(step: &WorkflowStep) -> String {
    let mut line = format!("  {}. {}", step.n, step.op.as_str());
    if let Some(to) = &step.to {
        line.push_str(&format!(" {to}"));
    }
    match &step.target {
        Some(target) => line.push_str(&format!(" {}", target.describe())),
        None if !matches!(step.op, super::model::StepOp::Navigate) => {
            line.push_str(" (no anchor)");
        }
        None => {}
    }
    if let Some(key) = &step.key {
        line.push_str(&format!(" key={key}"));
        if let Some(modifiers) = &step.modifiers {
            line.push_str(&format!(" modifiers={}", modifiers.join("+")));
        }
    }
    if let Some(from) = &step.value_from {
        line.push_str(&format!(" <- ${from}"));
    } else if let Some(value) = &step.value {
        line.push_str(&format!(" = {value:?}"));
    }
    if let Some(commit) = &step.commit {
        line.push_str(&format!(" (commit: {commit})"));
    }
    if step.needs_review {
        line.push_str("  [needs review]");
    }
    if let Some(note) = &step.note {
        line.push_str(&format!("\n      note: {note}"));
    }
    line
}

pub fn print_candidate(candidate: &Candidate) {
    println!("candidate: {}", candidate.id);
    println!("host: {}", candidate.host);
    println!("kind: {}", candidate.kind.as_str());
    println!("status: {}", candidate.status.as_str());
    println!("observed (UTC): {}", candidate.observed_date_utc);
    if let Some(id) = &candidate.workflow_id {
        println!("workflow: {id}");
    }
    println!("claim: {}", candidate.claim);
    if let Some(evidence) = &candidate.evidence {
        println!("evidence: {evidence}");
    }
    if let Some(consequence) = &candidate.consequence {
        println!("consequence: {consequence}");
    }
}

pub fn render_candidate_line(candidate: &Candidate) -> String {
    format!(
        "{}  [{}] {} {}  {}",
        candidate.id,
        candidate.status.as_str(),
        candidate.kind.as_str(),
        candidate.observed_date_utc,
        candidate.claim
    )
}

pub fn print_checkpoint(out: &CheckpointOutput) {
    match out {
        CheckpointOutput::Committed {
            revision,
            host,
            reason,
            paths,
            ingested,
            rejected,
            warnings,
        } => {
            println!("committed {host} at revision {revision} ({reason})");
            for path in paths {
                println!("  {path}");
            }
            if !ingested.is_empty() {
                println!("ingested candidates: {}", ingested.join(", "));
            }
            if !rejected.is_empty() {
                println!("rejected candidates: {}", rejected.join(", "));
            }
            for warning in warnings {
                eprintln!("warning: {warning}");
            }
        }
        CheckpointOutput::Conflict { expected, actual } => {
            eprintln!(
                "conflict: expected revision {expected}, active memory is at {actual}. Another \
                 writer committed first. Re-run `bsk site context` with the same --task: it \
                 re-seeds the draft's SITE.md and references from revision {actual}, so your own \
                 edits are gone from the draft and must be replayed on top before you checkpoint \
                 again."
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::model::{StepOp, StepTarget, WorkflowStep};
    use super::*;

    fn step() -> WorkflowStep {
        WorkflowStep {
            n: 2,
            op: StepOp::Fill,
            to: None,
            target: Some(StepTarget {
                role: Some("textbox".into()),
                name: Some("标题".into()),
                ctx: Some("工单信息".into()),
            }),
            value: None,
            value_from: Some("title".into()),
            commit: Some("blur".into()),
            key: None,
            modifiers: None,
            note: None,
            needs_review: false,
        }
    }

    #[test]
    fn step_renders_anchor_parameter_and_commit() {
        let line = render_step(&step());
        assert_eq!(
            line,
            "  2. fill role=textbox name=\"标题\" ctx=\"工单信息\" <- $title (commit: blur)"
        );
    }

    #[test]
    fn step_without_anchor_is_marked_for_review() {
        let mut step = step();
        step.target = None;
        step.needs_review = true;
        step.note = Some("supply an anchor".into());
        let line = render_step(&step);
        assert!(line.contains("(no anchor)"));
        assert!(line.contains("[needs review]"));
        assert!(line.contains("note: supply an anchor"));
    }

    #[test]
    fn navigate_step_does_not_claim_a_missing_anchor() {
        let mut step = step();
        step.op = StepOp::Navigate;
        step.target = None;
        step.value_from = None;
        step.commit = None;
        step.to = Some("https://corp.example/new".into());
        assert_eq!(render_step(&step), "  2. navigate https://corp.example/new");
    }

    #[test]
    fn index_entry_flags_stale_and_review() {
        let entry = WorkflowIndexEntry {
            id: "submit-ticket".into(),
            purpose: None,
            last_verified: Some("2026-01-01".into()),
            stale: true,
            unverified: false,
            days_since_verified: Some(90),
            needs_review: true,
            steps: 4,
            draft: false,
        };
        let line = render_index_entry(&entry);
        assert!(line.contains("STALE"));
        assert!(!line.contains("UNVERIFIED"), "{line}");
        assert!(line.contains("NEEDS REVIEW"));
        assert!(line.contains("90d ago"));
    }

    /// A workflow saved a minute ago has not expired — calling it STALE told
    /// the agent to distrust the memory it had just written.
    #[test]
    fn a_never_verified_entry_reads_unverified_not_stale() {
        let entry = WorkflowIndexEntry {
            id: "submit-ticket".into(),
            purpose: None,
            last_verified: None,
            stale: false,
            unverified: true,
            days_since_verified: None,
            needs_review: false,
            steps: 4,
            draft: false,
        };
        let line = render_index_entry(&entry);
        assert!(line.contains("UNVERIFIED"), "{line}");
        assert!(!line.contains("STALE"), "{line}");
        assert!(line.contains("never verified"), "{line}");
    }

    /// Once it is verified and the review is cleared, nothing is flagged.
    #[test]
    fn a_verified_reviewed_entry_carries_no_flags() {
        let entry = WorkflowIndexEntry {
            id: "submit-ticket".into(),
            purpose: None,
            last_verified: Some(today_utc()),
            stale: false,
            unverified: false,
            days_since_verified: Some(0),
            needs_review: false,
            steps: 4,
            draft: false,
        };
        let line = render_index_entry(&entry);
        assert!(!line.contains('['), "{line}");
    }

    #[test]
    fn checkpoint_conflict_serialises_the_documented_shape() {
        let json = serde_json::to_value(CheckpointOutput::Conflict {
            expected: 3,
            actual: 5,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "status": "conflict", "expected": 3, "actual": 5 })
        );
    }
}
