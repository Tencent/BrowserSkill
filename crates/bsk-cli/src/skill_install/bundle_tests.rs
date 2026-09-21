use super::storage::test_support::with_replace_hook;
use super::*;
use std::collections::BTreeMap;
use sync::{PauseReason, sync_with_bundle};

fn bundle(main: &str, resources: &[(&str, &str)]) -> SkillBundle {
    let mut result = SkillBundle::single(main);
    for (name, content) in resources {
        result
            .files
            .insert((*name).into(), content.as_bytes().to_vec());
    }
    result
}

fn install(home: &Path, source: &SkillBundle, kind: SkillSource, force: bool) -> PathBuf {
    install_one_at_home(home, HarnessId::Cursor, source, kind, force).unwrap();
    HarnessId::Cursor.skill_dest_dir_for_home(home)
}

fn assert_bundle(dir: &Path, source: &SkillBundle) {
    for (name, bytes) in &source.files {
        assert_eq!(&fs::read(dir.join(name)).unwrap(), bytes, "{name}");
    }
    assert_eq!(
        provenance::read(&dir.join(SOURCE_MARKER_FILE)).unwrap(),
        provenance::Provenance::Bundle(provenance::BundleMarker::new(source.hashes(), None))
    );
}

#[test]
fn default_install_contains_every_embedded_resource() {
    let home = tempfile::tempdir().unwrap();
    let source = load_source(None).unwrap();
    let authored = SkillBundle::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("skill")).unwrap();
    assert_eq!(
        source.files, authored.files,
        "embedded package must include every authored resource"
    );
    assert!(source.files.contains_key("references/files.md"));
    assert!(source.files.contains_key("references/help-and-recovery.md"));
    let dir = install(home.path(), &source, SkillSource::Bundled, false);
    assert_bundle(&dir, &source);
    let mtimes: BTreeMap<_, _> = source
        .files
        .keys()
        .map(|name| {
            (
                name,
                fs::metadata(dir.join(name)).unwrap().modified().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        sync_with_bundle(home.path(), &source).up_to_date,
        [HarnessId::Cursor]
    );
    for (name, mtime) in mtimes {
        assert_eq!(
            fs::metadata(dir.join(name)).unwrap().modified().unwrap(),
            mtime
        );
    }
}

#[test]
fn custom_sources_support_single_files_and_complete_directories() {
    let home = tempfile::tempdir().unwrap();
    let source_dir = tempfile::tempdir().unwrap();
    fs::create_dir(source_dir.path().join("references")).unwrap();
    fs::write(source_dir.path().join("SKILL.md"), "custom").unwrap();
    fs::write(source_dir.path().join("references/data.bin"), [0, 255, 12]).unwrap();
    fs::write(source_dir.path().join(SOURCE_MARKER_FILE), SOURCE_BUNDLED).unwrap();
    assert_eq!(
        load_source(Some(&source_dir.path().join("SKILL.md")))
            .unwrap()
            .files
            .len(),
        1
    );
    let source = load_source(Some(source_dir.path())).unwrap();
    assert_eq!(source.files.len(), 2);
    let dir = install(home.path(), &source, SkillSource::Custom, false);
    assert_eq!(
        fs::read(dir.join("references/data.bin")).unwrap(),
        [0, 255, 12]
    );
    assert_eq!(
        sync::sync_installed_skills(home.path()).protected,
        [HarnessId::Cursor]
    );
    // Reinstalling a skill from its own directory is supported, too.
    let own_source = load_source(Some(&dir)).unwrap();
    install(home.path(), &own_source, SkillSource::Custom, true);
    assert_eq!(
        fs::read(dir.join("references/data.bin")).unwrap(),
        [0, 255, 12]
    );
    fs::remove_file(source_dir.path().join("SKILL.md")).unwrap();
    assert!(load_source(Some(source_dir.path())).is_err());
}

#[test]
fn identical_custom_bundle_stays_custom() {
    let home = tempfile::tempdir().unwrap();
    let source = SkillBundle::bundled();
    let dir = install(home.path(), &source, SkillSource::Custom, false);
    assert_eq!(
        sync_with_bundle(home.path(), &source).protected,
        [HarnessId::Cursor]
    );
    assert_eq!(
        fs::read_to_string(dir.join(SOURCE_MARKER_FILE)).unwrap(),
        SOURCE_CUSTOM
    );
}

#[test]
fn version_one_single_file_installs_migrate_to_complete_bundles() {
    let home = tempfile::tempdir().unwrap();
    let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("SKILL.md"), "old official instructions").unwrap();
    fs::write(
        dir.join(SOURCE_MARKER_FILE),
        provenance::bundled_marker(b"old official instructions").unwrap(),
    )
    .unwrap();
    let source = SkillBundle::bundled();
    assert_eq!(
        sync_with_bundle(home.path(), &source).updated,
        [HarnessId::Cursor]
    );
    assert_bundle(&dir, &source);
}

