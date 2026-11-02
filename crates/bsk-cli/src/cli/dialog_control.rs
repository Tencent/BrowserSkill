//! Explicit native dialog decisions and retrieval of the original suspended tool result.

use super::{
    business_rpc,
    ensure_daemon::ensure_daemon,
    error::{CliError, Format},
};
use bsk_protocol::Method;
use bsk_protocol::tools::{DialogHandleParams, DialogStatusParams, OperationParams};
use clap::{Args, Subcommand};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Args)]
pub struct DialogCmd {
    #[command(subcommand)]
    pub sub: DialogSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum DialogSub {
    /// Read pending native JS dialogs without querying the blocked renderer.
    Status(DialogStatusArgs),
    /// Confirm a dialog; --text supplies prompt input, including an empty string.
    Accept(DialogAcceptArgs),
    /// Cancel a dialog (beforeunload stays on the page).
    Dismiss(DialogDismissArgs),
}

#[derive(Debug, Clone, Args)]
pub struct DialogStatusArgs {
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub tab_id: Option<i64>,
}

#[derive(Debug, Clone, Args)]
pub struct DialogAcceptArgs {
    pub dialog_id: String,
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct DialogDismissArgs {
    pub dialog_id: String,
    #[arg(long)]
    pub session: String,
}

#[derive(Debug, Clone, Args)]
pub struct OperationCmd {
    #[command(subcommand)]
    pub sub: OperationSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum OperationSub {
    /// Retrieve the ORIGINAL result; never repeats its browser action.
    Await(OperationAwaitArgs),
    /// Cancel an outstanding operation and reject its pending modal.
    Cancel(OperationCancelArgs),
}

#[derive(Debug, Clone, Args)]
pub struct OperationAwaitArgs {
    pub operation_id: String,
    #[arg(long)]
    pub session: String,
    #[arg(long, default_value_t = 10000, value_parser = clap::value_parser!(u32).range(0..=60000))]
    pub wait_ms: u32,
    /// Save a completed download's retained bytes without repeating its browser action.
    #[arg(long)]
    pub out: Option<PathBuf>,
    #[arg(long, requires = "out")]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Args)]
pub struct OperationCancelArgs {
    pub operation_id: String,
    #[arg(long)]
    pub session: String,
}

fn invoke(
    method: Method,
    params: impl serde::Serialize + Send + 'static,
    timeout: Duration,
) -> Result<(), CliError> {
    let info = ensure_daemon()?;
    let value: Value = business_rpc::call(info.sock_path, "dialog", method, Some(params), timeout)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&value).map_err(anyhow::Error::from)?
    );
    Ok(())
}

pub fn dispatch_dialog(cmd: DialogCmd, _format: Format) -> Result<(), CliError> {
    match cmd.sub {
        DialogSub::Status(p) => invoke(
            Method::ToolDialogStatus,
            DialogStatusParams {
                session_id: p.session,
                tab_id: p.tab_id,
            },
            Duration::from_secs(10),
        ),
        DialogSub::Accept(p) => invoke(
            Method::ToolDialogAccept,
            DialogHandleParams {
                session_id: p.session,
                dialog_id: p.dialog_id,
                text: p.text,
            },
            Duration::from_secs(10),
        ),
        DialogSub::Dismiss(p) => invoke(
            Method::ToolDialogDismiss,
            DialogHandleParams {
                session_id: p.session,
                dialog_id: p.dialog_id,
                text: None,
            },
            Duration::from_secs(10),
        ),
    }
}

pub fn dispatch_operation(cmd: OperationCmd, _format: Format) -> Result<(), CliError> {
    let (method, params, output) = match cmd.sub {
        OperationSub::Await(p) => (
            Method::ToolOperationAwait,
            OperationParams {
                session_id: p.session,
                operation_id: p.operation_id,
                wait_ms: Some(p.wait_ms),
            },
            p.out.map(|path| (path, p.overwrite)),
        ),
        OperationSub::Cancel(p) => (
            Method::ToolOperationCancel,
            OperationParams {
                session_id: p.session,
                operation_id: p.operation_id,
                wait_ms: None,
            },
            None,
        ),
    };
    let timeout = Duration::from_millis(params.wait_ms.unwrap_or(0) as u64 + 10000);
    let info = ensure_daemon()?;
    let mut value: Value = business_rpc::call(
        info.sock_path.clone(),
        "operation",
        method,
        Some(params),
        timeout,
    )?;
    if let Some((out, overwrite)) = output {
        if value["method"] != "tool.download" {
            return Err(CliError::Local(anyhow::anyhow!(
                "--out is only supported for download operations"
            )));
        }
        if value["state"] == "completed" {
            let id = value["result"]["transfer_id"].as_str().ok_or_else(|| {
                CliError::Local(anyhow::anyhow!(
                    "completed download has no retained transfer id"
                ))
            })?;
            super::download::write_transfer(&info.sock_path, id, &out, overwrite)?;
            // Keep the retained transfer available for repeated retrieval or another
            // output path. Session teardown and the transfer TTL own its cleanup.
            value["result"]["path"] = serde_json::json!(out.to_string_lossy());
            value["result"]["saved"] = serde_json::json!(true);
        }
    } else if value["method"] == "tool.download" && value["state"] == "completed" {
        value["result"]["saved"] = serde_json::json!(false);
        value["result"]["save_hint"] = serde_json::json!(
            "Use operation await with --out PATH and optional --overwrite to save this retained download; do not repeat the browser action"
        );
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&value).map_err(anyhow::Error::from)?
    );
    Ok(())
}
