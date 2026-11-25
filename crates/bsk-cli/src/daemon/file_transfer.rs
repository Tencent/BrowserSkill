//! Session-scoped, content-transparent staging for upload/download tools.
//!
//! The registry deliberately exposes no arbitrary-path operations. Upload
//! bytes arrive from the invoking CLI in bounded chunks; browser downloads
//! land in a daemon-minted directory and are read back by the invoking CLI.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use bsk_protocol::tools::{
    TransferBeginParams, TransferBeginResult, TransferChunkParams, TransferChunkResult,
    TransferIdParams, TransferReadParams, TransferReadyResult, TransferReleaseResult,
};
use bsk_protocol::{ErrorCode, RpcError};
use uuid::Uuid;

use super::paths;

pub const TRANSFER_CHUNK_SIZE: u32 = 512 * 1024;
pub const MAX_TRANSFER_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_UPLOAD_FILES: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Upload,
    Download,
}

#[derive(Debug)]
struct Entry {
    session_id: String,
    direction: Direction,
    dir: PathBuf,
    path: PathBuf,
    expected_size: Option<u64>,
    written: u64,
    ready: bool,
    busy: bool,
    readers: usize,
    released: bool,
}

/// Browser download path after the daemon has verified that it belongs to
/// the capability minted for this transfer. From this point onward the daemon
/// owns cleanup on every error path; unvalidated arbitrary paths are never
/// removed.
#[derive(Debug)]
struct ValidatedBrowserFile {
    path: PathBuf,
    parent: PathBuf,
    cleanup_armed: bool,
}

impl ValidatedBrowserFile {
    fn validate(reported_path: &Path, transfer_id: &str) -> Result<Self, RpcError> {
        if !reported_path.is_absolute() {
            return Err(permission(
                "download path is outside its browser capability",
            ));
        }
        let expected_parent = Path::new("BrowserSkill").join(transfer_id);
        let parent = reported_path
            .parent()
            .ok_or_else(|| permission("download path has no parent directory"))?;
        if !parent.ends_with(&expected_parent) {
            return Err(permission(
                "download escaped its browser capability directory",
            ));
        }
        for path in [reported_path, parent] {
            if fs::symlink_metadata(path)
                .map_err(io_error)?
                .file_type()
                .is_symlink()
            {
                return Err(permission("download capability path contains a symlink"));
            }
        }
        Ok(Self {
            path: reported_path.to_path_buf(),
            parent: parent.to_path_buf(),
            cleanup_armed: true,
        })
    }

    fn remove_source(mut self) -> std::io::Result<()> {
        self.cleanup_armed = false;
        let file_res = remove_if_present(&self.path);
        let dir_res = remove_dir_if_present(&self.parent);
        file_res.and(dir_res)
    }
}

impl Drop for ValidatedBrowserFile {
    fn drop(&mut self) {
        if !self.cleanup_armed {
            return;
        }
        let _ = remove_if_present(&self.path);
        let _ = remove_dir_if_present(&self.parent);
    }
}

#[derive(Debug)]
pub struct DownloadStaging {
    pub transfer_id: String,
    pub browser_relative_dir: String,
    pub max_byte_size: u64,
}

#[derive(Debug)]
pub struct TransferRegistry {
    root: PathBuf,
    initialized: Mutex<bool>,
    entries: Mutex<HashMap<String, Entry>>,
}

