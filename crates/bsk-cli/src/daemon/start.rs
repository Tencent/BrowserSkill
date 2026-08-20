//! Daemon entrypoints (`bsk daemon start|stop|restart`).
//!
//! The "start" path comes in two flavours:
//! * `--foreground` — run the daemon loop in the current process and
//!   inherit stdio. Used by tests and `--foreground` users.
//! * default — fork-and-detach a child copy of the same binary, wait
//!   for it to write a valid `daemon.json`, then return success.
//!
//! Detachment uses a hidden `BSK_DAEMONIZED=1` env handoff: when the
//! parent spawns the child it sets the env var; the child sees it on
//! startup, redirects stdio to `/dev/null`, calls `setsid` (Unix), and
//! falls through to `run_foreground`.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bsk_protocol::{Method, StatusParams, StatusResult};
use tracing::{debug, info, warn};

use crate::cli::daemon::StartArgs;
use crate::daemon::{
    browsers::{BROWSER_LIVENESS_TICK, BROWSER_LIVENESS_TIMEOUT, EXTENSION_CONNECT_WAIT},
    info as daemon_info, ipc, lockfile, paths,
    sessions::{StopSessionError, forget_session, stop_session},
    state::{DaemonState, PROTOCOL_VERSION},
    ws,
};

/// Internal env-var contract: the parent sets this on the spawned child
/// to indicate "you are the daemon, detach yourself and run".
pub(crate) const DAEMONIZED_ENV: &str = "BSK_DAEMONIZED";

/// Internal env-var contract for daemon self-restart after an
/// auto-update: the outgoing daemon spawns its replacement with this set
/// to its own pid; the child waits for that pid to exit — releasing the
/// daemon lock, IPC socket, and WS port — before taking over.
pub(crate) const DAEMON_REPLACEMENT_WAIT_ENV: &str = "BSK_DAEMON_REPLACES_PID";

/// Concrete daemon configuration resolved from CLI flags / defaults.
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub ws_port: u16,
    pub session_idle: Duration,
    pub daemon_idle: Duration,
    /// Skip the Origin allow-list (tests / `--insecure-origin`).
    pub allow_any_origin: bool,
    /// How long `session.start` polls for an extension handshake before
    /// returning `no_browser_connected`.
    pub extension_connect_wait: Duration,
    /// A heartbeat-capable browser silent for at least this long is
    /// reaped by the liveness task. Defaults to [`BROWSER_LIVENESS_TIMEOUT`].
    pub browser_liveness_timeout: Duration,
    /// How often the liveness task scans the registry. Defaults to
    /// [`BROWSER_LIVENESS_TICK`].
    pub browser_liveness_tick: Duration,
}

impl DaemonConfig {
    /// Test/embed helper: a minimal config locked to `port` with
    /// generous idle timeouts. Used by integration tests that spin up
    /// a daemon via [`super::run`].
    pub fn new(port: u16) -> Self {
        Self {
            ws_port: port,
            session_idle: Duration::from_secs(60 * 5),
            daemon_idle: Duration::from_secs(60 * 30),
            allow_any_origin: false,
            extension_connect_wait: EXTENSION_CONNECT_WAIT,
            browser_liveness_timeout: BROWSER_LIVENESS_TIMEOUT,
            browser_liveness_tick: BROWSER_LIVENESS_TICK,
        }
    }

    pub fn with_extension_connect_wait(mut self, wait: Duration) -> Self {
        self.extension_connect_wait = wait;
        self
    }

    /// Override the liveness reaper's silence threshold and scan cadence.
    /// Primarily for tests that need the reaper to act within
    /// sub-second windows instead of the production 60s/15s defaults.
    pub fn with_browser_liveness(mut self, timeout: Duration, tick: Duration) -> Self {
        self.browser_liveness_timeout = timeout;
        self.browser_liveness_tick = tick;
        self
    }
}

impl From<&StartArgs> for DaemonConfig {
    fn from(args: &StartArgs) -> Self {
        Self {
            ws_port: args.resolved_port(),
            session_idle: args.resolved_session_idle(),
            daemon_idle: args.resolved_daemon_idle(),
            allow_any_origin: false,
            extension_connect_wait: EXTENSION_CONNECT_WAIT,
            browser_liveness_timeout: BROWSER_LIVENESS_TIMEOUT,
            browser_liveness_tick: BROWSER_LIVENESS_TICK,
        }
    }
}

