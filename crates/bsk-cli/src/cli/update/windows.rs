//! In-place replacement of a running Windows executable.
//!
//! Windows refuses to overwrite or delete an executable while a process runs
//! it, but the loader opens images with delete sharing, so the file can be
//! renamed. The running image is moved aside and the new binary takes its
//! path; processes keep running the old image, and every later launch uses
//! the new one. The moved-aside image is the previous executable an update
//! restores on failure, and is deleted once nothing runs it.
//!
//! This relies on the file system honouring renames of open images, which
//! NTFS does. Elsewhere the first rename fails and the executable is left as
//! it was.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
};

use super::{PreviousNotRestored, sibling, unique_suffix};

/// How long to keep retrying a rename that a scanner or indexer briefly blocks.
const RETRY_WINDOW: Duration = Duration::from_secs(5);
const RETRY_DELAY: Duration = Duration::from_millis(50);

/// Files of the former script-based updater are only removed once its helper
/// has certainly finished with them.
const LEGACY_HELPER_GRACE: Duration = Duration::from_secs(60 * 60);
/// Upper bound for a legacy helper report copied into the daemon log.
const LEGACY_REPORT_LIMIT: usize = 4096;

/// Returns where the previous executable now lives.
pub(super) fn replace(target: &Path, binary: &[u8]) -> Result<PathBuf> {
    super::remove_update_leftovers(target);
    let staged = sibling(target, &format!("new-{}", unique_suffix()))?;
    super::write_synced(&staged, binary)?;
    let installed = install(target, &staged, RETRY_WINDOW, &mut |from, to| {
        fs::rename(from, to)
    });
    if installed.is_err() {
        let _ = fs::remove_file(&staged);
    }
    installed
}

