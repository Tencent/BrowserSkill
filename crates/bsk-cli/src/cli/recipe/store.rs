//! Recipes on disk: `$BSK_HOME/recipes/<name>/`, private to this user.
//!
//! ```text
//! recipe.json          the current revision
//! state.json           draft/verified/stale and local counters
//! revisions/2.json     earlier revisions, at most ten
//! runs/r-7f3a.jsonl    step status and a parameter digest, never parameter values
//! ```
use super::model::{self, Recipe, Refusal};
use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_REVISIONS: usize = 10;
const MAX_RUNS: usize = 50;
const RUN_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const STALE_AFTER_HANDOFFS: u32 = 3;
/// Far beyond a run's budget plus starting and stopping its session.
const RUN_LIFETIME_MS: i64 = 10 * 60 * 1000;
const UNUSED_NOTICE_MS: i64 = 90 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Draft,
    Verified,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct State {
    pub status: Status,
    pub runs: u32,
    pub completed: u32,
    pub handoffs: u32,
    pub uncertain: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success_ms: Option<i64>,
    /// Where the latest run in an unbroken series of handoffs stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_at: Option<String>,
    #[serde(default)]
    pub handoff_streak: u32,
    pub created_ms: i64,
    /// A person's approval of the risks the recipe lowers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval: Option<Approval>,
    /// A run whose effect nobody has checked. The recipe does not run again until the
    /// caller names it: repeating an unknown effect can double it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unchecked: Option<Unchecked>,
    /// Runs in progress, so one that dies without reporting is not taken for a clean one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub running: Vec<Running>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unchecked {
    pub run_id: String,
    /// `effect_unknown` or `dialog_pending`, or `interrupted` for a run that never reported.
    pub reason: String,
    /// Where it stopped, such as `query/2`, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    pub since_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Running {
    pub run_id: String,
    pub pid: u32,
    pub started_ms: i64,
}

/// What a person approved at a terminal, so a later change needs approving again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Approval {
    /// Digest of the recipe as reviewed, without its description and revision.
    pub digest: String,
    pub revision: u32,
    pub approved_ms: i64,
}

/// `required` until a person approves the risks a recipe lowers, then `approved`.
fn approval_note(recipe: &Recipe, state: &State) -> Option<&'static str> {
    if recipe.downgrades().is_empty() {
        return None;
    }
    let digest = approval_digest(recipe);
    Some(
        if state
            .approval
            .as_ref()
            .is_some_and(|approval| approval.digest == digest)
        {
            "approved"
        } else {
            "required"
        },
    )
}

