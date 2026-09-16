//! `bsk site` — local, per-host memory distilled from recordings.
//!
//! Site memory turns one human exploration into an asset the next agent can
//! read: a constrained `SITE.md`, structured workflows derived from a recorded
//! `trace.json`, and append-only candidate observations. Design §4.
//!
//! Every command in this family is pure local file I/O under
//! `$BSK_HOME/sites`. None of them starts or needs the daemon, so they work
//! unchanged in a sandbox running with `BSK_AUTO_START=0`.
//!
//! Three disciplines the agent-facing skill repeats, enforced here:
//!
//! - **Read before acting.** `bsk site context` is the first call of a task.
//! - **Never explore to learn.** Memory records what a task already revealed.
//! - **Learning never fails the task.** These commands are advisory; a failure
//!   is reported and the task continues.

pub mod checkpoint;
pub mod derive;
pub mod model;
pub mod render;
pub mod store;
pub mod trace_input;
pub mod validate;

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Args, Subcommand};

use crate::cli::error::{CliError, Format};

use model::{
    Candidate, CandidateKind, CandidateStatus, CheckpointReason, StepOp, Workflow, today_utc,
};
use render::{
    CandidateAddOutput, CheckpointOutput, ContextOutput, DraftInfo, SaveOutput, VerifyOutput,
    WorkflowIndexEntry,
};
use store::{Draft, HostKey, SiteStore};

// ---------------------------------------------------------------------------
// Command tree
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Args)]
pub struct SiteCmd {
    #[command(subcommand)]
    pub sub: SiteSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum SiteSub {
    /// Read everything known about a host: SITE.md, references, workflows,
    /// pending candidates and the current revision. Call this first.
    Context(ContextArgs),

    /// Inspect and record reusable workflows.
    Workflow(WorkflowCmd),

    /// Record and read candidate observations.
    Candidate(CandidateCmd),

    /// Promote a task's draft into active memory.
    Checkpoint(CheckpointArgs),
}

#[derive(Debug, Clone, Args)]
pub struct ContextArgs {
    /// Site host, e.g. `ticket.corp.example`. A full URL is accepted.
    #[arg(long)]
    pub host: String,

    /// Task id. Supplying it stages a draft so edits stay isolated per task.
    #[arg(long)]
    pub task: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct WorkflowCmd {
    #[command(subcommand)]
    pub sub: WorkflowSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum WorkflowSub {
    /// Derive a workflow draft from a recorded `trace.json`.
    Save(WorkflowSaveArgs),
    /// List stored workflows with their verification age.
    List(WorkflowListArgs),
    /// Print one workflow as numbered steps, or as JSON with `--json`.
    Show(WorkflowShowArgs),
    /// Record a pass/fail assertion against a stored workflow.
    Verify(WorkflowVerifyArgs),
}

#[derive(Debug, Clone, Args)]
pub struct WorkflowSaveArgs {
    /// Path to a `trace.json` produced by `bsk record start --output <dir>`.
    #[arg(long = "from")]
    pub from: PathBuf,

    /// Workflow id: lowercase letters, digits, `-` and `_`.
    #[arg(long)]
    pub id: String,

    /// Host to file the workflow under. Inferred from the trace when omitted.
    #[arg(long)]
    pub host: Option<String>,

    /// One line describing what the workflow accomplishes.
    #[arg(long)]
    pub purpose: Option<String>,

    /// Task id owning the draft. Defaults to the workflow id.
    #[arg(long)]
    pub task: Option<String>,

    /// Keep recorded field values as constants instead of turning them into
    /// parameters. Use only when the values belong to the flow rather than to
    /// whoever recorded it; values that look like credentials, email addresses
    /// or identifiers stay parameters regardless.
    #[arg(long = "inline-values")]
    pub inline_values: bool,
}

#[derive(Debug, Clone, Args)]
pub struct WorkflowListArgs {
    /// Restrict to one host. Omit to list every host with stored workflows.
    #[arg(long)]
    pub host: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct WorkflowShowArgs {
    /// Workflow id.
    pub id: String,

    /// Site host.
    #[arg(long)]
    pub host: String,
}

#[derive(Debug, Clone, Args)]
#[command(group(
    clap::ArgGroup::new("outcome").required(true).args(["pass", "fail"])
))]
pub struct WorkflowVerifyArgs {
    /// Workflow id.
    pub id: String,

