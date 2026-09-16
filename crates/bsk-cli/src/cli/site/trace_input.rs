//! Read a recorded trace from either shape `bsk record` can produce.
//!
//! `tool.record_stop` returns the **wire** trace, where each state carries its
//! observation inline as `body`. `bsk record start --output <dir>` writes a
//! **bundle** instead (`crates/bsk-cli/src/cli/record/export.rs`): the page
//! text moves to `states/<id>.txt` and `trace.json` references it as `page`.
//! `TraceV3` denies unknown fields, so a bundle never parses as a wire trace —
//! which is exactly the file an agent has on disk after a recording.
//!
//! The observation text is read back only so the reconstructed `TraceV3` is
//! faithful. Nothing derived from it reaches site memory: `states[]` holds
//! full page text including URLs, account names and order numbers, and design
//! §4.1 keeps that out of the store.

use std::path::Path;

use anyhow::{Context, Result, bail};
use bsk_protocol::tools::{RecordedTrace, TraceStateV3, TraceV3};
use serde::Deserialize;

/// A `states[]` entry as written into a bundle: `page` instead of `body`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleState {
    id: String,
    url: String,
    #[serde(default)]
    title: Option<String>,
    page: String,
    #[serde(default)]
    truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BundleTrace {
    version: u32,
    #[serde(default)]
    purpose: Option<String>,
    #[serde(default)]
    started_at: Option<String>,
    recorded_at: String,
    stopped_by: bsk_protocol::tools::StopReason,
    entry: bsk_protocol::tools::TraceEntry,
    recorder: bsk_protocol::tools::RecorderInfo,
    states: Vec<BundleState>,
    steps: Vec<bsk_protocol::tools::StepV3>,
}

/// Load a v3 trace from `path`, accepting the wire and bundle shapes.
pub fn read_trace_v3(path: &Path) -> Result<TraceV3> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("read trace {}", path.display()))?;

    // A bundle and a wire trace are told apart by `states[].page`, so try the
    // wire shape first and keep its error for the failure message.
    let wire_error = match serde_json::from_str::<RecordedTrace>(&text) {
        Ok(RecordedTrace::V3(trace)) => return Ok(trace),
        Ok(RecordedTrace::V2(_)) => bail!(
            "{} is a v2 trace, which has no per-step semantic targets. Re-record it with a \
             v3-capable extension before deriving a workflow.",
            path.display()
        ),
        Err(err) => err,
    };

    match serde_json::from_str::<BundleTrace>(&text) {
        Ok(bundle) => rebuild(bundle, path),
        Err(bundle_error) => Err(anyhow::anyhow!(
            "{} is neither a recorded trace ({wire_error}) nor a record bundle ({bundle_error})",
            path.display()
        )),
    }
}

