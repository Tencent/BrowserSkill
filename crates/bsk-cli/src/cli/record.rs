//! `bsk record start|stop` — capture user actions in the Agent Window.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::tools::{
    RecordAwaitParams, RecordAwaitResult, RecordStartParams, RecordStartResult, RecordStopParams,
    RecordStopResult, RecordedTrace, TRACE_VERSION_V3,
};
use bsk_protocol::{ErrorCode, Method};
use clap::{Args, Subcommand};

use crate::cli::TOOL_IPC_TIMEOUT;

pub(crate) mod export;

use crate::cli::business_rpc;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::record_recovery;
use crate::cli::record_state;
use crate::cli::session::{SessionStartOptions, StopReply, start_session, stop_session};
use export::{
    ExportMeta, export_with_recovery, states_dir_for_output, trace_json_path,
    validate_record_output,
};

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

    /// Return as soon as recording is armed instead of blocking until the
    /// user clicks 结束. Prints the session id so the *agent* can drive the
    /// recorded flow itself (`bsk observe/fill/click --session <id>`); the
    /// per-session busy gate stays free because nothing holds `record_await`.
    /// Finish with `bsk record stop --output <dir>`.
    #[arg(long)]
    pub detach: bool,
}

#[derive(Debug, Clone, Args)]
pub struct RecordStopArgs {
    /// Output directory for the trace bundle (default `./trace`).
    /// Writes `<dir>/trace.json` and `<dir>/states/*.txt`.
    #[arg(long, default_value = "trace")]
    pub output: PathBuf,
}

pub fn dispatch(cmd: RecordCmd, format: Format) -> Result<(), CliError> {
    match cmd.sub {
        RecordSub::Start(args) => dispatch_start(args, format),
        RecordSub::Stop(args) => dispatch_stop(args, format),
    }
}

fn dispatch_start(args: RecordStartArgs, format: Format) -> Result<(), CliError> {
    prepare_record_start(&args.output)?;

    let info = ensure_daemon().context("ensure daemon is running")?;
    let session = start_session(
        info.sock_path.clone(),
        SessionStartOptions {
            browser: args.browser,
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
        trace_version: Some(TRACE_VERSION_V3),
        supports_tab_switch_steps: Some(true),
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
            return Err(annotate_default_start_page_error(err, args.url.as_deref()));
        }
    };

    if let Err(err) = record_state::write(&session.session_id) {
        let _ = stop_session(info.sock_path.clone(), &session.session_id);
        return Err(CliError::Local(err));
    }

    if args.detach {
        // Detached: no `record_await`, so the session's serial busy lock stays
        // free and the agent's own observe/act calls are accepted. The session
        // and the record state outlive this process; `record stop` closes both.
        render_detached(
            &session.session_id,
            start_result.tab_id,
            &args.output,
            format,
        )?;
        return Ok(());
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
            let exported = export_with_recovery(&args.output, &result.trace)?;
            render_finish(&result.trace, &args.output, &exported, format)
        })(),
        Err(err) => Err(err),
    };

    let session_stop_result = stop_session(info.sock_path, &session.session_id);
    record_state::clear();

    run_result?;
    tolerate_concurrent_session_stop(session_stop_result)?;
    Ok(())
}

fn dispatch_stop(args: RecordStopArgs, format: Format) -> Result<(), CliError> {
    validate_record_output(&args.output)?;

    if let Ok(state) = record_state::read() {
        let info = ensure_daemon().context("ensure daemon is running")?;
        let session_id = state.session_id.clone();

        let params = RecordStopParams {
            session_id: session_id.clone(),
        };
        let stop = business_rpc::call::<RecordStopParams, RecordStopResult>(
            info.sock_path.clone(),
            "record-stop",
            Method::ToolRecordStop,
            Some(params),
            TOOL_IPC_TIMEOUT,
        );

        match stop {
            Ok(result) => {
                let run_result: Result<(), CliError> = (|| {
                    let exported = export_with_recovery(&args.output, &result.trace)?;
                    render_stop(&result, &args.output, &exported, format)
                })();

                let session_stop_result = stop_session(info.sock_path, &session_id);
                record_state::clear();

                run_result?;
                tolerate_concurrent_session_stop(session_stop_result)?;
                return Ok(());
            }
            // The recording session is gone: the process that armed it died, or
            // the daemon reaped it as idle. `--detach` makes that reachable, so
            // clear the state file rather than wedging every later `record
            // start` behind "a recording is already in progress", then fall
            // through to whatever the recovery file still holds.
            Err(err) if is_recording_session_gone(&err) => {
                record_state::clear();
                if !record_recovery::exists() {
                    return Err(CliError::Local(anyhow::anyhow!(
                        "recording session {session_id} is no longer active, so nothing could be \
                         exported. The stale record state is cleared; `bsk record start` works \
                         again."
                    )));
                }
            }
            Err(err) => return Err(err),
        }
    }

    let Some(trace) = record_recovery::load().map_err(CliError::Local)? else {
        return Err(CliError::Local(anyhow::anyhow!(
            "no recording in progress; run `bsk record start` first"
        )));
    };

    let exported = export_with_recovery(&args.output, &trace)?;
    render_finish(&trace, &args.output, &exported, format)
}

