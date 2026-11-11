//! Bounded DOM reads: data parameters, never caller JavaScript.
use super::{
    TOOL_IPC_TIMEOUT, business_rpc,
    ensure_daemon::ensure_daemon,
    error::{CliError, Format},
};
use anyhow::Context;
use bsk_protocol::{
    Method,
    tools::{ReadField, ReadParams, ReadResult},
};
use clap::Args;

#[derive(Debug, Clone, Args)]
pub struct ReadArgs {
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub tab_id: Option<i64>,
    /// CSS selector in the main document. Reads all matches, up to max-nodes.
    #[arg(long, conflicts_with = "ref_")]
    pub selector: Option<String>,
    /// Exact observed DOM ref, including iframe/shadow nodes. Never retargeted.
    #[arg(long = "ref", conflicts_with = "selector")]
    pub ref_: Option<String>,
    /// JSON array of {key, read, optional selector/attribute}. Reads: text, attribute,
    /// value, checked, exists. Default: [{"key":"text","read":"text"}]. No JavaScript.
    #[arg(long)]
    pub fields_json: Option<String>,
    #[arg(long, value_parser=clap::value_parser!(u32).range(1..=1000))]
    pub max_nodes: Option<u32>,
    #[arg(long, value_parser=clap::value_parser!(u32).range(1024..=1048576))]
    pub max_bytes: Option<u32>,
    #[arg(long, value_parser=clap::value_parser!(u32).range(100..=10000))]
    pub timeout_ms: Option<u32>,
}
pub fn dispatch(args: ReadArgs, _format: Format) -> Result<(), CliError> {
    let fields: Option<Vec<ReadField>> = args
        .fields_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .context("parse --fields-json as a DOM read field array")?;
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = ReadParams {
        session_id: args.session,
        tab_id: args.tab_id,
        context_id: None,
        selector: args.selector,
        ref_: args.ref_,
        fields,
        max_nodes: args.max_nodes,
        max_bytes: args.max_bytes,
        timeout_ms: args.timeout_ms,
    };
    let reply: ReadResult = business_rpc::call(
        info.sock_path,
        "read",
        Method::ToolRead,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )?;
    println!(
        "{}",
        serde_json::to_string_pretty(&reply).map_err(|e| CliError::Local(e.into()))?
    );
    Ok(())
}