    /// Site host.
    #[arg(long)]
    pub host: String,

    /// The workflow reproduced the flow: refresh `lastVerified` to today.
    #[arg(long)]
    pub pass: bool,

    /// The workflow did not reproduce the flow: record a candidate. The
    /// workflow itself is left untouched — one failure is not evidence.
    #[arg(long)]
    pub fail: bool,

    /// What went wrong. Required with `--fail`.
    #[arg(long)]
    pub note: Option<String>,

    /// Candidate kind recorded for a failure.
    #[arg(long, default_value = "repeated_mistake")]
    pub kind: CandidateKind,
}

#[derive(Debug, Clone, Args)]
pub struct CandidateCmd {
    #[command(subcommand)]
    pub sub: CandidateSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum CandidateSub {
    /// Record one observation. Written to active memory immediately.
    Add(CandidateAddArgs),
    /// List recorded observations.
    List(CandidateListArgs),
    /// Print one observation.
    Show(CandidateShowArgs),
}

#[derive(Debug, Clone, Args)]
pub struct CandidateAddArgs {
    /// Site host.
    #[arg(long)]
    pub host: String,

    /// What kind of observation this is.
    #[arg(long)]
    pub kind: CandidateKind,

    /// The claim, in one sentence.
    #[arg(long)]
    pub claim: String,

    /// What was observed that supports the claim.
    #[arg(long)]
    pub evidence: Option<String>,

    /// What happens if the claim is ignored.
    #[arg(long)]
    pub consequence: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct CandidateListArgs {
    /// Site host.
    #[arg(long)]
    pub host: String,

    /// Restrict to one kind.
    #[arg(long)]
    pub kind: Option<CandidateKind>,

    /// Restrict to one status.
    #[arg(long)]
    pub status: Option<CandidateStatus>,
}

#[derive(Debug, Clone, Args)]
pub struct CandidateShowArgs {
    /// Candidate id.
    pub id: String,

    /// Site host.
    #[arg(long)]
    pub host: String,
}

#[derive(Debug, Clone, Args)]
pub struct CheckpointArgs {
    /// Site host.
    #[arg(long)]
    pub host: String,

    /// Task id whose draft is being promoted.
    #[arg(long)]
    pub task: String,

    /// Why memory is changing.
    #[arg(long)]
    pub reason: CheckpointReason,

    /// Revision this edit was based on. Defaults to the draft's base revision.
    #[arg(long = "expected-revision")]
    pub expected_revision: Option<u64>,

    /// Candidate to promote. Repeatable.
    #[arg(long = "ingest")]
    pub ingest: Vec<String>,

