//! Consolidated integration tests that mutate process-wide environment variables (`BSK_HOME`).

pub(crate) static PROCESS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[path = "process_env/browser_wait.rs"]
#[cfg(unix)]
mod browser_wait;
#[path = "process_env/info_roundtrip.rs"]
mod info_roundtrip;
#[path = "process_env/lockfile.rs"]
mod lockfile;
