//! Filesystem layer for `$BSK_HOME/sites`.
//!
//! Layout (design §3.1):
//!
//! ```text
//! sites/
//!   .lock                      repository-wide advisory lock
//!   .drafts/<taskId>/<host>/   task-isolated staging area
//!     .context.json
//!   <host>/
//!     .revision                monotonic CAS token, per host
//!     .journal.jsonl           one line per committed checkpoint, per host
//!     SITE.md  references/  workflows/  candidates/
//! ```
//!
//! The revision counter is **per host**. A single global counter made every
//! host's checkpoint invalidate every other host's draft: creating memory for
//! `example.org` pushed an untouched `wikipedia.org` draft straight into the
//! conflict path. The lock stays repository-wide because it is cheap and
//! guards the whole tree.
//!
//! Everything in this module is pure local file I/O: no `bsk site` command
//! needs the daemon, so the whole family works under `BSK_AUTO_START=0`.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use fs2::FileExt;
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::model::{Candidate, DraftContext, JournalEntry, Workflow, now_rfc3339};
use crate::daemon::paths;

pub const SITE_MD: &str = "SITE.md";
pub const REFERENCES_DIR: &str = "references";
pub const WORKFLOWS_DIR: &str = "workflows";
pub const CANDIDATES_DIR: &str = "candidates";
pub const DRAFTS_DIR: &str = ".drafts";

const REVISION_FILE: &str = ".revision";
const JOURNAL_FILE: &str = ".journal.jsonl";
const LOCK_FILE: &str = ".lock";
const CONTEXT_FILE: &str = ".context.json";

/// How long a command waits for the repository lock before giving up. Long
/// enough to ride out a concurrent checkpoint, short enough that a wedged
/// agent reports a real error instead of hanging the task.
const LOCK_TIMEOUT: Duration = Duration::from_secs(10);
const LOCK_POLL: Duration = Duration::from_millis(50);

// ---------------------------------------------------------------------------
// Host normalisation
// ---------------------------------------------------------------------------

/// A host after registrable-domain-ish normalisation.
///
/// No public-suffix list is pulled in: folding `www.` / `m.` and lowercasing
/// covers the cases that actually collide in practice, and a wrong PSL answer
/// would silently merge two sites' memory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKey {
    /// Canonical host as reported to the user.
    pub display: String,
    /// Directory name under `sites/`. Equals `display` unless `read_only`.
    pub dir: String,
    /// True when normalisation failed: drafts are allowed, promotion is not.
    pub read_only: bool,
}

/// Windows reserves these names at every path level, extension or not.
const WINDOWS_RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Normalise a `--host` value. Accepts a bare host or a full URL.
pub fn normalize_host(raw: &str) -> HostKey {
    let candidate = strip_to_host(raw);
    if is_valid_host(&candidate) {
        // A dotless host (`localhost`, an internal short name) is legal but its
        // bare label is exactly what Windows reserves, so it is filed under a
        // prefixed directory. `display` keeps the name the user typed.
        let dir = if candidate.contains('.') {
            candidate.clone()
        } else {
            format!("host-{candidate}")
        };
        return HostKey {
            display: candidate,
            dir,
            read_only: false,
        };
    }
    let slug = slugify(&candidate);
    HostKey {
        display: raw.trim().to_string(),
        dir: format!("provisional-{slug}"),
        read_only: true,
    }
}

fn strip_to_host(raw: &str) -> String {
    let mut text = raw.trim();
    if let Some(idx) = text.find("://") {
        text = &text[idx + 3..];
    }
    // Cut the authority off FIRST. Searching the whole string for `@` lets a
    // path or query smuggle in a different host:
    // `https://login.microsoftonline.com/x@ticket.corp.example` would otherwise
    // normalise to `ticket.corp.example` and slip past the sensitive-host gate.
    text = text.split(['/', '?', '#']).next().unwrap_or_default();
    // Userinfo lives inside the authority; the host follows the last `@`.
    if let Some((_, host)) = text.rsplit_once('@') {
        text = host;
    }
    text = text.trim_end_matches('.');
    // Strip a trailing :port, but leave bracketed IPv6 literals alone (they are
    // rejected by `is_valid_host` anyway).
    if !text.starts_with('[')
        && let Some(idx) = text.rfind(':')
        && text[idx + 1..].chars().all(|c| c.is_ascii_digit())
    {
        text = &text[..idx];
    }
    let lower = text.to_ascii_lowercase();
    for prefix in ["www.", "m."] {
        if let Some(rest) = lower.strip_prefix(prefix)
            && rest.contains('.')
        {
            return rest.to_string();
        }
    }
    lower
}

