//! `bsk update` — check for and install CLI updates.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail};
use clap::Args;
use flate2::read::GzDecoder;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::cli::daemon::StartArgs;
use crate::cli::error::{CliError, Format};

pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/Tencent/BrowserSkill/releases/latest/download/version.json";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const ARCHIVE_FETCH_TIMEOUT: Duration = Duration::from_secs(60);
const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone)]
pub struct UpdateManifest {
    pub version: Version,
    pub tag: String,
    pub release_url: Option<String>,
    pub assets: BTreeMap<String, ManifestAsset>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestAsset {
    pub url: String,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCandidate {
    pub current: Version,
    pub latest: Version,
    pub tag: String,
    pub release_url: Option<String>,
    pub asset: ManifestAsset,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallAction {
    Replaced,
    Staged,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedReplacementPaths {
    pub binary_path: PathBuf,
    pub script_path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
struct UpdateReport {
    status: &'static str,
    current_version: String,
    latest_version: Option<String>,
    release_url: Option<String>,
    asset_url: Option<String>,
    install_action: Option<&'static str>,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateCheckCache {
    pub checked_at_epoch_secs: u64,
    pub latest_version: String,
}

impl UpdateCheckCache {
    pub fn is_fresh(&self, now_epoch_secs: u64, interval: Duration) -> bool {
        now_epoch_secs.saturating_sub(self.checked_at_epoch_secs) <= interval.as_secs()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    TarGz,
    Zip,
}

#[derive(Debug, Deserialize)]
struct RawManifest {
    version: String,
    tag: Option<String>,
    release_url: Option<String>,
    assets: BTreeMap<String, RawManifestAsset>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawManifestAsset {
    Url(String),
    Rich {
        url: String,
        #[serde(default)]
        sha256: Option<String>,
    },
}

impl UpdateManifest {
    pub fn from_slice(bytes: &[u8]) -> Result<Self> {
        let raw: RawManifest = serde_json::from_slice(bytes).context("parse update manifest")?;
        let version = Version::parse(raw.version.trim_start_matches('v'))
            .context("parse manifest version")?;
        let tag = raw.tag.unwrap_or_else(|| format!("cli-v{version}"));
        let assets = raw
            .assets
            .into_iter()
            .map(|(platform, asset)| {
                let asset = match asset {
                    RawManifestAsset::Url(url) => ManifestAsset { url, sha256: None },
                    RawManifestAsset::Rich { url, sha256 } => ManifestAsset { url, sha256 },
                };
                (platform, asset)
            })
            .collect();

        Ok(Self {
            version,
            tag,
            release_url: raw.release_url,
            assets,
        })
    }

    pub fn update_candidate(
        &self,
        current_version: &str,
        platform_key: &str,
    ) -> Result<Option<UpdateCandidate>> {
        let current = Version::parse(current_version.trim_start_matches('v'))
            .context("parse current bsk version")?;
        if self.version <= current {
            return Ok(None);
        }

        let asset = self
            .assets
            .get(platform_key)
            .with_context(|| format!("no bsk release asset for platform `{platform_key}`"))?
            .clone();

        Ok(Some(UpdateCandidate {
            current,
            latest: self.version.clone(),
            tag: self.tag.clone(),
            release_url: self.release_url.clone(),
            asset,
        }))
    }
}

impl ArchiveKind {
    pub fn from_url(url: &str) -> Result<Self> {
        if url.ends_with(".tar.gz") || url.ends_with(".tgz") {
            Ok(Self::TarGz)
        } else if url.ends_with(".zip") {
            Ok(Self::Zip)
        } else {
            bail!("unsupported bsk archive type: {url}");
        }
    }
}

#[derive(Debug, Clone, Args, Default)]
pub struct UpdateArgs {
    /// Only check whether a newer version is available; do not install it.
    #[arg(long)]
    pub check: bool,

    /// Skip interactive confirmation prompts.
    #[arg(short = 'y', long)]
    pub yes: bool,

    /// Do not restart the daemon after replacing the CLI binary.
    #[arg(long = "no-restart-daemon", default_value_t = true, action = clap::ArgAction::SetFalse)]
    pub restart_daemon: bool,
}

pub fn dispatch(args: UpdateArgs, format: Format) -> Result<(), CliError> {
    run(args, format).map_err(CliError::Local)
}

fn run(args: UpdateArgs, format: Format) -> Result<()> {
    let client = update_http_client(ARCHIVE_FETCH_TIMEOUT)?;
    let manifest = fetch_manifest_with_client(&client, &manifest_url())?;
    let platform = current_platform_key()?;
    let current_version = env!("CARGO_PKG_VERSION");
    let Some(candidate) = manifest.update_candidate(current_version, platform)? else {
        return render_report(
            format,
            &UpdateReport {
                status: "up_to_date",
                current_version: current_version.to_string(),
                latest_version: Some(manifest.version.to_string()),
                release_url: manifest.release_url,
                asset_url: None,
                install_action: None,
                message: format!("bsk {current_version} is already up to date"),
            },
        );
    };

    if args.check {
        return render_report(
            format,
            &UpdateReport {
                status: "update_available",
                current_version: candidate.current.to_string(),
                latest_version: Some(candidate.latest.to_string()),
                release_url: candidate.release_url.clone(),
                asset_url: Some(candidate.asset.url.clone()),
                install_action: None,
                message: format!(
                    "bsk {} is available (current {})",
                    candidate.latest, candidate.current
                ),
            },
        );
    }

    if !args.yes && !confirm_update(&candidate)? {
        return render_report(
            format,
            &UpdateReport {
                status: "cancelled",
                current_version: candidate.current.to_string(),
                latest_version: Some(candidate.latest.to_string()),
                release_url: candidate.release_url,
                asset_url: Some(candidate.asset.url),
                install_action: None,
                message: "update cancelled".to_string(),
            },
        );
    }

    let action = install_candidate_with_client(&candidate, args.restart_daemon, &client)?;
    let action_label = match action {
        InstallAction::Replaced => "replaced",
        InstallAction::Staged => "staged",
    };

    render_report(
        format,
        &UpdateReport {
            status: "updated",
            current_version: candidate.current.to_string(),
            latest_version: Some(candidate.latest.to_string()),
            release_url: candidate.release_url,
            asset_url: Some(candidate.asset.url),
            install_action: Some(action_label),
            message: format!(
                "updated bsk from {} to {}",
                candidate.current, candidate.latest
            ),
        },
    )
}

pub fn current_platform_key() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        ("windows", "x86_64") => Ok("windows-x64"),
        (os, arch) => bail!("unsupported platform for bsk auto-update: {os}-{arch}"),
    }
}

pub fn fetch_bytes(url: &str, timeout: Duration) -> Result<Vec<u8>> {
    let client = update_http_client(timeout)?;
    fetch_bytes_with_client(&client, url)
}

fn update_http_client(timeout: Duration) -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .context("build update HTTP client")
}

fn fetch_bytes_with_client(client: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>> {
    let response = client
        .get(url)
        .send()
        .with_context(|| format!("download {url}"))?
        .error_for_status()
        .with_context(|| format!("download {url}"))?;
    Ok(response
        .bytes()
        .context("read update response body")?
        .to_vec())
}

pub fn fetch_manifest(url: &str) -> Result<UpdateManifest> {
    let client = update_http_client(FETCH_TIMEOUT)?;
    fetch_manifest_with_client(&client, url)
}

fn fetch_manifest_with_client(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Result<UpdateManifest> {
    let bytes = fetch_bytes_with_client(client, url)?;
    UpdateManifest::from_slice(&bytes)
}

fn install_candidate_with_client(
    candidate: &UpdateCandidate,
    restart_daemon: bool,
    client: &reqwest::blocking::Client,
) -> Result<InstallAction> {
    let expected_sha = candidate.asset.sha256.as_deref().with_context(|| {
        format!(
            "release {} does not include a sha256 checksum; cannot safely auto-update",
            candidate.tag
        )
    })?;
    let archive = fetch_bytes_with_client(client, &candidate.asset.url)?;
    verify_sha256(&archive, expected_sha)?;
    let kind = ArchiveKind::from_url(&candidate.asset.url)?;
    let binary = extract_bsk_binary(&archive, kind)?;
    let target = std::env::current_exe().context("locate current bsk executable")?;

    let daemon_was_running = restart_daemon && crate::daemon::info::read_valid()?.is_some();
    if daemon_was_running {
        crate::daemon::start::run_stop().context("stop bsk daemon before update")?;
    }

    let action = replace_binary_at_path(&target, &binary)?;

    if daemon_was_running && matches!(action, InstallAction::Replaced) {
        crate::daemon::start::run_start(StartArgs::default())
            .context("restart bsk daemon after update")?;
    }

    Ok(action)
}

pub fn verify_sha256(bytes: &[u8], expected_hex: &str) -> Result<()> {
    let actual = hex_sha256(bytes);
    let expected = expected_hex.trim().to_ascii_lowercase();
    if actual != expected {
        bail!("downloaded bsk archive checksum mismatch: expected {expected}, got {actual}");
    }
    Ok(())
}

fn manifest_url() -> String {
    std::env::var("BSK_UPDATE_MANIFEST_URL").unwrap_or_else(|_| DEFAULT_MANIFEST_URL.to_string())
}

pub fn update_hint_for_manifest(
    manifest: &UpdateManifest,
    current_version: &str,
    platform_key: &str,
) -> Result<Option<String>> {
    Ok(manifest
        .update_candidate(current_version, platform_key)?
        .map(|candidate| {
            format!(
                "A new bsk version is available: {} -> {}. Run `bsk update`.",
                candidate.current, candidate.latest
            )
        }))
}

fn update_hint_for_cache(cache: &UpdateCheckCache, current_version: &str) -> Option<String> {
    let latest = cache.latest_version.as_str();
    let current = Version::parse(current_version.trim_start_matches('v')).ok()?;
    let latest_version = Version::parse(latest.trim_start_matches('v')).ok()?;
    (latest_version > current).then(|| {
        format!("A new bsk version is available: {current} -> {latest_version}. Run `bsk update`.")
    })
}

pub fn read_update_cache(path: &Path) -> Result<Option<UpdateCheckCache>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let cache = serde_json::from_slice(&bytes)
                .with_context(|| format!("parse {}", path.display()))?;
            Ok(Some(cache))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(anyhow::Error::from(err).context(format!("read {}", path.display()))),
    }
}

pub fn write_update_cache(path: &Path, cache: &UpdateCheckCache) -> Result<()> {
    let dir = path
        .parent()
        .with_context(|| format!("cache path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let tmp = path.with_file_name(format!(
        "{}.tmp.{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("update-check.json"),
        std::process::id()
    ));
    let payload = serde_json::to_vec_pretty(cache).context("encode update cache")?;
    {
        let mut file =
            std::fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        file.write_all(&payload)
            .with_context(|| format!("write {}", tmp.display()))?;
        file.flush()
            .with_context(|| format!("flush {}", tmp.display()))?;
        file.sync_all()
            .with_context(|| format!("sync {}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path)
        .with_context(|| format!("rename {} to {}", tmp.display(), path.display()))?;
    sync_dir(dir);
    Ok(())
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn refresh_update_cache(cache_path: &Path) -> Result<Option<String>> {
    let manifest = fetch_manifest(&manifest_url())?;
    let platform = current_platform_key()?;
    let hint = update_hint_for_manifest(&manifest, env!("CARGO_PKG_VERSION"), platform)?;
    write_update_cache(
        cache_path,
        &UpdateCheckCache {
            checked_at_epoch_secs: now_epoch_secs(),
            latest_version: manifest.version.to_string(),
        },
    )?;
    Ok(hint)
}

pub fn maybe_spawn_background_check(flags: &super::GlobalFlags, command: &super::Command) {
    if flags.quiet
        || flags.json
        || matches!(
            command,
            super::Command::Daemon(_) | super::Command::Update(_)
        )
    {
        return;
    }

    let Ok(cache_path) = crate::daemon::paths::update_check_path() else {
        return;
    };
    let now = now_epoch_secs();
    match read_update_cache(&cache_path) {
        Ok(Some(cache)) => {
            if let Some(hint) = update_hint_for_cache(&cache, env!("CARGO_PKG_VERSION")) {
                eprintln!("{hint}");
            }
            if cache.is_fresh(now, UPDATE_CHECK_INTERVAL) {
                return;
            }
        }
        Ok(None) => {}
        Err(err) => {
            tracing::debug!(error = %err, "update cache read failed");
        }
    }

    let _ = std::thread::Builder::new()
        .name("bsk-update-check".to_string())
        .spawn(move || match refresh_update_cache(&cache_path) {
            Ok(Some(hint)) => eprintln!("{hint}"),
            Ok(None) => {}
            Err(err) => tracing::debug!(error = %err, "background update check failed"),
        });
}

fn confirm_update(candidate: &UpdateCandidate) -> Result<bool> {
    dialoguer::Confirm::new()
        .with_prompt(format!(
            "Update bsk from {} to {}?",
            candidate.current, candidate.latest
        ))
        .default(true)
        .interact()
        .context("read update confirmation")
}

fn render_report(format: Format, report: &UpdateReport) -> Result<()> {
    match format {
        Format::Human => {
            println!("{}", report.message);
            if let Some(release_url) = &report.release_url {
                println!("release: {release_url}");
            }
            if matches!(report.install_action, Some("staged")) {
                println!(
                    "restart your terminal and run `bsk --version` to verify the staged update"
                );
            }
        }
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(report).context("encode update report as JSON")?
            );
        }
    }
    Ok(())
}

pub fn extract_bsk_binary(archive_bytes: &[u8], kind: ArchiveKind) -> Result<Vec<u8>> {
    match kind {
        ArchiveKind::TarGz => extract_bsk_from_tar_gz(archive_bytes),
        ArchiveKind::Zip => extract_bsk_from_zip(archive_bytes),
    }
}

pub fn replace_binary_at_path(target: &Path, binary: &[u8]) -> Result<InstallAction> {
    #[cfg(windows)]
    {
        stage_windows_replacement(target, binary)
    }

    #[cfg(not(windows))]
    {
        replace_binary_atomically(target, binary)
    }
}

#[cfg(not(windows))]
fn replace_binary_atomically(target: &Path, binary: &[u8]) -> Result<InstallAction> {
    let dir = target
        .parent()
        .with_context(|| format!("target path has no parent: {}", target.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;

    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .context("target path must have a UTF-8 file name")?;
    let tmp = target.with_file_name(format!(".{file_name}.update-{}.tmp", std::process::id()));

    {
        let mut file =
            std::fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        file.write_all(binary)
            .with_context(|| format!("write {}", tmp.display()))?;
        file.flush()
            .with_context(|| format!("flush {}", tmp.display()))?;
        file.sync_all()
            .with_context(|| format!("sync {}", tmp.display()))?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("chmod 0755 {}", tmp.display()))?;
    }

    std::fs::rename(&tmp, target)
        .with_context(|| format!("rename {} to {}", tmp.display(), target.display()))?;
    sync_dir(dir);
    Ok(InstallAction::Replaced)
}

#[cfg(windows)]
fn stage_windows_replacement(target: &Path, binary: &[u8]) -> Result<InstallAction> {
    let paths = staged_replacement_paths(target, std::process::id())?;
    std::fs::write(&paths.binary_path, binary)
        .with_context(|| format!("write {}", paths.binary_path.display()))?;
    std::fs::write(
        &paths.script_path,
        windows_replacement_script(target, &paths.binary_path),
    )
    .with_context(|| format!("write {}", paths.script_path.display()))?;
    Ok(InstallAction::Staged)
}

pub fn staged_replacement_paths(target: &Path, pid: u32) -> Result<StagedReplacementPaths> {
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .context("target path must have a UTF-8 file name")?;
    let binary_path = target.with_file_name(format!("{file_name}.update-{pid}"));
    let script_path = target.with_file_name(format!("{file_name}.update-{pid}.cmd"));
    Ok(StagedReplacementPaths {
        binary_path,
        script_path,
    })
}

#[cfg(windows)]
fn windows_replacement_script(target: &Path, staged_binary: &Path) -> String {
    format!(
        "@echo off\r\n\
         setlocal\r\n\
         :retry\r\n\
         move /Y \"{}\" \"{}\" >nul 2>nul\r\n\
         if errorlevel 1 (\r\n\
           timeout /t 1 /nobreak >nul\r\n\
           goto retry\r\n\
         )\r\n",
        staged_binary.display(),
        target.display()
    )
}

fn sync_dir(dir: &Path) {
    if let Ok(dir_file) = std::fs::File::open(dir) {
        let _ = dir_file.sync_all();
    }
}

fn extract_bsk_from_tar_gz(archive_bytes: &[u8]) -> Result<Vec<u8>> {
    let decoder = GzDecoder::new(Cursor::new(archive_bytes));
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries().context("read bsk tar.gz entries")? {
        let mut entry = entry.context("read bsk tar.gz entry")?;
        let path = entry.path().context("read bsk tar.gz entry path")?;
        if path.file_name().is_some_and(|name| name == "bsk") {
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .context("read bsk binary from tar.gz")?;
            return Ok(bytes);
        }
    }
    bail!("bsk binary not found in tar.gz archive");
}

fn extract_bsk_from_zip(archive_bytes: &[u8]) -> Result<Vec<u8>> {
    let cursor = Cursor::new(archive_bytes);
    let mut archive = zip::ZipArchive::new(cursor).context("read bsk zip archive")?;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .with_context(|| format!("read zip entry {index}"))?;
        let name = std::path::Path::new(file.name())
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if name == "bsk.exe" || name == "bsk" {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .context("read bsk binary from zip")?;
            return Ok(bytes);
        }
    }
    bail!("bsk binary not found in zip archive");
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::Write;

    #[test]
    fn parses_new_and_legacy_manifest_asset_shapes() {
        let manifest = UpdateManifest::from_slice(
            br#"{
                "name": "bsk",
                "version": "0.2.0",
                "tag": "cli-v0.2.0",
                "release_url": "https://github.com/Tencent/BrowserSkill/releases/tag/cli-v0.2.0",
                "assets": {
                    "darwin-arm64": {
                        "url": "https://example.test/bsk.tar.gz",
                        "sha256": "abc123"
                    },
                    "linux-x64": "https://example.test/legacy.tar.gz"
                }
            }"#,
        )
        .unwrap();

        assert_eq!(manifest.version.to_string(), "0.2.0");
        assert_eq!(
            manifest.assets["darwin-arm64"].url,
            "https://example.test/bsk.tar.gz"
        );
        assert_eq!(
            manifest.assets["darwin-arm64"].sha256.as_deref(),
            Some("abc123")
        );
        assert_eq!(
            manifest.assets["linux-x64"].url,
            "https://example.test/legacy.tar.gz"
        );
        assert!(manifest.assets["linux-x64"].sha256.is_none());
    }

    #[test]
    fn classifies_newer_manifest_as_update_candidate() {
        let manifest = UpdateManifest::from_slice(
            br#"{
                "name": "bsk",
                "version": "0.2.0",
                "tag": "cli-v0.2.0",
                "release_url": "https://github.com/Tencent/BrowserSkill/releases/tag/cli-v0.2.0",
                "assets": {
                    "linux-x64": {
                        "url": "https://example.test/bsk.tar.gz",
                        "sha256": "abc123"
                    }
                }
            }"#,
        )
        .unwrap();

        let candidate = manifest
            .update_candidate("0.1.7", "linux-x64")
            .unwrap()
            .unwrap();
        assert_eq!(candidate.latest.to_string(), "0.2.0");
        assert_eq!(candidate.asset.sha256.as_deref(), Some("abc123"));
        assert!(
            manifest
                .update_candidate("0.2.0", "linux-x64")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn verifies_sha256_before_installing_archive() {
        let bytes = b"archive bytes";
        let expected = hex_sha256(bytes);
        verify_sha256(bytes, &expected).unwrap();
        assert!(verify_sha256(bytes, "0000").is_err());
    }

    #[test]
    fn extracts_bsk_binary_from_tar_gz_archive() {
        let archive = tar_gz_with_bsk(b"new binary");
        let extracted = extract_bsk_binary(&archive, ArchiveKind::TarGz).unwrap();
        assert_eq!(extracted, b"new binary");
    }

    #[test]
    fn extracts_bsk_binary_from_zip_archive() {
        let archive = zip_with_bsk_exe(b"windows binary");
        let extracted = extract_bsk_binary(&archive, ArchiveKind::Zip).unwrap();
        assert_eq!(extracted, b"windows binary");
    }

    #[test]
    fn replaces_binary_at_path() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("bsk");
        std::fs::write(&target, b"old binary").unwrap();

        let action = replace_binary_at_path(&target, b"new binary").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new binary");
        assert!(matches!(action, InstallAction::Replaced));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o755);
        }
    }

    #[test]
    fn staged_replacement_paths_are_next_to_target() {
        let target = std::path::Path::new("/tmp/bsk.exe");
        let paths = staged_replacement_paths(target, 42).unwrap();
        assert_eq!(
            paths.binary_path,
            std::path::Path::new("/tmp/bsk.exe.update-42")
        );
        assert_eq!(
            paths.script_path,
            std::path::Path::new("/tmp/bsk.exe.update-42.cmd")
        );
    }

    #[test]
    fn cache_freshness_uses_epoch_seconds() {
        let cache = UpdateCheckCache {
            checked_at_epoch_secs: 100,
            latest_version: "0.2.0".to_string(),
        };
        assert!(cache.is_fresh(120, Duration::from_secs(30)));
        assert!(!cache.is_fresh(131, Duration::from_secs(30)));
    }

    #[test]
    fn update_hint_is_generated_only_for_newer_versions() {
        let manifest = UpdateManifest::from_slice(
            br#"{
                "name": "bsk",
                "version": "0.2.0",
                "tag": "cli-v0.2.0",
                "release_url": "https://github.com/Tencent/BrowserSkill/releases/tag/cli-v0.2.0",
                "assets": {
                    "linux-x64": {
                        "url": "https://example.test/bsk.tar.gz",
                        "sha256": "abc123"
                    }
                }
            }"#,
        )
        .unwrap();

        let hint = update_hint_for_manifest(&manifest, "0.1.7", "linux-x64").unwrap();
        assert_eq!(
            hint.as_deref(),
            Some("A new bsk version is available: 0.1.7 -> 0.2.0. Run `bsk update`.")
        );
        assert!(
            update_hint_for_manifest(&manifest, "0.2.0", "linux-x64")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn update_check_cache_round_trips_to_disk() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("update-check.json");
        let cache = UpdateCheckCache {
            checked_at_epoch_secs: 123,
            latest_version: "0.2.0".to_string(),
        };

        write_update_cache(&path, &cache).unwrap();
        assert_eq!(read_update_cache(&path).unwrap(), Some(cache));
    }

    fn tar_gz_with_bsk(binary: &[u8]) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            let mut header = tar::Header::new_gnu();
            header.set_size(binary.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, "bsk", binary).unwrap();
            builder.finish().unwrap();
        }

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn zip_with_bsk_exe(binary: &[u8]) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            writer
                .start_file("bsk.exe", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(binary).unwrap();
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }
}
