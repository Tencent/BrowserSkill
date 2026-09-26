//! In-place replacement of a running Windows executable.
//!
//! Windows refuses to overwrite or delete an executable while a process runs
//! it, but the loader opens images with delete sharing, so the file can be
//! renamed. The running image is moved aside and the new binary takes its
//! path; processes keep running the old image, and every later launch uses
//! the new one. Moved-aside images are deleted once nothing runs them.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
};

use crate::daemon::lockfile;

/// How long to keep retrying a rename that a scanner or indexer briefly blocks.
const RETRY_WINDOW: Duration = Duration::from_secs(5);
const RETRY_DELAY: Duration = Duration::from_millis(50);

/// Files of the former script-based updater are only removed once its helper
/// has certainly finished with them.
const LEGACY_HELPER_GRACE: Duration = Duration::from_secs(60 * 60);
/// Upper bound for a legacy helper report copied into the daemon log.
const LEGACY_REPORT_LIMIT: usize = 4096;

pub(super) fn replace(target: &Path, binary: &[u8]) -> Result<()> {
    replace_within(target, binary, RETRY_WINDOW)
}

fn replace_within(target: &Path, binary: &[u8], window: Duration) -> Result<()> {
    remove_leftovers(target);
    let staged = sibling(target, &format!("new-{}", unique_suffix()))?;
    super::write_synced(&staged, binary)?;
    let installed = install(target, &staged, window);
    if installed.is_err() {
        let _ = fs::remove_file(&staged);
    }
    installed
}

/// Swap `staged` into `target`, restoring the original if the swap fails.
fn install(target: &Path, staged: &Path, window: Duration) -> Result<()> {
    let aside = sibling(target, &format!("old-{}", unique_suffix()))?;
    retry(window, || fs::rename(target, &aside))
        .with_context(|| format!("move {} aside", target.display()))?;
    let Err(err) = retry(window, || fs::rename(staged, target)) else {
        return Ok(());
    };
    match retry(window, || fs::rename(&aside, target)) {
        Ok(()) => Err(err).with_context(|| format!("install new {}", target.display())),
        Err(restore) => Err(err).with_context(|| {
            format!(
                "install new {target}; restoring the previous executable also failed ({restore}), \
                 rename {aside} to {target} to recover",
                target = target.display(),
                aside = aside.display(),
            )
        }),
    }
}

/// Best-effort removal of what earlier updates left next to `target`:
/// moved-aside images no process runs any more, binaries staged by updaters
/// that have exited, and files of the former script-based updater.
pub(crate) fn remove_leftovers(target: &Path) {
    let (Some(dir), Some(name)) = (
        target.parent(),
        target.file_name().and_then(|name| name.to_str()),
    ) else {
        return;
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let aside = format!(".{name}.old-");
    let staged = format!(".{name}.new-");
    let legacy = format!("{name}.update-");
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let path = entry.path();
        if file_name.starts_with(&aside) {
            // Deleting an image that is still running fails and is retried later.
            let _ = fs::remove_file(&path);
        } else if let Some(suffix) = file_name.strip_prefix(&staged) {
            if staging_process(suffix).is_some_and(|pid| !lockfile::pid_alive(pid)) {
                let _ = fs::remove_file(&path);
            }
        } else if file_name.starts_with(&legacy) && older_than(&entry, LEGACY_HELPER_GRACE) {
            if file_name.ends_with(".log") {
                report_legacy_helper(&path);
            }
            let _ = fs::remove_file(&path);
        }
    }
}

/// The former updater only logged next to the executable; surface its last
/// report in the daemon log before removing it.
fn report_legacy_helper(path: &Path) {
    let Ok(bytes) = fs::read(path) else {
        return;
    };
    let report = String::from_utf8_lossy(&bytes[..bytes.len().min(LEGACY_REPORT_LIMIT)]);
    let report = report.trim();
    if !report.is_empty() {
        tracing::warn!(path = %path.display(), report, "previous update helper left a report");
    }
}

fn sibling(target: &Path, suffix: &str) -> Result<PathBuf> {
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .context("target path must have a UTF-8 file name")?;
    Ok(target.with_file_name(format!(".{name}.{suffix}")))
}

/// `<pid>-<nanos>`: unique per attempt, and names the process that owns it.
fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{}-{nanos}", std::process::id())
}

fn staging_process(suffix: &str) -> Option<u32> {
    suffix.split_once('-')?.0.parse().ok()
}

fn older_than(entry: &fs::DirEntry, age: Duration) -> bool {
    entry
        .metadata()
        .and_then(|metadata| metadata.modified())
        .is_ok_and(|modified| modified.elapsed().is_ok_and(|elapsed| elapsed >= age))
}