/// `bsk daemon start` entrypoint.
pub fn run_start(args: StartArgs) -> Result<()> {
    let cfg = DaemonConfig::from(&args);

    if args.foreground {
        return run_foreground(cfg);
    }

    // Detached child mode (set by parent before spawn).
    if is_daemonized_child() {
        wait_for_replaced_daemon();
        detach_stdio()?;
        return run_foreground(cfg);
    }

    if let Some(status) = verified_existing_daemon()? {
        validate_existing_start(&args, &status)?;
        info!(
            pid = status.pid,
            ws_port = status.ws_port,
            "daemon already running"
        );
        return Ok(());
    }

    // Parent: spawn ourselves detached and wait for ready.
    spawn_detached(&args)?;
    wait_for_ready(Duration::from_secs(3), args.port.filter(|port| *port != 0))?;
    Ok(())
}

/// `bsk daemon stop` entrypoint.
pub fn run_stop() -> Result<()> {
    let info = match daemon_info::read()? {
        Some(info) => info,
        None => {
            info!("no daemon.json present — nothing to stop");
            return Ok(());
        }
    };

    if !lockfile::pid_alive(info.pid) {
        info!(
            pid = info.pid,
            "daemon.json points to a dead pid — cleaning up"
        );
        let _ = daemon_info::remove();
        return Ok(());
    }

    match confirm_daemon(&info, Duration::from_secs(2)) {
        Ok(status) if status.pid == info.pid => {}
        Ok(status) => {
            warn!(
                expected_pid = info.pid,
                actual_pid = status.pid,
                "daemon.json does not match IPC daemon; refusing to stop"
            );
            return Err(anyhow::anyhow!(
                "daemon.json pid {} does not match IPC daemon pid {}; refusing to stop",
                info.pid,
                status.pid
            ));
        }
        Err(err) => {
            warn!(
                pid = info.pid,
                ?err,
                "daemon.json pid is alive but IPC validation failed; refusing to stop"
            );
            return Err(anyhow::anyhow!(
                "could not verify daemon identity for pid {}; refusing to stop: {err:#}",
                info.pid
            ));
        }
    }

    send_term(info.pid)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !lockfile::pid_alive(info.pid) {
            let _ = daemon_info::remove();
            info!(pid = info.pid, "daemon stopped");
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    warn!(
        pid = info.pid,
        "daemon did not exit within 5s; sending KILL"
    );
    let _ = send_kill(info.pid);
    let _ = daemon_info::remove();
    Ok(())
}

/// Run the daemon in the foreground of the current process: acquire
/// the lock, bind IPC, publish `daemon.json`, and serve until shutdown.
pub fn run_foreground(cfg: DaemonConfig) -> Result<()> {
    paths::ensure_bsk_home()?;
    let _log_guard = init_tracing();
    let lock = lockfile::acquire().context("acquire daemon lock")?;
    info!(?lock, "daemon lock acquired");

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("build tokio runtime")?;

    runtime.block_on(async move {
        #[cfg(unix)]
        let sock_path = paths::sock_path().context("resolve socket path")?;
        #[cfg(windows)]
        let sock_path = std::path::PathBuf::from(paths::pipe_name());

        let ipc_listener = ipc::bind(&sock_path)
            .await
            .with_context(|| format!("bind IPC endpoint {}", sock_path.display()))?;

        let state = Arc::new(DaemonState::new(cfg.clone()));
        state
            .transfers
            .initialize()
            .context("initialize transfer staging")?;
        let session_idle_task = spawn_session_idle_reaper(Arc::clone(&state));
        let browser_liveness_task = spawn_browser_liveness_reaper(Arc::clone(&state));
        // Fired by the update check task after a successful auto-update:
        // the replacement daemon has already been spawned, so this
        // process should shut down and let it take over.
        let restart_notify = Arc::new(tokio::sync::Notify::new());
        let update_check_task =
            spawn_update_check_task(Arc::clone(&state), Arc::clone(&restart_notify));
        let ws_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), cfg.ws_port);
        let ws_handle = ws::WsServer::new(Arc::clone(&state))
            .bind(ws_addr)
            .await
            .with_context(|| format!("bind WS server on {ws_addr}"))?;
        let ws_port = ws_handle.local_addr.port();

        let info = daemon_info::DaemonInfo::now(
            std::process::id(),
            sock_path.clone(),
            ws_port,
            env!("CARGO_PKG_VERSION"),
        );
        daemon_info::write(&info).context("write daemon.json")?;
        info!(
            pid = info.pid,
            ws_port = info.ws_port,
            sock = %sock_path.display(),
            "daemon ready"
        );

        // Best-effort: keep installed agent skills in step with this
        // daemon's bundled SKILL.md. Spawned so a slow/failing fs
        // never blocks the daemon ready signal.
        tokio::spawn(async move {
            let result = tokio::task::spawn_blocking(|| {
                let home = match crate::skill_install::harness::home_dir() {
                    Ok(home) => home,
                    Err(err) => {
                        warn!(error = %err, "skill sync skipped: cannot resolve $HOME");
                        return None;
                    }
                };
                Some(crate::skill_install::sync::sync_installed_skills(&home))
            })
            .await;

            match result {
                Ok(Some(report)) => {
                    for harness in &report.updated {
                        info!(harness = harness.cli_name(), "skill synced");
                    }
                    for (harness, msg) in &report.errors {
                        warn!(harness = harness.cli_name(), error = %msg, "skill sync failed");
                    }
                    if !report.up_to_date.is_empty() {
                        debug!(count = report.up_to_date.len(), "skill already up to date");
                    }
                }
                Ok(None) => { /* home_dir() already warned inside the closure */ }
                Err(join_err) => {
                    warn!(error = %join_err, "skill sync task panicked");
                }
            }
        });

        let started_at = Instant::now();
        let activity = Arc::new(Mutex::new(IpcActivityState::new(started_at)));
        let (ipc_shutdown_tx, ipc_shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let status = ipc::DaemonStatus {
            started_at,
            ws_port,
            sock_path: sock_path.clone(),
            daemon_version: env!("CARGO_PKG_VERSION"),
            protocol_version: PROTOCOL_VERSION,
        };
        let handler = ipc::full_handler(status, Arc::clone(&state));

        let ipc_activity = {
            let activity = activity.clone();
            move || {
                record_activity(&activity);
            }
        };

        let ipc_task = {
            let handler = handler.clone();
            let ipc_open = {
                let activity = activity.clone();
                move || {
                    record_ipc_open(&activity);
                }
            };
            let ipc_close = {
                let activity = activity.clone();
                move || {
                    record_ipc_close(&activity);
                }
            };
            tokio::spawn(ipc::serve(
                ipc_listener,
                handler,
                ipc_open,
                ipc_activity,
                ipc_close,
                async move {
                    let _ = ipc_shutdown_rx.await;
                },
            ))
        };

        let (_idle_tx, idle_rx) = tokio::sync::oneshot::channel::<()>();
        let idle_task = {
            let activity = activity.clone();
            let state = Arc::clone(&state);
            let daemon_idle = cfg.daemon_idle;
            tokio::spawn(async move {
                let tick = (daemon_idle / 4).max(Duration::from_millis(250));
                let mut ticker = tokio::time::interval(tick);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    ticker.tick().await;
                    let ipc_is_idle =
                        lock_activity(&activity).should_exit_for_idle(Instant::now(), daemon_idle);
                    if !ipc_is_idle {
                        continue;
                    }
                    // IPC liveness (open-connection count + idle window) is already
                    // enforced above by `should_exit_for_idle`, which reads
                    // `IpcActivityState` under one lock and returns true only when
                    // there are zero connections AND the idle interval has elapsed.
                    // Here we additionally hold the daemon alive while any browser
                    // is paired or any session is live (design §3.2, M4/M5
                    // registries).
                    if !state.browsers.is_empty() || !state.sessions.is_empty() {
                        continue;
                    }
                    info!(
                        idle_secs = daemon_idle.as_secs(),
                        "daemon exceeded idle threshold; exiting"
                    );
                    return Some(());
                }
            })
        };
        drop(idle_rx);

        // Created before `select!` so a `notify_one` from the update
        // check task is never missed (Notify stores one permit).
        let restart_notified = restart_notify.notified();
        tokio::pin!(restart_notified);

        tokio::select! {
            _ = wait_for_shutdown() => {
                info!("bsk daemon shutting down (signal)");
            }
            res = idle_task => {
                if matches!(res, Ok(Some(()))) {
                    info!("bsk daemon shutting down (idle)");
                }
            }
            _ = &mut restart_notified => {
                info!("bsk daemon shutting down (auto-update restart)");
            }
        }

        let _ = ipc_shutdown_tx.send(());
        let _ = ipc_task.await;
        session_idle_task.abort();
        let _ = session_idle_task.await;
        browser_liveness_task.abort();
        let _ = browser_liveness_task.await;
        update_check_task.abort();
        let _ = update_check_task.await;
        ws_handle.shutdown.notify_waiters();
        let _ = ws_handle.task.await;

        let _ = daemon_info::remove();
        let _ = std::fs::remove_file(&sock_path);
        Result::<()>::Ok(())
    })?;

    drop(lock);
    Ok(())
}

