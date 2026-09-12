//! Read legacy source markers and record the last managed content in the same
//! atomically replaced marker. A baseline describes what we wrote, not what the
//! current binary happens to bundle.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{SOURCE_BUNDLED, SOURCE_CUSTOM, SkillSource};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Provenance {
    Missing,
    Custom,
    LegacyBundled,
    Bundled { sha256: String },
    Invalid,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Marker {
    version: u8,
    source: SkillSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

pub(super) fn digest(content: &[u8]) -> String {
    Sha256::digest(content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn bundled_marker(content: &[u8]) -> Result<String> {
    let marker = Marker {
        version: 1,
        source: SkillSource::Bundled,
        sha256: Some(digest(content)),
    };
    Ok(format!("{}\n", serde_json::to_string(&marker)?))
}

pub(super) fn read(marker: &Path) -> Result<Provenance> {
    let bytes = match std::fs::read(marker) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Provenance::Missing),
        Err(err) => return Err(err).with_context(|| format!("read {}", marker.display())),
    };
    if bytes == SOURCE_CUSTOM.as_bytes() {
        return Ok(Provenance::Custom);
    }
    if bytes == SOURCE_BUNDLED.as_bytes() {
        return Ok(Provenance::LegacyBundled);
    }
    match serde_json::from_slice::<Marker>(&bytes) {
        Ok(Marker {
            version: 1,
            source: SkillSource::Custom,
            ..
        }) => Ok(Provenance::Custom),
        Ok(Marker {
            version: 1,
            source: SkillSource::Bundled,
            sha256: Some(hash),
        }) if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) => {
            Ok(Provenance::Bundled {
                sha256: hash.to_ascii_lowercase(),
            })
        }
        _ => Ok(Provenance::Invalid),
    }
}
