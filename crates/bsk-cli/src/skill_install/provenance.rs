//! Versioned ownership records. A pending bundle records both sides of each
//! replacement so a later pass can distinguish interrupted writes from user edits.

use super::{SOURCE_BUNDLED, SOURCE_CUSTOM, SkillSource, bundle::valid_path};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

pub(super) type FileHashes = BTreeMap<String, String>;
pub(super) type PreviousFiles = BTreeMap<String, Option<String>>;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Provenance {
    Missing,
    Custom,
    LegacyBundled,
    Bundled { sha256: String },
    Bundle(BundleMarker),
    Invalid,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LegacyMarker {
    version: u8,
    source: SkillSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct BundleMarker {
    version: u8,
    source: SkillSource,
    pub files: FileHashes,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<PreviousFiles>,
}

impl BundleMarker {
    pub fn new(files: FileHashes, previous: Option<PreviousFiles>) -> Self {
        Self {
            version: 2,
            source: SkillSource::Bundled,
            files,
            previous,
        }
    }

    pub fn encode(&self) -> Result<String> {
        Ok(format!("{}\n", serde_json::to_string(self)?))
    }

    fn valid(&self) -> bool {
        self.version == 2
            && self.source == SkillSource::Bundled
            && self.files.contains_key("SKILL.md")
            && self
                .files
                .iter()
                .all(|(name, hash)| valid_path(name) && valid_hash(hash))
            && self.previous.as_ref().is_none_or(|previous| {
                self.files.keys().all(|name| previous.contains_key(name))
                    && previous.iter().all(|(name, hash)| {
                        valid_path(name) && hash.as_ref().is_none_or(|h| valid_hash(h))
                    })
            })
    }
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn digest(content: &[u8]) -> String {
    Sha256::digest(content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn known_legacy(hash: &str) -> bool {
    include_str!("legacy-digests.txt")
        .lines()
        .any(|line| line == hash)
}

#[cfg(test)]
pub(super) fn bundled_marker(content: &[u8]) -> Result<String> {
    Ok(format!(
        "{}\n",
        serde_json::to_string(&LegacyMarker {
            version: 1,
            source: SkillSource::Bundled,
            sha256: Some(digest(content)),
        })?
    ))
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
    if let Ok(marker) = serde_json::from_slice::<BundleMarker>(&bytes) {
        return Ok(if marker.valid() {
            Provenance::Bundle(marker)
        } else {
            Provenance::Invalid
        });
    }
    match serde_json::from_slice::<LegacyMarker>(&bytes) {
        Ok(LegacyMarker {
            version: 1,
            source: SkillSource::Custom,
            ..
        }) => Ok(Provenance::Custom),
        Ok(LegacyMarker {
            version: 1,
            source: SkillSource::Bundled,
            sha256: Some(hash),
        }) if valid_hash(&hash.to_ascii_lowercase()) => Ok(Provenance::Bundled {
            sha256: hash.to_ascii_lowercase(),
        }),
        _ => Ok(Provenance::Invalid),
    }
}
