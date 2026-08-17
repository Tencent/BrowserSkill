//! Keep installed `SKILL.md` files in sync with the `bsk` binary's
//! bundled copy. Best-effort: I/O errors are recorded, never thrown.

use std::path::Path;

use super::{
    DEFAULT_SKILL_MD, SOURCE_CUSTOM, SOURCE_MARKER_FILE, bundled_source_marker, harness::HarnessId,
};

/// Per-harness outcome of a sync pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Harnesses whose on-disk `SKILL.md` differed and was rewritten.
    pub updated: Vec<HarnessId>,
    /// Harnesses whose on-disk `SKILL.md` already matched the bundled
    /// content; no write happened, mtime preserved.
    pub up_to_date: Vec<HarnessId>,
    /// Harnesses whose skill is custom, manually edited, or from a
    /// marker-less historical install. Automatic sync preserves it.
    pub preserved: Vec<HarnessId>,
    /// Harnesses that have an installed `SKILL.md` but the sync attempt
    /// failed with an I/O error. The string is a human-readable detail.
    pub errors: Vec<(HarnessId, String)>,
}

/// Iterates `HarnessId::ALL`, syncing harnesses with an existing
/// `SKILL.md` and leaving the rest untouched.
pub fn sync_installed_skills(home: &Path) -> SyncReport {
    sync_with_source(home, DEFAULT_SKILL_MD)
}

/// Test seam: lets unit tests inject a synthetic "bundled" payload.
pub(crate) fn sync_with_source(home: &Path, source: &str) -> SyncReport {
    let mut report = SyncReport::default();
    for &harness in HarnessId::ALL {
        let dest = harness.skill_dest_dir_for_home(home).join("SKILL.md");
        match sync_one(&dest, source) {
            SyncOne::Missing => continue,
            SyncOne::UpToDate => report.up_to_date.push(harness),
            SyncOne::Updated => report.updated.push(harness),
            SyncOne::Preserved => report.preserved.push(harness),
            SyncOne::Error(msg) => report.errors.push((harness, msg)),
        }
    }
    report
}

enum SyncOne {
    Missing,
    UpToDate,
    Updated,
    Preserved,
    Error(String),
}

