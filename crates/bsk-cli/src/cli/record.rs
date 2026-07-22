//! `bsk record start|stop` — capture user actions in the Agent Window.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{
    RecordAwaitParams, RecordAwaitResult, RecordStartParams, RecordStartResult, RecordStopParams,
    RecordStopResult, Trace,
};
use clap::{Args, Subcommand};

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::business_rpc;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::record_state;
use crate::cli::session::{start_session, stop_session};

/// Max wait for the user to click 结束 in the browser (24 hours).
const RECORD_AWAIT_TIMEOUT_MS: u32 = 86_400_000;

/// `bsk record …` subcommand tree.
#[derive(Debug, Clone, Args)]
pub struct RecordCmd {
    #[command(subcommand)]
    pub sub: RecordSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum RecordSub {
    /// Open the Agent Window, record user actions, and block until finished in the browser.
    Start(RecordStartArgs),
    /// Stop recording from the terminal (fallback), write trace JSON, and close the window.
    /// Works even while `record start` is blocked in `record_await` (daemon forwards
    /// `tool.record_stop` without the per-session busy gate).
    Stop(RecordStopArgs),
}

#[derive(Debug, Clone, Args)]
pub struct RecordStartArgs {
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Navigate to this http(s) URL before recording (required for a fresh
    /// session — Agent Window starts on about:blank, which cannot host the
    /// content script).
    #[arg(long)]
    pub url: Option<String>,

    /// Optional goal text stored on the exported trace for LLM context.
    #[arg(long)]
    pub purpose: Option<String>,

    /// Output path for the trace JSON (default `./trace.json`).
    #[arg(long, default_value = "trace.json")]
    pub output: PathBuf,
}

#[derive(Debug, Clone, Args)]
pub struct RecordStopArgs {
    /// Output path for the trace JSON (default `./trace.json`).
    #[arg(long, default_value = "trace.json")]
    pub output: PathBuf,
}

pub fn dispatch(cmd: RecordCmd, format: Format) -> Result<(), CliError> {
    match cmd.sub {
        RecordSub::Start(args) => dispatch_start(args, format),
        RecordSub::Stop(args) => dispatch_stop(args, format),
    }
}

fn dispatch_start(args: RecordStartArgs, format: Format) -> Result<(), CliError> {
    if record_state::read().is_ok() {
        return Err(CliError::Local(anyhow::anyhow!(
            "a recording is already in progress; run `bsk record stop` first"
        )));
    }

    let info = ensure_daemon().context("ensure daemon is running")?;
    let session = start_session(info.sock_path.clone(), None)?;

    let start_params = RecordStartParams {
        session_id: session.session_id.clone(),
        tab_id: args.tab_id,
        url: args.url,
        purpose: args.purpose.clone(),
    };
    let start_result = business_rpc::call::<RecordStartParams, RecordStartResult>(
        info.sock_path.clone(),
        "record-start",
        Method::ToolRecordStart,
        Some(start_params),
        TOOL_IPC_TIMEOUT,
    );

    let start_result = match start_result {
        Ok(result) => result,
        Err(err) => {
            let _ = stop_session(info.sock_path, &session.session_id);
            return Err(err);
        }
    };

    if let Err(err) = record_state::write(&session.session_id) {
        let _ = stop_session(info.sock_path.clone(), &session.session_id);
        return Err(CliError::Local(err));
    }

    if format == Format::Human {
        println!(
            "recording on tab={} — click 结束 in the browser when done",
            start_result.tab_id
        );
    }

    let await_params = RecordAwaitParams {
        session_id: session.session_id.clone(),
        timeout_ms: Some(RECORD_AWAIT_TIMEOUT_MS),
    };
    let await_result = business_rpc::call::<RecordAwaitParams, RecordAwaitResult>(
        info.sock_path.clone(),
        "record-await",
        Method::ToolRecordAwait,
        Some(await_params),
        record_await_ipc_timeout(RECORD_AWAIT_TIMEOUT_MS),
    );

    // Keep write/render inside a Result so `?` cannot skip session teardown.
    let run_result: Result<(), CliError> = match await_result {
        Ok(result) => (|| {
            write_trace_file(&args.output, &result.trace)?;
            render_finish(&result.trace, &args.output, format)
        })(),
        Err(err) => Err(err),
    };

    let session_stop_result = stop_session(info.sock_path, &session.session_id);
    record_state::clear();

    run_result?;
    session_stop_result?;
    Ok(())
}

fn dispatch_stop(args: RecordStopArgs, format: Format) -> Result<(), CliError> {
    let state = record_state::read().map_err(CliError::Local)?;
    let info = ensure_daemon().context("ensure daemon is running")?;
    let session_id = state.session_id.clone();

    let run_result: Result<(), CliError> = (|| {
        let params = RecordStopParams {
            session_id: session_id.clone(),
        };
        let result = business_rpc::call::<RecordStopParams, RecordStopResult>(
            info.sock_path.clone(),
            "record-stop",
            Method::ToolRecordStop,
            Some(params),
            TOOL_IPC_TIMEOUT,
        )?;
        write_trace_file(&args.output, &result.trace)?;
        render_stop(&result, &args.output, format)
    })();

    let session_stop_result = stop_session(info.sock_path, &session_id);
    record_state::clear();

    run_result?;
    session_stop_result?;
    Ok(())
}

fn record_await_ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms))
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(u64::from(timeout_ms / 1_000) + 15))
}

fn write_trace_file(output: &PathBuf, trace: &Trace) -> Result<(), CliError> {
    let json = serde_json::to_string_pretty(trace)
        .context("serialize trace JSON")
        .map_err(CliError::Local)?;
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create output directory {}", parent.display()))
                .map_err(CliError::Local)?;
        }
    }
    fs::write(output, format!("{json}\n"))
        .with_context(|| format!("write trace to {}", output.display()))
        .map_err(CliError::Local)?;
    Ok(())
}

fn render_finish(trace: &Trace, output: &PathBuf, format: Format) -> Result<(), CliError> {
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({
                    "output": output,
                    "trace": trace,
                    "window_closed": true,
                }))
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            println!("saved {} steps to {}", trace.steps.len(), output.display());
        }
    }
    Ok(())
}

fn render_stop(
    result: &RecordStopResult,
    output: &PathBuf,
    format: Format,
) -> Result<(), CliError> {
    render_finish(&result.trace, output, format)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_output_is_trace_json() {
        let args = RecordStopArgs {
            output: PathBuf::from("trace.json"),
        };
        assert_eq!(args.output, PathBuf::from("trace.json"));
    }

    #[test]
    fn start_args_default_output_is_trace_json() {
        let args = RecordStartArgs {
            tab_id: None,
            url: None,
            purpose: None,
            output: PathBuf::from("trace.json"),
        };
        assert_eq!(args.output, PathBuf::from("trace.json"));
    }

    #[test]
    fn record_await_ipc_timeout_covers_long_wait() {
        let got = record_await_ipc_timeout(RECORD_AWAIT_TIMEOUT_MS);
        assert!(got >= Duration::from_secs(86_400));
    }
}
