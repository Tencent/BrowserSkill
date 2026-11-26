//! Atomic visibility boundary for files received into a same-directory temp.

use std::path::Path;

use crate::cli::error::CliError;

/// Reject a destination that cannot receive an output file before the command
/// pays for a capture or a daemon round trip. Only the target path shape and
/// containing directory are checked: whether an existing regular file may be
/// replaced is the command's own `--overwrite` decision.
pub(crate) fn preflight_destination(out: &Path) -> Result<(), CliError> {
    preflight_destination_with_hint(
        out,
        "choose an --out file path inside an existing directory",
    )
}

pub(super) fn preflight_destination_with_hint(out: &Path, hint: &str) -> Result<(), CliError> {
    let reject = |error: std::io::Error| CliError::file_validation(error.into(), hint);
    if out.as_os_str().is_empty() {
        return Err(reject(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "output path is empty",
        )));
    }
    let trailing_sep = out
        .as_os_str()
        .as_encoded_bytes()
        .last()
        .is_some_and(|&byte| byte == b'/' || (cfg!(windows) && byte == b'\\'));
    if trailing_sep
        || out.file_name().is_none()
        || std::fs::metadata(out).is_ok_and(|metadata| metadata.is_dir())
    {
        return Err(reject(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("output path is a directory, not a file: {}", out.display()),
        )));
    }
    let parent = out
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    match std::fs::metadata(parent) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(reject(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("output path is not a directory: {}", parent.display()),
        ))),
        Err(error) => Err(reject(std::io::Error::new(
            error.kind(),
            format!(
                "output directory is not usable: {}: {error}",
                parent.display()
            ),
        ))),
    }
}

pub fn commit(temp: &Path, out: &Path, overwrite: bool) -> std::io::Result<()> {
    if !overwrite {
        std::fs::hard_link(temp, out)?;
        std::fs::remove_file(temp)?;
        return Ok(());
    }
    replace(temp, out)
}

#[cfg(unix)]
fn replace(temp: &Path, out: &Path) -> std::io::Result<()> {
    // POSIX rename replaces an existing non-directory destination atomically.
    std::fs::rename(temp, out)
}

#[cfg(windows)]
fn replace(temp: &Path, out: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = out.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both buffers are NUL-terminated and remain alive for the call.
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
fn replace(temp: &Path, out: &Path) -> std::io::Result<()> {
    std::fs::rename(temp, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_replace_never_overwrites_existing_output() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join("new.part");
        let out = dir.path().join("out.bin");
        std::fs::write(&temp, b"new").unwrap();
        std::fs::write(&out, b"old").unwrap();
        assert!(commit(&temp, &out, false).is_err());
        assert_eq!(std::fs::read(&out).unwrap(), b"old");
    }

    #[test]
    fn overwrite_replaces_existing_output_without_predelete() {
        let dir = tempfile::tempdir().unwrap();
        let temp = dir.path().join("new.part");
        let out = dir.path().join("out.bin");
        std::fs::write(&temp, b"new").unwrap();
        std::fs::write(&out, b"old").unwrap();
        commit(&temp, &out, true).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"new");
        assert!(!temp.exists());
    }

    #[test]
    fn preflight_accepts_an_existing_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        preflight_destination(&dir.path().join("shot.png")).unwrap();
        // A bare relative file name resolves against the current directory.
        preflight_destination(Path::new("shot.png")).unwrap();
    }

    #[test]
    fn preflight_rejects_a_missing_parent_directory() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("no-such-dir").join("shot.png");
        let error = preflight_destination(&out).unwrap_err();
        assert_eq!(error.exit_code(), 1);
        assert_eq!(error.code(), Some(bsk_protocol::ErrorCode::NotFound));
        assert!(format!("{error:#}").contains("no-such-dir"));
    }

    #[test]
    fn preflight_rejects_an_empty_destination() {
        let error = preflight_destination(Path::new("")).unwrap_err();
        assert_eq!(error.exit_code(), 1);
        assert_eq!(error.code(), Some(bsk_protocol::ErrorCode::InvalidParams));
        assert!(format!("{error:#}").contains("output path is empty"));
    }

    #[test]
    fn preflight_rejects_a_parent_that_is_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file.bin");
        std::fs::write(&file, b"x").unwrap();
        let error = preflight_destination(&file.join("shot.png")).unwrap_err();
        assert_eq!(error.exit_code(), 1);
        assert_eq!(error.code(), Some(bsk_protocol::ErrorCode::InvalidParams));
    }

    #[test]
    fn preflight_rejects_a_directory_or_trailing_separator_destination() {
        let dir = tempfile::tempdir().unwrap();
        let trailing_missing = format!("{}/", dir.path().join("no-such-dir").display());
        let trailing_existing = format!("{}/", dir.path().display());
        for candidate in [
            dir.path().to_path_buf(),
            Path::new(".").to_path_buf(),
            Path::new(trailing_missing.as_str()).to_path_buf(),
            Path::new(trailing_existing.as_str()).to_path_buf(),
        ] {
            let error = preflight_destination(&candidate).unwrap_err();
            assert_eq!(error.exit_code(), 1, "{}", candidate.display());
            assert_eq!(
                error.code(),
                Some(bsk_protocol::ErrorCode::InvalidParams),
                "{}",
                candidate.display()
            );
            assert!(
                format!("{error:#}").contains("output path is a directory"),
                "{}: {error:#}",
                candidate.display()
            );
        }
    }
}
