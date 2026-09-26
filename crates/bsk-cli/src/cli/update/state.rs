//! What the most recent update attempt did, kept in `update-state.json` so a
//! failure stays diagnosable after the process that hit it has exited.
//!
//! Each attempt rewrites the record as it moves through its stages. A record
//! still `in_progress` long after it started therefore names the stage in
//! which that process stopped.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use fs2::FileExt;
use semver::Version;
use serde::{Deserialize, Serialize};

use super::now_epoch_secs;
use crate::daemon::paths;

/// How long a daemon waits before trying a version whose update failed again.
pub(crate) const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateSource {
    /// The daemon's periodic auto-update.
    Daemon,
    /// `bsk update`.
    Command,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateStage {
    /// Fetching and verifying the release archive.
    Download,
    /// Putting the new executable in place and running it once.
    Install,
    /// A running daemon handing over to one started from the new executable.
    Handover,
    /// `bsk update` restarting the daemon it stopped.
    Restart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateResult {
    InProgress,
    Succeeded,
    Failed,
    /// A newer version exists, but this installation cannot apply it itself.
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// The daemon belongs to a terminal or supervisor, which must restart it.
    HostManaged,
    /// The directory holding the executable does not accept new files.
    NotWritable,
}

/// What a failed attempt left behind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Recovery {
    /// The attempt failed before it changed anything.
    Unchanged,
    /// The previous executable is back in place. `daemon_serving` tells
    /// whether a daemon running the previous version kept or resumed serving.
    Restored { daemon_serving: bool },
    /// The previous executable could not be put back.
    RestoreFailed { action: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateRecord {
    pub source: UpdateSource,
    pub from_version: String,
    pub target_version: String,
    pub executable: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<UpdateStage>,
    pub result: UpdateResult,
    pub started_at_epoch_secs: u64,
    pub updated_at_epoch_secs: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<SkipReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<Recovery>,
    /// The previous executable, kept until the new version is confirmed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_executable: Option<PathBuf>,
    /// Earliest time a daemon tries this version again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_epoch_secs: Option<u64>,
    /// The daemon that answered once a handover or restart finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daemon_version: Option<String>,
}

impl UpdateRecord {
    pub(crate) fn start(source: UpdateSource, target_version: &Version, executable: &Path) -> Self {
        let now = now_epoch_secs();
        Self {
            source,
            from_version: env!("CARGO_PKG_VERSION").to_string(),
            target_version: target_version.to_string(),
            executable: executable.to_path_buf(),
            stage: Some(UpdateStage::Download),
            result: UpdateResult::InProgress,
            started_at_epoch_secs: now,
            updated_at_epoch_secs: now,
            error: None,
            skip_reason: None,
            recovery: None,
            previous_executable: None,
            retry_after_epoch_secs: None,
            daemon_pid: None,
            daemon_version: None,
        }
    }

    pub(crate) fn skipped(
        source: UpdateSource,
        target_version: &Version,
        executable: &Path,
        reason: SkipReason,
        error: Option<&anyhow::Error>,
    ) -> Self {
        Self {
            stage: None,
            result: UpdateResult::Skipped,
            skip_reason: Some(reason),
            error: error.map(|err| format!("{err:#}")),
            ..Self::start(source, target_version, executable)
        }
    }

    pub(crate) fn enter(&mut self, stage: UpdateStage) {
        self.stage = Some(stage);
        self.updated_at_epoch_secs = now_epoch_secs();
        self.save();
    }

    pub(crate) fn succeed(&mut self, daemon: Option<(u32, String)>) {
        self.result = UpdateResult::Succeeded;
        self.previous_executable = None;
        if let Some((pid, version)) = daemon {
            self.daemon_pid = Some(pid);
            self.daemon_version = Some(version);
        }
        self.updated_at_epoch_secs = now_epoch_secs();
        self.save();
    }

    /// Record a failure. Daemon attempts wait [`RETRY_AFTER_FAILURE`] before
    /// trying the same version again; `bsk update` retries when asked.
    pub(crate) fn fail(&mut self, error: &anyhow::Error, recovery: Recovery) {
        let now = now_epoch_secs();
        self.result = UpdateResult::Failed;
        self.error = Some(format!("{error:#}"));
        if !matches!(recovery, Recovery::RestoreFailed { .. }) {
            self.previous_executable = None;
        }
        self.recovery = Some(recovery);
        self.retry_after_epoch_secs = (self.source == UpdateSource::Daemon)
            .then(|| now.saturating_add(RETRY_AFTER_FAILURE.as_secs()));
        self.updated_at_epoch_secs = now;
        self.save();
    }

    /// When a daemon may next try `target`, if an earlier failure defers it.
    pub(crate) fn retry_blocked_until(&self, target: &Version, now: u64) -> Option<u64> {
        let retry_after = self.retry_after_epoch_secs?;
        (self.result == UpdateResult::Failed
            && self.target_version == target.to_string()
            && now < retry_after)
            .then_some(retry_after)
    }

    /// Whether this already records skipping `target` for `reason`.
    pub(crate) fn skips(&self, target: &Version, reason: SkipReason) -> bool {
        self.result == UpdateResult::Skipped
            && self.skip_reason == Some(reason)
            && self.target_version == target.to_string()
    }

    /// Best effort: an attempt must not fail because its diagnostics could
    /// not be written.
    pub(crate) fn save(&self) {
        let result = paths::update_state_path().and_then(|path| write(&path, self));
        if let Err(err) = result {
            tracing::warn!(error = %format_args!("{err:#}"), "could not record the update state");
        }
    }
}

pub fn read(path: &Path) -> Result<Option<UpdateRecord>> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .with_context(|| format!("parse {}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(anyhow::Error::from(err).context(format!("read {}", path.display()))),
    }
}

/// The recorded attempt, if one exists and can be read.
pub(crate) fn current() -> Option<UpdateRecord> {
    let path = paths::update_state_path().ok()?;
    match read(&path) {
        Ok(record) => record,
        Err(err) => {
            tracing::warn!(error = %format_args!("{err:#}"), "ignoring unreadable update state");
            None
        }
    }
}

pub fn write(path: &Path, record: &UpdateRecord) -> Result<()> {
    super::write_json_atomically(path, record)
}

/// Serializes update attempts that share a bsk home, so an automatic and a
/// manual update never swap the executable at the same time.
#[derive(Debug)]
pub(crate) struct UpdateLock(File);

impl UpdateLock {
    pub(crate) fn try_acquire() -> Result<Self> {
        paths::ensure_bsk_home()?;
        Self::try_acquire_at(&paths::update_lock_path()?)
    }

    fn try_acquire_at(path: &Path) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("open {}", path.display()))?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Self(file)),
            Err(err) if err.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                anyhow::bail!("another bsk update is in progress; retry once it finishes")
            }
            Err(err) => Err(anyhow::Error::new(err).context(format!("lock {}", path.display()))),
        }
    }
}

