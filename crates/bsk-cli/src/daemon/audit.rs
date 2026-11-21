//! Opt-in, local operation history. Only an allowlist of metadata reaches disk.
//! Browser ownership comes from the connected peer, never from query parameters.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
pub use bsk_protocol::system::{AuditEvent, AuditRun};
use bsk_protocol::{AuditContextEvent, ErrorCode, Method, ResponseBody};
use serde_json::{Value, json};

use super::sessions::Session;

const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const MAX_RUN_BYTES: u64 = 16 * 1024 * 1024;
const PAGE_SIZE: usize = 100;

#[derive(Debug, Clone)]
struct LiveSession {
    live_id: u64,
    session: Session,
    run_id: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Ticket {
    pub run_id: String,
    pub operation_id: String,
    browser_id: String,
    epoch: u64,
}

#[derive(Debug, Default)]
struct Inner {
    loaded: bool,
    next_live_id: u64,
    enabled: HashSet<String>,
    pending_pause_browsers: HashSet<String>,
    epochs: HashMap<String, u64>,
    sessions: HashMap<String, LiveSession>,
    closing_sessions: HashMap<u64, LiveSession>,
    runs: BTreeMap<String, AuditRun>,
    pending: HashMap<String, Ticket>,
    last_error: HashMap<String, String>,
}

#[derive(Debug)]
pub struct AuditStore {
    root: Option<PathBuf>,
    io_lock: Mutex<()>,
    inner: Mutex<Inner>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

impl AuditStore {
    pub fn new(root: Option<PathBuf>) -> Self {
        Self {
            root,
            io_lock: Mutex::new(()),
            inner: Mutex::new(Inner::default()),
        }
    }

    pub fn directory(&self) -> Result<&Path> {
        self.root
            .as_deref()
            .context("Audit directory is unavailable")
    }

    /// Lock-free-of-disk fast check: returns `true` only when `session_id` belongs to a
    /// live session whose browser currently has local audit collection enabled.
    pub fn needs_begin(&self, session_id: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner
            .sessions
            .get(session_id)
            .is_some_and(|live| inner.enabled.contains(&live.session.browser_id.0))
    }

    /// Fast in-memory check for inbound `AuditContext` events from `ws.rs`.
    pub fn needs_context(&self, browser: &str, operation_id: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.pending.get(operation_id).is_some_and(|ticket| {
            ticket.browser_id == browser
                && inner.enabled.contains(browser)
                && inner.epochs.get(browser).copied().unwrap_or(0) == ticket.epoch
        })
    }

    /// Fast in-memory check for session audit markers.
    pub fn needs_marker(&self, session_id: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.sessions.get(session_id).is_some_and(|live| {
            live.run_id.is_some() && inner.enabled.contains(&live.session.browser_id.0)
        })
    }

    fn ensure_loaded_unlocked(&self) -> Result<()> {
        if self.inner.lock().unwrap().loaded {
            return Ok(());
        }
        let root = self.directory()?;
        let mut loaded_runs = BTreeMap::new();
        if root.exists() {
            for entry in fs::read_dir(root)? {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(err) => {
                        tracing::warn!(%err, "skipping unreadable audit directory entry");
                        continue;
                    }
                };
                let file_type = match entry.file_type() {
                    Ok(ft) => ft,
                    Err(err) => {
                        tracing::warn!(
                            path = %entry.path().display(),
                            %err,
                            "skipping audit entry with unreadable file type"
                        );
                        continue;
                    }
                };
                if !file_type.is_file() {
                    continue;
                }
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                match load_run_file(&path) {
                    Ok(Some(run)) => {
                        loaded_runs.insert(run.id.clone(), run);
                    }
                    Ok(None) => {}
                    Err(err) => {
                        tracing::warn!(
                            path = %path.display(),
                            %err,
                            "skipping corrupt or unexpected audit file"
                        );
                    }
                }
            }
        }
        {
            let mut inner = self.inner.lock().unwrap();
            if !inner.loaded {
                for (id, run) in loaded_runs {
                    inner.runs.entry(id).or_insert(run);
                }
                inner.loaded = true;
            }
        }
        self.prune_unlocked(now_ms())
    }

    fn path(&self, id: &str) -> Result<PathBuf> {
        if id.len() > 80
            || !id
                .bytes()
                .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() || c == b'-')
        {
            bail!("Invalid audit ID");
        }
        Ok(self.directory()?.join(format!("{id}.jsonl")))
    }

    fn write_event_to_disk(&self, id: &str, event: &AuditEvent) -> Result<()> {
        let root = self.directory()?;
        fs::create_dir_all(root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
        }
        let path = self.path(id)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true);
        if event.kind == "started" {
            options.create_new(true);
        } else {
            let meta = fs::symlink_metadata(&path)?;
            if !meta.is_file() || meta.len() > MAX_RUN_BYTES {
                bail!("Audit file unavailable or size limit reached");
            }
            options.append(true);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        if event.kind != "started" {
            // Never append behind a partial write: that would turn a recoverable
            // trailing record into a corrupt line in the middle of the history.
            file.seek(SeekFrom::End(-1))?;
            let mut last = [0];
            file.read_exact(&mut last)?;
            if last[0] != b'\n' {
                bail!("Audit file has an incomplete trailing record");
            }
        }
        let mut line = serde_json::to_vec(event)?;
        line.push(b'\n');
        file.write_all(&line)?;
        file.sync_data()?;
        Ok(())
    }

