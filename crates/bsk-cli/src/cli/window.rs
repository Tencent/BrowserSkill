//! `bsk window …` subcommands — Agent Window management.

use std::path::PathBuf;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{WindowResizeParams, WindowResizeResult, WindowResizeWarning};
use clap::{Args, Subcommand};

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::ensure_daemon::ensure_daemon_optimistic as ensure_daemon;
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
    /// Session id (omit to resolve via caller scope).
    #[arg(long)]
    pub session: Option<String>,

    /// Explicit caller scope name for multi-agent isolation.
    #[arg(long)]
    pub scope: Option<String>,

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

pub fn dispatch(
    cmd: WindowCmd,
    ctx: &crate::cli::business_rpc::ClientContext,
    format: Format,
) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    match cmd.sub {
        WindowSub::Resize(args) => run_resize(info.sock_path, ctx, args, format),
    }
}

fn run_resize(
    sock: PathBuf,
    ctx: &crate::cli::business_rpc::ClientContext,
    args: WindowResizeArgs,
    format: Format,
) -> Result<(), CliError> {
    let op_ctx = ctx.with_scope(args.scope.as_deref());
    let params = WindowResizeParams {
        session_id: args.session.unwrap_or_default(),
        tab_id: None,
        width: args.width,
        height: args.height,
        context_id: None,
        observation_id: None,
        depends_on: None,
        expect: None,
    };
    let reply: WindowResizeResult = ipc_call(
        "window-resize-1",
        &op_ctx,
        Method::ToolWindowResize,
        sock,
        params,
    )?;
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(&reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            for line in human_resize_lines(&reply) {
                println!("{line}");
            }
        }
    }
    Ok(())
}

fn human_resize_lines(reply: &WindowResizeResult) -> Vec<String> {
    let mut lines = vec![if let Some(viewport) = &reply.actual_viewport {
        format!(
            "resized window_id={} outer={}x{} viewport={}x{}",
            reply.window_id, reply.width, reply.height, viewport.width, viewport.height
        )
    } else {
        format!(
            "resized window_id={} to {}x{}",
            reply.window_id, reply.width, reply.height
        )
    }];

    for warning in &reply.warnings {
        match warning {
            WindowResizeWarning::SizeConstrained => {
                let message = match &reply.requested {
                    Some(requested) => format!(
                        "warning: browser constrained requested outer size {}x{} to {}x{}",
                        requested.width, requested.height, reply.width, reply.height
                    ),
                    None => {
                        "warning: browser constrained the requested outer window size".to_owned()
                    }
                };
                lines.push(message);
            }
            WindowResizeWarning::ViewportDidNotFollow => {
                lines.push(
                    "warning: the tab viewport did not follow the resize; synchronize before further page actions"
                        .to_owned(),
                );
            }
        }
    }

    lines
}

fn ipc_call<P, R>(
    rpc_id_prefix: &'static str,
    ctx: &crate::cli::business_rpc::ClientContext,
    method: Method,
    sock: PathBuf,
    params: P,
) -> Result<R, CliError>
where
    P: serde::Serialize + Send + 'static,
    R: serde::de::DeserializeOwned + Send + 'static,
{
    ctx.call::<P, R>(sock, rpc_id_prefix, method, Some(params), TOOL_IPC_TIMEOUT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::tools::WindowResizeSize;

    #[test]
    fn human_output_reports_constrained_outer_size_and_viewport() {
        let result = WindowResizeResult {
            window_id: 42,
            width: 1200,
            height: 875,
            requested: Some(WindowResizeSize {
                width: 1200,
                height: 900,
            }),
            actual_viewport: Some(WindowResizeSize {
                width: 1185,
                height: 523,
            }),
            warnings: vec![WindowResizeWarning::SizeConstrained],
        };

        assert_eq!(
            human_resize_lines(&result),
            vec![
                "resized window_id=42 outer=1200x875 viewport=1185x523",
                "warning: browser constrained requested outer size 1200x900 to 1200x875",
            ]
        );
    }
}