/// Covers what a run does. Rewording the description changes nothing a person approved.
pub(crate) fn approval_digest(recipe: &Recipe) -> String {
    let mut reviewed = recipe.clone();
    reviewed.description.clear();
    reviewed.revision = 0;
    let bytes = serde_json::to_vec(&reviewed).expect("serializable recipe");
    Sha256::digest(bytes)
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, Clone)]
pub(crate) struct Store {
    root: PathBuf,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn private_dir(path: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(path).with_context(|| {
        format!(
            "create {}; if this location is read-only, set BSK_HOME to a writable directory",
            path.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Readers see the old file or the new one, never part of either.
fn write_private(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let dir = path.parent().context("file has no directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    // NamedTempFile creates 0600 on Unix and inherits account permissions on Windows.
    temp.persist(path)
        .with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

fn read_limited(path: &Path) -> anyhow::Result<Vec<u8>> {
    let size = fs::metadata(path)
        .with_context(|| format!("read {}", path.display()))?
        .len();
    ensure!(size <= MAX_FILE_BYTES, "{} is too large", path.display());
    fs::read(path).with_context(|| format!("read {}", path.display()))
}

/// Parses a recipe file, or what MCP sent instead of one.
pub(crate) fn parse_document(bytes: &[u8]) -> Result<Recipe, Refusal> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(Refusal::new(
            "invalid_recipe",
            format!("recipe exceeds {MAX_FILE_BYTES} bytes"),
        ));
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| Refusal::new("invalid_recipe", format!("recipe is not JSON: {error}")))?;
    model::from_value(value)
}

pub(crate) fn read_document(path: &Path) -> Result<Recipe, Refusal> {
    let bytes =
        read_limited(path).map_err(|error| Refusal::new("invalid_recipe", format!("{error:#}")))?;
    parse_document(&bytes)
}

/// Sorted by the number in `<number>.json` or by age, so the oldest go first.
fn prune_revisions(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut revisions: Vec<(u32, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let number = entry.path().file_stem()?.to_str()?.parse().ok()?;
            Some((number, entry.path()))
        })
        .collect();
    revisions.sort();
    let excess = revisions.len().saturating_sub(MAX_REVISIONS);
    for (_, path) in revisions.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

fn prune_runs(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    let mut runs: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    runs.sort();
    let excess = runs.len().saturating_sub(MAX_RUNS);
    for (index, (modified, path)) in runs.into_iter().enumerate() {
        let expired = now
            .duration_since(modified)
            .is_ok_and(|age| age > RUN_RETENTION);
        if index < excess || expired {
            let _ = fs::remove_file(path);
        }
    }
}

/// A digest lets repeated inputs be recognized without storing them.
pub(crate) fn params_digest(values: &BTreeMap<String, String>) -> String {
    let bytes = serde_json::to_vec(values).expect("string map");
    Sha256::digest(bytes)
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Appends a run's history. Logging never decides the outcome of a run.
pub(crate) struct RunLog {
    file: Option<fs::File>,
}

impl RunLog {
    #[cfg(test)]
    pub(crate) fn disabled() -> Self {
        Self { file: None }
    }

    pub(crate) fn event(&mut self, event: &str, mut fields: Value) {
        let Some(file) = &mut self.file else { return };
        fields["t"] = now_ms().into();
        fields["event"] = event.into();
        let mut line = fields.to_string();
        line.push('\n');
        if file.write_all(line.as_bytes()).is_err() {
            self.file = None;
        }
    }
}

impl Store {
    pub(crate) fn open() -> anyhow::Result<Self> {
        Ok(Self {
            root: crate::daemon::paths::bsk_home()?.join("recipes"),
        })
    }

    #[cfg(test)]
    pub(crate) fn at(root: PathBuf) -> Self {
        Self { root }
    }

    fn dir(&self, name: &str) -> anyhow::Result<PathBuf> {
        ensure!(model::valid_name(name), "invalid recipe name {name}");
        Ok(self.root.join(name))
    }

    pub(crate) fn exists(&self, name: &str) -> bool {
        self.dir(name)
            .is_ok_and(|dir| dir.join("recipe.json").is_file())
    }

    pub(crate) fn load(&self, name: &str) -> Result<Recipe, Refusal> {
        let dir = self
            .dir(name)
            .map_err(|error| Refusal::new("invalid_params", format!("{error:#}")))?;
        let path = dir.join("recipe.json");
        if !path.is_file() {
            return Err(Refusal::new(
                "recipe_not_found",
                format!("no recipe named {name}; list shows the saved ones"),
            ));
        }
        read_document(&path)
    }

    pub(crate) fn state(&self, name: &str) -> State {
        let mut state = self.read_state(name).unwrap_or_default();
        if let Some(run) = state.running.iter().find(|run| {
            now_ms() - run.started_ms > RUN_LIFETIME_MS
                || (run.pid != std::process::id() && !crate::daemon::lockfile::pid_alive(run.pid))
        }) {
            state.unchecked.get_or_insert_with(|| Unchecked {
                run_id: run.run_id.clone(),
                reason: "interrupted".into(),
                at: None,
                since_ms: run.started_ms,
            });
        }
        state
    }

    /// Execution must not mistake unreadable approval or hold records for a fresh recipe.
    pub(crate) fn read_state(&self, name: &str) -> anyhow::Result<State> {
        let bytes = read_limited(&self.dir(name)?.join("state.json"))?;
        serde_json::from_slice(&bytes).context("read recipe state; restore it before replaying")
    }

    fn write_state(&self, name: &str, state: &State) -> anyhow::Result<()> {
        write_private(
            &self.dir(name)?.join("state.json"),
            &serde_json::to_vec_pretty(state)?,
        )
    }

    /// Stores a validated recipe as the next revision. A change to what it does
    /// sends it back to draft until a run proves it. A file replaces a saved recipe
    /// only when it names the revision it was made from, so a fresh draft with a
    /// name already in use never overwrites that recipe by accident.
    pub(crate) fn save(
        &self,
        mut recipe: Recipe,
        declared_revision: bool,
    ) -> Result<Value, Refusal> {
        let storage =
            |error: anyhow::Error| Refusal::new("storage_unavailable", format!("{error:#}"));
        let _lock = self.lock_recipe(&recipe.name)?;
        let dir = self
            .dir(&recipe.name)
            .map_err(|error| Refusal::new("invalid_recipe", format!("{error:#}")))?;
        private_dir(&self.root).map_err(storage)?;
        private_dir(&dir).map_err(storage)?;
        let path = dir.join("recipe.json");
        let previous = path.is_file().then(|| self.load(&recipe.name));
        let mut state;
        match previous {
            None => {
                recipe.revision = 1;
                state = State {
                    created_ms: now_ms(),
                    ..State::default()
                };
            }
            Some(Err(_)) => {
                return Err(Refusal::new(
                    "invalid_recipe",
                    format!(
                        "the saved recipe {} cannot be read; remove it first",
                        recipe.name
                    ),
                ));
            }
            Some(Ok(previous)) => {
                state = self.read_state(&recipe.name).map_err(storage)?;
                if !declared_revision {
                    return Err(Refusal::new(
                        "recipe_exists",
                        format!(
                            "a recipe named {name} already exists at revision {current}. To replace \
                             it, set \"revision\": {current} in this file, as recipe show prints it; \
                             to keep both, choose another name",
                            name = recipe.name,
                            current = previous.revision
                        ),
                    ));
                }
                if recipe.revision != previous.revision {
                    return Err(Refusal::new(
                        "revision_conflict",
                        format!(
                            "this file is based on revision {}, but revision {} is current; \
                             start from recipe show",
                            recipe.revision, previous.revision
                        ),
                    ));
                }
                let revisions = dir.join("revisions");
                private_dir(&revisions).map_err(storage)?;
                let bytes = serde_json::to_vec_pretty(&previous).expect("serializable recipe");
                write_private(
                    &revisions.join(format!("{}.json", previous.revision)),
                    &bytes,
                )
                .map_err(storage)?;
                prune_revisions(&revisions);
                recipe.revision = previous.revision + 1;
                let mut before = previous;
                before.revision = recipe.revision;
                if before.description != recipe.description {
                    before.description.clone_from(&recipe.description);
                }
                if before != recipe {
                    state.status = Status::Draft;
                }
                state.handoff_streak = 0;
                state.handoff_at = None;
            }
        }
        let bytes = serde_json::to_vec_pretty(&recipe).expect("serializable recipe");
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(Refusal::new(
                "invalid_recipe",
                format!(
                    "saved recipe exceeds {MAX_FILE_BYTES} bytes after formatting; shorten constants or split the flow"
                ),
            ));
        }
        write_private(&path, &bytes).map_err(storage)?;
        self.write_state(&recipe.name, &state).map_err(storage)?;
        let mut reply = json!({"saved":true,"name":recipe.name,"revision":recipe.revision,
            "status":state.status,"path":path,"summary":recipe.summary()});
        if let Some(approval) = approval_note(&recipe, &state) {
            reply["approval"] = approval.into();
        }
        Ok(reply)
    }

    /// Whether the recipe may run: nothing lowered, or a person approved exactly this.
    pub(crate) fn approved(&self, recipe: &Recipe) -> bool {
        approval_note(recipe, &self.state(&recipe.name)) != Some("required")
    }

    /// Records a person's approval of the recipe as they reviewed it.
    pub(crate) fn approve(&self, recipe: &Recipe) -> anyhow::Result<()> {
        let _lock = self
            .lock_recipe(&recipe.name)
            .map_err(|error| anyhow::anyhow!(error.message))?;
        let current = self
            .load(&recipe.name)
            .map_err(|error| anyhow::anyhow!(error.message))?;
        ensure!(
            current == *recipe,
            "the recipe changed during review; review it again"
        );
        let mut state = self.read_state(&recipe.name)?;
        state.approval = Some(Approval {
            digest: approval_digest(recipe),
            revision: recipe.revision,
            approved_ms: now_ms(),
        });
        self.write_state(&recipe.name, &state)
    }

    pub(crate) fn remove(&self, name: &str) -> Result<bool, Refusal> {
        let _lock = self.lock_recipe(name)?;
        let dir = self
            .dir(name)
            .map_err(|error| Refusal::new("invalid_params", error.to_string()))?;
        if !dir.join("recipe.json").is_file() {
            return Ok(false);
        }
        fs::remove_dir_all(&dir).map_err(|error| {
            Refusal::new(
                "storage_unavailable",
                format!("remove {}: {error}", dir.display()),
            )
        })?;
        Ok(true)
    }

    fn entry(&self, recipe: &Recipe, state: &State) -> Value {
        let idle_since = state.last_success_ms.unwrap_or(state.created_ms);
        let mut entry = json!({"name":recipe.name,"description":recipe.description,
            "revision":recipe.revision,"status":state.status,"site":recipe.site,
            "params":recipe.params,"outputs":recipe.outputs.keys().collect::<Vec<_>>()});
        if idle_since > 0 && now_ms() - idle_since > UNUSED_NOTICE_MS {
            entry["notice"] = "No successful run in 90 days; it may be out of date.".into();
        }
        if state.status == Status::Stale {
            entry["notice"] = format!(
                "Stopped at the same point {} runs in a row ({}); the site may have changed.",
                state.handoff_streak,
                state.handoff_at.as_deref().unwrap_or("unknown")
            )
            .into();
        }
        if let Some(approval) = approval_note(recipe, state) {
            entry["approval"] = approval.into();
        }
        if let Some(unchecked) = &state.unchecked {
            entry["unchecked_run"] = unchecked.run_id.as_str().into();
            entry["notice"] = format!(
                "Run {} ended with an effect nobody has checked. Check the application's \
                 records, then run again with checked set to that run.",
                unchecked.run_id
            )
            .into();
        }
        entry
    }

    pub(crate) fn list(&self, site: Option<&str>) -> anyhow::Result<Value> {
        let mut recipes = Vec::new();
        let mut unreadable = Vec::new();
        let names = match fs::read_dir(&self.root) {
            Ok(entries) => entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| model::valid_name(name))
                .collect::<Vec<_>>(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error).context("read the recipes directory"),
        };
        for name in names {
            if !self.exists(&name) {
                continue;
            }
            match self.load(&name).and_then(|recipe| {
                self.read_state(&name)
                    .map_err(|error| Refusal::new("storage_unavailable", format!("{error:#}")))?;
                Ok(recipe)
            }) {
                Ok(recipe) => {
                    if site.is_none_or(|site| recipe.site.origins.iter().any(|o| o == site)) {
                        recipes.push(self.entry(&recipe, &self.state(&name)));
                    }
                }
                Err(refusal) => {
                    unreadable.push(
                        json!({"name":name,"reason":refusal.reason,"message":refusal.message}),
                    );
                }
            }
        }
        recipes.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        let mut reply = json!({"recipes":recipes});
        if !unreadable.is_empty() {
            reply["unreadable"] = unreadable.into();
        }
        Ok(reply)
    }

    pub(crate) fn show(&self, name: &str) -> Result<Value, Refusal> {
        let recipe = self.load(name)?;
        self.read_state(name)
            .map_err(|error| Refusal::new("storage_unavailable", format!("{error:#}")))?;
        let state = self.state(name);
        let mut reply = json!({"recipe":recipe,"state":state,"summary":recipe.summary()});
        if let Some(approval) = approval_note(&recipe, &state) {
            reply["approval"] = approval.into();
        }
        Ok(reply)
    }

    /// A log nobody can write is not a reason to stop a run.
    pub(crate) fn run_log(&self, name: &str, run_id: &str) -> RunLog {
        let open = || -> anyhow::Result<fs::File> {
            let runs = self.dir(name)?.join("runs");
            private_dir(&runs)?;
            prune_runs(&runs);
            let mut options = fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            Ok(options.open(runs.join(format!("{run_id}.jsonl")))?)
        };
        RunLog { file: open().ok() }
    }

    /// `at` names where the page deviated, when it did. A person stepping in says
    /// nothing about the recipe. A failure to save costs a counter, not the result.
    pub(crate) fn record_outcome(&self, name: &str, status: &str, at: Option<&str>) {
        let Ok(mut state) = self.read_state(name) else {
            return;
        };
        let now = now_ms();
        state.runs += 1;
        state.last_run_ms = Some(now);
        match status {
            "completed" => {
                state.completed += 1;
                state.last_success_ms = Some(now);
                state.status = Status::Verified;
                state.handoff_streak = 0;
                state.handoff_at = None;
            }
            "handoff" => {
                state.handoffs += 1;
                if at.is_some() {
                    state.handoff_streak = if state.handoff_at.as_deref() == at {
                        state.handoff_streak + 1
                    } else {
                        1
                    };
                    state.handoff_at = at.map(str::to_owned);
                    if state.handoff_streak >= STALE_AFTER_HANDOFFS {
                        state.status = Status::Stale;
                    }
                }
            }
            "uncertain" => state.uncertain += 1,
            _ => {}
        }
        let _ = self.write_state(name, &state);
    }

    /// Marks a run as started. One that dies before [`Self::finish_run`], with its
    /// process, is taken as unchecked: it may have sent input nobody saw the result of.
    pub(crate) fn start_run(&self, name: &str, run_id: &str) -> anyhow::Result<()> {
        let mut state = self.read_state(name)?;
        ensure!(
            state.unchecked.is_none(),
            "the previous run still needs checking"
        );
        state.running.push(Running {
            run_id: run_id.to_owned(),
            pid: std::process::id(),
            started_ms: now_ms(),
        });
        self.write_state(name, &state)
    }

    /// Clears the run's marker and, for a run whose effect is unknown, holds the
    /// recipe until the caller says it was checked.
    pub(crate) fn finish_run(
        &self,
        name: &str,
        run_id: &str,
        unchecked: Option<Unchecked>,
    ) -> anyhow::Result<()> {
        let mut state = self.read_state(name)?;
        state.running.retain(|run| run.run_id != run_id);
        if let Some(unchecked) = unchecked {
            state.unchecked = Some(Unchecked {
                since_ms: now_ms(),
                ..unchecked
            });
        }
        self.write_state(name, &state)
    }

    /// Call only with the recipe lock held. Any leftover marker belongs to a run
    /// that released its lock without recording an outcome, even in a live MCP host.
    pub(crate) fn unchecked(&self, name: &str) -> Option<Unchecked> {
        let mut state = self.state(name);
        if let Some(run) = state.running.first() {
            state.unchecked.get_or_insert_with(|| Unchecked {
                run_id: run.run_id.clone(),
                reason: "interrupted".into(),
                at: None,
                since_ms: run.started_ms,
            });
            state.running.clear();
            let _ = self.write_state(name, &state);
        }
        state.unchecked
    }

    /// Releases the hold once the caller names the run whose effect they checked.
    pub(crate) fn release(&self, name: &str, run_id: &str) -> bool {
        let mut state = self.state(name);
        if state
            .unchecked
            .as_ref()
            .is_none_or(|unchecked| unchecked.run_id != run_id)
        {
            return false;
        }
        state.unchecked = None;
        self.write_state(name, &state).is_ok()
    }

    /// The same recipe cannot run, change revision or be removed concurrently.
    pub(crate) fn lock_recipe(&self, name: &str) -> Result<StoreLock, Refusal> {
        self.dir(name)
            .map_err(|error| Refusal::new("invalid_params", error.to_string()))?;
        self.lock("recipe", name)
    }

    /// One recipe at a time per session; the lock ends with the process.
    pub(crate) fn lock_session(&self, session: &str) -> Result<StoreLock, Refusal> {
        self.lock("session", session)
    }

    fn lock(&self, scope: &str, key: &str) -> Result<StoreLock, Refusal> {
        let storage = |error| {
            Refusal::new(
                "storage_unavailable",
                format!("cannot lock {scope}: {error}"),
            )
        };
        let dir = self.root.join(".locks");
        private_dir(&self.root).map_err(storage)?;
        private_dir(&dir).map_err(storage)?;
        let hash: String = Sha256::digest(key.as_bytes())
            .iter()
            .take(8)
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let path = dir.join(format!("{scope}-{hash}"));
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|error| storage(error.into()))?;
        if let Err(error) = fs2::FileExt::try_lock_exclusive(&file) {
            return Err(
                if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
                    Refusal::new(
                        if scope == "recipe" {
                            "recipe_busy"
                        } else {
                            "session_busy"
                        },
                        format!("{scope} {key} is already in use by a recipe operation"),
                    )
                } else {
                    storage(error.into())
                },
            );
        }
        Ok(StoreLock { file })
    }
}

pub(crate) struct StoreLock {
    file: fs::File,
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        // Keep the inode: another process may already have opened this path.
        // Unlinking it would let a third process lock a different file at the same path.
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::recipe::model::tests::{parsed, report};

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::at(dir.path().join("recipes"));
        (dir, store)
    }

    /// Saves a new recipe, or the next revision of a saved one, as an edited copy would.
    fn put(store: &Store, mut value: Value) -> Value {
        let name = value["name"].as_str().unwrap().to_owned();
        let based = store.load(&name).ok().map(|current| current.revision);
        if let Some(revision) = based {
            value["revision"] = revision.into();
        }
        store.save(parsed(value).unwrap(), based.is_some()).unwrap()
    }

    #[test]
    fn saving_creates_private_files_and_new_revisions_keep_the_old_ones() {
        let (_dir, store) = store();
        let reply = store.save(parsed(report()).unwrap(), false).unwrap();
        assert_eq!(reply["revision"], 1);
        assert_eq!(reply["status"], "draft");
        assert!(reply["summary"]["steps"].as_array().unwrap().len() == 3);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: PathBuf| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            let dir = store.root.join("sales-report");
            assert_eq!(mode(store.root.clone()), 0o700);
            assert_eq!(mode(dir.clone()), 0o700);
            assert_eq!(mode(dir.join("recipe.json")), 0o600);
            assert_eq!(mode(dir.join("state.json")), 0o600);
        }
        let mut next = report();
        next["segments"][0]["until"]["timeout_ms"] = 2000.into();
        let reply = put(&store, next);
        assert_eq!(reply["revision"], 2);
        assert!(store.root.join("sales-report/revisions/1.json").is_file());
    }