fn is_valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 || host.contains("..") {
        return false;
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels
        .iter()
        .any(|label| label.is_empty() || label.len() > 63)
    {
        return false;
    }
    // A reserved device name as the first label would produce a directory
    // Windows refuses to create, and only a dotted host can hit it: a dotless
    // one is prefixed by `normalize_host`.
    if host.contains('.') && WINDOWS_RESERVED.contains(&labels[0]) {
        return false;
    }
    true
}

/// Short, stable digest keeping truncated slugs from colliding.
fn short_hash(text: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

fn slugify(text: &str) -> String {
    let mut out: String = text
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    out = out.trim_matches(['-', '.']).to_string();
    if out.is_empty() {
        return format!("unknown-{}", short_hash(text));
    }
    if out.len() > 48 {
        // Two long inputs sharing a 48-character prefix must not land in the
        // same directory, so the digest of the full value is appended.
        let digest = short_hash(text);
        out.truncate(48);
        out = format!("{}-{digest}", out.trim_end_matches(['-', '.']));
    }
    out
}

/// Refuse a host that must never become durable site memory.
///
/// Every entry point calls this right after [`normalize_host`], so the
/// credential-surface rule cannot be reached around by choosing a different
/// subcommand. The check runs on the normalised host, which is why
/// [`strip_to_host`] must cut the authority before looking for userinfo.
pub fn guard_host(host: &HostKey) -> Result<()> {
    if let Some(reason) = super::validate::sensitive_host_reason(&host.display) {
        bail!("{reason}");
    }
    Ok(())
}

/// Sanitise a task id into one safe path segment.
pub fn task_slug(task: &str) -> Result<String> {
    let trimmed = task.trim();
    if trimmed.is_empty() {
        bail!("--task must not be empty");
    }
    let slug = slugify(trimmed);
    if WINDOWS_RESERVED.contains(&slug.as_str()) {
        bail!("--task {trimmed:?} is a reserved name on Windows");
    }
    Ok(slug)
}

/// Validate a workflow / candidate id: one lowercase path segment.
pub fn validate_id(id: &str, what: &str) -> Result<()> {
    if id.is_empty() || id.len() > 64 {
        bail!("{what} id must be 1-64 characters, got {id:?}");
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        bail!("{what} id {id:?} must use only lowercase letters, digits, '-' and '_'");
    }
    if id.starts_with('-') || id.starts_with('_') {
        bail!("{what} id {id:?} must not start with '-' or '_'");
    }
    if WINDOWS_RESERVED.contains(&id) {
        bail!("{what} id {id:?} is a reserved name on Windows");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/// One child of a host or draft directory (`workflows`, `SITE.md`, ...).
///
/// Every subdirectory goes through here rather than a bare `join` so a
/// symlinked `candidates/` cannot redirect writes outside `sites/`.
pub fn sub(base: &Path, name: &str) -> Result<PathBuf> {
    resolve_in(base, &[name])
}

/// Join `segments` under `base`, rejecting traversal and symlinked components.
///
/// Site memory is written from agent-supplied ids and host names, so every
/// path is rebuilt segment by segment rather than trusted. A symlink anywhere
/// along the chain is refused outright: following one would let a crafted
/// draft write outside `sites/`.
pub fn resolve_in(base: &Path, segments: &[&str]) -> Result<PathBuf> {
    let mut path = base.to_path_buf();
    for segment in segments {
        if segment.is_empty() || *segment == "." || *segment == ".." {
            bail!("unsafe path segment {segment:?}");
        }
        let as_path = Path::new(segment);
        let mut components = as_path.components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(_)), None) => {}
            _ => bail!("path segment {segment:?} must be a single plain name"),
        }
        path.push(segment);
        if let Ok(meta) = fs::symlink_metadata(&path)
            && meta.file_type().is_symlink()
        {
            bail!("refusing to follow symlink at {}", path.display());
        }
    }
    Ok(path)
}

// ---------------------------------------------------------------------------
// Repository handle
// ---------------------------------------------------------------------------

/// Handle on `$BSK_HOME/sites`.
#[derive(Debug, Clone)]
pub struct SiteStore {
    root: PathBuf,
}

impl SiteStore {
    /// Open (and create) the site-memory root.
    pub fn open() -> Result<Self> {
        let root = paths::ensure_sites_root().context("prepare site-memory root")?;
        Ok(Self { root })
    }

