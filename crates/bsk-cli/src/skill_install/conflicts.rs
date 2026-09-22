//! Read-only preflight checks shared by installation and automatic sync.
//! Callers hold the skill lock until the subsequent transaction completes.

use std::path::Path;

use anyhow::Result;

use super::{
    bundle::file_hash,
    provenance::{FileHashes, PreviousFiles},
};

fn changed(dir: &Path, name: &str, missing: bool) -> String {
    let reason = if missing { "deleted" } else { "modified" };
    format!("{}: {reason}", dir.join(name).display())
}

pub(super) fn managed(dir: &Path, baseline: &FileHashes) -> Result<Vec<String>> {
    let mut conflicts = Vec::new();
    for (name, hash) in baseline {
        let current = file_hash(dir, name)?;
        if current.as_ref() != Some(hash) {
            conflicts.push(changed(dir, name, current.is_none()));
        }
    }
    Ok(conflicts)
}

pub(super) fn pending(
    dir: &Path,
    target: &FileHashes,
    previous: &PreviousFiles,
) -> Result<Vec<String>> {
    let mut conflicts = Vec::new();
    for (name, old_hash) in previous {
        let current = file_hash(dir, name)?;
        if current != *old_hash && current.as_ref() != target.get(name) {
            conflicts.push(changed(dir, name, current.is_none()));
        }
    }
    Ok(conflicts)
}

pub(super) fn unowned(
    dir: &Path,
    target: &FileHashes,
    baseline: &FileHashes,
) -> Result<Vec<String>> {
    let mut conflicts = Vec::new();
    for (name, hash) in target {
        if !baseline.contains_key(name)
            && file_hash(dir, name)?.is_some_and(|current| current != *hash)
        {
            conflicts.push(format!(
                "{}: new resource conflicts with an existing file",
                dir.join(name).display()
            ));
        }
    }
    Ok(conflicts)
}