fn retry(window: Duration, mut op: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let deadline = Instant::now() + window;
    loop {
        match op() {
            Err(err) if is_transient(&err) && Instant::now() < deadline => {
                std::thread::sleep(RETRY_DELAY);
            }
            result => return result,
        }
    }
}

/// Scanners and indexers open fresh files without delete sharing for a moment.
fn is_transient(err: &io::Error) -> bool {
    err.raw_os_error().is_some_and(|code| {
        [ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION]
            .contains(&(code as u32))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    #[ignore = "subprocess entry point"]
    fn idle_process() {
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn replaces_a_running_executable() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("中文 space %PATH% ! & (update)");
        fs::create_dir(&dir).unwrap();
        let target = dir.join("bsk.exe");
        fs::copy(std::env::current_exe().unwrap(), &target).unwrap();
        let mut running = std::process::Command::new(&target)
            .args(["--exact", "cli::update::windows::tests::idle_process", "--ignored"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();

        let replaced = replace(&target, b"new binary");
        let still_running = running.try_wait().unwrap().is_none();
        let _ = running.kill();
        let _ = running.wait();

        replaced.unwrap();
        assert!(still_running, "replacement must not disturb the running process");
        assert_eq!(fs::read(&target).unwrap(), b"new binary");
        // The exited image is released asynchronously; scanners may also hold it briefly.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            remove_leftovers(&target);
            let listed = names(&dir);
            if listed == ["bsk.exe"] {
                break;
            }
            assert!(Instant::now() < deadline, "leftovers remain: {listed:?}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn replaces_in_unicode_space_and_shell_symbol_paths() {
        let tmp = tempfile::TempDir::new().unwrap();
        for name in ["ascii", "with space", "中文目录", "literal %PATH% ! & (folder)"] {
            let dir = tmp.path().join(name);
            fs::create_dir(&dir).unwrap();
            let target = dir.join("bsk.exe");
            fs::write(&target, b"old binary").unwrap();

            replace(&target, b"new binary").unwrap();

            assert_eq!(fs::read(&target).unwrap(), b"new binary", "{name}");
            let listed = names(&dir);
            assert_eq!(listed.len(), 2, "{name}: {listed:?}");
            assert!(listed[0].starts_with(".bsk.exe.old-"), "{name}: {listed:?}");
            remove_leftovers(&target);
            assert_eq!(names(&dir), ["bsk.exe"], "{name}");
        }
    }

    #[test]
    fn keeps_the_original_when_it_cannot_be_moved() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("bsk.exe");
        fs::write(&target, b"old binary").unwrap();
        // Without delete sharing the file cannot be renamed.
        let _lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&target)
            .unwrap();

        let error = replace_within(&target, b"new binary", Duration::from_millis(200)).unwrap_err();

        assert!(format!("{error:#}").contains("aside"), "{error:#}");
        assert_eq!(fs::read(&target).unwrap(), b"old binary");
        assert_eq!(names(tmp.path()), ["bsk.exe"]);
    }

    #[test]
    fn retries_while_the_original_is_briefly_locked() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("bsk.exe");
        fs::write(&target, b"old binary").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&target)
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            drop(lock);
        });

        replace(&target, b"new binary").unwrap();

        release.join().unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new binary");
    }

    #[test]
    fn removes_only_leftovers_that_are_no_longer_in_use() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("bsk.exe");
        fs::write(&target, b"current").unwrap();
        let path = |name: &str| tmp.path().join(name);
        let live_staging = format!(".bsk.exe.new-{}-1", std::process::id());
        for name in [
            ".bsk.exe.old-1-1",
            ".bsk.exe.new-4294967295-1",
            live_staging.as_str(),
            "bsk.exe.update-7.cmd",
            "bsk.exe.update-7.log",
            "bsk.exe.update-8.log",
            "other.exe.old",
        ] {
            fs::write(path(name), b"leftover").unwrap();
        }
        let expired = SystemTime::now() - LEGACY_HELPER_GRACE - Duration::from_secs(60);
        for name in ["bsk.exe.update-7.cmd", "bsk.exe.update-7.log"] {
            fs::File::options()
                .write(true)
                .open(path(name))
                .unwrap()
                .set_modified(expired)
                .unwrap();
        }

        remove_leftovers(&target);

        let mut expected = vec![
            live_staging,
            "bsk.exe".to_string(),
            "bsk.exe.update-8.log".to_string(),
            "other.exe.old".to_string(),
        ];
        expected.sort();
        assert_eq!(names(tmp.path()), expected);
    }
}
