//! Domestic downloads first, with a version-pinned GitHub fallback. Explicit
//! manifest overrides remain isolated from the built-in public sources.

use super::*;

pub const DEFAULT_MANIFEST_URL: &str = "https://mmsprxiaoweicos-1258344707.cos.ap-shanghai.myqcloud.com/chatbot/deepsearch/downloads/browserskill/stable/version.json";
const DOMESTIC_DOWNLOAD_BASE: &str = "https://mmsprxiaoweicos-1258344707.cos.ap-shanghai.myqcloud.com/chatbot/deepsearch/downloads/browserskill/stable";
const GITHUB_MANIFEST_URL: &str =
    "https://github.com/Tencent/BrowserSkill/releases/latest/download/version.json";
const GITHUB_RELEASE_BASE: &str = "https://github.com/Tencent/BrowserSkill/releases/download";
const RECOVERY_HINT: &str = "Check your network/proxy settings and retry `bsk update`.";

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct SourcesFailed {
    message: String,
}

pub(crate) fn recovery_hint(error: &anyhow::Error) -> Option<&'static str> {
    error.downcast_ref::<SourcesFailed>().map(|_| RECOVERY_HINT)
}

#[cfg(test)]
mod tests;

struct Sources<'a> {
    domestic_manifest: &'a str,
    domestic_base: &'a str,
    github_manifest: &'a str,
}

pub(super) fn fetch_update_manifest() -> Result<UpdateManifest> {
    let client = update_http_client(FETCH_TIMEOUT)?;
    Sources {
        domestic_manifest: DEFAULT_MANIFEST_URL,
        domestic_base: DOMESTIC_DOWNLOAD_BASE,
        github_manifest: GITHUB_MANIFEST_URL,
    }
    .fetch_manifest(
        &client,
        std::env::var("BSK_UPDATE_MANIFEST_URL").ok().as_deref(),
        env!("CARGO_PKG_VERSION"),
        current_platform_key()?,
    )
}

impl Sources<'_> {
    fn fetch_manifest(
        &self,
        client: &reqwest::blocking::Client,
        override_url: Option<&str>,
        current_version: &str,
        platform: &str,
    ) -> Result<UpdateManifest> {
        if let Some(url) = override_url {
            return try_sources("fetch the bsk update manifest", [("custom", url)], |url| {
                fetch_manifest_with_client(client, url)
            });
        }

        try_sources(
            "fetch the bsk update manifest",
            [
                ("domestic", self.domestic_manifest),
                ("GitHub fallback", self.github_manifest),
            ],
            |url| {
                let mut manifest = fetch_manifest_with_client(client, url)?;
                // The website currently mirrors version.json unchanged, so
                // its asset URLs still point to GitHub. Use the website's
                // platform filenames, retaining the manifest's checksum.
                // Also prefer domestic archives when only the domestic
                // manifest failed and GitHub supplied the metadata instead.
                for (key, filename, target) in [
                    (
                        "darwin-arm64",
                        "bsk-macos-arm64.tar.gz",
                        "aarch64-apple-darwin",
                    ),
                    (
                        "darwin-x64",
                        "bsk-macos-intel.tar.gz",
                        "x86_64-apple-darwin",
                    ),
                    (
                        "linux-arm64",
                        "bsk-linux-arm64.tar.gz",
                        "aarch64-unknown-linux-musl",
                    ),
                    (
                        "linux-x64",
                        "bsk-linux-x64.tar.gz",
                        "x86_64-unknown-linux-musl",
                    ),
                    (
                        "windows-x64",
                        "bsk-windows-x64.zip",
                        "x86_64-pc-windows-msvc",
                    ),
                ] {
                    if let Some(asset) = manifest.assets.get_mut(key) {
                        let suffix = if key == "windows-x64" {
                            "zip"
                        } else {
                            "tar.gz"
                        };
                        asset.url = format!("{}/{filename}", self.domestic_base);
                        // Pin the fallback to this manifest's release;
                        // never combine latest-version bytes with its hash.
                        asset.fallback_url = Some(format!(
                            "{GITHUB_RELEASE_BASE}/{}/bsk-v{}-{target}.{suffix}",
                            manifest.tag, manifest.version
                        ));
                    }
                }
                if let Some(candidate) = manifest.update_candidate(current_version, platform)? {
                    anyhow::ensure!(
                        candidate.asset.sha256.as_ref().is_some_and(|sha| {
                            sha.len() == 64 && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
                        }),
                        "release {} has no valid SHA256 checksum for platform `{platform}`",
                        manifest.tag
                    );
                }
                Ok(manifest)
            },
        )
    }
}

/// Keep every source's URL and complete cause chain in the final error, for
/// both human and JSON CLI output and the daemon's update-state record.
pub(super) fn try_sources<'a, T>(
    action: &str,
    sources: impl IntoIterator<Item = (&'a str, &'a str)>,
    mut attempt: impl FnMut(&str) -> Result<T>,
) -> Result<T> {
    let mut failures = Vec::new();
    for (name, url) in sources {
        match attempt(url) {
            Ok(value) => return Ok(value),
            Err(err) => {
                tracing::warn!(source = name, url, error = %format_args!("{err:#}"), "update source failed");
                failures.push(format!("{name} ({url}): {err:#}"));
            }
        }
    }
    Err(anyhow::Error::new(SourcesFailed {
        message: format!(
            "could not {action}; all configured sources failed:\n{}\n{RECOVERY_HINT}",
            failures.join("\n")
        ),
    }))
}
