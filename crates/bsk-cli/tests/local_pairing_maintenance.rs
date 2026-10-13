//! Lifecycle-lock races are tested with real CLI and daemon processes.
use bsk::daemon::local_auth::{LocalAuthMode, read_mode, store::PairingStore, write_mode};
use fs2::FileExt;
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn command(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
    cmd.env("BSK_HOME", home)
        .env("BSK_AUTO_UPDATE", "off")
        .env_remove("BSK_DAEMONIZED")
        .env_remove("BSK_DAEMON_REPLACES_PID")
        .stdin(Stdio::null());
    cmd
}
struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn output(home: &Path, args: &[&str]) -> String {
    let result = command(home).args(args).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}

#[test]
fn l11a_offline_revoke_and_startup_use_one_lifecycle_lock() {
    let home = tempfile::tempdir().unwrap();
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(home.path().join("daemon.lock"))
        .unwrap();
    lock.lock_exclusive().unwrap();
    let store = PairingStore::open(home.path()).unwrap();
    store.pair(52800, None).unwrap();
    let id = store.devices()[0].device_id.clone();
    let log_path = home.path().join("test-daemon.log");
    let mut daemon = Daemon(
        command(home.path())
            .args(["daemon", "start", "--foreground", "--port", "0"])
            .stdout(Stdio::null())
            .stderr(fs::File::create(&log_path).unwrap())
            .spawn()
            .unwrap(),
    );
    // A concurrent maintenance process cannot edit the file while we own the
    // lifecycle lock. After the daemon starts it must complete over IPC.
    let maintenance = command(home.path())
        .args(["daemon", "pair"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::thread::sleep(Duration::from_millis(250));
    assert!(daemon.0.try_wait().unwrap().is_none());
    store.revoke(Some(&id)).unwrap();
    FileExt::unlock(&lock).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !home.path().join("daemon.json").exists() {
        assert!(
            Instant::now() < deadline,
            "daemon did not retry its lifecycle lock"
        );
        assert!(
            daemon.0.try_wait().unwrap().is_none(),
            "daemon exited during startup: {}",
            fs::read_to_string(&log_path).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let pair = maintenance.wait_with_output().unwrap();
    assert!(
        pair.status.success(),
        "{}",
        String::from_utf8_lossy(&pair.stderr)
    );
    let info: serde_json::Value =
        serde_json::from_slice(&fs::read(home.path().join("daemon.json")).unwrap()).unwrap();
    assert!(
        String::from_utf8(pair.stdout)
            .unwrap()
            .starts_with(&format!("ws://127.0.0.1:{}/#", info["ws_port"]))
    );
    let devices: serde_json::Value =
        serde_json::from_str(&output(home.path(), &["daemon", "devices"])).unwrap();
    assert_eq!(
        devices
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["device_id"] == id)
            .unwrap()["status"],
        "revoked"
    );
    output(home.path(), &["daemon", "trust-local", "on"]);
    assert_eq!(read_mode(home.path()).unwrap(), LocalAuthMode::TrustLocal);
    output(home.path(), &["daemon", "trust-local", "off"]);
    assert_eq!(read_mode(home.path()).unwrap(), LocalAuthMode::Required);
}

#[test]
fn l16_local_keys_are_not_remote_bearer_grants() {
    let home = tempfile::tempdir().unwrap();
    let link = output(home.path(), &["daemon", "pair"]);
    let key = link.trim().rsplit('.').next().unwrap();
    let remote = bsk::daemon::remote::authorization::AuthorizationStore::at_home(home.path());
    assert!(remote.authenticate(key).is_err());
    assert!(bsk_protocol::local_auth::Probe::parse(&format!("{{\"id\":\"x\",\"method\":\"system.ping\",\"params\":{{\"local_auth\":{{\"token\":\"{key}\"}}}}}}")).is_err());
    assert!(!output(home.path(), &["daemon", "devices"]).contains(key));
}

#[test]
fn settings_preserve_unrelated_fields_and_absence_uses_release_default() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(read_mode(home.path()).unwrap(), LocalAuthMode::Required);
    fs::write(
        home.path().join("settings.json"),
        br#"{"custom":{"enabled":true}}"#,
    )
    .unwrap();
    write_mode(home.path(), LocalAuthMode::TrustLocal).unwrap();
    let settings: serde_json::Value =
        serde_json::from_slice(&fs::read(home.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["custom"]["enabled"], true);
    assert_eq!(read_mode(home.path()).unwrap(), LocalAuthMode::TrustLocal);
}