    #[cfg(test)]
    pub fn at(root: PathBuf) -> Result<Self> {
        paths::ensure_private_dir(&root)?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Active memory directory for a host. Not created.
    pub fn host_dir(&self, host: &HostKey) -> Result<PathBuf> {
        resolve_in(&self.root, &[host.dir.as_str()])
    }

    /// Draft directory for `(task, host)`. Not created.
    pub fn draft_dir(&self, task_slug: &str, host: &HostKey) -> Result<PathBuf> {
        resolve_in(&self.root, &[DRAFTS_DIR, task_slug, host.dir.as_str()])
    }

    // -- revision ---------------------------------------------------------

    /// `sites/<host>/.revision` — the CAS token for one host.
    ///
    /// Per host, not per repository: `wikipedia.org` publishing a workflow is
    /// not a reason for a `ticket.corp.example` draft to conflict. Any
    /// leftover `sites/.revision` from the pre-release global scheme is simply
    /// never read.
    pub fn revision_path(&self, host: &HostKey) -> Result<PathBuf> {
        Ok(self.host_dir(host)?.join(REVISION_FILE))
    }

    /// `sites/<host>/.journal.jsonl` — that host's append-only commit log.
    pub fn journal_path(&self, host: &HostKey) -> Result<PathBuf> {
        Ok(self.host_dir(host)?.join(JOURNAL_FILE))
    }

    pub fn revision(&self, host: &HostKey) -> Result<u64> {
        let path = self.revision_path(host)?;
        match fs::read_to_string(&path) {
            Ok(text) => text
                .trim()
                .parse::<u64>()
                .with_context(|| format!("{} is not a revision number", path.display())),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(err) => Err(anyhow!(err).context(format!("read {}", path.display()))),
        }
    }

    pub fn set_revision(&self, host: &HostKey, value: u64) -> Result<()> {
        write_atomic(&self.revision_path(host)?, format!("{value}\n").as_bytes())
    }

    pub fn append_journal(&self, host: &HostKey, entry: &JournalEntry) -> Result<()> {
        let path = self.journal_path(host)?;
        paths::ensure_private_dir(self.host_dir(host)?.as_path())?;
        let line = serde_json::to_string(entry).context("encode journal entry")?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("open {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        writeln!(file, "{line}").with_context(|| format!("append {}", path.display()))
    }

    // -- locking ----------------------------------------------------------

    /// Take the repository-wide exclusive lock.
    ///
    /// `fs2` advisory locks are released by the OS when a holder dies, so no
    /// pid/mtime stale-breaking dance is needed: a crashed agent cannot wedge
    /// the tree. The bounded wait turns a live deadlock into a clear error.
    pub fn lock(&self) -> Result<SiteLock> {
        let path = self.root.join(LOCK_FILE);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .with_context(|| format!("open {}", path.display()))?;
        // The lock file sits beside private memory and is created by whichever
        // command runs first, so it gets the same 0600 promise as the rest.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
        let deadline = Instant::now() + LOCK_TIMEOUT;
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(SiteLock { file }),
                Err(err) if err.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                    if Instant::now() >= deadline {
                        bail!(
                            "another bsk site command is holding {} (waited {}s)",
                            path.display(),
                            LOCK_TIMEOUT.as_secs()
                        );
                    }
                    std::thread::sleep(LOCK_POLL);
                }
                Err(err) => {
                    return Err(anyhow!(err).context(format!("lock {}", path.display())));
                }
            }
        }
    }
}

/// Guard releasing the repository lock on drop.
pub struct SiteLock {
    file: File,
}

impl Drop for SiteLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

// ---------------------------------------------------------------------------
// Atomic IO helpers
// ---------------------------------------------------------------------------

/// Replace `path` with `bytes` through a same-directory temporary file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", path.display()))?;
    paths::ensure_private_dir(parent)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".bsk-site-")
        .tempfile_in(parent)
        .with_context(|| format!("stage a temporary file next to {}", path.display()))?;
    temp.write_all(bytes)
        .with_context(|| format!("write staged content for {}", path.display()))?;
    temp.flush()
        .with_context(|| format!("flush staged content for {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o600))
            .with_context(|| format!("chmod 0600 staged content for {}", path.display()))?;
    }
    temp.persist(path)
        .map_err(|err| anyhow!(err.error))
        .with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let mut text = serde_json::to_string_pretty(value)
        .with_context(|| format!("encode {}", path.display()))?;
    text.push('\n');
    write_atomic(path, text.as_bytes())
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

/// Read a file, mapping "missing" to `None`.
pub fn read_optional(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(anyhow!(err).context(format!("read {}", path.display()))),
    }
}

/// List `*.<ext>` file stems in `dir`, sorted. A missing directory is empty.
pub fn list_stems(dir: &Path, ext: &str) -> Result<Vec<String>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(anyhow!(err).context(format!("read {}", dir.display()))),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.with_context(|| format!("read entry in {}", dir.display()))?;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some(ext) {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            out.push(stem.to_string());
        }
    }
    out.sort();
    Ok(out)
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

enum Undo {
    /// Put a replaced file back, or delete one that did not exist before.
    Restore {
        path: PathBuf,
        previous: Option<Vec<u8>>,
    },
    /// Cut an appended line back off the journal.
    Truncate {
        path: PathBuf,
        len: u64,
        existed: bool,
    },
}