    #[test]
    fn saving_never_publishes_a_document_larger_than_the_reader_accepts() {
        let (_dir, store) = store();
        store.save(parsed(report()).unwrap(), false).unwrap();
        assert!(
            parse_document(&vec![b' '; MAX_FILE_BYTES as usize + 1])
                .unwrap_err()
                .message
                .contains("exceeds")
        );
        let mut large = report();
        large["revision"] = 1.into();
        large["segments"][0]["steps"][0]["values"] = json!([""]);
        let overhead = serde_json::to_vec(&large).unwrap().len();
        large["segments"][0]["steps"][0]["values"][0] =
            "x".repeat(MAX_FILE_BYTES as usize - overhead - 1).into();
        // The compact input fits; the canonical pretty-printed document does not.
        let input = serde_json::to_vec(&large).unwrap();
        let recipe = parse_document(&input).unwrap();
        assert!(serde_json::to_vec_pretty(&recipe).unwrap().len() > MAX_FILE_BYTES as usize);
        let refusal = store.save(recipe, true).unwrap_err();
        assert_eq!(refusal.reason, "invalid_recipe");
        assert_eq!(store.load("sales-report").unwrap().revision, 1);
    }

    #[test]
    fn revisions_are_bounded_and_a_stale_base_is_rejected() {
        let (_dir, store) = store();
        for timeout in 1..=13 {
            let mut next = report();
            next["segments"][0]["until"]["timeout_ms"] = (timeout * 100).into();
            put(&store, next);
        }
        let revisions = fs::read_dir(store.root.join("sales-report/revisions")).unwrap();
        assert_eq!(revisions.count(), MAX_REVISIONS);
        let mut old = report();
        old["revision"] = 3.into();
        let error = store.save(parsed(old).unwrap(), true).unwrap_err();
        assert_eq!(error.reason, "revision_conflict");
        assert!(error.message.contains("based on revision 3"), "{error:?}");
        assert_eq!(store.load("sales-report").unwrap().revision, 13);
    }

