//! Daemon-local `<3ms` Intent Write-Ahead Ledger (`RM-03`).
//!
//! Protects all mutating browser actions (`tool.click`, `tool.fill`,
//! `tool.press`, `tool.select`, `tool.upload`, `tool.drag`, and
//! `tool.evaluate`) regardless of whether the target was specified via
//! `--ref e5`, a raw CSS `--selector "#pay-btn"`, or visual coordinates
//! `(image_x, image_y)`.
//!
//! State machine per `(SessionId, Option<i64> /* tab_id */)`:
//! - `DISPATCHED`: appended before forwarding the mutating RPC to the browser.
//! - `SETTLED`: deterministic `Ok` reply, or deterministic `Err` whose side
//!   effect is proven absent (`effect_state == "none"`, `dispatched == false`,
//!   pre-flight queue rejection, or `tool.click` with `press_sent == false`).
//! - `UNKNOWN`: `Timeout`, `Cancelled` (after forwarding), WebSocket / browser
//!   disconnect mid-call, `effect_state == "unknown"`, task drop/panic before
//!   completion, or leftover `DISPATCHED` entries recovered on daemon startup.
//! - `RECONCILED`: cleared automatically when `bsk sync` (`tool.cooperate`
//!   `action == "sync"`) succeeds on that tab, or explicitly via
//!   `bsk ledger resolve`.
//!
//! Security invariant: `target_summary` stores ONLY redacted target locators
//! (`ref:e3`, `selector:#pay-btn`, `visual:(x,y)`, `script(len=N)`, file count)
//! and NEVER stores `fill` text values, `press` keys, `select` option values,
//! `upload` paths/filenames, or `evaluate` JS source/arguments.

use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use bsk_protocol::{ErrorCode, Method, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing::warn;

use super::queue::DispatchError;
use super::sessions::SessionId;

/// Bound on `$BSK_HOME/intent_ledger.jsonl` before atomic compaction.
const MAX_LEDGER_BYTES: u64 = 512 * 1024;
/// Maximum number of recent ledger entries retained in memory and across compaction.
const RECENT_ENTRY_CAP: usize = 64;
/// Maximum characters retained in a selector or locator summary.
const MAX_LOCATOR_CHARS: usize = 120;

pub const RECOVERY_GUIDANCE: &str = "Run `bsk sync` on this tab to observe current state and auto-reconcile, or inspect with `bsk read` / `bsk network` and run `bsk ledger resolve`. Do not blindly replay the prior action.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum IntentState {
    Dispatched,
    Settled,
    Unknown,
    Reconciled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub operation_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<i64>,
    pub method: String,
    pub target_summary: String,
    pub state: IntentState,
    pub dispatched_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconciled_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerStatusReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub frozen: bool,
    pub pending_unknown: Vec<LedgerEntry>,
    pub recent: Vec<LedgerEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerResolveReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub resolved_count: usize,
    pub resolved: Vec<LedgerEntry>,
}

#[derive(Debug, Default)]
struct WalInner {
    ledger_path: Option<PathBuf>,
    writer: Option<File>,
    bytes_written: u64,
    /// In-flight `DISPATCHED` entries keyed by `operation_id`.
    dispatched: HashMap<String, LedgerEntry>,
    /// Unreconciled `UNKNOWN` entries indexed by `(SessionId, Option<i64>)`.
    unknown: HashMap<(SessionId, Option<i64>), Vec<LedgerEntry>>,
    /// Bounded ring of the most recent ledger snapshots (one per `operation_id`).
    recent: VecDeque<LedgerEntry>,
}

#[derive(Debug, Clone, Default)]
pub struct IntentWal {
    inner: Arc<Mutex<WalInner>>,
}

/// RAII guard for an in-flight mutating tool dispatch.
/// If dropped without calling [`IntentWal::finish_dispatch`] (for instance on
/// task cancellation or unwind), the entry automatically transitions to
/// [`IntentState::Unknown`] so blind replays remain blocked.
#[derive(Debug)]
pub struct IntentTicket {
    wal: IntentWal,
    operation_id: String,
    finished: bool,
}

impl Drop for IntentTicket {
    fn drop(&mut self) {
        if !self.finished {
            self.wal.mark_abandoned(&self.operation_id);
        }
    }
}