    fn append_unlocked(&self, id: &str, event: AuditEvent) -> Result<()> {
        self.write_event_to_disk(id, &event)?;
        let mut inner = self.inner.lock().unwrap();
        if let Some(run) = inner.runs.get_mut(id) {
            project(run, &event);
        }
        Ok(())
    }

    fn ensure_run_unlocked(&self, session_id: &str, partial: bool) -> Result<Option<String>> {
        let live = {
            let inner = self.inner.lock().unwrap();
            let Some(live) = inner.sessions.get(session_id).cloned() else {
                return Ok(None);
            };
            if !inner.enabled.contains(&live.session.browser_id.0) {
                return Ok(None);
            }
            if let Some(id) = live.run_id {
                return Ok(Some(id));
            }
            live
        };
        self.ensure_loaded_unlocked()?;
        let at = now_ms();
        self.prune_unlocked(at)?;
        let id = format!("{at}-{}", uuid::Uuid::new_v4());
        let run = AuditRun {
            id: id.clone(),
            browser_id: live.session.browser_id.0.clone(),
            session_id: session_id.into(),
            started_at: live.session.created_at_ms,
            recorded_at: at,
            updated_at: at,
            status: "running".into(),
            name: live.name,
            site: None,
            operations: 0,
            errors: 0,
            partial,
        };
        let started = event("started", None, serde_json::to_value(&run)?);
        self.write_event_to_disk(&id, &started)?;
        let mut inner = self.inner.lock().unwrap();
        inner.runs.insert(id.clone(), run);
        if let Some(live_mut) = inner
            .sessions
            .get_mut(session_id)
            .filter(|l| l.live_id == live.live_id)
        {
            live_mut.run_id = Some(id.clone());
        } else if let Some(closing_mut) = inner.closing_sessions.get_mut(&live.live_id) {
            closing_mut.run_id = Some(id.clone());
        }
        Ok(Some(id))
    }

    /// Record a live session in memory without touching `io_lock`. Returns
    /// `true` when audit is enabled for the session's browser and the caller
    /// should invoke [`Self::ensure_session_started`] (e.g. on `spawn_blocking`).
    pub fn register_session_in_memory(&self, session: &Session) -> bool {
        let mut inner = self.inner.lock().unwrap();
        inner.next_live_id = inner.next_live_id.wrapping_add(1);
        let live_id = inner.next_live_id;
        inner.sessions.insert(
            session.id.0.clone(),
            LiveSession {
                live_id,
                session: session.clone(),
                run_id: None,
                name: None,
            },
        );
        inner.enabled.contains(&session.browser_id.0)
    }

    pub fn ensure_session_started(&self, session_id: &str, browser_id: &str) {
        let _io = self.io_lock.lock().unwrap();
        if self.ensure_run_unlocked(session_id, false).is_err() {
            self.inner
                .lock()
                .unwrap()
                .last_error
                .insert(browser_id.to_owned(), "write_failed".into());
        }
    }

    pub fn session_started(&self, session: &Session) {
        if self.register_session_in_memory(session) {
            self.ensure_session_started(&session.id.0, &session.browser_id.0);
        }
    }

    pub fn set_name(&self, session_id: &str, name: &str) {
        let name = safe_text(name);
        let needs_disk = {
            let mut inner = self.inner.lock().unwrap();
            let Some(live) = inner.sessions.get_mut(session_id) else {
                return;
            };
            live.name = Some(name.clone());
            let browser = live.session.browser_id.0.clone();
            inner.enabled.contains(&browser)
        };
        if !needs_disk {
            return;
        }
        let _io = self.io_lock.lock().unwrap();
        let target = {
            let inner = self.inner.lock().unwrap();
            inner.sessions.get(session_id).and_then(|live| {
                let browser = live.session.browser_id.0.clone();
                inner
                    .enabled
                    .contains(&browser)
                    .then_some(live.run_id.clone().map(|id| (id, browser)))
                    .flatten()
            })
        };
        if let Some((id, browser)) = target
            && self
                .append_unlocked(&id, event("named", None, json!({"name": name})))
                .is_err()
        {
            self.inner
                .lock()
                .unwrap()
                .last_error
                .insert(browser, "write_failed".into());
        }
    }

    /// Detach `session_id` from active in-memory tracking without touching
    /// `io_lock`. Returns `Some(live_id)` when a blocking disk flush via
    /// [`Self::finish_session_end`] is needed to finalize an active audit run.
    pub fn prepare_session_end(&self, session_id: &str) -> Option<u64> {
        let mut inner = self.inner.lock().unwrap();
        let live = inner.sessions.remove(session_id)?;
        let needs_io = live.run_id.is_some() || inner.enabled.contains(&live.session.browser_id.0);
        if !needs_io {
            return None;
        }
        let live_id = live.live_id;
        inner.closing_sessions.insert(live_id, live);
        Some(live_id)
    }

