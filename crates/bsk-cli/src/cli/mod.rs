//! Top-level CLI definition (clap derive).

use std::time::Duration;

pub mod browser_wait;
pub mod browsers;
pub mod business_rpc;
pub mod console;
pub mod daemon;
pub mod dialogs;
pub mod doctor;
pub mod ensure_daemon;
pub mod error;
pub mod evaluate;
pub mod get_html;
pub mod human_loop;
pub mod install_skill;
pub mod interaction;
pub mod logs;
pub mod navigate;
pub mod render_error;
pub mod screenshot;
pub mod session;
pub mod snapshot;
pub mod status;
pub mod tab;
pub mod update;
pub mod waits;

use clap::{Args, Parser, Subcommand};

use crate::cli::console::ConsoleArgs;
use crate::cli::daemon::DaemonCmd;
use crate::cli::evaluate::EvaluateArgs;
use crate::cli::get_html::GetHtmlArgs;
use crate::cli::human_loop::RequestHelpArgs;
use crate::cli::install_skill::InstallSkillArgs;
use crate::cli::interaction::{ClickArgs, FillArgs, PressArgs, SelectArgs};
use crate::cli::navigate::{NavigateCommand, NavigateHistoryArgs, ReloadArgs};
use crate::cli::screenshot::ScreenshotArgs;
use crate::cli::session::SessionCmd;
use crate::cli::snapshot::SnapshotArgs;
use crate::cli::tab::TabCmd;
use crate::cli::update::UpdateArgs;
use crate::cli::waits::{WaitForNavigationArgs, WaitMsArgs};

/// Tool calls wait slightly longer than the daemon's 30s tool timeout so
/// callers receive the structured daemon timeout instead of dropping the
/// IPC connection first.
pub const TOOL_IPC_TIMEOUT: Duration = Duration::from_secs(35);

/// Global flags shared by every subcommand.
#[derive(Debug, Clone, Args, Default)]
pub struct GlobalFlags {
    /// Emit machine-readable JSON output (when meaningful).
    #[arg(long, global = true)]
    pub json: bool,

    /// Suppress informational output.
    #[arg(long, global = true)]
    pub quiet: bool,

    /// Increase log verbosity (`-v` debug, `-vv` trace).
    #[arg(short = 'v', long = "verbose", global = true, action = clap::ArgAction::Count)]
    pub verbose: u8,
}

/// Top-level `bsk` CLI.
#[derive(Debug, Parser)]
#[command(
    name = "bsk",
    version,
    about = "browser-skill — drive your browser from AI agents"
)]
pub struct Cli {
    #[command(flatten)]
    pub flags: GlobalFlags,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Manage the local `bsk` daemon process.
    #[command(subcommand)]
    Daemon(DaemonCmd),

    /// Show daemon status.
    Status,

    /// Run diagnostics + repair hints.
    Doctor,

    /// Install the browser-skill agent skill into local agent harnesses.
    #[command(name = "install-skill")]
    InstallSkill(InstallSkillArgs),

    /// Check for and install bsk CLI updates.
    Update(UpdateArgs),

    /// Print (and optionally follow) the daemon log file.
    Logs(LogsCmd),

    /// Session lifecycle.
    Session(SessionCmd),

    /// List connected browsers.
    Browsers,

    /// Tab management commands.
    Tab(TabCmd),

    /// Capture a PNG of the active tab or a snapshot ref element.
    Screenshot(ScreenshotArgs),

    /// Produce an indented aria-snapshot with @eN refs.
    Snapshot(SnapshotArgs),

    /// Read buffered console/log/exception messages.
    Console(ConsoleArgs),

    /// Dump raw HTML for a tab or a snapshot ref.
    #[command(name = "get-html")]
    GetHtml(GetHtmlArgs),

    /// Navigate the Agent Window's tab to a URL.
    Navigate(NavigateCommand),

    /// Step back in history one entry.
    #[command(name = "navigate-back")]
    NavigateBack(NavigateHistoryArgs),

    /// Step forward in history one entry.
    #[command(name = "navigate-forward")]
    NavigateForward(NavigateHistoryArgs),

    /// Reload the current tab.
    Reload(ReloadArgs),

    /// Click a snapshot ref or CSS selector.
    Click(ClickArgs),

    /// Fill an input / textarea / contenteditable.
    Fill(FillArgs),

    /// Dispatch a keyboard key combo.
    Press(PressArgs),

    /// Set `<select>` option values by `value` attribute.
    Select(SelectArgs),

    /// Evaluate a JavaScript expression inside the Agent Window.
    Evaluate(EvaluateArgs),

    /// Wait for a page-lifecycle event.
    #[command(name = "wait-for-navigation")]
    WaitForNavigation(WaitForNavigationArgs),

    /// Sleep for a duration on the daemon side.
    #[command(name = "wait-ms")]
    WaitMs(WaitMsArgs),

    /// Ask the human to complete an in-page step (captcha / login / confirm).
    #[command(name = "request-help")]
    RequestHelp(RequestHelpArgs),
}

#[derive(Debug, Clone, Args, Default)]
pub struct LogsCmd {
    /// Follow new log lines as they are written (`tail -f`).
    #[arg(short = 'f', long)]
    pub follow: bool,

    /// Number of trailing lines to print before following (default 200).
    #[arg(short = 'n', long, default_value_t = 200)]
    pub lines: usize,
}
