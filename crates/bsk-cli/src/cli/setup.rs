//! `bsk setup` — 60-second zero-friction onboarding & one-click browser pairing wizard (`RM-09`).

use std::collections::HashMap;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail, ensure};
use bsk_protocol::{BrowserStatusEntry, ErrorCode, Method, StatusParams, StatusResult};
use clap::Args;
use console::style;
use dialoguer::Confirm;
use serde::Serialize;
use serde_json::{Value, json};

use crate::cli::GlobalFlags;
use crate::cli::doctor::{
    CheckResult, CheckStatus, EXTENSION_STORE_URL, EXTENSION_STORE_URL_EDGE,
    collect_current_checks, has_failures,
};
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format, exit_code_for};
use crate::daemon::info::DaemonInfo;
use crate::daemon::probe::{self, PROBE_TIMEOUT, Probe};
use crate::daemon::start_error::recovery_hint;
use crate::skill_install::{
    HarnessId, InstallOptions, SkillBundle, SkillSource, all_harness_reports,
    install_to_harnesses_at_home, parse_harness_id,
};

const PAIR_POLL_INTERVAL: Duration = Duration::from_millis(250);
const IPC_CALL_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Args)]
pub struct SetupArgs {
    /// Harness id to install the skill into (repeatable). Defaults to all detected harnesses.
    #[arg(long = "harness", short = 'H', value_name = "HARNESS")]
    pub harness: Vec<String>,

    /// Also configure the BrowserSkill MCP server for supported harnesses (Codex, Claude Code, Cursor).
    #[arg(long)]
    pub mcp: bool,

    /// Skip Agent Skill and MCP installation.
    #[arg(long = "no-skill")]
    pub no_skill: bool,

    /// Skip local browser pairing (wait for browser connection and run health checks only).
    #[arg(long = "no-pair")]
    pub no_pair: bool,

    /// Issue a replacement pairing link when the current browser is already paired.
    #[arg(long = "re-pair", conflicts_with = "no_pair")]
    pub re_pair: bool,

    /// Explicitly replace a paired browser/device ID when issuing a pairing link.
    #[arg(long, value_name = "BROWSER_ID", conflicts_with = "no_pair")]
    pub replace: Option<String>,

    /// Do not automatically open the confirmation URL in the system browser.
    #[arg(long = "no-open")]
    pub no_open: bool,

