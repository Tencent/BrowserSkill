//! Verify the daemon self-exits after `--daemon-idle` elapses.

#![cfg(unix)]

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use tempfile::TempDir;
use tokio::net::UnixStream;

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
fn daemon_self_exits_after_idle_timeout() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();

    let out = Command::new(bsk_bin())
        .env("BSK_HOME", &home)
        .env("RUST_LOG", "warn")
        .args(["daemon", "start", "--port", "0", "--daemon-idle", "2s"])
        .output()
        .expect("spawn bsk daemon start");
    assert!(
        out.status.success(),
        "daemon start failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let info_path = home.join("daemon.json");
    let info: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&info_path).unwrap()).unwrap();
    let pid = info["pid"].as_u64().expect("pid number") as i32;

    assert!(
        wait_for_pid_exit(pid, Duration::from_secs(6)),
        "daemon should self-exit within 6s of starting with --daemon-idle=2s"
    );
    // daemon.json should be cleaned up on graceful shutdown.
    assert!(
        !info_path.exists(),
        "daemon.json should be removed after idle exit"
    );
}

#[test]
fn daemon_stays_alive_while_ipc_connection_is_open() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();

    let out = Command::new(bsk_bin())
        .env("BSK_HOME", &home)
        .env("RUST_LOG", "warn")
        .args(["daemon", "start", "--port", "0", "--daemon-idle", "2s"])
        .output()
        .expect("spawn bsk daemon start");
    assert!(
        out.status.success(),
        "daemon start failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let info_path = home.join("daemon.json");
    let info: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&info_path).unwrap()).unwrap();
    let pid = info["pid"].as_u64().expect("pid number") as i32;
    let sock = info["sock_path"].as_str().expect("sock path").to_string();

    let rt = tokio::runtime::Runtime::new().unwrap();
    let stream = rt
        .block_on(UnixStream::connect(sock))
        .expect("connect to daemon IPC");

    std::thread::sleep(Duration::from_secs(3));
    assert!(
        unsafe { libc::kill(pid, 0) } == 0,
        "daemon should stay alive while IPC connection is open"
    );

    drop(stream);
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        unsafe { libc::kill(pid, 0) } == 0,
        "daemon should restart the idle clock when the last IPC connection closes"
    );
    assert!(
        wait_for_pid_exit(pid, Duration::from_secs(6)),
        "daemon should self-exit after the IPC connection closes"
    );
}
