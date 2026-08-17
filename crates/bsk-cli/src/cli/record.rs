//! `bsk record start|stop` — capture user actions in the Agent Window.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::tools::{
    FrameCaptureStatus, RecordAwaitParams, RecordAwaitResult, RecordStartParams, RecordStartResult,
    RecordStopParams, RecordStopResult, TRACE_VERSION, Trace, TraceState,
};
use bsk_protocol::{ErrorCode, Method};
use clap::{Args, Subcommand};

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::business_rpc;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::record_state;
use crate::cli::session::{SessionStartOptions, start_session, stop_session};
use crate::daemon::ipc::STOP_IN_PROGRESS_REASON;

/// Max wait for the user to click 结束 in the browser (24 hours).
const RECORD_AWAIT_TIMEOUT_MS: u32 = 86_400_000;

/// Tear down the recording session, tolerating the teardown the other half of
/// the pair already started. `record start` blocks in `record_await` and stops
/// the session once the trace arrives; the documented `record stop` fallback
/// stops it too. Whichever loses that race must not report a failure — the
/// trace is already written by then.
fn stop_recording_session(sock: PathBuf, session_id: &str) -> Result<(), CliError> {
    match stop_session(sock, session_id) {
        Ok(_) => Ok(()),
        Err(err) if session_teardown_raced(&err) => Ok(()),
        Err(err) => Err(err),
    }
}

fn session_teardown_raced(err: &CliError) -> bool {
    if err.code() == Some(ErrorCode::NotFound) {
        return true;
    }
    err.data()
        .and_then(|data| data.get("reason"))
        .and_then(serde_json::Value::as_str)
        == Some(STOP_IN_PROGRESS_REASON)
}

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
    /// to `https://example.com/`.
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
    /// Writes `<dir>/trace.json` and `<dir>/pages/*.vom.txt`.
    #[arg(long, default_value = "trace")]
    pub output: PathBuf,
}

#[derive(Debug, Clone, Args)]
pub struct RecordStopArgs {
    /// Output directory for the trace bundle (default `./trace`).
    /// Writes `<dir>/trace.json` and `<dir>/pages/*.vom.txt`.
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
    if record_state::read().is_ok() {
        return Err(CliError::Local(anyhow::anyhow!(
            "a recording is already in progress; run `bsk record stop` first"
        )));
    }

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
        url: args.url,
        purpose: args.purpose.clone(),
        max_page_tokens: args.max_page_tokens,
        redact_values: Some(args.redact_values),
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
            let pages_dir = write_trace_bundle(&args.output, &result.trace)?;
            render_finish(&result.trace, &args.output, &pages_dir, format)
        })(),
        Err(err) => Err(err),
    };

    let session_stop_result = stop_recording_session(info.sock_path, &session.session_id);
    record_state::clear();

    run_result?;
    session_stop_result?;
    Ok(())
}

fn dispatch_stop(args: RecordStopArgs, format: Format) -> Result<(), CliError> {
    let state = record_state::read().map_err(CliError::Local)?;
    let info = ensure_daemon().context("ensure daemon is running")?;
    let session_id = state.session_id.clone();

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

    let run_result: Result<(), CliError> = (|| {
        let pages_dir = write_trace_bundle(&args.output, &result.trace)?;
        render_stop(&result, &args.output, &pages_dir, format)
    })();

    let session_stop_result = stop_recording_session(info.sock_path, &session_id);
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

fn pages_dir_for_output(output_dir: &Path) -> PathBuf {
    output_dir.join("pages")
}

fn trace_json_path(output_dir: &Path) -> PathBuf {
    output_dir.join("trace.json")
}

fn is_canonical_state_id(id: &str) -> bool {
    let Some(number) = id.strip_prefix('s') else {
        return false;
    };
    let mut digits = number.bytes();
    matches!(digits.next(), Some(b'1'..=b'9')) && digits.all(|byte| byte.is_ascii_digit())
}

fn validate_bundle_directory(path: &Path, description: &str) -> Result<(), CliError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CliError::Local(anyhow::anyhow!(
            "{description} {} must not be a symlink",
            path.display()
        ))),
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(CliError::Local(anyhow::anyhow!(
            "{description} {} is not a directory",
            path.display()
        ))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(CliError::Local(
            anyhow::Error::new(err).context(format!("inspect {description} {}", path.display())),
        )),
    }
}