/// Spawn the browser-liveness reaper shared by the production foreground
/// daemon and the test/embed entry point.
///
/// A normal disconnect closes the WebSocket, which the per-connection
/// read loop observes and cleans up. But if the OS resumed from sleep
/// and killed the MV3 service worker, the socket can be left half-open
/// with no close frame ever delivered. Without the ~20s `system.heartbeat`
/// arriving, such a connection would otherwise sit in the registry
/// forever — pinning a phantom "connected" browser and preventing the
/// daemon from ever idle-exiting. This reaper drops any browser that has
/// gone silent past [`BROWSER_LIVENESS_TIMEOUT`] and purges its sessions,
/// mirroring the WS disconnect cleanup.
pub(crate) fn spawn_browser_liveness_reaper(
    state: Arc<DaemonState>,
) -> tokio::task::JoinHandle<()> {
    let timeout = state.config.browser_liveness_timeout;
    let tick = state.config.browser_liveness_tick;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(tick);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick is immediate; skip it so a freshly connected
        // browser always gets at least one full window before a scan.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            for client in state.browsers.stale_browsers(timeout) {
                if state
                    .browsers
                    .remove_if_generation_matches(&client.id, client.generation)
                    .is_some()
                {
                    warn!(
                        id = %client.id,
                        idle_secs = client.idle_for().as_secs(),
                        "reaping unresponsive browser (no heartbeat within liveness window)"
                    );
                    for s in state.sessions.purge_browser(&client.id) {
                        state.tool_queues.remove(&s.id);
                        state.session_interrupts.drop_session(&s.id);
                        state.transfers.release_session(&s.id.0);
                        debug!(session = %s.id, "purged session on browser liveness timeout");
                    }
                }
            }
        }
    })
}

