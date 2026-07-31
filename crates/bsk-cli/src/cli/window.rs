//! `bsk window …` subcommands — Agent Window management.

use std::path::PathBuf;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{WindowResizeParams, WindowResizeResult};
use clap::{Args, Subcommand};

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct WindowCmd {
    #[command(subcommand)]
    pub sub: WindowSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum WindowSub {
    /// Resize the session's Agent Window.
    Resize(WindowResizeArgs),
}

#[derive(Debug, Clone, Args)]
pub struct WindowResizeArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// New Agent Window outer width in CSS pixels (100..=7680).
    #[arg(long, value_parser = window_size)]
    pub width: u32,

    /// New Agent Window outer height in CSS pixels (100..=7680).
    #[arg(long, value_parser = window_size)]
    pub height: u32,
}

/// Parse a `--width` / `--height` Agent Window dimension (CSS pixels).
fn window_size(s: &str) -> Result<u32, String> {
    let value: u32 = s
        .parse()
        .map_err(|_| format!("invalid window dimension {s:?}: expected a positive integer"))?;
    if (100..=7680).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "window dimension {value} out of range (100..=7680)"
        ))
    }
}

pub fn dispatch(cmd: WindowCmd, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    match cmd.sub {
        WindowSub::Resize(args) => run_resize(info.sock_path, args, format),
    }
}

fn run_resize(sock: PathBuf, args: WindowResizeArgs, format: Format) -> Result<(), CliError> {
    let params = WindowResizeParams {
        session_id: args.session,
        width: args.width,
        height: args.height,
    };
    let reply: WindowResizeResult =
        ipc_call("window-resize-1", Method::ToolWindowResize, sock, params)?;
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(&reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            println!(
                "resized window_id={} to {}x{}",
                reply.window_id, reply.width, reply.height
            );
        }
    }
    Ok(())
}

fn ipc_call<P, R>(
    rpc_id_prefix: &'static str,
    method: Method,
    sock: PathBuf,
    params: P,
) -> Result<R, CliError>
where
    P: serde::Serialize + Send + 'static,
    R: serde::de::DeserializeOwned + Send + 'static,
{
    crate::cli::business_rpc::call::<P, R>(
        sock,
        rpc_id_prefix,
        method,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}
