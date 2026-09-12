//! Install bundled or custom browser-skill instructions into agent skill directories.

pub mod harness;
mod provenance;
mod storage;
pub mod sync;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use console::{Style, style};
use dialoguer::{MultiSelect, theme::ColorfulTheme};
use serde::{Deserialize, Serialize};

pub use harness::{HarnessId, HarnessReport, all_harness_reports, parse_harness_id};

pub const SKILL_DIR_NAME: &str = "browser-skill";
pub const DEFAULT_SKILL_MD: &str = include_str!("../../skill/SKILL.md");
pub const SOURCE_MARKER_FILE: &str = ".bsk-source";
pub const SOURCE_BUNDLED: &str = "bundled\n";
pub const SOURCE_CUSTOM: &str = "custom\n";

/// Installation provenance is explicit: even an identical `--source` is custom.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    Bundled,
    Custom,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub harness: String,
    pub path: PathBuf,
    pub status: InstallStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallStatus {
    Installed,
    Updated,
    Skipped,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallSkillOutput {
    pub results: Vec<InstallResult>,
    pub errors: Vec<InstallError>,
}

/// JSON envelope for `bsk install-skill --json` (single document, includes exit metadata).
#[derive(Debug, Clone, Serialize)]
pub struct InstallSkillJsonOutput {
    pub success: bool,
    pub exit_code: u8,
    pub results: Vec<InstallResult>,
    pub errors: Vec<InstallError>,
}

impl InstallSkillOutput {
    pub fn success(&self) -> bool {
        self.errors.is_empty()
    }

    pub fn exit_code(&self) -> u8 {
        u8::from(!self.success())
    }

    pub fn to_json_output(&self) -> InstallSkillJsonOutput {
        InstallSkillJsonOutput {
            success: self.success(),
            exit_code: self.exit_code(),
            results: self.results.clone(),
            errors: self.errors.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallError {
    pub harness: String,
    pub message: String,
}

pub struct InstallOptions<'a> {
    pub harnesses: &'a [HarnessId],
    pub source: &'a str,
    pub source_kind: SkillSource,
    pub force: bool,
    /// When `Some`, installs under this home instead of the real `$HOME`.
    pub home: Option<&'a Path>,
}

pub fn install_to_harnesses(opts: &InstallOptions<'_>) -> InstallSkillOutput {
    let home = match opts.home {
        Some(home) => home.to_path_buf(),
        None => match harness::home_dir() {
            Ok(home) => home,
            Err(err) => {
                return InstallSkillOutput {
                    results: Vec::new(),
                    errors: vec![InstallError {
                        harness: "*".to_string(),
                        message: err.to_string(),
                    }],
                };
            }
        },
    };
    install_to_harnesses_at_home(&home, opts)
}

pub fn install_to_harnesses_at_home(home: &Path, opts: &InstallOptions<'_>) -> InstallSkillOutput {
    let mut results = Vec::new();
    let mut errors = Vec::new();

    for harness in opts.harnesses {
        match install_one_at_home(home, *harness, opts.source, opts.source_kind, opts.force) {
            Ok((path, status)) => results.push(InstallResult {
                harness: harness.cli_name().to_string(),
                path,
                status,
            }),
            Err(err) => errors.push(InstallError {
                harness: harness.cli_name().to_string(),
                message: format!("{err:#}"),
            }),
        }
    }

    InstallSkillOutput { results, errors }
}

fn install_one_at_home(
    home: &Path,
    harness: HarnessId,
    source: &str,
    source_kind: SkillSource,
    force: bool,
) -> Result<(PathBuf, InstallStatus)> {
    let dest_dir = harness.skill_dest_dir_for_home(home);
    let dest_file = dest_dir.join("SKILL.md");

    // A no-op install needs no write access. Recheck under the lock before writing
    // so two installers that both observed a missing file cannot overwrite it.
    if dest_file.exists() && !force {
        return Ok((dest_file, InstallStatus::Skipped));
    }
    fs::create_dir_all(&dest_dir).with_context(|| format!("create {}", dest_dir.display()))?;
    let _lock = storage::SkillLock::acquire(&dest_dir)
        .with_context(|| format!("lock {}", dest_dir.display()))?;

    if dest_file.exists() && !force {
        return Ok((dest_file, InstallStatus::Skipped));
    }

    let existed = dest_file.exists();
    let marker = dest_dir.join(SOURCE_MARKER_FILE);
    match source_kind {
        SkillSource::Custom => {
            let content = storage::PendingWrite::prepare(&dest_file, source)?;
            // Protection must be established before any custom content appears.
            storage::PendingWrite::prepare(&marker, SOURCE_CUSTOM)?.commit()?;
            content
                .commit()
                .context("custom protection recorded, but skill content was not replaced")?;
        }
        SkillSource::Bundled => {
            write_bundled_skill(&dest_file, source)?;
        }
    }

    let status = if existed {
        InstallStatus::Updated
    } else {
        InstallStatus::Installed
    };
    Ok((dest_file, status))
}

/// Callers hold the skill lock. Publish the baseline only after its content;
/// a failed marker replacement leaves a conservative, detectable mismatch.
fn write_bundled_skill(dest: &Path, source: &str) -> Result<()> {
    let content = storage::PendingWrite::prepare(dest, source)?;
    let marker = dest
        .parent()
        .context("skill destination has no parent")?
        .join(SOURCE_MARKER_FILE);
    let metadata = provenance::bundled_marker(source.as_bytes())?;
    let marker = storage::PendingWrite::prepare(&marker, &metadata)?;
    content.commit()?;
    marker
        .commit()
        .context("bundled skill content installed, but its source marker was not updated")
}

/// Harnesses visible in the interactive installer (detected on this machine only).
pub fn interactive_candidates(reports: &[HarnessReport]) -> Vec<&HarnessReport> {
    reports.iter().filter(|report| report.detected).collect()
}

pub fn harness_ids_from_indices(
    reports: &[HarnessReport],
    indices: &[usize],
) -> Result<Vec<HarnessId>> {
    if indices.is_empty() {
        bail!("no harnesses selected");
    }
    let mut selected = Vec::with_capacity(indices.len());
    for &index in indices {
        let Some(report) = reports.get(index) else {
            bail!("invalid selection index {index}");
        };
        selected.push(report.id);
    }
    selected.sort_by_key(|id| id.index());
    selected.dedup();
    Ok(selected)
}

fn install_skill_theme() -> ColorfulTheme {
    ColorfulTheme {
        prompt_style: Style::new().for_stderr().bold().yellow(),
        prompt_prefix: style("▸".to_string()).for_stderr().yellow(),
        prompt_suffix: style("›".to_string()).for_stderr().dim(),
        success_prefix: style("✔".to_string()).for_stderr().green(),
        hint_style: Style::new().for_stderr().dim(),
        active_item_style: Style::new().for_stderr().cyan().bold(),
        inactive_item_style: Style::new().for_stderr().dim(),
        checked_item_prefix: style("●".to_string()).for_stderr().green(),
        unchecked_item_prefix: style("○".to_string()).for_stderr().dim(),
        active_item_prefix: style("❯".to_string()).for_stderr().cyan(),
        ..ColorfulTheme::default()
    }
}

fn format_multi_select_item(report: &HarnessReport) -> String {
    let name = style(report.id.display_name()).bold().yellow();
    let path = style(report.skills_dir.display().to_string()).dim();
    let installed = if report.installed {
        format!("  {}", style("installed").green())
    } else {
        String::new()
    };
    format!("{name}  {path}{installed}")
}

/// Interactive harness picker: vertical list, Space toggles, Enter confirms.
pub fn run_interactive_prompt(reports: &[HarnessReport]) -> Result<Vec<HarnessId>> {
    let candidates = interactive_candidates(reports);
    if candidates.is_empty() {
        bail!(
            "no Agent harness detected on this machine; use `bsk install-skill --list` to check paths, or use `--harness <id>` to install manually"
        );
    }

    eprintln!(
        "\n{}",
        style(" browser-skill · Install Agent Skill")
            .bold()
            .yellow()
    );
    eprintln!(
        "{}",
        style(" shows detected harnesses only · unchecked by default · space to toggle · enter to confirm").dim()
    );

    let items: Vec<String> = candidates
        .iter()
        .map(|report| format_multi_select_item(report))
        .collect();
    let theme = install_skill_theme();

    loop {
        let indices = MultiSelect::with_theme(&theme)
            .with_prompt("select harnesses to install")
            .items(&items)
            .defaults(&vec![false; items.len()])
            .interact()
            .map_err(|err| match err {
                dialoguer::Error::IO(io_err)
                    if io_err.kind() == std::io::ErrorKind::Interrupted =>
                {
                    anyhow::anyhow!("cancelled")
                }
                other => anyhow::anyhow!("interactive prompt failed: {other}"),
            })?;

        if indices.is_empty() {
            eprintln!(
                "{}",
                style(" ⚠  nothing selected — use Space to check a harness, then press Enter")
                    .yellow()
            );
            continue;
        }

        let mut selected: Vec<HarnessId> = indices
            .into_iter()
            .map(|index| candidates[index].id)
            .collect();
        selected.sort_by_key(|id| id.index());
        selected.dedup();
        return Ok(selected);
    }
}

pub fn print_harness_table(reports: &[HarnessReport], heading: &str) {
    eprint!("{heading}");
    for (index, report) in reports.iter().enumerate() {
        let marker = if report.detected { "detected" } else { "—" };
        let installed = if report.installed {
            ", skill installed"
        } else {
            ""
        };
        eprintln!(
            "  {}. [{marker:9}] {:18} → {}{installed}",
            index + 1,
            report.id.display_name(),
            report.skills_dir.display(),
        );
        if let Some(detail) = &report.detection_detail {
            eprintln!("       ({detail})");
        }
    }
}

pub fn load_source(path: Option<&Path>) -> Result<String> {
    match path {
        Some(path) => {
            let meta = fs::metadata(path)
                .with_context(|| format!("read skill source {}", path.display()))?;
            if !meta.is_file() {
                bail!("skill source must be a file: {}", path.display());
            }
            fs::read_to_string(path)
                .with_context(|| format!("read skill source {}", path.display()))
        }
        None => Ok(DEFAULT_SKILL_MD.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn install_writes_skill_md() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().to_path_buf();
        let harness = HarnessId::Cursor;
        let skills = harness.skills_dir_for_home(&home);
        let report = harness.report_for_home(&home);
        assert!(report.skills_dir.ends_with("skills"));

        let out = install_to_harnesses_at_home(
            &home,
            &InstallOptions {
                harnesses: &[harness],
                source: "# test skill\n",
                source_kind: SkillSource::Custom,
                force: false,
                home: Some(&home),
            },
        );
        assert!(out.errors.is_empty());
        assert_eq!(out.results.len(), 1);
        assert!(skills.join(SKILL_DIR_NAME).join("SKILL.md").is_file());
        assert_eq!(
            fs::read_to_string(skills.join(SKILL_DIR_NAME).join(SOURCE_MARKER_FILE)).unwrap(),
            SOURCE_CUSTOM
        );
    }

    #[test]
    fn skipped_when_exists_without_force() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().to_path_buf();
        let harness = HarnessId::Cursor;
        let dest = harness
            .skills_dir_for_home(&home)
            .join(SKILL_DIR_NAME)
            .join("SKILL.md");
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, "old").unwrap();

        let out = install_to_harnesses_at_home(
            &home,
            &InstallOptions {
                harnesses: &[harness],
                source: "new",
                source_kind: SkillSource::Custom,
                force: false,
                home: Some(&home),
            },
        );
        assert_eq!(out.results[0].status, InstallStatus::Skipped);
        assert_eq!(fs::read_to_string(&dest).unwrap(), "old");
    }

    #[test]
    fn force_overwrites_existing_skill() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().to_path_buf();
        let harness = HarnessId::Cursor;
        let dest = harness
            .skills_dir_for_home(&home)
            .join(SKILL_DIR_NAME)
            .join("SKILL.md");
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(&dest, "old").unwrap();

        let out = install_to_harnesses_at_home(
            &home,
            &InstallOptions {
                harnesses: &[harness],
                source: "new",
                source_kind: SkillSource::Custom,
                force: true,
                home: Some(&home),
            },
        );
        assert_eq!(out.results[0].status, InstallStatus::Updated);
        assert_eq!(fs::read_to_string(&dest).unwrap(), "new");
        assert_eq!(
            fs::read_to_string(dest.parent().unwrap().join(SOURCE_MARKER_FILE)).unwrap(),
            SOURCE_CUSTOM
        );
    }

    #[test]
    fn bundled_install_is_marked_as_managed() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().to_path_buf();
        let harness = HarnessId::Cursor;

        let out = install_to_harnesses_at_home(
            &home,
            &InstallOptions {
                harnesses: &[harness],
                source: DEFAULT_SKILL_MD,
                source_kind: SkillSource::Bundled,
                force: false,
                home: Some(&home),
            },
        );

        assert!(out.errors.is_empty());
        let marker = harness
            .skill_dest_dir_for_home(&home)
            .join(SOURCE_MARKER_FILE);
        assert_eq!(
            provenance::read(&marker).unwrap(),
            provenance::Provenance::Bundled {
                sha256: provenance::digest(DEFAULT_SKILL_MD.as_bytes()),
            }
        );
    }

    #[test]
    fn custom_install_survives_automatic_bundled_sync() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().to_path_buf();
        let harness = HarnessId::Cursor;
        let dest = harness.skill_dest_dir_for_home(&home).join("SKILL.md");

        let out = install_to_harnesses_at_home(
            &home,
            &InstallOptions {
                harnesses: &[harness],
                source: "custom instructions",
                source_kind: SkillSource::Custom,
                force: false,
                home: Some(&home),
            },
        );
        assert!(out.errors.is_empty());

        let report = sync::sync_with_source(&home, "new bundled instructions");

        assert_eq!(report.protected, vec![HarnessId::Cursor]);
        assert_eq!(fs::read_to_string(dest).unwrap(), "custom instructions");
    }

    #[test]
    fn skipped_install_does_not_claim_or_change_provenance() {
        for marker in [None, Some(SOURCE_CUSTOM), Some(SOURCE_BUNDLED)] {
            let home = TempDir::new().unwrap();
            let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("SKILL.md"), "keep").unwrap();
            if let Some(marker) = marker {
                fs::write(dir.join(SOURCE_MARKER_FILE), marker).unwrap();
            }
            let (_, status) = install_one_at_home(
                home.path(),
                HarnessId::Cursor,
                DEFAULT_SKILL_MD,
                SkillSource::Bundled,
                false,
            )
            .unwrap();
            assert_eq!(status, InstallStatus::Skipped);
            assert_eq!(fs::read_to_string(dir.join("SKILL.md")).unwrap(), "keep");
            assert!(!dir.join(".bsk.lock").exists());
            assert_eq!(
                fs::read_to_string(dir.join(SOURCE_MARKER_FILE))
                    .ok()
                    .as_deref(),
                marker
            );
        }
    }

    #[test]
    fn failed_install_keeps_content_and_provenance_safe() {
        use storage::test_support::{assert_no_temporary_files, with_replace_hook};

        for kind in [SkillSource::Custom, SkillSource::Bundled] {
            for failed_file in ["SKILL.md", SOURCE_MARKER_FILE] {
                let home = TempDir::new().unwrap();
                let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
                let old_kind = if kind == SkillSource::Custom {
                    SkillSource::Bundled
                } else {
                    SkillSource::Custom
                };
                install_one_at_home(
                    home.path(),
                    HarnessId::Cursor,
                    "old content",
                    old_kind,
                    false,
                )
                .unwrap();
                let original_marker = fs::read_to_string(dir.join(SOURCE_MARKER_FILE)).unwrap();
                let error = with_replace_hook(
                    move |dest| {
                        if dest.file_name().unwrap() == failed_file {
                            Err(std::io::Error::other("injected replacement failure"))
                        } else {
                            Ok(())
                        }
                    },
                    || {
                        install_one_at_home(
                            home.path(),
                            HarnessId::Cursor,
                            "new content",
                            kind,
                            true,
                        )
                    },
                )
                .unwrap_err();
                assert!(format!("{error:#}").contains("injected replacement failure"));
                let bundled_content_installed =
                    kind == SkillSource::Bundled && failed_file == SOURCE_MARKER_FILE;
                let expected_content = if bundled_content_installed {
                    "new content"
                } else {
                    "old content"
                };
                assert_eq!(
                    fs::read_to_string(dir.join("SKILL.md")).unwrap(),
                    expected_content
                );
                if bundled_content_installed {
                    assert!(
                        error
                            .to_string()
                            .contains("bundled skill content installed")
                    );
                }
                let still_bundled =
                    kind == SkillSource::Custom && failed_file == SOURCE_MARKER_FILE;
                let expected_marker = if still_bundled {
                    original_marker.as_str()
                } else {
                    SOURCE_CUSTOM
                };
                assert_eq!(
                    fs::read_to_string(dir.join(SOURCE_MARKER_FILE)).unwrap(),
                    expected_marker
                );
                assert_no_temporary_files(&dir);
                let report = sync::sync_with_source(home.path(), "next bundled version");
                if still_bundled {
                    assert_eq!(report.updated, vec![HarnessId::Cursor]);
                } else {
                    assert_eq!(report.protected, vec![HarnessId::Cursor]);
                    assert_eq!(
                        fs::read_to_string(dir.join("SKILL.md")).unwrap(),
                        expected_content
                    );
                }
            }
        }
    }

    #[test]
    fn sync_defers_during_custom_install_then_preserves_it() {
        use std::sync::mpsc;
        use std::time::Duration;
        use storage::test_support::with_replace_hook;

        let home = TempDir::new().unwrap();
        install_one_at_home(
            home.path(),
            HarnessId::Cursor,
            "old bundled",
            SkillSource::Bundled,
            false,
        )
        .unwrap();
        let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
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
                || {
                    install_one_at_home(
                        &worker_home,
                        HarnessId::Cursor,
                        "custom",
                        SkillSource::Custom,
                        true,
                    )
                },
            )
        });
        ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let during = sync::sync_with_source(home.path(), "new bundled");
        assert_eq!(during.busy, vec![HarnessId::Cursor]);
        assert!(during.updated.is_empty());
        assert!(during.errors.is_empty());
        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "old bundled"
        );
        assert_eq!(
            fs::read_to_string(dir.join(SOURCE_MARKER_FILE)).unwrap(),
            SOURCE_CUSTOM
        );
        resume_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        let after = sync::sync_with_source(home.path(), "new bundled");
        assert_eq!(after.protected, vec![HarnessId::Cursor]);
        assert_eq!(fs::read_to_string(dir.join("SKILL.md")).unwrap(), "custom");
    }

    #[test]
    fn forced_bundled_install_resumes_management() {
        let home = TempDir::new().unwrap();
        install_one_at_home(
            home.path(),
            HarnessId::Cursor,
            "custom",
            SkillSource::Custom,
            false,
        )
        .unwrap();
        install_one_at_home(
            home.path(),
            HarnessId::Cursor,
            DEFAULT_SKILL_MD,
            SkillSource::Bundled,
            true,
        )
        .unwrap();
        let report = sync::sync_with_source(home.path(), "new bundled");
        assert_eq!(report.updated, vec![HarnessId::Cursor]);
        assert_eq!(
            fs::read_to_string(
                HarnessId::Cursor
                    .skill_dest_dir_for_home(home.path())
                    .join("SKILL.md")
            )
            .unwrap(),
            "new bundled"
        );
    }

    #[test]
    fn interactive_candidates_omit_undetected() {
        let reports = vec![
            HarnessReport {
                id: HarnessId::Cursor,
                skills_dir: PathBuf::from("/tmp/cursor/skills"),
                detected: true,
                detection_detail: None,
                installed: false,
            },
            HarnessReport {
                id: HarnessId::Codex,
                skills_dir: PathBuf::from("/tmp/codex/skills"),
                detected: false,
                detection_detail: None,
                installed: false,
            },
        ];
        let candidates = interactive_candidates(&reports);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].id, HarnessId::Cursor);
    }

    #[test]
    fn json_output_reports_failure_exit_code() {
        let output = InstallSkillOutput {
            results: Vec::new(),
            errors: vec![InstallError {
                harness: "cursor".into(),
                message: "boom".into(),
            }],
        };
        let json = output.to_json_output();
        assert!(!json.success);
        assert_eq!(json.exit_code, 1);
    }
}
