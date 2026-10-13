//! Locked JSON transactions with durable, private atomic replacement.

use anyhow::{Context, Result};
use fs2::FileExt;
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{Duration, Instant},
};

pub fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid authorization store")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(error) => Err(error.into()),
    }
}

pub fn transaction<T: Serialize + DeserializeOwned + Default, R>(
    path: &Path,
    write: bool,
    work: impl FnOnce(&mut T) -> Result<R>,
) -> Result<R> {
    if !write {
        return work(&mut read(path)?);
    }
    let parent = path.parent().context("authorization directory missing")?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(path.with_extension("lock"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        lock.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    let deadline = Instant::now() + Duration::from_millis(500);
    loop {
        match FileExt::try_lock_exclusive(&lock) {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(error).context("authorization store is busy");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.into()),
        }
    }
    let mut state = read(path)?;
    let result = work(&mut state)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(file.as_file_mut(), &state)?;
    file.as_file_mut().flush()?;
    file.as_file().sync_all()?;
    file.persist(path).map_err(|error| error.error)?;
    // Windows does not permit opening a directory this way. On Unix a failed
    // directory sync must not be mistaken for a durable commit.
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(result)
}
