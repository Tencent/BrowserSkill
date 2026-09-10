//! Atomic visibility boundary for files received into a same-directory temp.

use std::path::Path;

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
}
