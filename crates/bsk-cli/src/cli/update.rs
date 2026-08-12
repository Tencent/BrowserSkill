//! `bsk update` — check for and install CLI updates.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::process::{Command, Stdio};

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
/// How often the daemon ticks the update check, and how long a cache
/// entry counts as fresh for the CLI hint. The daemon is the only
/// writer; CLI commands only ever read the cache.
pub(crate) const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(30 * 60);

/// Freshness window the daemon uses to decide whether a tick actually
/// refreshes the cache. Deliberately shorter than the tick cadence
/// ([`UPDATE_CHECK_INTERVAL`]): with an equal window, a cache refreshed
/// just after tick N would still count as fresh at tick N+1 (age just
/// under 30min), so steady state would only refetch every *other* tick.
/// At 5/6 of the interval (25min) every 30-minute tick finds the cache
/// stale and really refreshes it, while a daemon restarted with a
/// younger-than-25min cache still skips its first tick.
pub(crate) const DAEMON_REFRESH_WINDOW: Duration =
    Duration::from_secs(UPDATE_CHECK_INTERVAL.as_secs() * 5 / 6);

/// Environment variable that switches daemon-side auto-upgrade off.
/// Unset, or any value other than `off` (compared case-insensitively,
/// surrounding whitespace ignored), keeps auto-upgrade on.
pub(crate) const AUTO_UPDATE_ENV: &str = "BSK_AUTO_UPDATE";

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
    let (status, message) = match action {
        InstallAction::Replaced => (
            "updated",
            format!(
                "updated bsk from {} to {}",
                candidate.current, candidate.latest
            ),
        ),
        InstallAction::Staged => (
            "staged",
            format!(
                "staged bsk {} for replacement after this command exits",
                candidate.latest
            ),
        ),
    };

    render_report(
        format,
        &UpdateReport {
            status,
            current_version: candidate.current.to_string(),
            latest_version: Some(candidate.latest.to_string()),
            release_url: candidate.release_url,
            asset_url: Some(candidate.asset.url),
            install_action: Some(action_label),
            message,
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
    let binary = download_candidate_binary(candidate, client)?;
    let target = std::env::current_exe().context("locate current bsk executable")?;

    let daemon_was_running = restart_daemon && crate::daemon::info::read_valid()?.is_some();
    if daemon_was_running {
        crate::daemon::start::run_stop().context("stop bsk daemon before update")?;
    }

    let action = replace_binary_for_update(&target, &binary, daemon_was_running)?;

    if daemon_was_running && matches!(action, InstallAction::Replaced) {
        crate::daemon::start::run_start(StartArgs::default())
            .context("restart bsk daemon after update")?;
    }

    Ok(action)
}

/// Download the candidate's release archive, verify its sha256 checksum,
/// and extract the `bsk` binary. Archives without a checksum are
/// refused — auto-update never installs unverifiable bytes.
pub(crate) fn download_candidate_binary(
    candidate: &UpdateCandidate,
    client: &reqwest::blocking::Client,
) -> Result<Vec<u8>> {
    let expected_sha = candidate.asset.sha256.as_deref().with_context(|| {
        format!(
            "release {} does not include a sha256 checksum; cannot safely auto-update",
            candidate.tag
        )
    })?;
    let archive = fetch_bytes_with_client(client, &candidate.asset.url)?;
    verify_sha256(&archive, expected_sha)?;
    let kind = ArchiveKind::from_url(&candidate.asset.url)?;
    extract_bsk_binary(&archive, kind)
}

/// Daemon-side install: download, verify, and replace the executable at
/// `target` (on Windows: stage the replacement next to it). Unlike the
/// CLI path this never stops or starts the daemon — the daemon drives
/// its own restart once the binary is replaced.
///
/// `target` must be captured *before* any replacement happens: on Linux
/// `std::env::current_exe` starts returning a ` (deleted)`-suffixed
/// path once the running binary has been replaced on disk.
pub(crate) fn self_install_candidate(
    candidate: &UpdateCandidate,
    target: &Path,
) -> Result<InstallAction> {
    let client = update_http_client(ARCHIVE_FETCH_TIMEOUT)?;
    let binary = download_candidate_binary(candidate, &client)?;
    replace_binary_at_path(target, &binary)
}

/// Outcome of one daemon auto-update step (see [`auto_update_step`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AutoUpdateOutcome {
    /// The manifest names no newer version.
    UpToDate,
    /// A newer version exists but auto-update is switched off — the
    /// refreshed cache still feeds the CLI hint.
    Disabled { latest: String },
    /// Live agent sessions block replacing the binary; the next tick
    /// retries.
    PostponedSessions { latest: String, sessions: usize },
    /// The new binary replaced the old one; the daemon should now
    /// restart into it.
    Replaced { latest: String },
    /// Windows staged the replacement next to the running binary; a
    /// daemon/terminal restart finishes it.
    Staged { latest: String },
}

