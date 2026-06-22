//! `~/.bsk/daemon.json` — the canonical "where is the running daemon"
//! discovery file written by the daemon and consumed by the CLI.
//!
//! Reads use [`read`]/[`read_valid`]; writes go through [`write`] which
//! atomically renames a temp file into place and stamps mode 0600 on
//! Unix so stale info from an aborted daemon cannot leak credentials or
//! confuse a CLI start-up race.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::daemon::lockfile;
use crate::daemon::paths;

/// Snapshot of a live daemon. Mirrors design doc §3.1's "daemon
/// auto-startup logic" field set: enough for the CLI to connect over IPC
/// and surface a `bsk status` line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonInfo {
    pub pid: u32,
    pub sock_path: PathBuf,
    pub ws_port: u16,
    pub version: String,
    /// `SystemTime` rendered as RFC 3339-ish seconds-since-epoch for
    /// portability across platforms.
    pub started_at_epoch_secs: u64,
}

impl DaemonInfo {
    pub fn now(pid: u32, sock_path: PathBuf, ws_port: u16, version: impl Into<String>) -> Self {
        Self {
            pid,
            sock_path,
            ws_port,
            version: version.into(),
            started_at_epoch_secs: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        }
    }
}

/// Atomically write `info` to `daemon.json`. Temp-file-and-rename keeps
/// the file visible to readers as a coherent unit. Mode is stamped to
/// 0600 on Unix.
pub fn write(info: &DaemonInfo) -> Result<()> {
    paths::ensure_bsk_home()?;
    let final_path = paths::info_path()?;
    write_to_path(info, &final_path)
}

/// Test-friendly variant exposed for integration tests; production code
/// should call [`write`].
pub fn write_to_path(info: &DaemonInfo, final_path: &Path) -> Result<()> {
    let dir = final_path
        .parent()
        .context("info path must have a parent directory")?;
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;

    let mut tmp = final_path.to_path_buf();
    let file_name = format!(
        "{}.tmp.{}",
        final_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("daemon.json"),
        std::process::id()
    );
    tmp.set_file_name(file_name);
    let payload = serde_json::to_vec_pretty(info).context("serialise daemon info")?;

    {
        let file =
            std::fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        let mut file = std::io::BufWriter::new(file);
        use std::io::Write;
        file.write_all(&payload)
            .with_context(|| format!("write {}", tmp.display()))?;
        file.flush()
            .with_context(|| format!("flush {}", tmp.display()))?;
        file.get_ref()
            .sync_all()
            .with_context(|| format!("sync {}", tmp.display()))?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("chmod 0600 {}", tmp.display()))?;
    }

    std::fs::rename(&tmp, final_path)
        .with_context(|| format!("rename {} → {}", tmp.display(), final_path.display()))?;
    if let Ok(dir_file) = std::fs::File::open(dir) {
        let _ = dir_file.sync_all();
    }
    Ok(())
}

/// Read `daemon.json`. Returns `Ok(None)` if the file is missing so
/// callers can distinguish "no daemon running" from "I/O error".
pub fn read() -> Result<Option<DaemonInfo>> {
    let p = paths::info_path()?;
    read_from_path(&p)
}

pub fn read_from_path(path: &Path) -> Result<Option<DaemonInfo>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let info: DaemonInfo = serde_json::from_slice(&bytes)
                .with_context(|| format!("parse {}", path.display()))?;
            Ok(Some(info))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(anyhow::Error::from(err).context(format!("read {}", path.display()))),
    }
}

/// Read `daemon.json` and only return it if the recorded pid is alive
/// on the local machine. Stale files (daemon crashed without cleanup)
/// surface as `Ok(None)` so callers can fall through to "auto-spawn".
pub fn read_valid() -> Result<Option<DaemonInfo>> {
    Ok(read()?.filter(|info| lockfile::pid_alive(info.pid)))
}

/// Delete the info file (used when the daemon shuts down cleanly).
pub fn remove() -> Result<()> {
    let p = paths::info_path()?;
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(anyhow::Error::from(err).context(format!("remove {}", p.display()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn round_trip_through_path() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("daemon.json");
        let info = DaemonInfo::now(
            std::process::id(),
            tmp.path().join("daemon.sock"),
            52800,
            "0.1.0-test",
        );
        write_to_path(&info, &path).unwrap();
        let parsed = read_from_path(&path).unwrap().unwrap();
        assert_eq!(parsed, info);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn read_from_path_returns_none_when_missing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("missing.json");
        assert!(read_from_path(&path).unwrap().is_none());
    }

    #[test]
    fn atomic_rename_overwrites_existing() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("daemon.json");
        let a = DaemonInfo::now(1, tmp.path().join("a"), 1, "a");
        write_to_path(&a, &path).unwrap();
        let b = DaemonInfo::now(2, tmp.path().join("b"), 2, "b");
        write_to_path(&b, &path).unwrap();
        let parsed = read_from_path(&path).unwrap().unwrap();
        assert_eq!(parsed.pid, 2);
        assert_eq!(parsed.version, "b");
    }
}