/// Spawn the cooperative session-idle reaper shared by the production
/// foreground daemon and the test/embed daemon entry point.
pub(crate) fn spawn_session_idle_reaper(state: Arc<DaemonState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let session_idle = state.config.session_idle;
        let tick = (session_idle / 4)
            .max(Duration::from_millis(100))
            .min(Duration::from_secs(30));
        let mut ticker = tokio::time::interval(tick);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // `interval`'s first tick is immediate. Consume it so a zero/very
        // short test setting still gets one real inactivity window.
        ticker.tick().await;

        loop {
            ticker.tick().await;
            let idle_ids = state.sessions.idle_ids_at(session_idle, Instant::now());
            for session_id in idle_ids {
                match stop_session(
                    &state.browsers,
                    &state.sessions,
                    &state.tool_queues,
                    &state.session_interrupts,
                    &session_id,
                    Duration::from_secs(10),
                    None,
                )
                .await
                {
                    Ok(_) => {
                        state.transfers.release_session(&session_id.0);
                        info!(session = %session_id, "idle session stopped");
                    }
                    Err(StopSessionError::SessionBusy | StopSessionError::Stopping) => {
                        debug!(session = %session_id, "idle session still active; retrying later");
                    }
                    Err(StopSessionError::NotFound | StopSessionError::BrowserGone) => {
                        forget_session(
                            &state.sessions,
                            &state.tool_queues,
                            &state.session_interrupts,
                            &session_id,
                        );
                        state.transfers.release_session(&session_id.0);
                    }
                    Err(err) => {
                        warn!(session = %session_id, error = %err, "failed to stop idle session");
                    }
                }
            }
        }
    })
}

