//! Real pre-bundle instructions: adoption must recognize official bytes without
//! confusing custom intent, edits or unrelated references with managed content.

use std::{fs, path::Path};

use bsk::skill_install::{
    HarnessId, SOURCE_BUNDLED, SOURCE_CUSTOM, SOURCE_MARKER_FILE,
    sync::{PauseReason, sync_installed_skills},
};
use sha2::{Digest, Sha256};

const FIXTURES: &[(&str, &[u8], &str)] = &[
    (
        "root",
        include_bytes!("fixtures/legacy-skills/root.md"),
        "d50a38a62e767ecdf9cbb513ab0333d50780f74bb78ab36fc53068b26c58b4d9",
    ),
    (
        "crate",
        include_bytes!("fixtures/legacy-skills/crate.md"),
        "438d36d17d9e2b418f38fbc4c1cd4749be4473e9868d4c32c0f1fd699bc5d6b9",
    ),
];

fn line_endings(content: &[u8], crlf: bool) -> Vec<u8> {
    let source = std::str::from_utf8(content).unwrap();
    assert!(!source.contains('\r'), "frozen fixtures must remain LF");
    if crlf {
        source.replace('\n', "\r\n").into_bytes()
    } else {
        content.to_vec()
    }
}

fn seed(dir: &Path, content: &[u8], marker: Option<&str>) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join("SKILL.md"), content).unwrap();
    if let Some(marker) = marker {
        fs::write(dir.join(SOURCE_MARKER_FILE), marker).unwrap();
    }
}

fn assert_package(source: &Path, installed: &Path) {
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination = installed.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            assert_package(&entry.path(), &destination);
        } else {
            assert_eq!(
                fs::read(entry.path()).unwrap(),
                fs::read(destination).unwrap()
            );
        }
    }
}

#[test]
fn skill_install_legacy_fixtures_are_exact_historical_bytes() {
    for (name, bytes, expected) in FIXTURES {
        let hash: String = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(hash, *expected, "{name}");
    }
}

#[test]
fn skill_install_legacy_official_files_migrate_with_lf_or_crlf() {
    for (name, bytes, _) in FIXTURES {
        for crlf in [false, true] {
            for marker in [None, Some(SOURCE_BUNDLED)] {
                let home = tempfile::tempdir().unwrap();
                let dir = HarnessId::Workbuddy.skill_dest_dir_for_home(home.path());
                seed(&dir, &line_endings(bytes, crlf), marker);
                let report = sync_installed_skills(home.path());
                assert_eq!(
                    report.updated,
                    [HarnessId::Workbuddy],
                    "{name}, crlf={crlf}, marker={marker:?}: {report:?}"
                );
                assert!(report.errors.is_empty());
                assert_package(&Path::new(env!("CARGO_MANIFEST_DIR")).join("skill"), &dir);
                assert_eq!(
                    sync_installed_skills(home.path()).up_to_date,
                    [HarnessId::Workbuddy]
                );
            }
        }
    }
}

#[test]
fn skill_install_legacy_custom_intent_and_edits_are_preserved() {
    for (name, bytes, _) in FIXTURES {
        for crlf in [false, true] {
            let official = line_endings(bytes, crlf);
            let mut appended = official.clone();
            appended.extend_from_slice(b"\nUser rule: keep this customization.\n");
            let mut removed_newline = official.clone();
            removed_newline.pop();
            let mut changed = official.clone();
            changed[0] = b'#';
            for content in [&official, &appended, &removed_newline, &changed] {
                for marker in [None, Some(SOURCE_BUNDLED), Some(SOURCE_CUSTOM)] {
                    if content == &official && marker != Some(SOURCE_CUSTOM) {
                        continue;
                    }
                    let home = tempfile::tempdir().unwrap();
                    let dir = HarnessId::Workbuddy.skill_dest_dir_for_home(home.path());
                    seed(&dir, content, marker);
                    let report = sync_installed_skills(home.path());
                    assert!(report.errors.is_empty(), "{report:?}");
                    if marker == Some(SOURCE_CUSTOM) {
                        assert_eq!(report.protected, [HarnessId::Workbuddy]);
                    } else {
                        let reason = if marker.is_none() {
                            PauseReason::Untracked
                        } else {
                            PauseReason::MissingBaseline
                        };
                        assert_eq!(
                            report.paused,
                            [(HarnessId::Workbuddy, reason)],
                            "{name}, crlf={crlf}"
                        );
                    }
                    assert_eq!(fs::read(dir.join("SKILL.md")).unwrap(), *content);
                    assert_eq!(
                        fs::read_to_string(dir.join(SOURCE_MARKER_FILE))
                            .ok()
                            .as_deref(),
                        marker
                    );
                    assert!(!dir.join("references").exists());
                }
            }
        }
    }
}

#[test]
fn skill_install_legacy_adoption_does_not_overwrite_reference_collisions() {
    for (_, bytes, _) in FIXTURES {
        for crlf in [false, true] {
            let home = tempfile::tempdir().unwrap();
            let dir = HarnessId::Workbuddy.skill_dest_dir_for_home(home.path());
            let content = line_endings(bytes, crlf);
            seed(&dir, &content, Some(SOURCE_BUNDLED));
            fs::create_dir(dir.join("references")).unwrap();
            fs::write(dir.join("references/files.md"), "User reference").unwrap();
            let report = sync_installed_skills(home.path());
            assert_eq!(
                report.paused,
                [(HarnessId::Workbuddy, PauseReason::LocalChanges)]
            );
            assert_eq!(fs::read(dir.join("SKILL.md")).unwrap(), content);
            assert_eq!(
                fs::read_to_string(dir.join("references/files.md")).unwrap(),
                "User reference"
            );
            assert_eq!(
                fs::read_to_string(dir.join(SOURCE_MARKER_FILE)).unwrap(),
                SOURCE_BUNDLED
            );
        }
    }
}

#[test]
fn skill_install_legacy_recorded_checksums_still_require_exact_bytes() {
    for (_, bytes, hash) in FIXTURES {
        let home = tempfile::tempdir().unwrap();
        let dir = HarnessId::Workbuddy.skill_dest_dir_for_home(home.path());
        let marker =
            serde_json::json!({"version": 1, "source": "bundled", "sha256": hash}).to_string();
        let converted = line_endings(bytes, true);
        seed(&dir, &converted, Some(&marker));
        assert_eq!(
            sync_installed_skills(home.path()).paused,
            [(HarnessId::Workbuddy, PauseReason::LocalChanges)]
        );
        assert_eq!(fs::read(dir.join("SKILL.md")).unwrap(), converted);
        assert_eq!(
            fs::read_to_string(dir.join(SOURCE_MARKER_FILE)).unwrap(),
            marker
        );
        // A checksum recorded for those CRLF bytes is a valid baseline.
        let crlf_hash: String = Sha256::digest(&converted)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let marker =
            serde_json::json!({"version": 1, "source": "bundled", "sha256": crlf_hash}).to_string();
        fs::write(dir.join(SOURCE_MARKER_FILE), marker).unwrap();
        assert_eq!(
            sync_installed_skills(home.path()).updated,
            [HarnessId::Workbuddy]
        );
    }
}