fn validate_replaceable_file(path: &Path, description: &str) -> Result<(), CliError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => Err(CliError::Local(anyhow::anyhow!(
            "{description} {} is not a regular file",
            path.display()
        ))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(CliError::Local(
            anyhow::Error::new(err).context(format!("inspect {description} {}", path.display())),
        )),
    }
}

fn commit_staged_file(staged: &Path, target: &Path, backup: &Path) -> io::Result<Option<PathBuf>> {
    let old_file = match fs::symlink_metadata(target) {
        Ok(_) => {
            fs::rename(target, backup)?;
            Some(backup.to_path_buf())
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => None,
        Err(err) => return Err(err),
    };

    if let Err(err) = fs::rename(staged, target) {
        if let Some(old_file) = old_file.as_deref() {
            if let Err(restore_err) = fs::rename(old_file, target) {
                return Err(io::Error::new(
                    restore_err.kind(),
                    format!(
                        "{err}; additionally failed to restore {}: {restore_err}",
                        target.display()
                    ),
                ));
            }
        }
        return Err(err);
    }

    Ok(old_file)
}

fn rollback_installed_files(installed: &[(PathBuf, Option<PathBuf>)]) -> io::Result<()> {
    let mut rollback_error = None;
    for (target, backup) in installed.iter().rev() {
        match fs::remove_file(target) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => {
                rollback_error.get_or_insert(err);
                continue;
            }
        }
        if let Some(backup) = backup {
            if let Err(err) = fs::rename(backup, target) {
                rollback_error.get_or_insert(err);
            }
        }
    }
    match rollback_error {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// Drop page files left by an earlier, longer recording without deleting the
/// directory itself: `record start` and the `record stop` fallback export the
/// same recording concurrently, and a `remove_dir_all` here would fail the
/// writer whose files the other one just erased.
fn prune_stale_pages(pages_dir: &Path, keep: &HashSet<String>) -> Result<(), CliError> {
    let entries = match fs::read_dir(pages_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => {
            return Err(CliError::Local(
                anyhow::Error::new(err).context(format!("read pages dir {}", pages_dir.display())),
            ));
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.ends_with(".vom.txt") || keep.contains(name) {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(CliError::Local(
                    anyhow::Error::new(err)
                        .context(format!("remove stale page {}", entry.path().display())),
                ));
            }
        }
    }
    Ok(())
}

fn write_trace_bundle(output_dir: &Path, trace: &Trace) -> Result<PathBuf, CliError> {
    let pages_dir = pages_dir_for_output(output_dir);
    let trace_path = trace_json_path(output_dir);

    if trace.version != TRACE_VERSION {
        return Err(CliError::Local(anyhow::anyhow!(
            "trace version {} is not supported (expected {})",
            trace.version,
            TRACE_VERSION
        )));
    }

    let mut state_ids = HashSet::with_capacity(trace.states.len());
    for state in &trace.states {
        if !is_canonical_state_id(&state.id) {
            return Err(CliError::Local(anyhow::anyhow!(
                "state id {:?} is not canonical (expected s1, s2, ...)",
                state.id
            )));
        }
        if !state_ids.insert(state.id.as_str()) {
            return Err(CliError::Local(anyhow::anyhow!(
                "duplicate state id {:?}",
                state.id
            )));
        }
    }

    let mut disk_states: Vec<TraceState> = Vec::with_capacity(trace.states.len());
    let mut page_writes = Vec::new();
    let mut keep = HashSet::new();
    for state in &trace.states {
        let mut disk = state.clone();
        if let Some(body) = state.body.as_deref() {
            let filename = format!("{}.vom.txt", state.id);
            let page_path = pages_dir.join(&filename);
            if page_path.parent() != Some(pages_dir.as_path()) {
                return Err(CliError::Local(anyhow::anyhow!(
                    "page path {} escapes pages directory {}",
                    page_path.display(),
                    pages_dir.display()
                )));
            }
            keep.insert(filename.clone());
            page_writes.push((filename.clone(), body));
            disk.body = None;
            disk.page = Some(filename);
        }
        disk_states.push(disk);
    }

    let mut disk_trace = trace.clone();
    disk_trace.states = disk_states;
    let json = serde_json::to_string_pretty(&disk_trace)
        .context("serialize trace JSON")
        .map_err(CliError::Local)?;

    validate_bundle_directory(output_dir, "output bundle directory")?;
    fs::create_dir_all(output_dir)
        .with_context(|| format!("create output dir {}", output_dir.display()))
        .map_err(CliError::Local)?;

    validate_bundle_directory(&pages_dir, "pages directory")?;

    // `record start` and `record stop` can export the same recording at once.
    // Serialize writers without replacing the shared directory underneath one
    // another; the lock is released when this file handle is dropped.
    let lock_path = output_dir.join(".bsk-record-export.lock");
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .with_context(|| format!("open export lock {}", lock_path.display()))
        .map_err(CliError::Local)?;
    fs2::FileExt::lock_exclusive(&lock_file)
        .with_context(|| format!("lock export bundle {}", output_dir.display()))
        .map_err(CliError::Local)?;

    fs::create_dir_all(&pages_dir)
        .with_context(|| format!("create pages dir {}", pages_dir.display()))
        .map_err(CliError::Local)?;

    for (filename, _) in &page_writes {
        validate_replaceable_file(&pages_dir.join(filename), "page observation")?;
    }
    validate_replaceable_file(&trace_path, "trace JSON")?;

    let transaction_id = uuid::Uuid::new_v4();
    let staging_dir = output_dir.join(format!(".bsk-record-stage-{transaction_id}"));
    let staging_pages = staging_dir.join("pages");
    fs::create_dir_all(&staging_pages)
        .with_context(|| format!("create staging dir {}", staging_pages.display()))
        .map_err(CliError::Local)?;

    let stage_result: Result<(), CliError> = (|| {
        for (filename, body) in &page_writes {
            let staged_path = staging_pages.join(filename);
            fs::write(&staged_path, body)
                .with_context(|| format!("write staged page observation {}", staged_path.display()))
                .map_err(CliError::Local)?;
        }
        let staged_trace = staging_dir.join("trace.json");
        fs::write(&staged_trace, format!("{json}\n"))
            .with_context(|| format!("write staged trace to {}", staged_trace.display()))
            .map_err(CliError::Local)?;
        Ok(())
    })();
    if let Err(err) = stage_result {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(err);
    }

    let mut replacements: Vec<(PathBuf, PathBuf, PathBuf)> =
        Vec::with_capacity(page_writes.len() + 1);
    for (filename, _) in &page_writes {
        replacements.push((
            staging_pages.join(filename),
            pages_dir.join(filename),
            pages_dir.join(format!(".{filename}.{transaction_id}.bak")),
        ));
    }
    replacements.push((
        staging_dir.join("trace.json"),
        trace_path.clone(),
        output_dir.join(format!(".trace.json.{transaction_id}.bak")),
    ));

    let mut installed = Vec::with_capacity(replacements.len());
    for (staged, target, backup) in replacements {
        match commit_staged_file(&staged, &target, &backup) {
            Ok(old_file) => installed.push((target, old_file)),
            Err(err) => {
                let rollback_result = rollback_installed_files(&installed);
                let _ = fs::remove_dir_all(&staging_dir);
                let message = match rollback_result {
                    Ok(()) => format!("commit replacement {}: {err}", target.display()),
                    Err(rollback_err) => format!(
                        "commit replacement {}: {err}; rollback also failed: {rollback_err}",
                        target.display()
                    ),
                };
                return Err(CliError::Local(anyhow::anyhow!(message)));
            }
        }
    }

    for (_, backup) in &installed {
        if let Some(backup) = backup {
            let _ = fs::remove_file(backup);
        }
    }
    let _ = fs::remove_dir_all(&staging_dir);
    prune_stale_pages(&pages_dir, &keep)?;

    Ok(pages_dir)
}

fn render_finish(
    trace: &Trace,
    output_dir: &PathBuf,
    pages_dir: &PathBuf,
    format: Format,
) -> Result<(), CliError> {
    let trace_path = trace_json_path(output_dir);
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({
                    "output": output_dir,
                    "trace_json": trace_path,
                    "pages_dir": pages_dir,
                    "trace": trace,
                    "window_closed": true,
                }))
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            println!(
                "saved {} steps and {} states to {} (+ {})",
                trace.steps.len(),
                trace.states.len(),
                trace_path.display(),
                pages_dir.display()
            );
            if let Some(frame_capture) = &trace.frame_capture {
                if matches!(frame_capture.status, FrameCaptureStatus::Partial) {
                    eprintln!(
                        "warning: trace is partial — some embedded frames were not recorded (see frame_capture.failures in trace.json)"
                    );
                }
            }
        }
    }
    Ok(())
}