/// Spawn the periodic update check owned by the production daemon.
///
/// The daemon is the only writer of `~/.bsk/update-check.json`; CLI
/// commands only read it to print the "new version available" hint
/// (see [`crate::cli::update::print_update_hint_from_cache`]). The first
/// tick of `tokio::time::interval` is immediate, so the check runs right
/// after startup and then every
/// [`crate::cli::update::UPDATE_CHECK_INTERVAL`]. Each tick re-reads the
/// cache and skips the network fetch while it is still fresh within
/// [`crate::cli::update::DAEMON_REFRESH_WINDOW`] (25min — shorter than
/// the 30min tick, so steady state really refreshes on every tick
/// instead of every other one). The task
/// loops forever; shutdown aborts it like the other background tasks, so
/// it never delays daemon exit (an in-flight fetch is bounded by the
/// update client's own timeout and detached on abort).
///
/// When a tick finds a newer version the daemon also *installs* it
/// (auto-update, on by default; [`crate::cli::update::AUTO_UPDATE_ENV`]
/// `=off` disables it and keeps the check cache/hint-only). Safety
/// gate: while any agent session is live the tick postpones the
/// install and retries next time. Once the new binary is in place the
/// task spawns the replacement daemon (see
/// [`DAEMON_REPLACEMENT_WAIT_ENV`]) and fires `restart` so this process
/// shuts down and the new version takes over; on Windows the
/// replacement can only be staged, so it just logs that a restart is
/// needed.
pub(crate) fn spawn_update_check_task(
    state: Arc<DaemonState>,
    restart: Arc<tokio::sync::Notify>,
) -> tokio::task::JoinHandle<()> {
    use crate::cli::update;

    tokio::spawn(async move {
        let cache_path = match paths::update_check_path() {
            Ok(path) => path,
            Err(err) => {
                warn!(error = %err, "periodic update check disabled: cannot resolve cache path");
                return;
            }
        };
        // Capture our own executable path once, up front: after an
        // auto-update replaces the binary, `current_exe` on Linux starts
        // returning a " (deleted)"-suffixed path that can neither be
        // replaced again nor spawned.
        let exe_path = match std::env::current_exe() {
            Ok(exe) => Some(exe),
            Err(err) => {
                warn!(error = %err, "auto-update install disabled: cannot locate current executable");
                None
            }
        };

        let mut ticker = tokio::time::interval(update::UPDATE_CHECK_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;

            let needs_refresh = match update::read_update_cache(&cache_path) {
                Ok(cache) => update::cache_needs_refresh(
                    cache.as_ref(),
                    update::now_epoch_secs(),
                    update::DAEMON_REFRESH_WINDOW,
                ),
                Err(err) => {
                    warn!(error = %err, "update cache unreadable; will refresh it");
                    true
                }
            };
            if !needs_refresh {
                debug!("update cache still fresh; skipping update check");
                continue;
            }

            let result = {
                let cache_path = cache_path.clone();
                let state = Arc::clone(&state);
                let exe_path = exe_path.clone();
                tokio::task::spawn_blocking(move || {
                    let candidate = update::refresh_update_cache(&cache_path)?;
                    // The session gate is read after the fetch, as late
                    // as possible before the binary gets replaced.
                    let active_sessions = state.sessions.len();
                    let auto_update = update::auto_update_enabled() && exe_path.is_some();
                    update::auto_update_step(
                        candidate.as_ref(),
                        auto_update,
                        active_sessions,
                        |candidate| {
                            let target =
                                exe_path.as_deref().context("current executable unknown")?;
                            update::self_install_candidate(candidate, target)
                        },
                    )
                })
                .await
            };
            let outcome = match result {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(err)) => {
                    warn!(error = %err, "periodic update check failed");
                    continue;
                }
                Err(err) => {
                    warn!(error = %err, "periodic update check task panicked");
                    continue;
                }
            };
            match outcome {
                update::AutoUpdateOutcome::UpToDate => {
                    info!("periodic update check refreshed cache (already up to date)")
                }
                update::AutoUpdateOutcome::Disabled { latest } => info!(
                    %latest,
                    "periodic update check found a new version; auto-update off, CLI hint only"
                ),
                update::AutoUpdateOutcome::PostponedSessions { latest, sessions } => info!(
                    %latest,
                    sessions,
                    "auto-update postponed: agent session(s) active; will retry on the next tick"
                ),
                update::AutoUpdateOutcome::Staged { latest } => warn!(
                    %latest,
                    "auto-update staged the new binary but cannot replace the running daemon in place; restart the daemon (or terminal) to finish the upgrade"
                ),
                update::AutoUpdateOutcome::Replaced { latest } => {
                    info!(
                        current = env!("CARGO_PKG_VERSION"),
                        %latest,
                        "auto-update installed the new bsk binary; restarting daemon"
                    );
                    // `exe_path` is always Some here: the install only
                    // runs when it was captured.
                    if let Some(exe) = &exe_path {
                        let args = restart_start_args(&state.config);
                        match spawn_detached_at(exe, &args, Some(std::process::id())) {
                            Ok(()) => {
                                info!(
                                    pid = std::process::id(),
                                    "replacement daemon spawned; exiting so it can take over"
                                );
                                restart.notify_one();
                                return;
                            }
                            Err(err) => warn!(
                                error = %err,
                                "auto-update replaced the binary but failed to spawn the replacement daemon; the next daemon start picks up the new version"
                            ),
                        }
                    }
                }
            }
        }
    })
}

/// Rebuild the `StartArgs` for the replacement daemon from the running
/// config so the respawn keeps the same port and idle timeouts.
fn restart_start_args(cfg: &DaemonConfig) -> StartArgs {
    StartArgs {
        port: Some(cfg.ws_port),
        foreground: false,
        session_idle: Some(cfg.session_idle),
        daemon_idle: Some(cfg.daemon_idle),
    }
}

