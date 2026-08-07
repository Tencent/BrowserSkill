//! Install the bundled browser-skill `SKILL.md` into agent harness skill directories.

pub mod harness;
pub mod sync;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use console::{Style, style};
use dialoguer::{MultiSelect, theme::ColorfulTheme};
use serde::Serialize;

pub use harness::{HarnessId, HarnessReport, all_harness_reports, parse_harness_id};

pub const SKILL_DIR_NAME: &str = "browser-skill";
pub const DEFAULT_SKILL_MD: &str = include_str!("../../skill/SKILL.md");
pub const SOURCE_MARKER_FILE: &str = ".bsk-source";
pub const SOURCE_BUNDLED: &str = "bundled\n";
pub const SOURCE_CUSTOM: &str = "custom\n";

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
        match install_one_at_home(home, *harness, opts.source, opts.force) {
            Ok((path, status)) => results.push(InstallResult {
                harness: harness.cli_name().to_string(),
                path,
                status,
            }),
            Err(err) => errors.push(InstallError {
                harness: harness.cli_name().to_string(),
                message: err.to_string(),
            }),
        }
    }

    InstallSkillOutput { results, errors }
}

fn install_one_at_home(
    home: &Path,
    harness: HarnessId,
    source: &str,
    force: bool,
) -> Result<(PathBuf, InstallStatus)> {
    let dest_dir = harness.skill_dest_dir_for_home(home);
    let dest_file = dest_dir.join("SKILL.md");

    if dest_file.exists() && !force {
        return Ok((dest_file, InstallStatus::Skipped));
    }

    let existed = dest_file.exists();
    fs::create_dir_all(&dest_dir).with_context(|| format!("create {}", dest_dir.display()))?;
    fs::write(&dest_file, source).with_context(|| format!("write {}", dest_file.display()))?;
    let source_kind = if source == DEFAULT_SKILL_MD {
        SOURCE_BUNDLED
    } else {
        SOURCE_CUSTOM
    };
    let marker = dest_dir.join(SOURCE_MARKER_FILE);
    fs::write(&marker, source_kind).with_context(|| format!("write {}", marker.display()))?;

    let status = if existed {
        InstallStatus::Updated
    } else {
        InstallStatus::Installed
    };
    Ok((dest_file, status))
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
                force: false,
                home: Some(&home),
            },
        );

        assert!(out.errors.is_empty());
        let marker = harness
            .skill_dest_dir_for_home(&home)
            .join(SOURCE_MARKER_FILE);
        assert_eq!(fs::read_to_string(marker).unwrap(), SOURCE_BUNDLED);
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