impl IntentWal {
    /// Initialise the WAL backed by `ledger_path` (or purely in-memory when `None`).
    /// Leftover `DISPATCHED` records from a prior daemon run are automatically
    /// promoted to `UNKNOWN`.
    pub fn new(ledger_path: Option<PathBuf>) -> Self {
        let mut inner = WalInner {
            ledger_path,
            ..WalInner::default()
        };
        inner.load_from_disk();
        Self {
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    /// Pure in-memory WAL constructor for unit/embedded setups without disk backing.
    pub fn memory() -> Self {
        Self::new(None)
    }

    /// True for every tool RPC call whose params require Intent WAL protection.
    pub fn is_wal_tracked(method: &Method, params: &Value) -> bool {
        method.wal_tracked_with_params(params)
    }

    /// Extract a strictly redacted target locator summary from `params`.
    /// Never includes `fill` text values, `press` keys, `select` option values,
    /// `upload` local paths/filenames, `navigate` query strings/fragments/userinfo,
    /// `dialog.accept` prompt text, `debug` headers/bodies, or `evaluate` JS source.
    pub fn extract_target_summary(method: &Method, params: &Value) -> String {
        match method {
            Method::ToolDrag => {
                let src = params
                    .get("source")
                    .and_then(summarize_locator)
                    .unwrap_or_else(|| "source".to_string());
                let dst = params
                    .get("target")
                    .and_then(summarize_locator)
                    .or_else(|| {
                        let delta = params.get("delta")?;
                        let dx = format_coord(delta.get("x")?)?;
                        let dy = format_coord(delta.get("y")?)?;
                        Some(format!("delta:({dx},{dy})"))
                    })
                    .unwrap_or_else(|| "target".to_string());
                format!("{src} -> {dst}")
            }
            Method::ToolUpload => {
                let loc = summarize_locator(params).unwrap_or_else(|| "page".to_string());
                let count = params
                    .get("files")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                format!("{loc} (files={count})")
            }
            Method::ToolDownload => {
                let loc = summarize_locator(params).unwrap_or_else(|| "page".to_string());
                format!("download:{loc}")
            }
            Method::ToolNavigate => {
                let target = params
                    .get("url")
                    .and_then(Value::as_str)
                    .map(|raw| {
                        reqwest::Url::parse(raw).map_or_else(
                            |_| {
                                let stripped = raw.split(['?', '#']).next().unwrap_or(raw);
                                sanitize_summary_token(stripped)
                            },
                            |parsed| {
                                let origin = parsed.origin().ascii_serialization();
                                let path = sanitize_summary_token(parsed.path());
                                if origin == "null" {
                                    format!("{}:{path}", parsed.scheme())
                                } else {
                                    format!("{origin}{path}")
                                }
                            },
                        )
                    })
                    .unwrap_or_else(|| "url:unspecified".to_string());
                format!("navigate:{target}")
            }
            Method::ToolNavigateBack => "navigate:back".to_string(),
            Method::ToolNavigateForward => "navigate:forward".to_string(),
            Method::ToolReload => "reload".to_string(),
            Method::ToolDialogAccept => {
                let id = params
                    .get("dialog_id")
                    .and_then(Value::as_str)
                    .map(sanitize_summary_token)
                    .unwrap_or_else(|| "active".to_string());
                format!("dialog:{id}")
            }
            Method::ToolDebug => {
                let action = params
                    .get("action")
                    .and_then(Value::as_str)
                    .map(sanitize_summary_token)
                    .unwrap_or_else(|| "unknown".to_string());
                if action == "replay"
                    && let Some(req_id) = params.get("request_id").and_then(Value::as_str)
                {
                    format!("debug:replay:{}", sanitize_summary_token(req_id))
                } else {
                    format!("debug:{action}")
                }
            }
            Method::ToolEvaluate => {
                let len = params
                    .get("expression")
                    .and_then(Value::as_str)
                    .map_or(0, |s| s.chars().count());
                format!("script(len={len})")
            }
            Method::ToolPress => summarize_locator(params).unwrap_or_else(|| "focused".to_string()),
            _ => summarize_locator(params).unwrap_or_else(|| "target:unspecified".to_string()),
        }
    }

    /// `<1ms` pre-dispatch gate: rejects mutating calls when `(session_id, effective_tab_id)`
    /// (or a tab-ambiguous slot on `session_id`) has an unreconciled `UNKNOWN` entry.
    pub fn check_gate(
        &self,
        session_id: &SessionId,
        effective_tab_id: Option<i64>,
    ) -> Result<(), RpcError> {
        let guard = self.inner.lock().expect("intent_wal poisoned");
        let Some(prior) = guard.find_blocking_unknown(session_id, effective_tab_id) else {
            return Ok(());
        };
        Err(RpcError {
            code: ErrorCode::PermissionDenied,
            message: format!(
                "mutating action blocked: prior {} on {} (operation {}) ended with an uncertain side effect at {}. {}",
                prior.method,
                prior.target_summary,
                prior.operation_id,
                prior.dispatched_at,
                RECOVERY_GUIDANCE
            ),
            data: Some(json!({
                "reason": bsk_protocol::RpcErrorReason::UncertainPriorEffect.as_str(),
                "effect_state": "none",
                "dispatched": false,
                "session_id": prior.session_id,
                "tab_id": prior.tab_id,
                "operation_id": prior.operation_id,
                "method": prior.method,
                "target_summary": prior.target_summary,
                "dispatched_at": prior.dispatched_at,
                "recovery": RECOVERY_GUIDANCE,
            })),
        })
    }

    /// Record `DISPATCHED` immediately before forwarding a mutating RPC to the extension.
    pub fn begin_dispatch(
        &self,
        session_id: &SessionId,
        effective_tab_id: Option<i64>,
        operation_id: Option<&str>,
        method: &Method,
        params: &Value,
    ) -> IntentTicket {
        let op_id = operation_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("op-{}", uuid::Uuid::new_v4()));
        let now = now_rfc3339();
        let entry = LedgerEntry {
            operation_id: op_id.clone(),
            session_id: session_id.0.clone(),
            tab_id: effective_tab_id,
            method: method.wire_name().to_owned(),
            target_summary: Self::extract_target_summary(method, params),
            state: IntentState::Dispatched,
            dispatched_at: now.clone(),
            updated_at: now,
            reconciled_by: None,
        };
        {
            let mut guard = self.inner.lock().expect("intent_wal poisoned");
            guard.upsert_recent(entry.clone());
            guard.append_entry(&entry);
            guard.dispatched.insert(op_id.clone(), entry);
        }
        IntentTicket {
            wal: self.clone(),
            operation_id: op_id,
            finished: false,
        }
    }

    /// Finalise an `IntentTicket` into either `SETTLED` or `UNKNOWN` based on
    /// the queue/extension dispatch outcome.
    pub fn finish_dispatch(
        &self,
        mut ticket: IntentTicket,
        method: &Method,
        outcome: &Result<Value, DispatchError>,
    ) -> IntentState {
        ticket.finished = true;
        let next_state = classify_dispatch_outcome(method, outcome);
        let resolved_tab_id = match outcome {
            Ok(val) => val.get("tab_id").and_then(Value::as_i64),
            Err(DispatchError::Rpc(err)) => err
                .data
                .as_ref()
                .and_then(|d| d.get("tab_id"))
                .and_then(Value::as_i64),
            Err(_) => None,
        };

        let mut guard = self.inner.lock().expect("intent_wal poisoned");
        let Some(mut entry) = guard.dispatched.remove(&ticket.operation_id) else {
            return next_state;
        };
        if entry.tab_id.is_none() && resolved_tab_id.is_some() {
            entry.tab_id = resolved_tab_id;
        }
        entry.state = next_state;
        entry.updated_at = now_rfc3339();
        guard.upsert_recent(entry.clone());
        guard.append_entry(&entry);
        if next_state == IntentState::Unknown {
            let key = (SessionId(entry.session_id.clone()), entry.tab_id);
            guard.unknown.entry(key).or_default().push(entry);
        }
        next_state
    }

    fn mark_abandoned(&self, operation_id: &str) {
        let mut guard = self.inner.lock().expect("intent_wal poisoned");
        let Some(mut entry) = guard.dispatched.remove(operation_id) else {
            return;
        };
        entry.state = IntentState::Unknown;
        entry.updated_at = now_rfc3339();
        guard.upsert_recent(entry.clone());
        guard.append_entry(&entry);
        let key = (SessionId(entry.session_id.clone()), entry.tab_id);
        guard.unknown.entry(key).or_default().push(entry);
    }

    /// Zero-ceremony auto-reconciliation triggered when `bsk sync` succeeds on `tab_id`.
    /// Transitions matching `UNKNOWN` entries on `(session_id, tab_id)` (plus any
    /// tab-ambiguous `(session_id, None)` entries) to `RECONCILED`.
    pub fn reconcile_tab(
        &self,
        session_id: &SessionId,
        synced_tab_id: Option<i64>,
        reconciled_by: &str,
    ) -> usize {
        let mut guard = self.inner.lock().expect("intent_wal poisoned");
        let matching_keys: Vec<(SessionId, Option<i64>)> = guard
            .unknown
            .keys()
            .filter(|(sid, tid)| {
                sid == session_id
                    && (*tid == synced_tab_id || tid.is_none() || synced_tab_id.is_none())
            })
            .cloned()
            .collect();
        if matching_keys.is_empty() {
            return 0;
        }
        let now = now_rfc3339();
        let mut count = 0;
        for key in matching_keys {
            if let Some(entries) = guard.unknown.remove(&key) {
                for mut entry in entries {
                    entry.state = IntentState::Reconciled;
                    entry.updated_at = now.clone();
                    entry.reconciled_by = Some(reconciled_by.to_owned());
                    guard.upsert_recent(entry.clone());
                    guard.append_entry(&entry);
                    count += 1;
                }
            }
        }
        count
    }

    /// Explicit manual resolution (`bsk ledger resolve`).
    pub fn resolve(
        &self,
        session_id: &SessionId,
        tab_id: Option<i64>,
        operation_id: Option<&str>,
    ) -> LedgerResolveReply {
        let mut guard = self.inner.lock().expect("intent_wal poisoned");
        let op_filter = operation_id.map(str::trim).filter(|s| !s.is_empty());
        let now = now_rfc3339();
        let mut resolved = Vec::new();

        let candidate_keys: Vec<(SessionId, Option<i64>)> = guard
            .unknown
            .keys()
            .filter(|(sid, tid)| {
                sid == session_id && tab_id.is_none_or(|target_tid| *tid == Some(target_tid))
            })
            .cloned()
            .collect();

        for key in candidate_keys {
            let Some(mut bucket) = guard.unknown.remove(&key) else {
                continue;
            };
            let mut remaining = Vec::new();
            for mut entry in bucket.drain(..) {
                if op_filter.is_none_or(|wanted| entry.operation_id == wanted) {
                    entry.state = IntentState::Reconciled;
                    entry.updated_at = now.clone();
                    entry.reconciled_by = Some("ledger_resolve".to_owned());
                    guard.upsert_recent(entry.clone());
                    guard.append_entry(&entry);
                    resolved.push(entry);
                } else {
                    remaining.push(entry);
                }
            }
            if !remaining.is_empty() {
                guard.unknown.insert(key, remaining);
            }
        }

        LedgerResolveReply {
            session_id: Some(session_id.0.clone()),
            resolved_count: resolved.len(),
            resolved,
        }
    }

    /// Find the owning `SessionId` for a pending `UNKNOWN` `operation_id` when
    /// unambiguous (used when `bsk ledger resolve --operation-id <id>` is run
    /// without an active bound scope, e.g. after daemon restart).
    pub fn find_unknown_session_by_operation(&self, operation_id: &str) -> Option<SessionId> {
        let wanted = operation_id.trim();
        if wanted.is_empty() {
            return None;
        }
        let guard = self.inner.lock().expect("intent_wal poisoned");
        let mut found: Option<SessionId> = None;
        for ((sid, _), entries) in &guard.unknown {
            if entries.iter().any(|e| e.operation_id == wanted) {
                if found.as_ref().is_some_and(|prev| prev != sid) {
                    return None;
                }
                found = Some(sid.clone());
            }
        }
        found
    }

    /// Inspect pending `UNKNOWN` intents and recent ledger entries (`bsk ledger status`).
    pub fn status(&self, session_id: Option<&SessionId>) -> LedgerStatusReply {
        let guard = self.inner.lock().expect("intent_wal poisoned");
        let mut pending_unknown: Vec<LedgerEntry> = guard
            .unknown
            .iter()
            .filter(|((sid, _), _)| session_id.is_none_or(|wanted| sid == wanted))
            .flat_map(|(_, entries)| entries.iter().cloned())
            .collect();
        pending_unknown.sort_by(|a, b| {
            a.dispatched_at
                .cmp(&b.dispatched_at)
                .then_with(|| a.operation_id.cmp(&b.operation_id))
        });

        let recent: Vec<LedgerEntry> = guard
            .recent
            .iter()
            .filter(|entry| session_id.is_none_or(|wanted| entry.session_id == wanted.0))
            .cloned()
            .collect();

        LedgerStatusReply {
            session_id: session_id.map(|s| s.0.clone()),
            frozen: !pending_unknown.is_empty(),
            pending_unknown,
            recent,
        }
    }

    /// Clear in-memory `UNKNOWN` freeze entries when a session ends so closed
    /// sessions do not accumulate unbounded state in memory.
    pub fn on_session_ended(&self, session_id: &SessionId) {
        let mut guard = self.inner.lock().expect("intent_wal poisoned");
        guard.unknown.retain(|(sid, _), _| sid != session_id);
        guard
            .dispatched
            .retain(|_, entry| entry.session_id != session_id.0);
    }
}

impl WalInner {
    fn find_blocking_unknown(
        &self,
        session_id: &SessionId,
        effective_tab_id: Option<i64>,
    ) -> Option<&LedgerEntry> {
        if let Some(entries) = self
            .unknown
            .get(&(session_id.clone(), effective_tab_id))
            .filter(|v| !v.is_empty())
        {
            return entries.last();
        }
        if effective_tab_id.is_some()
            && let Some(entries) = self
                .unknown
                .get(&(session_id.clone(), None))
                .filter(|v| !v.is_empty())
        {
            return entries.last();
        }
        if effective_tab_id.is_none() {
            return self
                .unknown
                .iter()
                .filter(|((sid, _), entries)| sid == session_id && !entries.is_empty())
                .filter_map(|(_, entries)| entries.last())
                .max_by(|a, b| a.updated_at.cmp(&b.updated_at));
        }
        None
    }

