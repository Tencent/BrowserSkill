use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{
    io::Write,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

pub(crate) struct SavedReply {
    pending: NamedTempFile,
    destination: PathBuf,
}
impl SavedReply {
    pub(crate) fn prepare(path: &Path) -> Result<Self> {
        match std::fs::symlink_metadata(path) {
            Ok(_) => anyhow::bail!("output already exists: {}", path.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).context("check full observation output"),
        }
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        ensure!(
            parent.is_dir(),
            "output parent does not exist: {}",
            parent.display()
        );
        Ok(Self {
            pending: NamedTempFile::new_in(parent).context("stage full observation")?,
            destination: path.into(),
        })
    }
    pub(crate) fn finish(mut self, reply: &Value) -> Result<()> {
        serde_json::to_writer_pretty(self.pending.as_file_mut(), reply)
            .context("write full observation")?;
        self.pending.write_all(b"\n")?;
        self.pending.as_file_mut().sync_all()?;
        self.pending
            .persist_noclobber(&self.destination)
            .map_err(|e| e.error)
            .context("publish full observation without overwriting")?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsuccessful_capture_leaves_no_destination_or_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.json");
        {
            let _pending = SavedReply::prepare(&path).unwrap();
            assert!(!path.exists());
        }
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        SavedReply::prepare(&path)
            .unwrap()
            .finish(&serde_json::json!({"context_id":"fresh"}))
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap()["context_id"],
            "fresh"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn concurrent_writer_and_existing_files_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.json");
        let pending = SavedReply::prepare(&path).unwrap();
        std::fs::write(&path, "other writer").unwrap();
        assert!(pending.finish(&serde_json::json!({"new":true})).is_err());
        assert!(SavedReply::prepare(&path).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "other writer");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