fn render_stop(
    result: &RecordStopResult,
    output: &PathBuf,
    pages_dir: &PathBuf,
    format: Format,
) -> Result<(), CliError> {
    render_finish(&result.trace, output, pages_dir, format)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::tools::{
        NavigationCause, RecorderInfo, Step, StepCommon, StepResult, StopReason, TraceEntry,
        VOM_FORMAT_VERSION,
    };

    fn sample_trace(state_id: &str, body: &str) -> Trace {
        Trace {
            version: TRACE_VERSION,
            recorded_at: "2026-08-10T02:12:55.360Z".into(),
            stopped_by: StopReason::UserFinish,
            entry: TraceEntry {
                start_url: "https://example.com/".into(),
            },
            recorder: RecorderInfo {
                bsk: "0.1.10".into(),
                vom: VOM_FORMAT_VERSION,
            },
            frame_capture: None,
            states: vec![TraceState {
                id: state_id.into(),
                url: "https://example.com/".into(),
                title: Some("Example".into()),
                body: Some(body.into()),
                page: None,
                truncated: false,
            }],
            steps: vec![Step::Navigate {
                common: StepCommon {
                    id: 1,
                    state: state_id.into(),
                    result: StepResult {
                        state: state_id.into(),
                    },
                },
                to: "https://example.com/".into(),
                cause: NavigationCause::UserTyped,
            }],
            purpose: None,
            started_at: None,
        }
    }

    #[test]
    fn concurrent_teardown_is_not_a_record_failure() {
        let stopping = CliError::from_rpc(bsk_protocol::RpcError {
            code: ErrorCode::Timeout,
            message: "session stop is already in progress".into(),
            data: Some(serde_json::json!({ "reason": STOP_IN_PROGRESS_REASON })),
        });
        assert!(session_teardown_raced(&stopping));

        let gone = CliError::from_rpc(bsk_protocol::RpcError {
            code: ErrorCode::NotFound,
            message: "session is not registered".into(),
            data: None,
        });
        assert!(session_teardown_raced(&gone));
    }

    #[test]
    fn unrelated_stop_timeout_still_fails() {
        let stalled = CliError::from_rpc(bsk_protocol::RpcError {
            code: ErrorCode::Timeout,
            message: "tool.session_stop timed out".into(),
            data: None,
        });
        assert!(!session_teardown_raced(&stalled));
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
    fn write_trace_bundle_writes_dir_layout() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        let trace = sample_trace("s1", "@vom 1\nL1 page");
        let pages_dir = write_trace_bundle(&output, &trace).unwrap();
        let trace_path = output.join("trace.json");
        assert!(trace_path.exists());
        assert_eq!(pages_dir, output.join("pages"));
        assert!(pages_dir.join("s1.vom.txt").exists());
        let disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&trace_path).unwrap()).unwrap();
        assert_eq!(disk["states"][0]["page"], "s1.vom.txt");
        assert!(disk["states"][0].get("body").is_none());
        assert_eq!(
            fs::read_to_string(pages_dir.join("s1.vom.txt")).unwrap(),
            "@vom 1\nL1 page"
        );

        // Re-exporting drops pages from the previous run but keeps the
        // directory in place for the concurrent writer.
        fs::write(pages_dir.join("s9.vom.txt"), "stale").unwrap();
        fs::write(pages_dir.join("notes.md"), "keep me").unwrap();
        write_trace_bundle(&output, &trace).unwrap();
        assert!(!pages_dir.join("s9.vom.txt").exists());
        assert!(pages_dir.join("s1.vom.txt").exists());
        assert!(pages_dir.join("notes.md").exists());
    }

    #[test]
    fn write_trace_bundle_rejects_traversal_state_id() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        let trace = sample_trace("../escaped", "@vom 1\nL1 page");

        let err = write_trace_bundle(&output, &trace).unwrap_err();

        assert!(err.to_string().contains("state id"));
        assert!(!output.join("escaped.vom.txt").exists());
        assert!(!output.join("trace.json").exists());
    }

    #[test]
    fn write_trace_bundle_rejects_duplicate_state_id() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        let mut trace = sample_trace("s1", "@vom 1\nL1 first");
        trace.states.push(TraceState {
            body: Some("@vom 1\nL1 duplicate".into()),
            ..trace.states[0].clone()
        });

        let err = write_trace_bundle(&output, &trace).unwrap_err();

        assert!(err.to_string().contains("duplicate state id"));
        assert!(!output.exists());
    }

    #[test]
    fn unsupported_version_preserves_existing_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        write_trace_bundle(&output, &sample_trace("s1", "original")).unwrap();
        let original_json = fs::read(output.join("trace.json")).unwrap();

        let mut replacement = sample_trace("s2", "replacement");
        replacement.version += 1;
        let err = write_trace_bundle(&output, &replacement).unwrap_err();

        assert!(err.to_string().contains("not supported"));
        assert_eq!(fs::read(output.join("trace.json")).unwrap(), original_json);
        assert_eq!(
            fs::read_to_string(output.join("pages/s1.vom.txt")).unwrap(),
            "original"
        );
        assert!(!output.join("pages/s2.vom.txt").exists());
    }

    #[test]
    fn page_replacement_failure_preserves_existing_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        write_trace_bundle(&output, &sample_trace("s1", "original")).unwrap();
        let original_json = fs::read(output.join("trace.json")).unwrap();
        fs::write(output.join("pages/notes.md"), "keep me").unwrap();
        fs::create_dir(output.join("pages/s2.vom.txt")).unwrap();

        let err = write_trace_bundle(&output, &sample_trace("s2", "replacement")).unwrap_err();

        assert!(err.to_string().contains("page"));
        assert_eq!(fs::read(output.join("trace.json")).unwrap(), original_json);
        assert_eq!(
            fs::read_to_string(output.join("pages/s1.vom.txt")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(output.join("pages/notes.md")).unwrap(),
            "keep me"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_trace_bundle_rejects_symlinked_pages_directory() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        let external_pages = dir.path().join("external-pages");
        fs::create_dir_all(&output).unwrap();
        fs::create_dir_all(&external_pages).unwrap();
        fs::write(external_pages.join("s9.vom.txt"), "external").unwrap();
        symlink(&external_pages, output.join("pages")).unwrap();

        let err = write_trace_bundle(&output, &sample_trace("s1", "replacement")).unwrap_err();

        assert!(err.to_string().contains("symlink"));
        assert_eq!(
            fs::read_to_string(external_pages.join("s9.vom.txt")).unwrap(),
            "external"
        );
        assert!(!external_pages.join("s1.vom.txt").exists());
        assert!(!output.join("trace.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn write_trace_bundle_rejects_symlinked_output_directory() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let external_output = dir.path().join("external-output");
        let output = dir.path().join("flow");
        fs::create_dir_all(&external_output).unwrap();
        fs::write(external_output.join("notes.md"), "external").unwrap();
        symlink(&external_output, &output).unwrap();

        let err = write_trace_bundle(&output, &sample_trace("s1", "replacement")).unwrap_err();

        assert!(err.to_string().contains("symlink"));
        assert_eq!(
            fs::read_to_string(external_output.join("notes.md")).unwrap(),
            "external"
        );
        assert!(!external_output.join("trace.json").exists());
        assert!(!external_output.join("pages").exists());
    }

    #[test]
    fn record_await_ipc_timeout_covers_long_wait() {
        let got = record_await_ipc_timeout(RECORD_AWAIT_TIMEOUT_MS);
        assert!(got >= Duration::from_secs(86_400));
    }
}