    fn upsert_recent(&mut self, entry: LedgerEntry) {
        if let Some(pos) = self
            .recent
            .iter()
            .position(|existing| existing.operation_id == entry.operation_id)
        {
            self.recent.remove(pos);
        }
        self.recent.push_back(entry);
        while self.recent.len() > RECENT_ENTRY_CAP {
            self.recent.pop_front();
        }
    }

    fn load_from_disk(&mut self) {
        let Some(path) = self.ledger_path.clone() else {
            return;
        };
        if !path.exists() {
            return;
        }
        let file = match File::open(&path) {
            Ok(f) => f,
            Err(err) => {
                warn!(path = %path.display(), error = %err, "failed to open intent_ledger.jsonl");
                return;
            }
        };
        self.bytes_written = file.metadata().map(|m| m.len()).unwrap_or(0);

        let reader = BufReader::new(file);
        let mut ordered_ids: Vec<String> = Vec::new();
        let mut latest_by_op: HashMap<String, LedgerEntry> = HashMap::new();

        for line in reader.lines() {
            let Ok(raw) = line else {
                break;
            };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<LedgerEntry>(trimmed) else {
                continue;
            };
            if let Some(pos) = ordered_ids.iter().position(|id| id == &entry.operation_id) {
                ordered_ids.remove(pos);
            }
            ordered_ids.push(entry.operation_id.clone());
            latest_by_op.insert(entry.operation_id.clone(), entry);
        }

        let now = now_rfc3339();
        let mut promoted: Vec<LedgerEntry> = Vec::new();
        for op_id in ordered_ids {
            let Some(mut entry) = latest_by_op.remove(&op_id) else {
                continue;
            };
            if entry.state == IntentState::Dispatched {
                entry.state = IntentState::Unknown;
                entry.updated_at = now.clone();
                promoted.push(entry.clone());
            }
            if entry.state == IntentState::Unknown {
                let key = (SessionId(entry.session_id.clone()), entry.tab_id);
                self.unknown.entry(key).or_default().push(entry.clone());
            }
            self.upsert_recent(entry);
        }

        for entry in promoted {
            self.append_entry(&entry);
        }
    }

