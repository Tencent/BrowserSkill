use super::{
    TOOL_IPC_TIMEOUT, business_rpc,
    ensure_daemon::ensure_daemon,
    error::{CliError, Format},
};
use anyhow::Context;
use bsk_protocol::{
    Method,
    tools::{CooperateAction, CooperateParams},
};
use clap::{Args, ValueEnum};

#[derive(Debug, Clone, ValueEnum)]
pub enum Action {
    Enable,
    Status,
    Sync,
    Wait,
}

#[derive(Debug, Clone, Args)]
pub struct CooperateArgs {
    /// Synchronize default shared control, inspect ownership, or wait for hand-back.
    /// Enable remains an optional alias for synchronization and task-tab binding.
    #[arg(value_enum)]
    pub action: Action,
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub tab_id: Option<i64>,
    /// Bounded wait, up to 25 seconds. Waiting never holds the action queue.
    #[arg(long, value_parser = clap::value_parser!(u64).range(0..=25000))]
    pub timeout_ms: Option<u64>,
    #[arg(long)]
    pub max_tokens: Option<u32>,
}

pub fn dispatch(args: CooperateArgs, _format: Format) -> Result<(), CliError> {
    let daemon = ensure_daemon().context("ensure daemon is running")?;
    let reply: serde_json::Value = business_rpc::call(
        daemon.sock_path,
        "cooperate",
        Method::ToolCooperate,
        Some(CooperateParams {
            session_id: args.session,
            tab_id: args.tab_id,
            action: match args.action {
                Action::Enable => CooperateAction::Enable,
                Action::Status => CooperateAction::Status,
                Action::Sync => CooperateAction::Sync,
                Action::Wait => CooperateAction::Wait,
            },
            timeout_ms: args.timeout_ms,
            max_tokens: args.max_tokens,
        }),
        TOOL_IPC_TIMEOUT,
    )?;
    println!(
        "{}",
        serde_json::to_string_pretty(&reply).context("render cooperation result")?
    );
    Ok(())
}