impl TransferRegistry {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            root: paths::bsk_home()?.join("run").join("transfers"),
            initialized: Mutex::new(false),
            entries: Mutex::new(HashMap::new()),
        })
    }

    pub(super) fn at_root(root: PathBuf) -> anyhow::Result<Self> {
        let registry = Self {
            root,
            initialized: Mutex::new(false),
            entries: Mutex::new(HashMap::new()),
        };
        registry.ensure_root()?;
        Ok(registry)
    }

    pub fn initialize(&self) -> anyhow::Result<()> {
        self.ensure_root()
    }

    fn ensure_root(&self) -> anyhow::Result<()> {
        let mut initialized = self.initialized.lock().unwrap();
        if *initialized {
            return Ok(());
        }
        if self.root.exists() {
            // Transfers never survive a daemon; removing stale directories on
            // startup gives crash cleanup without a second persistence model.
            let _ = fs::remove_dir_all(&self.root);
        }
        fs::create_dir_all(&self.root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))?;
        }
        *initialized = true;
        Ok(())
    }

    pub fn begin_upload(&self, p: TransferBeginParams) -> Result<TransferBeginResult, RpcError> {
        self.ensure_root()
            .map_err(|err| protocol_error(err.to_string()))?;
        let basename = safe_upload_basename(&p.name)?.to_owned();
        if p.byte_size > MAX_TRANSFER_BYTES {
            return Err(invalid(format!(
                "file size {} exceeds transfer limit {}",
                p.byte_size, MAX_TRANSFER_BYTES
            )));
        }
        let id = new_id();
        let dir = self.root.join(&id);
        let path = dir.join(basename);
        {
            let mut entries = self.entries.lock().unwrap();
            let session_bytes = session_bytes_locked(&entries, &p.session_id, None);
            if session_bytes.saturating_add(p.byte_size) > MAX_TRANSFER_BYTES {
                return Err(invalid(format!(
                    "session transfer staging exceeds limit {}",
                    MAX_TRANSFER_BYTES
                )));
            }
            entries.insert(
                id.clone(),
                Entry {
                    session_id: p.session_id,
                    direction: Direction::Upload,
                    dir: dir.clone(),
                    path: path.clone(),
                    expected_size: Some(p.byte_size),
                    written: 0,
                    ready: false,
                    busy: true,
                    readers: 0,
                    released: false,
                },
            );
        }

        let create_res = (|| -> Result<(), RpcError> {
            fs::create_dir(&dir).map_err(io_error)?;
            set_private_dir(&dir).map_err(io_error)?;
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(io_error)?;
            set_private_file(&file).map_err(io_error)?;
            Ok(())
        })();

        let cleanup_dir = {
            let mut entries = self.entries.lock().unwrap();
            match (&create_res, entries.get_mut(&id)) {
                (Ok(()), Some(entry)) if !entry.released => {
                    entry.busy = false;
                    false
                }
                _ => {
                    entries.remove(&id);
                    true
                }
            }
        };
        if cleanup_dir {
            let _ = fs::remove_dir_all(&dir);
            create_res?;
            return Err(not_found("transfer not found"));
        }
        Ok(TransferBeginResult {
            transfer_id: id,
            chunk_size: TRANSFER_CHUNK_SIZE,
        })
    }

    pub fn write_chunk(&self, p: TransferChunkParams) -> Result<TransferChunkResult, RpcError> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(p.data_base64)
            .map_err(|e| invalid(format!("invalid transfer chunk: {e}")))?;
        if bytes.len() > TRANSFER_CHUNK_SIZE as usize {
            return Err(invalid("transfer chunk exceeds negotiated size"));
        }
        let (path, dir, next) = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries
                .get_mut(&p.transfer_id)
                .filter(|entry| !entry.released)
                .ok_or_else(|| not_found("transfer not found"))?;
            if entry.direction != Direction::Upload || entry.ready || entry.busy {
                return Err(invalid("transfer is not writable"));
            }
            if p.offset != entry.written {
                return Err(invalid(format!(
                    "non-sequential transfer offset: expected {}, got {}",
                    entry.written, p.offset
                )));
            }
            let next = entry.written.saturating_add(bytes.len() as u64);
            if next > entry.expected_size.unwrap_or(MAX_TRANSFER_BYTES) {
                return Err(invalid("transfer exceeds declared byte size"));
            }
            entry.busy = true;
            (entry.path.clone(), entry.dir.clone(), next)
        };

        let write_res = OpenOptions::new()
            .append(true)
            .open(&path)
            .and_then(|mut file| file.write_all(&bytes))
            .map_err(io_error);

        let released_mid_flight = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get_mut(&p.transfer_id) {
                Some(entry) if entry.released => {
                    entries.remove(&p.transfer_id);
                    true
                }
                Some(entry) => {
                    entry.busy = false;
                    if write_res.is_ok() {
                        entry.written = next;
                    }
                    false
                }
                None => false,
            }
        };
        if released_mid_flight {
            let _ = fs::remove_dir_all(&dir);
            return Err(not_found("transfer not found"));
        }
        write_res?;
        Ok(TransferChunkResult {
            next_offset: next,
            eof: false,
            data_base64: None,
        })
    }

    pub fn finish_upload(&self, p: TransferIdParams) -> Result<TransferReadyResult, RpcError> {
        let mut entries = self.entries.lock().unwrap();
        let entry = entries
            .get_mut(&p.transfer_id)
            .filter(|entry| !entry.released)
            .ok_or_else(|| not_found("transfer not found"))?;
        if entry.direction != Direction::Upload || entry.busy {
            return Err(invalid("transfer is not an upload"));
        }
        if entry.written != entry.expected_size.unwrap_or(entry.written) {
            return Err(invalid(format!(
                "incomplete transfer: expected {} bytes, received {}",
                entry.expected_size.unwrap_or(0),
                entry.written
            )));
        }
        entry.ready = true;
        Ok(TransferReadyResult {
            transfer_id: p.transfer_id,
            byte_size: entry.written,
        })
    }

    pub fn resolve_uploads(
        &self,
        session_id: &str,
        ids: &[String],
    ) -> Result<Vec<PathBuf>, RpcError> {
        let entries = self.entries.lock().unwrap();
        ids.iter()
            .map(|id| {
                let entry = entries
                    .get(id)
                    .filter(|entry| !entry.released)
                    .ok_or_else(|| not_found("upload transfer not found"))?;
                if entry.session_id != session_id
                    || entry.direction != Direction::Upload
                    || !entry.ready
                    || entry.busy
                {
                    return Err(permission(
                        "upload transfer is outside this session or not ready",
                    ));
                }
                Ok(entry.path.clone())
            })
            .collect()
    }

    pub fn begin_download(&self, session_id: &str) -> Result<DownloadStaging, RpcError> {
        self.ensure_root()
            .map_err(|err| protocol_error(err.to_string()))?;
        let remaining = {
            let entries = self.entries.lock().unwrap();
            MAX_TRANSFER_BYTES.saturating_sub(session_bytes_locked(&entries, session_id, None))
        };
        if remaining == 0 {
            return Err(invalid(format!(
                "session transfer staging exceeds limit {}",
                MAX_TRANSFER_BYTES
            )));
        }
        let id = new_id();
        let dir = self.root.join(&id);
        fs::create_dir(&dir).map_err(io_error)?;
        set_private_dir(&dir).map_err(io_error)?;
        let max_byte_size = {
            let mut entries = self.entries.lock().unwrap();
            let remaining =
                MAX_TRANSFER_BYTES.saturating_sub(session_bytes_locked(&entries, session_id, None));
            if remaining == 0 {
                drop(entries);
                let _ = fs::remove_dir_all(&dir);
                return Err(invalid(format!(
                    "session transfer staging exceeds limit {}",
                    MAX_TRANSFER_BYTES
                )));
            }
            entries.insert(
                id.clone(),
                Entry {
                    session_id: session_id.to_string(),
                    direction: Direction::Download,
                    dir: dir.clone(),
                    path: dir,
                    // Reserve the advertised budget immediately so a concurrent
                    // `transfer.begin` cannot consume space promised to Chrome
                    // while the download is in flight; `import_download` shrinks
                    // this to the actual copied size (or clears it on failure).
                    expected_size: Some(remaining),
                    written: 0,
                    ready: false,
                    busy: false,
                    readers: 0,
                    released: false,
                },
            );
            remaining
        };
        Ok(DownloadStaging {
            browser_relative_dir: format!("BrowserSkill/{id}"),
            transfer_id: id,
            max_byte_size,
        })
    }

    pub fn import_download(&self, id: &str, reported_path: &Path) -> Result<u64, RpcError> {
        let (dir, session_id) = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries
                .get_mut(id)
                .filter(|entry| !entry.released)
                .ok_or_else(|| not_found("download transfer not found"))?;
            if entry.direction != Direction::Download {
                return Err(permission("transfer is not a download capability"));
            }
            if entry.busy || entry.ready {
                return Err(invalid("download transfer is already finalized or busy"));
            }
            entry.busy = true;
            (entry.dir.clone(), entry.session_id.clone())
        };

        let destination = dir.join("payload");
        let import_res = (|| -> Result<(u64, ValidatedBrowserFile), RpcError> {
            let browser_file = ValidatedBrowserFile::validate(reported_path, id)?;
            let canonical = browser_file.path.canonicalize().map_err(io_error)?;
            let meta = fs::metadata(&canonical).map_err(io_error)?;
            if !meta.is_file() || meta.len() > MAX_TRANSFER_BYTES {
                return Err(invalid(
                    "download is not a regular file or exceeds the transfer limit",
                ));
            }
            let declared_len = meta.len();
            // Keep the full remaining session budget reserved on this entry while
            // copying so no concurrent `transfer.begin` can consume space promised
            // to this download; `expected_size` shrinks to `Some(copied)` on commit.
            let remaining = {
                let mut entries = self.entries.lock().unwrap();
                let other_bytes = session_bytes_locked(&entries, &session_id, Some(id));
                let remaining = MAX_TRANSFER_BYTES.saturating_sub(other_bytes);
                if declared_len > remaining {
                    return Err(invalid(format!(
                        "session transfer staging exceeds limit {}",
                        MAX_TRANSFER_BYTES
                    )));
                }
                let entry = entries
                    .get_mut(id)
                    .filter(|entry| !entry.released)
                    .ok_or_else(|| not_found("download transfer not found"))?;
                entry.expected_size = Some(remaining);
                remaining
            };
            let source = File::open(&canonical).map_err(io_error)?;
            let mut destination_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(io_error)?;
            let copied = std::io::copy(
                &mut source.take(remaining.saturating_add(1)),
                &mut destination_file,
            )
            .map_err(io_error)?;
            if copied > remaining {
                drop(destination_file);
                let _ = fs::remove_file(&destination);
                return Err(invalid(format!(
                    "session transfer staging exceeds limit {}",
                    MAX_TRANSFER_BYTES
                )));
            }
            drop(destination_file);
            Ok((copied, browser_file))
        })();

        let mut quota_exceeded = false;
        let mut committed: Option<(u64, ValidatedBrowserFile)> = None;
        let released_mid_flight = {
            let mut entries = self.entries.lock().unwrap();
            let other_bytes = session_bytes_locked(&entries, &session_id, Some(id));
            match entries.get_mut(id) {
                Some(entry) if entry.released => {
                    entries.remove(id);
                    true
                }
                Some(entry) => {
                    entry.busy = false;
                    match import_res {
                        Ok((copied, browser_file)) => {
                            if other_bytes.saturating_add(copied) > MAX_TRANSFER_BYTES {
                                entry.expected_size = None;
                                quota_exceeded = true;
                                drop(browser_file);
                            } else {
                                entry.path = destination.clone();
                                entry.written = copied;
                                entry.expected_size = Some(copied);
                                entry.ready = true;
                                committed = Some((copied, browser_file));
                            }
                        }
                        Err(err) => {
                            entry.expected_size = None;
                            drop(entries);
                            return Err(err);
                        }
                    }
                    false
                }
                None => false,
            }
        };
        if released_mid_flight {
            let _ = fs::remove_dir_all(&dir);
            return Err(not_found("download transfer not found"));
        }
        if quota_exceeded {
            let _ = fs::remove_file(&destination);
            return Err(invalid(format!(
                "session transfer staging exceeds limit {}",
                MAX_TRANSFER_BYTES
            )));
        }
        let (copied, browser_file) =
            committed.ok_or_else(|| not_found("download transfer not found"))?;
        // Remove the browser source only AFTER `entry.ready = true` is durably
        // committed, and tolerate non-fatal cleanup failures (e.g. macOS `.DS_Store`
        // `ENOTEMPTY` or Windows AV file locks) without discarding the imported file.
        if let Err(err) = browser_file.remove_source() {
            tracing::warn!(
                transfer_id = id,
                path = %reported_path.display(),
                %err,
                "download imported, but removing browser download source failed"
            );
        }
        Ok(copied)
    }

    pub fn read_chunk(&self, p: TransferReadParams) -> Result<TransferChunkResult, RpcError> {
        let (path, dir, total_written) = {
            let mut entries = self.entries.lock().unwrap();
            let entry = entries
                .get_mut(&p.transfer_id)
                .filter(|entry| !entry.released)
                .ok_or_else(|| not_found("transfer not found"))?;
            if entry.direction != Direction::Download || !entry.ready || entry.busy {
                return Err(invalid("transfer is not readable"));
            }
            if p.offset > entry.written {
                return Err(invalid("read offset is beyond transfer length"));
            }
            entry.readers += 1;
            (entry.path.clone(), entry.dir.clone(), entry.written)
        };

        let read_res = (|| -> Result<TransferChunkResult, RpcError> {
            let mut file = File::open(&path).map_err(io_error)?;
            file.seek(SeekFrom::Start(p.offset)).map_err(io_error)?;
            let mut buf = vec![0u8; TRANSFER_CHUNK_SIZE as usize];
            let count = file.read(&mut buf).map_err(io_error)?;
            buf.truncate(count);
            let next = p.offset + count as u64;
            Ok(TransferChunkResult {
                next_offset: next,
                eof: next >= total_written,
                data_base64: Some(base64::engine::general_purpose::STANDARD.encode(buf)),
            })
        })();

        let cleanup_dir = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get_mut(&p.transfer_id) {
                Some(entry) => {
                    entry.readers = entry.readers.saturating_sub(1);
                    if entry.released && entry.readers == 0 && !entry.busy {
                        entries.remove(&p.transfer_id);
                        true
                    } else {
                        false
                    }
                }
                None => false,
            }
        };
        if cleanup_dir {
            let _ = fs::remove_dir_all(&dir);
        }
        read_res
    }

    pub fn release(&self, p: TransferIdParams) -> TransferReleaseResult {
        let remove_dir = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get_mut(&p.transfer_id) {
                None => return TransferReleaseResult { released: false },
                Some(entry) if entry.released => return TransferReleaseResult { released: false },
                Some(entry) if entry.busy || entry.readers > 0 => {
                    entry.released = true;
                    None
                }
                Some(_) => entries.remove(&p.transfer_id).map(|entry| entry.dir),
            }
        };
        if let Some(dir) = remove_dir {
            let _ = fs::remove_dir_all(dir);
        }
        TransferReleaseResult { released: true }
    }

    pub fn drain_session_dirs(&self, session_id: &str) -> Vec<PathBuf> {
        let mut entries = self.entries.lock().unwrap();
        let mut dirs = Vec::new();
        entries.retain(|_, entry| {
            if entry.session_id != session_id {
                return true;
            }
            if entry.busy || entry.readers > 0 {
                entry.released = true;
                true
            } else {
                dirs.push(entry.dir.clone());
                false
            }
        });
        dirs
    }

    pub fn remove_dirs(dirs: Vec<PathBuf>) {
        for dir in dirs {
            let _ = fs::remove_dir_all(dir);
        }
    }

    pub fn release_session(&self, session_id: &str) {
        Self::remove_dirs(self.drain_session_dirs(session_id));
    }
}