/// The daemon's auto-update step for one tick: decide whether the
/// fetched `candidate` may be installed (auto-update on, no live agent
/// sessions) and, only then, run `install`. The installer is injectable
/// so tests never touch a real binary.
pub(crate) fn auto_update_step(
    candidate: Option<&UpdateCandidate>,
    auto_update_enabled: bool,
    active_sessions: usize,
    install: impl FnOnce(&UpdateCandidate) -> Result<InstallAction>,
) -> Result<AutoUpdateOutcome> {
    let Some(candidate) = candidate else {
        return Ok(AutoUpdateOutcome::UpToDate);
    };
    let latest = candidate.latest.to_string();
    if !auto_update_enabled {
        return Ok(AutoUpdateOutcome::Disabled { latest });
    }
    if active_sessions > 0 {
        return Ok(AutoUpdateOutcome::PostponedSessions {
            latest,
            sessions: active_sessions,
        });
    }
    Ok(match install(candidate)? {
        InstallAction::Replaced => AutoUpdateOutcome::Replaced { latest },
        InstallAction::Staged => AutoUpdateOutcome::Staged { latest },
    })
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

/// Whether daemon-side auto-upgrade is enabled. On by default; only
/// [`AUTO_UPDATE_ENV`]`=off` disables it. This is the single place the
/// switch is interpreted — the daemon periodic task and the CLI hint
/// both go through it so they always agree.
pub(crate) fn auto_update_enabled() -> bool {
    auto_update_enabled_from(std::env::var(AUTO_UPDATE_ENV).ok().as_deref())
}

fn auto_update_enabled_from(value: Option<&str>) -> bool {
    !matches!(value, Some(value) if value.trim().eq_ignore_ascii_case("off"))
}

pub fn update_hint_for_manifest(
    manifest: &UpdateManifest,
    current_version: &str,
    platform_key: &str,
    auto_update: bool,
) -> Result<Option<String>> {
    Ok(manifest
        .update_candidate(current_version, platform_key)?
        .map(|candidate| update_hint_text(&candidate.current, &candidate.latest, auto_update)))
}

fn update_hint_for_cache(
    cache: &UpdateCheckCache,
    current_version: &str,
    auto_update: bool,
) -> Option<String> {
    let latest = cache.latest_version.as_str();
    let current = Version::parse(current_version.trim_start_matches('v')).ok()?;
    let latest_version = Version::parse(latest.trim_start_matches('v')).ok()?;
    (latest_version > current).then(|| update_hint_text(&current, &latest_version, auto_update))
}

/// CLI hint wording. With auto-update on, the daemon upgrades bsk
/// itself so the hint only announces that; with it off, the hint keeps
/// pointing at the manual `bsk update`.
fn update_hint_text(current: &Version, latest: &Version, auto_update: bool) -> String {
    if auto_update {
        format!(
            "A new bsk version is available: {current} -> {latest}. The daemon will upgrade bsk automatically."
        )
    } else {
        format!("A new bsk version is available: {current} -> {latest}. Run `bsk update`.")
    }
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

pub(crate) fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Decide whether the update cache needs a network refresh: a missing
/// cache always does, a present one only once it is no longer fresh.
pub(crate) fn cache_needs_refresh(
    cache: Option<&UpdateCheckCache>,
    now_epoch_secs: u64,
    interval: Duration,
) -> bool {
    match cache {
        Some(cache) => !cache.is_fresh(now_epoch_secs, interval),
        None => true,
    }
}

/// Fetch the update manifest and rewrite the cache. Returns the update
/// candidate when the manifest names a newer version. Blocking: call
/// from a blocking context (the daemon wraps it in `spawn_blocking`).
pub(crate) fn refresh_update_cache(cache_path: &Path) -> Result<Option<UpdateCandidate>> {
    let manifest = fetch_manifest(&manifest_url())?;
    let platform = current_platform_key()?;
    let candidate = manifest.update_candidate(env!("CARGO_PKG_VERSION"), platform)?;
    write_update_cache(
        cache_path,
        &UpdateCheckCache {
            checked_at_epoch_secs: now_epoch_secs(),
            latest_version: manifest.version.to_string(),
        },
    )?;
    Ok(candidate)
}

/// Print the cached "new version available" hint, if there is one.
///
/// Read-only by design: the daemon's periodic task owns refreshing
/// `~/.bsk/update-check.json`, so a missing or stale cache just means
/// "stay quiet" — this function never spawns threads or touches the
/// network. (The old implementation spawned a detached refresh thread
/// that the exiting CLI process almost always killed before it could
/// write the cache, so the hint never fired.)
pub fn print_update_hint_from_cache(flags: &super::GlobalFlags, command: &super::Command) {
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
    match cached_update_hint(
        &cache_path,
        env!("CARGO_PKG_VERSION"),
        now_epoch_secs(),
        auto_update_enabled(),
    ) {
        Ok(Some(hint)) => eprintln!("{hint}"),
        Ok(None) => {}
        Err(err) => {
            tracing::debug!(error = %err, "update cache read failed");
        }
    }
}

/// The hint to show for a cache file: only when the cache is present,
/// fresh, and names a version newer than `current_version`.
fn cached_update_hint(
    cache_path: &Path,
    current_version: &str,
    now_epoch_secs: u64,
    auto_update: bool,
) -> Result<Option<String>> {
    let Some(cache) = read_update_cache(cache_path)? else {
        return Ok(None);
    };
    if !cache.is_fresh(now_epoch_secs, UPDATE_CHECK_INTERVAL) {
        return Ok(None);
    }
    Ok(update_hint_for_cache(&cache, current_version, auto_update))
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
                println!("the detached update helper will apply the replacement after exit");
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
    replace_binary_for_update(target, binary, false)
}

fn replace_binary_for_update(
    target: &Path,
    binary: &[u8],
    restart_daemon: bool,
) -> Result<InstallAction> {
    #[cfg(windows)]
    {
        stage_windows_replacement(target, binary, restart_daemon)
    }

    #[cfg(not(windows))]
    {
        let _ = restart_daemon;
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
fn stage_windows_replacement(
    target: &Path,
    binary: &[u8],
    restart_daemon: bool,
) -> Result<InstallAction> {
    let paths = staged_replacement_paths(target, std::process::id())?;
    std::fs::write(&paths.binary_path, binary)
        .with_context(|| format!("write {}", paths.binary_path.display()))?;
    std::fs::write(
        &paths.script_path,
        windows_replacement_script(target, &paths.binary_path, restart_daemon),
    )
    .with_context(|| format!("write {}", paths.script_path.display()))?;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let command = format!("\"{}\"", paths.script_path.display());
    if let Err(err) = Command::new("cmd.exe")
        .args(["/D", "/S", "/C"])
        .arg(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        let _ = std::fs::remove_file(&paths.binary_path);
        let _ = std::fs::remove_file(&paths.script_path);
        return Err(err).context("launch detached Windows update helper");
    }
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

#[cfg(any(windows, test))]
fn windows_replacement_script(target: &Path, staged_binary: &Path, restart_daemon: bool) -> String {
    let target = target.display().to_string().replace('%', "%%");
    let staged_binary = staged_binary.display().to_string().replace('%', "%%");
    let restart = if restart_daemon {
        format!("start \"\" /B \"{target}\" daemon start >nul 2>nul\r\n")
    } else {
        String::new()
    };
    format!(
        "@echo off\r\n\
         setlocal\r\n\
         :retry\r\n\
         move /Y \"{staged_binary}\" \"{target}\" >nul 2>nul\r\n\
         if errorlevel 1 (\r\n\
           timeout /t 1 /nobreak >nul\r\n\
           goto retry\r\n\
         )\r\n\
         {restart}\
         del /F /Q \"%~f0\" >nul 2>nul\r\n"
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
    fn windows_replacement_script_retries_restarts_and_cleans_itself() {
        let script = windows_replacement_script(
            Path::new(r"C:\Program Files\bsk.exe"),
            Path::new(r"C:\Program Files\bsk.exe.update-42"),
            true,
        );

        assert!(script.contains(":retry"));
        assert!(script.contains("move /Y"));
        assert!(script.contains(r#"start "" /B "C:\Program Files\bsk.exe" daemon start"#));
        assert!(script.contains(r#"del /F /Q "%~f0""#));
    }

    #[test]
    fn windows_replacement_script_omits_restart_when_daemon_was_not_running() {
        let script = windows_replacement_script(
            Path::new(r"C:\bsk.exe"),
            Path::new(r"C:\bsk.exe.update-42"),
            false,
        );

        assert!(!script.contains("daemon start"));
        assert!(script.contains(r#"del /F /Q "%~f0""#));
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

        // Auto-update off: the hint keeps pointing at `bsk update`.
        let hint = update_hint_for_manifest(&manifest, "0.1.7", "linux-x64", false).unwrap();
        assert_eq!(
            hint.as_deref(),
            Some("A new bsk version is available: 0.1.7 -> 0.2.0. Run `bsk update`.")
        );
        // Auto-update on: the daemon upgrades bsk itself.
        let hint = update_hint_for_manifest(&manifest, "0.1.7", "linux-x64", true).unwrap();
        assert_eq!(
            hint.as_deref(),
            Some(
                "A new bsk version is available: 0.1.7 -> 0.2.0. The daemon will upgrade bsk automatically."
            )
        );
        assert!(
            update_hint_for_manifest(&manifest, "0.2.0", "linux-x64", true)
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

    #[test]
    fn update_check_interval_is_thirty_minutes() {
        assert_eq!(UPDATE_CHECK_INTERVAL, Duration::from_secs(1800));
    }

    #[test]
    fn cache_needs_refresh_only_when_missing_or_stale() {
        let fresh = UpdateCheckCache {
            checked_at_epoch_secs: 1000,
            latest_version: "0.2.0".to_string(),
        };
        let stale = UpdateCheckCache {
            checked_at_epoch_secs: 100,
            latest_version: "0.2.0".to_string(),
        };
        let now = 1000 + UPDATE_CHECK_INTERVAL.as_secs();

        assert!(cache_needs_refresh(None, now, UPDATE_CHECK_INTERVAL));
        assert!(!cache_needs_refresh(
            Some(&fresh),
            now,
            UPDATE_CHECK_INTERVAL
        ));
        assert!(cache_needs_refresh(
            Some(&stale),
            now,
            UPDATE_CHECK_INTERVAL
        ));
    }

    #[test]
    fn daemon_refresh_window_is_shorter_than_tick() {
        // 25 minutes: 5/6 of the 30-minute tick.
        assert_eq!(DAEMON_REFRESH_WINDOW, Duration::from_secs(1500));
        assert!(DAEMON_REFRESH_WINDOW < UPDATE_CHECK_INTERVAL);
    }

    #[test]
    fn daemon_refresh_window_refreshes_every_tick_in_steady_state() {
        // A cache written just after tick N must count as stale at tick
        // N+1 (30 minutes later), so every tick really refetches.
        let cache = UpdateCheckCache {
            checked_at_epoch_secs: 10_000,
            latest_version: "0.2.0".to_string(),
        };
        let next_tick = 10_000 + UPDATE_CHECK_INTERVAL.as_secs();
        assert!(cache_needs_refresh(
            Some(&cache),
            next_tick,
            DAEMON_REFRESH_WINDOW
        ));

        // ... while a daemon restarted with a cache younger than the
        // refresh window still skips the fetch.
        let just_checked = 10_000 + Duration::from_secs(10 * 60).as_secs();
        assert!(!cache_needs_refresh(
            Some(&cache),
            just_checked,
            DAEMON_REFRESH_WINDOW
        ));
    }

    #[test]
    fn cached_update_hint_only_for_fresh_newer_cache() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("update-check.json");
        let now = now_epoch_secs();

        // Missing cache -> no hint.
        assert_eq!(
            cached_update_hint(&path, "0.1.7", now, false).unwrap(),
            None
        );

        // Fresh cache with a newer version -> hint, worded by the
        // auto-update switch.
        let fresh_newer = UpdateCheckCache {
            checked_at_epoch_secs: now,
            latest_version: "0.2.0".to_string(),
        };
        write_update_cache(&path, &fresh_newer).unwrap();
        assert_eq!(
            cached_update_hint(&path, "0.1.7", now, false).unwrap(),
            Some("A new bsk version is available: 0.1.7 -> 0.2.0. Run `bsk update`.".to_string())
        );
        assert_eq!(
            cached_update_hint(&path, "0.1.7", now, true).unwrap(),
            Some(
                "A new bsk version is available: 0.1.7 -> 0.2.0. The daemon will upgrade bsk automatically.".to_string()
            )
        );

        // Fresh cache without a newer version -> no hint.
        let fresh_current = UpdateCheckCache {
            checked_at_epoch_secs: now,
            latest_version: "0.1.7".to_string(),
        };
        write_update_cache(&path, &fresh_current).unwrap();
        assert_eq!(cached_update_hint(&path, "0.1.7", now, true).unwrap(), None);

        // Stale cache, even with a newer version -> no hint.
        let stale_newer = UpdateCheckCache {
            checked_at_epoch_secs: now - UPDATE_CHECK_INTERVAL.as_secs() - 1,
            latest_version: "0.2.0".to_string(),
        };
        write_update_cache(&path, &stale_newer).unwrap();
        assert_eq!(cached_update_hint(&path, "0.1.7", now, true).unwrap(), None);

        // Corrupt cache file -> error surfaced to the caller, no panic.
        std::fs::write(&path, b"not json").unwrap();
        assert!(cached_update_hint(&path, "0.1.7", now, true).is_err());
    }

    #[test]
    fn auto_update_toggle_defaults_on_and_only_off_disables() {
        assert!(auto_update_enabled_from(None));
        assert!(auto_update_enabled_from(Some("on")));
        assert!(auto_update_enabled_from(Some("1")));
        assert!(auto_update_enabled_from(Some("")));
        assert!(!auto_update_enabled_from(Some("off")));
        assert!(!auto_update_enabled_from(Some("OFF")));
        assert!(!auto_update_enabled_from(Some("  Off  ")));
    }

    fn test_candidate() -> UpdateCandidate {
        UpdateCandidate {
            current: Version::parse("0.1.7").unwrap(),
            latest: Version::parse("0.2.0").unwrap(),
            tag: "cli-v0.2.0".to_string(),
            release_url: None,
            asset: ManifestAsset {
                url: "https://example.test/bsk.tar.gz".to_string(),
                sha256: Some("abc123".to_string()),
            },
        }
    }

    #[test]
    fn auto_update_step_reports_up_to_date_without_candidate() {
        let outcome = auto_update_step(None, true, 0, |_| panic!("install must not run")).unwrap();
        assert_eq!(outcome, AutoUpdateOutcome::UpToDate);
    }

    #[test]
    fn auto_update_step_keeps_cache_only_when_disabled() {
        let candidate = test_candidate();
        let outcome = auto_update_step(Some(&candidate), false, 0, |_| {
            panic!("install must not run")
        })
        .unwrap();
        assert_eq!(
            outcome,
            AutoUpdateOutcome::Disabled {
                latest: "0.2.0".to_string()
            }
        );
    }

    #[test]
    fn auto_update_step_postpones_with_active_sessions() {
        let candidate = test_candidate();
        let outcome = auto_update_step(Some(&candidate), true, 2, |_| {
            panic!("install must not run")
        })
        .unwrap();
        assert_eq!(
            outcome,
            AutoUpdateOutcome::PostponedSessions {
                latest: "0.2.0".to_string(),
                sessions: 2,
            }
        );
    }

    #[test]
    fn auto_update_step_installs_when_no_sessions() {
        let candidate = test_candidate();
        let installs = std::cell::Cell::new(0);
        let outcome = auto_update_step(Some(&candidate), true, 0, |candidate| {
            installs.set(installs.get() + 1);
            assert_eq!(candidate.latest.to_string(), "0.2.0");
            Ok(InstallAction::Replaced)
        })
        .unwrap();
        assert_eq!(installs.get(), 1);
        assert_eq!(
            outcome,
            AutoUpdateOutcome::Replaced {
                latest: "0.2.0".to_string()
            }
        );
    }

    #[test]
    fn auto_update_step_staged_outcome_requests_no_restart() {
        // The Windows shape: the replacement is staged next to the
        // running binary, so the outcome must not ask for the immediate
        // self-restart that `Replaced` triggers.
        let candidate = test_candidate();
        let outcome =
            auto_update_step(Some(&candidate), true, 0, |_| Ok(InstallAction::Staged)).unwrap();
        assert_eq!(
            outcome,
            AutoUpdateOutcome::Staged {
                latest: "0.2.0".to_string()
            }
        );
    }

    #[test]
    fn auto_update_step_propagates_install_errors() {
        let candidate = test_candidate();
        let result = auto_update_step(Some(&candidate), true, 0, |_| bail!("boom"));
        assert!(result.is_err());
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
