//! Keep installed skill packages in sync with the binary's embedded bundle.
//! Best-effort: I/O errors are recorded, never thrown.

use std::path::Path;

use anyhow::{Context, Result};

use super::{
    SOURCE_MARKER_FILE, SkillBundle,
    bundle::file_hash,
    conflicts,
    harness::HarnessId,
    provenance::{self, Provenance},
    storage::SkillLock,
};

/// Per-harness outcome of a sync pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Harnesses whose managed package differed and was updated.
    pub updated: Vec<HarnessId>,
    /// Managed harnesses whose managed files already matched the bundled
    /// content; no write happened, mtime preserved.
    pub up_to_date: Vec<HarnessId>,
    /// Explicit custom installations that intentionally opt out of updates.
    pub protected: Vec<HarnessId>,
    /// Content preserved because safe automatic updates need user attention.
    pub paused: Vec<(HarnessId, PauseReason)>,
    /// Paths and reasons for conflicts that paused a harness, captured under its lock.
    pub conflict_details: Vec<(HarnessId, Vec<String>)>,
    /// Another install/sync holds the lock; retry on a later sync pass.
    pub busy: Vec<HarnessId>,
    /// Harnesses that have an installed `SKILL.md` but the sync attempt
    /// failed with an I/O error. The string is a human-readable detail.
    pub errors: Vec<(HarnessId, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseReason {
    Untracked,
    MissingBaseline,
    LocalChanges,
    InvalidMarker,
    InterruptedUpdate,
}

impl PauseReason {
    pub fn description(self) -> &'static str {
        match self {
            Self::Untracked => "untracked installation differs from the bundled skill",
            Self::MissingBaseline => "older bundled installation has no content baseline",
            Self::LocalChanges => "local changes detected",
            Self::InvalidMarker => "unrecognized or damaged source marker",
            Self::InterruptedUpdate => {
                "another skill version has an unfinished update; reinstall with --force"
            }
        }
    }
}

/// Sync installed packages and recover pending installs; leave other harnesses untouched.
pub fn sync_installed_skills(home: &Path) -> SyncReport {
    sync_with_bundle(home, &SkillBundle::bundled())
}

/// Test seam: lets unit tests inject a synthetic "bundled" payload.
#[cfg(test)]
pub(crate) fn sync_with_source(home: &Path, source: &str) -> SyncReport {
    sync_with_bundle(home, &SkillBundle::single(source))
}

pub(super) fn sync_with_bundle(home: &Path, source: &SkillBundle) -> SyncReport {
    let mut report = SyncReport::default();
    for &harness in HarnessId::ALL {
        let dest = harness.skill_dest_dir_for_home(home).join("SKILL.md");
        match sync_one(&dest, source) {
            Ok(SyncOne::Missing) => continue,
            Ok(SyncOne::UpToDate) => report.up_to_date.push(harness),
            Ok(SyncOne::Updated) => report.updated.push(harness),
            Ok(SyncOne::Protected) => report.protected.push(harness),
            Ok(SyncOne::Paused(reason, conflicts)) => {
                report.paused.push((harness, reason));
                if !conflicts.is_empty() {
                    report.conflict_details.push((harness, conflicts));
                }
            }
            Ok(SyncOne::Busy) => report.busy.push(harness),
            Err(err) => report.errors.push((harness, format!("{err:#}"))),
        }
    }
    report
}

enum SyncOne {
    Missing,
    UpToDate,
    Updated,
    Protected,
    Paused(PauseReason, Vec<String>),
    Busy,
}

