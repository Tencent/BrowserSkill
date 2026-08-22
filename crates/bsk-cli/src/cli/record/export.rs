use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use anyhow::Context;
use bsk_protocol::tools::{RecordedTrace, TRACE_VERSION_V2, TRACE_VERSION_V3, TraceV2, TraceV3};
use serde::Serialize;

use crate::cli::error::CliError;

#[derive(Debug)]
pub(super) struct ExportMeta {
    pub(super) states_dir: Option<PathBuf>,
    pub(super) trace_version: u32,
    /// True when the CLI requested v3 but the extension returned legacy v2.
    pub(super) v2_fallback: bool,
}

pub(super) fn export_recorded_trace(
    output_dir: &Path,
    trace: &RecordedTrace,
) -> Result<ExportMeta, CliError> {
    match trace {
        RecordedTrace::V3(trace) => {
            let states_dir = write_trace_bundle(output_dir, trace)?;
            Ok(ExportMeta {
                states_dir: Some(states_dir),
                trace_version: TRACE_VERSION_V3,
                v2_fallback: false,
            })
        }
        RecordedTrace::V2(trace) => {
            write_trace_v2(output_dir, trace)?;
            Ok(ExportMeta {
                states_dir: None,
                trace_version: TRACE_VERSION_V2,
                v2_fallback: true,
            })
        }
    }
}

/// Save the completed Trace first, then write the bundle. Recovery is
/// removed only after the export commits so a bad `--output` cannot drop
/// a recording the extension already returned.
pub(super) fn export_with_recovery(
    output_dir: &Path,
    trace: &RecordedTrace,
) -> Result<ExportMeta, CliError> {
    let save_result = crate::cli::record_recovery::save(trace);
    match export_recorded_trace(output_dir, trace) {
        Ok(meta) => {
            crate::cli::record_recovery::clear();
            Ok(meta)
        }
        Err(export_err) => {
            let export_err = annotate_recovery_hint(export_err, save_result.is_ok());
            if let Err(save_err) = save_result {
                return Err(match export_err {
                    CliError::Local(inner) => CliError::Local(
                        inner.context(format!("also failed to save recovery data: {save_err}")),
                    ),
                    other => other,
                });
            }
            Err(export_err)
        }
    }
}

fn annotate_recovery_hint(err: CliError, recovery_saved: bool) -> CliError {
    if !recovery_saved {
        return err;
    }
    match err {
        CliError::Local(inner) => CliError::Local(inner.context(
            "export failed; the recorded trace was saved and can be recovered with `bsk record stop --output <dir>`",
        )),
        other => other,
    }
}

fn looks_like_json_output(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
}

fn legacy_json_output_error(path: &Path) -> CliError {
    CliError::Local(anyhow::anyhow!(
        "--output {} is a JSON file path; Trace v3 writes a bundle directory \
         (`<dir>/trace.json` and `<dir>/states/`), not a single file. \
         Use `--output trace` or another directory.",
        path.display()
    ))
}

/// Reject legacy `--output trace.json` (and any existing non-directory)
/// before a recording starts, so the user is not blocked only after Finish.
pub(super) fn validate_record_output(path: &Path) -> Result<(), CliError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(CliError::Local(anyhow::anyhow!(
            "--output {} must not be a symlink",
            path.display()
        ))),
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) if looks_like_json_output(path) => Err(legacy_json_output_error(path)),
        Ok(_) => Err(CliError::Local(anyhow::anyhow!(
            "--output {} is not a directory; Trace v3 writes a bundle directory \
             (`<dir>/trace.json` and `<dir>/states/`). Use `--output trace`.",
            path.display()
        ))),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            if looks_like_json_output(path) {
                Err(legacy_json_output_error(path))
            } else {
                Ok(())
            }
        }
        Err(err) => Err(CliError::Local(
            anyhow::Error::new(err).context(format!("inspect --output {}", path.display())),
        )),
    }
}

fn acquire_export_lock(output_dir: &Path) -> Result<std::fs::File, CliError> {
    validate_bundle_directory(output_dir, "output bundle directory")?;
    fs::create_dir_all(output_dir)
        .with_context(|| format!("create output dir {}", output_dir.display()))
        .map_err(CliError::Local)?;
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
    Ok(lock_file)
}