    #[test]
    fn a_file_without_its_revision_cannot_replace_a_saved_recipe() {
        let (_dir, store) = store();
        store.save(parsed(report()).unwrap(), false).unwrap();
        // A fresh draft has no revision: it would silently replace different steps.
        let mut fresh = report();
        fresh["segments"][0]["steps"][2]["target"]["name"] = "Find".into();
        let error = store
            .save(parsed(fresh.clone()).unwrap(), false)
            .unwrap_err();
        assert_eq!(error.reason, "recipe_exists");
        assert!(error.message.contains("\"revision\": 1"), "{error:?}");
        let current = store.load("sales-report").unwrap();
        assert_eq!(current.revision, 1);
        assert_eq!(current.segments[0].steps[2].target.name, "Search");
        // Naming the revision it replaces is a deliberate replacement.
        fresh["revision"] = 1.into();
        let saved = store.save(parsed(fresh).unwrap(), true).unwrap();
        assert_eq!(saved["revision"], 2);
    }

    #[test]
    fn a_first_success_verifies_and_changing_behavior_returns_to_draft() {
        let (_dir, store) = store();
        store.save(parsed(report()).unwrap(), false).unwrap();
        store.record_outcome("sales-report", "completed", None);
        assert_eq!(store.state("sales-report").status, Status::Verified);
        // Rewording the description keeps what a run proved.
        let mut reworded = report();
        reworded["description"] = "Reworded".into();
        put(&store, reworded);
        assert_eq!(store.state("sales-report").status, Status::Verified);
        // Different steps prove nothing yet.
        let mut changed = report();
        changed["segments"][0]["steps"][2]["target"]["name"] = "Find".into();
        put(&store, changed);
        assert_eq!(store.state("sales-report").status, Status::Draft);
    }

