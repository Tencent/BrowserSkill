//! File operations shared by installation and automatic synchronization.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use fs2::FileExt;
use tempfile::NamedTempFile;

/// All readers that may replace a skill hold this lock until their writes finish.
/// Keep the lock file in place: deleting it could let two processes lock different
/// files at the same path. Explicitly unlock on drop: a concurrently spawned
/// child may still hold an inherited handle until exec, delaying close-only release.
pub(super) struct SkillLock {
    _file: File,
}

impl Drop for SkillLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self._file);
    }
}

impl SkillLock {
    fn open(dir: &Path) -> io::Result<File> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(".bsk.lock"))
    }

    pub(super) fn acquire(dir: &Path) -> io::Result<Self> {
        let file = Self::open(dir)?;
        file.lock_exclusive()?;
        Ok(Self { _file: file })
    }

    /// Automatic sync is best-effort and must not wait on another installer.
    pub(super) fn try_acquire(dir: &Path) -> io::Result<Option<Self>> {
        let file = Self::open(dir)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Some(Self { _file: file })),
            Err(err) if err.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                Ok(None)
            }
            Err(err) => Err(err),
        }
    }
}

/// Prepare complete content before changing the destination. The unique sibling
/// temporary file is removed on error or drop, including a failed replacement.
pub(super) struct PendingWrite {
    file: NamedTempFile,
    dest: PathBuf,
}

impl PendingWrite {
    pub(super) fn prepare(dest: &Path, content: &str) -> Result<Self> {
        let mut file = tempfile::Builder::new()
            .prefix(".bsk-tmp-")
            .tempfile_in(dest.parent().context("skill destination has no parent")?)
            .with_context(|| format!("prepare {}", dest.display()))?;
        file.write_all(content.as_bytes())
            .with_context(|| format!("write temporary file for {}", dest.display()))?;
        Ok(Self {
            file,
            dest: dest.to_path_buf(),
        })
    }

    pub(super) fn commit(self) -> Result<()> {
        #[cfg(test)]
        test_support::before_replace(&self.dest)?;
        self.file
            .persist(&self.dest)
            .map_err(|err| err.error)
            .with_context(|| format!("replace {}", self.dest.display()))?;
        Ok(())
    }
}

#[cfg(test)]
pub(super) mod test_support {
    use super::*;
    use std::cell::RefCell;

    type ReplaceHook = Box<dyn Fn(&Path) -> io::Result<()>>;
    thread_local! {
        // Thread-local injection keeps failure and interleaving tests independent.
        static REPLACE_HOOK: RefCell<Option<ReplaceHook>> = RefCell::new(None);
    }

    pub(super) fn before_replace(dest: &Path) -> io::Result<()> {
        REPLACE_HOOK.with_borrow(|hook| match hook {
            Some(hook) => hook(dest),
            None => Ok(()),
        })
    }

    pub(crate) fn with_replace_hook<T>(
        hook: impl Fn(&Path) -> io::Result<()> + 'static,
        run: impl FnOnce() -> T,
    ) -> T {
        struct Reset(Option<ReplaceHook>);
        impl Drop for Reset {
            fn drop(&mut self) {
                REPLACE_HOOK.set(self.0.take());
            }
        }
        let _reset = Reset(REPLACE_HOOK.replace(Some(Box::new(hook))));
        run()
    }

    pub(crate) fn assert_no_temporary_files(dir: &Path) {
        for entry in std::fs::read_dir(dir).unwrap() {
            assert!(
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".bsk-tmp-")
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_atomic_replace_preserves_destination_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("SKILL.md");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("sentinel"), "keep").unwrap();
        assert!(
            PendingWrite::prepare(&dest, "new")
                .unwrap()
                .commit()
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("sentinel")).unwrap(),
            "keep"
        );
        test_support::assert_no_temporary_files(dir.path());
    }

    #[test]
    fn lock_is_shared_by_separate_handles_and_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let lock = SkillLock::acquire(dir.path()).unwrap();
        assert!(SkillLock::try_acquire(dir.path()).unwrap().is_none());
        drop(lock);
        assert!(dir.path().join(".bsk.lock").exists());
        assert!(SkillLock::try_acquire(dir.path()).unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn dropping_guard_releases_lock_with_a_duplicate_handle_alive() {
        let dir = tempfile::tempdir().unwrap();
        let lock = SkillLock::acquire(dir.path()).unwrap();
        // dup shares the open file description, as an inherited fd does between
        // fork and exec in a concurrently spawned child process.
        let duplicate = lock._file.try_clone().unwrap();
        assert!(SkillLock::try_acquire(dir.path()).unwrap().is_none());
        drop(lock);
        assert!(SkillLock::try_acquire(dir.path()).unwrap().is_some());
        drop(duplicate);
    }
}