    /// Maximum time to wait for browser extension connection and verification (default 60s).
    #[arg(
        long,
        value_name = "DURATION",
        default_value = "60s",
        value_parser = crate::cli::daemon::parse_duration
    )]
    pub timeout: Duration,

    /// Non-interactive confirmation mode (overwrite existing skill installations without prompting).
    #[arg(long, short = 'y')]
    pub yes: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DaemonStepReport {
    pub ok: bool,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ws_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sock_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillTargetReport {
    pub harness: String,
    pub path: PathBuf,
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillStepReport {
    pub ok: bool,
    pub status: &'static str,
    pub detail: String,
    pub results: Vec<SkillTargetReport>,
    pub mcp_results: Vec<SkillTargetReport>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairingStepReport {
    pub ok: bool,
    pub status: &'static str,
    pub verified: bool,
    pub opened_browser: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorStepReport {
    pub ok: bool,
    pub checks: Vec<CheckResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupJsonReport {
    pub daemon: DaemonStepReport,
    pub skill: SkillStepReport,
    pub pairing: PairingStepReport,
    pub doctor: DoctorStepReport,
    pub elapsed_ms: u64,
    pub ok: bool,
}

/// Convert a daemon `ws://127.0.0.1:<port>/#bsk-local.v1.<daemon>.<device>.<secret>`
/// pairing link into the browser launch URL `http://127.0.0.1:<port>/pair#bsk-local.v1...`
/// and return `(http_launch_url, device_id)`.
pub fn ws_pair_link_to_http_launch_url(ws_link: &str) -> Result<(String, String)> {
    let trimmed = ws_link.trim();
    let rest = trimmed
        .strip_prefix("ws://127.0.0.1:")
        .ok_or_else(|| anyhow!("local pairing link did not use ws://127.0.0.1:<port>"))?;
    let (port_str, tail) = rest
        .split_once("/#")
        .ok_or_else(|| anyhow!("local pairing link missing fragment"))?;
    let port: u16 = port_str
        .parse()
        .context("invalid port in local pairing link")?;
    ensure!(port > 0, "port in local pairing link must be non-zero");

    let parts: Vec<&str> = tail.split('.').collect();
    ensure!(
        parts.len() == 5
            && parts[0] == "bsk-local"
            && parts[1] == "v1"
            && !parts[2].is_empty()
            && !parts[3].is_empty()
            && !parts[4].is_empty(),
        "unexpected local pairing fragment format"
    );
    let device_id = parts[3].to_string();
    let launch_url = format!("http://127.0.0.1:{port}/pair#{tail}");
    Ok((launch_url, device_id))
}

/// Default non-blocking OS browser launcher. Degrades silently on headless or
/// restricted environments without panicking or failing setup.
pub fn default_browser_launcher(url: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        spawn_detached("open", &[url])
    }
    #[cfg(target_os = "windows")]
    {
        spawn_detached("rundll32", &["url.dll,FileProtocolHandler", url])
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let has_gui =
            std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some();
        if !has_gui {
            return false;
        }
        spawn_detached("xdg-open", &[url])
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = url;
        false
    }
}

fn spawn_detached(program: &str, args: &[&str]) -> bool {
    let spawned = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match spawned {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            true
        }
        Err(_) => false,
    }
}

pub fn dispatch(args: SetupArgs, flags: &GlobalFlags, format: Format) -> Result<(), CliError> {
    run_with_launcher(args, flags, format, &default_browser_launcher)
}

pub fn run_with_launcher(
    args: SetupArgs,
    flags: &GlobalFlags,
    format: Format,
    launcher: &dyn Fn(&str) -> bool,
) -> Result<(), CliError> {
    let started_at = Instant::now();
    let human = format == Format::Human && !flags.quiet;

    let explicit_harnesses = parse_explicit_harnesses(&args).map_err(CliError::invalid_params)?;

    // -------------------------------------------------------------------------
    // Step 1: [1/4] Daemon
    // -------------------------------------------------------------------------
    if human {
        eprintln!("{}", style("[1/4] Daemon").bold());
    }
    let (daemon_info, initial_status) = match ensure_and_probe_daemon() {
        Ok(pair) => pair,
        Err(err) => {
            if format == Format::Json {
                let hint = recovery_hint(&err).map(str::to_owned);
                let report = SetupJsonReport {
                    daemon: DaemonStepReport {
                        ok: false,
                        status: "fail",
                        pid: None,
                        ws_port: None,
                        protocol_version: None,
                        daemon_version: None,
                        sock_path: None,
                        error: Some(format!("{err:#}")),
                        hint,
                    },
                    skill: skipped_skill_report("skipped (daemon unavailable)"),
                    pairing: skipped_pairing_report("skipped (daemon unavailable)"),
                    doctor: DoctorStepReport {
                        ok: false,
                        checks: collect_current_checks(),
                    },
                    elapsed_ms: started_at.elapsed().as_millis() as u64,
                    ok: false,
                };
                println!(
                    "{}",
                    serde_json::to_string_pretty(&report)
                        .map_err(|err| CliError::Local(err.into()))?
                );
                return Err(CliError::RenderedExit { exit_code: 2 });
            }
            return Err(CliError::Local(err));
        }
    };

    if human {
        eprintln!(
            "  {} Daemon running (pid {}, ws://127.0.0.1:{}, protocol {}, v{})",
            style("✓").green(),
            initial_status.pid,
            initial_status.ws_port,
            initial_status.protocol_version,
            initial_status.daemon_version
        );
    }
    let daemon_report = DaemonStepReport {
        ok: true,
        status: "ok",
        pid: Some(initial_status.pid),
        ws_port: Some(initial_status.ws_port),
        protocol_version: Some(initial_status.protocol_version.clone()),
        daemon_version: Some(initial_status.daemon_version.clone()),
        sock_path: Some(initial_status.sock_path.clone()),
        error: None,
        hint: None,
    };

    // -------------------------------------------------------------------------
    // Step 2: [2/4] Agent Skill & MCP
    // -------------------------------------------------------------------------
    if human {
        eprintln!("{}", style("[2/4] Agent Skill & MCP").bold());
    }
    let skill_report = run_skill_step(&args, &explicit_harnesses, format, human)?;

    // -------------------------------------------------------------------------
    // Step 3: [3/4] Browser Pairing
    // -------------------------------------------------------------------------
    if human {
        eprintln!("{}", style("[3/4] Browser Pairing").bold());
    }
    let pairing_report = run_pairing_step(&args, &daemon_info, &initial_status, human, launcher)?;

    // -------------------------------------------------------------------------
    // Step 4: [4/4] Health Check
    // -------------------------------------------------------------------------
    if human {
        eprintln!("{}", style("[4/4] Health Check").bold());
    }
    let checks = collect_current_checks();
    let doctor_ok = !has_failures(&checks);
    if human {
        render_human_doctor_summary(&checks);
    }
    let doctor_report = DoctorStepReport {
        ok: doctor_ok,
        checks,
    };

    let overall_ok = daemon_report.ok && skill_report.ok && pairing_report.ok && doctor_report.ok;
    let elapsed_ms = started_at.elapsed().as_millis() as u64;

    match format {
        Format::Human => {
            if !flags.quiet && overall_ok {
                eprintln!(
                    "\n{} BrowserSkill is ready! Try: {}",
                    style("✓").green().bold(),
                    style("bsk session start").cyan().bold()
                );
            }
        }
        Format::Json => {
            let report = SetupJsonReport {
                daemon: daemon_report,
                skill: skill_report.clone(),
                pairing: pairing_report.clone(),
                doctor: doctor_report,
                elapsed_ms,
                ok: overall_ok,
            };
            println!(
                "{}",
                serde_json::to_string_pretty(&report).map_err(|err| CliError::Local(err.into()))?
            );
        }
    }

    if overall_ok {
        Ok(())
    } else {
        let exit_code = if pairing_report.status == "timeout" {
            exit_code_for(ErrorCode::Timeout)
        } else {
            1
        };
        Err(CliError::RenderedExit { exit_code })
    }
}

fn parse_explicit_harnesses(args: &SetupArgs) -> Result<Vec<HarnessId>> {
    if args.harness.is_empty() {
        return Ok(Vec::new());
    }
    let mut ids = Vec::with_capacity(args.harness.len());
    for raw in &args.harness {
        ids.push(parse_harness_id(raw)?);
    }
    ids.sort_by_key(|id| id.index());
    ids.dedup();
    if args.mcp && !args.no_skill {
        for &harness in &ids {
            if !crate::skill_install::mcp::supported(harness) {
                bail!(
                    "--mcp supports codex, claude-code and cursor; {} is not supported",
                    harness.cli_name()
                );
            }
        }
    }
    Ok(ids)
}

fn ensure_and_probe_daemon() -> Result<(DaemonInfo, StatusResult)> {
    let _ = ensure_daemon()?;
    match probe::probe(PROBE_TIMEOUT)? {
        Probe::Ready(verified) => Ok((verified.info, verified.status)),
        _ => {
            let verified = probe::wait_for_ready(Duration::from_secs(3))?;
            Ok((verified.info, verified.status))
        }
    }
}

fn skipped_skill_report(detail: &str) -> SkillStepReport {
    SkillStepReport {
        ok: true,
        status: "skipped",
        detail: detail.to_string(),
        results: Vec::new(),
        mcp_results: Vec::new(),
        errors: Vec::new(),
    }
}

fn skipped_pairing_report(detail: &str) -> PairingStepReport {
    PairingStepReport {
        ok: false,
        status: "skipped",
        verified: false,
        opened_browser: false,
        endpoint: None,
        browser_name: None,
        instance_id: None,
        device_id: None,
        detail: Some(detail.to_string()),
        hint: None,
    }
}

fn run_skill_step(
    args: &SetupArgs,
    explicit_harnesses: &[HarnessId],
    format: Format,
    human: bool,
) -> Result<SkillStepReport, CliError> {
    if args.no_skill {
        if human {
            eprintln!("  - Skipped (--no-skill)");
        }
        return Ok(skipped_skill_report("skipped (--no-skill)"));
    }

    let home = crate::skill_install::harness::home_dir().map_err(CliError::Local)?;
    let reports = all_harness_reports().map_err(CliError::Local)?;
    let targets: Vec<HarnessId> = if !explicit_harnesses.is_empty() {
        explicit_harnesses.to_vec()
    } else {
        let mut detected: Vec<_> = reports
            .iter()
            .filter(|r| r.detected)
            .map(|r| r.id)
            .collect();
        detected.sort_by_key(|id| id.index());
        detected.dedup();
        detected
    };

    if targets.is_empty() {
        let detail = "no supported coding agent harness detected on this machine";
        if human {
            eprintln!("  - N/A: {detail} (pass --harness <id> to install explicitly)");
        }
        return Ok(SkillStepReport {
            ok: true,
            status: "na",
            detail: detail.to_string(),
            results: Vec::new(),
            mcp_results: Vec::new(),
            errors: Vec::new(),
        });
    }

    let bundle = SkillBundle::bundled();
    let mut results = Vec::new();
    let mut errors = Vec::new();

    if args.yes {
        let out = install_to_harnesses_at_home(
            &home,
            &InstallOptions {
                harnesses: &targets,
                source: &bundle,
                source_kind: SkillSource::Bundled,
                force: true,
                home: Some(&home),
            },
        );
        for item in out.results {
            let status = match item.status {
                crate::skill_install::InstallStatus::Installed => "installed",
                crate::skill_install::InstallStatus::Updated => "updated",
                crate::skill_install::InstallStatus::Skipped => "up_to_date",
            };
            results.push(SkillTargetReport {
                harness: item.harness,
                path: item.path,
                status,
            });
        }
        for err in out.errors {
            errors.push(format!("{}: {}", err.harness, err.message));
        }
    } else {
        let sync_report = crate::skill_install::sync::sync_installed_skills(&home);
        let interactive =
            format == Format::Human && io::stdin().is_terminal() && io::stderr().is_terminal();

        for &harness in &targets {
            let dest_file = harness.skill_dest_dir_for_home(&home).join("SKILL.md");
            if let Some((_, msg)) = sync_report.errors.iter().find(|(id, _)| *id == harness) {
                errors.push(format!("{}: {msg}", harness.cli_name()));
                continue;
            }
            if sync_report.updated.contains(&harness) {
                results.push(SkillTargetReport {
                    harness: harness.cli_name().to_string(),
                    path: dest_file,
                    status: "updated",
                });
                continue;
            }
            if sync_report.up_to_date.contains(&harness) {
                results.push(SkillTargetReport {
                    harness: harness.cli_name().to_string(),
                    path: dest_file,
                    status: "up_to_date",
                });
                continue;
            }
            let needs_overwrite_confirm = sync_report.protected.contains(&harness)
                || sync_report.paused.iter().any(|(id, _)| *id == harness);
            if needs_overwrite_confirm {
                let overwrite = if interactive {
                    Confirm::new()
                        .with_prompt(format!(
                            "Existing skill in {} has custom or local edits. Overwrite with bundled skill?",
                            harness.display_name()
                        ))
                        .default(false)
                        .interact_opt()
                        .ok()
                        .flatten()
                        .unwrap_or(false)
                } else {
                    false
                };
                if overwrite {
                    let out = install_to_harnesses_at_home(
                        &home,
                        &InstallOptions {
                            harnesses: &[harness],
                            source: &bundle,
                            source_kind: SkillSource::Bundled,
                            force: true,
                            home: Some(&home),
                        },
                    );
                    for item in out.results {
                        results.push(SkillTargetReport {
                            harness: item.harness,
                            path: item.path,
                            status: "updated",
                        });
                    }
                    for err in out.errors {
                        errors.push(format!("{}: {}", err.harness, err.message));
                    }
                } else {
                    results.push(SkillTargetReport {
                        harness: harness.cli_name().to_string(),
                        path: dest_file,
                        status: "preserved",
                    });
                }
                continue;
            }

            let out = install_to_harnesses_at_home(
                &home,
                &InstallOptions {
                    harnesses: &[harness],
                    source: &bundle,
                    source_kind: SkillSource::Bundled,
                    force: false,
                    home: Some(&home),
                },
            );
            for item in out.results {
                let status = match item.status {
                    crate::skill_install::InstallStatus::Installed => "installed",
                    crate::skill_install::InstallStatus::Updated => "updated",
                    crate::skill_install::InstallStatus::Skipped => "preserved",
                };
                results.push(SkillTargetReport {
                    harness: item.harness,
                    path: item.path,
                    status,
                });
            }
            for err in out.errors {
                errors.push(format!("{}: {}", err.harness, err.message));
            }
        }
    }

    let mut mcp_results = Vec::new();
    if args.mcp {
        let mcp_targets: Vec<HarnessId> = if !explicit_harnesses.is_empty() {
            explicit_harnesses.to_vec()
        } else {
            targets
                .iter()
                .copied()
                .filter(|&h| crate::skill_install::mcp::supported(h))
                .collect()
        };
        if !mcp_targets.is_empty() {
            let executable = std::env::current_exe()
                .context("locate bsk executable")
                .map_err(CliError::Local)?;
            for harness in mcp_targets {
                if errors
                    .iter()
                    .any(|e| e.starts_with(&format!("{}:", harness.cli_name())))
                {
                    continue;
                }
                match crate::skill_install::mcp::install(&home, harness, &executable) {
                    Ok(res) => mcp_results.push(SkillTargetReport {
                        harness: res.harness,
                        path: res.path,
                        status: res.status,
                    }),
                    Err(err) => errors.push(format!("{} MCP: {err:#}", harness.cli_name())),
                }
            }
        }
    }

    if human {
        for r in &results {
            eprintln!(
                "  {} {} skill → {} ({})",
                style("✓").green(),
                r.harness,
                r.path.display(),
                r.status
            );
        }
        for m in &mcp_results {
            eprintln!(
                "  {} {} MCP → {} ({})",
                style("✓").green(),
                m.harness,
                m.path.display(),
                m.status
            );
        }
        for e in &errors {
            eprintln!("  {} {e}", style("×").red());
        }
    }

    let ok = errors.is_empty();
    let detail = if ok {
        format!(
            "processed {} harness(es){}",
            results.len(),
            if mcp_results.is_empty() {
                String::new()
            } else {
                format!(", {} MCP config(s)", mcp_results.len())
            }
        )
    } else {
        format!("{} error(s) during skill/MCP setup", errors.len())
    };

    Ok(SkillStepReport {
        ok,
        status: if ok { "ok" } else { "fail" },
        detail,
        results,
        mcp_results,
        errors,
    })
}

fn run_pairing_step(
    args: &SetupArgs,
    daemon_info: &DaemonInfo,
    initial_status: &StatusResult,
    human: bool,
    launcher: &dyn Fn(&str) -> bool,
) -> Result<PairingStepReport, CliError> {
    let endpoint = format!("ws://127.0.0.1:{}", initial_status.ws_port);

    if args.no_pair {
        return wait_without_pairing(args, daemon_info, initial_status, &endpoint, human);
    }

    let (status, devices) =
        query_status_and_devices(&daemon_info.sock_path).map_err(CliError::Local)?;

    // Idempotent 0-second fast path when an online browser is already paired & verified.
    if !args.re_pair
        && args.replace.is_none()
        && let Some((browser, device_id)) = find_verified_online_browser(&status, &devices)
    {
        if human {
            eprintln!(
                "  {} Browser already paired & verified ({})",
                style("✓").green(),
                format_browser_name(&browser)
            );
        }
        return Ok(PairingStepReport {
            ok: true,
            status: "already_paired",
            verified: true,
            opened_browser: false,
            endpoint: Some(endpoint),
            browser_name: Some(browser.browser_name),
            instance_id: Some(browser.instance_id),
            device_id: Some(device_id),
            detail: Some("browser already paired and verified".into()),
            hint: None,
        });
    }

    let replace_target =
        resolve_replace_target(args, &status, &devices).map_err(CliError::invalid_params)?;

    let pre_pair_connected: HashMap<String, i64> = status
        .browsers
        .iter()
        .map(|b| (b.instance_id.clone(), b.connected_at_ms))
        .collect();

    let pair_reply =
        crate::cli::daemon::maintain(Method::LocalAuthPair, json!({ "replace": replace_target }))
            .map_err(CliError::invalid_params)?;

    let ws_link = pair_reply["link"]
        .as_str()
        .ok_or_else(|| CliError::Local(anyhow!("daemon returned an invalid pairing reply")))?;
    let (launch_url, expected_device_id) =
        ws_pair_link_to_http_launch_url(ws_link).map_err(CliError::Local)?;

    let opened_browser = !args.no_open && launcher(&launch_url);
    if human {
        if opened_browser {
            eprintln!(
                "  {} Opened one-click confirmation page in your browser:",
                style("→").cyan()
            );
            eprintln!("    {launch_url}");
        } else {
            eprintln!(
                "  {} Open this URL in your target browser for one-click confirmation:",
                style("→").cyan()
            );
            eprintln!("    {launch_url}");
        }
        eprintln!(
            "  {} Backup manual pairing link (paste in extension Connection Settings if using another profile):",
            style("→").cyan()
        );
        eprintln!("    {ws_link}");
        eprintln!(
            "  … Waiting up to {} for browser confirmation (click \"Approve & Pair\")…",
            format_duration_short(args.timeout)
        );
    }

    let deadline = Instant::now() + args.timeout;
    loop {
        if let Ok((cur_status, cur_devices)) = query_status_and_devices(&daemon_info.sock_path) {
            if let Some(browser) = check_expected_device_online(
                &cur_status,
                &cur_devices,
                &expected_device_id,
                &pre_pair_connected,
                &daemon_info.sock_path,
            ) {
                if human {
                    eprintln!(
                        "  {} Paired & verified with {} ({})",
                        style("✓").green(),
                        format_browser_name(&browser),
                        browser.instance_id
                    );
                }
                return Ok(PairingStepReport {
                    ok: true,
                    status: "paired",
                    verified: true,
                    opened_browser,
                    endpoint: Some(endpoint),
                    browser_name: Some(browser.browser_name),
                    instance_id: Some(browser.instance_id),
                    device_id: Some(expected_device_id),
                    detail: Some("paired and verified".into()),
                    hint: None,
                });
            }

            if !args.re_pair
                && args.replace.is_none()
                && let Some((browser, existing_device_id)) =
                    find_verified_online_browser(&cur_status, &cur_devices)
            {
                if human {
                    eprintln!(
                        "  {} Paired & verified with {} ({})",
                        style("✓").green(),
                        format_browser_name(&browser),
                        browser.instance_id
                    );
                }
                return Ok(PairingStepReport {
                    ok: true,
                    status: "already_paired",
                    verified: true,
                    opened_browser,
                    endpoint: Some(endpoint),
                    browser_name: Some(browser.browser_name),
                    instance_id: Some(browser.instance_id),
                    device_id: Some(existing_device_id),
                    detail: Some("connected with existing verified pairing".into()),
                    hint: None,
                });
            }
        }

        if Instant::now() >= deadline {
            break;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        std::thread::sleep(remaining.min(PAIR_POLL_INTERVAL));
    }

    let hint = format!(
        "install BrowserSkill from {EXTENSION_STORE_URL} (Chrome) or {EXTENSION_STORE_URL_EDGE} (Edge) if not installed; \
         otherwise open the confirmation URL in the target browser profile and click 'Approve & Pair' \
         (or paste the backup ws:// link into the extension's Connection Settings), then re-run `bsk setup`"
    );
    if human {
        eprintln!(
            "  {} Timed out after {} waiting for browser pairing confirmation.",
            style("×").red(),
            format_duration_short(args.timeout)
        );
        eprintln!("    • Chrome Web Store: {EXTENSION_STORE_URL}");
        eprintln!("    • Edge Add-ons:     {EXTENSION_STORE_URL_EDGE}");
        eprintln!(
            "    • If installed in another browser profile, paste the backup ws:// link into its Connection Settings or re-run `bsk setup`."
        );
    }

    Ok(PairingStepReport {
        ok: false,
        status: "timeout",
        verified: false,
        opened_browser,
        endpoint: Some(endpoint),
        browser_name: None,
        instance_id: None,
        device_id: Some(expected_device_id),
        detail: Some(format!(
            "timed out after {} waiting for browser pairing confirmation",
            format_duration_short(args.timeout)
        )),
        hint: Some(hint),
    })
}

fn wait_without_pairing(
    args: &SetupArgs,
    daemon_info: &DaemonInfo,
    initial_status: &StatusResult,
    endpoint: &str,
    human: bool,
) -> Result<PairingStepReport, CliError> {
    if let Some(browser) = initial_status.browsers.iter().find(|b| !b.unresponsive) {
        let (verified, device_id) = query_status_and_devices(&daemon_info.sock_path)
            .ok()
            .and_then(|(status, devices)| find_verified_online_browser(&status, &devices))
            .filter(|(b, _)| b.instance_id == browser.instance_id)
            .map(|(_, dev)| (true, Some(dev)))
            .unwrap_or((false, None));
        if human {
            eprintln!(
                "  - Skipped pairing (--no-pair); browser online ({})",
                format_browser_name(browser)
            );
        }
        return Ok(PairingStepReport {
            ok: true,
            status: "skipped",
            verified,
            opened_browser: false,
            endpoint: Some(endpoint.to_string()),
            browser_name: Some(browser.browser_name.clone()),
            instance_id: Some(browser.instance_id.clone()),
            device_id,
            detail: Some("skipped (--no-pair); browser connected".into()),
            hint: None,
        });
    }

    let deadline = Instant::now() + args.timeout;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        std::thread::sleep(remaining.min(PAIR_POLL_INTERVAL));
        if let Ok((status, devices)) = query_status_and_devices(&daemon_info.sock_path)
            && let Some(browser) = status.browsers.iter().find(|b| !b.unresponsive)
        {
            let verified = find_verified_online_browser(&status, &devices)
                .is_some_and(|(b, _)| b.instance_id == browser.instance_id);
            if human {
                eprintln!(
                    "  - Skipped pairing (--no-pair); browser connected ({})",
                    format_browser_name(browser)
                );
            }
            return Ok(PairingStepReport {
                ok: true,
                status: "skipped",
                verified,
                opened_browser: false,
                endpoint: Some(endpoint.to_string()),
                browser_name: Some(browser.browser_name.clone()),
                instance_id: Some(browser.instance_id.clone()),
                device_id: None,
                detail: Some("skipped (--no-pair); browser connected".into()),
                hint: None,
            });
        }
    }

    let hint = format!(
        "open a browser profile with the BrowserSkill extension enabled, or install it from {EXTENSION_STORE_URL} (Chrome) / {EXTENSION_STORE_URL_EDGE} (Edge)"
    );
    if human {
        eprintln!(
            "  {} No browser connected within {} (--no-pair).",
            style("×").red(),
            format_duration_short(args.timeout)
        );
    }
    Ok(PairingStepReport {
        ok: false,
        status: "timeout",
        verified: false,
        opened_browser: false,
        endpoint: Some(endpoint.to_string()),
        browser_name: None,
        instance_id: None,
        device_id: None,
        detail: Some("no browser connected before timeout".into()),
        hint: Some(hint),
    })
}

fn resolve_replace_target(
    args: &SetupArgs,
    status: &StatusResult,
    devices: &[Value],
) -> Result<Option<String>> {
    if let Some(ref explicit) = args.replace {
        let trimmed = explicit.trim();
        ensure!(!trimmed.is_empty(), "--replace value cannot be empty");
        return Ok(Some(trimmed.to_string()));
    }
    if !args.re_pair {
        return Ok(None);
    }

    let active_local: Vec<&Value> = devices
        .iter()
        .filter(|d| d["kind"] == "local" && d["status"] == "active")
        .collect();
    match active_local.len() {
        0 => Ok(None),
        1 => Ok(active_local[0]["browser_id"]
            .as_str()
            .or_else(|| active_local[0]["device_id"].as_str())
            .map(str::to_owned)),
        _ => {
            let online_active: Vec<&str> = active_local
                .iter()
                .filter_map(|d| d["browser_id"].as_str())
                .filter(|bid| {
                    status
                        .browsers
                        .iter()
                        .any(|b| !b.unresponsive && b.instance_id == *bid)
                })
                .collect();
            if online_active.len() == 1 {
                return Ok(Some(online_active[0].to_string()));
            }
            let candidates: Vec<&str> = active_local
                .iter()
                .filter_map(|d| d["browser_id"].as_str().or_else(|| d["device_id"].as_str()))
                .collect();
            bail!(
                "multiple paired browsers exist ({}); pass `--replace <BROWSER_ID>` to choose which pairing to replace",
                candidates.join(", ")
            );
        }
    }
}

fn find_verified_online_browser(
    status: &StatusResult,
    devices: &[Value],
) -> Option<(BrowserStatusEntry, String)> {
    let auth = status.local_auth.as_ref()?;
    if auth.mode == "trust_local" {
        return None;
    }
    for browser in status.browsers.iter().filter(|b| !b.unresponsive) {
        if let Some(device) = devices.iter().find(|d| {
            d["kind"] == "local"
                && d["status"] == "active"
                && d["browser_id"].as_str() == Some(browser.instance_id.as_str())
        }) && let Some(device_id) = device["device_id"].as_str()
        {
            return Some((browser.clone(), device_id.to_string()));
        }
    }
    None
}

fn check_expected_device_online(
    status: &StatusResult,
    devices: &[Value],
    expected_device_id: &str,
    pre_pair_connected: &HashMap<String, i64>,
    sock_path: &Path,
) -> Option<BrowserStatusEntry> {
    if status
        .local_auth
        .as_ref()
        .is_none_or(|a| a.mode == "trust_local")
    {
        return None;
    }
    let device = devices.iter().find(|d| {
        d["kind"] == "local"
            && d["device_id"].as_str() == Some(expected_device_id)
            && d["status"] == "active"
    })?;
    let browser_id = device["browser_id"].as_str()?;
    let browser = status
        .browsers
        .iter()
        .find(|b| !b.unresponsive && b.instance_id == browser_id)?;

    if pre_pair_connected.get(browser_id) == Some(&browser.connected_at_ms) {
        // Guard against the narrow window where store.commit has flipped the
        // device to active right before durable_commit drops the previous socket.
        std::thread::sleep(Duration::from_millis(30));
        let (rechecked, _) = query_status_and_devices(sock_path).ok()?;
        return rechecked
            .browsers
            .into_iter()
            .find(|b| !b.unresponsive && b.instance_id == browser_id);
    }

    Some(browser.clone())
}

fn query_status_and_devices(sock_path: &Path) -> Result<(StatusResult, Vec<Value>)> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build IPC runtime")?
        .block_on(async {
            let mut client = crate::ipc_client::Client::connect_path(sock_path.to_path_buf())
                .await
                .context("connect to daemon IPC")?;
            let status: StatusResult = client
                .call(
                    Method::SystemStatus,
                    &StatusParams::default(),
                    IPC_CALL_TIMEOUT,
                )
                .await?
                .map_err(|e| anyhow!("{}", e.message))?;
            let devices_val: Value = client
                .call_with_id(
                    "setup-devices".into(),
                    Method::LocalAuthDevices,
                    &json!({}),
                    IPC_CALL_TIMEOUT,
                )
                .await?
                .map_err(|e| anyhow!("{}", e.message))?;
            let devices = devices_val.as_array().cloned().unwrap_or_default();
            Ok((status, devices))
        })
}

fn format_browser_name(browser: &BrowserStatusEntry) -> String {
    if browser.label.trim().is_empty() {
        browser.browser_name.clone()
    } else {
        format!("{} · {}", browser.browser_name, browser.label)
    }
}

fn format_duration_short(d: Duration) -> String {
    let ms = d.as_millis();
    if ms > 0 && ms % 1000 != 0 {
        format!("{ms}ms")
    } else {
        format!("{}s", d.as_secs())
    }
}

fn render_human_doctor_summary(checks: &[CheckResult]) {
    for c in checks {
        let icon = match c.status {
            CheckStatus::Ok => style("✓").green().to_string(),
            CheckStatus::Warning => style("!").yellow().to_string(),
            CheckStatus::Fail => style("×").red().to_string(),
            CheckStatus::NotApplicable => style("-").dim().to_string(),
        };
        match (&c.hint, c.status) {
            (Some(h), CheckStatus::Fail | CheckStatus::Warning) => {
                eprintln!("  {icon} {}: {} (hint: {h})", c.name, c.detail);
            }
            _ => {
                eprintln!("  {icon} {}: {}", c.name, c.detail);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_ws_pair_link_to_http_launch_url_preserving_fragment() {
        let ws = "ws://127.0.0.1:52800/#bsk-local.v1.daemonA.deviceB.secretC";
        let (http, device_id) = ws_pair_link_to_http_launch_url(ws).unwrap();
        assert_eq!(
            http,
            "http://127.0.0.1:52800/pair#bsk-local.v1.daemonA.deviceB.secretC"
        );
        assert_eq!(device_id, "deviceB");
    }

    #[test]
    fn rejects_malformed_or_remote_pair_links() {
        assert!(ws_pair_link_to_http_launch_url("wss://example.com/#bsk-local.v1.a.b.c").is_err());
        assert!(ws_pair_link_to_http_launch_url("ws://127.0.0.1:0/#bsk-local.v1.a.b.c").is_err());
        assert!(ws_pair_link_to_http_launch_url("ws://127.0.0.1:52800/#bad").is_err());
    }
}
