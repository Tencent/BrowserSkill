//! Explicit decisions for native JavaScript dialogs in the session's Agent Window.

use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{DialogAction, DialogParams, DialogResult};
use clap::{Args, Subcommand};

use super::dialogs::print_dialog_summaries;
use super::ensure_daemon::ensure_daemon;
use super::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct DialogCmd {
    #[command(subcommand)]
    pub sub: DialogSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum DialogSub {
    /// Inspect a pending dialog without reading or executing page JavaScript.
    Status(DialogTargetArgs),
    /// Accept the dialog; optional text replaces a prompt's default (including empty text).
    Accept(DialogAcceptArgs),
    /// Cancel a confirm/prompt, or stay on the page for beforeunload.
    Dismiss(DialogHandleArgs),
}

#[derive(Debug, Clone, Args)]
pub struct DialogTargetArgs {
    #[arg(long)]
    pub session: String,
    /// Target tab; defaults to the session's selected tab.
    #[arg(long)]
    pub tab_id: Option<i64>,
}

#[derive(Debug, Clone, Args)]
pub struct DialogHandleArgs {
    #[command(flatten)]
    pub target: DialogTargetArgs,
    /// Only answer this dialog ID, as returned by status or a dialog_pending error.
    #[arg(long)]
    pub dialog_id: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct DialogAcceptArgs {
    #[command(flatten)]
    pub target: DialogHandleArgs,
    pub text: Option<String>,
    /// Named form for integrations, including text beginning with a hyphen.
    #[arg(long = "text", conflicts_with = "text", allow_hyphen_values = true)]
    pub prompt_text: Option<String>,
}

impl DialogCmd {
    pub fn params(self) -> DialogParams {
        let (action, target, dialog_id, prompt_text) = match self.sub {
            DialogSub::Status(target) => (DialogAction::Status, target, None, None),
            DialogSub::Accept(args) => (
                DialogAction::Accept,
                args.target.target,
                args.target.dialog_id,
                args.text.or(args.prompt_text),
            ),
            DialogSub::Dismiss(args) => (DialogAction::Dismiss, args.target, args.dialog_id, None),
        };
        DialogParams {
            session_id: target.session,
            action,
            tab_id: target.tab_id,
            prompt_text,
            dialog_id,
        }
    }
}

pub fn dispatch(cmd: DialogCmd, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    super::interaction_policy::require_dialog_support(&info.sock_path)?;
    let result: DialogResult = super::business_rpc::call(
        info.sock_path,
        "dialog",
        Method::ToolDialog,
        Some(cmd.params()),
        Duration::from_secs(45),
    )?;
    match format {
        Format::Json => println!(
            "{}",
            serde_json::to_string_pretty(&result).context("render dialog result")?
        ),
        Format::Human => {
            if let Some(handled) = &result.handled {
                print_dialog_summaries(std::slice::from_ref(handled));
            }
            if let Some(dialog) = &result.pending {
                println!(
                    "dialog: type={} handled=pending message={}",
                    dialog.dialog_type.as_str(),
                    dialog.message
                );
                println!("  id={} tab_id={}", dialog.id, dialog.tab_id);
                if let Some(url) = &dialog.url {
                    println!("  url={url}");
                }
                if let Some(prompt) = &dialog.default_prompt {
                    println!("  default_prompt={prompt}");
                }
            } else {
                println!("No pending JavaScript dialog on tab {}", result.tab_id);
            }
            if result.execution_pending {
                eprintln!(
                    "The original browser command is still finishing; query dialog status before another action. Do not repeat the original action."
                );
            }
        }
    }
    Ok(())
}
