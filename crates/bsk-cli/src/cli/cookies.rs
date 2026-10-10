//! `bsk cookies` — export cookies (including httpOnly) for the site
//! open in the session's Agent Window tab. Thin clap wrapper around the
//! `tool.cookies` IPC call.
//!
//! Scope: the export is limited to the target tab's own URL (CDP
//! `Network.getCookies` with `urls: [tab.url]`), and the tab must live
//! in the Agent Window — same red-line as `tool.evaluate` (design §6).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{CookiesParams, CookiesResult};
use clap::Args;

use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct CookiesArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Hard upper bound on the call, milliseconds.
    #[arg(long = "timeout-ms", default_value_t = 30_000)]
    pub timeout: u32,
}

pub fn dispatch(args: CookiesArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = CookiesParams {
        session_id: args.session,
        tab_id: args.tab_id,
        timeout_ms: Some(args.timeout),
    };
    let reply = call(info.sock_path, params, args.timeout)?;
    render(&reply, format)
}

fn call(sock: PathBuf, params: CookiesParams, timeout_ms: u32) -> Result<CookiesResult, CliError> {
    crate::cli::business_rpc::call::<CookiesParams, CookiesResult>(
        sock,
        "cookies",
        Method::ToolCookies,
        Some(params),
        ipc_timeout(timeout_ms),
    )
}

fn ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms))
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(u64::from(timeout_ms / 1_000) + 15))
}

fn render(reply: &CookiesResult, format: Format) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            println!("url: {}", reply.url);
            for c in &reply.cookies {
                let flags = [
                    if c.http_only { "httpOnly" } else { "" },
                    if c.secure { "secure" } else { "" },
                ]
                .iter()
                .filter(|s| !s.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join(",");
                println!("  {:24} {} ({}{})", c.name, c.domain, flags, if !flags.is_empty() { "" } else { "-" });
            }
            println!("{} cookies", reply.cookies.len());
        }
    }
    Ok(())
}
