//! `bsk mcp`: BrowserSkill tools for Model Context Protocol clients.
//!
//! The server speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and
//! forwards each tool call to the local daemon over IPC, as the CLI does,
//! without starting a `bsk` process per call. Results, receipts and errors
//! keep their CLI JSON shapes. Stdout carries protocol messages only; logs
//! go to stderr.

mod server;
mod tools;

pub use server::{Daemon, PROTOCOL_VERSIONS, serve};

use std::time::Duration;

use anyhow::Context;
use clap::Args;

use crate::cli::error::CliError;

#[derive(Debug, Clone, Args)]
pub struct McpArgs {}

/// Run the stdio server until the client closes stdin.
pub fn dispatch(_args: McpArgs) -> Result<(), CliError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("build tokio runtime for the MCP server")?;
    let result = runtime.block_on(serve(
        tokio::io::stdin(),
        tokio::io::stdout(),
        Daemon::Discover,
    ));
    // In-flight calls were cancelled when stdin closed; do not wait for a wedged one.
    runtime.shutdown_timeout(Duration::from_secs(5));
    result.map_err(CliError::Local)
}
