//! Exercise automatic daemon startup and reuse through the real `bsk status`
//! command, so ensure_daemon's current_exe() points to the CLI binary.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use tempfile::TempDir;

fn bsk_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_bsk"))
}

fn command(home: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(bsk_bin());
    cmd.args(args)
        .env("BSK_HOME", home)
        .env("BSK_AUTO_UPDATE", "off")
        .env("BSK_BROWSER_WAIT_MS", "0")
        .env("RUST_LOG", "warn");
    cmd
}

struct StopOnDrop(PathBuf);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        let _ = command(&self.0, &["daemon", "stop"]).output();
    }
}

#[test]
fn status_auto_spawns_from_an_empty_home() {
    // BSK_HOME isolates files, not the production default WS port. Exercise
    // the real default on clean CI hosts; never stop a developer's daemon.
    match std::net::TcpListener::bind(("127.0.0.1", bsk::cli::daemon::DEFAULT_WS_PORT)) {
        Ok(port) => drop(port),
        Err(err) if err.kind() == std::io::ErrorKind::AddrInUse => {
            assert!(
                std::env::var_os("CI").is_none(),
                "CI must provide a free default WS port for the auto-spawn regression: {err}"
            );
            eprintln!("skipping default-port auto-spawn test: port 52800 is already in use");
            return;
        }
        Err(err) => panic!("check default WS port: {err}"),
    }
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    let _cleanup = StopOnDrop(home.clone());
    assert!(!home.exists());

    let out = command(&home, &["--json", "status"]).output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let reported: bsk_protocol::StatusResult = serde_json::from_slice(&out.stdout).unwrap();
    let info: bsk::daemon::info::DaemonInfo =
        serde_json::from_slice(&std::fs::read(home.join("daemon.json")).unwrap()).unwrap();
    assert_eq!(reported.pid, info.pid);
    assert_eq!(reported.sock_path, info.sock_path);
    assert!(info.pid > 0);
    assert!(home.join("daemon.lock").exists());

    // A second status must use the same successfully started instance.
    let again = command(&home, &["--json", "status"]).output().unwrap();
    assert!(again.status.success());
    let reused: bsk_protocol::StatusResult = serde_json::from_slice(&again.stdout).unwrap();
    assert_eq!(reused.pid, info.pid);
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
    let _cleanup = StopOnDrop(home.clone());
    let out = command(
        &home,
        &["daemon", "start", "--port", "0", "--daemon-idle", "60s"],
    )
    .output()
    .unwrap();
    assert!(out.status.success());

    let info_path = home.join("daemon.json");
    let info: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&info_path).unwrap()).unwrap();
    let pid_before = info["pid"].as_u64().unwrap() as i32;

    // Exercise ensure_daemon through status, not a second explicit start.
    let status = command(&home, &["--json", "status"]).output().unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let reported: bsk_protocol::StatusResult = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(reported.pid, pid_before as u32);

    let info_after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&info_path).unwrap()).unwrap();
    let pid_after = info_after["pid"].as_u64().unwrap() as i32;
    assert_eq!(pid_before, pid_after, "daemon pid should not change");

    // Clean up.
    let _ = command(&home, &["daemon", "stop"]).output();
    assert!(wait_for_pid_exit(pid_before, Duration::from_secs(5)));
}