#[derive(Debug)]
struct IpcActivityState {
    last_activity: Instant,
    active_connections: usize,
}

impl IpcActivityState {
    fn new(now: Instant) -> Self {
        Self {
            last_activity: now,
            active_connections: 0,
        }
    }

    fn touch(&mut self, now: Instant) {
        self.last_activity = now;
    }

    fn opened(&mut self, now: Instant) {
        self.active_connections = self.active_connections.saturating_add(1);
        self.last_activity = now;
    }

    fn closed(&mut self, now: Instant) {
        self.active_connections = self.active_connections.saturating_sub(1);
        self.last_activity = now;
    }

    fn should_exit_for_idle(&self, now: Instant, idle: Duration) -> bool {
        self.active_connections == 0 && now.saturating_duration_since(self.last_activity) >= idle
    }
}

fn lock_activity(
    activity: &Arc<Mutex<IpcActivityState>>,
) -> std::sync::MutexGuard<'_, IpcActivityState> {
    activity.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn record_activity(activity: &Arc<Mutex<IpcActivityState>>) {
    lock_activity(activity).touch(Instant::now());
}

fn record_ipc_open(activity: &Arc<Mutex<IpcActivityState>>) {
    lock_activity(activity).opened(Instant::now());
}

fn record_ipc_close(activity: &Arc<Mutex<IpcActivityState>>) {
    lock_activity(activity).closed(Instant::now());
}

/// Initialise tracing for the daemon: write a daily-rotated file in
/// `~/.bsk/` and (best-effort) also mirror to stderr. Returns the
/// non-blocking writer guard which must outlive the daemon loop.
fn init_tracing() -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::EnvFilter;
    use tracing_subscriber::fmt;
    use tracing_subscriber::prelude::*;

    let log_dir = paths::log_dir().ok();
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let (file_layer, guard) = if let Some(dir) = log_dir {
        let appender = tracing_appender::rolling::daily(&dir, "daemon.log");
        let (writer, guard) = tracing_appender::non_blocking(appender);
        let layer = fmt::layer()
            .with_writer(writer)
            .with_ansi(false)
            .with_target(true)
            .json();
        (Some(layer), Some(guard))
    } else {
        (None, None)
    };

    let stderr_layer = fmt::layer().with_writer(std::io::stderr).with_ansi(true);

    let _ = tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer)
        .with(stderr_layer)
        .try_init();
    guard
}

async fn wait_for_shutdown() {
    let _ = shutdown_signal().await;
}

#[cfg(unix)]
async fn shutdown_signal() -> Option<()> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut sigint = signal(SignalKind::interrupt()).ok()?;
    let mut sigterm = signal(SignalKind::terminate()).ok()?;
    tokio::select! {
        _ = sigint.recv() => {}
        _ = sigterm.recv() => {}
    }
    Some(())
}

#[cfg(windows)]
async fn shutdown_signal() -> Option<()> {
    let _ = tokio::signal::ctrl_c().await;
    Some(())
}

#[cfg(not(any(unix, windows)))]
async fn shutdown_signal() -> Option<()> {
    std::future::pending::<()>().await
}

fn is_daemonized_child() -> bool {
    std::env::var(DAEMONIZED_ENV).as_deref() == Ok("1")
}

