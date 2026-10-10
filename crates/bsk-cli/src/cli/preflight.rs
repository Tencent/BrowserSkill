//! `bsk preflight` — detect browser-automation conflicts before
//! starting another parallel task in the same browser.
//!
//! Two tasks sharing one browser interfere in ways a *tool* cannot
//! diagnose afterwards:
//!
//! 1. **Same-domain login state** — every session in one browser
//!    shares the profile's cookies, so two tasks automating the same
//!    logged-in site can overwrite each other's page state with no
//!    visible error.
//! 2. **Session mixing** — when the number of running Agent Windows no
//!    longer matches the number of parallel tasks, tasks share one
//!    session and tab refs (`@eN`) bleed between them.
//!
//! The check is read-only: it lists sessions and tabs through the usual
//! RPCs, grades what it sees, and exits with the grade.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::system::SessionStatusEntry;
use bsk_protocol::tools::{TabInfo, TabListParams, TabListResult, TabScope};
use serde::Serialize;

use crate::cli::business_rpc;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

/// IPC read budget for the preflight queries. These are cheap
/// enumerations; the daemon answers them without waiting on a browser.
const IPC_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, clap::Args)]
pub struct PreflightArgs {
    /// URL the task is about to automate. Repeatable.
    #[arg(long, required = true)]
    pub url: Vec<String>,

    /// Number of parallel tasks the caller intends to run. When given,
    /// a mismatch with the active session count is reported.
    #[arg(long)]
    pub expected_parallel: Option<usize>,
}

/// Conflict grades, from harmless to blocking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Grade {
    /// No conflict detected.
    P2,
    /// Worth a warning: session mixing.
    P1,
    /// Blocking: same-domain login state is already in use.
    P0,
}

impl Grade {
    fn exit_code(self) -> u8 {
        match self {
            Grade::P2 => 0,
            Grade::P1 => 1,
            Grade::P0 => 2,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Grade::P0 => "P0",
            Grade::P1 => "P1",
            Grade::P2 => "P2",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Conflict {
    pub grade: Grade,
    pub kind: &'static str,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreflightReport {
    pub grade: Grade,
    pub target_hosts: Vec<String>,
    pub active_sessions: usize,
    pub conflicts: Vec<Conflict>,
}

pub fn dispatch(args: PreflightArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let report = check(info.sock_path, &args)?;
    match format {
        Format::Human => render_human(&report),
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&report)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
    }
    if report.grade == Grade::P2 {
        Ok(())
    } else {
        // The report is the deliverable; its grade is the exit status.
        Err(CliError::RenderedExit {
            exit_code: report.grade.exit_code(),
        })
    }
}

/// Collect state through the usual RPCs and grade it. Read-only: the
/// worst outcome of a wrong answer is a redundant task, never a broken
/// one, so every source degrades to "unknown" on error.
fn check(sock: PathBuf, args: &PreflightArgs) -> Result<PreflightReport, CliError> {
    let target_hosts: Vec<String> = args
        .url
        .iter()
        .map(|url| {
            host_of(url).ok_or_else(|| {
                CliError::Local(anyhow::anyhow!("--url {url} is not a URL with a host"))
            })
        })
        .collect::<Result<_, _>>()?;

    let sessions: Vec<SessionStatusEntry> = {
        #[derive(serde::Deserialize)]
        struct ListReply {
            sessions: Vec<SessionStatusEntry>,
        }
        business_rpc::call::<(), ListReply>(
            sock.clone(),
            "preflight",
            Method::SessionList,
            None,
            IPC_TIMEOUT,
        )?
        .sessions
    };

    let mut conflicts = Vec::new();
    for host in &target_hosts {
        for session in &sessions {
            for tab in agent_tabs(&sock, &session.session_id)? {
                let Some(tab_host) = tab.url.as_deref().and_then(host_of) else {
                    continue;
                };
                if tab_host.eq_ignore_ascii_case(host) {
                    conflicts.push(Conflict {
                        grade: Grade::P0,
                        kind: "same_domain",
                        detail: format!(
                            "host {host} is already automated by session {} (tab {}); \
                             sessions share one browser profile's login state",
                            session.session_id, tab.tab_id
                        ),
                    });
                }
            }
        }
    }

    if let Some(expected) = args.expected_parallel {
        if expected > sessions.len() {
            conflicts.push(Conflict {
                grade: Grade::P1,
                kind: "session_mixup",
                detail: format!(
                    "expected {expected} parallel tasks but {n} session(s) are active; \
                     tasks may be sharing one Agent Window and its tab refs",
                    n = sessions.len()
                ),
            });
        }
    }

    let grade = conflicts.iter().map(|c| c.grade).max().unwrap_or(Grade::P2);
    Ok(PreflightReport {
        grade,
        target_hosts,
        active_sessions: sessions.len(),
        conflicts,
    })
}

fn agent_tabs(sock: &std::path::Path, session_id: &str) -> Result<Vec<TabInfo>, CliError> {
    let params = TabListParams {
        session_id: session_id.to_string(),
        scope: TabScope::Agent,
    };
    let reply: TabListResult = business_rpc::call(
        sock.to_path_buf(),
        "preflight",
        Method::ToolTabList,
        Some(params),
        IPC_TIMEOUT,
    )?;
    Ok(reply.tabs)
}

/// Host of a URL, URL-normalized (lowercase) so both sides of the
/// domain comparison are case-stable.
fn host_of(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
}

fn render_human(report: &PreflightReport) {
    println!(
        "preflight: {} ({} active session{})",
        report.grade.label(),
        report.active_sessions,
        if report.active_sessions == 1 { "" } else { "s" }
    );
    for host in &report.target_hosts {
        println!("  target: {host}");
    }
    if report.conflicts.is_empty() {
        println!("  no conflicts detected");
        return;
    }
    for conflict in &report.conflicts {
        println!(
            "  {} [{}]: {}",
            conflict.grade.label(),
            conflict.kind,
            conflict.detail
        );
    }
}
