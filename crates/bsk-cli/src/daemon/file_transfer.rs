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
    TransferIdParams, TransferReadyResult, TransferReleaseResult,
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
    path: PathBuf,
    expected_size: Option<u64>,
    written: u64,
    ready: bool,
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

    fn remove_source(mut self) -> Result<(), RpcError> {
        remove_if_present(&self.path).map_err(io_error)?;
        remove_dir_if_present(&self.parent).map_err(io_error)?;
        self.cleanup_armed = false;
        Ok(())
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

    #[cfg(test)]
    fn at_root(root: PathBuf) -> anyhow::Result<Self> {
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
        let basename = safe_upload_basename(&p.name)?;
        if p.byte_size > MAX_TRANSFER_BYTES {
            return Err(invalid(format!(
                "file size {} exceeds transfer limit {}",
                p.byte_size, MAX_TRANSFER_BYTES
            )));
        }
        let mut entries = self.entries.lock().unwrap();
        let session_bytes: u64 = entries
            .values()
            .filter(|entry| entry.session_id == p.session_id)
            .map(|entry| entry.expected_size.unwrap_or(entry.written))
            .sum();
        if session_bytes.saturating_add(p.byte_size) > MAX_TRANSFER_BYTES {
            return Err(invalid(format!(
                "session transfer staging exceeds limit {}",
                MAX_TRANSFER_BYTES
            )));
        }
        let id = new_id();
        let dir = self.root.join(&id);
        fs::create_dir(&dir).map_err(io_error)?;
        set_private_dir(&dir).map_err(io_error)?;
        let path = dir.join(basename);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(io_error)?;
        set_private_file(&file).map_err(io_error)?;
        entries.insert(
            id.clone(),
            Entry {
                session_id: p.session_id,
                direction: Direction::Upload,
                path,
                expected_size: Some(p.byte_size),
                written: 0,
                ready: false,
            },
        );
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
        let mut entries = self.entries.lock().unwrap();
        let entry = entries
            .get_mut(&p.transfer_id)
            .ok_or_else(|| not_found("transfer not found"))?;
        if entry.direction != Direction::Upload || entry.ready {
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
        let mut file = OpenOptions::new()
            .append(true)
            .open(&entry.path)
            .map_err(io_error)?;
        file.write_all(&bytes).map_err(io_error)?;
        entry.written = next;
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
            .ok_or_else(|| not_found("transfer not found"))?;
        if entry.direction != Direction::Upload {
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
                    .ok_or_else(|| not_found("upload transfer not found"))?;
                if entry.session_id != session_id
                    || entry.direction != Direction::Upload
                    || !entry.ready
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
        let id = new_id();
        let dir = self.root.join(&id);
        fs::create_dir(&dir).map_err(io_error)?;
        set_private_dir(&dir).map_err(io_error)?;
        self.entries.lock().unwrap().insert(
            id.clone(),
            Entry {
                session_id: session_id.to_string(),
                direction: Direction::Download,
                path: dir.clone(),
                expected_size: None,
                written: 0,
                ready: false,
            },
        );
        Ok(DownloadStaging {
            browser_relative_dir: format!("BrowserSkill/{id}"),
            transfer_id: id,
        })
    }

    pub fn import_download(&self, id: &str, reported_path: &Path) -> Result<u64, RpcError> {
        let mut entries = self.entries.lock().unwrap();
        let entry = entries
            .get_mut(id)
            .ok_or_else(|| not_found("download transfer not found"))?;
        if entry.direction != Direction::Download {
            return Err(permission("transfer is not a download capability"));
        }
        let browser_file = ValidatedBrowserFile::validate(reported_path, id)?;
        let canonical = browser_file.path.canonicalize().map_err(io_error)?;
        let meta = fs::metadata(&canonical).map_err(io_error)?;
        if !meta.is_file() || meta.len() > MAX_TRANSFER_BYTES {
            return Err(invalid(
                "download is not a regular file or exceeds the transfer limit",
            ));
        }

        let destination = entry.path.join("payload");
        let source = File::open(&canonical).map_err(io_error)?;
        let mut destination_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(io_error)?;
        let copied = std::io::copy(
            &mut source.take(MAX_TRANSFER_BYTES.saturating_add(1)),
            &mut destination_file,
        )
        .map_err(io_error)?;
        if copied > MAX_TRANSFER_BYTES {
            let _ = fs::remove_file(&destination);
            return Err(invalid("download exceeds the transfer limit"));
        }
        entry.path = destination;
        entry.written = copied;
        entry.expected_size = Some(copied);
        entry.ready = true;
        browser_file.remove_source()?;
        Ok(copied)
    }

    pub fn read_chunk(&self, p: TransferChunkParams) -> Result<TransferChunkResult, RpcError> {
        let entries = self.entries.lock().unwrap();
        let entry = entries
            .get(&p.transfer_id)
            .ok_or_else(|| not_found("transfer not found"))?;
        if entry.direction != Direction::Download || !entry.ready {
            return Err(invalid("transfer is not readable"));
        }
        if p.offset > entry.written {
            return Err(invalid("read offset is beyond transfer length"));
        }
        let mut file = File::open(&entry.path).map_err(io_error)?;
        file.seek(SeekFrom::Start(p.offset)).map_err(io_error)?;
        let mut buf = vec![0u8; TRANSFER_CHUNK_SIZE as usize];
        let count = file.read(&mut buf).map_err(io_error)?;
        buf.truncate(count);
        let next = p.offset + count as u64;
        Ok(TransferChunkResult {
            next_offset: next,
            eof: next >= entry.written,
            data_base64: Some(base64::engine::general_purpose::STANDARD.encode(buf)),
        })
    }

    pub fn release(&self, p: TransferIdParams) -> TransferReleaseResult {
        let entry = self.entries.lock().unwrap().remove(&p.transfer_id);
        if let Some(entry) = entry {
            let dir = if entry.path.is_dir() {
                entry.path
            } else {
                entry.path.parent().unwrap_or(&self.root).to_path_buf()
            };
            let _ = fs::remove_dir_all(dir);
            TransferReleaseResult { released: true }
        } else {
            TransferReleaseResult { released: false }
        }
    }

    pub fn release_session(&self, session_id: &str) {
        let ids: Vec<String> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, entry)| entry.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.release(TransferIdParams { transfer_id: id });
        }
    }
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
            .read_chunk(TransferChunkParams {
                transfer_id: staging.transfer_id,
                offset: 0,
                data_base64: String::new(),
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
}
