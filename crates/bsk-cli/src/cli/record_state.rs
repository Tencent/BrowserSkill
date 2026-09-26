//! Persist the session id between `bsk record start` and `bsk record stop`.

use std::fs::{self, File, OpenOptions};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::daemon::paths;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordSessionState {
    pub session_id: String,
    pub started_at: String,
}

/// Serializes every check-then-change of the state file across CLI processes.
/// Keep the lock file in place: deleting it could let two processes lock
/// different files at the same path.
struct StateLock {
    file: File,
}

impl Drop for StateLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

impl StateLock {
    fn acquire() -> Result<Self> {
        paths::ensure_bsk_home()?;
        let path = paths::record_session_path()?.with_extension("lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .with_context(|| format!("open {}", path.display()))?;
        FileExt::lock_exclusive(&file).with_context(|| format!("lock {}", path.display()))?;
        Ok(Self { file })
    }
}

pub fn write(session_id: &str) -> Result<()> {
    let _lock = StateLock::acquire()?;
    let path = paths::record_session_path()?;
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
    fs::write(&path, format!("{json}\n")).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

pub fn read() -> Result<RecordSessionState> {
    let _lock = StateLock::acquire()?;
    read_unlocked()
}

fn read_unlocked() -> Result<RecordSessionState> {
    let path = paths::record_session_path()?;
    if !path.exists() {
        return Err(anyhow::anyhow!(
            "no recording in progress; run `bsk record start` first"
        ));
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("parse {}", path.display()))
}

/// Remove the state only while it still names `session_id`, so late cleanup
/// for an earlier recording cannot drop a newer one.
pub fn clear_session(session_id: &str) {
    let Ok(_lock) = StateLock::acquire() else {
        return;
    };
    if read_unlocked().is_ok_and(|state| state.session_id == session_id)
        && let Ok(path) = paths::record_session_path()
    {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
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

    fn with_temp_home<F: FnOnce()>(f: F) {
        let _lock = crate::daemon::paths::test_env_lock();
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

    #[test]
    fn clear_session_only_removes_its_own_state() {
        with_temp_home(|| {
            write("new").unwrap();
            clear_session("old");
            assert_eq!(read().unwrap().session_id, "new");

            clear_session("new");
            assert!(read().is_err());
        });
    }

    #[test]
    fn concurrent_writes_admit_one_recording() {
        with_temp_home(|| {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
            let admitted = (0..8)
                .map(|index| {
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        write(&format!("session-{index}")).is_ok()
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|admitted| *admitted)
                .count();
            assert_eq!(admitted, 1);
        });
    }
}
