//! `bsk install-skill` — install browser-skill SKILL.md into agent harnesses.

use std::io::{self, IsTerminal};
use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use bsk_protocol::ErrorCode;
use clap::Args;
use serde::Serialize;

use crate::cli::error::CliError;
use crate::cli::status::Output;
use crate::skill_install::{
    InstallOptions, all_harness_reports,
    harness::{HarnessId, parse_harness_id},
    load_source, print_harness_table, run_interactive_prompt,
};

#[derive(Debug, Clone, Args)]
pub struct InstallSkillArgs {
    /// Harness id to install into (repeatable). Run with `--list` to see ids.
    #[arg(long = "harness", short = 'H', value_name = "HARNESS")]
    pub harness: Vec<String>,

    /// Install into every harness on this machine (detected or not).
    #[arg(long)]
    pub all: bool,

    /// Show harness paths and detection status without installing.
    #[arg(long)]
    pub list: bool,

    /// Non-interactive mode (required for scripts when not specifying harnesses explicitly).
    #[arg(long, short = 'y')]
    pub yes: bool,

    /// Path to a `SKILL.md` to install instead of the bundled skill.
    #[arg(long, value_name = "PATH")]
    pub source: Option<PathBuf>,

    /// Overwrite an existing `browser-skill` skill installation.
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Serialize)]
struct ListOutput {
    harnesses: Vec<crate::skill_install::HarnessReport>,
}

pub fn dispatch(args: InstallSkillArgs, output: Output) -> Result<(), CliError> {
    let reports = all_harness_reports().map_err(CliError::Local)?;

    if args.list {
        return render_list(&reports, output).map_err(CliError::Local);
    }

    let harnesses = resolve_targets(&args, &reports).map_err(CliError::Local)?;
    let source = load_source(args.source.as_deref()).map_err(CliError::Local)?;

    let install_output = crate::skill_install::install_to_harnesses(&InstallOptions {
        harnesses: &harnesses,
        source: &source,
        force: args.force,
        home: None,
    });

    match output {
        Output::Human => render_human(&install_output),
        Output::Json => {
            let json = serde_json::to_string_pretty(&install_output.to_json_output())
                .context("encode json")?;
            println!("{json}");
        }
    }

    if install_output.success() {
        Ok(())
    } else if matches!(output, Output::Json) {
        Err(CliError::Rendered {
            code: ErrorCode::InvalidParams,
            message: format!(
                "failed to install skill for {} harness(es)",
                install_output.errors.len()
            ),
        })
    } else {
        Err(CliError::Local(anyhow::anyhow!(
            "failed to install skill for {} harness(es)",
            install_output.errors.len()
        )))
    }
}

fn resolve_targets(
    args: &InstallSkillArgs,
    reports: &[crate::skill_install::HarnessReport],
) -> Result<Vec<HarnessId>> {
    if args.all {
        return Ok(HarnessId::ALL.to_vec());
    }

    if !args.harness.is_empty() {
        let mut ids = Vec::with_capacity(args.harness.len());
        for raw in &args.harness {
            ids.push(parse_harness_id(raw)?);
        }
        ids.sort_by_key(|id| id.index());
        ids.dedup();
        return Ok(ids);
    }

    let stdin_tty = io::stdin().is_terminal();
    let stderr_tty = io::stderr().is_terminal();

    if stdin_tty && stderr_tty && !args.yes {
        return run_interactive_prompt(reports);
    }

    if args.yes {
        let detected: Vec<_> = reports
            .iter()
            .filter(|r| r.detected)
            .map(|r| r.id)
            .collect();
        if detected.is_empty() {
            bail!(
                "no harnesses detected; pass --harness <id> or use --all -y to install everywhere"
            );
        }
        return Ok(detected);
    }

    bail!(
        "non-interactive mode requires --harness, --all, or --yes (with detected harnesses); use --list to inspect"
    );
}

fn render_list(reports: &[crate::skill_install::HarnessReport], output: Output) -> Result<()> {
    match output {
        Output::Human => {
            print_harness_table(
                reports,
                "Agent harnesses supported by `bsk install-skill`:\n",
            );
            eprintln!(
                "\nPass `--harness <id>` (repeatable) or run without flags for interactive install."
            );
        }
        Output::Json => {
            let payload = ListOutput {
                harnesses: reports.to_vec(),
            };
            println!("{}", serde_json::to_string_pretty(&payload)?);
        }
    }
    Ok(())
}

fn render_human(output: &crate::skill_install::InstallSkillOutput) {
    for result in &output.results {
        let action = match result.status {
            crate::skill_install::InstallStatus::Installed => "installed",
            crate::skill_install::InstallStatus::Updated => "updated",
            crate::skill_install::InstallStatus::Skipped => "skipped (already exists; use --force)",
        };
        eprintln!(
            "✓ {} → {} ({action})",
            result.harness,
            result.path.display()
        );
    }
    for err in &output.errors {
        eprintln!("× {} — {}", err.harness, err.message);
    }
}
