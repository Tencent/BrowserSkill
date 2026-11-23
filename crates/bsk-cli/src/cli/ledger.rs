//! CLI subcommands for inspecting and manually reconciling the Daemon Intent WAL (`RM-03`).
//!
//! - `bsk ledger status [--session <id>] [--scope <name>]`
//! - `bsk ledger resolve [--session <id>] [--scope <name>] [--tab-id <id>] [--operation-id <id>]`

use std::time::Duration;

use bsk_protocol::Method;
use clap::{Args, Subcommand};
use serde_json::json;

use super::business_rpc;
use super::ensure_daemon::ensure_daemon_optimistic as ensure_daemon;
use super::error::{CliError, Format};
use crate::daemon::intent_wal::{IntentState, LedgerResolveReply, LedgerStatusReply};

const LEDGER_RPC_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Args)]
pub struct LedgerCmd {
    #[command(subcommand)]
    pub command: LedgerSubcommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum LedgerSubcommand {
    /// Show pending `UNKNOWN` intents and recent write-ahead ledger entries.
    Status(LedgerStatusArgs),
    /// Manually reconcile pending `UNKNOWN` intents after verifying application state.
    Resolve(LedgerResolveArgs),
}

#[derive(Debug, Clone, Args)]
pub struct LedgerStatusArgs {
    /// Explicit session ID (omit to resolve via caller scope or inspect daemon-wide).
    #[arg(long)]
    pub session: Option<String>,

    /// Explicit caller scope name for multi-agent session isolation.
    #[arg(long)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct LedgerResolveArgs {
    /// Explicit session ID (omit to resolve via caller scope).
    #[arg(long)]
    pub session: Option<String>,

    /// Explicit caller scope name for multi-agent session isolation.
    #[arg(long)]
    pub scope: Option<String>,

    /// Restrict resolution to a specific browser tab ID.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Restrict resolution to a single operation ID.
    #[arg(long = "operation-id")]
    pub operation_id: Option<String>,
}

pub fn dispatch(
    cmd: LedgerCmd,
    ctx: &business_rpc::ClientContext,
    format: Format,
) -> Result<(), CliError> {
    match cmd.command {
        LedgerSubcommand::Status(args) => dispatch_status(args, ctx, format),
        LedgerSubcommand::Resolve(args) => dispatch_resolve(args, ctx, format),
    }
}

fn dispatch_status(
    args: LedgerStatusArgs,
    ctx: &business_rpc::ClientContext,
    format: Format,
) -> Result<(), CliError> {
    let op_ctx = ctx.with_scope(args.scope.as_deref());
    let info = ensure_daemon().map_err(CliError::Local)?;
    let params = json!({
        "action": "status",
        "session_id": args.session.unwrap_or_default(),
    });
    let reply: LedgerStatusReply = op_ctx.call(
        info.sock_path,
        "ledger-status",
        Method::LedgerRequest,
        Some(params),
        LEDGER_RPC_TIMEOUT,
    )?;

    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply)
                    .map_err(|e| CliError::Local(anyhow::Error::new(e)))?
            );
        }
        Format::Human => {
            let session_label = reply.session_id.as_deref().unwrap_or("all");
            let state_label = if reply.frozen { "frozen" } else { "clear" };
            println!(
                "ledger status session={session_label} state={state_label} pending_unknown={}",
                reply.pending_unknown.len()
            );
            for entry in &reply.pending_unknown {
                let tab = entry
                    .tab_id
                    .map_or_else(|| "-".to_string(), |t| t.to_string());
                println!(
                    "  unknown op={} tab={tab} method={} target={:?} dispatched_at={}",
                    entry.operation_id, entry.method, entry.target_summary, entry.dispatched_at
                );
            }
            let tail_start = reply.recent.len().saturating_sub(10);
            for entry in &reply.recent[tail_start..] {
                let tab = entry
                    .tab_id
                    .map_or_else(|| "-".to_string(), |t| t.to_string());
                println!(
                    "  recent  op={} state={} tab={tab} method={} target={:?}",
                    entry.operation_id,
                    state_str(entry.state),
                    entry.method,
                    entry.target_summary
                );
            }
        }
    }
    Ok(())
}

fn dispatch_resolve(
    args: LedgerResolveArgs,
    ctx: &business_rpc::ClientContext,
    format: Format,
) -> Result<(), CliError> {
    let op_ctx = ctx.with_scope(args.scope.as_deref());
    let info = ensure_daemon().map_err(CliError::Local)?;
    let mut params = json!({
        "action": "resolve",
        "session_id": args.session.unwrap_or_default(),
    });
    if let Some(tid) = args.tab_id {
        params["tab_id"] = json!(tid);
    }
    if let Some(op_id) = args.operation_id {
        params["operation_id"] = json!(op_id);
    }
    let reply: LedgerResolveReply = op_ctx.call(
        info.sock_path,
        "ledger-resolve",
        Method::LedgerRequest,
        Some(params),
        LEDGER_RPC_TIMEOUT,
    )?;

    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply)
                    .map_err(|e| CliError::Local(anyhow::Error::new(e)))?
            );
        }
        Format::Human => {
            let session_label = reply.session_id.as_deref().unwrap_or("-");
            println!(
                "ledger resolve ok session={session_label} resolved={}",
                reply.resolved_count
            );
            for entry in &reply.resolved {
                let tab = entry
                    .tab_id
                    .map_or_else(|| "-".to_string(), |t| t.to_string());
                println!(
                    "  reconciled op={} tab={tab} method={} target={:?}",
                    entry.operation_id, entry.method, entry.target_summary
                );
            }
        }
    }
    Ok(())
}

fn state_str(state: IntentState) -> &'static str {
    match state {
        IntentState::Dispatched => "DISPATCHED",
        IntentState::Settled => "SETTLED",
        IntentState::Unknown => "UNKNOWN",
        IntentState::Reconciled => "RECONCILED",
    }
}
