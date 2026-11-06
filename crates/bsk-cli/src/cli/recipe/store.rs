//! Recipes on disk: `$BSK_HOME/recipes/<name>/`, private to this user.
//!
//! ```text
//! recipe.json          the current revision
//! state.json           draft/verified/stale and local counters
//! revisions/2.json     earlier revisions, at most ten
//! runs/r-7f3a.jsonl    step status and a parameter digest, never parameter values
//! ```
use super::model::{self, Recipe, Refusal};
use anyhow::{Context, bail, ensure};
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
        self.dir(name)
            .ok()
            .and_then(|dir| fs::read(dir.join("state.json")).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write_state(&self, name: &str, state: &State) -> anyhow::Result<()> {
        write_private(
            &self.dir(name)?.join("state.json"),
            &serde_json::to_vec_pretty(state)?,
        )
    }

    /// Stores a validated recipe as the next revision. A change to what it does
    /// sends it back to draft until a run proves it.
    pub(crate) fn save(
        &self,
        mut recipe: Recipe,
        declared_revision: bool,
    ) -> anyhow::Result<Value> {
        let dir = self.dir(&recipe.name)?;
        private_dir(&self.root)?;
        private_dir(&dir)?;
        let path = dir.join("recipe.json");
        let previous = path.is_file().then(|| self.load(&recipe.name));
        let mut state = self.state(&recipe.name);
        match previous {
            None => {
                recipe.revision = 1;
                state = State {
                    created_ms: now_ms(),
                    ..State::default()
                };
            }
            Some(Err(_)) => bail!(
                "the saved recipe {} cannot be read; remove it first",
                recipe.name
            ),
            Some(Ok(previous)) => {
                if declared_revision && recipe.revision != previous.revision {
                    bail!(
                        "this file is based on revision {}, but revision {} is current; \
                         start from recipe show",
                        recipe.revision,
                        previous.revision
                    );
                }
                let revisions = dir.join("revisions");
                private_dir(&revisions)?;
                write_private(
                    &revisions.join(format!("{}.json", previous.revision)),
                    &serde_json::to_vec_pretty(&previous)?,
                )?;
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
        write_private(&path, &serde_json::to_vec_pretty(&recipe)?)?;
        self.write_state(&recipe.name, &state)?;
        Ok(
            json!({"saved":true,"name":recipe.name,"revision":recipe.revision,
            "status":state.status,"path":path,"summary":recipe.summary()}),
        )
    }

    pub(crate) fn remove(&self, name: &str) -> anyhow::Result<bool> {
        let dir = self.dir(name)?;
        if !dir.join("recipe.json").is_file() {
            return Ok(false);
        }
        fs::remove_dir_all(&dir).with_context(|| format!("remove {}", dir.display()))?;
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
            match self.load(&name) {
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
        let state = self.state(name);
        Ok(json!({"recipe":recipe,"state":state,"summary":recipe.summary()}))
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
        let mut state = self.state(name);
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

    /// One recipe at a time per session; the lock ends with the process.
    pub(crate) fn lock_session(&self, session: &str) -> Result<Option<SessionLock>, Refusal> {
        let dir = self.root.join(".locks");
        if private_dir(&self.root).is_err() || private_dir(&dir).is_err() {
            return Ok(None);
        }
        let hash: String = Sha256::digest(session.as_bytes())
            .iter()
            .take(8)
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let path = dir.join(hash);
        let Ok(file) = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
        else {
            return Ok(None);
        };
        if fs2::FileExt::try_lock_exclusive(&file).is_err() {
            return Err(Refusal::new(
                "session_busy",
                format!("session {session} is already running a recipe"),
            ));
        }
        Ok(Some(SessionLock { file, path }))
    }
}

pub(crate) struct SessionLock {
    file: fs::File,
    path: PathBuf,
}

impl Drop for SessionLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
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
        let reply = store.save(parsed(next).unwrap(), false).unwrap();
        assert_eq!(reply["revision"], 2);
        assert!(store.root.join("sales-report/revisions/1.json").is_file());
    }

    #[test]
    fn revisions_are_bounded_and_a_stale_base_is_rejected() {
        let (_dir, store) = store();
        for timeout in 1..=13 {
            let mut next = report();
            next["segments"][0]["until"]["timeout_ms"] = (timeout * 100).into();
            store.save(parsed(next).unwrap(), false).unwrap();
        }
        let revisions = fs::read_dir(store.root.join("sales-report/revisions")).unwrap();
        assert_eq!(revisions.count(), MAX_REVISIONS);
        let mut old = report();
        old["revision"] = 3.into();
        let error = store.save(parsed(old).unwrap(), true).unwrap_err();
        assert!(error.to_string().contains("based on revision 3"), "{error}");
        assert_eq!(store.load("sales-report").unwrap().revision, 13);
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
        store.save(parsed(reworded).unwrap(), false).unwrap();
        assert_eq!(store.state("sales-report").status, Status::Verified);
        // Different steps prove nothing yet.
        let mut changed = report();
        changed["segments"][0]["steps"][2]["target"]["name"] = "Find".into();
        store.save(parsed(changed).unwrap(), false).unwrap();
        assert_eq!(store.state("sales-report").status, Status::Draft);
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
    fn a_session_runs_one_recipe_at_a_time() {
        let (_dir, store) = store();
        let held = store.lock_session("s1").unwrap();
        assert!(held.is_some());
        assert_eq!(
            store.lock_session("s1").err().unwrap().reason,
            "session_busy"
        );
        assert!(store.lock_session("s2").unwrap().is_some());
        drop(held);
        assert!(store.lock_session("s1").unwrap().is_some());
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