#[test]
fn reference_only_changes_update_and_retired_resources_are_removed() {
    let home = tempfile::tempdir().unwrap();
    let before = bundle(
        "main",
        &[
            ("references/old.md", "retired"),
            ("references/stay.md", "v1"),
        ],
    );
    let dir = install(home.path(), &before, SkillSource::Bundled, false);
    fs::write(dir.join("references/my-notes.md"), "keep").unwrap();
    let after = bundle(
        "main",
        &[("references/new.md", "added"), ("references/stay.md", "v2")],
    );
    let mtime = fs::metadata(dir.join("SKILL.md"))
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(
        sync_with_bundle(home.path(), &after).updated,
        [HarnessId::Cursor]
    );
    assert_bundle(&dir, &after);
    assert!(!dir.join("references/old.md").exists());
    assert_eq!(
        fs::read_to_string(dir.join("references/my-notes.md")).unwrap(),
        "keep"
    );
    assert_eq!(
        fs::metadata(dir.join("SKILL.md"))
            .unwrap()
            .modified()
            .unwrap(),
        mtime
    );
}

#[test]
fn edited_or_deleted_managed_files_pause_the_entire_bundle() {
    for name in ["SKILL.md", "references/keep.md", "references/retire.md"] {
        for edited in [Some("local edit"), Some("new reference"), None] {
            let home = tempfile::tempdir().unwrap();
            let before = bundle(
                "old",
                &[
                    ("references/keep.md", "old reference"),
                    ("references/retire.md", "old"),
                ],
            );
            let dir = install(home.path(), &before, SkillSource::Bundled, false);
            let marker = fs::read(dir.join(SOURCE_MARKER_FILE)).unwrap();
            if let Some(edited) = edited {
                fs::write(dir.join(name), edited).unwrap();
            } else {
                fs::remove_file(dir.join(name)).unwrap();
            }
            let after = bundle("new", &[("references/keep.md", "new reference")]);
            let report = sync_with_bundle(home.path(), &after);
            assert_eq!(
                report.paused,
                [(HarnessId::Cursor, PauseReason::LocalChanges)],
                "{name}"
            );
            assert!(report.errors.is_empty());
            assert_eq!(fs::read(dir.join(SOURCE_MARKER_FILE)).unwrap(), marker);
            for (path, bytes) in &before.files {
                if path != name {
                    assert_eq!(fs::read(dir.join(path)).unwrap(), *bytes);
                }
            }
            assert_eq!(fs::read_to_string(dir.join(name)).ok().as_deref(), edited);
        }
    }
}

#[test]
fn new_resource_collisions_are_preserved_until_explicit_force() {
    let home = tempfile::tempdir().unwrap();
    let before = SkillBundle::single("old");
    let dir = install(home.path(), &before, SkillSource::Bundled, false);
    fs::create_dir(dir.join("references")).unwrap();
    fs::write(dir.join("references/new.md"), "user file").unwrap();
    let after = bundle("new", &[("references/new.md", "official")]);
    assert_eq!(
        sync_with_bundle(home.path(), &after).paused,
        [(HarnessId::Cursor, PauseReason::LocalChanges)]
    );
    assert_eq!(
        fs::read_to_string(dir.join("references/new.md")).unwrap(),
        "user file"
    );
    install(home.path(), &after, SkillSource::Bundled, true);
    assert_bundle(&dir, &after);
}

#[test]
fn interrupted_updates_resume_at_each_file_boundary() {
    for failed_file in [
        "references/a.md",
        "references/b.md",
        "SKILL.md",
        "final marker",
    ] {
        let home = tempfile::tempdir().unwrap();
        let before = bundle(
            "old",
            &[
                ("references/a.md", "a1"),
                ("references/retire.md", "retired"),
            ],
        );
        let dir = install(home.path(), &before, SkillSource::Bundled, false);
        let after = bundle(
            "new",
            &[("references/a.md", "a2"), ("references/b.md", "b2")],
        );
        let marker_writes = std::cell::Cell::new(0);
        let report = with_replace_hook(
            move |path| {
                if path.file_name().unwrap() == SOURCE_MARKER_FILE {
                    marker_writes.set(marker_writes.get() + 1);
                }
                if path.ends_with(failed_file)
                    || (failed_file == "final marker"
                        && path.file_name().unwrap() == SOURCE_MARKER_FILE
                        && marker_writes.get() == 2)
                {
                    Err(std::io::Error::other("interrupted"))
                } else {
                    Ok(())
                }
            },
            || sync_with_bundle(home.path(), &after),
        );
        assert_eq!(report.errors.len(), 1, "{failed_file}");
        if failed_file != "final marker" {
            assert_eq!(fs::read_to_string(dir.join("SKILL.md")).unwrap(), "old");
        }
        assert_eq!(
            sync_with_bundle(home.path(), &before).paused,
            [(HarnessId::Cursor, PauseReason::InterruptedUpdate)]
        );
        assert_eq!(
            sync_with_bundle(home.path(), &after).updated,
            [HarnessId::Cursor]
        );
        assert_bundle(&dir, &after);
        assert!(!dir.join("references/retire.md").exists());
    }
}