/// When `record start` omitted `--url` and the default example.com page
/// never loaded, rewrite the RPC error so the CLI hint points at `--url`.
fn annotate_default_start_page_error(err: CliError, user_url: Option<&str>) -> CliError {
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
            "reason": crate::cli::render_error::reason::RECORD_START_PAGE_UNREACHABLE
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

fn prepare_record_start(output: &Path) -> Result<(), CliError> {
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

/// Message the daemon returns when another `session.stop` is already running
/// for this session. See `StopSessionError::Stopping` in `daemon/sessions.rs`.
const SESSION_STOP_IN_PROGRESS: &str = "session stop is already in progress";

/// A losing race against a concurrent `session.stop` is not a recording failure.
///
/// `record stop` and a blocked `record start` both tear the session down when
/// the recording ends. Whoever arrives second gets
/// `StopSessionError::Stopping`, which used to bubble up through
/// `session_stop_result?` and fail the command with exit 4 — *after* the trace
/// was already written and the window was already closing. Downgrade exactly
/// that message to a warning; every other stop failure still fails the command.
fn tolerate_concurrent_session_stop(result: Result<StopReply, CliError>) -> Result<(), CliError> {
    match result {
        Ok(_) => Ok(()),
        Err(err) if is_concurrent_session_stop(&err) => {
            eprintln!(
                "warning: {SESSION_STOP_IN_PROGRESS}; the trace is already written and the \
                 window is closing"
            );
            Ok(())
        }
        Err(err) => Err(err),
    }
}

/// Whether `tool.record_stop` failed because the session itself is gone.
fn is_recording_session_gone(err: &CliError) -> bool {
    matches!(err.code(), Some(ErrorCode::NotFound))
}

fn is_concurrent_session_stop(err: &CliError) -> bool {
    match err {
        CliError::Rpc { code, message, .. } | CliError::Rendered { code, message } => {
            *code == ErrorCode::Timeout && message.contains(SESSION_STOP_IN_PROGRESS)
        }
        _ => false,
    }
}

/// The `--json` shape of a detached `record start`.
fn detached_payload(session_id: &str, tab_id: i64, output: &Path) -> serde_json::Value {
    serde_json::json!({
        "detached": true,
        "session_id": session_id,
        "tab_id": tab_id,
        "output": output,
        "trace_json": trace_json_path(output),
    })
}

/// Print what a detached `record start` hands back to its caller.
///
/// The session id is the whole point: the agent passes it to `--session` on
/// every following command, and to `record stop` implicitly via the record
/// state file.
fn render_detached(
    session_id: &str,
    tab_id: i64,
    output: &Path,
    format: Format,
) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let payload = detached_payload(session_id, tab_id, output);
            println!(
                "{}",
                serde_json::to_string(&payload).map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            println!("recording detached on tab={tab_id}");
            println!("session: {session_id}");
            println!(
                "run the task with `--session {session_id}`, then `bsk record stop --output {}`",
                output.display()
            );
        }
    }
    Ok(())
}