/// Swap `staged` into `target`, putting the original back if that fails.
fn install(
    target: &Path,
    staged: &Path,
    window: Duration,
    rename: &mut dyn FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<PathBuf> {
    let previous = sibling(target, &format!("old-{}", unique_suffix()))?;
    retry(window, || rename(target, &previous))
        .with_context(|| format!("move {} aside", target.display()))?;
    let Err(err) = retry(window, || rename(staged, target)) else {
        return Ok(previous);
    };
    let err = anyhow::Error::new(err).context(format!("install new {}", target.display()));
    match retry(window, || rename(&previous, target)) {
        Ok(()) => Err(err),
        Err(restore) => {
            Err(err
                .context(format!("restore failed: {restore}"))
                .context(PreviousNotRestored {
                    previous,
                    target: target.to_path_buf(),
                }))
        }
    }
}

/// Put `previous` back at `target`. The rejected executable is deleted when
/// nothing runs it, and otherwise left for a later cleanup.
pub(super) fn restore(target: &Path, previous: &Path) -> Result<()> {
    restore_with(target, previous, RETRY_WINDOW, &mut |from, to| {
        fs::rename(from, to)
    })
}

fn restore_with(
    target: &Path,
    previous: &Path,
    window: Duration,
    rename: &mut dyn FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<()> {
    let not_restored = || PreviousNotRestored {
        previous: previous.to_path_buf(),
        target: target.to_path_buf(),
    };
    let rejected = sibling(target, &format!("old-{}", unique_suffix()))?;
    let moved = match retry(window, || rename(target, &rejected)) {
        Ok(()) => true,
        Err(err) if err.kind() == io::ErrorKind::NotFound => false,
        Err(err) => {
            return Err(anyhow::Error::new(err)
                .context(format!("move rejected {} aside", target.display()))
                .context(not_restored()));
        }
    };
    if let Err(err) = retry(window, || rename(previous, target)) {
        // Keep an executable at the path rather than none.
        if moved {
            let _ = retry(window, || rename(&rejected, target));
        }
        return Err(anyhow::Error::new(err).context(not_restored()));
    }
    if moved {
        let _ = fs::remove_file(&rejected);
    }
    Ok(())
}

/// Whether `entry` is a file of the former script-based updater, and if so
/// whether it is old enough to remove.
pub(super) fn legacy_helper_file(entry: &fs::DirEntry, name: &str) -> Option<bool> {
    let file_name = entry.file_name();
    let file_name = file_name.to_str()?;
    file_name
        .starts_with(&format!("{name}.update-"))
        .then(|| older_than(entry, LEGACY_HELPER_GRACE))
}

/// The former updater only logged next to the executable; surface its last
/// report in the daemon log before the file is removed.
pub(super) fn report_legacy_helper(path: &Path) {
    if path.extension().is_none_or(|ext| ext != "log") {
        return;
    }
    let Ok(bytes) = fs::read(path) else {
        return;
    };
    let report = String::from_utf8_lossy(&bytes[..bytes.len().min(LEGACY_REPORT_LIMIT)]);
    let report = report.trim();
    if !report.is_empty() {
        tracing::warn!(path = %path.display(), report, "previous update helper left a report");
    }
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
        [
            ERROR_ACCESS_DENIED,
            ERROR_SHARING_VIOLATION,
            ERROR_LOCK_VIOLATION,
        ]
        .contains(&(code as u32))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::update::{Installed, remove_update_leftovers};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::process::CommandExt;
    use std::time::SystemTime;
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

    /// Renames where exactly the listed calls fail, counting from 1.
    fn failing_calls(failing: &'static [usize]) -> impl FnMut(&Path, &Path) -> io::Result<()> {
        let mut calls = 0;
        move |from, to| {
            calls += 1;
            if failing.contains(&calls) {
                Err(io::Error::from(io::ErrorKind::InvalidInput))
            } else {
                fs::rename(from, to)
            }
        }
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("bsk.exe");
        let staged = tmp.path().join(".bsk.exe.new-1-1");
        fs::write(&target, b"old binary").unwrap();
        fs::write(&staged, b"new binary").unwrap();
        (tmp, target, staged)
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
            .args([
                "--exact",
                "cli::update::windows::tests::idle_process",
                "--ignored",
            ])
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

        let previous = replaced.unwrap();
        assert!(
            still_running,
            "replacement must not disturb the running process"
        );
        assert_eq!(fs::read(&target).unwrap(), b"new binary");
        assert!(previous.exists(), "the previous executable is kept");
        // The exited image is released asynchronously; scanners may also hold it briefly.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            // This process made the backup, so only an explicit discard removes it.
            let _ = fs::remove_file(&previous);
            let listed = names(&dir);
            if listed == ["bsk.exe"] {
                break;
            }
            assert!(Instant::now() < deadline, "leftovers remain: {listed:?}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn restores_the_previous_executable_of_a_running_process() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("bsk.exe");
        fs::copy(std::env::current_exe().unwrap(), &target).unwrap();
        let original = fs::read(&target).unwrap();
        let mut running = std::process::Command::new(&target)
            .args([
                "--exact",
                "cli::update::windows::tests::idle_process",
                "--ignored",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .unwrap();

        let previous = replace(&target, b"new binary").unwrap();
        let restored = restore(&target, &previous);
        let _ = running.kill();
        let _ = running.wait();

        restored.unwrap();
        assert_eq!(fs::read(&target).unwrap(), original);
        assert!(!previous.exists());
    }

    #[test]
    fn replaces_in_unicode_space_and_shell_symbol_paths() {
        let tmp = tempfile::TempDir::new().unwrap();
        for name in [
            "ascii",
            "with space",
            "中文目录",
            "literal %PATH% ! & (folder)",
        ] {
            let dir = tmp.path().join(name);
            fs::create_dir(&dir).unwrap();
            let target = dir.join("bsk.exe");
            fs::write(&target, b"old binary").unwrap();

            let previous = replace(&target, b"new binary").unwrap();

            assert_eq!(fs::read(&target).unwrap(), b"new binary", "{name}");
            assert_eq!(fs::read(&previous).unwrap(), b"old binary", "{name}");
            let listed = names(&dir);
            assert_eq!(listed.len(), 2, "{name}: {listed:?}");
            assert!(listed[0].starts_with(".bsk.exe.old-"), "{name}: {listed:?}");
            // This process owns the previous executable until it exits.
            remove_update_leftovers(&target);
            assert_eq!(names(&dir).len(), 2, "{name}");
            Installed {
                target: target.clone(),
                previous,
            }
            .discard();
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
        let staged = tmp.path().join(".bsk.exe.new-1-1");
        fs::write(&staged, b"new binary").unwrap();

        let error = install(&target, &staged, Duration::from_millis(200), &mut |a, b| {
            fs::rename(a, b)
        })
        .unwrap_err();

        assert!(format!("{error:#}").contains("aside"), "{error:#}");
        assert!(error.downcast_ref::<PreviousNotRestored>().is_none());
        assert_eq!(fs::read(&target).unwrap(), b"old binary");
    }

    #[test]
    fn puts_the_original_back_when_the_new_binary_cannot_take_its_place() {
        let (_tmp, target, staged) = fixture();

        // Call 2 moves the new binary in.
        let error =
            install(&target, &staged, Duration::ZERO, &mut failing_calls(&[2])).unwrap_err();

        assert!(format!("{error:#}").contains("install new"), "{error:#}");
        assert!(error.downcast_ref::<PreviousNotRestored>().is_none());
        assert_eq!(fs::read(&target).unwrap(), b"old binary");
        assert_eq!(fs::read(&staged).unwrap(), b"new binary");
    }

    #[test]
    fn names_the_manual_step_when_the_original_cannot_be_put_back() {
        let (_tmp, target, staged) = fixture();

        // Call 3 would move the original back.
        let error = install(
            &target,
            &staged,
            Duration::ZERO,
            &mut failing_calls(&[2, 3]),
        )
        .unwrap_err();

        let missing = error
            .downcast_ref::<PreviousNotRestored>()
            .unwrap_or_else(|| panic!("{error:#}"));
        assert_eq!(missing.target, target);
        assert!(!target.exists());
        assert_eq!(fs::read(&missing.previous).unwrap(), b"old binary");
        let action = missing.action();
        assert!(
            action.contains(&missing.previous.display().to_string()),
            "{action}"
        );
        assert!(action.contains(&target.display().to_string()), "{action}");
    }

    #[test]
    fn restore_keeps_an_executable_at_the_path_when_it_fails() {
        let (tmp, target, _staged) = fixture();
        let previous = tmp.path().join(".bsk.exe.old-1-1");
        fs::write(&previous, b"previous binary").unwrap();

        // Call 2 moves the previous executable back.
        let error =
            restore_with(&target, &previous, Duration::ZERO, &mut failing_calls(&[2])).unwrap_err();

        assert!(error.downcast_ref::<PreviousNotRestored>().is_some());
        assert_eq!(fs::read(&target).unwrap(), b"old binary");
        assert_eq!(fs::read(&previous).unwrap(), b"previous binary");
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
    fn concurrent_replacements_leave_one_intact_executable() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("bsk.exe");
        fs::write(&target, b"old binary").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let binaries: Vec<Vec<u8>> = (0..4).map(|i| format!("new binary {i}").into()).collect();
        let workers: Vec<_> = binaries
            .iter()
            .cloned()
            .map(|binary| {
                let target = target.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    replace(&target, &binary).is_ok()
                })
            })
            .collect();
        let succeeded = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(|ok| *ok)
            .count();

        assert!(succeeded >= 1);
        let installed = fs::read(&target).unwrap();
        assert!(binaries.contains(&installed), "{installed:?}");
        let staged: Vec<_> = names(tmp.path())
            .into_iter()
            .filter(|name| name.starts_with(".bsk.exe.new-"))
            .collect();
        assert!(staged.is_empty(), "{staged:?}");
    }

    #[test]
    fn removes_only_leftovers_that_are_no_longer_in_use() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("bsk.exe");
        fs::write(&target, b"current").unwrap();
        let path = |name: &str| tmp.path().join(name);
        let own = std::process::id();
        let live_previous = format!(".bsk.exe.old-{own}-1");
        let live_staging = format!(".bsk.exe.new-{own}-1");
        for name in [
            ".bsk.exe.old-4294967295-1",
            live_previous.as_str(),
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

        remove_update_leftovers(&target);

        let mut expected = vec![
            live_previous,
            live_staging,
            "bsk.exe".to_string(),
            "bsk.exe.update-8.log".to_string(),
            "other.exe.old".to_string(),
        ];
        expected.sort();
        assert_eq!(names(tmp.path()), expected);
    }
}
