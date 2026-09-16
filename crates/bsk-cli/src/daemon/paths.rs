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

pub(crate) const BSK_HOME_HINT: &str = "set BSK_HOME to a writable private directory; \
    when using a host daemon, use the same shared directory and allow access to it \
    and its IPC endpoint in the sandbox settings";

/// Resolve the bsk home directory:
/// 1. `BSK_HOME` env var (any non-empty value); or
/// 2. `~/.bsk` (using [`dirs::home_dir`]).
pub fn bsk_home() -> Result<PathBuf> {
    if let Ok(p) = env::var(BSK_HOME_ENV) {
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let home = dirs::home_dir()
        .with_context(|| format!("could not determine user home directory; {BSK_HOME_HINT}"))?;
    Ok(home.join(".bsk"))
}

/// Ensure `~/.bsk` (or `$BSK_HOME`) exists, creating it with restrictive
/// permissions on Unix (`chmod 0700`). Returns the resolved path.
pub fn ensure_bsk_home() -> Result<PathBuf> {
    let home = bsk_home()?;
    prepare_home(&home).with_context(|| {
        let source = if env::var(BSK_HOME_ENV).is_ok_and(|value| !value.is_empty()) {
            "BSK_HOME"
        } else {
            "platform home lookup"
        };
        format!(
            "cannot prepare bsk home {} (from {source}); {BSK_HOME_HINT}",
            home.display()
        )
    })?;
    Ok(home)
}

fn prepare_home(home: &Path) -> Result<()> {
    if !home.exists() {
        std::fs::create_dir_all(home)
            .with_context(|| format!("create bsk home {}", home.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(home, perms)
            .with_context(|| format!("chmod 0700 {}", home.display()))?;
    }
    ensure_run_dir(home)
}

fn ensure_run_dir(home: &Path) -> Result<()> {
    ensure_private_dir(&home.join("run"))
}

/// Create `dir` (and parents) if missing and tighten it to 0700 on Unix.
///
/// Shared by every BSK_HOME subtree that may hold user-derived data
/// (`run/`, `sites/`) so they all carry the same permission promise as the
/// home itself.
///
/// Every level this call brings into existence is created and chmodded
/// individually rather than through `create_dir_all`, which would leave the
/// intermediate levels at the process umask: `sites/.drafts/<task>/<host>`
/// used to end up with a world-readable `.drafts/` and `.drafts/<task>/`,
/// letting any other account on the machine enumerate task ids. Directories
/// that already existed keep their own permissions except for `dir` itself.
pub fn ensure_private_dir(dir: &Path) -> Result<()> {
    if !dir.exists() {
        let mut missing: Vec<&Path> = Vec::new();
        let mut cursor = Some(dir);
        while let Some(path) = cursor {
            if path.as_os_str().is_empty() || path.exists() {
                break;
            }
            missing.push(path);
            cursor = path.parent();
        }
        for path in missing.into_iter().rev() {
            match std::fs::create_dir(path) {
                Ok(()) => {}
                // A concurrent agent may have created the same level first.
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => {
                    return Err(
                        anyhow::Error::from(err).context(format!("create {}", path.display()))
                    );
                }
            }
            set_private_mode(path)?;
        }
    }
    set_private_mode(dir)
}

fn set_private_mode(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o700);
        std::fs::set_permissions(dir, perms)
            .with_context(|| format!("chmod 0700 {}", dir.display()))?;
    }
    #[cfg(not(unix))]
    let _ = dir;
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

/// Path to the in-progress recording session state (`record-session.json`).
pub fn record_session_path() -> Result<PathBuf> {
    Ok(bsk_home()?.join("record-session.json"))
}

/// Path to a completed Trace saved before bundle export (`record-recovery.json`).
///
/// Kept until export succeeds so a failed `--output` write cannot drop the
/// recording the extension already returned.
pub fn record_recovery_path() -> Result<PathBuf> {
    Ok(bsk_home()?.join("record-recovery.json"))
}

/// Root of the local site-memory tree (`$BSK_HOME/sites`).
///
/// Holds the same kind of user-derived data as `audit/`, so it inherits the
/// 0700 directory promise from [`ensure_private_dir`].
pub fn sites_root() -> Result<PathBuf> {
    Ok(bsk_home()?.join("sites"))
}

/// Ensure the site-memory root exists with restrictive permissions.
pub fn ensure_sites_root() -> Result<PathBuf> {
    let home = ensure_bsk_home()?;
    let root = home.join("sites");
    ensure_private_dir(&root)?;
    Ok(root)
}

/// Active memory directory for one already-normalised host (design §5).
///
/// `host` must be a single safe path segment; callers go through
/// `cli::site::store::normalize_host`, which guarantees that. The directory is
/// not created here.
pub fn site_dir(host: &str) -> Result<PathBuf> {
    Ok(sites_root()?.join(host))
}

/// Draft root for one task (design §5). Not created here.
pub fn drafts_dir(task: &str) -> Result<PathBuf> {
    Ok(sites_root()?.join(".drafts").join(task))
}

/// Windows named-pipe name. Include the resolved `BSK_HOME` path in the
/// token so test homes and custom installs do not share a predictable
/// per-username pipe.
///
/// The name is hash-only (`bsk-daemon-<hex>`): the hash already covers
/// user + home, so uniqueness and per-user isolation are unchanged, and
/// the pipe name never contains raw username characters. Usernames with
/// apostrophes/spaces/non-ASCII characters (e.g. `z'z'f'l'g'y`) make
/// NPFS misbehave — `CreateNamedPipeW` reports success yet clients get
/// `ERROR_FILE_NOT_FOUND` opening the very same name (issue #75).
#[cfg(windows)]
pub fn pipe_name() -> String {
    let user = env::var("USERNAME").unwrap_or_else(|_| "default".to_string());
    let home = bsk_home()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown-home".to_string());
    render_pipe_name(&user, &home)
}

/// Process-wide lock for tests that mutate `BSK_HOME`.
#[cfg(test)]
pub(crate) fn test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    static GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
    GUARD.lock().unwrap_or_else(|e| e.into_inner())
}

/// Render the Windows named-pipe name for a user/home pair. Kept
/// platform-agnostic so unit tests on any host can pin the output
/// character set.
#[cfg(any(windows, test))]
fn render_pipe_name(user: &str, home: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    user.hash(&mut hasher);
    home.hash(&mut hasher);
    format!(r"\\.\pipe\bsk-daemon-{:016x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn with_temp_home<F: FnOnce(&Path)>(f: F) {
        let _lock = test_env_lock();
        let tmp = TempDir::new().unwrap();
        // SAFETY: serialised by test_env_lock above.
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
    fn ensure_sites_root_creates_private_directory() {
        with_temp_home(|_| {
            let root = ensure_sites_root().unwrap();
            assert!(root.is_dir());
            assert_eq!(root, sites_root().unwrap());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&root).unwrap().permissions().mode() & 0o777;
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
            assert_eq!(
                record_session_path().unwrap(),
                home.join("record-session.json")
            );
            assert_eq!(
                record_recovery_path().unwrap(),
                home.join("record-recovery.json")
            );
            assert_eq!(sites_root().unwrap(), home.join("sites"));
            assert_eq!(
                site_dir("corp.example").unwrap(),
                home.join("sites").join("corp.example")
            );
            assert_eq!(
                drafts_dir("t1").unwrap(),
                home.join("sites").join(".drafts").join("t1")
            );
        });
    }

    /// Issue #75: usernames with apostrophes/spaces/non-ASCII characters
    /// must not leak into the pipe name — NPFS misbehaves on such names
    /// (CreateNamedPipeW succeeds, yet clients opening the same name get
    /// ERROR_FILE_NOT_FOUND). The name must be hash-only.
    #[test]
    fn pipe_name_uses_safe_charset_for_special_usernames() {
        for user in ["z'z'f'l'g'y", "user name", "用户", "a\"b\\c", "plain"] {
            let name = render_pipe_name(user, r"C:\Users\whatever\.bsk");
            let suffix = name
                .strip_prefix(r"\\.\pipe\bsk-daemon-")
                .unwrap_or_else(|| panic!("unexpected pipe name shape: {name}"));
            assert_eq!(
                suffix.len(),
                16,
                "pipe name {name} must carry a 16-hex-char hash"
            );
            assert!(
                suffix.chars().all(|c| c.is_ascii_hexdigit()),
                "pipe name {name} must be hash-only (did user {user:?} leak?)"
            );
        }
    }

    /// The hash-only name stays unique per (user, home) and deterministic
    /// across calls (daemon and CLI exchange it via daemon.json, but a
    /// stable value keeps logs/diagnostics comparable).
    #[test]
    fn pipe_name_is_deterministic_and_scoped() {
        let a = render_pipe_name("alice", r"C:\Users\alice\.bsk");
        assert_eq!(a, render_pipe_name("alice", r"C:\Users\alice\.bsk"));
        assert_ne!(a, render_pipe_name("bob", r"C:\Users\alice\.bsk"));
        assert_ne!(a, render_pipe_name("alice", r"D:\alt-home\.bsk"));
    }
}
