//! Durable, private atomic replacement. Callers serialize writes with the
//! daemon lifecycle lock and their in-process state mutex.

use anyhow::{Context, Result};
use serde::{Serialize, de::DeserializeOwned};
use std::{fs, io::Write, path::Path};

pub fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid authorization store")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.into()),
    }
}

pub fn write<T: Serialize>(path: &Path, state: &T) -> Result<()> {
    let parent = path.parent().context("authorization directory missing")?;
    // NamedTempFile creates a private (0600 on Unix) file in the same directory.
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(file.as_file_mut(), state)?;
    file.as_file_mut().flush()?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    // Windows does not permit opening a directory this way. On Unix a failed
    // directory sync must not be mistaken for a durable commit.
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