    pub fn finish_session_end(&self, live_id: u64, status: &str) {
        let _io = self.io_lock.lock().unwrap();
        let removed = self
            .inner
            .lock()
            .unwrap()
            .closing_sessions
            .remove(&live_id)
            .and_then(|live| live.run_id.map(|id| (id, live.session.browser_id.0)));
        if let Some((id, browser_id)) = removed {
            // Even while recording is paused, close the history's lifecycle.
            if self
                .append_unlocked(&id, event("ended", None, json!({"status": status})))
                .is_err()
            {
                let mut inner = self.inner.lock().unwrap();
                inner.last_error.insert(browser_id, "write_failed".into());
                if let Some(run) = inner.runs.get_mut(&id) {
                    run.status = "interrupted".into();
                }
            }
        }
    }

    pub fn session_ended(&self, session_id: &str, status: &str) {
        if let Some(live_id) = self.prepare_session_end(session_id) {
            self.finish_session_end(live_id, status);
        }
    }

    /// Immediately apply an opt-out in memory without touching `io_lock`.
    /// Called synchronously when `configure(enabled = false)` arrives on WS so
    /// no subsequent tool RPC can start recording while earlier audit worker
    /// items (e.g. a 16 MiB `audit.request(get)`) are still running. Records
    /// `pending_pause_browsers` so the queued `configure(false)` still emits
    /// the `"paused"` event on existing runs once it reaches the worker.
    pub fn disable_in_memory(&self, browser: &str) {
        let mut inner = self.inner.lock().unwrap();
        if inner.enabled.remove(browser) {
            *inner.epochs.entry(browser.into()).or_default() += 1;
            inner.pending_pause_browsers.insert(browser.into());
        }
    }