fn session_bytes_locked(
    entries: &HashMap<String, Entry>,
    session_id: &str,
    exclude_id: Option<&str>,
) -> u64 {
    entries
        .iter()
        .filter(|(id, entry)| {
            exclude_id.is_none_or(|excluded| id.as_str() != excluded)
                && !entry.released
                && entry.session_id == session_id
        })
        .map(|(_, entry)| entry.expected_size.unwrap_or(entry.written))
        .fold(0u64, u64::saturating_add)
}

fn new_id() -> String {
    format!("tr_{}", Uuid::new_v4().simple())
}

fn set_private_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_private_file(file: &File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn remove_dir_if_present(path: &Path) -> std::io::Result<()> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn safe_upload_basename(name: &str) -> Result<&str, RpcError> {
    if name.is_empty() || name.contains(['/', '\\', '\0']) {
        return Err(invalid("upload name must be a safe basename"));
    }
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(name),
        _ => Err(invalid("upload name must be a safe basename")),
    }
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError {
        code: ErrorCode::InvalidParams,
        message: message.into(),
        data: None,
    }
}
fn not_found(message: impl Into<String>) -> RpcError {
    RpcError {
        code: ErrorCode::NotFound,
        message: message.into(),
        data: None,
    }
}
fn permission(message: impl Into<String>) -> RpcError {
    RpcError {
        code: ErrorCode::PermissionDenied,
        message: message.into(),
        data: None,
    }
}
fn io_error(err: std::io::Error) -> RpcError {
    RpcError {
        code: ErrorCode::ProtocolError,
        message: err.to_string(),
        data: None,
    }
}