pub(super) fn write_trace_v2(output_dir: &Path, trace: &TraceV2) -> Result<(), CliError> {
    let trace_path = trace_json_path(output_dir);
    let states_dir = states_dir_for_output(output_dir);
    let json = serde_json::to_string_pretty(trace)
        .context("serialize trace JSON")
        .map_err(CliError::Local)?;

    let _lock = acquire_export_lock(output_dir)?;
    validate_replaceable_file(&trace_path, "trace JSON")?;

    let transaction_id = uuid::Uuid::new_v4();
    let staging_dir = output_dir.join(format!(".bsk-record-stage-{transaction_id}"));
    fs::create_dir_all(&staging_dir)
        .with_context(|| format!("create staging dir {}", staging_dir.display()))
        .map_err(CliError::Local)?;

    let staged_trace = staging_dir.join("trace.json");
    let stage_result: Result<(), CliError> = (|| {
        fs::write(&staged_trace, format!("{json}\n"))
            .with_context(|| format!("write staged trace to {}", staged_trace.display()))
            .map_err(CliError::Local)?;
        Ok(())
    })();
    if let Err(err) = stage_result {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(err);
    }

    commit_export_transaction(
        &staging_dir,
        &states_dir,
        &HashSet::new(),
        transaction_id,
        vec![(
            staged_trace,
            trace_path,
            output_dir.join(format!(".trace.json.{transaction_id}.bak")),
        )],
    )?;

    Ok(())
}

pub(super) fn states_dir_for_output(output_dir: &Path) -> PathBuf {
    output_dir.join("states")
}