    pub fn configure(&self, browser: &str, enabled: bool) -> Result<Value> {
        let _io = self.io_lock.lock().unwrap();
        let (transitioned, sessions) = {
            let mut inner = self.inner.lock().unwrap();
            let previous = inner.enabled.contains(browser);
            let was_pending_pause = inner.pending_pause_browsers.remove(browser);
            // Apply the privacy preference before any fallible I/O. A broken disk
            // must never prevent the user from stopping collection.
            if enabled {
                inner.enabled.insert(browser.into());
            } else {
                inner.enabled.remove(browser);
            }
            if previous != enabled {
                *inner.epochs.entry(browser.into()).or_default() += 1;
            }
            let transitioned = if enabled {
                !previous
            } else {
                previous || was_pending_pause
            };
            let sessions: Vec<_> = inner
                .sessions
                .iter()
                .filter(|(_, l)| l.session.browser_id.0 == browser)
                .map(|(id, live)| (id.clone(), live.run_id.clone()))
                .collect();
            (transitioned, sessions)
        };
        let result = (|| -> Result<Value> {
            if enabled {
                self.ensure_loaded_unlocked()?;
                let root = self.directory()?;
                fs::create_dir_all(root)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
                }
                // Confirm readiness even before the first task is started.
                let mut probe = tempfile::NamedTempFile::new_in(root)?;
                probe.write_all(b"audit-ready\n")?;
                probe.as_file().sync_data()?;
            }
            for (sid, run) in sessions {
                if let Some(id) = run.filter(|_| transitioned) {
                    self.append_unlocked(
                        &id,
                        event(if enabled { "resumed" } else { "paused" }, None, json!({})),
                    )?;
                } else if enabled {
                    self.ensure_run_unlocked(&sid, true)?;
                }
            }
            if enabled && self.inner.lock().unwrap().loaded {
                self.prune_unlocked(now_ms())?;
            }
            let directory = if enabled {
                Some(self.directory()?.to_path_buf())
            } else {
                self.root.clone()
            };
            Ok(json!({"enabled": enabled, "directory": directory, "retention_days": 30}))
        })();
        if result.is_err() {
            self.inner
                .lock()
                .unwrap()
                .last_error
                .insert(browser.into(), "write_failed".into());
        }
        // A successful directory probe cannot prove a failed operation record
        // was saved. Keep the warning for this daemon's lifetime.
        result
    }

    pub fn begin(
        &self,
        session_id: &str,
        method: &Method,
        params: &Value,
    ) -> Result<Option<Ticket>> {
        if !self.needs_begin(session_id) {
            return Ok(None);
        }
        let _io = self.io_lock.lock().unwrap();
        let Some(id) = self.ensure_run_unlocked(session_id, true)? else {
            return Ok(None);
        };
        let ticket = {
            let inner = self.inner.lock().unwrap();
            let browser = inner.runs[&id].browser_id.clone();
            Ticket {
                run_id: id,
                operation_id: uuid::Uuid::new_v4().to_string(),
                epoch: *inner.epochs.get(&browser).unwrap_or(&0),
                browser_id: browser,
            }
        };
        let mut data = safe_params(params);
        data["method"] = serde_json::to_value(method)?;
        if self
            .append_unlocked(
                &ticket.run_id,
                event("operation_started", Some(&ticket.operation_id), data),
            )
            .is_err()
        {
            self.inner
                .lock()
                .unwrap()
                .last_error
                .insert(ticket.browser_id, "write_failed".into());
            bail!("Operation audit could not be saved; action was not dispatched");
        }
        self.inner
            .lock()
            .unwrap()
            .pending
            .insert(ticket.operation_id.clone(), ticket.clone());
        Ok(Some(ticket))
    }

    pub fn finish(&self, ticket: Ticket, body: &ResponseBody) {
        let _io = self.io_lock.lock().unwrap();
        let should_append = {
            let mut inner = self.inner.lock().unwrap();
            inner.pending.remove(&ticket.operation_id);
            // A disable/re-enable during the call leaves the result explicitly unknown.
            inner.enabled.contains(&ticket.browser_id)
                && inner.epochs.get(&ticket.browser_id).copied().unwrap_or(0) == ticket.epoch
        };
        if !should_append {
            return;
        }
        let data = safe_outcome(body);
        if self
            .append_unlocked(
                &ticket.run_id,
                event("operation_finished", Some(&ticket.operation_id), data),
            )
            .is_err()
        {
            self.inner
                .lock()
                .unwrap()
                .last_error
                .insert(ticket.browser_id, "write_failed".into());
        }
    }

    /// Capture the matching in-flight audit ticket without touching `io_lock`.
    /// Callers on the WS pump loop call this synchronously before reading the
    /// next frame so a subsequent `Frame::Response` cannot race `finish()`
    /// ahead of context capture.
    pub fn prepare_context(&self, browser: &str, data: &AuditContextEvent) -> Option<Ticket> {
        let inner = self.inner.lock().unwrap();
        let ticket = inner.pending.get(&data.operation_id)?;
        if ticket.browser_id != browser
            || !inner.enabled.contains(browser)
            || inner.epochs.get(browser).copied().unwrap_or(0) != ticket.epoch
        {
            return None;
        }
        Some(ticket.clone())
    }

    pub fn write_context_with_ticket(&self, ticket: Ticket, data: &AuditContextEvent) {
        let _io = self.io_lock.lock().unwrap();
        {
            let inner = self.inner.lock().unwrap();
            if !inner.enabled.contains(&ticket.browser_id)
                || inner.epochs.get(&ticket.browser_id).copied().unwrap_or(0) != ticket.epoch
                || !inner.runs.contains_key(&ticket.run_id)
            {
                return;
            }
        }
        let mut metadata = json!({});
        if let Some(url) = data.url.as_deref().and_then(safe_url) {
            metadata["page_url"] = json!(url);
        }
        if let Some(target) = data.target.as_deref() {
            metadata["target"] = json!(safe_text(target));
        }
        if let Some(tab) = data.tab_id {
            metadata["tab_id"] = json!(tab);
        }
        if self
            .append_unlocked(
                &ticket.run_id,
                event("context", Some(&ticket.operation_id), metadata),
            )
            .is_err()
        {
            self.inner
                .lock()
                .unwrap()
                .last_error
                .insert(ticket.browser_id, "write_failed".into());
        }
    }

    pub fn context(&self, browser: &str, data: &AuditContextEvent) {
        if let Some(ticket) = self.prepare_context(browser, data) {
            self.write_context_with_ticket(ticket, data);
        }
    }

    pub fn marker(&self, session_id: &str, kind: &str) {
        if !self.needs_marker(session_id) {
            return;
        }
        let _io = self.io_lock.lock().unwrap();
        let target = {
            let inner = self.inner.lock().unwrap();
            let Some(live) = inner.sessions.get(session_id).cloned() else {
                return;
            };
            inner
                .enabled
                .contains(&live.session.browser_id.0)
                .then_some(live.run_id.map(|id| (id, live.session.browser_id.0)))
                .flatten()
        };
        if let Some((id, browser_id)) = target
            && self
                .append_unlocked(&id, event(kind, None, json!({})))
                .is_err()
        {
            self.inner
                .lock()
                .unwrap()
                .last_error
                .insert(browser_id, "write_failed".into());
        }
    }

    pub fn list(&self, browser: &str, offset: usize, limit: usize) -> Result<Value> {
        let _io = self.io_lock.lock().unwrap();
        self.ensure_loaded_unlocked()?;
        self.prune_unlocked(now_ms())?;
        let directory = self.directory()?;
        let inner = self.inner.lock().unwrap();
        let mut runs: Vec<_> = inner
            .runs
            .values()
            .filter(|run| run.browser_id == browser)
            .cloned()
            .collect();
        runs.sort_by(|a, b| b.started_at.cmp(&a.started_at).then(b.id.cmp(&a.id)));
        let total = runs.len();
        let page: Vec<_> = runs
            .into_iter()
            .skip(offset)
            .take(limit.clamp(1, PAGE_SIZE))
            .collect();
        Ok(
            json!({"runs": page, "total": total, "enabled": inner.enabled.contains(browser),
            "error": inner.last_error.get(browser), "directory": directory, "retention_days": 30}),
        )
    }

    pub fn get(&self, browser: &str, id: &str, offset: usize, limit: usize) -> Result<Value> {
        let _io = self.io_lock.lock().unwrap();
        self.ensure_loaded_unlocked()?;
        let (run, pending_operations, error) = {
            let inner = self.inner.lock().unwrap();
            let run = inner
                .runs
                .get(id)
                .filter(|run| run.browser_id == browser)
                .cloned()
                .context("Audit task not found")?;
            let pending_operations: Vec<String> = inner
                .pending
                .values()
                .filter(|ticket| {
                    ticket.run_id == id
                        && inner.enabled.contains(browser)
                        && inner.epochs.get(browser).copied().unwrap_or(0) == ticket.epoch
                })
                .map(|ticket| ticket.operation_id.clone())
                .collect();
            let error = inner.last_error.get(browser).cloned();
            (run, pending_operations, error)
        };
        let events = read_events(&self.path(id)?)?;
        let total = events.len();
        let page: Vec<_> = events
            .into_iter()
            .skip(offset)
            .take(limit.clamp(1, 500))
            .collect();
        Ok(json!({"run": run, "events": page, "total": total,
                "pending_operations": pending_operations, "error": error}))
    }

    pub fn delete(&self, browser: &str, id: &str) -> Result<Value> {
        let _io = self.io_lock.lock().unwrap();
        self.ensure_loaded_unlocked()?;
        {
            let inner = self.inner.lock().unwrap();
            let run = inner
                .runs
                .get(id)
                .filter(|run| run.browser_id == browser)
                .context("Audit task not found")?;
            if run.status == "running" || inner.pending.values().any(|ticket| ticket.run_id == id) {
                bail!("Cannot delete an active audit task");
            }
        }
        match fs::remove_file(self.path(id)?) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        self.inner.lock().unwrap().runs.remove(id);
        Ok(json!({"deleted": true}))
    }

    fn prune_unlocked(&self, now: i64) -> Result<()> {
        let cutoff_ms = now.saturating_sub(RETENTION_MS);
        let expired: Vec<_> = {
            let inner = self.inner.lock().unwrap();
            inner
                .runs
                .values()
                .filter(|run| {
                    run.status != "running"
                        && run.updated_at < cutoff_ms
                        && !inner.pending.values().any(|ticket| ticket.run_id == run.id)
                })
                .map(|run| run.id.clone())
                .collect()
        };
        for id in expired {
            let remove_res = self
                .path(&id)
                .and_then(|path| match fs::remove_file(&path) {
                    Ok(()) => Ok(()),
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(err) => Err(err.into()),
                });
            match remove_res {
                Ok(()) => {
                    self.inner.lock().unwrap().runs.remove(&id);
                }
                Err(err) => {
                    tracing::warn!(audit_id = %id, %err, "failed to prune expired audit file");
                }
            }
        }
        // Also enforce the 30-day retention cap on unindexed/corrupt `*.jsonl`
        // files skipped during `ensure_loaded_unlocked()`, using filesystem mtime.
        if let Ok(root) = self.directory()
            && root.exists()
            && let Ok(entries) = fs::read_dir(root)
        {
            let protected: HashSet<String> = {
                let inner = self.inner.lock().unwrap();
                inner
                    .runs
                    .keys()
                    .cloned()
                    .chain(inner.sessions.values().filter_map(|s| s.run_id.clone()))
                    .chain(
                        inner
                            .closing_sessions
                            .values()
                            .filter_map(|s| s.run_id.clone()),
                    )
                    .chain(inner.pending.values().map(|ticket| ticket.run_id.clone()))
                    .collect()
            };
            for entry in entries.flatten() {
                if !entry.file_type().is_ok_and(|ft| ft.is_file()) {
                    continue;
                }
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                if protected.contains(stem) {
                    continue;
                }
                let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else {
                    continue;
                };
                let modified_ms = match modified.duration_since(UNIX_EPOCH) {
                    Ok(dur) => i64::try_from(dur.as_millis()).unwrap_or(i64::MAX),
                    Err(_) => 0,
                };
                if modified_ms < cutoff_ms {
                    match fs::remove_file(&path) {
                        Ok(()) => {}
                        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                        Err(err) => {
                            tracing::warn!(
                                path = %path.display(),
                                %err,
                                "failed to prune expired unindexed audit file"
                            );
                        }
                    }
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn prune(&self, inner: &mut Inner, now: i64) -> Result<()> {
        let expired: Vec<_> = inner
            .runs
            .values()
            .filter(|run| run.status != "running" && run.updated_at < now - RETENTION_MS)
            .map(|run| run.id.clone())
            .collect();
        for id in expired {
            if inner.pending.values().any(|ticket| ticket.run_id == id) {
                continue;
            }
            match fs::remove_file(self.path(&id)?) {
                Ok(()) => {
                    inner.runs.remove(&id);
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    inner.runs.remove(&id);
                }
                Err(err) => return Err(err.into()),
            }
        }
        Ok(())
    }
}

fn load_run_file(path: &Path) -> Result<Option<AuditRun>> {
    let events = read_events(path)?;
    let Some(first) = events.first() else {
        return Ok(None);
    };
    if first.kind != "started" {
        bail!("Invalid audit file header");
    }
    let mut run: AuditRun = serde_json::from_value(first.data.clone())?;
    if path.file_stem().and_then(|s| s.to_str()) != Some(&run.id) {
        bail!("Invalid audit file identity");
    }
    for event in events.iter().skip(1) {
        project(&mut run, event);
    }
    // A daemon restart cannot prove the old browser task completed.
    if run.status == "running" {
        run.status = "interrupted".into();
    }
    Ok(Some(run))
}

fn event(kind: &str, operation_id: Option<&str>, data: Value) -> AuditEvent {
    AuditEvent {
        at: now_ms(),
        kind: kind.into(),
        operation_id: operation_id.map(str::to_owned),
        data,
    }
}

fn project(run: &mut AuditRun, event: &AuditEvent) {
    run.updated_at = event.at;
    match event.kind.as_str() {
        "operation_started" => run.operations += 1,
        "operation_finished" if event.data["status"] == "error" => run.errors += 1,
        "paused" | "resumed" => run.partial = true,
        "ended" => {
            run.status = event.data["status"]
                .as_str()
                .unwrap_or("interrupted")
                .into()
        }
        "named" => run.name = event.data["name"].as_str().map(str::to_owned),
        _ => {}
    }
    if run.site.is_none()
        && let Some(url) = event.data["url"]
            .as_str()
            .or(event.data["page_url"].as_str())
    {
        run.site = reqwest::Url::parse(url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned));
    }
}

fn read_events(path: &Path) -> Result<Vec<AuditEvent>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > MAX_RUN_BYTES + 16_384 {
        bail!("Invalid audit file");
    }
    let bytes = fs::read(path)?;
    let mut events = Vec::new();
    // Ignore only an unterminated last record, including incomplete UTF-8.
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if line.last() != Some(&b'\n') {
            break;
        }
        events.push(serde_json::from_slice(line).context("Audit record is damaged")?);
    }
    Ok(events)
}

