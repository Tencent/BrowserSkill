//! Filesystem layout for the local daemon home (`~/.bsk` by default).
//!
//! Per design §3.2 the daemon owns a per-user home directory containing:
//!
//! ```text
//! ~/.bsk/
//!   daemon.lock      advisory file lock (M2.2)
//!   daemon.sock      UDS socket  (Unix only, M2.3) — actually under run/
//!   daemon.pid       deprecated; pid lives in daemon.json
//!   daemon.json      DaemonInfo (M2.4)
//!   daemon.log       rotating daily file (M3.4)
//!   run/             ephemeral runtime artifacts (sockets etc.)
//! ```
//!
//! Tests override the location via `BSK_HOME` so the user's real `~/.bsk`
//! is never touched. On Unix the home is created with mode 0700.

use std::env;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Environment variable that overrides the home directory.
pub const BSK_HOME_ENV: &str = "BSK_HOME";

/// Resolve the bsk home directory:
/// 1. `BSK_HOME` env var (any non-empty value); or
/// 2. `~/.bsk` (using [`dirs::home_dir`]).
pub fn bsk_home() -> Result<PathBuf> {
    if let Ok(p) = env::var(BSK_HOME_ENV) {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let home = dirs::home_dir().context("could not determine user home directory")?;
    Ok(home.join(".bsk"))
}

/// Ensure `~/.bsk` (or `$BSK_HOME`) exists, creating it with restrictive
/// permissions on Unix (`chmod 0700`). Returns the absolute path.
pub fn ensure_bsk_home() -> Result<PathBuf> {
    let home = bsk_home()?;
    if !home.exists() {
        std::fs::create_dir_all(&home)
            .with_context(|| format!("create bsk home {}", home.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(&home, perms)
            .with_context(|| format!("chmod 0700 {}", home.display()))?;
    }
    ensure_run_dir(&home)?;
    Ok(home)
}

fn ensure_run_dir(home: &Path) -> Result<()> {
    let run = home.join("run");
    if !run.exists() {
        std::fs::create_dir_all(&run).with_context(|| format!("create {}", run.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(&run, perms)?;
    }
    Ok(())
}

pub fn lock_path() -> Result<PathBuf> {
    Ok(bsk_home()?.join("daemon.lock"))
}

pub fn info_path() -> Result<PathBuf> {
    Ok(bsk_home()?.join("daemon.json"))
}

pub fn log_path() -> Result<PathBuf> {
    Ok(bsk_home()?.join("daemon.log"))
}

pub fn update_check_path() -> Result<PathBuf> {
    Ok(bsk_home()?.join("update-check.json"))
}

pub fn log_dir() -> Result<PathBuf> {
    bsk_home()
}

/// Path to the IPC socket (Unix UDS). On Windows the IPC layer uses a
/// named-pipe whose name is derived from [`pipe_name`].
pub fn sock_path() -> Result<PathBuf> {
    Ok(bsk_home()?.join("run").join("daemon.sock"))
}

/// Windows named-pipe name. Include the resolved `BSK_HOME` path in the
/// token so test homes and custom installs do not share a predictable
/// per-username pipe.
#[cfg(windows)]
pub fn pipe_name() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let user = env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let home = bsk_home()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown-home".to_string());
    let mut hasher = DefaultHasher::new();
    user.hash(&mut hasher);
    home.hash(&mut hasher);
    format!(r"\\.\pipe\bsk-daemon-{user}-{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// Serialise tests that mutate the global `BSK_HOME` env var.
    fn env_guard() -> &'static Mutex<()> {
        static GUARD: Mutex<()> = Mutex::new(());
        &GUARD
    }

    fn with_temp_home<F: FnOnce(&Path)>(f: F) {
        let _lock = env_guard().lock().unwrap_or_else(|e| e.into_inner());
        let tmp = TempDir::new().unwrap();
        // SAFETY: serialised by env_guard above.
        unsafe {
            std::env::set_var(BSK_HOME_ENV, tmp.path().join("bsk"));
        }
        f(tmp.path());
        unsafe {
            std::env::remove_var(BSK_HOME_ENV);
        }
    }

    #[test]
    fn ensure_creates_home() {
        with_temp_home(|root| {
            let home = ensure_bsk_home().unwrap();
            assert!(home.starts_with(root));
            assert!(home.exists());
            assert!(home.join("run").exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&home).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o700);
            }
        });
    }

    #[test]
    fn computes_expected_paths() {
        with_temp_home(|_| {
            let home = ensure_bsk_home().unwrap();
            assert_eq!(lock_path().unwrap(), home.join("daemon.lock"));
            assert_eq!(info_path().unwrap(), home.join("daemon.json"));
            assert_eq!(log_path().unwrap(), home.join("daemon.log"));
            assert_eq!(update_check_path().unwrap(), home.join("update-check.json"));
            assert_eq!(sock_path().unwrap(), home.join("run").join("daemon.sock"));
        });
    }
}
