//! The `bsk site checkpoint` transaction (design §3.5).
//!
//! Order matters and is fixed:
//!
//! ```text
//! repository lock → read draft context → compare-and-swap on revision
//! → validate draft → check candidate evidence → copy draft into active
//! → bump revision → append journal → settle candidate statuses
//! ```
//!
//! Everything from the copy onwards is undone on failure, so a checkpoint
//! either publishes the whole draft or leaves active memory untouched. A
//! revision mismatch is a `conflict` result, not an error: the agent is
//! expected to re-read context and replay its edits once.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use super::model::{Candidate, CandidateStatus, CheckpointReason, JournalEntry, now_rfc3339};
use super::render::CheckpointOutput;
use super::store::{self, Draft, HostKey, SiteStore};
use super::validate;

pub struct CheckpointRequest<'a> {
    pub store: &'a SiteStore,
    pub host: &'a HostKey,
    pub task: &'a str,
    pub reason: CheckpointReason,
    pub expected_revision: Option<u64>,
    pub ingest: &'a [String],
    pub reject: &'a [String],
}

pub fn run(req: &CheckpointRequest<'_>) -> Result<CheckpointOutput> {
    // The same gate every other entry point applies, so a hand-written draft
    // cannot route a sensitive host into active memory.
    store::guard_host(req.host)?;
    let _lock = req.store.lock()?;

    let draft = store::load_draft(req.store, req.task, req.host)?.ok_or_else(|| {
        anyhow::anyhow!(
            "no draft for task {:?} on {}. Run `bsk site context --host {} --task {}` first.",
            req.task,
            req.host.display,
            req.host.display,
            req.task
        )
    })?;
    if draft.context.read_only {
        bail!(
            "draft for {} is read-only: the host could not be normalised, so it may be staged but \
             never promoted into active memory. Re-run with a plain hostname.",
            req.host.display
        );
    }

    let expected = req.expected_revision.unwrap_or(draft.context.base_revision);
    let actual = req.store.revision(req.host)?;
    if expected != actual {
        // The draft deliberately keeps its stale base. `bsk site context` is
        // what recovers a conflict, and it recognises the stale base as its cue
        // to re-seed the draft from the published revision. Moving the base
        // here would make that re-seed a no-op and let the retry republish the
        // old prose, erasing what the other writer just committed.
        return Ok(CheckpointOutput::Conflict { expected, actual });
    }

    let mut warnings = validate_draft(req, &draft)?;
    let active = req.store.host_dir(req.host)?;
    let (candidates, problems) = load_active_candidates(&active)?;
    warnings.extend(problems);
    let disposition = resolve_disposition(req, &candidates)?;

    let staged = stage(&draft.dir, &active, &req.host.dir)?;
    if staged.is_empty() && disposition.is_empty() {
        bail!(
            "nothing to checkpoint: the draft at {} has no SITE.md, references or workflows, and \
             no candidates were ingested or rejected",
            draft.dir.display()
        );
    }

    let mut tx = store::Transaction::default();
    let result = commit(req, &mut tx, &draft, &staged, &disposition, actual + 1);
    match result {
        Ok(()) => Ok(CheckpointOutput::Committed {
            revision: actual + 1,
            host: req.host.display.clone(),
            reason: req.reason.as_str().to_string(),
            paths: staged.iter().map(|f| f.label.clone()).collect(),
            ingested: disposition.ingest.iter().map(|c| c.id.clone()).collect(),
            rejected: disposition.reject.iter().map(|c| c.id.clone()).collect(),
            warnings,
        }),
        Err(err) => {
            let rollback = tx.rollback();
            match rollback {
                Ok(()) => Err(err.context("checkpoint failed; active memory was rolled back")),
                Err(rollback_err) => Err(err.context(format!(
                    "checkpoint failed and rollback was incomplete ({rollback_err:#}); inspect {}",
                    req.store.root().display()
                ))),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn validate_draft(req: &CheckpointRequest<'_>, draft: &Draft) -> Result<Vec<String>> {
    let mut report = validate::Report::default();
    let references_dir = store::sub(&draft.dir, store::REFERENCES_DIR)?;
    let references = store::list_stems(&references_dir, "md")?;
    if let Some(text) = store::read_optional(&store::sub(&draft.dir, store::SITE_MD)?)? {
        report.merge(validate::validate_site_md(&text, &references));
    }
    report.merge(validate_references(&references_dir, &references)?);
    let workflows_dir = store::sub(&draft.dir, store::WORKFLOWS_DIR)?;
    report.merge(validate::validate_workflow_dir(
        &workflows_dir,
        &req.host.display,
    ));
    if !report.is_ok() {
        bail!(
            "the draft does not satisfy the site-memory rules:\n  - {}",
            report.errors.join("\n  - ")
        );
    }
    Ok(report.warnings)
}

/// Scan every `references/*.md` in the draft. Anything else in that directory
/// is refused outright: `references/` holds prose a human reads, not payloads.
fn validate_references(dir: &Path, stems: &[String]) -> Result<validate::Report> {
    let mut report = validate::Report::default();
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            report.errors.push(format!(
                "references/ must contain only .md files, found the directory {}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            report.errors.push(format!(
                "references/ must contain only .md files, found {}",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
    }
    for stem in stems {
        let name = format!("{stem}.md");
        let path = store::resolve_in(dir, &[name.as_str()])?;
        let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
        report.merge(validate::validate_reference(stem, &text));
    }
    Ok(report)
}

// ---------------------------------------------------------------------------
// Candidate disposition
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Disposition {
    ingest: Vec<Candidate>,
    reject: Vec<Candidate>,
}

impl Disposition {
    fn is_empty(&self) -> bool {
        self.ingest.is_empty() && self.reject.is_empty()
    }
}

fn load_active_candidates(active: &Path) -> Result<(Vec<Candidate>, Vec<String>)> {
    store::load_candidates(&store::sub(active, store::CANDIDATES_DIR)?)
}

fn resolve_disposition(
    req: &CheckpointRequest<'_>,
    candidates: &[Candidate],
) -> Result<Disposition> {
    if req.reason == CheckpointReason::CandidateIngestion
        && req.ingest.is_empty()
        && req.reject.is_empty()
    {
        bail!(
            "--reason candidate_ingestion needs at least one --ingest or --reject. Run \
             `bsk site candidate list --host {} --status pending` to see the options.",
            req.host.display
        );
    }

    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for id in req.ingest.iter().chain(req.reject.iter()) {
        if !seen.insert(id.as_str()) {
            bail!("candidate {id} appears more than once in --ingest / --reject");
        }
    }

    let mut disposition = Disposition::default();
    for id in req.ingest {
        let candidate = pick(candidates, id)?;
        validate::check_corroboration(candidate, candidates).map_err(anyhow::Error::msg)?;
        disposition.ingest.push(candidate.clone());
    }
    for id in req.reject {
        disposition.reject.push(pick(candidates, id)?.clone());
    }
    Ok(disposition)
}

fn pick<'a>(candidates: &'a [Candidate], id: &str) -> Result<&'a Candidate> {
    let candidate = candidates
        .iter()
        .find(|c| c.id == id)
        .with_context(|| format!("no candidate {id} on this host"))?;
    if candidate.status != CandidateStatus::Pending {
        bail!(
            "candidate {id} is already {}; a candidate is settled once",
            candidate.status.as_str()
        );
    }
    Ok(candidate)
}

// ---------------------------------------------------------------------------
// Staging and commit
// ---------------------------------------------------------------------------

struct StagedFile {
    source: PathBuf,
    dest: PathBuf,
    /// Path as reported to the user and written to the journal.
    label: String,
}

/// Collect every draft file that will be copied into active memory.
///
/// Copy-only: a checkpoint never deletes an active file the draft happens to
/// lack, so a partial draft cannot silently erase memory. Removing a workflow
/// is a deliberate act outside this transaction.
fn stage(draft_dir: &Path, active: &Path, host_dir: &str) -> Result<Vec<StagedFile>> {
    let mut staged = Vec::new();
    if store::sub(draft_dir, store::SITE_MD)?.is_file() {
        staged.push(StagedFile {
            source: store::sub(draft_dir, store::SITE_MD)?,
            dest: store::resolve_in(active, &[store::SITE_MD])?,
            label: format!("{host_dir}/{}", store::SITE_MD),
        });
    }
    for (sub, ext) in [
        (store::REFERENCES_DIR, "md"),
        (store::WORKFLOWS_DIR, "json"),
    ] {
        let src_dir = draft_dir.join(sub);
        let dst_dir = active.join(sub);
        for stem in store::list_stems(&src_dir, ext)? {
            let name = format!("{stem}.{ext}");
            staged.push(StagedFile {
                source: store::resolve_in(&src_dir, &[name.as_str()])?,
                dest: store::resolve_in(&dst_dir, &[name.as_str()])?,
                label: format!("{host_dir}/{sub}/{name}"),
            });
        }
    }
    Ok(staged)
}

fn commit(
    req: &CheckpointRequest<'_>,
    tx: &mut store::Transaction,
    draft: &Draft,
    staged: &[StagedFile],
    disposition: &Disposition,
    revision: u64,
) -> Result<()> {
    for file in staged {
        let bytes = fs::read(&file.source)
            .with_context(|| format!("read staged {}", file.source.display()))?;
        tx.write(&file.dest, &bytes)?;
    }

    let candidates_dir = store::sub(&req.store.host_dir(req.host)?, store::CANDIDATES_DIR)?;
    settle(
        tx,
        &candidates_dir,
        &disposition.ingest,
        CandidateStatus::Ingested,
    )?;
    settle(
        tx,
        &candidates_dir,
        &disposition.reject,
        CandidateStatus::Rejected,
    )?;

    tx.write(
        &req.store.revision_path(req.host)?,
        format!("{revision}\n").as_bytes(),
    )?;

    // The draft now sits on top of what it just published, so a follow-up edit
    // in the same task checkpoints without a spurious conflict.
    let mut context = draft.context.clone();
    context.base_revision = revision;
    tx.write_json(&store::draft_context_path(&draft.dir), &context)?;

    // The journal goes last and inside the transaction: a rollback must not
    // leave a line claiming a commit that was undone.
    let entry = JournalEntry {
        revision,
        at: now_rfc3339(),
        host: req.host.display.clone(),
        task_id: Some(req.task.to_string()),
        reason: req.reason.as_str().to_string(),
        paths: staged.iter().map(|f| f.label.clone()).collect(),
        ingested: disposition.ingest.iter().map(|c| c.id.clone()).collect(),
        rejected: disposition.reject.iter().map(|c| c.id.clone()).collect(),
    };
    let line = serde_json::to_string(&entry).context("encode journal entry")?;
    tx.append_line(&req.store.journal_path(req.host)?, &line)
}

fn settle(
    tx: &mut store::Transaction,
    dir: &Path,
    candidates: &[Candidate],
    status: CandidateStatus,
) -> Result<()> {
    for candidate in candidates {
        let mut updated = candidate.clone();
        updated.status = status;
        let name = format!("{}.json", candidate.id);
        let path = store::resolve_in(dir, &[name.as_str()])?;
        tx.write_json(&path, &updated)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::model::CandidateKind;
    use super::*;

    struct Fixture {
        _tmp: tempfile::TempDir,
        store: SiteStore,
        host: HostKey,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let store = SiteStore::at(tmp.path().join("sites")).unwrap();
        let host = store::normalize_host("ticket.corp.example");
        Fixture {
            _tmp: tmp,
            store,
            host,
        }
    }

    fn request<'a>(
        fx: &'a Fixture,
        reason: CheckpointReason,
        ingest: &'a [String],
        reject: &'a [String],
    ) -> CheckpointRequest<'a> {
        CheckpointRequest {
            store: &fx.store,
            host: &fx.host,
            task: "task-1",
            reason,
            expected_revision: None,
            ingest,
            reject,
        }
    }

    fn draft_with_site_md(fx: &Fixture, body: &str) -> Draft {
        let draft = store::ensure_draft(&fx.store, "task-1", &fx.host).unwrap();
        store::write_atomic(
            &store::sub(&draft.dir, store::SITE_MD).unwrap(),
            body.as_bytes(),
        )
        .unwrap();
        draft
    }

    fn add_candidate(fx: &Fixture, id: &str, date: &str, kind: CandidateKind, claim: &str) {
        let dir = fx
            .store
            .host_dir(&fx.host)
            .unwrap()
            .join(store::CANDIDATES_DIR);
        store::write_json(
            &dir.join(format!("{id}.json")),
            &Candidate {
                id: id.into(),
                host: fx.host.display.clone(),
                observed_date_utc: date.into(),
                kind,
                claim: claim.into(),
                evidence: None,
                consequence: None,
                status: CandidateStatus::Pending,
                workflow_id: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn commits_draft_and_bumps_revision() {
        let fx = fixture();
        draft_with_site_md(&fx, "Submit lives under /new. [verified 2026-09-15]\n");
        let out = run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap();
        let CheckpointOutput::Committed {
            revision, paths, ..
        } = out
        else {
            panic!("expected a commit");
        };
        assert_eq!(revision, 1);
        assert_eq!(paths, vec!["ticket.corp.example/SITE.md".to_string()]);
        assert_eq!(fx.store.revision(&fx.host).unwrap(), 1);
        let active = store::sub(&fx.store.host_dir(&fx.host).unwrap(), store::SITE_MD).unwrap();
        assert!(
            fs::read_to_string(active)
                .unwrap()
                .contains("verified 2026-09-15")
        );
        let journal = fs::read_to_string(fx.store.journal_path(&fx.host).unwrap()).unwrap();
        assert_eq!(journal.lines().count(), 1);
    }

    #[test]
    fn stale_expected_revision_reports_a_conflict_without_writing() {
        let fx = fixture();
        draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        // Another writer commits first.
        fx.store.set_revision(&fx.host, 9).unwrap();
        let out = run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap();
        assert!(matches!(
            out,
            CheckpointOutput::Conflict {
                expected: 0,
                actual: 9
            }
        ));
        assert!(
            !fx.store
                .host_dir(&fx.host)
                .unwrap()
                .join(store::SITE_MD)
                .exists()
        );
        assert_eq!(fx.store.revision(&fx.host).unwrap(), 9);
    }

    #[test]
    fn invalid_site_md_blocks_the_commit() {
        let fx = fixture();
        draft_with_site_md(&fx, "a fact with no stamp\n");
        let err = run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap_err();
        assert!(err.to_string().contains("[verified YYYY-MM-DD]"), "{err:#}");
        assert_eq!(fx.store.revision(&fx.host).unwrap(), 0);
        assert!(
            !fx.store
                .host_dir(&fx.host)
                .unwrap()
                .join(store::SITE_MD)
                .exists()
        );
    }

    #[test]
    fn read_only_draft_cannot_be_promoted() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SiteStore::at(tmp.path().join("sites")).unwrap();
        let host = store::normalize_host("not a host!!");
        let draft = store::ensure_draft(&store, "task-1", &host).unwrap();
        store::write_atomic(
            &store::sub(&draft.dir, store::SITE_MD).unwrap(),
            b"x [verified 2026-09-15]\n",
        )
        .unwrap();
        let req = CheckpointRequest {
            store: &store,
            host: &host,
            task: "task-1",
            reason: CheckpointReason::DirectCorrection,
            expected_revision: None,
            ingest: &[],
            reject: &[],
        };
        let err = run(&req).unwrap_err();
        assert!(err.to_string().contains("read-only"), "{err:#}");
    }

    #[test]
    fn candidate_ingestion_requires_a_disposition() {
        let fx = fixture();
        draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        let err = run(&request(
            &fx,
            CheckpointReason::CandidateIngestion,
            &[],
            &[],
        ))
        .unwrap_err();
        assert!(err.to_string().contains("--ingest"), "{err:#}");
    }

    #[test]
    fn uncorroborated_candidate_cannot_be_ingested() {
        let fx = fixture();
        draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        add_candidate(
            &fx,
            "c1",
            "2026-09-15",
            CandidateKind::BetterPath,
            "use the dropdown",
        );
        let ingest = vec!["c1".to_string()];
        let err = run(&request(
            &fx,
            CheckpointReason::CandidateIngestion,
            &ingest,
            &[],
        ))
        .unwrap_err();
        assert!(
            err.to_string().contains("two independent observations"),
            "{err:#}"
        );
        assert_eq!(fx.store.revision(&fx.host).unwrap(), 0);
    }

    #[test]
    fn two_day_corroboration_ingests_and_settles_status() {
        let fx = fixture();
        draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        add_candidate(
            &fx,
            "c1",
            "2026-09-15",
            CandidateKind::BetterPath,
            "use the dropdown",
        );
        add_candidate(
            &fx,
            "c2",
            "2026-09-16",
            CandidateKind::BetterPath,
            "Use the  dropdown",
        );
        let ingest = vec!["c1".to_string()];
        let reject = vec!["c2".to_string()];
        let out = run(&request(
            &fx,
            CheckpointReason::CandidateIngestion,
            &ingest,
            &reject,
        ))
        .unwrap();
        let CheckpointOutput::Committed {
            ingested, rejected, ..
        } = out
        else {
            panic!("expected a commit");
        };
        assert_eq!(ingested, vec!["c1".to_string()]);
        assert_eq!(rejected, vec!["c2".to_string()]);
        let dir = fx
            .store
            .host_dir(&fx.host)
            .unwrap()
            .join(store::CANDIDATES_DIR);
        let (candidates, _) = store::load_candidates(&dir).unwrap();
        assert_eq!(candidates[0].status, CandidateStatus::Ingested);
        assert_eq!(candidates[1].status, CandidateStatus::Rejected);
    }

    #[test]
    fn high_consequence_candidate_needs_no_second_sighting() {
        let fx = fixture();
        draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        add_candidate(
            &fx,
            "c1",
            "2026-09-15",
            CandidateKind::HighConsequence,
            "delete removes the whole queue with no confirm",
        );
        let ingest = vec!["c1".to_string()];
        assert!(matches!(
            run(&request(
                &fx,
                CheckpointReason::CandidateIngestion,
                &ingest,
                &[]
            ))
            .unwrap(),
            CheckpointOutput::Committed { .. }
        ));
    }

    #[test]
    fn a_candidate_is_settled_only_once() {
        let fx = fixture();
        draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        add_candidate(&fx, "c1", "2026-09-15", CandidateKind::HighConsequence, "x");
        let ingest = vec!["c1".to_string()];
        run(&request(
            &fx,
            CheckpointReason::CandidateIngestion,
            &ingest,
            &[],
        ))
        .unwrap();
        let err = run(&CheckpointRequest {
            expected_revision: Some(1),
            ..request(&fx, CheckpointReason::CandidateIngestion, &ingest, &[])
        })
        .unwrap_err();
        assert!(err.to_string().contains("already ingested"), "{err:#}");
    }

    /// S7: the conflict recovery must not swallow the commit that won the
    /// race. Two tasks branch from the same base; A publishes, B conflicts, B
    /// re-runs `context` (which re-seeds its draft), replays its own edit and
    /// checkpoints. Both lines have to survive.
    #[test]
    fn conflict_recovery_keeps_both_writers_edits() {
        let fx = fixture();
        let site_md = |draft: &Draft| store::sub(&draft.dir, store::SITE_MD).unwrap();

        let a = store::ensure_draft(&fx.store, "task-a", &fx.host).unwrap();
        let b = store::ensure_draft(&fx.store, "task-b", &fx.host).unwrap();
        store::write_atomic(&site_md(&a), b"A's line [verified 2026-09-15]\n").unwrap();
        store::write_atomic(&site_md(&b), b"B's line [verified 2026-09-15]\n").unwrap();

        run(&CheckpointRequest {
            task: "task-a",
            ..request(&fx, CheckpointReason::DirectCorrection, &[], &[])
        })
        .unwrap();

        let conflict = run(&CheckpointRequest {
            task: "task-b",
            ..request(&fx, CheckpointReason::DirectCorrection, &[], &[])
        })
        .unwrap();
        assert!(matches!(
            conflict,
            CheckpointOutput::Conflict {
                expected: 0,
                actual: 1
            }
        ));

        // `bsk site context` is the documented recovery: it re-seeds the draft
        // from the published revision, so B now sees A's line.
        let b = store::load_draft(&fx.store, "task-b", &fx.host)
            .unwrap()
            .unwrap();
        let b = store::rebase_draft(&fx.store, &fx.host, b, 1).unwrap();
        assert!(b.rebased);
        let reseeded = fs::read_to_string(site_md(&b)).unwrap();
        assert_eq!(reseeded, "A's line [verified 2026-09-15]\n");

        // B replays its own edit on top and checkpoints again.
        store::write_atomic(
            &site_md(&b),
            format!("{reseeded}B's line [verified 2026-09-15]\n").as_bytes(),
        )
        .unwrap();
        let second = run(&CheckpointRequest {
            task: "task-b",
            ..request(&fx, CheckpointReason::DirectCorrection, &[], &[])
        })
        .unwrap();
        let CheckpointOutput::Committed { revision, .. } = second else {
            panic!("the retry must commit, got {second:?}");
        };
        assert_eq!(revision, 2);

        let published = fs::read_to_string(
            store::sub(&fx.store.host_dir(&fx.host).unwrap(), store::SITE_MD).unwrap(),
        )
        .unwrap();
        assert!(published.contains("A's line"), "{published}");
        assert!(published.contains("B's line"), "{published}");
    }

    /// A conflict leaves the base revision alone on purpose: only `context`
    /// moves it, and it re-seeds the draft in the same breath. A bare retry
    /// must keep conflicting rather than silently republish stale prose.
    #[test]
    fn a_bare_retry_after_a_conflict_conflicts_again() {
        let fx = fixture();
        draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        fx.store.set_revision(&fx.host, 9).unwrap();
        for _ in 0..2 {
            assert!(matches!(
                run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap(),
                CheckpointOutput::Conflict {
                    expected: 0,
                    actual: 9
                }
            ));
        }
    }

    /// One host's checkpoint must not push another host's draft into conflict.
    #[test]
    fn revisions_do_not_leak_between_hosts() {
        let fx = fixture();
        draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap();

        let other = store::normalize_host("example.org");
        let draft = store::ensure_draft(&fx.store, "task-1", &other).unwrap();
        assert_eq!(
            draft.context.base_revision, 0,
            "a fresh host starts at revision 0 whatever other hosts have done"
        );
        store::write_atomic(
            &store::sub(&draft.dir, store::SITE_MD).unwrap(),
            b"another site [verified 2026-09-15]\n",
        )
        .unwrap();
        assert!(matches!(
            run(&CheckpointRequest {
                host: &other,
                ..request(&fx, CheckpointReason::DirectCorrection, &[], &[])
            })
            .unwrap(),
            CheckpointOutput::Committed { revision: 1, .. }
        ));
        assert_eq!(fx.store.revision(&fx.host).unwrap(), 1);
    }

    /// A successful checkpoint leaves the draft sitting on what it published,
    /// so a follow-up edit in the same task does not conflict with itself.
    #[test]
    fn a_commit_rebases_its_own_draft() {
        let fx = fixture();
        draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap();
        let draft = store::load_draft(&fx.store, "task-1", &fx.host)
            .unwrap()
            .unwrap();
        assert_eq!(draft.context.base_revision, 1);

        store::write_atomic(
            &store::sub(&draft.dir, store::SITE_MD).unwrap(),
            b"a second fact [verified 2026-09-15]\n",
        )
        .unwrap();
        assert!(matches!(
            run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap(),
            CheckpointOutput::Committed { revision: 2, .. }
        ));
    }

    /// M8: a failure part-way through must leave active memory, the revision
    /// and the journal exactly as they were.
    #[test]
    fn a_failed_commit_rolls_back_without_leaving_a_journal_line() {
        let fx = fixture();
        draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap();
        let journal_before = fs::read_to_string(fx.store.journal_path(&fx.host).unwrap()).unwrap();
        let site_before = fs::read_to_string(
            store::sub(&fx.store.host_dir(&fx.host).unwrap(), store::SITE_MD).unwrap(),
        )
        .unwrap();

        // Stage a second edit, then make one staged source unreadable so the
        // copy loop fails after the first file has already been written.
        let draft = store::load_draft(&fx.store, "task-1", &fx.host)
            .unwrap()
            .unwrap();
        store::write_atomic(
            &store::sub(&draft.dir, store::SITE_MD).unwrap(),
            b"an edited fact [verified 2026-09-15]\n",
        )
        .unwrap();
        let references = store::sub(&draft.dir, store::REFERENCES_DIR).unwrap();
        store::write_atomic(&references.join("detail.md"), b"prose").unwrap();
        // A directory sitting at the *destination* makes the atomic replace
        // fail after SITE.md has already been copied, which is exactly the
        // half-applied state the rollback exists for.
        let blocked = store::sub(&fx.store.host_dir(&fx.host).unwrap(), store::REFERENCES_DIR)
            .unwrap()
            .join("detail.md");
        fs::create_dir_all(&blocked).unwrap();
        fs::write(blocked.join("occupied"), b"x").unwrap();

        let err = run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap_err();
        assert!(err.to_string().contains("rolled back"), "{err:#}");

        assert_eq!(
            fx.store.revision(&fx.host).unwrap(),
            1,
            "revision must not advance"
        );
        assert_eq!(
            fs::read_to_string(
                store::sub(&fx.store.host_dir(&fx.host).unwrap(), store::SITE_MD).unwrap()
            )
            .unwrap(),
            site_before,
            "active SITE.md must be restored"
        );
        assert_eq!(
            fs::read_to_string(fx.store.journal_path(&fx.host).unwrap()).unwrap(),
            journal_before,
            "a rolled-back commit must leave no journal line"
        );
    }

    /// H3/H4: the draft path must not be a way around the capture-time gates.
    #[test]
    fn checkpoint_refuses_a_sensitive_host_and_secret_prose() {
        let tmp = tempfile::tempdir().unwrap();
        let store = SiteStore::at(tmp.path().join("sites")).unwrap();
        let host = store::normalize_host("sso.corp.example");
        let err = run(&CheckpointRequest {
            store: &store,
            host: &host,
            task: "task-1",
            reason: CheckpointReason::DirectCorrection,
            expected_revision: None,
            ingest: &[],
            reject: &[],
        })
        .unwrap_err();
        assert!(err.to_string().contains("credential-surface"), "{err:#}");

        let fx = fixture();
        draft_with_site_md(
            &fx,
            "paste Authorization: Bearer abc123def456 [verified 2026-09-15]\n",
        );
        let err = run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap_err();
        assert!(err.to_string().contains("bearer token"), "{err:#}");
        assert_eq!(fx.store.revision(&fx.host).unwrap(), 0);
    }

    #[test]
    fn checkpoint_refuses_secret_and_oversized_references() {
        let fx = fixture();
        let draft = draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        let references = store::sub(&draft.dir, store::REFERENCES_DIR).unwrap();
        store::write_atomic(&references.join("detail.md"), b"cookie=session_id=abc").unwrap();
        let err = run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap_err();
        assert!(err.to_string().contains("cookie"), "{err:#}");

        fs::remove_file(references.join("detail.md")).unwrap();
        store::write_atomic(&references.join("notes.txt"), b"prose").unwrap();
        let err = run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap_err();
        assert!(err.to_string().contains("only .md files"), "{err:#}");
    }

    #[test]
    fn checkpoint_never_deletes_active_files_the_draft_lacks() {
        let fx = fixture();
        let active = fx.store.host_dir(&fx.host).unwrap();
        let keep = store::sub(&active, store::WORKFLOWS_DIR)
            .unwrap()
            .join("keep.json");
        store::write_atomic(&keep, b"{}").unwrap();
        // Seed the draft *after* writing the file so it is copied in, then remove it.
        let draft = draft_with_site_md(&fx, "a fact [verified 2026-09-15]\n");
        fs::remove_file(
            store::sub(&draft.dir, store::WORKFLOWS_DIR)
                .unwrap()
                .join("keep.json"),
        )
        .unwrap();
        run(&request(&fx, CheckpointReason::DirectCorrection, &[], &[])).unwrap();
        assert!(
            keep.is_file(),
            "an active file absent from the draft must survive"
        );
    }
}
