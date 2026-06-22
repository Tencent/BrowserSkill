//! `bsk request-help` — pause and ask the human to complete an in-page
//! step (captcha / login / confirmation). Blocks until the user acts in
//! the browser overlay or the call times out.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{HelpTarget, RequestHelpParams, RequestHelpResult};
use clap::Args;

use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::navigate::parse_timeout_ms;

#[derive(Debug, Clone, Args)]
pub struct RequestHelpArgs {
    #[arg(long)]
    pub session: String,

    /// Message shown to the user explaining what they need to do.
    #[arg(long)]
    pub prompt: String,

    /// Optional custom title for the overlay panel.
    #[arg(long)]
    pub title: Option<String>,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Component to highlight. Repeatable. Accepts a snapshot ref
    /// (`@e3`) or a CSS selector (`#login`). A value starting with `@`
    /// or matching `eN` is treated as a ref; everything else is a
    /// selector.
    #[arg(long = "target")]
    pub target: Vec<String>,

    /// Hard timeout (default 5m). Accepts `5m`, `300s`, `300000ms`.
    #[arg(long, default_value = "5m", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

/// Classify a `--target` value as a ref or a selector. Refs are `@eN`
/// or bare `eN` (digits after a leading `e`); everything else is a CSS
/// selector.
pub fn parse_target(raw: &str) -> HelpTarget {
    let trimmed = raw.trim();
    let candidate = trimmed.strip_prefix('@').unwrap_or(trimmed);
    let is_ref = candidate.starts_with('e')
        && candidate.len() > 1
        && candidate[1..].chars().all(|c| c.is_ascii_digit());
    if is_ref {
        HelpTarget {
            ref_: Some(trimmed.to_string()),
            selector: None,
        }
    } else {
        HelpTarget {
            ref_: None,
            selector: Some(trimmed.to_string()),
        }
    }
}

pub fn dispatch(args: RequestHelpArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let targets: Vec<HelpTarget> = args.target.iter().map(|t| parse_target(t)).collect();
    let params = RequestHelpParams {
        session_id: args.session,
        tab_id: args.tab_id,
        prompt: args.prompt,
        title: args.title,
        targets: if targets.is_empty() {
            None
        } else {
            Some(targets)
        },
        timeout_ms: Some(args.timeout),
    };
    let reply = call(info.sock_path, params, args.timeout)?;
    render(&reply, format)
}

fn call(
    sock: PathBuf,
    params: RequestHelpParams,
    timeout_ms: u32,
) -> Result<RequestHelpResult, CliError> {
    crate::cli::business_rpc::call::<RequestHelpParams, RequestHelpResult>(
        sock,
        "request-help",
        Method::ToolRequestHelp,
        Some(params),
        ipc_timeout(timeout_ms),
    )
}

fn render(reply: &RequestHelpResult, format: Format) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            print!("tab={} outcome={}", reply.tab_id, reply.outcome.as_str());
            if let Some(note) = &reply.note {
                print!(" note={note:?}");
            }
            println!();
        }
    }
    Ok(())
}

/// IPC budget: requested timeout + 15s slack so the client does not
/// tear the connection down before the daemon's (long) wait resolves.
fn ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms))
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(u64::from(timeout_ms / 1_000) + 15))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_refs() {
        assert_eq!(parse_target("@e3").ref_.as_deref(), Some("@e3"));
        assert_eq!(parse_target("e12").ref_.as_deref(), Some("e12"));
        assert!(parse_target("@e3").selector.is_none());
    }

    #[test]
    fn classifies_selectors() {
        assert_eq!(parse_target("#login").selector.as_deref(), Some("#login"));
        assert_eq!(parse_target(".btn").selector.as_deref(), Some(".btn"));
        // `email` starts with `e` but is not `e<digits>` → selector.
        assert_eq!(parse_target("email").selector.as_deref(), Some("email"));
        assert!(parse_target("#login").ref_.is_none());
    }
}