    fn ensure_writer(&mut self) -> Option<&mut File> {
        let path = self.ledger_path.as_ref()?;
        if self.writer.is_none() {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
                }
            }
            let file = match open_private_append(path) {
                Ok(f) => f,
                Err(err) => {
                    warn!(path = %path.display(), error = %err, "failed to open intent_ledger.jsonl for append");
                    return None;
                }
            };
            self.bytes_written = file.metadata().map(|m| m.len()).unwrap_or(0);
            self.writer = Some(file);
        }
        self.writer.as_mut()
    }

    fn append_entry(&mut self, entry: &LedgerEntry) {
        if self.ledger_path.is_none() {
            return;
        }
        let Ok(mut line) = serde_json::to_vec(entry) else {
            return;
        };
        line.push(b'\n');
        if self.bytes_written.saturating_add(line.len() as u64) > MAX_LEDGER_BYTES {
            self.compact_on_disk();
        }
        let line_len = line.len() as u64;
        if let Some(writer) = self.ensure_writer() {
            if let Err(err) = writer.write_all(&line) {
                warn!(error = %err, "failed to append to intent_ledger.jsonl");
                self.writer = None;
            } else {
                self.bytes_written = self.bytes_written.saturating_add(line_len);
            }
        }
    }

    fn compact_on_disk(&mut self) {
        let Some(path) = self.ledger_path.clone() else {
            return;
        };
        self.writer = None;
        let tmp_path = path.with_extension("jsonl.tmp");

        // Retain all active DISPATCHED / UNKNOWN entries plus recent history without duplicates.
        let mut retained: Vec<LedgerEntry> = Vec::new();
        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut push_unique = |entry: &LedgerEntry| {
            if let Some(&idx) = seen.get(&entry.operation_id) {
                retained[idx] = entry.clone();
            } else {
                seen.insert(entry.operation_id.clone(), retained.len());
                retained.push(entry.clone());
            }
        };

        for entry in &self.recent {
            push_unique(entry);
        }
        for entries in self.unknown.values() {
            for entry in entries {
                push_unique(entry);
            }
        }
        for entry in self.dispatched.values() {
            push_unique(entry);
        }

        let mut buf = Vec::with_capacity(retained.len() * 220);
        for entry in &retained {
            if let Ok(json_bytes) = serde_json::to_vec(entry) {
                buf.extend_from_slice(&json_bytes);
                buf.push(b'\n');
            }
        }

        if write_private_atomic(&tmp_path, &path, &buf).is_ok() {
            self.bytes_written = buf.len() as u64;
        }
    }
}

fn open_private_append(path: &Path) -> std::io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let file = opts.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
    Ok(file)
}

fn write_private_atomic(tmp_path: &Path, dst_path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut opts = OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    {
        let mut file = opts.open(tmp_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
        }
        file.write_all(bytes)?;
    }
    fs::rename(tmp_path, dst_path)
}

fn classify_dispatch_outcome(
    method: &Method,
    outcome: &Result<Value, DispatchError>,
) -> IntentState {
    match outcome {
        Ok(_) => IntentState::Settled,
        Err(
            DispatchError::SessionNotFound { .. }
            | DispatchError::SessionStopping
            | DispatchError::SessionBusy
            | DispatchError::QueueFull,
        ) => IntentState::Settled,
        Err(DispatchError::QueueClosed | DispatchError::Timeout) => IntentState::Unknown,
        Err(DispatchError::Rpc(err)) => classify_rpc_error(method, err),
    }
}

