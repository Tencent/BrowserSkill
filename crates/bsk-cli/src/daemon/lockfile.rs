//! Advisory file lock for the daemon (`~/.bsk/daemon.lock`).
//!
//! At most one daemon process per host may hold the lock. The lock is
//! released automatically when the holding process exits (kernel-managed
//! advisory lock via `fs2::FileExt`).

use std::fs::{File, OpenOptions};
use std::path::PathBuf;

use anyhow::{Context, Result};
use fs2::FileExt;
use thiserror::Error;

use crate::daemon::paths;

/// A held daemon lock. Dropping the value releases the lock.
#[derive(Debug)]
pub struct DaemonLock {
    file: File,
    path: PathBuf,
}

impl DaemonLock {
    /// Returns the absolute path of the lock file on disk.
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for DaemonLock {
    fn drop(&mut self) {
        // Best-effort: unlock then close. Kernel would do this anyway.
        // Use fs2::FileExt explicitly so we don't accidentally pull in
        // the std::fs::FileExt method stabilised in 1.89 (our MSRV is
        // 1.85).
        let _ = <std::fs::File as fs2::FileExt>::unlock(&self.file);
    }
}

/// Error returned when the lock is already held by another process.
#[derive(Debug, Error)]
#[error("daemon lock {path} is already held by another process")]
pub struct AlreadyLocked {
    pub path: PathBuf,
}

/// Acquire the lock exclusively, returning a guard.
pub fn acquire() -> Result<DaemonLock> {
    paths::ensure_bsk_home()?;
    let path = paths::lock_path()?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .with_context(|| format!("open lock file {}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    match file.try_lock_exclusive() {
        Ok(()) => Ok(DaemonLock { file, path }),
        Err(_) => Err(anyhow::anyhow!(AlreadyLocked { path })),
    }
}

/// Check if a pid is alive on the local machine.
///
/// Returns `true` if a process with that pid exists (we don't differentiate
/// our own daemon vs an unrelated process — the pid in `daemon.json` is
/// validated against the held lock by [`info::read_valid`] in M2.4).
pub fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        use nix::errno::Errno;
        use nix::sys::signal::kill;
        use nix::unistd::Pid;
        match kill(Pid::from_raw(pid as i32), None) {
            Ok(()) => true,
            Err(Errno::ESRCH) => false,
            // EPERM means the process exists but we can't signal it — still alive.
            Err(Errno::EPERM) => true,
            Err(_) => false,
        }
    }

    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            CloseHandle(handle);
            true
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}
