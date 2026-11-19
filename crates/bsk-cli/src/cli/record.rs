//! `bsk record start|stop` — capture user actions in the Agent Window.

use std::path::{Path, PathBuf};

use anyhow::Context;
use bsk_protocol::tools::{
    RecordAwaitParams, RecordAwaitResult, RecordStartParams, RecordStartResult, RecordStopParams,
    RecordStopResult, RecordedTrace,
};
use bsk_protocol::{ErrorCode, Method};
use clap::{Args, Subcommand};

use crate::cli::TOOL_IPC_TIMEOUT;

pub(crate) mod export;

use crate::cli::business_rpc::{ClientContext, ipc_timeout};
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::record_recovery;
use crate::cli::record_state;
use crate::cli::session::{
    SessionStartOptions, start_session_with_context, stop_record_session_with_context,
    stop_session_with_context,
};
use export::{ExportMeta, export_with_recovery, trace_json_path, validate_record_output};

/// Max wait for the user to click 结束 in the browser (24 hours).
pub(crate) const RECORD_AWAIT_TIMEOUT_MS: u32 = 86_400_000;

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
    /// Target browser instance id or label. Required when multiple browsers
    /// are connected; omit when only one is online.
    #[arg(long)]
    pub browser: Option<String>,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Navigate to this http(s) URL before recording. When omitted, defaults
    /// to `https://example.com/`. If that page does not load, pass `--url`
    /// with a site you can open in this browser.
    #[arg(long)]
    pub url: Option<String>,

    /// Optional goal text stored on the exported trace for LLM context.
    #[arg(long)]
    pub purpose: Option<String>,

    /// Max VOM tokens per page observation file (default 3000).
    #[arg(long = "max-page-tokens")]
    pub max_page_tokens: Option<u32>,

    /// Redact all form values in page observations (`[filled]` only).
    #[arg(long = "redact-values")]
    pub redact_values: bool,

    /// Output directory for the trace bundle (default `./trace`).
    /// Writes `<dir>/trace.json` and `<dir>/states/*.txt`.
    #[arg(long, default_value = "trace")]
    pub output: PathBuf,
}

#[derive(Debug, Clone, Args)]
pub struct RecordStopArgs {
    /// Output directory for the trace bundle (default `./trace`).
    /// Writes `<dir>/trace.json` and `<dir>/states/*.txt`.
    #[arg(long, default_value = "trace")]
    pub output: PathBuf,
}

pub fn dispatch(cmd: RecordCmd, ctx: &ClientContext, format: Format) -> Result<(), CliError> {
    ctx.prepare_params(&Method::ToolRecordStart, Some(serde_json::json!({})))?;
    let aux_ctx = ctx.without_action_metadata();
    match cmd.sub {
        RecordSub::Start(args) => dispatch_start(args, &aux_ctx, format),
        RecordSub::Stop(args) => dispatch_stop(args, &aux_ctx, format),
    }
}

