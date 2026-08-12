//! Spawn `bsk daemon start` (default detached mode), wait for daemon.json,
//! then `bsk daemon stop` and verify the daemon is gone.

#![cfg(unix)]

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tempfile::TempDir;

fn bsk_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_bsk"))
}

fn run(home: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new(bsk_bin())
        .env("BSK_HOME", home)
        .env("RUST_LOG", "warn")
        .args(args)
        .output()
        .expect("spawn bsk command")
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
fn detached_start_and_stop_round_trip() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();

    // Use port 0 so concurrent test runs (or any existing daemon on
    // 52800) don't collide with us; the daemon writes the chosen port
    // back into daemon.json.
    let out = run(
        &home,
        &["daemon", "start", "--port", "0", "--daemon-idle", "60s"],
    );
    assert!(
        out.status.success(),
        "daemon start failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // Daemon.json should now exist with a live pid.
    let info_path = home.join("daemon.json");
    assert!(info_path.exists(), "daemon.json should be written");
    let info: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&info_path).unwrap()).unwrap();
    let pid = info["pid"].as_u64().expect("pid number") as i32;
    assert!(pid > 0);

    // Stop the daemon.
    let out = run(&home, &["daemon", "stop"]);
    assert!(
        out.status.success(),
        "daemon stop failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    assert!(
        wait_for_pid_exit(pid, Duration::from_secs(5)),
        "daemon pid {pid} should disappear after stop"
    );
    assert!(
        !home.join("daemon.json").exists(),
        "daemon.json should be cleaned up after stop"
    );
}

#[test]
fn stop_when_no_daemon_running_is_noop() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();
    let out = run(&home, &["daemon", "stop"]);
    assert!(out.status.success(), "stop should succeed when no daemon");
}

#[test]
fn stop_refuses_live_pid_that_is_not_verified_daemon() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(home.join("run")).unwrap();

    let mut child = Command::new("sleep")
        .arg("30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn controlled non-daemon child");

    let info = serde_json::json!({
        "pid": child.id(),
        "sock_path": home.join("run").join("not-a-daemon.sock"),
        "ws_port": 0,
        "version": env!("CARGO_PKG_VERSION"),
        "started_at_epoch_secs": 1
    });
    std::fs::write(
        home.join("daemon.json"),
        serde_json::to_vec_pretty(&info).unwrap(),
    )
    .unwrap();

    let out = run(&home, &["daemon", "stop"]);
    assert!(
        !out.status.success(),
        "stop should refuse unverified daemon.json"
    );
    assert!(
        child.try_wait().unwrap().is_none(),
        "non-daemon child must not be terminated"
    );

    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn start_with_conflicting_port_refuses_existing_daemon() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();

    let out = run(
        &home,
        &["daemon", "start", "--port", "0", "--daemon-idle", "60s"],
    );
    assert!(
        out.status.success(),
        "daemon start failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let info_path = home.join("daemon.json");
    let info: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&info_path).unwrap()).unwrap();
    let pid = info["pid"].as_u64().expect("pid number") as i32;
    let existing_port = info["ws_port"].as_u64().expect("ws_port") as u16;
    let conflicting_port = if existing_port == 52801 { 52802 } else { 52801 };
    let conflicting_port = conflicting_port.to_string();

    let out = run(&home, &["daemon", "start", "--port", &conflicting_port]);
    assert!(
        !out.status.success(),
        "start should fail when an existing daemon has different config"
    );
    assert!(
        unsafe { libc::kill(pid, 0) } == 0,
        "existing daemon should remain alive"
    );

    let _ = run(&home, &["daemon", "stop"]);
    assert!(wait_for_pid_exit(pid, Duration::from_secs(5)));
}

#[test]
fn restart_propagates_stop_error_and_does_not_run_start() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(home.join("run")).unwrap();

    let mut child = Command::new("sleep")
        .arg("30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn controlled non-daemon child");

    let info = serde_json::json!({
        "pid": child.id(),
        "sock_path": home.join("run").join("not-a-daemon.sock"),
        "ws_port": 0,
        "version": env!("CARGO_PKG_VERSION"),
        "started_at_epoch_secs": 1
    });
    std::fs::write(
        home.join("daemon.json"),
        serde_json::to_vec_pretty(&info).unwrap(),
    )
    .unwrap();

    let out = run(&home, &["daemon", "restart"]);
    assert!(
        !out.status.success(),
        "restart should fail when stop phase fails"
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("restart failed during stop phase")
            || stderr.contains("restart failed during stop phase".to_lowercase().as_str()),
        "restart error should mention stop phase: {stderr}"
    );

    // The decoy must still be alive — start should never have run.
    assert!(
        child.try_wait().unwrap().is_none(),
        "decoy child must not be terminated"
    );

    // daemon.json should still point to the decoy (start did not run);
    // also confirm no new daemon was actually started by checking that
    // the recorded pid is still the decoy.
    let after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(home.join("daemon.json")).unwrap()).unwrap();
    assert_eq!(
        after["pid"].as_u64().unwrap(),
        child.id() as u64,
        "daemon.json should be untouched after failed restart"
    );

    let _ = child.kill();
    let _ = child.wait();
}