fn record_await_ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms))
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(u64::from(timeout_ms / 1_000) + 15))
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
            let payload = match trace {
                RecordedTrace::V3(t) => serde_json::json!({
                    "output": output_dir,
                    "trace_json": trace_path,
                    "trace_version": exported.trace_version,
                    "states_dir": exported.states_dir,
                    "trace": t,
                    "window_closed": true,
                }),
                RecordedTrace::V2(t) => serde_json::json!({
                    "output": output_dir,
                    "trace_json": trace_path,
                    "trace_version": exported.trace_version,
                    "states_dir": null,
                    "trace": t,
                    "window_closed": true,
                }),
            };
            println!(
                "{}",
                serde_json::to_string(&payload).map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => match trace {
            RecordedTrace::V3(t) => {
                let states_dir = exported
                    .states_dir
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| states_dir_for_output(output_dir).display().to_string());
                println!(
                    "saved {} steps to {} and {} states to {}",
                    t.steps.len(),
                    trace_path.display(),
                    t.states.len(),
                    states_dir
                );
            }
            RecordedTrace::V2(t) => {
                if exported.v2_fallback {
                    eprintln!(
                        "note: extension returned trace v2 (no page observations); update the BrowserSkill extension for v3 bundles"
                    );
                }
                println!(
                    "saved {} steps to {} (trace v2)",
                    t.steps.len(),
                    trace_path.display()
                );
            }
        },
    }
    Ok(())
}

fn render_stop(
    result: &RecordStopResult,
    output: &PathBuf,
    exported: &ExportMeta,
    format: Format,
) -> Result<(), CliError> {
    render_finish(&result.trace, output, exported, format)
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
            detach: false,
        };
        assert_eq!(args.output, PathBuf::from("trace"));
    }

    #[test]
    fn record_await_ipc_timeout_covers_long_wait() {
        let got = record_await_ipc_timeout(RECORD_AWAIT_TIMEOUT_MS);
        assert!(got >= Duration::from_secs(86_400));
    }

    #[test]
    fn concurrent_session_stop_is_downgraded_to_a_warning() {
        let err = CliError::from_rpc(bsk_protocol::RpcError {
            code: ErrorCode::Timeout,
            message: SESSION_STOP_IN_PROGRESS.into(),
            data: None,
        });
        assert!(is_concurrent_session_stop(&err));
        tolerate_concurrent_session_stop(Err(err))
            .expect("a losing stop race must not fail the export");
    }

    #[test]
    fn other_session_stop_failures_still_fail() {
        let err = CliError::from_rpc(bsk_protocol::RpcError {
            code: ErrorCode::Timeout,
            message: "session stop timed out waiting for extension".into(),
            data: None,
        });
        assert!(!is_concurrent_session_stop(&err));
        assert!(tolerate_concurrent_session_stop(Err(err)).is_err());

        let other_code = CliError::from_rpc(bsk_protocol::RpcError {
            code: ErrorCode::NotFound,
            message: SESSION_STOP_IN_PROGRESS.into(),
            data: None,
        });
        assert!(!is_concurrent_session_stop(&other_code));
    }

    #[test]
    fn a_vanished_recording_session_is_recognised() {
        // `--detach` outlives the process that armed it, so `record stop` can
        // meet a session the daemon already reaped. That must clear the state
        // file, not wedge every later `record start`.
        let gone = CliError::from_rpc(bsk_protocol::RpcError {
            code: ErrorCode::NotFound,
            message: "session is not registered".into(),
            data: None,
        });
        assert!(is_recording_session_gone(&gone));

        let other = CliError::from_rpc(bsk_protocol::RpcError {
            code: ErrorCode::CdpFailed,
            message: "extension rejected tool.record_stop".into(),
            data: None,
        });
        assert!(!is_recording_session_gone(&other));
    }

    #[test]
    fn detached_json_reports_session_and_tab() {
        // The agent reads `session_id` out of this payload and passes it to
        // every following command, so the field must stay in `--json`.
        let payload = detached_payload("abcd", 7, Path::new("rec"));
        assert_eq!(payload["detached"], true);
        assert_eq!(payload["session_id"], "abcd");
        assert_eq!(payload["tab_id"], 7);
        assert_eq!(
            payload["trace_json"],
            serde_json::json!(trace_json_path(Path::new("rec")))
        );
    }

    #[test]
    fn detach_defaults_to_blocking() {
        let args = RecordStartArgs {
            browser: None,
            tab_id: None,
            url: None,
            purpose: None,
            max_page_tokens: None,
            redact_values: false,
            output: PathBuf::from("trace"),
            detach: false,
        };
        assert!(!args.detach, "the blocking path stays the default");
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
            Some(crate::cli::render_error::reason::RECORD_START_PAGE_UNREACHABLE)
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