pub(super) fn trace_json_path(output_dir: &Path) -> PathBuf {
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
        Ok(_) if looks_like_json_output(path) => Err(legacy_json_output_error(path)),
        Ok(_) => Err(CliError::Local(anyhow::anyhow!(
            "{description} {} is not a directory; Trace v3 writes `<dir>/trace.json` and `<dir>/states/`. Use `--output trace`.",
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

fn is_generated_state_name(name: &str) -> bool {
    name.strip_suffix(".txt").is_some_and(is_canonical_state_id)
}

fn restore_staged_stale_states(staged: &[(PathBuf, PathBuf)]) -> io::Result<()> {
    let mut restore_error = None;
    for (original, backup) in staged.iter().rev() {
        if let Err(err) = fs::rename(backup, original) {
            restore_error.get_or_insert(err);
        }
    }
    match restore_error {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// Move stale generated states aside so replacement and cleanup form one
/// rollback boundary. User-owned files, including arbitrary non-`sN.txt`, stay.
fn stage_stale_states(
    states_dir: &Path,
    keep: &HashSet<String>,
    transaction_id: uuid::Uuid,
) -> Result<Vec<(PathBuf, PathBuf)>, CliError> {
    let entries = match fs::read_dir(states_dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(CliError::Local(
                anyhow::Error::new(err)
                    .context(format!("read states dir {}", states_dir.display())),
            ));
        }
    };

    let mut staged = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                let restore_result = restore_staged_stale_states(&staged);
                let message = match restore_result {
                    Ok(()) => format!("read stale state entry: {err}"),
                    Err(restore_err) => {
                        format!("read stale state entry: {err}; restore also failed: {restore_err}")
                    }
                };
                return Err(CliError::Local(anyhow::anyhow!(message)));
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_generated_state_name(name) || keep.contains(name) {
            continue;
        }

        let original = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(err) => {
                let restore_result = restore_staged_stale_states(&staged);
                let message = match restore_result {
                    Ok(()) => format!("inspect stale state {}: {err}", original.display()),
                    Err(restore_err) => format!(
                        "inspect stale state {}: {err}; restore also failed: {restore_err}",
                        original.display()
                    ),
                };
                return Err(CliError::Local(anyhow::anyhow!(message)));
            }
        };
        if file_type.is_dir() {
            let restore_result = restore_staged_stale_states(&staged);
            let message = match restore_result {
                Ok(()) => format!("stale state {} is a directory", original.display()),
                Err(restore_err) => format!(
                    "stale state {} is a directory; restore also failed: {restore_err}",
                    original.display()
                ),
            };
            return Err(CliError::Local(anyhow::anyhow!(message)));
        }

        let backup = states_dir.join(format!(".{name}.{transaction_id}.stale"));
        if let Err(err) = fs::rename(&original, &backup) {
            let restore_result = restore_staged_stale_states(&staged);
            let message = match restore_result {
                Ok(()) => format!("stage stale state {}: {err}", original.display()),
                Err(restore_err) => format!(
                    "stage stale state {}: {err}; restore also failed: {restore_err}",
                    original.display()
                ),
            };
            return Err(CliError::Local(anyhow::anyhow!(message)));
        }
        staged.push((original, backup));
    }
    Ok(staged)
}

fn commit_export_transaction(
    staging_dir: &Path,
    states_dir: &Path,
    keep_states: &HashSet<String>,
    transaction_id: uuid::Uuid,
    replacements: Vec<(PathBuf, PathBuf, PathBuf)>,
) -> Result<(), CliError> {
    let mut installed = Vec::with_capacity(replacements.len());
    for (staged, target, backup) in replacements {
        match commit_staged_file(&staged, &target, &backup) {
            Ok(old_file) => installed.push((target, old_file)),
            Err(err) => {
                let rollback_result = rollback_installed_files(&installed);
                let _ = fs::remove_dir_all(staging_dir);
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

    let stale_states = match stage_stale_states(states_dir, keep_states, transaction_id) {
        Ok(stale) => stale,
        Err(err) => {
            let rollback_result = rollback_installed_files(&installed);
            let _ = fs::remove_dir_all(staging_dir);
            let message = match rollback_result {
                Ok(()) => err.to_string(),
                Err(rollback_err) => {
                    format!("{err}; replacement rollback also failed: {rollback_err}")
                }
            };
            return Err(CliError::Local(anyhow::anyhow!(message)));
        }
    };

    for (_, backup) in &installed {
        if let Some(backup) = backup {
            let _ = fs::remove_file(backup);
        }
    }
    for (_, backup) in stale_states {
        let _ = fs::remove_file(backup);
    }
    let _ = fs::remove_dir_all(staging_dir);
    Ok(())
}

#[derive(Serialize)]
struct BundleState<'a> {
    id: &'a str,
    url: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<&'a str>,
    page: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    truncated: bool,
}

#[derive(Serialize)]
struct BundleTrace<'a> {
    version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    purpose: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<&'a str>,
    recorded_at: &'a str,
    stopped_by: &'a bsk_protocol::tools::StopReason,
    entry: &'a bsk_protocol::tools::TraceEntry,
    recorder: &'a bsk_protocol::tools::RecorderInfo,
    states: Vec<BundleState<'a>>,
    steps: &'a [bsk_protocol::tools::StepV3],
}

pub(super) fn write_trace_bundle(output_dir: &Path, trace: &TraceV3) -> Result<PathBuf, CliError> {
    let states_dir = states_dir_for_output(output_dir);
    let trace_path = trace_json_path(output_dir);

    if trace.version != TRACE_VERSION_V3 {
        return Err(CliError::Local(anyhow::anyhow!(
            "trace version {} is not supported (expected {})",
            trace.version,
            TRACE_VERSION_V3
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

    let mut disk_states = Vec::with_capacity(trace.states.len());
    let mut state_writes = Vec::new();
    let mut keep = HashSet::new();
    for state in &trace.states {
        let filename = format!("{}.txt", state.id);
        let state_path = states_dir.join(&filename);
        if state_path.parent() != Some(states_dir.as_path()) {
            return Err(CliError::Local(anyhow::anyhow!(
                "state path {} escapes states directory {}",
                state_path.display(),
                states_dir.display()
            )));
        }
        keep.insert(filename.clone());
        state_writes.push((filename.clone(), state.body.as_str()));
        disk_states.push(BundleState {
            id: &state.id,
            url: &state.url,
            title: state.title.as_deref(),
            page: filename,
            truncated: state.truncated,
        });
    }

    let disk_trace = BundleTrace {
        version: trace.version,
        purpose: trace.purpose.as_deref(),
        started_at: trace.started_at.as_deref(),
        recorded_at: &trace.recorded_at,
        stopped_by: &trace.stopped_by,
        entry: &trace.entry,
        recorder: &trace.recorder,
        states: disk_states,
        steps: &trace.steps,
    };
    let json = serde_json::to_string_pretty(&disk_trace)
        .context("serialize trace JSON")
        .map_err(CliError::Local)?;

    validate_bundle_directory(output_dir, "output bundle directory")?;
    fs::create_dir_all(output_dir)
        .with_context(|| format!("create output dir {}", output_dir.display()))
        .map_err(CliError::Local)?;

    validate_bundle_directory(&states_dir, "states directory")?;

    let _lock = acquire_export_lock(output_dir)?;

    fs::create_dir_all(&states_dir)
        .with_context(|| format!("create states dir {}", states_dir.display()))
        .map_err(CliError::Local)?;

    for (filename, _) in &state_writes {
        validate_replaceable_file(&states_dir.join(filename), "state observation")?;
    }
    validate_replaceable_file(&trace_path, "trace JSON")?;

    let transaction_id = uuid::Uuid::new_v4();
    let staging_dir = output_dir.join(format!(".bsk-record-stage-{transaction_id}"));
    let staging_states = staging_dir.join("states");
    fs::create_dir_all(&staging_states)
        .with_context(|| format!("create staging dir {}", staging_states.display()))
        .map_err(CliError::Local)?;

    let stage_result: Result<(), CliError> = (|| {
        for (filename, body) in &state_writes {
            let staged_path = staging_states.join(filename);
            fs::write(&staged_path, body)
                .with_context(|| {
                    format!("write staged state observation {}", staged_path.display())
                })
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
        Vec::with_capacity(state_writes.len() + 1);
    for (filename, _) in &state_writes {
        replacements.push((
            staging_states.join(filename),
            states_dir.join(filename),
            states_dir.join(format!(".{filename}.{transaction_id}.bak")),
        ));
    }
    replacements.push((
        staging_dir.join("trace.json"),
        trace_path.clone(),
        output_dir.join(format!(".trace.json.{transaction_id}.bak")),
    ));

    commit_export_transaction(
        &staging_dir,
        &states_dir,
        &keep,
        transaction_id,
        replacements,
    )?;

    Ok(states_dir)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use bsk_protocol::tools::{
        NavigationCause, PageRefV2 as PageRef, RecorderInfo, StepCommonV3 as StepCommon,
        StepResultV3 as StepResult, StepV3 as Step, StopReason, TRACE_VERSION_V2, TRACE_VERSION_V3,
        TraceEntry, TraceStateV3, TraceV2, TraceV3, VOM_FORMAT_VERSION,
    };

    fn sample_trace(state_id: &str, body: &str) -> TraceV3 {
        TraceV3 {
            version: TRACE_VERSION_V3,
            recorded_at: "2026-08-10T02:12:55.360Z".into(),
            stopped_by: StopReason::UserFinish,
            entry: TraceEntry {
                start_url: "https://example.com/".into(),
            },
            recorder: RecorderInfo {
                bsk: "0.1.10".into(),
                vom: VOM_FORMAT_VERSION,
            },
            states: vec![TraceStateV3 {
                id: state_id.into(),
                url: "https://example.com/".into(),
                title: Some("Example".into()),
                body: body.into(),
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
    fn write_trace_bundle_writes_dir_layout() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        let trace = sample_trace("s1", "@vom 1\nL1 page");
        let states_dir = write_trace_bundle(&output, &trace).unwrap();
        let trace_path = output.join("trace.json");
        assert!(trace_path.exists());
        assert_eq!(states_dir, output.join("states"));
        assert!(states_dir.join("s1.txt").exists());
        let disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&trace_path).unwrap()).unwrap();
        assert_eq!(disk["states"][0]["page"], "s1.txt");
        assert!(disk["states"][0].get("body").is_none());
        assert_eq!(
            fs::read_to_string(states_dir.join("s1.txt")).unwrap(),
            "@vom 1\nL1 page"
        );

        // Re-exporting drops states from the previous run but keeps the
        // directory in place for the concurrent writer.
        fs::write(states_dir.join("s9.txt"), "stale").unwrap();
        fs::write(states_dir.join("notes.md"), "keep me").unwrap();
        fs::write(states_dir.join("reference.txt"), "user file").unwrap();
        write_trace_bundle(&output, &trace).unwrap();
        assert!(!states_dir.join("s9.txt").exists());
        assert!(states_dir.join("s1.txt").exists());
        assert!(states_dir.join("notes.md").exists());
        assert_eq!(
            fs::read_to_string(states_dir.join("reference.txt")).unwrap(),
            "user file"
        );
    }

    #[test]
    fn write_trace_bundle_rejects_traversal_state_id() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        let trace = sample_trace("../escaped", "@vom 1\nL1 page");

        let err = write_trace_bundle(&output, &trace).unwrap_err();

        assert!(err.to_string().contains("state id"));
        assert!(!output.join("escaped.txt").exists());
        assert!(!output.join("trace.json").exists());
    }

    #[test]
    fn write_trace_bundle_rejects_duplicate_state_id() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        let mut trace = sample_trace("s1", "@vom 1\nL1 first");
        trace.states.push(TraceStateV3 {
            body: "@vom 1\nL1 duplicate".into(),
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
            fs::read_to_string(output.join("states/s1.txt")).unwrap(),
            "original"
        );
        assert!(!output.join("states/s2.txt").exists());
    }

    #[test]
    fn state_replacement_failure_preserves_existing_bundle() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        write_trace_bundle(&output, &sample_trace("s1", "original")).unwrap();
        let original_json = fs::read(output.join("trace.json")).unwrap();
        fs::write(output.join("states/notes.md"), "keep me").unwrap();
        fs::create_dir(output.join("states/s2.txt")).unwrap();

        let err = write_trace_bundle(&output, &sample_trace("s2", "replacement")).unwrap_err();

        assert!(err.to_string().contains("state"));
        assert_eq!(fs::read(output.join("trace.json")).unwrap(), original_json);
        assert_eq!(
            fs::read_to_string(output.join("states/s1.txt")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(output.join("states/notes.md")).unwrap(),
            "keep me"
        );
    }

    #[test]
    fn stale_state_cleanup_failure_rolls_back_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        write_trace_bundle(&output, &sample_trace("s1", "original")).unwrap();
        let original_json = fs::read(output.join("trace.json")).unwrap();
        fs::create_dir(output.join("states/s9.txt")).unwrap();

        let err = write_trace_bundle(&output, &sample_trace("s2", "replacement")).unwrap_err();

        assert!(err.to_string().contains("stale state"));
        assert_eq!(fs::read(output.join("trace.json")).unwrap(), original_json);
        assert_eq!(
            fs::read_to_string(output.join("states/s1.txt")).unwrap(),
            "original"
        );
        assert!(!output.join("states/s2.txt").exists());
        assert!(output.join("states/s9.txt").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn write_trace_bundle_rejects_symlinked_states_directory() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        let external_states = dir.path().join("external-states");
        fs::create_dir_all(&output).unwrap();
        fs::create_dir_all(&external_states).unwrap();
        fs::write(external_states.join("s9.txt"), "external").unwrap();
        symlink(&external_states, output.join("states")).unwrap();

        let err = write_trace_bundle(&output, &sample_trace("s1", "replacement")).unwrap_err();

        assert!(err.to_string().contains("symlink"));
        assert_eq!(
            fs::read_to_string(external_states.join("s9.txt")).unwrap(),
            "external"
        );
        assert!(!external_states.join("s1.txt").exists());
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
        assert!(!external_output.join("states").exists());
    }

    #[test]
    fn write_trace_v2_writes_single_json_and_prunes_stale_states() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        fs::create_dir_all(output.join("states")).unwrap();
        fs::write(output.join("states/s1.txt"), "stale").unwrap();

        let trace = TraceV2 {
            recorded_at: "2026-08-10T02:12:55.360Z".into(),
            started_at: None,
            purpose: None,
            entry: bsk_protocol::tools::TraceEntry {
                start_url: "https://example.com/".into(),
            },
            pages: vec![PageRef {
                id: "p1".into(),
                url: "https://example.com/".into(),
                title: None,
            }],
            steps: vec![],
        };
        write_trace_v2(&output, &trace).unwrap();
        assert!(output.join("trace.json").exists());
        assert!(!output.join("states/s1.txt").exists());
    }

    #[test]
    fn write_trace_v2_stale_cleanup_failure_rolls_back_trace() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        write_trace_bundle(&output, &sample_trace("s1", "original")).unwrap();
        let original_json = fs::read(output.join("trace.json")).unwrap();
        fs::create_dir(output.join("states/s9.txt")).unwrap();
        let trace = TraceV2 {
            recorded_at: "2026-08-10T02:12:55.360Z".into(),
            started_at: None,
            purpose: None,
            entry: bsk_protocol::tools::TraceEntry {
                start_url: "https://example.com/".into(),
            },
            pages: vec![],
            steps: vec![],
        };

        let err = write_trace_v2(&output, &trace).unwrap_err();

        assert!(err.to_string().contains("stale state"));
        assert_eq!(fs::read(output.join("trace.json")).unwrap(), original_json);
        assert_eq!(
            fs::read_to_string(output.join("states/s1.txt")).unwrap(),
            "original"
        );
        assert!(output.join("states/s9.txt").is_dir());
    }

    #[test]
    fn export_recorded_trace_accepts_v2() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("flow");
        let trace = RecordedTrace::V2(TraceV2 {
            recorded_at: "2026-08-10T02:12:55.360Z".into(),
            started_at: None,
            purpose: None,
            entry: bsk_protocol::tools::TraceEntry {
                start_url: "https://example.com/".into(),
            },
            pages: vec![],
            steps: vec![],
        });
        let exported = export_recorded_trace(&output, &trace).unwrap();
        assert_eq!(exported.trace_version, TRACE_VERSION_V2);
        assert!(exported.states_dir.is_none());
        assert!(output.join("trace.json").exists());
    }

    #[test]
    fn existing_trace_json_file_is_rejected_with_bundle_usage() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("trace.json");
        fs::write(&output, "{}\n").unwrap();

        let err = validate_record_output(&output).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("JSON file") || msg.contains("json file"),
            "should name the legacy JSON file usage: {msg}"
        );
        assert!(
            msg.contains("states/") || msg.contains("--output trace"),
            "should hint at the new bundle directory usage: {msg}"
        );
        assert_eq!(fs::read_to_string(&output).unwrap(), "{}\n");
    }

    #[test]
    fn missing_trace_json_path_is_rejected_as_legacy_output() {
        let err = validate_record_output(Path::new("trace.json")).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("JSON file") || msg.contains("json file"),
            "{msg}"
        );
        assert!(
            msg.contains("states/") || msg.contains("--output trace"),
            "{msg}"
        );
    }

    #[test]
    fn export_failure_keeps_recovery_for_retry() {
        let _lock = crate::cli::record_recovery::test_env_lock();
        let tmp = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var(crate::daemon::paths::BSK_HOME_ENV, tmp.path());
        }

        let dir = tempfile::tempdir().unwrap();
        let bad_output = dir.path().join("trace.json");
        fs::write(&bad_output, "{}\n").unwrap();
        let trace = RecordedTrace::V3(sample_trace("s1", "@vom 1\nL1 page"));

        let err = export_with_recovery(&bad_output, &trace).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("recover") || msg.contains("record stop"),
            "export failure should tell the user how to recover: {msg}"
        );
        assert!(
            crate::cli::record_recovery::exists(),
            "recovery data must survive a failed bundle export"
        );
        let recovered = crate::cli::record_recovery::load()
            .unwrap()
            .expect("recovery file");
        assert_eq!(recovered, trace);
        assert_eq!(fs::read_to_string(&bad_output).unwrap(), "{}\n");

        let good_output = dir.path().join("bundle");
        export_with_recovery(&good_output, &recovered).unwrap();
        assert!(good_output.join("trace.json").exists());
        assert!(good_output.join("states/s1.txt").exists());
        assert!(
            !crate::cli::record_recovery::exists(),
            "successful export must delete recovery data"
        );

        unsafe {
            std::env::remove_var(crate::daemon::paths::BSK_HOME_ENV);
        }
    }
}