/// Input bodies, scripts, selector values, page text, URLs' query/path and error
/// messages can contain secrets. Persist metadata only; never dump raw RPC data.
fn safe_params(params: &Value) -> Value {
    let mut data = json!({});
    for key in [
        "tab_id",
        "x",
        "y",
        "width",
        "height",
        "timeout_ms",
        "duration_ms",
    ] {
        if let Some(value) = params.get(key).filter(|value| value.is_number()) {
            data[key] = value.clone();
        }
    }
    if let Some(value) = params.get("ref").and_then(Value::as_str) {
        let reference = value.trim_start_matches('@');
        if reference.starts_with('e')
            && reference.len() < 16
            && reference[1..].bytes().all(|c| c.is_ascii_digit())
        {
            data["target"] = json!(value);
        }
    }
    if params.get("selector").is_some() {
        data["selector_redacted"] = json!(true);
    }
    if let Some(url) = params.get("url").and_then(Value::as_str).and_then(safe_url) {
        data["url"] = json!(url);
    }
    for key in [
        "value",
        "text",
        "expression",
        "key",
        "values",
        "prompt",
        "message",
        "default_prompt",
    ] {
        if params.get(key).is_some() {
            data["input_redacted"] = json!(true);
        }
    }
    if let Some(files) = params.get("files").and_then(Value::as_array) {
        data["file_count"] = json!(files.len());
    }
    data
}

