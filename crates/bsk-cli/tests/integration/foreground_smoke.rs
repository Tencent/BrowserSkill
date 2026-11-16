//! Smoke-test the foreground daemon: spawn the bin, wait for the heartbeat,
//! send SIGTERM (Unix) / CTRL_BREAK (Windows), and verify a clean exit.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tempfile::TempDir;

#[test]
fn foreground_daemon_starts_and_stops() {
    let tmp = TempDir::new().unwrap();
    let home = tmp.path().join("bsk");
    std::fs::create_dir_all(&home).unwrap();
    let mut child = Command::new(crate::support::bsk_bin())
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
        // Shutdown waits for blocking update work, so keep the startup check local.
        .env("BSK_UPDATE_MANIFEST_URL", "http://127.0.0.1:1/disabled")
        .env("NO_PROXY", "127.0.0.1")
        .env("RUST_LOG", "info")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn bsk daemon start --foreground");

    let info_path = home.join("daemon.json");
    let boot_deadline = Instant::now() + Duration::from_secs(5);
    while !info_path.exists() {
        assert!(
            child.try_wait().expect("try_wait").is_none(),
            "daemon exited before publishing daemon.json"
        );
        assert!(
            Instant::now() < boot_deadline,
            "daemon did not publish daemon.json within 5s"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    // Wait until the daemon answers IPC so its Tokio select! shutdown signal
    // handlers are already installed before we deliver SIGTERM.
    loop {
        let ready = Command::new(crate::support::bsk_bin())
            .args(["status", "--json"])
            .env("BSK_HOME", &home)
            .env("BSK_BROWSER_WAIT_MS", "0")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("probe bsk status");
        if ready.success() {
            break;
        }
        assert!(
            child.try_wait().expect("try_wait").is_none(),
            "daemon exited before answering status"
        );
        assert!(
            Instant::now() < boot_deadline,
            "daemon did not answer status within 5s"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
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