    /// Candidate to dismiss. Repeatable.
    #[arg(long = "reject")]
    pub reject: Vec<String>,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

pub fn dispatch(cmd: SiteCmd, format: Format) -> Result<(), CliError> {
    match cmd.sub {
        SiteSub::Context(args) => run(|store| context(store, &args, format)),
        SiteSub::Workflow(cmd) => match cmd.sub {
            WorkflowSub::Save(args) => run(|store| workflow_save(store, &args, format)),
            WorkflowSub::List(args) => run(|store| workflow_list(store, &args, format)),
            WorkflowSub::Show(args) => run(|store| workflow_show(store, &args, format)),
            WorkflowSub::Verify(args) => run(|store| workflow_verify(store, &args, format)),
        },
        SiteSub::Candidate(cmd) => match cmd.sub {
            CandidateSub::Add(args) => run(|store| candidate_add(store, &args, format)),
            CandidateSub::List(args) => run(|store| candidate_list(store, &args, format)),
            CandidateSub::Show(args) => run(|store| candidate_show(store, &args, format)),
        },
        SiteSub::Checkpoint(args) => run(|store| checkpoint_cmd(store, &args, format)),
    }
}

/// Open the store and run one command, funnelling every failure through the
/// same renderer so `--json` callers always get a parseable body.
fn run(body: impl FnOnce(&SiteStore) -> Result<Outcome>) -> Result<(), CliError> {
    let store = match SiteStore::open() {
        Ok(store) => store,
        Err(err) => return Err(fail(format!("{err:#}"))),
    };
    match body(&store) {
        Ok(Outcome::Done) => Ok(()),
        Ok(Outcome::Unsuccessful) => Err(CliError::RenderedExit { exit_code: 1 }),
        Err(err) => Err(fail(format!("{err:#}"))),
    }
}

/// Whether a command that already printed its result should exit non-zero.
enum Outcome {
    Done,
    /// The command ran and reported a negative answer (a conflict, a missing
    /// workflow). Output is already rendered.
    Unsuccessful,
}

/// Render a site-memory failure through the CLI's standard error path.
///
/// Routing through [`CliError::Rpc`] keeps `--json` consumers on the one
/// documented envelope (`{code, message, hint, exit_code, data}`) instead of a
/// second bespoke shape. `invalid_params` is the honest code: every failure
/// here is the caller asking for something the rules do not allow.
fn fail(message: String) -> CliError {
    CliError::Rpc {
        code: bsk_protocol::ErrorCode::InvalidParams,
        message,
        data: Some(serde_json::json!({ "reason": "site_memory" })),
        source: None,
    }
}

fn emit<T: serde::Serialize>(value: &T) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).context("encode JSON output")?
    );
    Ok(())
}

fn draft_info(draft: &Draft) -> DraftInfo {
    DraftInfo {
        path: draft.dir.display().to_string(),
        task_id: draft.context.task_id.clone(),
        base_revision: draft.context.base_revision,
        read_only: draft.context.read_only,
        created: draft.created,
        rebased: draft.rebased,
        hint: draft.rebased.then(|| {
            format!(
                "draft SITE.md re-seeded from revision {}; replay your edits before checkpoint",
                draft.context.base_revision
            )
        }),
    }
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

fn context(store: &SiteStore, args: &ContextArgs, format: Format) -> Result<Outcome> {
    let host = store::normalize_host(&args.host);
    store::guard_host(&host)?;
    let active = store.host_dir(&host)?;

    // One lock around the whole read: the reported revision, the files read and
    // the draft's base revision must all come from the same moment, or the
    // agent checkpoints against a number that was stale when it was printed.
    let _lock = store.lock()?;
    let revision = store.revision(&host)?;
    let draft = match &args.task {
        Some(task) => {
            let draft = store::ensure_draft(store, task, &host)?;
            // Rebase an existing draft onto the revision being reported. This
            // is the recovery step a conflict tells the agent to perform, and
            // it re-seeds the staged prose from what is actually published.
            Some(store::rebase_draft(store, &host, draft, revision)?)
        }
        None => None,
    };

    let (workflows, mut problems) =
        store::load_workflows(&store::sub(&active, store::WORKFLOWS_DIR)?)?;
    let (candidates, candidate_problems) =
        store::load_candidates(&store::sub(&active, store::CANDIDATES_DIR)?)?;
    problems.extend(candidate_problems);

    // A workflow saved this task but not yet checkpointed is real and usable;
    // omitting it made `workflow save` followed by `context` report zero
    // workflows, which reads as "the save did nothing".
    let mut index: Vec<WorkflowIndexEntry> = workflows
        .iter()
        .map(WorkflowIndexEntry::from_workflow)
        .collect();
    if let Some(draft) = &draft {
        let (staged, staged_problems) =
            store::load_workflows(&store::sub(&draft.dir, store::WORKFLOWS_DIR)?)?;
        problems.extend(staged_problems);
        for workflow in &staged {
            if !workflows.iter().any(|active| active.id == workflow.id) {
                index.push(WorkflowIndexEntry::from_draft_workflow(workflow));
            }
        }
        index.sort_by(|a, b| a.id.cmp(&b.id));
    }

    let out = ContextOutput {
        host: host.display.clone(),
        revision,
        read_only: host.read_only,
        site_md: store::read_optional(&store::sub(&active, store::SITE_MD)?)?,
        references: store::list_stems(&store::sub(&active, store::REFERENCES_DIR)?, "md")?,
        workflows: index,
        pending_candidates: candidates
            .iter()
            .filter(|c| c.status == CandidateStatus::Pending)
            .count(),
        draft: draft.as_ref().map(draft_info),
    };

    match format {
        Format::Json => emit(&out)?,
        Format::Human => render::print_context(&out),
    }
    for problem in problems {
        eprintln!("warning: unreadable site-memory file — {problem}");
    }
    Ok(Outcome::Done)
}

// ---------------------------------------------------------------------------
// workflow save
// ---------------------------------------------------------------------------

fn workflow_save(store: &SiteStore, args: &WorkflowSaveArgs, format: Format) -> Result<Outcome> {
    store::validate_id(&args.id, "workflow")?;
    let trace = trace_input::read_trace_v3(&args.from)?;

    let raw_host = match &args.host {
        Some(host) => host.clone(),
        None => derive::infer_host(&trace).context(
            "could not infer a host from the trace: it has no navigate step and no entry URL. \
             Pass --host explicitly.",
        )?,
    };
    let host = store::normalize_host(&raw_host);
    store::guard_host(&host)?;
    // `--host` is a label for the directory, not a licence to refile a
    // recording: a trace captured on an SSO domain must not be saved under an
    // innocuous host. Compare against what the recording actually visited.
    if let Some(recorded) = derive::infer_host(&trace) {
        let recorded = store::normalize_host(&recorded);
        store::guard_host(&recorded)?;
        if recorded.dir != host.dir {
            anyhow::bail!(
                "the recording starts on {} but --host says {}. Save it under the host it was \
                 recorded on, or re-record on the intended site.",
                recorded.display,
                host.display
            );
        }
    }

    let policy = if args.inline_values {
        derive::ValuePolicy::Inline
    } else {
        derive::ValuePolicy::Parameterise
    };
    let derived = derive::derive_workflow(
        &trace,
        &args.id,
        &host.display,
        args.purpose.as_deref(),
        policy,
    );
    let raw = serde_json::to_value(&derived.workflow).context("encode derived workflow")?;
    let report = validate::validate_workflow(&derived.workflow, &raw, &host.display);
    if !report.is_ok() {
        anyhow::bail!(
            "the derived workflow is not valid:\n  - {}",
            report.errors.join("\n  - ")
        );
    }

    let task = args.task.clone().unwrap_or_else(|| args.id.clone());
    let _lock = store.lock()?;
    let draft = store::ensure_draft(store, &task, &host)?;
    let name = format!("{}.json", args.id);
    let path = store::resolve_in(
        &store::sub(&draft.dir, store::WORKFLOWS_DIR)?,
        &[name.as_str()],
    )?;
    store::write_json(&path, &derived.workflow)?;

    let out = SaveOutput {
        id: args.id.clone(),
        host: host.display.clone(),
        path: path.display().to_string(),
        steps: derived.workflow.steps.len(),
        dropped_steps: derived.dropped_steps,
        params: derived
            .workflow
            .params
            .iter()
            .map(|p| p.name.clone())
            .collect(),
        needs_review: derived.workflow.needs_review,
        review_notes: derived.workflow.review_notes.clone(),
        draft: draft_info(&draft),
    };
    match format {
        Format::Json => emit(&out)?,
        Format::Human => print_save(&out),
    }
    for warning in report.warnings {
        eprintln!("warning: {warning}");
    }
    Ok(Outcome::Done)
}

fn print_save(out: &SaveOutput) {
    println!("saved workflow {} for {}", out.id, out.host);
    println!("  {}", out.path);
    println!(
        "  {} steps derived, {} dropped (scroll / tab switches are not semantic steps)",
        out.steps, out.dropped_steps
    );
    if out.params.is_empty() {
        println!("  parameters: (none)");
    } else {
        println!("  parameters: {}", out.params.join(", "));
    }
    for note in &out.review_notes {
        println!("  note: {note}");
    }
    if out.needs_review {
        println!(
            "\nThis is a draft and still needs review. Recorded values were turned into \
             parameters rather than stored, and every anchorless step is flagged. Edit {}, then \
             run `bsk site checkpoint --host {} --task {} --reason direct_correction`.",
            out.path, out.host, out.draft.task_id
        );
    } else {
        println!(
            "\nRun `bsk site checkpoint --host {} --task {} --reason direct_correction` to publish it.",
            out.host, out.draft.task_id
        );
    }
}

// ---------------------------------------------------------------------------
// workflow list / show
// ---------------------------------------------------------------------------

fn workflow_list(store: &SiteStore, args: &WorkflowListArgs, format: Format) -> Result<Outcome> {
    let hosts = match &args.host {
        Some(host) => {
            let host = store::normalize_host(host);
            store::guard_host(&host)?;
            vec![host]
        }
        None => all_hosts(store)?,
    };
    let mut rows = Vec::new();
    for host in &hosts {
        let dir = store::sub(&store.host_dir(host)?, store::WORKFLOWS_DIR)?;
        let (workflows, _) = store::load_workflows(&dir)?;
        for workflow in workflows {
            rows.push((
                host.display.clone(),
                WorkflowIndexEntry::from_workflow(&workflow),
            ));
        }
    }
    match format {
        Format::Json => {
            let body: Vec<serde_json::Value> = rows
                .iter()
                .map(|(host, entry)| {
                    let mut value = serde_json::to_value(entry).unwrap_or_default();
                    if let Some(map) = value.as_object_mut() {
                        map.insert("host".into(), serde_json::Value::String(host.clone()));
                    }
                    value
                })
                .collect();
            emit(&body)?;
        }
        Format::Human => {
            if rows.is_empty() {
                println!("(no workflows recorded yet)");
            }
            for (host, entry) in &rows {
                println!("{host}  {}", render::render_index_entry(entry));
            }
        }
    }
    Ok(Outcome::Done)
}

/// Every host directory under `sites/`, skipping dot-prefixed bookkeeping.
fn all_hosts(store: &SiteStore) -> Result<Vec<HostKey>> {
    let entries = match std::fs::read_dir(store.root()) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(
                anyhow::Error::from(err).context(format!("read {}", store.root().display()))
            );
        }
    };
    let mut hosts = Vec::new();
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        hosts.push(HostKey {
            display: name.clone(),
            dir: name,
            read_only: false,
        });
    }
    hosts.sort_by(|a, b| a.dir.cmp(&b.dir));
    Ok(hosts)
}