impl Drop for UpdateLock {
    fn drop(&mut self) {
        let _ = <File as FileExt>::unlock(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TARGET: Version = Version::new(0, 9, 0);

    #[test]
    fn records_round_trip_and_omit_empty_fields() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("update-state.json");
        let mut record = UpdateRecord::start(UpdateSource::Daemon, &TARGET, Path::new("/bin/bsk"));
        record.previous_executable = Some(PathBuf::from("/bin/.bsk.old-1-1"));
        write(&path, &record).unwrap();
        assert_eq!(read(&path).unwrap(), Some(record));

        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(json["result"], "in_progress");
        assert_eq!(json["stage"], "download");
        assert!(json.get("error").is_none());
        assert!(json.get("recovery").is_none());
        assert_eq!(read(&tmp.path().join("missing.json")).unwrap(), None);
    }

    #[test]
    fn recovery_serialises_with_a_state_tag() {
        for (recovery, expected) in [
            (
                Recovery::Unchanged,
                serde_json::json!({"state": "unchanged"}),
            ),
            (
                Recovery::Restored {
                    daemon_serving: true,
                },
                serde_json::json!({"state": "restored", "daemon_serving": true}),
            ),
            (
                Recovery::RestoreFailed {
                    action: "rename it".into(),
                },
                serde_json::json!({"state": "restore_failed", "action": "rename it"}),
            ),
        ] {
            assert_eq!(serde_json::to_value(&recovery).unwrap(), expected);
        }
    }

    #[test]
    fn only_a_failed_daemon_attempt_defers_the_same_version() {
        let exe = Path::new("bsk");
        let failed = |source| UpdateRecord {
            result: UpdateResult::Failed,
            retry_after_epoch_secs: (source == UpdateSource::Daemon).then_some(1_000),
            ..UpdateRecord::start(source, &TARGET, exe)
        };
        let daemon = failed(UpdateSource::Daemon);
        assert_eq!(daemon.retry_blocked_until(&TARGET, 999), Some(1_000));
        assert_eq!(daemon.retry_blocked_until(&TARGET, 1_000), None);
        assert_eq!(daemon.retry_blocked_until(&Version::new(0, 9, 1), 0), None);
        assert_eq!(
            failed(UpdateSource::Command).retry_blocked_until(&TARGET, 0),
            None
        );
        let succeeded = UpdateRecord {
            result: UpdateResult::Succeeded,
            ..daemon
        };
        assert_eq!(succeeded.retry_blocked_until(&TARGET, 0), None);
    }

    #[test]
    fn only_one_update_attempt_holds_the_lock_at_a_time() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("update.lock");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let attempts: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    let lock = UpdateLock::try_acquire_at(&path);
                    // Hold a winning lock until every attempt has run.
                    std::thread::sleep(Duration::from_millis(200));
                    lock.map(drop).map_err(|err| format!("{err:#}"))
                })
            })
            .collect();
        let results: Vec<_> = attempts.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        for err in results.iter().filter_map(|result| result.as_ref().err()) {
            assert!(err.contains("another bsk update is in progress"), "{err}");
        }
        UpdateLock::try_acquire_at(&path).expect("released after the winner finishes");
    }

    #[test]
    fn skip_records_name_their_version_and_reason() {
        let record = UpdateRecord::skipped(
            UpdateSource::Daemon,
            &TARGET,
            Path::new("bsk"),
            SkipReason::HostManaged,
            None,
        );
        assert!(record.skips(&TARGET, SkipReason::HostManaged));
        assert!(!record.skips(&TARGET, SkipReason::NotWritable));
        assert!(!record.skips(&Version::new(1, 0, 0), SkipReason::HostManaged));
        assert_eq!(record.stage, None);
    }
}