/// Groups several file writes so a failure part-way through leaves the tree
/// exactly as it was.
///
/// The previous content of each touched file is held in memory; site-memory
/// files are prose and small JSON, so this stays cheap. Undo actions replay in
/// reverse order.
#[derive(Default)]
pub struct Transaction {
    undo: Vec<Undo>,
}

impl Transaction {
    pub fn write(&mut self, path: &Path, bytes: &[u8]) -> Result<()> {
        let previous = match fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => {
                return Err(anyhow!(err).context(format!("read {}", path.display())));
            }
        };
        self.undo.push(Undo::Restore {
            path: path.to_path_buf(),
            previous,
        });
        write_atomic(path, bytes)
    }

    pub fn write_json<T: Serialize>(&mut self, path: &Path, value: &T) -> Result<()> {
        let mut text = serde_json::to_string_pretty(value)
            .with_context(|| format!("encode {}", path.display()))?;
        text.push('\n');
        self.write(path, text.as_bytes())
    }

    /// Append one line, remembering the original length so a rollback can trim
    /// it. A journal entry must never outlive the commit it describes.
    pub fn append_line(&mut self, path: &Path, line: &str) -> Result<()> {
        let (len, existed) = match fs::metadata(path) {
            Ok(meta) => (meta.len(), true),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => (0, false),
            Err(err) => {
                return Err(anyhow!(err).context(format!("stat {}", path.display())));
            }
        };
        self.undo.push(Undo::Truncate {
            path: path.to_path_buf(),
            len,
            existed,
        });
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .with_context(|| format!("open {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
        }
        writeln!(file, "{line}").with_context(|| format!("append {}", path.display()))
    }

    /// Undo everything written so far. Returns the paths it could not restore.
    pub fn rollback(&mut self) -> Result<()> {
        let mut failures = Vec::new();
        for action in self.undo.drain(..).rev() {
            let outcome = match action {
                Undo::Restore {
                    path,
                    previous: Some(bytes),
                } => write_atomic(&path, &bytes),
                Undo::Restore {
                    path,
                    previous: None,
                } => remove_if_present(&path),
                Undo::Truncate {
                    path,
                    len,
                    existed: true,
                } => OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .and_then(|file| file.set_len(len))
                    .map_err(|err| anyhow!(err).context(format!("truncate {}", path.display()))),
                Undo::Truncate {
                    path,
                    existed: false,
                    ..
                } => remove_if_present(&path),
            };
            if let Err(err) = outcome {
                failures.push(format!("{err:#}"));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            bail!("{}", failures.join("; "))
        }
    }
}

fn remove_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(anyhow!(err).context(format!("remove {}", path.display()))),
    }
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/// A draft staged for one `(task, host)` pair.
#[derive(Debug, Clone)]
pub struct Draft {
    pub dir: PathBuf,
    pub context: DraftContext,
    /// True when this call created the draft rather than reusing it.
    pub created: bool,
    /// True when this call re-seeded the draft from a newer active revision.
    pub rebased: bool,
}

/// Open the draft for `(task, host)`, seeding it from active memory on first
/// use. Seeding copies `SITE.md`, `references/` and `workflows/` — candidates
/// stay out of drafts because they are append-only evidence written straight
/// to active memory (§3.4).
pub fn ensure_draft(store: &SiteStore, task: &str, host: &HostKey) -> Result<Draft> {
    let slug = task_slug(task)?;
    let dir = store.draft_dir(&slug, host)?;
    let context_path = dir.join(CONTEXT_FILE);
    if context_path.is_file() {
        let context: DraftContext = read_json(&context_path)?;
        return Ok(Draft {
            dir,
            context,
            created: false,
            rebased: false,
        });
    }
    // Each level is created through `ensure_private_dir` in turn so `.drafts/`
    // and `.drafts/<task>/` are 0700 too, not just the `<host>/` leaf: the task
    // id itself is information about what the user is doing.
    paths::ensure_private_dir(&resolve_in(store.root(), &[DRAFTS_DIR])?)?;
    paths::ensure_private_dir(&resolve_in(store.root(), &[DRAFTS_DIR, slug.as_str()])?)?;
    paths::ensure_private_dir(&dir)?;
    seed_draft(store, host, &dir, SeedScope::Everything)?;
    let context = DraftContext {
        read_only: host.read_only,
        base_revision: store.revision(host)?,
        host: host.display.clone(),
        task_id: task.trim().to_string(),
        created_at: now_rfc3339(),
    };
    write_json(&context_path, &context)?;
    Ok(Draft {
        dir,
        context,
        created: true,
        rebased: false,
    })
}

