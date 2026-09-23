//! Recoverable multi-file updates. Stage all writes first, publish their expected
//! old/new hashes, install resources before SKILL.md, then finalize ownership.

use super::{
    SOURCE_MARKER_FILE, SkillBundle,
    bundle::{file_hash, resource_path},
    provenance::{BundleMarker, PreviousFiles},
    storage::PendingWrite,
};
use anyhow::{Context, Result};
use std::{collections::BTreeSet, fs, path::Path};

/// Caller holds the skill lock and has verified ownership (or an explicit force).
pub(super) fn write_bundle(
    dir: &Path,
    source: &SkillBundle,
    obsolete: &BTreeSet<String>,
) -> Result<()> {
    let files = source.hashes();
    let names: BTreeSet<_> = files.keys().chain(obsolete.iter()).cloned().collect();
    let previous: PreviousFiles = names
        .iter()
        .map(|name| Ok((name.clone(), file_hash(dir, name)?)))
        .collect::<Result<_>>()?;
    let mut writes = Vec::new();
    // Sorting puts the entry point last: a newly published SKILL.md always has
    // its resources available. Unchanged resources keep their modification time.
    let mut changed: Vec<_> = source
        .files
        .iter()
        .filter(|(name, _)| previous.get(*name).and_then(Option::as_ref) != files.get(*name))
        .collect();
    changed.sort_by_key(|(name, _)| (*name == "SKILL.md", *name));
    for (name, bytes) in changed {
        let path = resource_path(dir, name)?;
        fs::create_dir_all(path.parent().unwrap())?;
        writes.push(PendingWrite::prepare_bytes(&path, bytes)?);
    }
    let marker = dir.join(SOURCE_MARKER_FILE);
    let ready = BundleMarker::new(files.clone(), None).encode()?;
    if writes.is_empty() && obsolete.iter().all(|name| previous[name].is_none()) {
        return PendingWrite::prepare(&marker, &ready)?.commit();
    }
    let pending = BundleMarker::new(files, Some(previous)).encode()?;
    PendingWrite::prepare(&marker, &pending)?.commit()?;
    for write in writes {
        write
            .commit()
            .context("skill update interrupted; its pending marker permits a safe retry")?;
    }
    for name in obsolete {
        let path = resource_path(dir, name)?;
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(err)
                    .with_context(|| format!("remove retired resource {}", path.display()));
            }
        }
    }
    PendingWrite::prepare(&marker, &ready)?
        .commit()
        .context("skill content installed; ownership finalization will be retried")
}