fn rebuild(bundle: BundleTrace, trace_path: &Path) -> Result<TraceV3> {
    let states_dir = trace_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("states");
    let mut states = Vec::with_capacity(bundle.states.len());
    for state in bundle.states {
        // `page` is a filename the bundle writer produced; refuse anything that
        // could read outside the bundle's own states directory.
        let name = Path::new(&state.page);
        let mut components = name.components();
        match (components.next(), components.next()) {
            (Some(std::path::Component::Normal(_)), None) => {}
            _ => bail!(
                "trace bundle {} references the state file {:?}, which is not a plain filename",
                trace_path.display(),
                state.page
            ),
        }
        // A missing page file costs nothing here: the body is never stored, so
        // an incomplete bundle should still yield a usable workflow.
        let body = std::fs::read_to_string(states_dir.join(name)).unwrap_or_default();
        states.push(TraceStateV3 {
            id: state.id,
            url: state.url,
            title: state.title,
            body,
            truncated: state.truncated,
        });
    }

    let trace = TraceV3 {
        version: bundle.version,
        purpose: bundle.purpose,
        started_at: bundle.started_at,
        recorded_at: bundle.recorded_at,
        stopped_by: bundle.stopped_by,
        entry: bundle.entry,
        recorder: bundle.recorder,
        states,
        steps: bundle.steps,
    };
    if trace.version != bsk_protocol::tools::TRACE_VERSION_V3 {
        bail!(
            "trace bundle {} has version {}, expected {}",
            trace_path.display(),
            trace.version,
            bsk_protocol::tools::TRACE_VERSION_V3
        );
    }
    Ok(trace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::tools::{
        NavigationCause, RecorderInfo, StepCommonV3, StepResultV3, StepV3, StopReason,
        TRACE_VERSION_V3, TraceEntry, VOM_FORMAT_VERSION,
    };

    fn sample() -> TraceV3 {
        TraceV3 {
            version: TRACE_VERSION_V3,
            purpose: Some("提交工单".into()),
            started_at: None,
            recorded_at: "2026-09-12T09:31:00Z".into(),
            stopped_by: StopReason::UserFinish,
            entry: TraceEntry {
                start_url: "https://ticket.corp.example/".into(),
            },
            recorder: RecorderInfo {
                bsk: "0.2.1".into(),
                vom: VOM_FORMAT_VERSION,
            },
            states: vec![TraceStateV3 {
                id: "s1".into(),
                url: "https://ticket.corp.example/new".into(),
                title: Some("新建工单".into()),
                body: "@vom 1\nRootWebArea \"新建工单\"".into(),
                truncated: false,
            }],
            steps: vec![StepV3::Navigate {
                common: StepCommonV3 {
                    id: 1,
                    state: "s1".into(),
                    result: StepResultV3 { state: "s1".into() },
                },
                to: "https://ticket.corp.example/new".into(),
                cause: NavigationCause::UserTyped,
            }],
        }
    }

    /// The exact file `bsk record start --output <dir>` leaves on disk must
    /// load. This uses the real exporter so the two cannot drift.
    #[test]
    fn reads_a_bundle_written_by_the_real_exporter() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("rec");
        crate::cli::record::export::write_trace_bundle(&out, &sample()).unwrap();

        let path = out.join("trace.json");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"page\""), "exporter shape changed: {raw}");
        assert!(!raw.contains("\"body\""));

        let trace = read_trace_v3(&path).unwrap();
        assert_eq!(trace, sample(), "body must be restored from states/s1.txt");
    }

    #[test]
    fn reads_a_wire_trace_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trace.json");
        std::fs::write(&path, serde_json::to_string(&sample()).unwrap()).unwrap();
        assert_eq!(read_trace_v3(&path).unwrap(), sample());
    }

    #[test]
    fn missing_state_files_still_yield_a_usable_trace() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("rec");
        crate::cli::record::export::write_trace_bundle(&out, &sample()).unwrap();
        std::fs::remove_dir_all(out.join("states")).unwrap();
        let trace = read_trace_v3(&out.join("trace.json")).unwrap();
        assert_eq!(trace.steps.len(), 1);
        assert_eq!(trace.states[0].body, "");
    }

    #[test]
    fn bundle_page_pointing_outside_the_states_dir_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trace.json");
        let mut value = serde_json::to_value(sample()).unwrap();
        value["states"][0].as_object_mut().unwrap().remove("body");
        value["states"][0]["page"] = serde_json::json!("../../etc/passwd");
        std::fs::write(&path, value.to_string()).unwrap();
        let err = read_trace_v3(&path).unwrap_err();
        assert!(err.to_string().contains("not a plain filename"), "{err:#}");
    }

    #[test]
    fn a_v2_trace_is_rejected_with_a_re_record_hint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trace.json");
        std::fs::write(
            &path,
            serde_json::json!({
                "recorded_at": "2026-09-12T09:31:00Z",
                "stopped_by": "user_finish",
                "entry": { "start_url": "https://corp.example/" },
                "recorder": { "bsk": "0.1.0", "vom": 1 },
                "pages": [],
                "steps": []
            })
            .to_string(),
        )
        .unwrap();
        let err = read_trace_v3(&path).unwrap_err();
        assert!(err.to_string().contains("v2 trace"), "{err:#}");
    }

    #[test]
    fn unrelated_json_reports_both_parse_failures() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("trace.json");
        std::fs::write(&path, "{\"hello\":1}").unwrap();
        let err = read_trace_v3(&path).unwrap_err();
        let text = err.to_string();
        assert!(text.contains("neither a recorded trace"), "{text}");
        assert!(text.contains("record bundle"), "{text}");
    }
}