/// Which parts of active memory a seeding pass copies into the draft.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SeedScope {
    /// First use of a draft: copy prose and workflows alike.
    Everything,
    /// A rebase: copy only the prose the agent is expected to replay its edits
    /// on top of. Workflows staged in the draft are new work this task has not
    /// published yet, so overwriting them would destroy it.
    ProseOnly,
}

fn seed_draft(store: &SiteStore, host: &HostKey, draft_dir: &Path, scope: SeedScope) -> Result<()> {
    let active = store.host_dir(host)?;
    if let Some(site_md) = read_optional(&active.join(SITE_MD))? {
        write_atomic(&draft_dir.join(SITE_MD), site_md.as_bytes())?;
    }
    let subs: &[(&str, &str)] = match scope {
        SeedScope::Everything => &[(REFERENCES_DIR, "md"), (WORKFLOWS_DIR, "json")],
        SeedScope::ProseOnly => &[(REFERENCES_DIR, "md")],
    };
    for (sub, ext) in subs {
        let src = active.join(sub);
        let dst = draft_dir.join(sub);
        let stems = list_stems(&src, ext)?;
        if stems.is_empty() {
            continue;
        }
        paths::ensure_private_dir(&dst)?;
        for stem in stems {
            let name = format!("{stem}.{ext}");
            let from = resolve_in(&src, &[name.as_str()])?;
            let to = resolve_in(&dst, &[name.as_str()])?;
            let bytes = fs::read(&from).with_context(|| format!("read {}", from.display()))?;
            write_atomic(&to, &bytes)?;
        }
    }
    Ok(())
}

/// Path to a draft's `.context.json`.
pub fn draft_context_path(draft_dir: &Path) -> PathBuf {
    draft_dir.join(CONTEXT_FILE)
}

/// Move a draft onto `revision`, re-seeding its prose from active memory.
///
/// This is the recovery `context` performs after a checkpoint conflict, and it
/// is the whole point of the conflict. Moving only `.context.json` used to let
/// the retry publish a `SITE.md` copied from the *old* base, silently deleting
/// whatever the writer who won the race had just committed. Re-seeding means
/// the draft's `SITE.md` and `references/` become exactly what is published
/// now; the agent replays its own edits on top and checkpoints again.
///
/// `workflows/` staged in the draft survive: they are this task's unpublished
/// work, not a stale copy of someone else's.
pub fn rebase_draft(
    store: &SiteStore,
    host: &HostKey,
    mut draft: Draft,
    revision: u64,
) -> Result<Draft> {
    if draft.context.base_revision == revision {
        return Ok(draft);
    }
    seed_draft(store, host, &draft.dir, SeedScope::ProseOnly)?;
    draft.context.base_revision = revision;
    write_json(&draft_context_path(&draft.dir), &draft.context)?;
    draft.rebased = true;
    Ok(draft)
}

/// Read an existing draft without creating one.
pub fn load_draft(store: &SiteStore, task: &str, host: &HostKey) -> Result<Option<Draft>> {
    let slug = task_slug(task)?;
    let dir = store.draft_dir(&slug, host)?;
    let context_path = dir.join(CONTEXT_FILE);
    if !context_path.is_file() {
        return Ok(None);
    }
    let context: DraftContext = read_json(&context_path)?;
    Ok(Some(Draft {
        dir,
        context,
        created: false,
        rebased: false,
    }))
}

// ---------------------------------------------------------------------------
// Typed readers over the active tree
// ---------------------------------------------------------------------------

/// Read every workflow stored for a host, skipping unreadable files.
///
/// A corrupt file must not hide the rest of a site's memory, so parse failures
/// are returned alongside the workflows rather than aborting the read.
pub fn load_workflows(dir: &Path) -> Result<(Vec<Workflow>, Vec<String>)> {
    let mut workflows = Vec::new();
    let mut problems = Vec::new();
    for stem in list_stems(dir, "json")? {
        let name = format!("{stem}.json");
        let path = resolve_in(dir, &[name.as_str()])?;
        match read_json::<Workflow>(&path) {
            Ok(workflow) => workflows.push(workflow),
            Err(err) => problems.push(format!("{name}: {err:#}")),
        }
    }
    workflows.sort_by(|a, b| a.id.cmp(&b.id));
    Ok((workflows, problems))
}

/// Read one workflow by id, or `None` when it does not exist.
pub fn load_workflow(dir: &Path, id: &str) -> Result<Option<Workflow>> {
    validate_id(id, "workflow")?;
    let name = format!("{id}.json");
    let path = resolve_in(dir, &[name.as_str()])?;
    if !path.is_file() {
        return Ok(None);
    }
    read_json(&path).map(Some)
}