fn workflow_show(store: &SiteStore, args: &WorkflowShowArgs, format: Format) -> Result<Outcome> {
    let host = store::normalize_host(&args.host);
    store::guard_host(&host)?;
    let dir = store::sub(&store.host_dir(&host)?, store::WORKFLOWS_DIR)?;
    let Some(workflow) = store::load_workflow(&dir, &args.id)? else {
        return Err(anyhow::anyhow!(
            "no workflow {} on {}. Run `bsk site workflow list --host {}` to see what exists.",
            args.id,
            host.display,
            host.display
        ));
    };
    match format {
        Format::Json => emit(&workflow)?,
        Format::Human => render::print_workflow(&workflow),
    }
    Ok(Outcome::Done)
}

// ---------------------------------------------------------------------------
// workflow verify
// ---------------------------------------------------------------------------

fn workflow_verify(
    store: &SiteStore,
    args: &WorkflowVerifyArgs,
    format: Format,
) -> Result<Outcome> {
    let host = store::normalize_host(&args.host);
    store::guard_host(&host)?;
    if host.read_only {
        anyhow::bail!(
            "{} could not be normalised to a host directory, so it has no active memory to verify",
            args.host
        );
    }
    let _lock = store.lock()?;
    let active = store.host_dir(&host)?;
    let dir = store::sub(&active, store::WORKFLOWS_DIR)?;
    let Some(workflow) = store::load_workflow(&dir, &args.id)? else {
        return Err(anyhow::anyhow!(
            "no workflow {} on {}",
            args.id,
            host.display
        ));
    };

    let out = if args.pass {
        verify_pass(store, &host, &dir, workflow)?
    } else {
        verify_fail(store, &host, args)?
    };
    match format {
        Format::Json => emit(&out)?,
        Format::Human => print_verify(&out),
    }
    Ok(Outcome::Done)
}