fn dispatch_start(
    args: RecordStartArgs,
    ctx: &ClientContext,
    format: Format,
) -> Result<(), CliError> {
    prepare_record_start(&args.output)?;

    let info = ensure_daemon().context("ensure daemon is running")?;
    let session = start_session_with_context(
        info.sock_path.clone(),
        ctx,
        SessionStartOptions {
            browser: args.browser,
            focused: Some(true),
            ..SessionStartOptions::default()
        },
    )?;

    let start_params = RecordStartParams {
        session_id: session.session_id.clone(),
        tab_id: args.tab_id,
        url: args.url.clone(),
        purpose: args.purpose.clone(),
        max_page_tokens: args.max_page_tokens,
        redact_values: Some(args.redact_values),
    };
    let start_result = ctx.call::<RecordStartParams, RecordStartResult>(
        info.sock_path.clone(),
        "record-start",
        Method::ToolRecordStart,
        Some(start_params),
        TOOL_IPC_TIMEOUT,
    );

    let start_result = match start_result {
        Ok(result) => result,
        Err(err) => {
            let _ = stop_session_with_context(info.sock_path, ctx, &session.session_id);
            return Err(annotate_default_start_page_error(err, args.url.as_deref()));
        }
    };

    if let Err(err) = record_state::write(&session.session_id) {
        let _ = stop_session_with_context(info.sock_path.clone(), ctx, &session.session_id);
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
    let await_result = ctx.call::<RecordAwaitParams, RecordAwaitResult>(
        info.sock_path.clone(),
        "record-await",
        Method::ToolRecordAwait,
        Some(await_params),
        ipc_timeout(RECORD_AWAIT_TIMEOUT_MS),
    );

    finish_recording(
        info.sock_path,
        ctx,
        &session.session_id,
        await_result.map(|result| result.trace),
        &args.output,
        format,
    )
}

fn dispatch_stop(
    args: RecordStopArgs,
    ctx: &ClientContext,
    format: Format,
) -> Result<(), CliError> {
    validate_record_output(&args.output)?;

    if let Ok(state) = record_state::read() {
        let info = ensure_daemon().context("ensure daemon is running")?;
        let session_id = state.session_id.clone();

        let params = RecordStopParams {
            session_id: session_id.clone(),
        };
        let result = ctx
            .call::<RecordStopParams, RecordStopResult>(
                info.sock_path.clone(),
                "record-stop",
                Method::ToolRecordStop,
                Some(params),
                TOOL_IPC_TIMEOUT,
            )
            .map_err(|err| forget_stale_recording(err, &session_id))?;

        return finish_recording(
            info.sock_path,
            ctx,
            &session_id,
            Ok(result.trace),
            &args.output,
            format,
        );
    }

    let Some(trace) = record_recovery::load().map_err(CliError::Local)? else {
        return Err(CliError::Local(anyhow::anyhow!(
            "no recording in progress; run `bsk record start` first"
        )));
    };

    let exported = export_with_recovery(&args.output, &trace)?;
    render_finish(&trace, &args.output, &exported, format)
}

fn finish_recording(
    sock: PathBuf,
    ctx: &ClientContext,
    session_id: &str,
    trace: Result<RecordedTrace, CliError>,
    output: &PathBuf,
    format: Format,
) -> Result<(), CliError> {
    let bundle = trace.and_then(|trace| {
        let exported = export_with_recovery(output, &trace)?;
        Ok((trace, exported))
    });
    // Preserve the trace before teardown, even if cleanup later fails.
    let stopped = stop_record_session_with_context(sock, ctx, session_id);
    record_state::clear_session(session_id);

    let (trace, exported) = bundle?;
    stopped?;
    render_finish(&trace, output, &exported, format)
}

/// A `not_found` stop means the session or its recording is gone, so the
/// saved pointer can never be stopped; drop it so `record start` works again.
pub(crate) fn forget_stale_recording(err: CliError, session_id: &str) -> CliError {
    let CliError::Rpc {
        code: ErrorCode::NotFound,
        message,
        data,
        source,
    } = err
    else {
        return err;
    };
    record_state::clear_session(session_id);
    CliError::Rpc {
        code: ErrorCode::NotFound,
        message: format!(
            "{message}; cleared the stale recording state for session {session_id}, so `bsk record start` can run again"
        ),
        data,
        source,
    }
}

/// When `record start` omitted `--url` and the default example.com page
/// never loaded, rewrite the RPC error so the CLI hint points at `--url`.
pub(crate) fn annotate_default_start_page_error(err: CliError, user_url: Option<&str>) -> CliError {
    if user_url.is_some() {
        return err;
    }
    let CliError::Rpc {
        code,
        message,
        data,
        source,
    } = err
    else {
        return err;
    };
    if !is_default_start_page_failure(code, &message) {
        return CliError::Rpc {
            code,
            message,
            data,
            source,
        };
    }
    CliError::Rpc {
        code,
        message,
        data: Some(serde_json::json!({
            "reason": bsk_protocol::RpcErrorReason::RecordStartPageUnreachable.as_str()
        })),
        source,
    }
}

fn is_default_start_page_failure(code: ErrorCode, message: &str) -> bool {
    match code {
        ErrorCode::CdpFailed | ErrorCode::Timeout => true,
        ErrorCode::InvalidParams => {
            message.contains("restricted URL") || message.contains("about:blank")
        }
        _ => false,
    }
}

pub(crate) fn prepare_record_start(output: &Path) -> Result<(), CliError> {
    if record_state::read().is_ok() {
        return Err(CliError::Local(anyhow::anyhow!(
            "a recording is already in progress; run `bsk record stop` first"
        )));
    }
    if record_recovery::exists() {
        return Err(CliError::Local(anyhow::anyhow!(
            "a previous recording was not exported; run `bsk record stop --output <dir>` to recover it first"
        )));
    }
    validate_record_output(output)
}

fn render_finish(
    trace: &RecordedTrace,
    output_dir: &PathBuf,
    exported: &ExportMeta,
    format: Format,
) -> Result<(), CliError> {
    let trace_path = trace_json_path(output_dir);
    match format {
        Format::Json => {
            let payload = serde_json::json!({
                "output": output_dir,
                "trace_json": trace_path,
                "trace_version": exported.trace_version,
                "states_dir": exported.states_dir,
                "trace": trace,
                "window_closed": true,
            });
            println!(
                "{}",
                serde_json::to_string(&payload).map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            println!(
                "saved {} steps to {} and {} states to {}",
                trace.steps.len(),
                trace_path.display(),
                trace.states.len(),
                exported.states_dir.display()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _lock = record_recovery::test_env_lock();
        let tmp = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var(crate::daemon::paths::BSK_HOME_ENV, tmp.path());
        }
        f();
        record_recovery::clear();
        record_state::clear();
        unsafe {
            std::env::remove_var(crate::daemon::paths::BSK_HOME_ENV);
        }
    }

    #[test]
    fn prepare_record_start_rejects_existing_trace_json_file() {
        with_temp_home(|| {
            let dir = tempfile::tempdir().unwrap();
            let output = dir.path().join("trace.json");
            std::fs::write(&output, "{}\n").unwrap();

            let err = prepare_record_start(&output).unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("JSON file") || msg.contains("json file"),
                "{msg}"
            );
            assert!(
                msg.contains("states/") || msg.contains("--output trace"),
                "{msg}"
            );
        });
    }

    #[test]
    fn prepare_record_start_rejects_unexported_recovery() {
        with_temp_home(|| {
            crate::daemon::paths::ensure_bsk_home().unwrap();
            std::fs::write(
                crate::daemon::paths::record_recovery_path().unwrap(),
                "{}\n",
            )
            .unwrap();

            let err = prepare_record_start(Path::new("trace")).unwrap_err();
            let msg = err.to_string();
            assert!(
                msg.contains("not exported") || msg.contains("recover"),
                "{msg}"
            );
        });
    }

    #[test]
    fn stop_of_a_vanished_session_unblocks_record_start() {
        with_temp_home(|| {
            record_state::write("megi").unwrap();
            let err = CliError::from_rpc(bsk_protocol::RpcError {
                code: ErrorCode::NotFound,
                message: "session not registered or already stopped".into(),
                data: None,
            });

            let err = forget_stale_recording(err, "megi");

            assert_eq!(err.code(), Some(ErrorCode::NotFound));
            assert!(
                err.to_string()
                    .contains("cleared the stale recording state")
            );
            assert!(record_state::read().is_err());
            prepare_record_start(Path::new("trace")).unwrap();
        });
    }

    #[test]
    fn late_stale_stop_keeps_a_newer_recording_state() {
        with_temp_home(|| {
            let not_found = || {
                CliError::from_rpc(bsk_protocol::RpcError {
                    code: ErrorCode::NotFound,
                    message: "session not registered or already stopped".into(),
                    data: None,
                })
            };
            record_state::write("old").unwrap();
            forget_stale_recording(not_found(), "old");
            record_state::write("new").unwrap();

            forget_stale_recording(not_found(), "old");

            assert_eq!(record_state::read().unwrap().session_id, "new");
        });
    }

    #[test]
    fn failed_flush_keeps_the_recording_state_for_a_retry() {
        with_temp_home(|| {
            record_state::write("oabu").unwrap();
            let err = CliError::from_rpc(bsk_protocol::RpcError {
                code: ErrorCode::ProtocolError,
                message: "failed to flush recorded steps for session oabu".into(),
                data: None,
            });

            let err = forget_stale_recording(err, "oabu");

            assert_eq!(err.code(), Some(ErrorCode::ProtocolError));
            assert_eq!(record_state::read().unwrap().session_id, "oabu");
        });
    }

    #[test]
    fn default_output_is_trace_dir() {
        let args = RecordStopArgs {
            output: PathBuf::from("trace"),
        };
        assert_eq!(args.output, PathBuf::from("trace"));
    }

    #[test]
    fn start_args_default_output_is_trace_dir() {
        let args = RecordStartArgs {
            browser: None,
            tab_id: None,
            url: None,
            purpose: None,
            max_page_tokens: None,
            redact_values: false,
            output: PathBuf::from("trace"),
        };
        assert_eq!(args.output, PathBuf::from("trace"));
    }

    #[test]
    fn record_await_ipc_timeout_covers_long_wait() {
        let got = ipc_timeout(RECORD_AWAIT_TIMEOUT_MS);
        assert!(got >= std::time::Duration::from_secs(86_400));
    }

    #[test]
    fn annotate_default_start_page_error_adds_url_reason() {
        let err = CliError::from_rpc(bsk_protocol::RpcError {
            code: ErrorCode::CdpFailed,
            message: "Page.navigate rejected: net::ERR_ABORTED".into(),
            data: None,
        });
        let annotated = annotate_default_start_page_error(err, None);
        assert_eq!(
            crate::cli::render_error::reason_for_data(annotated.data()),
            Some(bsk_protocol::RpcErrorReason::RecordStartPageUnreachable.as_str())
        );
        let info =
            crate::cli::render_error::info_for_error(annotated.code().unwrap(), annotated.data());
        assert!(info.hint.unwrap().contains("--url"));
    }

    #[test]
    fn annotate_default_start_page_error_skips_when_user_passed_url() {
        let err = CliError::from_rpc(bsk_protocol::RpcError {
            code: ErrorCode::CdpFailed,
            message: "Page.navigate rejected: net::ERR_ABORTED".into(),
            data: None,
        });
        let annotated = annotate_default_start_page_error(err, Some("https://www.example.org/"));
        assert_eq!(
            crate::cli::render_error::reason_for_data(annotated.data()),
            None
        );
    }
}
