//! `bsk observe` — semantic VOM observation with bounded perception probes.

use std::path::PathBuf;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{ObserveParams, ObserveResult};
use clap::Args;

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct ObserveArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Cap on VOM tree depth before truncating.
    #[arg(long = "max-depth")]
    pub max_depth: Option<u32>,

    /// Soft cap on rendered tokens (~4 chars/token).
    #[arg(long = "max-tokens")]
    pub max_tokens: Option<u32>,

    /// Include conditional surface probe diagnostics in JSON output.
    #[arg(long = "debug-surfaces")]
    pub debug_surfaces: bool,

    /// Actively hover page controls to reveal hover-only menus and tooltips.
    /// Costs seconds of wall clock and touches the live page, so it is off
    /// unless a static observation looks like it is missing hover content.
    #[arg(long = "probe-hover")]
    pub probe_hover: bool,
}

pub fn dispatch(args: ObserveArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    run(info.sock_path, args, format)
}

fn run(sock: PathBuf, args: ObserveArgs, format: Format) -> Result<(), CliError> {
    let params = ObserveParams {
        session_id: args.session.clone(),
        tab_id: args.tab_id,
        max_depth: args.max_depth,
        max_tokens: args.max_tokens,
        debug_surfaces: args.debug_surfaces,
        probe_hover: args.probe_hover,
    };
    let reply: ObserveResult = call(sock, params)?;
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(&reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            if reply.text.is_empty() {
                println!("(empty observation — page may still be loading)");
            } else {
                println!("{}", reply.text);
            }
            if reply.truncated {
                eprintln!(
                    "warning: observation truncated (refs={}, tab={}). Increase --max-depth / --max-tokens if needed.",
                    reply.ref_count, reply.tab_id
                );
            }
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn call(sock: PathBuf, params: ObserveParams) -> Result<ObserveResult, CliError> {
    crate::cli::business_rpc::call::<ObserveParams, ObserveResult>(
        sock,
        "observe",
        Method::ToolObserve,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}
