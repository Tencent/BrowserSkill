//! `bsk update` — check for and install CLI updates.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

pub mod state;
#[cfg(windows)]
mod windows;

use anyhow::{Context, Result, bail};
use clap::Args;
use flate2::read::GzDecoder;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use self::state::{Recovery, SkipReason, UpdateLock, UpdateRecord, UpdateSource, UpdateStage};
use crate::cli::daemon::StartArgs;
use crate::cli::error::{CliError, Format};
use crate::daemon::lockfile;

pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/Tencent/BrowserSkill/releases/latest/download/version.json";
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const ARCHIVE_FETCH_TIMEOUT: Duration = Duration::from_secs(60);
/// A new executable must answer `--version` within this time before any
/// running daemon is asked to switch to it.
const SELF_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
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
    /// Whether the daemon that wrote this cache installs updates itself.
    /// Absent in caches written before the daemon recorded it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_update: Option<bool>,
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

    install_candidate_with_client(&candidate, args.restart_daemon, &client)?;
    render_report(
        format,
        &UpdateReport {
            status: "updated",
            current_version: candidate.current.to_string(),
            latest_version: Some(candidate.latest.to_string()),
            release_url: candidate.release_url,
            asset_url: Some(candidate.asset.url),
            install_action: Some("replaced"),
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

/// `bsk update`: install and self-check the new executable while any daemon
/// keeps serving, and only then restart that daemon from it. If the new
/// daemon does not become ready, put the previous executable back and restart
/// the daemon from that.
fn install_candidate_with_client(
    candidate: &UpdateCandidate,
    restart_daemon: bool,
    client: &reqwest::blocking::Client,
) -> Result<()> {
    let target = std::env::current_exe().context("locate current bsk executable")?;
    if let Err(err) = ensure_replaceable(&target) {
        UpdateRecord::skipped(
            UpdateSource::Command,
            &candidate.latest,
            &target,
            SkipReason::NotWritable,
            Some(&err),
        )
        .save();
        return Err(err.context(installer_hint(&target)));
    }
    let _lock = UpdateLock::try_acquire()?;
    let mut record = UpdateRecord::start(UpdateSource::Command, &candidate.latest, &target);
    record.save();
    let installed = install_verified(candidate, &target, client, &mut record)?;

    let daemon_was_running = match restart_daemon
        .then(crate::daemon::start::stop_if_running)
        .transpose()
    {
        Ok(running) => running.unwrap_or(false),
        Err(err) => {
            let err = err.context("stop bsk daemon before switching to the new version");
            record.fail(&err, installed.roll_back(|| Recovery::Unchanged));
            return Err(err);
        }
    };
    if !daemon_was_running {
        record.succeed(None);
        installed.discard();
        return Ok(());
    }

    record.enter(UpdateStage::Restart);
    // Start from `target`: once it is replaced, Linux no longer reports it as
    // the current executable.
    let start = || crate::daemon::start::start_detached(&target, &StartArgs::default());
    match start() {
        Ok(daemon) => {
            record.succeed(Some((daemon.pid, daemon.version)));
            installed.discard();
            Ok(())
        }
        Err(err) => {
            let err = err.context("restart the daemon from the new version");
            let recovery = installed.roll_back(|| Recovery::Restored {
                daemon_serving: start().is_ok(),
            });
            let restored = matches!(recovery, Recovery::Restored { .. });
            record.fail(&err, recovery);
            if restored {
                Err(err.context(format!(
                    "update to {} rolled back; bsk {} is still installed",
                    candidate.latest, candidate.current
                )))
            } else {
                Err(err)
            }
        }
    }
}

/// Download, install and run the new executable once. On failure the previous
/// executable is back in place (or `record` says how to put it back), and
/// `record` holds the reason.
///
/// `target` must be captured *before* any replacement happens: on Linux
/// `std::env::current_exe` starts returning a ` (deleted)`-suffixed path once
/// the running binary has been replaced on disk.
pub(crate) fn install_verified(
    candidate: &UpdateCandidate,
    target: &Path,
    client: &reqwest::blocking::Client,
    record: &mut UpdateRecord,
) -> Result<Installed> {
    let binary = match download_candidate_binary(candidate, client) {
        Ok(binary) => binary,
        Err(err) => {
            record.fail(&err, Recovery::Unchanged);
            return Err(err);
        }
    };
    record.enter(UpdateStage::Install);
    let installed = match install_binary(target, &binary) {
        Ok(installed) => installed,
        Err(err) => {
            let recovery = match err.downcast_ref::<PreviousNotRestored>() {
                Some(missing) => Recovery::RestoreFailed {
                    action: missing.action(),
                },
                None => Recovery::Unchanged,
            };
            record.fail(&err, recovery);
            return Err(err);
        }
    };
    record.previous_executable = Some(installed.previous.clone());
    record.save();
    if let Err(err) = verify_executable(target) {
        let err = err.context("the new executable failed its self-check");
        record.fail(&err, installed.roll_back(|| Recovery::Unchanged));
        return Err(err);
    }
    Ok(installed)
}

/// Daemon-side install with the daemon's own HTTP client.
pub(crate) fn self_install_candidate(
    candidate: &UpdateCandidate,
    target: &Path,
    record: &mut UpdateRecord,
) -> Result<Installed> {
    let client = update_http_client(ARCHIVE_FETCH_TIMEOUT)?;
    install_verified(candidate, target, &client, record)
}

/// Where to turn when bsk cannot write next to its own executable.
pub(crate) fn installer_hint(target: &Path) -> String {
    format!(
        "update {} with the installer or package manager that put it there",
        target.display()
    )
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

/// What a daemon may do with a newer version it finds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AutoUpdatePolicy {
    /// Install it, then hand over to a replacement daemon.
    Install,
    /// [`AUTO_UPDATE_ENV`]`=off`: only refresh the cache behind the CLI hint.
    Disabled,
    /// A terminal or supervisor owns this daemon (`--foreground`). Only that
    /// owner can restart it, so leave the upgrade to `bsk update`.
    HostManaged,
    /// bsk cannot write next to its executable; its installer must update it.
    NotWritable,
}

/// Outcome of one daemon auto-update step (see [`auto_update_step`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AutoUpdateOutcome<T> {
    /// The manifest names no newer version.
    UpToDate,
    /// A newer version exists but auto-update is switched off — the
    /// refreshed cache still feeds the CLI hint.
    Disabled { latest: Version },
    /// A newer version exists but this daemon's owner must upgrade it.
    HostManaged { latest: Version },
    /// A newer version exists but its installer must put it in place.
    NotWritable { latest: Version },
    /// Live agent sessions block the upgrade; the next tick retries.
    PostponedSessions { latest: Version, sessions: usize },
    /// An earlier attempt at this version failed; retry once `until` passes.
    Deferred { latest: Version, until: u64 },
    /// The new executable is installed and passed its self-check; the daemon
    /// should hand over to it.
    Installed { latest: Version, installed: T },
}

/// The daemon's auto-update step for one tick: decide whether the fetched
/// `candidate` may be installed (policy allows it, no live agent sessions, no
/// recent failure of the same version) and, only then, run `install`. The
/// installer is injectable so tests never touch a real binary.
pub(crate) fn auto_update_step<T>(
    candidate: Option<&UpdateCandidate>,
    policy: AutoUpdatePolicy,
    active_sessions: usize,
    last_attempt: Option<&UpdateRecord>,
    now_epoch_secs: u64,
    install: impl FnOnce(&UpdateCandidate) -> Result<T>,
) -> Result<AutoUpdateOutcome<T>> {
    let Some(candidate) = candidate else {
        return Ok(AutoUpdateOutcome::UpToDate);
    };
    let latest = candidate.latest.clone();
    match policy {
        AutoUpdatePolicy::Install => {}
        AutoUpdatePolicy::Disabled => return Ok(AutoUpdateOutcome::Disabled { latest }),
        AutoUpdatePolicy::HostManaged => return Ok(AutoUpdateOutcome::HostManaged { latest }),
        AutoUpdatePolicy::NotWritable => return Ok(AutoUpdateOutcome::NotWritable { latest }),
    }
    if active_sessions > 0 {
        return Ok(AutoUpdateOutcome::PostponedSessions {
            latest,
            sessions: active_sessions,
        });
    }
    if let Some(until) =
        last_attempt.and_then(|record| record.retry_blocked_until(&latest, now_epoch_secs))
    {
        return Ok(AutoUpdateOutcome::Deferred { latest, until });
    }
    let installed = install(candidate)?;
    Ok(AutoUpdateOutcome::Installed { latest, installed })
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
        .map(|candidate| {
            update_hint_text(
                &candidate.current,
                &candidate.latest,
                HintAction::from_auto_update(auto_update),
            )
        }))
}