fn sync_one(dest: &Path, source: &str) -> SyncOne {
    if !dest.is_file() {
        return SyncOne::Missing;
    }
    let on_disk = match std::fs::read_to_string(dest) {
        Ok(s) => s,
        Err(err) => return SyncOne::Error(format!("read {}: {err}", dest.display())),
    };
    let marker = dest
        .parent()
        .expect("SKILL.md destination must have a parent")
        .join(SOURCE_MARKER_FILE);
    let managed_marker = match std::fs::read_to_string(&marker) {
        Ok(value) if value == SOURCE_CUSTOM => return SyncOne::Preserved,
        Ok(value) if value.starts_with("bundled:") => value,
        Ok(_) => return SyncOne::Preserved,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if on_disk != source {
                return SyncOne::Preserved;
            }
            let marker_value = bundled_source_marker(source);
            if let Err(err) = std::fs::write(&marker, &marker_value) {
                return SyncOne::Error(format!("write {}: {err}", marker.display()));
            }
            return SyncOne::UpToDate;
        }
        Err(err) => return SyncOne::Error(format!("read {}: {err}", marker.display())),
    };
    if managed_marker != bundled_source_marker(&on_disk) {
        return SyncOne::Preserved;
    }
    if on_disk == source {
        return SyncOne::UpToDate;
    }
    // Atomic replace: write tmp, rename over. Including pid in the
    // tmp suffix avoids concurrent processes racing on the same path.
    let tmp = dest.with_extension(format!("md.tmp.{}", std::process::id()));
    if let Err(err) = std::fs::write(&tmp, source) {
        // Best-effort cleanup of any partial tmp left by a half-written attempt.
        let _ = std::fs::remove_file(&tmp);
        return SyncOne::Error(format!("write {}: {err}", tmp.display()));
    }
    if let Err(err) = std::fs::rename(&tmp, dest) {
        // Best-effort cleanup of the orphan tmp file.
        let _ = std::fs::remove_file(&tmp);
        return SyncOne::Error(format!(
            "rename {} -> {}: {err}",
            tmp.display(),
            dest.display()
        ));
    }
    if let Err(err) = std::fs::write(&marker, bundled_source_marker(source)) {
        return SyncOne::Error(format!("write {}: {err}", marker.display()));
    }
    SyncOne::Updated
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn mark_bundled(dest: &Path, content: &str) {
        std::fs::write(
            dest.parent().unwrap().join(SOURCE_MARKER_FILE),
            bundled_source_marker(content),
        )
        .unwrap();
    }

    #[test]
    fn sync_skips_uninstalled_harness() {
        let tmp = TempDir::new().unwrap();
        let report = sync_with_source(tmp.path(), "anything");
        assert!(report.updated.is_empty());
        assert!(report.up_to_date.is_empty());
        assert!(report.preserved.is_empty());
        assert!(report.errors.is_empty());
        // Defensive: sync must not silently create files in harnesses that
        // never had the skill installed. This guards Task 2's real impl.
        let dest = HarnessId::Cursor
            .skill_dest_dir_for_home(tmp.path())
            .join("SKILL.md");
        assert!(
            !dest.exists(),
            "sync should not create files for uninstalled harnesses"
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
        mark_bundled(&dest, "old content");

        let report = sync_with_source(home, "fresh content");

        assert_eq!(report.updated, vec![HarnessId::Cursor]);
        assert!(report.up_to_date.is_empty());
        assert!(report.errors.is_empty());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "fresh content");
        // Atomicity guard: no orphan tmp files matching SKILL.md.tmp.* should
        // remain after a successful sync (regardless of pid suffix).
        let leftovers: Vec<_> = std::fs::read_dir(&dest_dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name())
            .filter(|name| name.to_string_lossy().starts_with("SKILL.md.tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no SKILL.md.tmp.* files should remain after sync, found: {leftovers:?}"
        );
    }

    #[test]
    fn sync_skips_when_up_to_date() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let dest_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("SKILL.md");
        std::fs::write(&dest, "frozen content").unwrap();
        mark_bundled(&dest, "frozen content");
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
        mark_bundled(&cursor_dir.join("SKILL.md"), "old");

        // Codex: parent dir set to r-x. Reads still succeed, but creating
        // SKILL.md.tmp fails → exercises sync_one's write-tmp error branch.
        let codex_dir = HarnessId::Codex.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(codex_dir.join("SKILL.md"), "old").unwrap();
        mark_bundled(&codex_dir.join("SKILL.md"), "old");
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
    fn sync_preserves_custom_edited_and_unknown_skills() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();

        let custom_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&custom_dir).unwrap();
        std::fs::write(custom_dir.join("SKILL.md"), "custom content").unwrap();
        std::fs::write(custom_dir.join(SOURCE_MARKER_FILE), SOURCE_CUSTOM).unwrap();

        let edited_dir = HarnessId::Codex.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&edited_dir).unwrap();
        std::fs::write(edited_dir.join("SKILL.md"), "managed then edited").unwrap();
        mark_bundled(&edited_dir.join("SKILL.md"), "original managed content");

        let unknown_dir = HarnessId::ClaudeCode.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&unknown_dir).unwrap();
        std::fs::write(unknown_dir.join("SKILL.md"), "historical content").unwrap();

        let report = sync_with_source(home, "new bundled content");

        assert_eq!(
            report.preserved,
            vec![HarnessId::Codex, HarnessId::ClaudeCode, HarnessId::Cursor]
        );
        assert_eq!(
            std::fs::read_to_string(custom_dir.join("SKILL.md")).unwrap(),
            "custom content"
        );
        assert_eq!(
            std::fs::read_to_string(edited_dir.join("SKILL.md")).unwrap(),
            "managed then edited"
        );
        assert_eq!(
            std::fs::read_to_string(unknown_dir.join("SKILL.md")).unwrap(),
            "historical content"
        );
    }

    #[test]
    fn sync_adopts_markerless_current_bundle_then_updates_it() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let dest_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("SKILL.md");
        std::fs::write(&dest, "current bundle").unwrap();

        let first = sync_with_source(home, "current bundle");
        assert_eq!(first.up_to_date, vec![HarnessId::Cursor]);
        assert_eq!(
            std::fs::read_to_string(dest_dir.join(SOURCE_MARKER_FILE)).unwrap(),
            bundled_source_marker("current bundle")
        );

        let second = sync_with_source(home, "next bundle");
        assert_eq!(second.updated, vec![HarnessId::Cursor]);
        assert_eq!(std::fs::read_to_string(dest).unwrap(), "next bundle");
    }
}
