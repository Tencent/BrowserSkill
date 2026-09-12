//! `bsk evaluate <expression>` — run an arbitrary JS expression inside
//! the session's Agent Window (M9.1). Thin clap wrapper around the
//! `tool.evaluate` IPC call.
//!
//! Exit-code policy (design §3.1, design doc §7 evaluate red-line):
//! * `ok: true`  → exit code 0, print the JSON-serialised value.
//! * `ok: false` → exit code 0 still (the call itself succeeded; the
//!   throw is in-band data the agent must read). The error text is
//!   printed to stderr in human mode and emitted inside the JSON
//!   payload in `--json` mode.
//! * RPC failure (`not_found / permission_denied / cdp_failed / …`) →
//!   normal `CliError` path with the usual non-zero exit codes.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{EvaluateParams, EvaluateResult};
use clap::Args;

use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::navigate::parse_timeout_ms;

#[derive(Debug, Clone, Args)]
pub struct EvaluateArgs {
    /// JavaScript expression to evaluate. Wrap with quotes; statements
    /// that need an explicit return should `return` from an IIFE or
    /// place the value last (CDP returns the expression's value, not a
    /// statement's).
    pub expression: String,

    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Await the expression's resolved value when it returns a Promise
    /// (CDP `awaitPromise`). Defaults to true.
    #[arg(long = "await-promise", default_value_t = true, action = clap::ArgAction::Set)]
    pub await_promise: bool,

    /// Ask CDP to serialise the result by value. Defaults to true so
    /// the CLI receives a plain JSON value instead of a RemoteObject id.
    #[arg(long = "return-by-value", default_value_t = true, action = clap::ArgAction::Set)]
    pub return_by_value: bool,

    /// Hard timeout (default 30s). Accepts `30s`, `1m`, `1500ms`.
    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

pub fn dispatch(args: EvaluateArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = EvaluateParams {
        session_id: args.session,
        expression: args.expression,
        tab_id: args.tab_id,
        await_promise: Some(args.await_promise),
        return_by_value: Some(args.return_by_value),
        timeout_ms: Some(args.timeout),
    };
    let reply = call(info.sock_path, params, args.timeout)?;
    render(&reply, format)
}

fn call(
    sock: PathBuf,
    params: EvaluateParams,
    timeout_ms: u32,
) -> Result<EvaluateResult, CliError> {
    crate::cli::business_rpc::call::<EvaluateParams, EvaluateResult>(
        sock,
        "evaluate",
        Method::ToolEvaluate,
        Some(params),
        ipc_timeout(timeout_ms),
    )
}

fn ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms))
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(u64::from(timeout_ms / 1_000) + 15))
}

fn render(reply: &EvaluateResult, format: Format) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            if reply.ok {
                match &reply.value {
                    Some(v) => {
                        // `null` is meaningful (the expression
                        // evaluated to undefined / null) — print it
                        // verbatim instead of an empty line.
                        match v {
                            serde_json::Value::String(s) => println!("{s}"),
                            other => {
                                let s =
                                    serde_json::to_string(other).unwrap_or_else(|_| "null".into());
                                println!("{s}");
                            }
                        }
                    }
                    None => println!("null"),
                }
            } else if let Some(err) = &reply.error {
                // Keep stdout reserved for the (missing) value; the
                // throw text goes to stderr so a shell pipeline still
                // sees the exit code 0 result.
                eprintln!("evaluate threw: {}", err.text);
                if let (Some(line), Some(column)) = (err.line, err.column) {
                    eprintln!("  at line {line}, column {column}");
                }
            } else {
                eprintln!("evaluate failed: ok=false with no error payload");
            }
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}