#[test]
fn edits_after_an_interrupted_update_are_not_mistaken_for_partial_writes() {
    let home = tempfile::tempdir().unwrap();
    let dir = install(
        home.path(),
        &SkillBundle::single("old"),
        SkillSource::Bundled,
        false,
    );
    let after = bundle("new", &[("references/a.md", "a2")]);
    let report = with_replace_hook(
        |path| {
            if path.ends_with("SKILL.md") {
                Err(std::io::Error::other("interrupted"))
            } else {
                Ok(())
            }
        },
        || sync_with_bundle(home.path(), &after),
    );
    assert_eq!(report.errors.len(), 1);
    fs::write(dir.join("references/a.md"), "edited after interruption").unwrap();
    assert_eq!(
        sync_with_bundle(home.path(), &after).paused,
        [(HarnessId::Cursor, PauseReason::LocalChanges)]
    );
    assert_eq!(fs::read_to_string(dir.join("SKILL.md")).unwrap(), "old");
}

#[test]
fn incomplete_first_install_recovers_before_entrypoint_exists() {
    let home = tempfile::tempdir().unwrap();
    let source = bundle("main", &[("references/a.md", "resource")]);
    let result = with_replace_hook(
        |path| {
            if path.ends_with("SKILL.md") {
                Err(std::io::Error::other("interrupted"))
            } else {
                Ok(())
            }
        },
        || {
            install_one_at_home(
                home.path(),
                HarnessId::Cursor,
                &source,
                SkillSource::Bundled,
                false,
            )
        },
    );
    assert!(result.is_err());
    assert_eq!(
        sync_with_bundle(home.path(), &source).updated,
        [HarnessId::Cursor]
    );
    assert_bundle(
        &HarnessId::Cursor.skill_dest_dir_for_home(home.path()),
        &source,
    );
}

#[test]
fn malformed_manifests_cannot_escape_the_skill_directory() {
    for name in [
        "../outside",
        "/absolute",
        "references/../../outside",
        "C:/outside",
        "references\\outside",
        ".bsk-source",
    ] {
        let home = tempfile::tempdir().unwrap();
        let source = SkillBundle::single("main");
        let dir = install(home.path(), &source, SkillSource::Bundled, false);
        let mut files = source.hashes();
        files.insert(name.into(), provenance::digest(b"outside"));
        fs::write(
            dir.join(SOURCE_MARKER_FILE),
            provenance::BundleMarker::new(files, None).encode().unwrap(),
        )
        .unwrap();
        assert_eq!(
            sync_with_bundle(home.path(), &source).paused,
            [(HarnessId::Cursor, PauseReason::InvalidMarker)]
        );
    }
}

#[cfg(unix)]
#[test]
fn symlinked_resources_are_never_read_or_overwritten() {
    use std::os::unix::fs::symlink;
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("a.md"), "private").unwrap();
    let dir = install(
        home.path(),
        &SkillBundle::single("old"),
        SkillSource::Bundled,
        false,
    );
    symlink(outside.path(), dir.join("references")).unwrap();
    let source = bundle("new", &[("references/a.md", "new")]);
    assert_eq!(sync_with_bundle(home.path(), &source).errors.len(), 1);
    assert!(
        install_one_at_home(
            home.path(),
            HarnessId::Cursor,
            &source,
            SkillSource::Bundled,
            true
        )
        .is_err()
    );
    assert!(load_source(Some(&dir)).is_err());
    assert_eq!(
        fs::read_to_string(outside.path().join("a.md")).unwrap(),
        "private"
    );
}

#[cfg(unix)]
#[test]
fn explicit_source_file_symlinks_preserve_legacy_install_behavior() {
    use std::os::unix::fs::symlink;
    let source_dir = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let source_file = source_dir.path().join("instructions.md");
    fs::write(&source_file, "My linked instructions\r\n").unwrap();
    let link = source_dir.path().join("SKILL.md");
    symlink("instructions.md", &link).unwrap();
    let source = load_source(Some(&link)).unwrap();
    let dir = install(home.path(), &source, SkillSource::Custom, false);
    assert_eq!(
        fs::read(dir.join("SKILL.md")).unwrap(),
        fs::read(&source_file).unwrap()
    );
    assert_eq!(
        fs::read_to_string(dir.join(SOURCE_MARKER_FILE)).unwrap(),
        SOURCE_CUSTOM
    );
    assert_eq!(
        sync::sync_installed_skills(home.path()).protected,
        [HarnessId::Cursor]
    );
    // Only the explicitly selected path follows links. A directory package must
    // not import the same symlink implicitly as one of its resources.
    assert!(load_source(Some(source_dir.path())).is_err());
    fs::remove_file(source_file).unwrap();
    assert!(
        load_source(Some(&link)).is_err(),
        "a broken source link must fail"
    );
}
