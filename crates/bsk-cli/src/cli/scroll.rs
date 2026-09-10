//! `bsk scroll-to` — bring a target element into the visible viewport.

use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{ScrollToParams, ScrollToResult};
use clap::Args;

use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::interaction::split_target;
use crate::cli::navigate::parse_timeout_ms;

#[derive(Debug, Clone, Args)]
pub struct ScrollToArgs {
    /// Snapshot ref (`@e3`, `e3`) or CSS selector. Optional when `--ref`/`--selector` is used.
    pub target: Option<String>,

    #[arg(long = "ref")]
    pub ref_: Option<String>,

    #[arg(long = "selector")]
    pub selector: Option<String>,

    #[arg(long)]
    pub session: String,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

pub fn dispatch(args: ScrollToArgs, format: Format) -> Result<(), CliError> {
    let (ref_, selector) = split_target(args.target, args.ref_, args.selector)?;
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = ScrollToParams {
        session_id: args.session,
        ref_,
        selector,
        tab_id: args.tab_id,
        timeout_ms: Some(args.timeout),
    };
    let reply: ScrollToResult = crate::cli::business_rpc::call(
        info.sock_path,
        "scroll-to-1",
        Method::ToolScrollTo,
        Some(params),
        ipc_timeout(args.timeout),
    )?;
    match format {
        Format::Json => println!(
            "{}",
            serde_json::to_string_pretty(&reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
        ),
        Format::Human => {
            let target =
                format_used_target(reply.used_ref.as_deref(), reply.used_selector.as_deref());
            println!(
                "scroll-to ok tab={} target={target} bounds=({}, {}, {}, {})",
                reply.tab_id, reply.x, reply.y, reply.width, reply.height
            );
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn format_used_target(used_ref: Option<&str>, used_selector: Option<&str>) -> String {
    used_ref
        .map(|r| format!("@{r}"))
        .or_else(|| used_selector.map(str::to_string))
        .unwrap_or_else(|| "?".into())
}

fn ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms))
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(u64::from(timeout_ms / 1_000) + 15))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_target_detects_refs_and_selectors() {
        let (ref_, selector) = split_target(Some("@e3".into()), None, None).unwrap();
        assert_eq!(ref_.as_deref(), Some("@e3"));
        assert!(selector.is_none());

        let (ref_, selector) = split_target(Some("#target".into()), None, None).unwrap();
        assert!(ref_.is_none());
        assert_eq!(selector.as_deref(), Some("#target"));
    }
}
