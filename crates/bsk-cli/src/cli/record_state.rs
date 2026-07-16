//! Persist the session id between `bsk record start` and `bsk record stop`.

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::daemon::paths;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordSessionState {
    pub session_id: String,
    pub started_at: String,
}

pub fn write(session_id: &str) -> Result<()> {
    let path = paths::record_session_path()?;
    paths::ensure_bsk_home()?;
    if path.exists() {
        return Err(anyhow::anyhow!(
            "a recording is already in progress; run `bsk record stop` first"
        ));
    }
    let state = RecordSessionState {
        session_id: session_id.to_string(),
        started_at: started_at_unix_ms(),
    };
    let json = serde_json::to_string_pretty(&state).context("serialize record session state")?;
    fs::write(&path, format!("{json}\n"))
        .with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

pub fn read() -> Result<RecordSessionState> {
    let path = paths::record_session_path()?;
    if !path.exists() {
        return Err(anyhow::anyhow!(
            "no recording in progress; run `bsk record start` first"
        ));
    }
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&raw)
        .with_context(|| format!("parse {}", path.display()))
}

pub fn clear() {
    if let Ok(path) = paths::record_session_path() {
        let _ = fs::remove_file(path);
    }
}

fn started_at_unix_ms() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{ms}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn env_guard() -> &'static Mutex<()> {
        static GUARD: Mutex<()> = Mutex::new(());
        &GUARD
    }

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _lock = env_guard().lock().unwrap_or_else(|e| e.into_inner());
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
    fn write_read_round_trips() {
        with_temp_home(|| {
            write("abcd").unwrap();
            let state = read().unwrap();
            assert_eq!(state.session_id, "abcd");
            assert!(!state.started_at.is_empty());
        });
    }

    #[test]
    fn write_rejects_duplicate() {
        with_temp_home(|| {
            write("abcd").unwrap();
            let err = write("efgh").unwrap_err();
            assert!(err.to_string().contains("already in progress"));
        });
    }

    #[test]
    fn read_errors_when_missing() {
        with_temp_home(|| {
            let err = read().unwrap_err();
            assert!(err.to_string().contains("no recording in progress"));
        });
    }

    #[test]
    fn clear_removes_state_file() {
        with_temp_home(|| {
            write("abcd").unwrap();
            clear();
            assert!(read().is_err());
        });
    }
}