fn protocol_error(message: impl Into<String>) -> RpcError {
    RpcError {
        code: ErrorCode::ProtocolError,
        message: message.into(),
        data: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> (tempfile::TempDir, TransferRegistry) {
        let temp = tempfile::tempdir().unwrap();
        let registry = TransferRegistry::at_root(temp.path().join("transfers")).unwrap();
        (temp, registry)
    }

    #[test]
    fn upload_is_not_resolvable_until_complete_or_from_another_session() {
        let (_temp, registry) = registry();
        let begin = registry
            .begin_upload(TransferBeginParams {
                session_id: "s1".into(),
                name: "image.png".into(),
                byte_size: 3,
            })
            .unwrap();
        assert!(
            registry
                .resolve_uploads("s1", std::slice::from_ref(&begin.transfer_id))
                .is_err()
        );
        registry
            .write_chunk(TransferChunkParams {
                transfer_id: begin.transfer_id.clone(),
                offset: 0,
                data_base64: base64::engine::general_purpose::STANDARD.encode(b"abc"),
            })
            .unwrap();
        registry
            .finish_upload(TransferIdParams {
                transfer_id: begin.transfer_id.clone(),
            })
            .unwrap();
        assert!(
            registry
                .resolve_uploads("s2", std::slice::from_ref(&begin.transfer_id))
                .is_err()
        );
        let [path] = registry
            .resolve_uploads("s1", &[begin.transfer_id])
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(path.file_name().unwrap(), "image.png");
        assert_eq!(fs::read(path).unwrap(), b"abc");
    }

    #[test]
    fn upload_name_must_be_one_safe_path_component() {
        let (_temp, registry) = registry();
        for name in ["", ".", "..", "../secret", "folder/file", "folder\\file"] {
            let result = registry.begin_upload(TransferBeginParams {
                session_id: "s1".into(),
                name: name.into(),
                byte_size: 0,
            });
            assert!(result.is_err(), "accepted unsafe upload name");
        }
        assert!(registry.entries.lock().unwrap().is_empty());
        assert!(fs::read_dir(&registry.root).unwrap().next().is_none());
    }

    #[test]
    fn same_upload_names_are_isolated_by_transfer_directory() {
        let (_temp, registry) = registry();
        let first = registry
            .begin_upload(TransferBeginParams {
                session_id: "s1".into(),
                name: "image.png".into(),
                byte_size: 0,
            })
            .unwrap();
        let second = registry
            .begin_upload(TransferBeginParams {
                session_id: "s1".into(),
                name: "image.png".into(),
                byte_size: 0,
            })
            .unwrap();
        let entries = registry.entries.lock().unwrap();
        let first_path = &entries[&first.transfer_id].path;
        let second_path = &entries[&second.transfer_id].path;
        assert_ne!(first_path.parent(), second_path.parent());
        assert_eq!(first_path.file_name().unwrap(), "image.png");
        assert_eq!(second_path.file_name().unwrap(), "image.png");
    }

    #[cfg(unix)]
    #[test]
    fn upload_staging_is_private() {
        use std::os::unix::fs::PermissionsExt;

        let (_temp, registry) = registry();
        let begin = registry
            .begin_upload(TransferBeginParams {
                session_id: "s1".into(),
                name: "private.png".into(),
                byte_size: 0,
            })
            .unwrap();
        let entries = registry.entries.lock().unwrap();
        let path = &entries[&begin.transfer_id].path;
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn download_must_import_from_its_browser_capability_directory() {
        let (temp, registry) = registry();
        let staging = registry.begin_download("s1").unwrap();
        let outside = temp.path().join("outside.bin");
        fs::write(&outside, b"secret").unwrap();
        assert!(
            registry
                .import_download(&staging.transfer_id, &outside)
                .is_err()
        );
        assert_eq!(fs::read(&outside).unwrap(), b"secret");

        let browser_dir = temp
            .path()
            .join("Downloads")
            .join("BrowserSkill")
            .join(&staging.transfer_id);
        fs::create_dir_all(&browser_dir).unwrap();
        let inside = browser_dir.join("result.bin");
        fs::write(&inside, b"result").unwrap();
        assert_eq!(
            registry
                .import_download(&staging.transfer_id, &inside)
                .unwrap(),
            6
        );
        assert!(!inside.exists());
        let chunk = registry
            .read_chunk(TransferReadParams {
                transfer_id: staging.transfer_id,
                offset: 0,
                data_base64: None,
            })
            .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(chunk.data_base64.unwrap())
                .unwrap(),
            b"result"
        );
    }

    #[test]
    fn validated_oversized_browser_download_is_removed_on_rejection() {
        let (temp, registry) = registry();
        let staging = registry.begin_download("s1").unwrap();
        let browser_dir = temp
            .path()
            .join("Downloads")
            .join("BrowserSkill")
            .join(&staging.transfer_id);
        fs::create_dir_all(&browser_dir).unwrap();
        let inside = browser_dir.join("oversized.bin");
        File::create(&inside)
            .unwrap()
            .set_len(MAX_TRANSFER_BYTES + 1)
            .unwrap();

        assert!(
            registry
                .import_download(&staging.transfer_id, &inside)
                .is_err()
        );
        assert!(!inside.exists());
        assert!(!browser_dir.exists());
    }

    #[test]
    fn releasing_a_session_removes_all_staging() {
        let (_temp, registry) = registry();
        let first = registry.begin_download("s1").unwrap();
        let second = registry.begin_download("s2").unwrap();
        let first_directory = registry.root.join(&first.transfer_id);
        let second_directory = registry.root.join(&second.transfer_id);
        registry.release_session("s1");
        assert!(!first_directory.exists());
        assert!(second_directory.exists());
    }

    #[test]
    fn upload_staging_is_bounded_across_a_session() {
        let (_temp, registry) = registry();
        registry
            .begin_upload(TransferBeginParams {
                session_id: "s1".into(),
                name: "large.bin".into(),
                byte_size: MAX_TRANSFER_BYTES,
            })
            .unwrap();
        assert!(
            registry
                .begin_upload(TransferBeginParams {
                    session_id: "s1".into(),
                    name: "one-more-byte.bin".into(),
                    byte_size: 1,
                })
                .is_err()
        );
        assert!(
            registry
                .begin_upload(TransferBeginParams {
                    session_id: "s2".into(),
                    name: "other-session.bin".into(),
                    byte_size: 1,
                })
                .is_ok()
        );
    }

    #[test]
    fn import_download_succeeds_when_source_parent_dir_is_not_empty() {
        let (temp, registry) = registry();
        let staging = registry.begin_download("s1").unwrap();
        let browser_dir = temp
            .path()
            .join("Downloads")
            .join("BrowserSkill")
            .join(&staging.transfer_id);
        fs::create_dir_all(&browser_dir).unwrap();
        // Simulate macOS Finder `.DS_Store` preventing `remove_dir` with ENOTEMPTY.
        fs::write(browser_dir.join(".DS_Store"), b"finder").unwrap();
        let downloaded = browser_dir.join("report.pdf");
        fs::write(&downloaded, b"pdf-payload").unwrap();

        let copied = registry
            .import_download(&staging.transfer_id, &downloaded)
            .expect("import_download must succeed even when remove_dir hits ENOTEMPTY");
        assert_eq!(copied, 11);

        let chunk = registry
            .read_chunk(TransferReadParams {
                transfer_id: staging.transfer_id.clone(),
                offset: 0,
                data_base64: None,
            })
            .unwrap();
        assert!(chunk.eof);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(chunk.data_base64.unwrap())
            .unwrap();
        assert_eq!(decoded, b"pdf-payload");
    }

    #[test]
    fn download_enforces_cumulative_session_transfer_quota() {
        let (temp, registry) = registry();
        // Reserve all but 4 bytes of the session quota with an upload.
        registry
            .begin_upload(TransferBeginParams {
                session_id: "s1".into(),
                name: "almost-full.bin".into(),
                byte_size: MAX_TRANSFER_BYTES - 4,
            })
            .unwrap();

        let staging = registry.begin_download("s1").unwrap();
        assert_eq!(staging.max_byte_size, 4);

        // A 5-byte download must be rejected because cumulative session bytes exceed MAX_TRANSFER_BYTES.
        let browser_dir = temp
            .path()
            .join("Downloads")
            .join("BrowserSkill")
            .join(&staging.transfer_id);
        fs::create_dir_all(&browser_dir).unwrap();
        let too_big = browser_dir.join("five.bin");
        fs::write(&too_big, b"12345").unwrap();
        assert!(
            registry
                .import_download(&staging.transfer_id, &too_big)
                .is_err()
        );

        // A 4-byte download fits exactly and exhausts the remaining quota.
        let staging2 = registry.begin_download("s1").unwrap();
        let browser_dir2 = temp
            .path()
            .join("Downloads")
            .join("BrowserSkill")
            .join(&staging2.transfer_id);
        fs::create_dir_all(&browser_dir2).unwrap();
        let exact = browser_dir2.join("four.bin");
        fs::write(&exact, b"1234").unwrap();
        assert_eq!(
            registry
                .import_download(&staging2.transfer_id, &exact)
                .unwrap(),
            4
        );

        // Now zero quota remains: `begin_download` rejects upfront.
        assert!(registry.begin_download("s1").is_err());
    }

    #[test]
    fn begin_download_reserves_budget_against_concurrent_uploads_and_releases_unused_on_import() {
        let (temp, registry) = registry();
        // Reserve all but 1024 bytes of session quota with an existing upload.
        registry
            .begin_upload(TransferBeginParams {
                session_id: "s1".into(),
                name: "existing.bin".into(),
                byte_size: MAX_TRANSFER_BYTES - 1024,
            })
            .unwrap();

        let staging = registry.begin_download("s1").unwrap();
        assert_eq!(staging.max_byte_size, 1024);

        // While the download is in flight, a concurrent `transfer.begin` must not
        // steal any of the 1024 bytes already advertised to Chrome.
        assert!(
            registry
                .begin_upload(TransferBeginParams {
                    session_id: "s1".into(),
                    name: "thief.bin".into(),
                    byte_size: 1,
                })
                .is_err(),
            "concurrent upload must not steal in-flight download budget"
        );

        // Once the browser finishes a 16-byte download and `import_download` commits,
        // the reservation shrinks from 1024 to 16, releasing 1008 bytes for new uploads.
        let browser_dir = temp
            .path()
            .join("Downloads")
            .join("BrowserSkill")
            .join(&staging.transfer_id);
        fs::create_dir_all(&browser_dir).unwrap();
        let downloaded = browser_dir.join("small.bin");
        fs::write(&downloaded, b"0123456789abcdef").unwrap();
        assert_eq!(
            registry
                .import_download(&staging.transfer_id, &downloaded)
                .unwrap(),
            16
        );

        assert!(
            registry
                .begin_upload(TransferBeginParams {
                    session_id: "s1".into(),
                    name: "too-large.bin".into(),
                    byte_size: 1009,
                })
                .is_err()
        );
        let fits = registry
            .begin_upload(TransferBeginParams {
                session_id: "s1".into(),
                name: "fits-exact.bin".into(),
                byte_size: 1008,
            })
            .unwrap();
        // Releasing that upload frees 1008 bytes, and releasing a fresh in-flight
        // download frees its reservation cleanly as well.
        assert!(
            registry
                .release(TransferIdParams {
                    transfer_id: fits.transfer_id,
                })
                .released
        );
        let staging2 = registry.begin_download("s1").unwrap();
        assert_eq!(staging2.max_byte_size, 1008);
        assert!(
            registry
                .release(TransferIdParams {
                    transfer_id: staging2.transfer_id,
                })
                .released
        );
        assert!(
            registry
                .begin_upload(TransferBeginParams {
                    session_id: "s1".into(),
                    name: "after-release.bin".into(),
                    byte_size: 1008,
                })
                .is_ok()
        );
    }
}
