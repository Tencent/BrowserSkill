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

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{
    EvaluateParams, EvaluateResult, UNVERIFIED_SCRIPT_PROTOCOL, supports_unverified_script,
};
use clap::Args;

use crate::cli::business_rpc::{self, ipc_timeout};
use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon_with_protocol;
use crate::cli::error::{CliError, Format};
use crate::cli::navigate::parse_timeout_ms;

#[derive(Debug, Clone, Args)]
pub struct EvaluateArgs {
    /// JavaScript expression to evaluate. Wrap with quotes; statements
    /// that need an explicit return should `return` from an IIFE or
    /// place the value last (CDP returns the expression's value, not a
    /// statement's).
    pub expression: String,

    /// Session id (omit to resolve via caller scope).
    #[arg(long)]
    pub session: Option<String>,

    /// Explicit caller scope name for multi-agent isolation.
    #[arg(long)]
    pub scope: Option<String>,

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

    /// Run without comparing the page with any observation: no --observation
    /// is needed and nothing is refused because the page changed. Control,
    /// the document and tab ownership are still checked. Last resort: first
    /// state what the script relies on with --expect and no --observation
    /// (target policy) or --depends-on (strict policy), which keeps a real
    /// check and also runs on pages that keep changing. The script should check its own
    /// preconditions and throw; the result carries `verified: false`.
    #[arg(long)]
    pub unverified: bool,
}

pub fn dispatch(args: EvaluateArgs, format: Format) -> Result<(), CliError> {
    // Asking for a page check and for none at once is a contradiction, not a
    // stricter request. Refuse before anything reaches the daemon.
    if args.unverified && business_rpc::verification_requested() {
        return Err(CliError::invalid_params(anyhow::anyhow!(
            "--unverified skips page verification; omit --expect, --observation and --depends-on, or omit --unverified to have them checked"
        )));
    }
    business_rpc::set_caller_scope(args.scope);
    let (info, protocol) = ensure_daemon_with_protocol().context("ensure daemon is running")?;
    business_rpc::check_daemon_protocol(&protocol)?;
    if args.unverified {
        require_unverified_script(&protocol)?;
    }
    let params = EvaluateParams {
        session_id: args.session.unwrap_or_default(),
        expression: args.expression,
        tab_id: args.tab_id,
        await_promise: Some(args.await_promise),
        return_by_value: Some(args.return_by_value),
        timeout_ms: Some(args.timeout),
        unverified: args.unverified.then_some(true),
    };
    let reply = call(info.sock_path, params, args.timeout)?;
    render(&reply, format)
}

/// An older daemon or extension would ignore the flag and apply its page
/// checks, so the refusal would look unexplained. Fail before dispatch instead.
pub(crate) fn require_unverified_script(protocol: &str) -> Result<(), CliError> {
    if supports_unverified_script(protocol) {
        return Ok(());
    }
    Err(CliError::from_rpc(bsk_protocol::RpcError {
        code: bsk_protocol::ErrorCode::Unsupported,
        message: format!(
            "evaluate --unverified requires daemon protocol {UNVERIFIED_SCRIPT_PROTOCOL} or a later compatible 1.x version; update the CLI and restart its daemon (running protocol {protocol})"
        ),
        data: Some(serde_json::json!({
            "reason": "unsupported_feature", "phase": "negotiate", "effect_state": "none",
            "required_protocol": UNVERIFIED_SCRIPT_PROTOCOL, "actual_protocol": protocol,
        })),
    }))
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
            if reply.verified == Some(false) {
                eprintln!("note: ran unverified; the page was not compared with any observation");
            }
        }
    }
    Ok(())
}