/// Self-update handoff: when the outgoing daemon spawned us as its
/// replacement ([`DAEMON_REPLACEMENT_WAIT_ENV`]), wait for its pid to
/// exit so the daemon lock, IPC socket, and WS port are free before we
/// try to take them over. Bounded on purpose — the lockfile is the real
/// backstop if the predecessor somehow lingers.
fn wait_for_replaced_daemon() {
    let pid = std::env::var(DAEMON_REPLACEMENT_WAIT_ENV)
        .ok()
        .and_then(|raw| raw.parse::<u32>().ok());
    let Some(pid) = pid else {
        return;
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    while lockfile::pid_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
fn detach_stdio() -> Result<()> {
    use std::fs::OpenOptions;
    use std::os::fd::AsRawFd;
    let dev_null_in = OpenOptions::new()
        .read(true)
        .open("/dev/null")
        .context("open /dev/null for stdin")?;
    let dev_null_out = OpenOptions::new()
        .write(true)
        .open("/dev/null")
        .context("open /dev/null for stdout")?;
    let dev_null_err = OpenOptions::new()
        .write(true)
        .open("/dev/null")
        .context("open /dev/null for stderr")?;
    unsafe {
        let _ = libc::dup2(dev_null_in.as_raw_fd(), libc::STDIN_FILENO);
        let _ = libc::dup2(dev_null_out.as_raw_fd(), libc::STDOUT_FILENO);
        let _ = libc::dup2(dev_null_err.as_raw_fd(), libc::STDERR_FILENO);
    }
    // setsid is best-effort; if we were already a session leader (e.g.
    // when launched via systemd) the call simply fails harmlessly.
    unsafe {
        libc::setsid();
    }
    Ok(())
}

#[cfg(windows)]
fn detach_stdio() -> Result<()> {
    // On Windows the parent spawned us with DETACHED_PROCESS so stdio
    // is already detached. Nothing extra to do here.
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn detach_stdio() -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn spawn_detached(args: &StartArgs) -> Result<()> {
    let exe = std::env::current_exe().context("current_exe")?;
    spawn_detached_at(&exe, args, None)
}

/// Spawn a detached daemon child running the binary at `exe`. When
/// `predecessor_pid` is set, the child first waits for that process to
/// exit ([`DAEMON_REPLACEMENT_WAIT_ENV`]) — used by the auto-update
/// self-restart, where the on-disk binary has already been replaced, so
/// the child runs the new version.
#[cfg(unix)]
fn spawn_detached_at(exe: &Path, args: &StartArgs, predecessor_pid: Option<u32>) -> Result<()> {
    use std::os::unix::process::CommandExt;
    let mut cmd = std::process::Command::new(exe);
    apply_start_args(&mut cmd, args);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env(DAEMONIZED_ENV, "1");
    if let Some(pid) = predecessor_pid {
        cmd.env(DAEMON_REPLACEMENT_WAIT_ENV, pid.to_string());
    }
    // Place the child into its own session before exec to fully detach.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = cmd.spawn().context("spawn detached daemon child")?;
    drop(child); // parent immediately disowns; child runs independently
    Ok(())
}

#[cfg(windows)]
fn spawn_detached(args: &StartArgs) -> Result<()> {
    let exe = std::env::current_exe().context("current_exe")?;
    spawn_detached_at(&exe, args, None)
}

/// Windows counterpart of the unix [`spawn_detached_at`]; see its docs.
#[cfg(windows)]
fn spawn_detached_at(exe: &Path, args: &StartArgs, predecessor_pid: Option<u32>) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    let mut cmd = std::process::Command::new(exe);
    apply_start_args(&mut cmd, args);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .env(DAEMONIZED_ENV, "1");
    if let Some(pid) = predecessor_pid {
        cmd.env(DAEMON_REPLACEMENT_WAIT_ENV, pid.to_string());
    }
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    let _child = cmd.spawn().context("spawn detached daemon child")?;
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn spawn_detached(_args: &StartArgs) -> Result<()> {
    Err(anyhow::anyhow!(
        "detached daemon spawn is not supported on this platform"
    ))
}

#[cfg(not(any(unix, windows)))]
fn spawn_detached_at(_exe: &Path, _args: &StartArgs, _predecessor_pid: Option<u32>) -> Result<()> {
    Err(anyhow::anyhow!(
        "detached daemon spawn is not supported on this platform"
    ))
}

fn apply_start_args(cmd: &mut std::process::Command, args: &StartArgs) {
    cmd.arg("daemon").arg("start");
    if let Some(p) = args.port {
        cmd.arg("--port").arg(p.to_string());
    }
    if let Some(d) = args.session_idle {
        cmd.arg("--session-idle").arg(format_duration(d));
    }
    if let Some(d) = args.daemon_idle {
        cmd.arg("--daemon-idle").arg(format_duration(d));
    }
}

fn format_duration(d: Duration) -> String {
    let secs = d.as_secs();
    let millis = d.subsec_millis();
    if millis != 0 {
        format!("{}ms", d.as_millis())
    } else {
        format!("{secs}s")
    }
}

fn verified_existing_daemon() -> Result<Option<StatusResult>> {
    let Some(info) = daemon_info::read_valid()? else {
        return Ok(None);
    };
    match confirm_daemon(&info, Duration::from_millis(500)) {
        Ok(status) if status.pid == info.pid => Ok(Some(status)),
        Ok(_) | Err(_) => Ok(None),
    }
}

fn validate_existing_start(args: &StartArgs, status: &StatusResult) -> Result<()> {
    if let Some(port) = args.port
        && status.ws_port != port
    {
        return Err(anyhow::anyhow!(
            "daemon already running on ws port {}; use `bsk daemon restart --port {port}` to change it",
            status.ws_port
        ));
    }
    if args.session_idle.is_some() || args.daemon_idle.is_some() {
        return Err(anyhow::anyhow!(
            "daemon already running; use `bsk daemon restart` to apply idle timeout changes"
        ));
    }
    Ok(())
}

fn wait_for_ready(timeout: Duration, expected_port: Option<u16>) -> Result<()> {
    let info_path = paths::info_path()?;
    let deadline = Instant::now() + timeout;
    let _ = info_path;
    loop {
        if let Some(info) = daemon_info::read_valid()? {
            match confirm_daemon(&info, Duration::from_millis(500)) {
                Ok(status) if status.pid == info.pid => {
                    if let Some(port) = expected_port
                        && status.ws_port != port
                    {
                        return Err(anyhow::anyhow!(
                            "daemon started on ws port {}, expected {port}",
                            status.ws_port
                        ));
                    }
                    tracing::debug!(?info, "daemon ready");
                    return Ok(());
                }
                Ok(status) => {
                    tracing::debug!(
                        expected_pid = info.pid,
                        actual_pid = status.pid,
                        "daemon.json did not match IPC status yet"
                    );
                }
                Err(err) => {
                    tracing::debug!(?err, "daemon IPC not ready yet");
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(anyhow::anyhow!(
                "daemon failed to start within {:?} (no valid daemon.json)",
                timeout
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn confirm_daemon(info: &daemon_info::DaemonInfo, timeout: Duration) -> Result<StatusResult> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build tokio runtime for daemon verification")?;
    rt.block_on(async {
        let mut client = crate::ipc_client::Client::connect_path(info.sock_path.clone()).await?;
        let outcome = client
            .call::<_, StatusResult>(Method::SystemStatus, &StatusParams::default(), timeout)
            .await?;
        outcome.map_err(|err| {
            anyhow::anyhow!(
                "daemon verification RPC failed: {} ({:?})",
                err.message,
                err.code
            )
        })
    })
}

#[cfg(unix)]
fn send_term(pid: u32) -> Result<()> {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), Signal::SIGTERM)
        .map_err(|e| anyhow::anyhow!("kill -TERM {pid}: {e}"))
}

#[cfg(windows)]
fn send_term(pid: u32) -> Result<()> {
    send_kill(pid)
}

#[cfg(not(any(unix, windows)))]
fn send_term(_pid: u32) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn send_kill(pid: u32) -> Result<()> {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), Signal::SIGKILL)
        .map_err(|e| anyhow::anyhow!("kill -KILL {pid}: {e}"))
}

#[cfg(windows)]
fn send_kill(pid: u32) -> Result<()> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Err(anyhow::anyhow!("OpenProcess({pid}) failed"));
        }
        let _ = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn send_kill(_pid: u32) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_duration_round_trips_seconds_and_millis() {
        assert_eq!(format_duration(Duration::from_secs(5)), "5s");
        assert_eq!(format_duration(Duration::from_millis(750)), "750ms");
    }

    #[test]
    fn restart_start_args_preserve_the_running_config() {
        let cfg = DaemonConfig {
            ws_port: 1234,
            session_idle: Duration::from_secs(11),
            daemon_idle: Duration::from_secs(22),
            ..DaemonConfig::new(0)
        };
        let args = restart_start_args(&cfg);
        assert_eq!(args.port, Some(1234));
        assert!(!args.foreground);
        assert_eq!(args.session_idle, Some(Duration::from_secs(11)));
        assert_eq!(args.daemon_idle, Some(Duration::from_secs(22)));
    }

    #[test]
    fn ipc_close_restarts_the_idle_window_atomically() {
        let started = Instant::now();
        let idle = Duration::from_secs(10);
        let mut activity = IpcActivityState::new(started);

        activity.opened(started);
        let closed_at = started + Duration::from_secs(30);
        assert!(
            !activity.should_exit_for_idle(closed_at, idle),
            "an open IPC connection must hold the daemon alive"
        );

        activity.closed(closed_at);
        assert_eq!(activity.active_connections, 0);
        assert_eq!(activity.last_activity, closed_at);
        assert!(!activity.should_exit_for_idle(closed_at, idle));
        assert!(!activity.should_exit_for_idle(closed_at + idle - Duration::from_millis(1), idle));
        assert!(activity.should_exit_for_idle(closed_at + idle, idle));
    }

    #[test]
    fn ipc_activity_keeps_the_daemon_alive_until_a_full_idle_interval_passes() {
        let started = Instant::now();
        let idle = Duration::from_secs(10);
        let mut activity = IpcActivityState::new(started);
        let request_at = started + Duration::from_secs(20);

        activity.touch(request_at);
        assert!(!activity.should_exit_for_idle(request_at + Duration::from_secs(9), idle));
        assert!(activity.should_exit_for_idle(request_at + idle, idle));
    }
}