/// Who applies the update the hint announces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HintAction<'a> {
    Daemon,
    Command,
    /// bsk cannot write next to this executable.
    Installer(&'a Path),
}

impl HintAction<'_> {
    fn from_auto_update(auto_update: bool) -> Self {
        if auto_update {
            Self::Daemon
        } else {
            Self::Command
        }
    }
}

fn update_hint_for_cache(
    cache: &UpdateCheckCache,
    current_version: &str,
    action: HintAction<'_>,
) -> Option<String> {
    let latest = cache.latest_version.as_str();
    let current = Version::parse(current_version.trim_start_matches('v')).ok()?;
    let latest_version = Version::parse(latest.trim_start_matches('v')).ok()?;
    (latest_version > current).then(|| update_hint_text(&current, &latest_version, action))
}

/// CLI hint wording. With auto-update on, the daemon upgrades bsk itself so
/// the hint only announces that; otherwise it names who must apply it.
fn update_hint_text(current: &Version, latest: &Version, action: HintAction<'_>) -> String {
    let available = format!("A new bsk version is available: {current} -> {latest}.");
    match action {
        HintAction::Daemon => format!("{available} The daemon will upgrade bsk automatically."),
        HintAction::Command => format!("{available} Run `bsk update`."),
        HintAction::Installer(target) => format!(
            "{available} bsk cannot write next to {}; {}.",
            target.display(),
            installer_hint(target)
        ),
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
    write_json_atomically(path, cache)
}

/// Replace `path` with `value` so readers see either the old or the new file.
fn write_json_atomically(path: &Path, value: &impl Serialize) -> Result<()> {
    let dir = path
        .parent()
        .with_context(|| format!("path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let tmp = path.with_file_name(format!(
        "{}.tmp.{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .context("path must have a UTF-8 file name")?,
        std::process::id()
    ));
    let payload =
        serde_json::to_vec_pretty(value).with_context(|| format!("encode {}", path.display()))?;
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

/// Fetch the update manifest and rewrite the cache, recording whether this
/// daemon installs updates itself. Returns the update candidate when the
/// manifest names a newer version. Blocking: call from a blocking context
/// (the daemon wraps it in `spawn_blocking`).
pub(crate) fn refresh_update_cache(
    cache_path: &Path,
    auto_update: bool,
) -> Result<Option<UpdateCandidate>> {
    let manifest = fetch_manifest(&manifest_url())?;
    let platform = current_platform_key()?;
    let candidate = manifest.update_candidate(env!("CARGO_PKG_VERSION"), platform)?;
    write_update_cache(
        cache_path,
        &UpdateCheckCache {
            checked_at_epoch_secs: now_epoch_secs(),
            latest_version: manifest.version.to_string(),
            auto_update: Some(auto_update),
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
        state::current().as_ref(),
    ) {
        Ok(Some(hint)) => eprintln!("{hint}"),
        Ok(None) => {}
        Err(err) => {
            tracing::debug!(error = %err, "update cache read failed");
        }
    }
}

/// The hint to show for a cache file: only when the cache is present,
/// fresh, and names a version newer than `current_version`. The daemon's
/// recorded policy wins over this process's `auto_update` switch, and a
/// recorded unwritable installation over both.
fn cached_update_hint(
    cache_path: &Path,
    current_version: &str,
    now_epoch_secs: u64,
    auto_update: bool,
    last_attempt: Option<&UpdateRecord>,
) -> Result<Option<String>> {
    let Some(cache) = read_update_cache(cache_path)? else {
        return Ok(None);
    };
    if !cache.is_fresh(now_epoch_secs, UPDATE_CHECK_INTERVAL) {
        return Ok(None);
    }
    let installer = Version::parse(cache.latest_version.trim_start_matches('v'))
        .ok()
        .and_then(|latest| {
            last_attempt.filter(|record| record.skips(&latest, SkipReason::NotWritable))
        })
        .map(|record| record.executable.as_path());
    let action = match installer {
        Some(target) => HintAction::Installer(target),
        None => HintAction::from_auto_update(cache.auto_update.unwrap_or(auto_update)),
    };
    Ok(update_hint_for_cache(&cache, current_version, action))
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

/// A new executable at `target`. The previous one stays next to it until the
/// new version is confirmed, so a failed handover or restart can put it back.
#[derive(Debug)]
pub(crate) struct Installed {
    target: PathBuf,
    previous: PathBuf,
}

impl Installed {
    /// Put the previous executable back at `target`.
    pub(crate) fn restore(&self) -> Result<()> {
        #[cfg(windows)]
        {
            windows::restore(&self.target, &self.previous)
        }

        #[cfg(not(windows))]
        {
            std::fs::rename(&self.previous, &self.target).map_err(|err| {
                anyhow::Error::new(PreviousNotRestored {
                    previous: self.previous.clone(),
                    target: self.target.clone(),
                })
                .context(err)
            })?;
            if let Some(dir) = self.target.parent() {
                sync_dir(dir);
            }
            Ok(())
        }
    }

    /// Restore the previous executable, reporting the outcome as `restored`
    /// or as the manual step that is left.
    pub(crate) fn roll_back(&self, restored: impl FnOnce() -> Recovery) -> Recovery {
        match self.restore() {
            Ok(()) => restored(),
            Err(err) => {
                tracing::error!(error = %format_args!("{err:#}"), "could not restore the previous bsk executable");
                self.restore_failed()
            }
        }
    }

    /// The recovery step left to the user when [`Self::restore`] failed.
    pub(crate) fn restore_failed(&self) -> Recovery {
        Recovery::RestoreFailed {
            action: PreviousNotRestored {
                previous: self.previous.clone(),
                target: self.target.clone(),
            }
            .action(),
        }
    }

    /// The new version is confirmed. A previous executable that is still
    /// running (Windows) is removed by a later cleanup instead.
    pub(crate) fn discard(self) {
        let _ = std::fs::remove_file(&self.previous);
    }
}

/// The previous executable is no longer at the target path; only the user can
/// move it back.
#[derive(Debug, thiserror::Error)]
#[error("the previous bsk executable could not be moved back to {target}")]
pub(crate) struct PreviousNotRestored {
    pub(crate) previous: PathBuf,
    pub(crate) target: PathBuf,
}

impl PreviousNotRestored {
    fn action(&self) -> String {
        format!(
            "stop bsk, then move {} to {}",
            self.previous.display(),
            self.target.display()
        )
    }
}

/// Put `binary` at `target`, even while `target` is running: running
/// processes keep their image and every later launch uses the new binary.
fn install_binary(target: &Path, binary: &[u8]) -> Result<Installed> {
    #[cfg(windows)]
    let previous = windows::replace(target, binary)?;

    #[cfg(not(windows))]
    let previous = replace_binary_atomically(target, binary)?;

    Ok(Installed {
        target: target.to_path_buf(),
        previous,
    })
}

/// Swap `binary` in with one rename, keeping a link to the previous
/// executable. Returns where the previous executable is kept.
#[cfg(not(windows))]
fn replace_binary_atomically(target: &Path, binary: &[u8]) -> Result<PathBuf> {
    let dir = target
        .parent()
        .with_context(|| format!("target path has no parent: {}", target.display()))?;
    let staged = sibling(target, &format!("new-{}", unique_suffix()))?;
    let previous = sibling(target, &format!("old-{}", unique_suffix()))?;
    let result = (|| {
        write_synced(&staged, binary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
                .with_context(|| format!("chmod 0755 {}", staged.display()))?;
        }
        // A hard link keeps the running image reachable at no cost; file
        // systems without links get a copy.
        if std::fs::hard_link(target, &previous).is_err() {
            std::fs::copy(target, &previous)
                .with_context(|| format!("keep {} as {}", target.display(), previous.display()))?;
        }
        std::fs::rename(&staged, target)
            .with_context(|| format!("rename {} to {}", staged.display(), target.display()))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staged);
        let _ = std::fs::remove_file(&previous);
    }
    result?;
    sync_dir(dir);
    Ok(previous)
}

/// Whether bsk can put a new executable next to `target`. An installation it
/// cannot write belongs to the installer or package manager that made it.
pub(crate) fn ensure_replaceable(target: &Path) -> Result<()> {
    let dir = target
        .parent()
        .with_context(|| format!("target path has no parent: {}", target.display()))?;
    let probe = sibling(target, &format!("new-{}", unique_suffix()))?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .with_context(|| format!("bsk cannot create files in {}", dir.display()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Run the new executable once, so a binary that cannot start on this system
/// is caught before any daemon depends on it.
fn verify_executable(exe: &Path) -> Result<()> {
    let mut command = std::process::Command::new(exe);
    command
        .arg("--version")
        .env_remove(crate::daemon::start::DAEMONIZED_ENV)
        .env_remove(crate::daemon::start::DAEMON_REPLACEMENT_WAIT_ENV)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("run {} --version", exe.display()))?;
    let deadline = Instant::now() + SELF_CHECK_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "`{} --version` did not finish within {SELF_CHECK_TIMEOUT:?}",
                exe.display()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    anyhow::ensure!(
        status.success() && stdout.starts_with("bsk "),
        "`{} --version` exited with {status} and printed {:?}",
        exe.display(),
        stdout.trim()
    );
    Ok(())
}

/// Best-effort removal of what earlier updates left next to `exe`: previous
/// executables and staged binaries whose owning process has exited, plus
/// files of the former Windows script updater. A previous executable that is
/// still running cannot be deleted on Windows and stays for a later cleanup.
pub(crate) fn remove_update_leftovers(exe: &Path) {
    for leftover in update_leftovers(exe) {
        let removable = match leftover.owner {
            Some(pid) => !lockfile::pid_alive(pid),
            None => leftover.expired,
        };
        if !removable {
            continue;
        }
        #[cfg(windows)]
        windows::report_legacy_helper(&leftover.path);
        let _ = std::fs::remove_file(&leftover.path);
    }
}

/// A file an update left next to the executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Leftover {
    pub(crate) path: PathBuf,
    /// The process that created it, while it may still need the file.
    pub(crate) owner: Option<u32>,
    /// For files without an owner: old enough that nothing can use them.
    pub(crate) expired: bool,
}

/// Files earlier updates left next to `exe`.
pub(crate) fn update_leftovers(exe: &Path) -> Vec<Leftover> {
    let (Some(dir), Some(name)) = (exe.parent(), exe.file_name().and_then(|name| name.to_str()))
    else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let owned = [format!(".{name}.old-"), format!(".{name}.new-")];
    let mut leftovers = Vec::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if let Some(suffix) = owned
            .iter()
            .find_map(|prefix| file_name.strip_prefix(prefix.as_str()))
        {
            // An unparsable owner can never be confirmed exited; treat it
            // like one that has.
            leftovers.push(Leftover {
                path: entry.path(),
                owner: owner_pid(suffix),
                expired: true,
            });
            continue;
        }
        #[cfg(windows)]
        if let Some(expired) = windows::legacy_helper_file(&entry, name) {
            leftovers.push(Leftover {
                path: entry.path(),
                owner: None,
                expired,
            });
        }
    }
    leftovers.sort_by(|a, b| a.path.cmp(&b.path));
    leftovers
}

/// `.<name>.<suffix>` next to `target`, hidden from directory listings on Unix.
fn sibling(target: &Path, suffix: &str) -> Result<PathBuf> {
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .context("target path must have a UTF-8 file name")?;
    Ok(target.with_file_name(format!(".{name}.{suffix}")))
}

/// `<pid>-<nanos>`: unique per attempt, and names the process that owns it.
fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{}-{nanos}", std::process::id())
}

fn owner_pid(suffix: &str) -> Option<u32> {
    suffix.split_once('-')?.0.parse().ok()
}

/// Write `bytes` to a file and flush them to disk before it is renamed into place.
fn write_synced(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file =
        std::fs::File::create(path).with_context(|| format!("create {}", path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("write {}", path.display()))?;
    file.flush()
        .with_context(|| format!("flush {}", path.display()))?;
    file.sync_all()
        .with_context(|| format!("sync {}", path.display()))
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

    fn dir_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[cfg(not(windows))]
    #[test]
    fn replaces_binary_atomically_and_keeps_the_previous_one() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("bsk");
        std::fs::write(&target, b"old binary").unwrap();

        let installed = install_binary(&target, b"new binary").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new binary");
        assert_eq!(std::fs::read(&installed.previous).unwrap(), b"old binary");
        assert_eq!(dir_names(tmp.path()).len(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o755);
        }

        installed.discard();
        assert_eq!(dir_names(tmp.path()), ["bsk"]);
    }

    #[cfg(not(windows))]
    #[test]
    fn restores_the_previous_binary() {
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("bsk");
        std::fs::write(&target, b"old binary").unwrap();
        let installed = install_binary(&target, b"new binary").unwrap();

        assert_eq!(
            installed.roll_back(|| Recovery::Unchanged),
            Recovery::Unchanged
        );

        assert_eq!(std::fs::read(&target).unwrap(), b"old binary");
        assert_eq!(dir_names(tmp.path()), ["bsk"]);
        // Restoring twice finds nothing to move and names the manual step.
        let error = installed.restore().unwrap_err();
        assert!(
            error.downcast_ref::<PreviousNotRestored>().is_some(),
            "{error:#}"
        );
        let Recovery::RestoreFailed { action } = installed.roll_back(|| Recovery::Unchanged) else {
            panic!("a missing previous executable cannot be restored");
        };
        assert!(
            action.contains(&installed.previous.display().to_string()),
            "{action}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn installation_needs_a_writable_directory() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().unwrap();
        let target = tmp.path().join("bsk");
        std::fs::write(&target, b"old binary").unwrap();
        ensure_replaceable(&target).unwrap();
        assert_eq!(dir_names(tmp.path()), ["bsk"]);

        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let writable = std::fs::File::create(tmp.path().join("probe")).is_ok();
        let result = ensure_replaceable(&target);
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        if writable {
            // Running as root: permissions do not apply.
            return;
        }
        let error = result.unwrap_err();
        assert!(
            format!("{error:#}").contains("cannot create files in"),
            "{error:#}"
        );
        let hint = installer_hint(&target);
        assert!(hint.contains("installer or package manager"), "{hint}");
    }

    #[cfg(unix)]
    fn script(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("bsk");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn self_check_requires_a_bsk_version_line() {
        let tmp = tempfile::TempDir::new().unwrap();
        verify_executable(&script(tmp.path(), "echo 'bsk 9.9.9'")).unwrap();
        for body in ["echo 'bsk 9.9.9'; exit 3", "echo 'not bsk'", "exit 0"] {
            let error = verify_executable(&script(tmp.path(), body)).unwrap_err();
            assert!(
                format!("{error:#}").contains("--version"),
                "{body}: {error:#}"
            );
        }
        let error = verify_executable(&tmp.path().join("missing")).unwrap_err();
        assert!(format!("{error:#}").contains("missing"), "{error:#}");
    }

    #[test]
    fn leftovers_belong_to_their_process_until_it_exits() {
        let tmp = tempfile::TempDir::new().unwrap();
        let exe = tmp.path().join("bsk.exe");
        std::fs::write(&exe, b"current").unwrap();
        let own = std::process::id();
        for name in [
            format!(".bsk.exe.old-{own}-1"),
            format!(".bsk.exe.new-{own}-2"),
            ".bsk.exe.old-4294967295-3".to_string(),
            ".bsk.exe.new-garbage".to_string(),
            ".other.exe.old-1-1".to_string(),
        ] {
            std::fs::write(tmp.path().join(name), b"leftover").unwrap();
        }

        let found: std::collections::BTreeSet<_> = update_leftovers(&exe)
            .into_iter()
            .map(|leftover| {
                let name = leftover
                    .path
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_string();
                (name, leftover.owner)
            })
            .collect();
        assert_eq!(
            found,
            [
                (".bsk.exe.new-garbage".to_string(), None),
                (format!(".bsk.exe.new-{own}-2"), Some(own)),
                (".bsk.exe.old-4294967295-3".to_string(), Some(u32::MAX)),
                (format!(".bsk.exe.old-{own}-1"), Some(own)),
            ]
            .into_iter()
            .collect()
        );

        remove_update_leftovers(&exe);
        assert_eq!(
            dir_names(tmp.path()),
            [
                format!(".bsk.exe.new-{own}-2"),
                format!(".bsk.exe.old-{own}-1"),
                ".other.exe.old-1-1".to_string(),
                "bsk.exe".to_string(),
            ]
        );
    }

    #[test]
    fn cache_freshness_uses_epoch_seconds() {
        let cache = UpdateCheckCache {
            checked_at_epoch_secs: 100,
            latest_version: "0.2.0".to_string(),
            auto_update: None,
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
            auto_update: None,
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
            auto_update: None,
        };
        let stale = UpdateCheckCache {
            checked_at_epoch_secs: 100,
            latest_version: "0.2.0".to_string(),
            auto_update: None,
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
            auto_update: None,
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
            cached_update_hint(&path, "0.1.7", now, false, None).unwrap(),
            None
        );

        // Fresh cache with a newer version -> hint, worded by the
        // auto-update switch.
        let fresh_newer = UpdateCheckCache {
            checked_at_epoch_secs: now,
            latest_version: "0.2.0".to_string(),
            auto_update: None,
        };
        write_update_cache(&path, &fresh_newer).unwrap();
        assert_eq!(
            cached_update_hint(&path, "0.1.7", now, false, None).unwrap(),
            Some("A new bsk version is available: 0.1.7 -> 0.2.0. Run `bsk update`.".to_string())
        );
        assert_eq!(
            cached_update_hint(&path, "0.1.7", now, true, None).unwrap(),
            Some(
                "A new bsk version is available: 0.1.7 -> 0.2.0. The daemon will upgrade bsk automatically.".to_string()
            )
        );

        // Fresh cache without a newer version -> no hint.
        let fresh_current = UpdateCheckCache {
            checked_at_epoch_secs: now,
            latest_version: "0.1.7".to_string(),
            auto_update: None,
        };
        write_update_cache(&path, &fresh_current).unwrap();
        assert_eq!(
            cached_update_hint(&path, "0.1.7", now, true, None).unwrap(),
            None
        );

        // Stale cache, even with a newer version -> no hint.
        let stale_newer = UpdateCheckCache {
            checked_at_epoch_secs: now - UPDATE_CHECK_INTERVAL.as_secs() - 1,
            latest_version: "0.2.0".to_string(),
            auto_update: None,
        };
        write_update_cache(&path, &stale_newer).unwrap();
        assert_eq!(
            cached_update_hint(&path, "0.1.7", now, true, None).unwrap(),
            None
        );

        // Corrupt cache file -> error surfaced to the caller, no panic.
        std::fs::write(&path, b"not json").unwrap();
        assert!(cached_update_hint(&path, "0.1.7", now, true, None).is_err());
    }

    #[test]
    fn cached_update_hint_follows_the_policy_recorded_by_the_daemon() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("update-check.json");
        let now = now_epoch_secs();
        let manual = "A new bsk version is available: 0.1.7 -> 0.2.0. Run `bsk update`.";
        let automatic = "A new bsk version is available: 0.1.7 -> 0.2.0. The daemon will upgrade bsk automatically.";
        for (recorded, local, expected) in [
            (Some(false), true, manual),
            (Some(true), false, automatic),
            (None, true, automatic),
            (None, false, manual),
        ] {
            let cache = UpdateCheckCache {
                checked_at_epoch_secs: now,
                latest_version: "0.2.0".to_string(),
                auto_update: recorded,
            };
            write_update_cache(&path, &cache).unwrap();
            assert_eq!(
                cached_update_hint(&path, "0.1.7", now, local, None)
                    .unwrap()
                    .as_deref(),
                Some(expected),
                "recorded {recorded:?}, local {local}"
            );
        }
    }

    #[test]
    fn cached_update_hint_names_the_installer_when_bsk_cannot_write() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("update-check.json");
        let now = now_epoch_secs();
        write_update_cache(
            &path,
            &UpdateCheckCache {
                checked_at_epoch_secs: now,
                latest_version: "0.2.0".to_string(),
                auto_update: Some(false),
            },
        )
        .unwrap();
        let exe = Path::new("/opt/bsk/bin/bsk");
        let skipped = |target: Version| {
            UpdateRecord::skipped(
                UpdateSource::Daemon,
                &target,
                exe,
                SkipReason::NotWritable,
                None,
            )
        };

        let hint = cached_update_hint(&path, "0.1.7", now, true, Some(&skipped(LATEST)))
            .unwrap()
            .unwrap();
        assert!(
            hint.starts_with("A new bsk version is available: 0.1.7 -> 0.2.0."),
            "{hint}"
        );
        assert!(hint.contains("/opt/bsk/bin/bsk"), "{hint}");
        assert!(hint.contains("installer or package manager"), "{hint}");

        // A record about another version does not change the advice.
        let hint = cached_update_hint(
            &path,
            "0.1.7",
            now,
            true,
            Some(&skipped(Version::new(0, 1, 9))),
        )
        .unwrap()
        .unwrap();
        assert!(hint.ends_with("Run `bsk update`."), "{hint}");
    }

    #[test]
    fn update_check_cache_stays_compatible_with_older_readers_and_writers() {
        let older: UpdateCheckCache =
            serde_json::from_str(r#"{"checked_at_epoch_secs":1,"latest_version":"0.2.0"}"#)
                .unwrap();
        assert_eq!(older.auto_update, None);
        assert!(
            !serde_json::to_string(&older)
                .unwrap()
                .contains("auto_update")
        );

        let recorded = UpdateCheckCache {
            auto_update: Some(false),
            ..older
        };
        let json = serde_json::to_value(&recorded).unwrap();
        assert_eq!(json["auto_update"], false);
        assert_eq!(json["latest_version"], "0.2.0");
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

    fn no_install(_: &UpdateCandidate) -> Result<()> {
        panic!("install must not run")
    }

    const LATEST: Version = Version::new(0, 2, 0);

    fn step(
        candidate: Option<&UpdateCandidate>,
        policy: AutoUpdatePolicy,
        sessions: usize,
        last_attempt: Option<&UpdateRecord>,
    ) -> AutoUpdateOutcome<()> {
        auto_update_step(candidate, policy, sessions, last_attempt, 1_000, no_install).unwrap()
    }

    fn failed_attempt(target: Version, retry_after: u64) -> UpdateRecord {
        UpdateRecord {
            result: state::UpdateResult::Failed,
            retry_after_epoch_secs: Some(retry_after),
            ..UpdateRecord::start(UpdateSource::Daemon, &target, Path::new("bsk"))
        }
    }

    #[test]
    fn auto_update_step_reports_up_to_date_without_candidate() {
        let outcome = step(None, AutoUpdatePolicy::Install, 0, None);
        assert_eq!(outcome, AutoUpdateOutcome::UpToDate);
    }

    #[test]
    fn auto_update_step_installs_only_when_the_policy_allows_it() {
        let candidate = test_candidate();
        for (policy, expected) in [
            (
                AutoUpdatePolicy::Disabled,
                AutoUpdateOutcome::Disabled { latest: LATEST },
            ),
            (
                AutoUpdatePolicy::HostManaged,
                AutoUpdateOutcome::HostManaged { latest: LATEST },
            ),
            (
                AutoUpdatePolicy::NotWritable,
                AutoUpdateOutcome::NotWritable { latest: LATEST },
            ),
        ] {
            assert_eq!(step(Some(&candidate), policy, 0, None), expected);
        }
    }

    #[test]
    fn auto_update_step_postpones_with_active_sessions() {
        let candidate = test_candidate();
        let outcome = step(Some(&candidate), AutoUpdatePolicy::Install, 2, None);
        assert_eq!(
            outcome,
            AutoUpdateOutcome::PostponedSessions {
                latest: LATEST,
                sessions: 2,
            }
        );
    }

    #[test]
    fn auto_update_step_installs_when_no_sessions() {
        let candidate = test_candidate();
        let installs = std::cell::Cell::new(0);
        let outcome = auto_update_step(
            Some(&candidate),
            AutoUpdatePolicy::Install,
            0,
            None,
            1_000,
            |candidate: &UpdateCandidate| {
                installs.set(installs.get() + 1);
                assert_eq!(candidate.latest, LATEST);
                Ok("installed")
            },
        )
        .unwrap();
        assert_eq!(installs.get(), 1);
        assert_eq!(
            outcome,
            AutoUpdateOutcome::Installed {
                latest: LATEST,
                installed: "installed",
            }
        );
    }

    #[test]
    fn auto_update_step_waits_after_a_failed_attempt_at_the_same_version() {
        let candidate = test_candidate();
        let failed = failed_attempt(LATEST, 2_000);
        assert_eq!(
            step(
                Some(&candidate),
                AutoUpdatePolicy::Install,
                0,
                Some(&failed)
            ),
            AutoUpdateOutcome::Deferred {
                latest: LATEST,
                until: 2_000,
            }
        );

        let installed = |last: &UpdateRecord, now| {
            auto_update_step(
                Some(&candidate),
                AutoUpdatePolicy::Install,
                0,
                Some(last),
                now,
                |_| Ok(()),
            )
            .unwrap()
        };
        let retry = AutoUpdateOutcome::Installed {
            latest: LATEST,
            installed: (),
        };
        // Once the wait is over, and for any other version, it installs again.
        assert_eq!(installed(&failed, 2_000), retry);
        assert_eq!(
            installed(&failed_attempt(Version::new(0, 1, 9), 2_000), 1_000),
            retry
        );
    }

    #[test]
    fn auto_update_step_propagates_install_errors() {
        let candidate = test_candidate();
        let result = auto_update_step(
            Some(&candidate),
            AutoUpdatePolicy::Install,
            0,
            None,
            1_000,
            |_| -> Result<()> { bail!("boom") },
        );
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