fn verify_pass(
    store: &SiteStore,
    host: &HostKey,
    dir: &std::path::Path,
    mut workflow: Workflow,
) -> Result<VerifyOutput> {
    let today = today_utc();
    workflow.last_verified = Some(today.clone());
    // `--pass` means a human or an agent just ran this workflow end to end on
    // the live site. That *is* the review the derived flags were asking for, so
    // clearing them here is what stops a workflow containing a `fill` from
    // carrying NEEDS REVIEW forever. `--fail` leaves every flag alone.
    // An anchorless step stays flagged: a pass proves the flow works around
    // it, not that it can be replayed, and the validator refuses to publish
    // an unflagged anchorless step — clearing it would make the whole host's
    // next checkpoint fail.
    let mut cleared_review = workflow.needs_review;
    workflow.needs_review = false;
    for step in &mut workflow.steps {
        if step.needs_review && step.target.is_none() && !matches!(step.op, StepOp::Navigate) {
            continue;
        }
        cleared_review |= step.needs_review;
        step.needs_review = false;
    }
    let name = format!("{}.json", workflow.id);
    let path = store::resolve_in(dir, &[name.as_str()])?;

    // Refreshing `lastVerified` changes active memory, so it advances the CAS
    // token and lands in the journal like any other commit — and all three
    // writes move together, or none of them do.
    let revision = store.revision(host)? + 1;
    let entry = model::JournalEntry {
        revision,
        at: model::now_rfc3339(),
        host: host.display.clone(),
        task_id: None,
        reason: "workflow_verify_pass".to_string(),
        paths: vec![format!("{}/{}/{name}", host.dir, store::WORKFLOWS_DIR)],
        ingested: Vec::new(),
        rejected: Vec::new(),
    };
    let mut tx = store::Transaction::default();
    if let Err(err) = write_verify_pass(store, host, &mut tx, &path, &workflow, revision, &entry) {
        return match tx.rollback() {
            Ok(()) => Err(err.context("verify --pass failed; active memory was rolled back")),
            Err(rollback) => Err(err.context(format!(
                "verify --pass failed and rollback was incomplete ({rollback:#})"
            ))),
        };
    }
    Ok(VerifyOutput {
        id: workflow.id,
        host: host.display.clone(),
        outcome: "pass",
        last_verified: Some(today),
        candidate_id: None,
        revision: Some(revision),
        cleared_review,
    })
}