fn classify_rpc_error(method: &Method, err: &RpcError) -> IntentState {
    if let Some(data) = err.data.as_ref() {
        // Proof that the action never reached the page wins over a generic
        // `effect_state`: the extension reports a click refused after scrolling as
        // `effect_state: "unknown"` *and* `press_sent: false`.
        if data.get("dispatched").and_then(Value::as_bool) == Some(false) {
            return IntentState::Settled;
        }
        if *method == Method::ToolClick
            && data.get("press_sent").and_then(Value::as_bool) == Some(false)
        {
            return IntentState::Settled;
        }
        let effect_state = data.get("effect_state").and_then(Value::as_str);
        if effect_state == Some("unknown") {
            return IntentState::Unknown;
        }
        if effect_state == Some("none") {
            return IntentState::Settled;
        }
        if let Some(reason) = data.get("reason").and_then(Value::as_str) {
            if matches!(
                reason,
                "input_outcome_unknown"
                    | "transfer_outcome_unknown"
                    | "transfer_timeout"
                    | "cancel_cleanup_timeout"
            ) {
                return IntentState::Unknown;
            }
            if reason == "extension_unresponsive" {
                // `forward_one` checks `client.is_unresponsive()` strictly before
                // dispatching any frame to the browser socket.
                return IntentState::Settled;
            }
        }
    }

    // Pre-flight cancellations and pre-send sink closures in `queue.rs` never put
    // a request frame onto the browser WebSocket.
    if err.message.contains("cancelled before forwarding")
        || err
            .message
            .contains("browser sink closed before request was queued")
    {
        return IntentState::Settled;
    }

    if matches!(
        err.code,
        ErrorCode::Timeout
            | ErrorCode::Cancelled
            | ErrorCode::NoBrowserConnected
            | ErrorCode::ProtocolError
    ) {
        return IntentState::Unknown;
    }

    IntentState::Settled
}

fn summarize_locator(obj: &Value) -> Option<String> {
    if let Some(r) = obj
        .get("ref")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(format!("ref:{}", sanitize_summary_token(r)));
    }
    if let Some(sel) = obj
        .get("selector")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(format!("selector:{}", sanitize_summary_token(sel)));
    }
    if let (Some(ix), Some(iy)) = (
        obj.get("image_x").and_then(format_coord),
        obj.get("image_y").and_then(format_coord),
    ) {
        return Some(format!("visual:({ix},{iy})"));
    }
    if let (Some(x), Some(y)) = (
        obj.get("x").and_then(format_coord),
        obj.get("y").and_then(format_coord),
    ) {
        return Some(format!("coords:({x},{y})"));
    }
    None
}

