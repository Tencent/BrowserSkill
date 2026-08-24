//! Persist a completed Trace so a failed bundle export can be retried.

use std::fs;

use anyhow::{Context, Result};
use bsk_protocol::tools::RecordedTrace;

use crate::daemon::paths;

pub fn save(trace: &RecordedTrace) -> Result<()> {
    let path = paths::record_recovery_path()?;
    paths::ensure_bsk_home()?;
    let json = serde_json::to_string_pretty(trace).context("serialize record recovery")?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, format!("{json}\n")).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, &path).with_context(|| format!("commit {}", path.display()))?;
    Ok(())
}

pub fn load() -> Result<Option<RecordedTrace>> {
    let path = paths::record_recovery_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let trace = serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))?;
    Ok(Some(trace))
}

pub fn exists() -> bool {
    paths::record_recovery_path()
        .map(|path| path.exists())
        .unwrap_or(false)
}

pub fn clear() {
    if let Ok(path) = paths::record_recovery_path() {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
pub(crate) fn test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::daemon::paths::test_env_lock()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsk_protocol::tools::{
        RecorderInfo, StopReason, TRACE_VERSION_V3, TraceEntry, TraceStateV3, TraceV3,
        VOM_FORMAT_VERSION,
    };

    fn sample_trace() -> RecordedTrace {
        RecordedTrace::V3(TraceV3 {
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
                id: "s1".into(),
                url: "https://example.com/".into(),
                title: Some("Example".into()),
                body: "@vom 1\nL1 page".into(),
                truncated: false,
            }],
            steps: vec![],
            purpose: None,
            started_at: None,
        })
    }

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _lock = test_env_lock();
        let tmp = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var(crate::daemon::paths::BSK_HOME_ENV, tmp.path());
        }
        f();
        clear();
        unsafe {
            std::env::remove_var(crate::daemon::paths::BSK_HOME_ENV);
        }
    }

    #[test]
    fn save_load_round_trips() {
        with_temp_home(|| {
            let trace = sample_trace();
            save(&trace).unwrap();
            assert!(exists());
            assert_eq!(load().unwrap(), Some(trace));
        });
    }

    #[test]
    fn clear_removes_recovery_file() {
        with_temp_home(|| {
            save(&sample_trace()).unwrap();
            clear();
            assert!(!exists());
            assert_eq!(load().unwrap(), None);
        });
    }
}
