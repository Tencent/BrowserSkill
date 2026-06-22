//! `bsk get-html` — dump raw DOM HTML (M6.4). Optionally narrows to a
//! single subtree by `@eN` ref. Defaults its `--max-bytes` budget to
//! the bsk-protocol spec (`524288`) when the user does not override
//! it — the extension would otherwise apply the same default
//! locally.

use std::path::PathBuf;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{GetHtmlParams, GetHtmlResult};
use clap::Args;

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct GetHtmlArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Optional `@eN` ref from the last `bsk snapshot`. Scopes the
    /// dump to the matching subtree.
    #[arg(long = "ref")]
    pub ref_: Option<String>,

    /// Maximum HTML bytes to return before truncation.
    #[arg(long = "max-bytes")]
    pub max_bytes: Option<u32>,

    /// Write HTML to this path instead of stdout.
    #[arg(long)]
    pub out: Option<PathBuf>,
}

pub fn dispatch(args: GetHtmlArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    run(info.sock_path, args, format)
}

fn run(sock: PathBuf, args: GetHtmlArgs, format: Format) -> Result<(), CliError> {
    let params = GetHtmlParams {
        session_id: args.session.clone(),
        tab_id: args.tab_id,
        ref_: args.ref_.clone(),
        max_bytes: args.max_bytes,
    };
    let reply: GetHtmlResult = call(sock, params)?;
    if let Some(out) = &args.out {
        std::fs::write(out, reply.html.as_bytes())
            .with_context(|| format!("write HTML to {}", out.display()))
            .map_err(CliError::Local)?;
    }
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(&reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            if args.out.is_some() {
                println!(
                    "tab={} bytes={} truncated={}",
                    reply.tab_id, reply.byte_size, reply.truncated
                );
            } else {
                println!("{}", reply.html);
                if reply.truncated {
                    eprintln!(
                        "warning: HTML truncated (full size {} bytes). Pass `--max-bytes N` to widen.",
                        reply.byte_size
                    );
                }
            }
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn call(sock: PathBuf, params: GetHtmlParams) -> Result<GetHtmlResult, CliError> {
    crate::cli::business_rpc::call::<GetHtmlParams, GetHtmlResult>(
        sock,
        "get-html",
        Method::ToolGetHtml,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}