/// Read every candidate stored for a host, skipping unreadable files.
pub fn load_candidates(dir: &Path) -> Result<(Vec<Candidate>, Vec<String>)> {
    let mut candidates = Vec::new();
    let mut problems = Vec::new();
    for stem in list_stems(dir, "json")? {
        let name = format!("{stem}.json");
        let path = resolve_in(dir, &[name.as_str()])?;
        match read_json::<Candidate>(&path) {
            Ok(candidate) => candidates.push(candidate),
            Err(err) => problems.push(format!("{name}: {err:#}")),
        }
    }
    candidates.sort_by(|a, b| {
        a.observed_date_utc
            .cmp(&b.observed_date_utc)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok((candidates, problems))
}

/// Allocate a candidate id that is unique within `dir`.
///
/// Shape is `<date>-<n>` so a directory listing sorts chronologically and the
/// id itself carries the observation date.
pub fn next_candidate_id(dir: &Path, date: &str) -> Result<String> {
    let existing = list_stems(dir, "json")?;
    for n in 1..10_000u32 {
        let candidate = format!("{date}-{n:03}");
        if !existing.contains(&candidate) {
            return Ok(candidate);
        }
    }
    bail!("more than 9999 candidates recorded for {date}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, SiteStore) {
        let tmp = tempfile::tempdir().unwrap();
        let store = SiteStore::at(tmp.path().join("sites")).unwrap();
        (tmp, store)
    }

    #[test]
    fn host_normalisation_folds_prefixes_and_case() {
        assert_eq!(normalize_host("WWW.Example.COM").dir, "example.com");
        assert_eq!(normalize_host("m.example.com").dir, "example.com");
        assert_eq!(
            normalize_host("https://ticket.corp.example/new?x=1").dir,
            "ticket.corp.example"
        );
        assert_eq!(normalize_host("example.com:8443").dir, "example.com");
        assert_eq!(normalize_host("example.com.").dir, "example.com");
        // A bare `m` / `www` label with nothing behind it is kept as-is, but a
        // dotless host is filed under a prefixed directory (see L15).
        let bare = normalize_host("www.");
        assert_eq!(bare.display, "www");
        assert_eq!(bare.dir, "host-www");
        assert!(!bare.read_only);
    }

    #[test]
    fn unnormalisable_host_falls_back_to_read_only_slug() {
        let key = normalize_host("../../etc/passwd");
        assert!(key.read_only);
        assert!(key.dir.starts_with("provisional-"));
        assert!(!key.dir.contains(".."));

        let empty = normalize_host("   ");
        assert!(empty.read_only);
        assert!(empty.dir.starts_with("provisional-unknown-"));
    }

    #[test]
    fn windows_reserved_names_never_become_directory_names() {
        // A dotted host whose first label is reserved has no safe directory.
        assert!(normalize_host("nul.example.com").read_only);
        assert!(normalize_host("con.corp.example").read_only);
        // A dotless one is legal and gets the `host-` prefix instead (L15).
        let con = normalize_host("con");
        assert!(!con.read_only);
        assert_eq!(con.dir, "host-con");
    }

    /// H2: userinfo is only meaningful inside the authority. Searching the
    /// whole URL for `@` let a path or query name a different host and slip
    /// past the sensitive-host gate.
    #[test]
    fn userinfo_in_a_path_or_query_cannot_rewrite_the_host() {
        assert_eq!(
            normalize_host("https://login.microsoftonline.com/x@ticket.corp.example").dir,
            "login.microsoftonline.com"
        );
        assert_eq!(
            normalize_host("https://a.example.com/r?to=x@okta.com").dir,
            "a.example.com"
        );
        // Real userinfo inside the authority still resolves to the host.
        assert_eq!(
            normalize_host("https://user:pw@ticket.corp.example/new").dir,
            "ticket.corp.example"
        );
        assert!(
            guard_host(&normalize_host(
                "https://login.microsoftonline.com/x@ticket.corp.example"
            ))
            .is_err()
        );
    }

    /// L15: two long values sharing a 48-character prefix must not collide.
    #[test]
    fn long_slugs_stay_distinct_after_truncation() {
        let prefix = "x".repeat(60);
        let a = normalize_host(&format!("{prefix} one!"));
        let b = normalize_host(&format!("{prefix} two!"));
        assert!(a.read_only && b.read_only);
        assert_ne!(a.dir, b.dir);
        assert!(a.dir.len() <= 48 + "provisional-".len() + 9);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_subdirectories_cannot_redirect_writes() {
        let (tmp, store) = store();
        let host = normalize_host("example.com");
        let active = store.host_dir(&host).unwrap();
        paths::ensure_private_dir(&active).unwrap();
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, active.join(CANDIDATES_DIR)).unwrap();
        let err = sub(&active, CANDIDATES_DIR).unwrap_err();
        assert!(err.to_string().contains("symlink"), "{err}");
    }

    #[test]
    fn rebase_draft_moves_the_base_revision() {
        let (_tmp, store) = store();
        let host = normalize_host("example.com");
        let draft = ensure_draft(&store, "t1", &host).unwrap();
        assert_eq!(draft.context.base_revision, 0);
        let rebased = rebase_draft(&store, &host, draft, 5).unwrap();
        assert_eq!(rebased.context.base_revision, 5);
        assert!(rebased.rebased);
        let reread = load_draft(&store, "t1", &host).unwrap().unwrap();
        assert_eq!(reread.context.base_revision, 5);
    }

    /// S7: a rebase must hand the draft the prose that is actually published,
    /// or replaying edits on it republishes the old base and deletes whatever
    /// the writer who won the race committed.
    #[test]
    fn rebase_reseeds_prose_but_keeps_staged_workflows() {
        let (_tmp, store) = store();
        let host = normalize_host("example.com");
        let active = store.host_dir(&host).unwrap();
        write_atomic(&active.join(SITE_MD), b"base line\n").unwrap();

        let draft = ensure_draft(&store, "t1", &host).unwrap();
        // This task edits the prose and stages a brand-new workflow.
        write_atomic(&draft.dir.join(SITE_MD), b"base line\nmy line\n").unwrap();
        let staged = sub(&draft.dir, WORKFLOWS_DIR).unwrap().join("mine.json");
        write_atomic(&staged, b"{}").unwrap();

        // Someone else publishes first.
        write_atomic(&active.join(SITE_MD), b"base line\ntheir line\n").unwrap();
        store.set_revision(&host, 1).unwrap();

        let rebased = rebase_draft(&store, &host, draft, 1).unwrap();
        assert!(rebased.rebased);
        assert_eq!(
            fs::read_to_string(rebased.dir.join(SITE_MD)).unwrap(),
            "base line\ntheir line\n",
            "the draft must show what is published now"
        );
        assert!(staged.is_file(), "unpublished workflow work must survive");
    }

    /// A per-host counter: one host's checkpoint is not another host's problem.
    #[test]
    fn revisions_are_per_host() {
        let (_tmp, store) = store();
        let a = normalize_host("a.example");
        let b = normalize_host("b.example");
        store.set_revision(&a, 3).unwrap();
        assert_eq!(store.revision(&a).unwrap(), 3);
        assert_eq!(store.revision(&b).unwrap(), 0);
        assert!(
            store
                .revision_path(&a)
                .unwrap()
                .starts_with(store.host_dir(&a).unwrap())
        );
    }

    /// S10: `.drafts/` and `.drafts/<task>/` used to land at the process umask,
    /// letting any other account on the machine list the user's task ids.
    #[cfg(unix)]
    #[test]
    fn draft_directories_and_the_lock_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, store) = store();
        let host = normalize_host("example.com");
        let draft = ensure_draft(&store, "task-1", &host).unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&store.root().join(DRAFTS_DIR)), 0o700);
        assert_eq!(mode(&store.root().join(DRAFTS_DIR).join("task-1")), 0o700);
        assert_eq!(mode(&draft.dir), 0o700);
        assert_eq!(mode(&draft_context_path(&draft.dir)), 0o600);

        let held = store.lock().unwrap();
        assert_eq!(mode(&store.root().join(LOCK_FILE)), 0o600);
        drop(held);

        store.set_revision(&host, 1).unwrap();
        store
            .append_journal(
                &host,
                &JournalEntry {
                    revision: 1,
                    at: "2026-09-16T00:00:00Z".into(),
                    host: host.display.clone(),
                    task_id: None,
                    reason: "direct_correction".into(),
                    paths: Vec::new(),
                    ingested: Vec::new(),
                    rejected: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(mode(&store.revision_path(&host).unwrap()), 0o600);
        assert_eq!(mode(&store.journal_path(&host).unwrap()), 0o600);
        assert_eq!(mode(&store.host_dir(&host).unwrap()), 0o700);
    }

    #[test]
    fn transaction_rollback_restores_files_and_trims_the_journal() {
        let (_tmp, store) = store();
        let kept = store.root().join("kept.txt");
        let created = store.root().join("created.txt");
        let journal = store.root().join("scratch.jsonl");
        write_atomic(&kept, b"original").unwrap();
        let mut tx = Transaction::default();
        tx.append_line(&journal, "{\"first\":true}").unwrap();

        let mut tx2 = Transaction::default();
        tx2.write(&kept, b"replaced").unwrap();
        tx2.write(&created, b"new").unwrap();
        tx2.append_line(&journal, "{\"second\":true}").unwrap();
        assert_eq!(fs::read_to_string(&journal).unwrap().lines().count(), 2);

        tx2.rollback().unwrap();
        assert_eq!(fs::read_to_string(&kept).unwrap(), "original");
        assert!(!created.exists(), "a file the transaction created must go");
        let journal_text = fs::read_to_string(&journal).unwrap();
        assert_eq!(journal_text.lines().count(), 1, "{journal_text}");
        assert!(journal_text.contains("first"));
        drop(tx);
    }

    #[test]
    fn resolve_in_rejects_traversal_and_separators() {
        let (_tmp, store) = store();
        assert!(resolve_in(store.root(), &[".."]).is_err());
        assert!(resolve_in(store.root(), &["a/b"]).is_err());
        assert!(resolve_in(store.root(), &[""]).is_err());
        assert!(resolve_in(store.root(), &["ok"]).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_in_refuses_symlinked_components() {
        let (tmp, store) = store();
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, store.root().join("evil.com")).unwrap();
        let err = resolve_in(store.root(), &["evil.com", "SITE.md"]).unwrap_err();
        assert!(err.to_string().contains("symlink"), "{err}");
    }

    #[test]
    fn revision_starts_at_zero_and_round_trips() {
        let (_tmp, store) = store();
        let host = normalize_host("example.com");
        assert_eq!(store.revision(&host).unwrap(), 0);
        store.set_revision(&host, 7).unwrap();
        assert_eq!(store.revision(&host).unwrap(), 7);
        // A stray global counter left by the pre-release layout is ignored.
        write_atomic(&store.root().join(REVISION_FILE), b"99\n").unwrap();
        assert_eq!(store.revision(&host).unwrap(), 7);
    }

    #[test]
    fn lock_is_exclusive_across_handles_and_released_on_drop() {
        let (_tmp, store) = store();
        let held = store.lock().unwrap();
        let path = store.root().join(LOCK_FILE);
        let probe = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .unwrap();
        assert!(probe.try_lock_exclusive().is_err());
        drop(probe);
        drop(held);
        let again = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert!(again.try_lock_exclusive().is_ok());
    }

    #[test]
    fn draft_seeds_from_active_memory_then_reuses() {
        let (_tmp, store) = store();
        let host = normalize_host("example.com");
        let active = store.host_dir(&host).unwrap();
        paths::ensure_private_dir(&active.join(WORKFLOWS_DIR)).unwrap();
        write_atomic(&active.join(SITE_MD), b"# example [verified 2026-09-15]\n").unwrap();
        write_atomic(&active.join(WORKFLOWS_DIR).join("a.json"), b"{}").unwrap();
        store.set_revision(&host, 4).unwrap();

        let draft = ensure_draft(&store, "task-1", &host).unwrap();
        assert!(draft.created);
        assert_eq!(draft.context.base_revision, 4);
        assert!(!draft.context.read_only);
        assert!(draft.dir.join(SITE_MD).is_file());
        assert!(draft.dir.join(WORKFLOWS_DIR).join("a.json").is_file());

        // A second call reuses the staged copy rather than re-seeding.
        write_atomic(&draft.dir.join(SITE_MD), b"edited\n").unwrap();
        let again = ensure_draft(&store, "task-1", &host).unwrap();
        assert!(!again.created);
        assert_eq!(
            fs::read_to_string(again.dir.join(SITE_MD)).unwrap(),
            "edited\n"
        );
    }

    #[test]
    fn draft_for_unnormalisable_host_is_read_only() {
        let (_tmp, store) = store();
        let host = normalize_host("not a host!!");
        let draft = ensure_draft(&store, "task-1", &host).unwrap();
        assert!(draft.context.read_only);
    }

    #[test]
    fn validate_id_rejects_path_tricks() {
        assert!(validate_id("submit-ticket", "workflow").is_ok());
        assert!(validate_id("../escape", "workflow").is_err());
        assert!(validate_id("Upper", "workflow").is_err());
        assert!(validate_id("", "workflow").is_err());
        assert!(validate_id("con", "workflow").is_err());
    }

    #[test]
    fn journal_appends_one_line_per_entry() {
        let (_tmp, store) = store();
        let host = normalize_host("example.com");
        for revision in 1..=2 {
            store
                .append_journal(
                    &host,
                    &JournalEntry {
                        revision,
                        at: "2026-09-15T00:00:00Z".into(),
                        host: "example.com".into(),
                        task_id: Some("t".into()),
                        reason: "direct_correction".into(),
                        paths: vec!["example.com/SITE.md".into()],
                        ingested: Vec::new(),
                        rejected: Vec::new(),
                    },
                )
                .unwrap();
        }
        let text = fs::read_to_string(store.journal_path(&host).unwrap()).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(
            text.lines()
                .all(|l| serde_json::from_str::<JournalEntry>(l).is_ok())
        );
    }
}