fn write_verify_pass(
    store: &SiteStore,
    host: &HostKey,
    tx: &mut store::Transaction,
    path: &std::path::Path,
    workflow: &Workflow,
    revision: u64,
    entry: &model::JournalEntry,
) -> Result<()> {
    tx.write_json(path, workflow)?;
    tx.write(
        &store.revision_path(host)?,
        format!("{revision}\n").as_bytes(),
    )?;
    let line = serde_json::to_string(entry).context("encode journal entry")?;
    tx.append_line(&store.journal_path(host)?, &line)
}

fn verify_fail(
    store: &SiteStore,
    host: &HostKey,
    args: &WorkflowVerifyArgs,
) -> Result<VerifyOutput> {
    let note = args.note.as_deref().unwrap_or_default().trim();
    if note.is_empty() {
        anyhow::bail!("--fail needs --note <text> describing what did not reproduce");
    }
    if !validate::is_failure_kind(args.kind) {
        anyhow::bail!(
            "--kind for a failure must be repeated_mistake or access, not {}",
            args.kind.as_str()
        );
    }
    let claim = format!("workflow {} did not reproduce: {note}", args.id);
    let candidate = write_candidate(
        store,
        host,
        args.kind,
        &claim,
        None,
        None,
        Some(args.id.clone()),
    )?;
    Ok(VerifyOutput {
        id: args.id.clone(),
        host: host.display.clone(),
        outcome: "fail",
        last_verified: None,
        candidate_id: Some(candidate.id),
        revision: None,
        cleared_review: false,
    })
}

fn print_verify(out: &VerifyOutput) {
    match out.outcome {
        "pass" => {
            println!(
                "workflow {} on {} verified; lastVerified is now {}",
                out.id,
                out.host,
                out.last_verified.as_deref().unwrap_or("(unset)")
            );
            if out.cleared_review {
                println!("review cleared: the run you just made is the review");
            }
            if let Some(revision) = out.revision {
                println!("revision: {revision}");
            }
        }
        _ => {
            println!(
                "recorded candidate {} for workflow {} on {}",
                out.candidate_id.as_deref().unwrap_or("(unknown)"),
                out.id,
                out.host
            );
            println!(
                "The workflow is unchanged. One failure is not evidence: record a second sighting \
                 on a different day before changing site memory."
            );
        }
    }
}

// ---------------------------------------------------------------------------
// candidates
// ---------------------------------------------------------------------------