fn sanitize_summary_token(input: &str) -> String {
    let mut out = String::new();
    for ch in input.chars().take(MAX_LOCATOR_CHARS) {
        if ch.is_control() {
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    if input.chars().count() > MAX_LOCATOR_CHARS {
        out.push_str("...");
    }
    out
}

fn format_coord(value: &Value) -> Option<String> {
    if let Some(i) = value.as_i64() {
        return Some(i.to_string());
    }
    let f = value.as_f64()?;
    if !f.is_finite() {
        return None;
    }
    if (f.fract()).abs() < f64::EPSILON {
        Some(format!("{}", f as i64))
    } else {
        Some(format!("{f:.1}"))
    }
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tempfile::TempDir;

    fn sid(name: &str) -> SessionId {
        SessionId(name.to_string())
    }

    #[test]
    fn mutating_classification_covers_all_mutators_and_allows_readonly_tools() {
        for (m, params) in [
            (Method::ToolClick, json!({})),
            (Method::ToolFill, json!({})),
            (Method::ToolPress, json!({})),
            (Method::ToolSelect, json!({})),
            (Method::ToolUpload, json!({})),
            (Method::ToolDownload, json!({})),
            (Method::ToolDrag, json!({})),
            (Method::ToolEvaluate, json!({})),
            (Method::ToolNavigate, json!({})),
            (Method::ToolNavigateBack, json!({})),
            (Method::ToolNavigateForward, json!({})),
            (Method::ToolReload, json!({})),
            (Method::ToolDialogAccept, json!({})),
            (Method::ToolDebug, json!({ "action": "replay" })),
        ] {
            assert!(
                IntentWal::is_wal_tracked(&m, &params),
                "{m:?} must be guarded by IntentWal"
            );
        }

        for (readonly, params) in [
            (Method::ToolCooperate, json!({})),
            (Method::ToolObserve, json!({})),
            (Method::ToolSnapshot, json!({})),
            (Method::ToolRead, json!({})),
            (Method::ToolExtract, json!({})),
            (Method::ToolGetHtml, json!({})),
            (Method::ToolScreenshot, json!({})),
            (Method::ToolScreenshotFullPage, json!({})),
            (Method::ToolConsole, json!({})),
            (Method::ToolNetwork, json!({})),
            (Method::ToolDebug, json!({ "action": "request" })),
            (Method::ToolDialogDismiss, json!({})),
            (Method::ToolTabList, json!({})),
            (Method::ToolTabCreate, json!({})),
            (Method::SessionStop, json!({})),
            (Method::LedgerRequest, json!({})),
        ] {
            assert!(
                !IntentWal::is_wal_tracked(&readonly, &params),
                "{readonly:?} must NEVER be blocked by IntentWal"
            );
        }
    }

    #[test]
    fn ref_and_bare_css_selector_pay_btn_both_block_blind_replay_after_timeout_cancel_or_unknown() {
        let tmp = TempDir::new().unwrap();
        let wal = IntentWal::new(Some(tmp.path().join("intent_ledger.jsonl")));
        let session = sid("sess-pay");

        // 1. `--ref e5` Timeout -> blocks subsequent mutating call on tab 7.
        let ticket = wal.begin_dispatch(
            &session,
            Some(7),
            Some("op-ref-timeout"),
            &Method::ToolClick,
            &json!({ "session_id": "sess-pay", "tab_id": 7, "ref": "e5" }),
        );
        let state = wal.finish_dispatch(ticket, &Method::ToolClick, &Err(DispatchError::Timeout));
        assert_eq!(state, IntentState::Unknown);

        let err = wal.check_gate(&session, Some(7)).unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied);
        let data = err.data.expect("uncertain_prior_effect error data");
        assert_eq!(data["reason"], "uncertain_prior_effect");
        assert_eq!(data["operation_id"], "op-ref-timeout");
        assert_eq!(data["method"], "tool.click");
        assert_eq!(data["target_summary"], "ref:e5");
        assert!(
            data["recovery"]
                .as_str()
                .unwrap_or_default()
                .contains("bsk sync")
        );

        // Unrelated tab 8 in the same session remains unblocked.
        assert!(wal.check_gate(&session, Some(8)).is_ok());

        // Reconcile tab 7 via `bsk sync`.
        assert_eq!(wal.reconcile_tab(&session, Some(7), "cooperate_sync"), 1);
        assert!(wal.check_gate(&session, Some(7)).is_ok());

        // 2. Bare CSS `--selector "#pay-btn"` (`exp04` red-team regression!) with `Cancelled`
        // and `effect_state == "unknown"` MUST also freeze the tab!
        let ticket = wal.begin_dispatch(
            &session,
            Some(7),
            Some("op-css-pay"),
            &Method::ToolClick,
            &json!({ "session_id": "sess-pay", "tab_id": 7, "selector": "#pay-btn" }),
        );
        let st = wal.finish_dispatch(
            ticket,
            &Method::ToolClick,
            &Err(DispatchError::Rpc(RpcError {
                code: ErrorCode::Cancelled,
                message: "cancelled mid-flight".into(),
                data: Some(json!({ "effect_state": "unknown" })),
            })),
        );
        assert_eq!(st, IntentState::Unknown);

        // Blind replay (even switching from selector to ref or visual coords!) is blocked.
        let err = wal.check_gate(&session, Some(7)).unwrap_err();
        assert_eq!(err.code, ErrorCode::PermissionDenied);
        let data = err.data.unwrap();
        assert_eq!(data["reason"], "uncertain_prior_effect");
        assert_eq!(data["operation_id"], "op-css-pay");
        assert_eq!(data["target_summary"], "selector:#pay-btn");

        // Explicit `bsk ledger resolve` unlocks the tab without full sync.
        let resolved = wal.resolve(&session, Some(7), Some("op-css-pay"));
        assert_eq!(resolved.resolved_count, 1);
        assert_eq!(resolved.resolved[0].state, IntentState::Reconciled);
        assert!(wal.check_gate(&session, Some(7)).is_ok());
    }

    #[test]
    fn unpressed_click_and_pre_write_validation_settle_with_extension_payloads() {
        let session = sid("sess-unsent");
        let settle = |method: Method, data: Value| {
            let wal = IntentWal::memory();
            let ticket = wal.begin_dispatch(
                &session,
                Some(1),
                Some("op"),
                &method,
                &json!({ "ref": "e2" }),
            );
            let state = wal.finish_dispatch(
                ticket,
                &method,
                &Err(DispatchError::Rpc(RpcError {
                    code: ErrorCode::InvalidParams,
                    message: "refused".into(),
                    data: Some(data),
                })),
            );
            (state, wal.check_gate(&session, Some(1)).is_ok())
        };

        // Shared control reports a click refused after scrolling as unknown *and* unpressed.
        assert_eq!(
            settle(
                Method::ToolClick,
                json!({ "reason": "target_covered", "effect_state": "unknown", "press_sent": false })
            ),
            (IntentState::Settled, true)
        );
        // `dispatched: false` is proof of absence regardless of the generic effect state.
        assert_eq!(
            settle(
                Method::ToolFill,
                json!({ "effect_state": "unknown", "dispatched": false })
            ),
            (IntentState::Settled, true)
        );
        // Pre-write select/fill validation reports `effect_state: none`.
        assert_eq!(
            settle(
                Method::ToolSelect,
                json!({ "reason": "option_not_found", "effect_state": "none", "phase": "precondition" })
            ),
            (IntentState::Settled, true)
        );
        // `press_sent` is a click-only fact; other unknown effects still freeze the tab.
        assert_eq!(
            settle(
                Method::ToolFill,
                json!({ "effect_state": "unknown", "press_sent": false })
            ),
            (IntentState::Unknown, false)
        );
        assert_eq!(
            settle(Method::ToolClick, json!({ "effect_state": "unknown" })),
            (IntentState::Unknown, false)
        );
    }

    #[test]
    fn deterministic_effect_none_and_press_sent_false_settle_without_freezing() {
        let wal = IntentWal::memory();
        let session = sid("sess-clean");

        // `effect_state == "none"` (e.g. `virtual_row_recycled` or `target_hidden`) -> SETTLED.
        let t1 = wal.begin_dispatch(
            &session,
            Some(1),
            Some("op-1"),
            &Method::ToolClick,
            &json!({ "ref": "e2" }),
        );
        let s1 = wal.finish_dispatch(
            t1,
            &Method::ToolClick,
            &Err(DispatchError::Rpc(RpcError {
                code: ErrorCode::PermissionDenied,
                message: "virtual row recycled".into(),
                data: Some(json!({
                    "reason": "virtual_row_recycled",
                    "effect_state": "none"
                })),
            })),
        );
        assert_eq!(s1, IntentState::Settled);
        assert!(wal.check_gate(&session, Some(1)).is_ok());

        // `tool.click` with `press_sent == false` -> SETTLED.
        let t2 = wal.begin_dispatch(
            &session,
            Some(1),
            Some("op-2"),
            &Method::ToolClick,
            &json!({ "selector": "#submit" }),
        );
        let s2 = wal.finish_dispatch(
            t2,
            &Method::ToolClick,
            &Err(DispatchError::Rpc(RpcError {
                code: ErrorCode::Timeout,
                message: "timed out before mousePressed".into(),
                data: Some(json!({ "press_sent": false })),
            })),
        );
        assert_eq!(s2, IntentState::Settled);
        assert!(wal.check_gate(&session, Some(1)).is_ok());
    }

    #[test]
    fn fill_secret_password_and_evaluate_source_never_touch_wal_disk_or_memory() {
        let tmp = TempDir::new().unwrap();
        let ledger_path = tmp.path().join("intent_ledger.jsonl");
        let wal = IntentWal::new(Some(ledger_path.clone()));
        let session = sid("sess-secret");
        let top_secret = "UltraSecretBankPassword#998877!";
        let secret_js =
            "fetch('/transfer', { headers: { Authorization: 'Bearer sk-live-99999' } })";

        let t_fill = wal.begin_dispatch(
            &session,
            Some(3),
            Some("op-fill-pw"),
            &Method::ToolFill,
            &json!({
                "session_id": "sess-secret",
                "tab_id": 3,
                "ref": "e9",
                "value": top_secret,
            }),
        );
        assert_eq!(
            wal.finish_dispatch(t_fill, &Method::ToolFill, &Ok(json!({ "tab_id": 3 }))),
            IntentState::Settled
        );

        let t_eval = wal.begin_dispatch(
            &session,
            Some(3),
            Some("op-eval"),
            &Method::ToolEvaluate,
            &json!({
                "session_id": "sess-secret",
                "tab_id": 3,
                "expression": secret_js,
            }),
        );
        assert_eq!(
            wal.finish_dispatch(t_eval, &Method::ToolEvaluate, &Err(DispatchError::Timeout)),
            IntentState::Unknown
        );

        let on_disk = fs::read_to_string(&ledger_path).expect("ledger file exists");
        assert!(
            !on_disk.contains(top_secret),
            "fill plaintext value MUST NEVER be persisted to intent_ledger.jsonl"
        );
        assert!(
            !on_disk.contains("sk-live-99999"),
            "evaluate script expression MUST NEVER be persisted to intent_ledger.jsonl"
        );
        assert!(on_disk.contains("\"ref:e9\""));
        assert!(on_disk.contains(&format!("script(len={})", secret_js.chars().count())));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&ledger_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(
                mode, 0o600,
                "intent_ledger.jsonl must enforce 0600 permissions"
            );
        }
    }

    #[test]
    fn daemon_restart_promotes_leftover_dispatched_records_to_unknown() {
        let tmp = TempDir::new().unwrap();
        let ledger_path = tmp.path().join("intent_ledger.jsonl");
        let session = sid("sess-crash");

        {
            let wal = IntentWal::new(Some(ledger_path.clone()));
            let mut ticket = wal.begin_dispatch(
                &session,
                Some(11),
                Some("op-inflight-crash"),
                &Method::ToolClick,
                &json!({ "image_x": 320, "image_y": 480 }),
            );
            // Simulate hard process kill (`SIGKILL`) before `finish_dispatch` or `Drop` runs.
            ticket.finished = true;
        }

        let recovered = IntentWal::new(Some(ledger_path));
        let status = recovered.status(Some(&session));
        assert!(status.frozen);
        assert_eq!(status.pending_unknown.len(), 1);
        assert_eq!(status.pending_unknown[0].operation_id, "op-inflight-crash");
        assert_eq!(status.pending_unknown[0].target_summary, "visual:(320,480)");
        assert_eq!(status.pending_unknown[0].state, IntentState::Unknown);

        let gate_err = recovered.check_gate(&session, Some(11)).unwrap_err();
        assert_eq!(gate_err.code, ErrorCode::PermissionDenied);
        assert_eq!(gate_err.data.unwrap()["reason"], "uncertain_prior_effect");
    }

    #[test]
    fn single_mutation_wal_overhead_stays_well_under_3ms_budget() {
        let tmp = TempDir::new().unwrap();
        let wal = IntentWal::new(Some(tmp.path().join("intent_ledger.jsonl")));
        let session = sid("sess-perf");
        let params = json!({ "ref": "e3", "value": "hello world" });

        // Warm up file descriptor once, then measure steady-state hot-path latency.
        let warm = wal.begin_dispatch(&session, Some(1), Some("warm"), &Method::ToolFill, &params);
        wal.finish_dispatch(warm, &Method::ToolFill, &Ok(json!({ "tab_id": 1 })));

        let start = Instant::now();
        let iterations = 50u32;
        for i in 0..iterations {
            wal.check_gate(&session, Some(1)).unwrap();
            let op_id = format!("op-perf-{i}");
            let ticket =
                wal.begin_dispatch(&session, Some(1), Some(&op_id), &Method::ToolFill, &params);
            wal.finish_dispatch(ticket, &Method::ToolFill, &Ok(json!({ "tab_id": 1 })));
        }
        let avg_us = start.elapsed().as_micros() / u128::from(iterations);
        assert!(
            avg_us < 3_000,
            "expected <3000us per mutation WAL cycle, got {avg_us}us"
        );
    }

    #[test]
    fn full_handler_blocks_blind_replay_allows_readonly_and_auto_reconciles_on_sync() {
        crate::daemon::test_support::isolated(
            "daemon::intent_wal::tests::full_handler_blocks_blind_replay_allows_readonly_and_auto_reconciles_on_sync",
            || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(async {
                    use crate::daemon::browsers::{
                        BrowserClient, BrowserId, BrowserSink, Liveness, next_browser_generation,
                    };
                    use crate::daemon::ipc::DaemonStatus;
                    use crate::daemon::sessions::Session;
                    use crate::daemon::start::DaemonConfig;
                    use crate::daemon::state::{DAEMON_VERSION, DaemonState, PROTOCOL_VERSION};
                    use bsk_protocol::{Frame, ResponseBody, ResponseFrame};

                    let state = Arc::new(DaemonState::new(DaemonConfig::new(0)));
                    let (ws_tx, mut ws_rx) = tokio::sync::mpsc::unbounded_channel();
                    let browser_id = BrowserId("browser-wal-1".into());
                    let client = Arc::new(BrowserClient {
                        id: browser_id.clone(),
                        browser_name: "Chromium".into(),
                        browser_version: "136.0".into(),
                        extension_version: "0.5.0".into(),
                        extension_protocol_version: PROTOCOL_VERSION.into(),
                        label: "test".into(),
                        sink: BrowserSink { tx: ws_tx },
                        pending: Default::default(),
                        generation: next_browser_generation(),
                        connected_at_ms: 1,
                        version_skew: false,
                        liveness: Liveness::default(),
                    });
                    state.browsers.insert(Arc::clone(&client));

                    let session = sid("sess-ipc");
                    state.sessions.insert(Session {
                        controller: None,
                        interaction: None,
                        id: session.clone(),
                        browser_id: browser_id.clone(),
                        agent_window_id: Some(100),
                        created_at_ms: 1,
                    });
                    state.tool_queues.spawn(session.clone());
                    state
                        .scopes
                        .bind_scope("scope:checkout", session.clone(), browser_id, false);

                    // Mock extension answering frames pushed onto `ws_rx`.
                    let ext_client = Arc::clone(&client);
                    let driver = tokio::spawn(async move {
                        let mut first_click = true;
                        while let Some(frame) = ws_rx.recv().await {
                            let Frame::Request(req) = frame else {
                                continue;
                            };
                            let body = match req.method {
                                Method::ToolClick if first_click => {
                                    first_click = false;
                                    ResponseBody::Err(RpcError {
                                        code: ErrorCode::Timeout,
                                        message: "extension click timed out".into(),
                                        data: Some(json!({
                                            "effect_state": "unknown",
                                            "tab_id": 10,
                                        })),
                                    })
                                }
                                Method::ToolClick => ResponseBody::Ok(json!({
                                    "tab_id": 10,
                                    "used_selector": "#pay-btn",
                                    "x": 50.0,
                                    "y": 40.0,
                                })),
                                Method::ToolRead | Method::ToolNetwork => {
                                    ResponseBody::Ok(json!({ "tab_id": 10, "ok": true }))
                                }
                                Method::ToolCooperate => ResponseBody::Ok(json!({
                                    "tab_id": 10,
                                    "context_id": "11111111-2222-3333-4444-555555555555",
                                    "control_policy": "target",
                                    "kind": "full",
                                    "vom": "@vom 1\n[e1] button \"Pay\"",
                                })),
                                Method::ToolSessionStop => ResponseBody::Ok(json!({
                                    "returned_tab_ids": [],
                                    "return_failures": [],
                                })),
                                _ => ResponseBody::Ok(json!({})),
                            };
                            ext_client
                                .pending
                                .lock()
                                .unwrap()
                                .resolve(ResponseFrame { id: req.id, body });
                        }
                    });

                    let handler = crate::daemon::ipc::full_envelope_handler(
                        DaemonStatus {
                            started_at: Instant::now(),
                            ws_port: 0,
                            sock_path: PathBuf::from("/tmp/unused.sock"),
                            daemon_version: DAEMON_VERSION,
                            protocol_version: PROTOCOL_VERSION,
                        },
                        Arc::clone(&state),
                    );
                    let checkout_meta = crate::ipc_client::IpcRequestMeta {
                        caller_scope: Some("scope:checkout".into()),
                        ..Default::default()
                    };

                    // Initial `bsk sync` records `active_tab_id = 10` for implicit calls.
                    let (sync0, _) = handler(
                        "rpc-sync-0".into(),
                        Method::ToolCooperate,
                        json!({
                            "action": "sync",
                            "control_policy": "target",
                        }),
                        checkout_meta.clone(),
                    )
                    .await;
                    assert!(matches!(sync0, ResponseBody::Ok(_)));

                    // 1. Bare CSS selector `#pay-btn` click returns `Timeout` / `unknown` -> freezes tab 10.
                    let (click1, _) = handler(
                        "rpc-click-1".into(),
                        Method::ToolClick,
                        json!({
                            "selector": "#pay-btn",
                        }),
                        checkout_meta.clone(),
                    )
                    .await;
                    assert!(matches!(
                        click1,
                        ResponseBody::Err(RpcError {
                            code: ErrorCode::Timeout,
                            ..
                        })
                    ));

                    // 2. Blind replay via `--ref e1` on the same tab is rejected in <1ms!
                    let (replay, _) = handler(
                        "rpc-click-replay".into(),
                        Method::ToolClick,
                        json!({
                            "ref": "e1",
                        }),
                        checkout_meta.clone(),
                    )
                    .await;
                    match replay {
                        ResponseBody::Err(err) => {
                            assert_eq!(err.code, ErrorCode::PermissionDenied);
                            let data = err.data.unwrap();
                            assert_eq!(data["reason"], "uncertain_prior_effect");
                            assert_eq!(data["target_summary"], "selector:#pay-btn");
                        }
                        other => panic!("expected uncertain_prior_effect, got {other:?}"),
                    }

                    // 3. Read-only diagnostics (`tool.read`, `tool.network`, `ledger.request`) pass 100%!
                    for (id, m) in [
                        ("rpc-read", Method::ToolRead),
                        ("rpc-net", Method::ToolNetwork),
                    ] {
                        let (res, _) =
                            handler(id.into(), m, json!({}), checkout_meta.clone()).await;
                        assert!(matches!(res, ResponseBody::Ok(_)));
                    }
                    let (status_res, _) = handler(
                        "rpc-ledger-status".into(),
                        Method::LedgerRequest,
                        json!({ "action": "status" }),
                        checkout_meta.clone(),
                    )
                    .await;
                    let ResponseBody::Ok(status_val) = status_res else {
                        panic!("expected ledger status ok");
                    };
                    assert_eq!(status_val["frozen"], true);
                    assert_eq!(status_val["pending_unknown"].as_array().unwrap().len(), 1);

                    // 4. `bsk sync` (`tool.cooperate` `action: "sync"`) auto-reconciles `UNKNOWN -> RECONCILED`!
                    let (sync1, _) = handler(
                        "rpc-sync-1".into(),
                        Method::ToolCooperate,
                        json!({
                            "action": "sync",
                            "control_policy": "target",
                        }),
                        checkout_meta.clone(),
                    )
                    .await;
                    assert!(matches!(sync1, ResponseBody::Ok(_)));

                    let (status_after, _) = handler(
                        "rpc-ledger-status-2".into(),
                        Method::LedgerRequest,
                        json!({ "action": "status" }),
                        checkout_meta.clone(),
                    )
                    .await;
                    let ResponseBody::Ok(status_after_val) = status_after else {
                        panic!("expected ledger status ok");
                    };
                    assert_eq!(status_after_val["frozen"], false);

                    // 5. Follow-up `tool.click` now succeeds cleanly!
                    let (click2, _) = handler(
                        "rpc-click-2".into(),
                        Method::ToolClick,
                        json!({
                            "selector": "#pay-btn",
                        }),
                        checkout_meta,
                    )
                    .await;
                    assert!(matches!(click2, ResponseBody::Ok(_)));

                    driver.abort();
                });
            },
        );
    }
}
