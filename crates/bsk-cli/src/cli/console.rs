//! `bsk console` — read buffered page console/log/exception messages.

use std::path::PathBuf;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{ConsoleEntry, ConsoleParams, ConsoleResult};
use clap::Args;

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct ConsoleArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Return entries with sequence greater than this cursor.
    #[arg(long)]
    pub since: Option<u64>,

    /// Maximum number of entries to return. Defaults to 50; extension caps at 200.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..))]
    pub limit: Option<u32>,

    /// Maximum characters per entry text. Defaults to 1000; extension caps at 4096.
    #[arg(long = "max-text-chars", value_parser = clap::value_parser!(u32).range(1..))]
    pub max_text_chars: Option<u32>,

    /// Include structured stack frames in JSON/human output.
    #[arg(long = "include-stack", default_value_t = false)]
    pub include_stack: bool,
}

pub fn dispatch(args: ConsoleArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    run(info.sock_path, args, format)
}

fn run(sock: PathBuf, args: ConsoleArgs, format: Format) -> Result<(), CliError> {
    let params = ConsoleParams {
        session_id: args.session,
        tab_id: args.tab_id,
        since: args.since,
        limit: args.limit,
        max_text_chars: args.max_text_chars,
        include_stack: args.include_stack.then_some(true),
    };
    let reply: ConsoleResult = call(sock, params)?;
    render(&reply, format)
}

fn call(sock: PathBuf, params: ConsoleParams) -> Result<ConsoleResult, CliError> {
    crate::cli::business_rpc::call::<ConsoleParams, ConsoleResult>(
        sock,
        "console",
        Method::ToolConsole,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}

fn render(reply: &ConsoleResult, format: Format) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            if reply.entries.is_empty() {
                println!("(no console messages captured)");
            } else {
                for entry in &reply.entries {
                    println!("{}", render_entry(entry));
                    for frame in &entry.stack_trace {
                        let loc = render_location(frame.url.as_deref(), frame.line, frame.column);
                        let name = frame.function_name.as_deref().unwrap_or("<anonymous>");
                        println!("  at {name} {loc}");
                    }
                }
            }
            if reply.truncated {
                eprintln!(
                    "warning: console output truncated (next_since={}). Use --since / --limit / --max-text-chars to request a different slice.",
                    reply.next_since
                );
            }
        }
    }
    Ok(())
}

fn render_entry(entry: &ConsoleEntry) -> String {
    let loc = render_location(entry.url.as_deref(), entry.line, entry.column);
    if loc.is_empty() {
        format!(
            "#{} {} {} {}",
            entry.sequence,
            entry.level,
            entry.kind.as_str(),
            entry.text
        )
    } else {
        format!(
            "#{} {} {} {} {}",
            entry.sequence,
            entry.level,
            entry.kind.as_str(),
            loc,
            entry.text
        )
    }
}

fn render_location(url: Option<&str>, line: Option<i64>, column: Option<i64>) -> String {
    let Some(url) = url else {
        return String::new();
    };
    match (line, column) {
        (Some(line), Some(column)) => format!("{url}:{line}:{column}"),
        (Some(line), None) => format!("{url}:{line}"),
        _ => url.to_string(),
    }
}