fn candidate_add(store: &SiteStore, args: &CandidateAddArgs, format: Format) -> Result<Outcome> {
    let host = store::normalize_host(&args.host);
    store::guard_host(&host)?;
    if host.read_only {
        anyhow::bail!(
            "{} could not be normalised to a host directory; candidates are written to active \
             memory and need a plain hostname",
            args.host
        );
    }
    for (label, text) in [
        ("--claim", Some(args.claim.as_str())),
        ("--evidence", args.evidence.as_deref()),
        ("--consequence", args.consequence.as_deref()),
    ] {
        if let Some(text) = text
            && let Some(reason) = validate::find_secret(text)
        {
            anyhow::bail!("{label}: {reason}");
        }
    }
    if args.claim.trim().is_empty() {
        anyhow::bail!("--claim must not be empty");
    }

    let _lock = store.lock()?;
    let candidate = write_candidate(
        store,
        &host,
        args.kind,
        &args.claim,
        args.evidence.clone(),
        args.consequence.clone(),
        None,
    )?;
    let path = store
        .host_dir(&host)?
        .join(store::CANDIDATES_DIR)
        .join(format!("{}.json", candidate.id));

    let out = CandidateAddOutput {
        id: candidate.id.clone(),
        host: host.display.clone(),
        path: path.display().to_string(),
        kind: candidate.kind.as_str(),
        observed_date_utc: candidate.observed_date_utc.clone(),
    };
    match format {
        Format::Json => emit(&out)?,
        Format::Human => {
            println!("recorded candidate {} on {}", out.id, out.host);
            println!("  {}", out.path);
            if candidate.kind.needs_corroboration() {
                println!(
                    "  This kind needs a second observation on a different UTC date before it may \
                     change site memory."
                );
            }
        }
    }
    Ok(Outcome::Done)
}

/// Write one candidate into active memory. The caller holds the lock.
fn write_candidate(
    store: &SiteStore,
    host: &HostKey,
    kind: CandidateKind,
    claim: &str,
    evidence: Option<String>,
    consequence: Option<String>,
    workflow_id: Option<String>,
) -> Result<Candidate> {
    let dir = store::sub(&store.host_dir(host)?, store::CANDIDATES_DIR)?;
    let date = today_utc();
    let id = store::next_candidate_id(&dir, &date)?;
    let candidate = Candidate {
        id,
        host: host.display.clone(),
        observed_date_utc: date,
        kind,
        claim: claim.trim().to_string(),
        evidence,
        consequence,
        status: CandidateStatus::Pending,
        workflow_id,
    };
    let name = format!("{}.json", candidate.id);
    let path = store::resolve_in(&dir, &[name.as_str()])?;
    store::write_json(&path, &candidate)?;
    Ok(candidate)
}

fn candidate_list(store: &SiteStore, args: &CandidateListArgs, format: Format) -> Result<Outcome> {
    let host = store::normalize_host(&args.host);
    store::guard_host(&host)?;
    let dir = store::sub(&store.host_dir(&host)?, store::CANDIDATES_DIR)?;
    let (candidates, problems) = store::load_candidates(&dir)?;
    let filtered: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| args.kind.is_none_or(|kind| c.kind == kind))
        .filter(|c| args.status.is_none_or(|status| c.status == status))
        .collect();
    match format {
        Format::Json => emit(&filtered)?,
        Format::Human => {
            if filtered.is_empty() {
                println!("(no candidates match)");
            }
            for candidate in &filtered {
                println!("{}", render::render_candidate_line(candidate));
            }
        }
    }
    for problem in problems {
        eprintln!("warning: unreadable candidate — {problem}");
    }
    Ok(Outcome::Done)
}

fn candidate_show(store: &SiteStore, args: &CandidateShowArgs, format: Format) -> Result<Outcome> {
    let host = store::normalize_host(&args.host);
    store::guard_host(&host)?;
    let dir = store::sub(&store.host_dir(&host)?, store::CANDIDATES_DIR)?;
    let (candidates, _) = store::load_candidates(&dir)?;
    let Some(candidate) = candidates.iter().find(|c| c.id == args.id) else {
        return Err(anyhow::anyhow!(
            "no candidate {} on {}",
            args.id,
            host.display
        ));
    };
    match format {
        Format::Json => emit(candidate)?,
        Format::Human => render::print_candidate(candidate),
    }
    Ok(Outcome::Done)
}

// ---------------------------------------------------------------------------
// checkpoint
// ---------------------------------------------------------------------------

fn checkpoint_cmd(store: &SiteStore, args: &CheckpointArgs, format: Format) -> Result<Outcome> {
    let host = store::normalize_host(&args.host);
    store::guard_host(&host)?;
    let out = checkpoint::run(&checkpoint::CheckpointRequest {
        store,
        host: &host,
        task: &args.task,
        reason: args.reason,
        expected_revision: args.expected_revision,
        ingest: &args.ingest,
        reject: &args.reject,
    })?;
    match format {
        Format::Json => emit(&out)?,
        Format::Human => render::print_checkpoint(&out),
    }
    match out {
        CheckpointOutput::Committed { .. } => Ok(Outcome::Done),
        CheckpointOutput::Conflict { .. } => Ok(Outcome::Unsuccessful),
    }
}
