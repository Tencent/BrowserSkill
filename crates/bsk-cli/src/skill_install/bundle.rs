//! Complete skill packages and safe paths relative to their installation root.

use anyhow::{Context, Result, bail};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use super::provenance::{self, FileHashes};

include!(concat!(env!("OUT_DIR"), "/skill_bundle.rs"));

#[derive(Debug, Clone)]
pub struct SkillBundle {
    pub(super) files: BTreeMap<String, Vec<u8>>,
}

impl SkillBundle {
    pub fn bundled() -> Self {
        Self {
            files: BUNDLED_FILES
                .iter()
                .map(|(name, bytes)| ((*name).to_owned(), bytes.to_vec()))
                .collect(),
        }
    }

    /// A file source remains a single-file custom skill for backwards compatibility.
    pub fn single(content: impl AsRef<[u8]>) -> Self {
        Self {
            files: BTreeMap::from([("SKILL.md".into(), content.as_ref().to_vec())]),
        }
    }

    pub fn load(path: &Path) -> Result<Self> {
        // The user-selected source may be a symlink, as with the legacy file
        // installer. Package entries and destination resources still reject links.
        let metadata =
            fs::metadata(path).with_context(|| format!("read skill source {}", path.display()))?;
        if metadata.is_file() {
            return Ok(Self::single(fs::read_to_string(path)?));
        }
        if !metadata.is_dir() {
            bail!(
                "skill source must be a regular file or directory: {}",
                path.display()
            );
        }
        let mut files = BTreeMap::new();
        collect(path, path, &mut files)?;
        if !files.contains_key("SKILL.md") {
            bail!("skill directory must contain SKILL.md: {}", path.display());
        }
        std::str::from_utf8(&files["SKILL.md"]).context("SKILL.md must be UTF-8 text")?;
        Ok(Self { files })
    }

    pub(super) fn hashes(&self) -> FileHashes {
        self.files
            .iter()
            .map(|(name, bytes)| (name.clone(), provenance::digest(bytes)))
            .collect()
    }
}

fn collect(root: &Path, dir: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        // Do not import installation metadata, locks, temporary files or VCS state.
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let name = path
            .strip_prefix(root)?
            .to_str()
            .context("skill path is not UTF-8")?
            .replace('\\', "/");
        if !valid_path(&name) {
            bail!("invalid skill resource path: {name}");
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect(root, &path, files)?;
        } else if kind.is_file() {
            files.insert(name, fs::read(&path)?);
        } else {
            bail!("skill resources must be regular files: {}", path.display());
        }
    }
    Ok(())
}

pub(super) fn valid_path(name: &str) -> bool {
    !name.is_empty()
        && name.split('/').all(|part| {
            !part.is_empty() && !part.starts_with('.') && !part.contains(['\\', ':', '\0'])
        })
}

/// Reject symlinks and non-directory parents rather than reading or writing outside
/// the installed package. The root can live under a symlinked harness/home directory.
pub(super) fn resource_path(root: &Path, name: &str) -> Result<PathBuf> {
    if !valid_path(name) {
        bail!("invalid skill resource path: {name}");
    }
    let mut path = root.to_path_buf();
    let parts: Vec<_> = name.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(meta)
                if meta.file_type().is_symlink()
                    || (index + 1 < parts.len() && !meta.is_dir())
                    || (index + 1 == parts.len() && !meta.is_file()) =>
            {
                bail!(
                    "skill resource is not a regular file or has an unsafe parent: {}",
                    path.display()
                );
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err).with_context(|| format!("inspect {}", path.display())),
        }
    }
    Ok(path)
}

pub(super) fn file_hash(root: &Path, name: &str) -> Result<Option<String>> {
    let path = resource_path(root, name)?;
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(provenance::digest(&bytes))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("read {}", path.display())),
    }
}
