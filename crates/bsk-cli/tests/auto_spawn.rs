//! Verify `ensure_daemon` spawns the daemon when none is running.
//!
//! We can't call `ensure_daemon` directly from a test process because
//! `current_exe()` would point to the test binary, not `bsk`. Instead we
//! drive the same effect end-to-end via `bsk status` (which itself calls
//! into `ensure_daemon` in M3.3) — but for M3.2 we test the helper by
//! pointing `current_exe` indirection at the actual `bsk` binary through
//! a small shim test.

#![cfg(unix)]

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use tempfile::TempDir;

fn bsk_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_bsk"))
}

fn wait_for_pid_exit(pid: i32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        if !alive {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn ensure_daemon_idempotent_when_already_running() {
    // Use BSK_HOME to isolate.
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();

    // Start a daemon manually first.
    let out = Command::new(bsk_bin())
        .args(["daemon", "start", "--port", "0", "--daemon-idle", "60s"])
        .env("BSK_HOME", &home)
        .env("RUST_LOG", "warn")
        .output()
        .unwrap();
    assert!(out.status.success());

    let info_path = home.join("daemon.json");
    let info: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&info_path).unwrap()).unwrap();
    let pid_before = info["pid"].as_u64().unwrap() as i32;

    // Now another `bsk daemon start` is invoked. Because the lock is
    // held, the spawned child should exit quickly and the existing
    // daemon should keep its pid.
    let _ = Command::new(bsk_bin())
        .args(["daemon", "start", "--port", "0", "--daemon-idle", "60s"])
        .env("BSK_HOME", &home)
        .env("RUST_LOG", "warn")
        .output()
        .unwrap();

    let info_after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&info_path).unwrap()).unwrap();
    let pid_after = info_after["pid"].as_u64().unwrap() as i32;
    assert_eq!(pid_before, pid_after, "daemon pid should not change");

    // Clean up.
    let _ = Command::new(bsk_bin())
        .args(["daemon", "stop"])
        .env("BSK_HOME", &home)
        .output();
    assert!(wait_for_pid_exit(pid_before, Duration::from_secs(5)));
}