fn safe_outcome(body: &ResponseBody) -> Value {
    match body {
        ResponseBody::Err(error) => json!({"status": match error.code {
            ErrorCode::Timeout | ErrorCode::ProtocolError => "unknown",
            ErrorCode::Cancelled | ErrorCode::UserAborted => "cancelled",
            _ => "error",
        }, "error_code": error.code}),
        ResponseBody::Ok(value) => {
            let mut data = json!({"status": if value.get("ok") == Some(&Value::Bool(false)) { "error" } else { "completed" }});
            for key in ["tab_id", "ref_count", "truncated", "bytes", "file_count"] {
                if let Some(value) = value.get(key).filter(|v| v.is_number() || v.is_boolean()) {
                    data[key] = value.clone();
                }
            }
            if let Some(outcome) = value.get("outcome").and_then(Value::as_str)
                && ["done", "cancelled", "timeout", "disabled", "completed"].contains(&outcome)
            {
                data["outcome"] = json!(outcome);
            }
            if let Some(dialogs) = value.get("dialogs").and_then(Value::as_array) {
                data["dialogs_handled"] = json!(dialogs.len());
            }
            data
        }
    }
}

pub fn safe_url(value: &str) -> Option<String> {
    let url = reqwest::Url::parse(value).ok()?;
    if !["https", "http"].contains(&url.scheme()) {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

pub fn safe_text(value: &str) -> String {
    // Names only: remove controls and replace likely credential/PII tokens.
    value
        .split_whitespace()
        .take(24)
        .map(|word| {
            let lower = word.to_ascii_lowercase();
            if word.contains('@')
                || word.chars().count() > 64
                || word.chars().filter(|c| c.is_ascii_digit()).count() >= 6
                || ["token=", "password=", "secret=", "bearer", "sk-", "ghp_"]
                    .iter()
                    .any(|prefix| lower.contains(prefix))
            {
                "[redacted]".to_string()
            } else {
                word.chars().filter(|c| !c.is_control()).collect()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::{browsers::BrowserId, sessions::SessionId};
    use super::*;

    fn fixture() -> (tempfile::TempDir, AuditStore, Session) {
        let temp = tempfile::tempdir().unwrap();
        let store = AuditStore::new(Some(temp.path().join("中文 user").join("audit")));
        let session = Session {
            controller: None,
            id: SessionId("abcd".into()),
            browser_id: BrowserId("browser-a".into()),
            agent_window_id: Some(1),
            created_at_ms: now_ms(),

            interaction: None,
        };
        (temp, store, session)
    }
    fn run_id(store: &AuditStore) -> String {
        store.list("browser-a", 0, 5).unwrap()["runs"][0]["id"]
            .as_str()
            .unwrap()
            .into()
    }

    #[test]
    fn disabled_is_default_and_never_creates_a_file() {
        let (_temp, store, session) = fixture();
        store.configure("browser-a", false).unwrap();
        store.session_started(&session);
        assert!(
            store
                .begin("abcd", &Method::ToolClick, &json!({"ref":"@e1"}))
                .unwrap()
                .is_none()
        );
        store.session_ended("abcd", "ended");
        assert!(!store.directory().unwrap().exists());
    }

    #[test]
    fn completed_history_is_scoped_and_secret_bodies_never_reach_disk() {
        let (_temp, store, session) = fixture();
        store.configure("browser-a", true).unwrap();
        store.session_started(&session);
        let ticket = store.begin("abcd", &Method::ToolFill, &json!({"ref":"@e2", "value":"raw-password", "selector":"[value=raw-password]", "url":"https://user:raw-password@example.com/private-path?token=raw-password#raw-password"})).unwrap().unwrap();
        store.context(
            "browser-b",
            &AuditContextEvent {
                operation_id: ticket.operation_id.clone(),
                tab_id: None,
                url: None,
                target: Some("foreign-target".into()),
            },
        );
        store.context(
            "browser-a",
            &AuditContextEvent {
                operation_id: ticket.operation_id.clone(),
                tab_id: None,
                url: Some("https://example.com/private-path".into()),
                target: Some("Search".into()),
            },
        );
        store.finish(
            ticket,
            &ResponseBody::Ok(json!({"value":"raw-password", "text":"private-page", "ok":true})),
        );
        store.session_ended("abcd", "ended");
        let id = run_id(&store);
        let raw = fs::read_to_string(store.path(&id).unwrap()).unwrap();
        for secret in [
            "raw-password",
            "private-path",
            "private-page",
            "foreign-target",
        ] {
            assert!(!raw.contains(secret));
        }
        assert!(raw.contains("Search"));
        assert_eq!(store.list("browser-b", 0, 5).unwrap()["total"], 0);
        assert!(store.get("browser-b", &id, 0, 100).is_err());
        assert!(store.delete("browser-b", &id).is_err());
        assert_eq!(
            store.get("browser-a", &id, 0, 100).unwrap()["run"]["status"],
            "ended"
        );
        store.delete("browser-a", &id).unwrap();
        assert_eq!(store.list("browser-a", 0, 5).unwrap()["total"], 0);
    }

    #[test]
    fn mid_session_enable_pause_resume_keeps_one_task_with_visible_gaps() {
        let (_temp, store, session) = fixture();
        store.session_started(&session);
        store.configure("browser-a", true).unwrap();
        let before_pause = store
            .begin("abcd", &Method::ToolClick, &json!({}))
            .unwrap()
            .unwrap();
        store.configure("browser-a", false).unwrap();
        assert!(
            store
                .begin("abcd", &Method::ToolFill, &json!({"value":"hidden"}))
                .unwrap()
                .is_none()
        );
        store.configure("browser-a", true).unwrap();
        store.finish(before_pause, &ResponseBody::Ok(json!({})));
        let after_resume = store
            .begin("abcd", &Method::ToolClick, &json!({}))
            .unwrap()
            .unwrap();
        store.finish(after_resume, &ResponseBody::Ok(json!({})));
        let id = run_id(&store);
        let detail = store.get("browser-a", &id, 0, 100).unwrap();
        assert_eq!(detail["run"]["partial"], true);
        assert_eq!(detail["run"]["operations"], 2);
        let events = detail["events"].as_array().unwrap();
        assert!(events.iter().any(|event| event["kind"] == "paused"));
        assert!(events.iter().any(|event| event["kind"] == "resumed"));
        assert_eq!(
            events
                .iter()
                .filter(|event| event["kind"] == "operation_finished")
                .count(),
            1
        );
        assert!(store.delete("browser-a", &id).is_err());
        store.configure("browser-a", false).unwrap();
        store.session_ended("abcd", "ended");
        assert_eq!(
            store.get("browser-a", &id, 0, 100).unwrap()["run"]["status"],
            "ended"
        );
    }

    #[test]
    fn restart_preserves_history_and_tolerates_torn_utf8_tail() {
        let (_temp, store, session) = fixture();
        store.configure("browser-a", true).unwrap();
        store.session_started(&session);
        let _ticket = store.begin("abcd", &Method::ToolClick, &json!({})).unwrap();
        let id = run_id(&store);
        OpenOptions::new()
            .append(true)
            .open(store.path(&id).unwrap())
            .unwrap()
            .write_all(&[b'{', 0xe4, 0xb8])
            .unwrap();
        let restored = AuditStore::new(store.root.clone());
        let detail = restored.get("browser-a", &id, 0, 100).unwrap();
        assert_eq!(detail["run"]["status"], "interrupted");
        assert_eq!(detail["run"]["operations"], 1);
        assert_eq!(detail["events"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn short_session_id_reuse_produces_distinct_history_ids() {
        let (_temp, store, session) = fixture();
        store.configure("browser-a", true).unwrap();
        store.session_started(&session);
        let first = run_id(&store);
        store.session_ended("abcd", "ended");
        store.session_started(&session);
        assert_eq!(store.list("browser-a", 0, 5).unwrap()["total"], 2);
        assert!(store.get("browser-a", &first, 0, 100).is_ok());
        assert!(store.get("browser-a", "../outside", 0, 100).is_err());
    }

    #[test]
    fn retention_keeps_live_tasks_and_prunes_ended_tasks() {
        let (_temp, store, session) = fixture();
        store.configure("browser-a", true).unwrap();
        store.session_started(&session);
        let id = run_id(&store);
        let mut inner = store.inner.lock().unwrap();
        store
            .prune(&mut inner, now_ms() + RETENTION_MS + 1_000)
            .unwrap();
        assert!(inner.runs.contains_key(&id));
        drop(inner);
        store.session_ended("abcd", "ended");
        let mut inner = store.inner.lock().unwrap();
        store
            .prune(&mut inner, now_ms() + RETENTION_MS + 1_000)
            .unwrap();
        assert!(!inner.runs.contains_key(&id));
        assert!(!store.path(&id).unwrap().exists());
    }

    #[test]
    fn pagination_has_no_duplicates_and_outcomes_remain_honest() {
        let (_temp, store, session) = fixture();
        store.configure("browser-a", true).unwrap();
        store.session_started(&session);
        let ticket = store
            .begin(
                "abcd",
                &Method::ToolEvaluate,
                &json!({"expression":"secret-script"}),
            )
            .unwrap()
            .unwrap();
        store.finish(
            ticket,
            &ResponseBody::Ok(json!({"ok":false,"error":{"text":"secret-error"}})),
        );
        let ticket = store
            .begin("abcd", &Method::ToolClick, &json!({}))
            .unwrap()
            .unwrap();
        store.finish(
            ticket,
            &ResponseBody::Err(bsk_protocol::RpcError {
                code: ErrorCode::Timeout,
                message: "secret-error".into(),
                data: None,
            }),
        );
        let id = run_id(&store);
        let first = store.get("browser-a", &id, 0, 2).unwrap();
        let next = store.get("browser-a", &id, 2, 100).unwrap();
        assert_eq!(
            first["events"].as_array().unwrap().len() + next["events"].as_array().unwrap().len(),
            first["total"].as_u64().unwrap() as usize
        );
        assert_eq!(next["run"]["errors"], 1);
        assert_eq!(
            next["events"].as_array().unwrap().last().unwrap()["data"]["status"],
            "unknown"
        );
        assert!(
            !fs::read_to_string(store.path(&id).unwrap())
                .unwrap()
                .contains("secret-")
        );
    }

    #[test]
    fn write_failure_is_visible_and_prevents_unrecorded_dispatch() {
        let (temp, _store, session) = fixture();
        let root = temp.path().join("unwritable");
        let store = AuditStore::new(Some(root.clone()));
        store.configure("browser-a", true).unwrap();
        fs::remove_dir(&root).unwrap();
        fs::write(&root, "blocking file").unwrap();
        store.session_started(&session);
        assert!(store.begin("abcd", &Method::ToolClick, &json!({})).is_err());
        assert_eq!(
            store.list("browser-a", 0, 5).unwrap()["error"],
            "write_failed"
        );
        store.configure("browser-a", false).unwrap();
        assert!(
            store
                .begin("abcd", &Method::ToolClick, &json!({}))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn incomplete_write_cannot_corrupt_later_records_or_block_opt_out() {
        let (_temp, store, session) = fixture();
        store.configure("browser-a", true).unwrap();
        store.session_started(&session);
        let id = run_id(&store);
        let path = store.path(&id).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{broken")
            .unwrap();
        let before = fs::read(&path).unwrap();
        assert!(store.begin("abcd", &Method::ToolClick, &json!({})).is_err());
        assert!(store.configure("browser-a", false).is_err());
        assert!(
            store
                .begin("abcd", &Method::ToolClick, &json!({}))
                .unwrap()
                .is_none()
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(store.get("browser-a", &id, 0, 100).unwrap()["total"], 1);
    }

    #[test]
    fn prune_removes_expired_corrupt_jsonl_while_keeping_fresh_and_healthy_files() {
        let (_temp, writer, session) = fixture();
        writer.configure("browser-a", true).unwrap();
        writer.session_started(&session);
        writer.session_ended("abcd", "completed");
        let healthy_id = run_id(&writer);
        let root = writer.directory().unwrap().to_path_buf();

        let expired_corrupt = root.join("corrupt-expired.jsonl");
        {
            let mut file = fs::File::create(&expired_corrupt).unwrap();
            file.write_all(b"{truncated corrupt json\n").unwrap();
            let old = SystemTime::now() - std::time::Duration::from_secs(31 * 24 * 60 * 60);
            file.set_modified(old).unwrap();
        }
        let fresh_corrupt = root.join("corrupt-fresh.jsonl");
        fs::write(&fresh_corrupt, b"{recent corrupt json\n").unwrap();
        let unrelated_old = root.join("notes.txt");
        {
            let mut file = fs::File::create(&unrelated_old).unwrap();
            file.write_all(b"keep me").unwrap();
            let old = SystemTime::now() - std::time::Duration::from_secs(31 * 24 * 60 * 60);
            file.set_modified(old).unwrap();
        }

        // Fresh store loads directory and runs `prune_unlocked(now_ms())`.
        let reader = AuditStore::new(Some(root.to_path_buf()));
        let listed = reader.list("browser-a", 0, 50).unwrap();
        assert_eq!(listed["runs"].as_array().unwrap().len(), 1);
        assert_eq!(listed["runs"][0]["id"], healthy_id);

        assert!(
            !expired_corrupt.exists(),
            "corrupt .jsonl older than 30 days must be pruned"
        );
        assert!(
            fresh_corrupt.exists(),
            "recent corrupt .jsonl within 30 days should not be pruned prematurely"
        );
        assert!(
            unrelated_old.exists(),
            "non-.jsonl files must not be touched by audit retention pruning"
        );
    }
}
