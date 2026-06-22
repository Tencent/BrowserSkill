//! `bsk snapshot` — aria-tree snapshot of the Agent Window's active
//! tab (M6.3). Text format is human-readable with `@eN` refs the
//! agent feeds back into `bsk click`, `bsk fill`, etc.

use std::path::PathBuf;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{SnapshotParams, SnapshotResult};
use clap::Args;

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct SnapshotArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Cap on aria-tree depth before truncating.
    #[arg(long = "max-depth")]
    pub max_depth: Option<u32>,

    /// Soft cap on rendered tokens (~4 chars/token).
    #[arg(long = "max-tokens")]
    pub max_tokens: Option<u32>,
}

pub fn dispatch(args: SnapshotArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    run(info.sock_path, args, format)
}

fn run(sock: PathBuf, args: SnapshotArgs, format: Format) -> Result<(), CliError> {
    let params = SnapshotParams {
        session_id: args.session.clone(),
        tab_id: args.tab_id,
        max_depth: args.max_depth,
        max_tokens: args.max_tokens,
    };
    let reply: SnapshotResult = call(sock, params)?;
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(&reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            if reply.text.is_empty() {
                println!("(empty snapshot — page may still be loading)");
            } else {
                println!("{}", reply.text);
            }
            if reply.truncated {
                eprintln!(
                    "warning: snapshot truncated (refs={}, tab={}). Increase --max-depth / --max-tokens if needed.",
                    reply.ref_count, reply.tab_id
                );
            }
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn call(sock: PathBuf, params: SnapshotParams) -> Result<SnapshotResult, CliError> {
    crate::cli::business_rpc::call::<SnapshotParams, SnapshotResult>(
        sock,
        "snapshot",
        Method::ToolSnapshot,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}
