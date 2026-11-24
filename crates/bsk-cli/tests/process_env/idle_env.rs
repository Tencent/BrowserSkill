//! End-to-end and process-env tests for `BSK_SESSION_IDLE` and `BSK_DAEMON_IDLE`.

use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use bsk::cli::daemon::{DAEMON_IDLE_ENV, DaemonMode, SESSION_IDLE_ENV, StartArgs};
use tempfile::TempDir;

struct EnvGuard {
    key: &'static str,
    original: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let original = std::env::var_os(key);
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, original }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.original {
            Some(v) => unsafe {
                std::env::set_var(self.key, v);
            },
            None => unsafe {
                std::env::remove_var(self.key);
            },
        }
    }
}

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn wait_child(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().expect("poll daemon child") {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    None
}

fn wait_for_daemon_ready(home: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if home.join("daemon.json").exists() {
            let status = Command::new(env!("CARGO_BIN_EXE_bsk"))
                .env("BSK_HOME", home)
                .env("BSK_AUTO_START", "0")
                .args(["status", "--json"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("probe bsk status");
            if status.success() {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    panic!("daemon did not become ready within {timeout:?}");
}

#[test]
fn foreground_daemon_self_exits_using_bsk_daemon_idle_env() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();

    let mut guard = ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_bsk"))
            .env("BSK_HOME", &home)
            .env("BSK_AUTO_UPDATE", "off")
            .env("BSK_UPDATE_MANIFEST_URL", "http://127.0.0.1:1/disabled")
            .env(DAEMON_IDLE_ENV, "350ms")
            .env_remove(SESSION_IDLE_ENV)
            .env("RUST_LOG", "warn")
            .args(["daemon", "start", "--foreground", "--port", "0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn foreground daemon"),
    );

    let status = wait_child(&mut guard.0, Duration::from_secs(4))
        .expect("daemon did not honor BSK_DAEMON_IDLE=350ms within 4s");
    assert!(
        status.success(),
        "daemon exited with non-zero status: {status}"
    );
    assert!(
        !home.join("daemon.json").exists(),
        "daemon.json should be removed on graceful idle shutdown"
    );
}

#[test]
fn foreground_daemon_cli_flag_overrides_env_idle() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();

    let mut guard = ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_bsk"))
            .env("BSK_HOME", &home)
            .env("BSK_AUTO_UPDATE", "off")
            .env("BSK_UPDATE_MANIFEST_URL", "http://127.0.0.1:1/disabled")
            .env(DAEMON_IDLE_ENV, "30m")
            .env(SESSION_IDLE_ENV, "30m")
            .env("RUST_LOG", "warn")
            .args([
                "daemon",
                "start",
                "--foreground",
                "--port",
                "0",
                "--daemon-idle",
                "350ms",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn foreground daemon with explicit override"),
    );

    let status = wait_child(&mut guard.0, Duration::from_secs(4))
        .expect("explicit --daemon-idle=350ms should override BSK_DAEMON_IDLE=30m");
    assert!(status.success());
}

#[test]
fn foreground_daemon_rejects_malformed_idle_env() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .env("BSK_HOME", &home)
        .env(SESSION_IDLE_ENV, "not-a-duration")
        .env_remove(DAEMON_IDLE_ENV)
        .args(["daemon", "start", "--foreground", "--port", "0"])
        .output()
        .expect("run bsk with invalid BSK_SESSION_IDLE");

    assert!(
        !out.status.success(),
        "malformed BSK_SESSION_IDLE must fail"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("invalid BSK_SESSION_IDLE"),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn daemon_start_reuses_running_daemon_when_idle_env_is_set_unless_cli_flag_passed() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();

    let _daemon = ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_bsk"))
            .env("BSK_HOME", &home)
            .env("BSK_AUTO_UPDATE", "off")
            .env("BSK_UPDATE_MANIFEST_URL", "http://127.0.0.1:1/disabled")
            .env("RUST_LOG", "warn")
            .args([
                "daemon",
                "start",
                "--foreground",
                "--port",
                "0",
                "--daemon-idle",
                "30s",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn running daemon"),
    );
    wait_for_daemon_ready(&home, Duration::from_secs(5));

    // Ambient BSK_SESSION_IDLE / BSK_DAEMON_IDLE must not break idempotent `bsk daemon start`.
    let reuse = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .env("BSK_HOME", &home)
        .env(SESSION_IDLE_ENV, "30m")
        .env(DAEMON_IDLE_ENV, "1h")
        .args(["daemon", "start"])
        .output()
        .expect("run idempotent bsk daemon start with idle env set");
    assert!(
        reuse.status.success(),
        "idempotent daemon start failed under idle env: {}",
        String::from_utf8_lossy(&reuse.stderr)
    );

    // Explicit CLI flag while running must still require `bsk daemon restart`.
    let explicit = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .env("BSK_HOME", &home)
        .args(["daemon", "start", "--session-idle", "30m"])
        .output()
        .expect("run bsk daemon start with explicit --session-idle");
    assert!(!explicit.status.success());
    let stderr = String::from_utf8_lossy(&explicit.stderr);
    assert!(
        stderr.contains("bsk daemon restart"),
        "unexpected stderr: {stderr}"
    );

    let _ = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .env("BSK_HOME", &home)
        .args(["daemon", "stop"])
        .status();
}

#[test]
fn with_env_idle_reads_process_environment_under_lock() {
    let _lock = crate::PROCESS_ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _s = EnvGuard::set(SESSION_IDLE_ENV, "12m");
    let _d = EnvGuard::set(DAEMON_IDLE_ENV, "34m");

    let local = StartArgs::default().with_env_idle().unwrap();
    assert_eq!(local.resolved_session_idle(), Duration::from_secs(12 * 60));
    assert_eq!(local.resolved_daemon_idle(), Duration::from_secs(34 * 60));

    let server = StartArgs {
        mode: DaemonMode::Server,
        public_url: Some("wss://browser.example/extension".into()),
        ..Default::default()
    }
    .with_env_idle()
    .unwrap();
    assert_eq!(server.resolved_session_idle(), Duration::from_secs(12 * 60));
    assert!(server.daemon_idle.is_none());
    assert!(server.server_config().unwrap().is_some());
}