fn sync_one(dest: &Path, source: &SkillBundle) -> Result<SyncOne> {
    let dir = dest.parent().context("skill destination has no parent")?;
    let marker = dir.join(SOURCE_MARKER_FILE);
    // Include incomplete new installs and missing managed entry points, without
    // creating anything for harnesses that have never installed this skill.
    if !dest.try_exists()? && !marker.try_exists()? {
        return Ok(SyncOne::Missing);
    }
    let Some(_lock) =
        SkillLock::try_acquire(dir).with_context(|| format!("lock {}", dir.display()))?
    else {
        return Ok(SyncOne::Busy);
    };
    let ownership = provenance::read(&marker)?;
    let target = source.hashes();
    let mut baseline = std::collections::BTreeMap::new();
    let mut conflicts = Vec::new();
    match &ownership {
        Provenance::Custom => return Ok(SyncOne::Protected),
        Provenance::Invalid => {
            return Ok(SyncOne::Paused(
                PauseReason::InvalidMarker,
                vec![format!("{}: invalid source marker", marker.display())],
            ));
        }
        Provenance::Bundle(record) => {
            if let Some(previous) = &record.previous {
                if record.files != target {
                    return Ok(SyncOne::Paused(
                        PauseReason::InterruptedUpdate,
                        vec![format!(
                            "{}: unfinished update targets another skill package",
                            marker.display()
                        )],
                    ));
                }
                let conflicts = conflicts::pending(dir, &target, previous)?;
                if !conflicts.is_empty() {
                    return Ok(SyncOne::Paused(PauseReason::LocalChanges, conflicts));
                }
                let obsolete = previous
                    .keys()
                    .filter(|name| !target.contains_key(*name))
                    .cloned()
                    .collect();
                super::transaction::write_bundle(dir, source, &obsolete)?;
                return Ok(SyncOne::Updated);
            }
            baseline = record.files.clone();
            conflicts = conflicts::managed(dir, &baseline)?;
        }
        legacy => {
            let Some(hash) = file_hash(dir, "SKILL.md")? else {
                return Ok(SyncOne::Paused(
                    PauseReason::LocalChanges,
                    vec![format!("{}: deleted", dest.display())],
                ));
            };
            let trusted = match legacy {
                Provenance::Bundled { sha256 } => {
                    *sha256 == hash || target.get("SKILL.md") == Some(&hash)
                }
                _ => provenance::known_legacy(&hash) || target.get("SKILL.md") == Some(&hash),
            };
            if !trusted {
                let reason = match legacy {
                    Provenance::Missing => PauseReason::Untracked,
                    Provenance::LegacyBundled => PauseReason::MissingBaseline,
                    _ => PauseReason::LocalChanges,
                };
                return Ok(SyncOne::Paused(
                    reason,
                    vec![format!("{}: {}", dest.display(), reason.description())],
                ));
            }
            baseline.insert("SKILL.md".into(), hash);
        }
    }
    // New resource paths may already contain user files. Adopt identical bytes,
    // but never overwrite an unowned file that differs from the target.
    conflicts.extend(conflicts::unowned(dir, &target, &baseline)?);
    if !conflicts.is_empty() {
        return Ok(SyncOne::Paused(PauseReason::LocalChanges, conflicts));
    }
    let obsolete = baseline
        .keys()
        .filter(|name| !target.contains_key(*name))
        .cloned()
        .collect();
    let matches = target
        .iter()
        .try_fold(true, |matches, (name, hash)| -> Result<bool> {
            Ok(matches && file_hash(dir, name)?.as_ref() == Some(hash))
        })?;
    if matches && baseline.keys().all(|name| target.contains_key(name)) {
        if !matches!(&ownership, Provenance::Bundle(record) if record.files == target) {
            let metadata = provenance::BundleMarker::new(target, None).encode()?;
            super::storage::PendingWrite::prepare(&marker, &metadata)?.commit()?;
        }
        return Ok(SyncOne::UpToDate);
    }
    super::transaction::write_bundle(dir, source, &obsolete)?;
    Ok(SyncOne::Updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn mark_bundled(dest: &Path) {
        std::fs::write(
            dest.parent().unwrap().join(SOURCE_MARKER_FILE),
            provenance::bundled_marker(&std::fs::read(dest).unwrap()).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn sync_skips_uninstalled_harness() {
        let tmp = TempDir::new().unwrap();
        let report = sync_with_source(tmp.path(), "anything");
        assert!(report.updated.is_empty());
        assert!(report.up_to_date.is_empty());
        assert!(report.errors.is_empty());
        // Defensive: sync must not silently create files in harnesses that
        // never had the skill installed. This guards Task 2's real impl.
        let dest = HarnessId::Cursor
            .skill_dest_dir_for_home(tmp.path())
            .join("SKILL.md");
        assert!(
            !dest.parent().unwrap().exists(),
            "sync should not create directories or locks for uninstalled harnesses"
        );
    }

    #[test]
    fn sync_updates_outdated_skill() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let dest_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("SKILL.md");
        std::fs::write(&dest, b"old content").unwrap();
        mark_bundled(&dest);

        let report = sync_with_source(home, "fresh content");

        assert_eq!(report.updated, vec![HarnessId::Cursor]);
        assert!(report.up_to_date.is_empty());
        assert!(report.errors.is_empty());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "fresh content");
        super::super::storage::test_support::assert_no_temporary_files(&dest_dir);
    }

    #[test]
    fn sync_skips_when_up_to_date() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let dest_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("SKILL.md");
        std::fs::write(&dest, "frozen content").unwrap();
        mark_bundled(&dest);
        let mtime_before = std::fs::metadata(&dest).unwrap().modified().unwrap();

        // Sleep enough that any rewrite would visibly change mtime on
        // platforms with coarse fs timestamps (HFS+ has 1 s granularity).
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let report = sync_with_source(home, "frozen content");

        assert_eq!(report.up_to_date, vec![HarnessId::Cursor]);
        assert!(report.updated.is_empty());
        assert!(report.errors.is_empty());
        let mtime_after = std::fs::metadata(&dest).unwrap().modified().unwrap();
        assert_eq!(
            mtime_before, mtime_after,
            "up-to-date sync should not touch mtime"
        );
    }

    #[cfg(unix)]
    #[test]
    fn sync_continues_on_partial_error() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let home = tmp.path();

        // Cursor: writable, outdated → should be updated.
        let cursor_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&cursor_dir).unwrap();
        std::fs::write(cursor_dir.join("SKILL.md"), "old").unwrap();
        mark_bundled(&cursor_dir.join("SKILL.md"));

        // Codex: a read-only directory prevents lock creation. The other
        // harness must still update, and the failure must not become Busy.
        let codex_dir = HarnessId::Codex.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(codex_dir.join("SKILL.md"), "old").unwrap();
        mark_bundled(&codex_dir.join("SKILL.md"));
        let mut perms = std::fs::metadata(&codex_dir).unwrap().permissions();
        perms.set_mode(0o500); // r-x: blocks tmp creation in this dir
        std::fs::set_permissions(&codex_dir, perms).unwrap();

        let report = sync_with_source(home, "fresh");

        // Restore perms so TempDir can clean up.
        let mut perms = std::fs::metadata(&codex_dir).unwrap().permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(&codex_dir, perms).unwrap();

        assert_eq!(report.updated, vec![HarnessId::Cursor]);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].0, HarnessId::Codex);
    }

    #[test]
    fn sync_preserves_custom_and_untracked_skills() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();

        let custom_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&custom_dir).unwrap();
        std::fs::write(custom_dir.join("SKILL.md"), "custom content").unwrap();
        std::fs::write(custom_dir.join(SOURCE_MARKER_FILE), "custom\n").unwrap();

        let untracked_dir = HarnessId::Codex.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&untracked_dir).unwrap();
        std::fs::write(untracked_dir.join("SKILL.md"), "historical content").unwrap();

        let report = sync_with_source(home, "new bundled content");

        assert_eq!(report.protected, vec![HarnessId::Cursor]);
        assert_eq!(
            report.paused,
            vec![(HarnessId::Codex, PauseReason::Untracked)]
        );
        assert_eq!(
            std::fs::read_to_string(custom_dir.join("SKILL.md")).unwrap(),
            "custom content"
        );
        assert_eq!(
            std::fs::read_to_string(untracked_dir.join("SKILL.md")).unwrap(),
            "historical content"
        );
    }
    #[test]
    fn unknown_markers_are_not_claimed_even_when_content_matches() {
        for marker in [
            "",
            "unknown\n",
            r#"{"version":2,"source":"bundled","sha256":"abc"}"#,
            r#"{"version":1,"source":"bundled","sha256":"invalid"}"#,
            r#"{"version":1,"source":"bundled"}"#,
            r#"{"version":1,"source":"custom","unexpected":true}"#,
        ] {
            let home = TempDir::new().unwrap();
            let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), "same").unwrap();
            std::fs::write(dir.join(SOURCE_MARKER_FILE), marker).unwrap();
            for source in ["same", "new bundled"] {
                let report = sync_with_source(home.path(), source);
                assert_eq!(
                    report.paused,
                    vec![(HarnessId::Cursor, PauseReason::InvalidMarker)]
                );
                assert!(report.up_to_date.is_empty());
                assert!(report.errors.is_empty());
                assert_eq!(
                    std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
                    "same"
                );
            }
            assert_eq!(
                std::fs::read_to_string(dir.join(SOURCE_MARKER_FILE)).unwrap(),
                marker
            );
        }
    }

    #[test]
    fn marker_read_error_is_reported_without_changing_content() {
        let home = TempDir::new().unwrap();
        let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
        std::fs::create_dir_all(dir.join(SOURCE_MARKER_FILE)).unwrap();
        std::fs::write(dir.join("SKILL.md"), "keep").unwrap();
        let report = sync_with_source(home.path(), "new bundled");
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].0, HarnessId::Cursor);
        assert!(report.errors[0].1.contains(SOURCE_MARKER_FILE));
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn failed_sync_replace_preserves_old_content_and_releases_lock() {
        use super::super::storage::test_support::{assert_no_temporary_files, with_replace_hook};
        let home = TempDir::new().unwrap();
        let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("SKILL.md");
        std::fs::write(&dest, "old").unwrap();
        mark_bundled(&dest);
        let report = with_replace_hook(
            |_| Err(std::io::Error::other("injected replacement failure")),
            || sync_with_source(home.path(), "new"),
        );
        assert_eq!(report.errors.len(), 1);
        assert!(report.updated.is_empty());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "old");
        assert_no_temporary_files(&dir);
        assert_eq!(
            sync_with_source(home.path(), "new").updated,
            vec![HarnessId::Cursor]
        );
    }

    #[test]
    fn sync_holds_lock_until_content_replacement_finishes() {
        use super::super::storage::test_support::with_replace_hook;
        use std::sync::mpsc;
        use std::time::Duration;
        let home = TempDir::new().unwrap();
        let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("SKILL.md");
        std::fs::write(&dest, "old").unwrap();
        mark_bundled(&dest);
        let worker_home = home.path().to_path_buf();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            with_replace_hook(
                move |dest| {
                    if dest.file_name().unwrap() == "SKILL.md" {
                        ready_tx.send(()).unwrap();
                        resume_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                    }
                    Ok(())
                },
                || sync_with_source(&worker_home, "first update"),
            )
        });
        ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let during = sync_with_source(home.path(), "second update");
        assert_eq!(during.busy, vec![HarnessId::Cursor]);
        assert!(during.errors.is_empty());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "old");
        resume_tx.send(()).unwrap();
        assert_eq!(worker.join().unwrap().updated, vec![HarnessId::Cursor]);
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "first update");
    }
    #[test]
    fn matching_legacy_installations_are_adopted_without_rewriting_content() {
        use std::time::{Duration, SystemTime};
        for legacy in [None, Some(super::super::SOURCE_BUNDLED)] {
            let home = TempDir::new().unwrap();
            let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
            std::fs::create_dir_all(&dir).unwrap();
            let dest = dir.join("SKILL.md");
            let marker = dir.join(SOURCE_MARKER_FILE);
            std::fs::write(&dest, "current bundle").unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(&dest)
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000))
                .unwrap();
            let mtime = std::fs::metadata(&dest).unwrap().modified().unwrap();
            if let Some(legacy) = legacy {
                std::fs::write(&marker, legacy).unwrap();
            }
            let report = sync_with_source(home.path(), "current bundle");
            assert_eq!(report.up_to_date, vec![HarnessId::Cursor]);
            assert!(report.paused.is_empty());
            assert_eq!(std::fs::metadata(&dest).unwrap().modified().unwrap(), mtime);
            assert_eq!(
                provenance::read(&marker).unwrap(),
                Provenance::Bundle(provenance::BundleMarker::new(
                    SkillBundle::single(b"current bundle").hashes(),
                    None
                ))
            );
            let marker_mtime = std::fs::metadata(&marker).unwrap().modified().unwrap();
            assert_eq!(
                sync_with_source(home.path(), "current bundle").up_to_date,
                vec![HarnessId::Cursor]
            );
            assert_eq!(
                std::fs::metadata(&marker).unwrap().modified().unwrap(),
                marker_mtime
            );
            assert_eq!(
                sync_with_source(home.path(), "next bundle").updated,
                vec![HarnessId::Cursor]
            );
            assert_eq!(std::fs::read(&dest).unwrap(), b"next bundle");
        }
    }

    #[test]
    fn differing_legacy_content_is_preserved_with_a_specific_pause_reason() {
        for (legacy, reason) in [
            (None, PauseReason::Untracked),
            (
                Some(super::super::SOURCE_BUNDLED),
                PauseReason::MissingBaseline,
            ),
        ] {
            let home = TempDir::new().unwrap();
            let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
            std::fs::create_dir_all(&dir).unwrap();
            let marker = dir.join(SOURCE_MARKER_FILE);
            // Even a trailing newline is a byte difference, not an adoption match.
            std::fs::write(dir.join("SKILL.md"), "bundle\n").unwrap();
            if let Some(legacy) = legacy {
                std::fs::write(&marker, legacy).unwrap();
            }
            let report = sync_with_source(home.path(), "bundle");
            assert_eq!(report.paused, vec![(HarnessId::Cursor, reason)]);
            assert!(report.updated.is_empty());
            assert!(report.errors.is_empty());
            assert_eq!(
                std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
                "bundle\n"
            );
            assert_eq!(std::fs::read_to_string(&marker).ok().as_deref(), legacy);
        }
    }

    #[test]
    fn failed_adoption_keeps_legacy_content_and_marker_intact() {
        use super::super::storage::test_support::{assert_no_temporary_files, with_replace_hook};
        for legacy in [None, Some(super::super::SOURCE_BUNDLED)] {
            let home = TempDir::new().unwrap();
            let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), "bundle").unwrap();
            let marker = dir.join(SOURCE_MARKER_FILE);
            if let Some(legacy) = legacy {
                std::fs::write(&marker, legacy).unwrap();
            }
            let report = with_replace_hook(
                |_| Err(std::io::Error::other("injected marker failure")),
                || sync_with_source(home.path(), "bundle"),
            );
            assert_eq!(report.errors.len(), 1);
            assert!(report.up_to_date.is_empty());
            assert_eq!(std::fs::read_to_string(&marker).ok().as_deref(), legacy);
            assert_eq!(
                std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
                "bundle"
            );
            assert_no_temporary_files(&dir);
            assert_eq!(
                sync_with_source(home.path(), "bundle").up_to_date,
                vec![HarnessId::Cursor]
            );
        }
    }

    #[test]
    fn local_edits_are_preserved_until_the_recorded_content_is_restored() {
        for edited in [b"my instructions".as_slice(), b"bundle v1\n", b"\xff"] {
            let home = TempDir::new().unwrap();
            let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
            std::fs::create_dir_all(&dir).unwrap();
            let dest = dir.join("SKILL.md");
            std::fs::write(&dest, "bundle v1").unwrap();
            mark_bundled(&dest);
            let original_marker = std::fs::read(dir.join(SOURCE_MARKER_FILE)).unwrap();
            std::fs::write(&dest, edited).unwrap();
            for target in ["bundle v1", "bundle v2"] {
                let report = sync_with_source(home.path(), target);
                assert_eq!(
                    report.paused,
                    vec![(HarnessId::Cursor, PauseReason::LocalChanges)]
                );
                assert!(report.errors.is_empty());
                assert_eq!(std::fs::read(&dest).unwrap(), edited);
                assert_eq!(
                    std::fs::read(dir.join(SOURCE_MARKER_FILE)).unwrap(),
                    original_marker
                );
            }
            std::fs::write(&dest, "bundle v1").unwrap();
            assert_eq!(
                sync_with_source(home.path(), "bundle v2").updated,
                vec![HarnessId::Cursor]
            );
            assert_eq!(
                provenance::read(&dir.join(SOURCE_MARKER_FILE)).unwrap(),
                Provenance::Bundle(provenance::BundleMarker::new(
                    SkillBundle::single(b"bundle v2").hashes(),
                    None
                ))
            );
            // The updated baseline must protect edits made after an upgrade, too.
            std::fs::write(&dest, "v2 with local edits").unwrap();
            assert_eq!(
                sync_with_source(home.path(), "bundle v3").paused,
                vec![(HarnessId::Cursor, PauseReason::LocalChanges)]
            );
        }
    }
}
