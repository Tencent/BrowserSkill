//! Smoke-test the foreground daemon: spawn the bin, wait for the heartbeat,
//! send SIGTERM (Unix) / CTRL_BREAK (Windows), and verify a clean exit.

#![cfg(unix)]

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tempfile::TempDir;

fn bsk_bin() -> std::path::PathBuf {
    let bin = env!("CARGO_BIN_EXE_bsk");
    std::path::PathBuf::from(bin)
}

#[test]
fn foreground_daemon_starts_and_stops() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();
    let mut child = Command::new(bsk_bin())
        .args([
            "daemon",
            "start",
            "--foreground",
            "--port",
            "0",
            "--daemon-idle",
            "60s",
        ])
        .env("BSK_HOME", &home)
        .env("RUST_LOG", "info")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn bsk daemon start --foreground");

    // Give the process a generous moment to come up and install signal
    // handlers (cargo test on cold caches can stagger spawn significantly).
    std::thread::sleep(Duration::from_millis(1500));
    assert!(
        child.try_wait().expect("try_wait").is_none(),
        "daemon should still be running"
    );

    let pid = child.id() as i32;
    // SAFETY: sending SIGTERM to our own child.
    unsafe {
        let _ = libc::kill(pid, libc::SIGTERM);
    }

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait after SIGTERM") {
            break status;
        }
        if started.elapsed() > Duration::from_secs(5) {
            let _ = child.kill();
            panic!("daemon did not exit within 5s of SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(
        status.success() || status.code() == Some(0),
        "daemon exited with non-success status: {status:?}"
    );
}