    #[test]
    fn an_approval_covers_exactly_the_steps_a_person_reviewed() {
        let (_dir, store) = store();
        let mut lowered = report();
        lowered["segments"][0]["steps"][2]["target"]["name"] = "Save filters".into();
        lowered["segments"][0]["steps"][2]["risk"] = "reversible".into();
        let saved = store.save(parsed(lowered.clone()).unwrap(), false).unwrap();
        assert_eq!(saved["approval"], "required");
        let recipe = store.load("sales-report").unwrap();
        assert!(!store.approved(&recipe));
        store.approve(&recipe).unwrap();
        assert!(store.approved(&recipe));
        assert_eq!(store.show("sales-report").unwrap()["approval"], "approved");
        assert_eq!(
            store.list(None).unwrap()["recipes"][0]["approval"],
            "approved"
        );
        // Rewording the description changes nothing a person approved.
        let mut reworded = lowered.clone();
        reworded["description"] = "Reworded".into();
        let saved = put(&store, reworded);
        assert_eq!(saved["approval"], "approved");
        // Anything else needs approving again.
        let mut changed = lowered;
        changed["segments"][0]["until"]["timeout_ms"] = 2000.into();
        let saved = put(&store, changed);
        assert_eq!(saved["approval"], "required");
        assert!(
            store
                .approve(&recipe)
                .unwrap_err()
                .to_string()
                .contains("changed during review")
        );
        assert!(!store.approved(&store.load("sales-report").unwrap()));

        // A recipe that lowers nothing needs no approval.
        let (_other, plain) = self::store();
        let saved = plain.save(parsed(report()).unwrap(), false).unwrap();
        assert!(saved.get("approval").is_none());
        assert!(plain.approved(&plain.load("sales-report").unwrap()));
    }

    #[test]
    fn three_handoffs_at_one_step_mark_it_stale_until_a_run_succeeds() {
        let (_dir, store) = store();
        store.save(parsed(report()).unwrap(), false).unwrap();
        store.record_outcome("sales-report", "completed", None);
        store.record_outcome("sales-report", "handoff", Some("query/1"));
        store.record_outcome("sales-report", "handoff", Some("query/2"));
        store.record_outcome("sales-report", "handoff", Some("query/2"));
        // A person stepping in is not the recipe's fault.
        store.record_outcome("sales-report", "handoff", None);
        assert_eq!(store.state("sales-report").status, Status::Verified);
        store.record_outcome("sales-report", "handoff", Some("query/2"));
        let state = store.state("sales-report");
        assert_eq!((state.status, state.handoff_streak), (Status::Stale, 3));
        let listed = store.list(None).unwrap();
        assert!(
            listed["recipes"][0]["notice"]
                .as_str()
                .unwrap()
                .contains("query/2")
        );
        store.record_outcome("sales-report", "completed", None);
        let state = store.state("sales-report");
        assert_eq!((state.status, state.handoff_streak), (Status::Verified, 0));
    }

    #[test]
    fn listing_filters_by_site_and_reports_unreadable_files() {
        let (_dir, store) = store();
        assert_eq!(store.list(None).unwrap()["recipes"], json!([]));
        store.save(parsed(report()).unwrap(), false).unwrap();
        assert_eq!(
            store.list(Some("https://erp.example.com")).unwrap()["recipes"][0]["name"],
            "sales-report"
        );
        assert_eq!(
            store.list(Some("https://other.test")).unwrap()["recipes"],
            json!([])
        );
        let broken = store.root.join("broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("recipe.json"), "{").unwrap();
        assert_eq!(store.list(None).unwrap()["unreadable"][0]["name"], "broken");
    }

    #[test]
    fn a_name_can_never_leave_the_recipes_directory() {
        let (_dir, store) = store();
        for name in ["../up", "a/b", "..", ".hidden", "", "CON", "nul"] {
            assert!(store.load(name).is_err(), "{name}");
            assert!(store.remove(name).is_err(), "{name}");
        }
    }

    #[test]
    fn logs_hold_no_parameter_values_and_are_bounded() {
        let (_dir, store) = store();
        store.save(parsed(report()).unwrap(), false).unwrap();
        let values = BTreeMap::from([("region".to_string(), "secret-region".to_string())]);
        let digest = params_digest(&values);
        assert_eq!(digest.len(), 16);
        assert!(!digest.contains("secret"));
        let mut log = store.run_log("sales-report", "r-1");
        log.event("start", json!({"params_digest":digest}));
        let written = fs::read_to_string(store.root.join("sales-report/runs/r-1.jsonl")).unwrap();
        assert!(written.contains(&digest) && written.contains("\"event\":\"start\""));
        for index in 0..60 {
            store.run_log("sales-report", &format!("r-more-{index}"));
        }
        let runs = fs::read_dir(store.root.join("sales-report/runs")).unwrap();
        assert!(runs.count() <= MAX_RUNS + 1);
    }

    #[test]
    fn an_unknown_effect_holds_the_recipe_until_the_caller_names_the_run() {
        let (_dir, store) = store();
        store.save(parsed(report()).unwrap(), false).unwrap();
        store.start_run("sales-report", "r-clean").unwrap();
        assert_eq!(store.state("sales-report").running.len(), 1);
        store.finish_run("sales-report", "r-clean", None).unwrap();
        assert!(store.state("sales-report").running.is_empty());

        store.start_run("sales-report", "r-1").unwrap();
        store
            .finish_run(
                "sales-report",
                "r-1",
                Some(Unchecked {
                    run_id: "r-1".into(),
                    reason: "effect_unknown".into(),
                    at: Some("query/2".into()),
                    since_ms: 0,
                }),
            )
            .unwrap();
        let held = store.unchecked("sales-report").unwrap();
        assert_eq!(
            (held.run_id.as_str(), held.at.as_deref()),
            ("r-1", Some("query/2"))
        );
        assert!(held.since_ms > 0);
        assert!(!store.release("sales-report", "r-2"));
        assert!(store.unchecked("sales-report").is_some());
        assert!(store.release("sales-report", "r-1"));
        assert!(store.unchecked("sales-report").is_none());

        // A run whose process died, or that outlived any budget, never reported.
        for running in [
            json!({"run_id":"r-live-host","pid":std::process::id(),"started_ms":now_ms()}),
            json!({"run_id":"r-dead","pid":u32::MAX,"started_ms":now_ms()}),
            json!({"run_id":"r-old","pid":std::process::id(),"started_ms":1}),
        ] {
            let mut state = store.state("sales-report");
            state.running = vec![serde_json::from_value(running).unwrap()];
            store.write_state("sales-report", &state).unwrap();
            let held = store.unchecked("sales-report").unwrap();
            assert_eq!(held.reason, "interrupted");
            assert!(store.state("sales-report").running.is_empty());
            assert!(store.release("sales-report", &held.run_id));
        }
    }

    #[test]
    fn a_session_runs_one_recipe_at_a_time() {
        let (_dir, store) = store();
        let held = store.lock_session("s1").unwrap();
        assert_eq!(
            store.lock_session("s1").err().unwrap().reason,
            "session_busy"
        );
        let _other = store.lock_session("s2").unwrap();
        drop(held);
        let _next = store.lock_session("s1").unwrap();
    }

    #[test]
    fn recipe_operations_share_a_stable_lock_separate_from_session_locks() {
        let (_dir, store) = store();
        let saved = parsed(report()).unwrap();
        store.save(saved.clone(), false).unwrap();
        let held = store.lock_recipe("sales-report").unwrap();
        assert_eq!(
            store.lock_recipe("sales-report").err().unwrap().reason,
            "recipe_busy"
        );
        assert_eq!(store.save(saved, true).unwrap_err().reason, "recipe_busy");
        assert_eq!(
            store.remove("sales-report").unwrap_err().reason,
            "recipe_busy"
        );
        let _session = store.lock_session("sales-report").unwrap();
        // Open before release, as a competing process can. It and any fresh opener
        // must still contend for the same inode after the original lock is gone.
        let path = fs::read_dir(store.root.join(".locks"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("recipe-")
            })
            .unwrap();
        let opened = fs::OpenOptions::new().write(true).open(path).unwrap();
        drop(held);
        fs2::FileExt::try_lock_exclusive(&opened).unwrap();
        assert_eq!(
            store.lock_recipe("sales-report").err().unwrap().reason,
            "recipe_busy"
        );
        drop(opened);
        let _next = store.lock_recipe("sales-report").unwrap();
    }

    #[test]
    fn unreadable_state_cannot_be_overwritten_by_a_new_run_or_revision() {
        let (_dir, store) = store();
        store.save(parsed(report()).unwrap(), false).unwrap();
        let path = store.root.join("sales-report/state.json");
        fs::write(&path, b"broken state").unwrap();
        assert!(store.start_run("sales-report", "r-new").is_err());
        assert_eq!(
            store
                .save(parsed(report()).unwrap(), true)
                .unwrap_err()
                .reason,
            "storage_unavailable"
        );
        assert_eq!(fs::read(&path).unwrap(), b"broken state");
    }

    #[test]
    fn removing_a_recipe_deletes_its_directory() {
        let (_dir, store) = store();
        store.save(parsed(report()).unwrap(), false).unwrap();
        assert!(store.remove("sales-report").unwrap());
        assert!(!store.remove("sales-report").unwrap());
        assert_eq!(
            store.load("sales-report").unwrap_err().reason,
            "recipe_not_found"
        );
    }
}
