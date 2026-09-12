//! Regression coverage for discovery without local PID visibility and for
//! conservative management of missing, blocked and inconsistent endpoints.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use bsk::daemon::info::{DaemonInfo, write_to_path};
use bsk::daemon::lockfile::pid_alive;
use bsk_protocol::{Frame, Method, RequestFrame, ResponseBody, ResponseFrame};
use fs2::FileExt;
use tempfile::TempDir;

const FOREIGN_PID: u32 = 0x3fff_fffe;

fn command(home: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
    cmd.args(args)
        .env("BSK_HOME", home)
        .env("HOME", home)
        .env_remove("BSK_AUTO_START")
        .env("BSK_AUTO_UPDATE", "off")
        .env("BSK_BROWSER_WAIT_MS", "0")
        .env("BSK_DOCTOR_BROWSER_WAIT_MS", "0")
        .env("RUST_LOG", "warn");
    cmd
}

fn run(home: &Path, args: &[&str]) -> Output {
    command(home, args).output().unwrap()
}

fn success(out: &Output) {
    assert!(
        out.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

struct MockDaemon {
    temp: TempDir,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl MockDaemon {
    fn new(
        pid: u32,
        reply: impl Fn(usize, &DaemonInfo) -> Option<ResponseBody> + Send + Sync + 'static,
    ) -> Self {
        Self::with_requests(pid, move |n, info, _| reply(n, info))
    }

    fn with_requests(
        pid: u32,
        reply: impl Fn(usize, &DaemonInfo, &RequestFrame) -> Option<ResponseBody>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        let temp = TempDir::new().unwrap();
        let sock = temp.path().join("daemon.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        listener.set_nonblocking(true).unwrap();
        let info = DaemonInfo::now(pid, sock, 12345, env!("CARGO_PKG_VERSION"));
        write_to_path(&info, &temp.path().join("daemon.json")).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let served_info = info.clone();
        let reply = Arc::new(reply);
        let requests = Arc::new(AtomicUsize::new(0));
        let thread = std::thread::spawn(move || {
            let mut clients = Vec::new();
            while !done.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let reply = reply.clone();
                        let info = served_info.clone();
                        let done = done.clone();
                        let requests = requests.clone();
                        clients.push(std::thread::spawn(move || {
                            stream
                                .set_read_timeout(Some(Duration::from_millis(50)))
                                .unwrap();
                            let mut reader = BufReader::new(stream);
                            while !done.load(Ordering::Relaxed) {
                                let mut line = String::new();
                                match reader.read_line(&mut line) {
                                    Ok(0) => break,
                                    Ok(_) => {}
                                    Err(err)
                                        if matches!(
                                            err.kind(),
                                            std::io::ErrorKind::WouldBlock
                                                | std::io::ErrorKind::TimedOut
                                        ) =>
                                    {
                                        continue;
                                    }
                                    Err(_) => break,
                                }
                                let Frame::Request(request) = serde_json::from_str(&line).unwrap()
                                else {
                                    panic!("expected request")
                                };
                                let n = requests.fetch_add(1, Ordering::SeqCst);
                                if let Some(body) = reply(n, &info, &request) {
                                    let frame = Frame::Response(ResponseFrame {
                                        id: request.id,
                                        body,
                                    });
                                    if writeln!(
                                        reader.get_mut(),
                                        "{}",
                                        serde_json::to_string(&frame).unwrap()
                                    )
                                    .is_err()
                                    {
                                        break;
                                    }
                                }
                            }
                        }));
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(err) => panic!("accept: {err}"),
                }
            }
            for client in clients {
                client.join().unwrap();
            }
        });
        Self {
            temp,
            stop,
            thread: Some(thread),
        }
    }

    fn home(&self) -> &Path {
        self.temp.path()
    }
    fn metadata(&self) -> Vec<u8> {
        std::fs::read(self.home().join("daemon.json")).unwrap()
    }
}

impl Drop for MockDaemon {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}

fn status(info: &DaemonInfo) -> ResponseBody {
    ResponseBody::Ok(serde_json::json!({
        "pid": info.pid, "daemon_version": info.version, "protocol_version": "1.1",
        "uptime_secs": 1, "ws_port": info.ws_port, "sock_path": info.sock_path,
        "browsers": [], "sessions": []
    }))
}

#[test]
fn only_unsupported_operations_reject_a_legacy_daemon() {
    let daemon = MockDaemon::new(FOREIGN_PID, |_, info| Some(status(info)));
    let original = daemon.metadata();
    for (args, required_protocol) in [
        (
            vec![
                "tab",
                "borrow",
                "7",
                "--session",
                "abcd",
                "--timeout",
                "120s",
                "--json",
            ],
            "1.2",
        ),
        (
            vec![
                "request-help",
                "--session",
                "abcd",
                "--prompt",
                "Continue",
                "--json",
            ],
            "1.3",
        ),
    ] {
        let result = command(daemon.home(), &args)
            .env("BSK_REQUEST_HELP", "off")
            .env("BSK_AUTO_START", "0")
            .output()
            .unwrap();
        assert!(!result.status.success());
        let error: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(error["code"], "unsupported", "{error}");
        assert!(
            error["message"]
                .as_str()
                .unwrap()
                .contains(&format!("protocol {required_protocol}"))
        );
        assert_eq!(error["data"]["component"], "daemon");
        assert!(error.get("outcome").is_none());
        assert_eq!(daemon.metadata(), original);
    }
}

#[test]
fn sessions_and_default_borrowing_work_with_legacy_daemons_without_forwarding_overrides() {
    for protocol in ["1.0", "1.1", "1.2"] {
        let daemon = MockDaemon::with_requests(FOREIGN_PID, move |_, info, request| {
            Some(match request.method {
                Method::SystemStatus => {
                    let ResponseBody::Ok(mut value) = status(info) else {
                        unreachable!()
                    };
                    value["protocol_version"] = protocol.into();
                    ResponseBody::Ok(value)
                }
                Method::SessionStart => {
                    assert!(request.params.as_ref().unwrap().get("unattended").is_none());
                    ResponseBody::Ok(serde_json::json!({
                        "session_id": "abcd", "browser_instance_id": "legacy", "agent_window_id": 1
                    }))
                }
                Method::ToolTabBorrow => {
                    let params = request.params.as_ref().unwrap();
                    assert!(params.get("confirm").is_none());
                    if params.get("confirmation_timeout_ms").is_some() {
                        assert_eq!(protocol, "1.2");
                        assert_eq!(params["confirmation_timeout_ms"], 120_000);
                    }
                    ResponseBody::Ok(serde_json::json!({
                        "tab_id": 7, "original_window_id": 2, "original_index": 0, "agent_window_id": 1
                    }))
                }
                Method::SessionStop => ResponseBody::Ok(serde_json::json!({"stopped": ["abcd"]})),
                _ => panic!("unexpected request: {:?}", request.method),
            })
        });
        let metadata = daemon.metadata();
        success(&run(
            daemon.home(),
            &["session", "start", "--unattended", "--json"],
        ));
        success(&run(
            daemon.home(),
            &[
                "tab",
                "borrow",
                "7",
                "--session",
                "abcd",
                "--no-confirm",
                "--json",
            ],
        ));
        let custom = run(
            daemon.home(),
            &[
                "tab",
                "borrow",
                "7",
                "--session",
                "abcd",
                "--timeout",
                "120s",
                "--json",
            ],
        );
        assert_eq!(custom.status.success(), protocol == "1.2");
        let help = command(
            daemon.home(),
            &[
                "request-help",
                "--session",
                "abcd",
                "--prompt",
                "Continue",
                "--json",
            ],
        )
        .env("BSK_REQUEST_HELP", "off")
        .output()
        .unwrap();
        assert!(!help.status.success());
        let value: serde_json::Value = serde_json::from_slice(&help.stdout).unwrap();
        assert_eq!(value["code"], "unsupported");
        assert!(value.get("outcome").is_none());
        // A feature error must neither shut down nor replace the daemon.
        success(&run(daemon.home(), &["session", "stop", "abcd", "--json"]));
        success(&run(daemon.home(), &["status", "--json"]));
        assert_eq!(metadata, daemon.metadata());
    }
}

#[test]
fn discovery_accepts_ipc_without_local_pid_but_management_refuses_it() {
    assert!(!pid_alive(FOREIGN_PID));
    let daemon = MockDaemon::new(FOREIGN_PID, |_, info| Some(status(info)));
    let original = daemon.metadata();
    success(&run(daemon.home(), &["--json", "status"]));
    success(&run(daemon.home(), &["daemon", "start"]));
    for auto_start in ["0", "1"] {
        success(
            &command(daemon.home(), &["--json", "status"])
                .env("BSK_AUTO_START", auto_start)
                .output()
                .unwrap(),
        );
        let doctor = command(daemon.home(), &["--json", "doctor"])
            .env("BSK_AUTO_START", auto_start)
            .output()
            .unwrap();
        let checks: Vec<serde_json::Value> = serde_json::from_slice(&doctor.stdout).unwrap();
        assert_eq!(
            checks
                .iter()
                .find(|c| c["name"] == "daemon running")
                .unwrap()["status"],
            "ok"
        );
        let identity = checks
            .iter()
            .find(|c| c["name"] == "daemon local process identity")
            .unwrap();
        assert_eq!(identity["status"], "warn");
        assert_eq!(identity["ok"], true);
        assert!(
            identity["hint"]
                .as_str()
                .unwrap()
                .contains("owning host environment")
        );
    }
    for args in [["daemon", "stop"], ["daemon", "restart"]] {
        let out = run(daemon.home(), &args);
        assert!(!out.status.success());
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("cannot verify local daemon process")
        );
        assert_eq!(daemon.metadata(), original);
    }
    assert!(
        !daemon.home().join("daemon.lock").exists(),
        "discovery must not attempt startup or cleanup"
    );
}

#[test]
fn file_and_rpc_agreement_cannot_authorize_signaling_an_unrelated_pid() {
    let mut decoy = ManagedChild(Command::new("sleep").arg("30").spawn().unwrap());
    let daemon = MockDaemon::new(decoy.0.id(), |_, info| Some(status(info)));
    let original = daemon.metadata();
    let out = run(daemon.home(), &["daemon", "stop"]);
    assert!(!out.status.success());
    assert!(decoy.0.try_wait().unwrap().is_none());
    assert_eq!(daemon.metadata(), original);
}

#[test]
fn unresponsive_endpoint_is_bounded_and_does_not_spawn_or_clean_up() {
    let daemon = MockDaemon::new(FOREIGN_PID, |_, _| None);
    let original = daemon.metadata();
    let start = Instant::now();
    for auto_start in ["0", "1"] {
        let out = command(daemon.home(), &["--json", "status"])
            .env("BSK_AUTO_START", auto_start)
            .output()
            .unwrap();
        assert!(!out.status.success());
        let error = String::from_utf8_lossy(&out.stdout);
        assert!(error.contains("timed out"), "{error}");
        assert!(
            !error.contains("automatic daemon startup is disabled"),
            "{error}"
        );
    }
    assert!(start.elapsed() < Duration::from_secs(3));
    assert_eq!(daemon.metadata(), original);
    assert!(!daemon.home().join("daemon.lock").exists());
}

#[test]
fn invalid_and_mismatched_responses_do_not_trigger_startup() {
    for mismatch in [false, true] {
        let daemon = MockDaemon::new(FOREIGN_PID, move |_, info| {
            let mut reply = if mismatch {
                status(info)
            } else {
                ResponseBody::Ok(serde_json::json!({"unexpected": true}))
            };
            if mismatch && let ResponseBody::Ok(ref mut value) = reply {
                value["pid"] = serde_json::json!(FOREIGN_PID - 1);
            }
            Some(reply)
        });
        let original = daemon.metadata();
        let out = run(daemon.home(), &["daemon", "start"]);
        assert!(!out.status.success());
        assert_eq!(daemon.metadata(), original);
        assert!(!daemon.home().join("daemon.lock").exists());
    }
}

#[test]
fn discovery_rereads_metadata_when_an_instance_changes_during_probe() {
    let daemon = MockDaemon::new(FOREIGN_PID, |_, info| {
        let mut replacement = info.clone();
        replacement.pid -= 1;
        write_to_path(
            &replacement,
            &info.sock_path.parent().unwrap().join("daemon.json"),
        )
        .unwrap();
        Some(status(&replacement))
    });
    let out = run(daemon.home(), &["--json", "status"]);
    success(&out);
    let value: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["pid"], FOREIGN_PID - 1);
    assert!(!daemon.home().join("daemon.lock").exists());
}

#[test]
fn stopping_without_discovery_does_not_create_runtime_files() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("absent");
    success(&run(&home, &["daemon", "stop"]));
    assert!(!home.exists());
}

#[test]
fn held_lock_protects_metadata_even_if_pid_and_endpoint_are_absent() {
    let temp = TempDir::new().unwrap();
    let info = DaemonInfo::now(FOREIGN_PID, temp.path().join("missing.sock"), 0, "0.2.1");
    let path = temp.path().join("daemon.json");
    write_to_path(&info, &path).unwrap();
    let original = std::fs::read(&path).unwrap();
    let lock = std::fs::File::create(temp.path().join("daemon.lock")).unwrap();
    lock.try_lock_exclusive().unwrap();
    let out = run(temp.path(), &["daemon", "stop"]);
    assert!(!out.status.success());
    assert_eq!(std::fs::read(&path).unwrap(), original);
    // Model a descriptor inherited by a concurrently spawned child before exec.
    let inherited_lock = lock.try_clone().unwrap();
    // Closing one descriptor does not release a flock while another survives.
    // Match DaemonLock's explicit unlock instead of depending on child timing.
    fs2::FileExt::unlock(&lock).unwrap();
    drop(lock);
    success(&run(temp.path(), &["daemon", "stop"]));
    assert!(!path.exists());
    assert!(temp.path().join("daemon.lock").exists());
    drop(inherited_lock);
}

#[test]
fn ipc_permission_denial_preserves_metadata_and_does_not_start_a_daemon() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping permission denial check for root");
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let temp = TempDir::new().unwrap();
    let blocked = temp.path().join("blocked");
    std::fs::create_dir(&blocked).unwrap();
    let sock = blocked.join("daemon.sock");
    let _listener = UnixListener::bind(&sock).unwrap();
    let info = DaemonInfo::now(FOREIGN_PID, sock, 0, "0.2.1");
    let path = temp.path().join("daemon.json");
    write_to_path(&info, &path).unwrap();
    let original = std::fs::read(&path).unwrap();
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o0)).unwrap();
    let out = run(temp.path(), &["--json", "status"]);
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("Permission denied"));
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert!(!temp.path().join("daemon.lock").exists());
}

#[test]
fn direct_client_uses_the_same_discovery_rules() {
    // Run the client in a child so BSK_HOME is fixed before any test threads
    // start, without mutating the parallel test runner's environment.
    if std::env::var_os("BSK_DISCOVERY_TEST_CHILD").is_none() {
        let daemon = MockDaemon::new(FOREIGN_PID, |_, info| Some(status(info)));
        let out = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "direct_client_uses_the_same_discovery_rules"])
            .env("BSK_HOME", daemon.home())
            .env("BSK_DISCOVERY_TEST_CHILD", "1")
            .output()
            .unwrap();
        success(&out);
        return;
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let mut client = bsk::ipc_client::Client::connect().await.unwrap();
        let result = client
            .call::<_, bsk_protocol::StatusResult>(
                bsk_protocol::Method::SystemStatus,
                &bsk_protocol::StatusParams::default(),
                Duration::from_secs(1),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.pid, FOREIGN_PID);
    });
}

#[cfg(target_os = "linux")]
#[test]
fn host_daemon_is_usable_but_not_signalable_from_a_child_pid_namespace() {
    // Some CI hosts disable unprivileged user namespaces. A skip is explicit;
    // deterministic IPC/PID regressions above still run on every Unix host.
    let available = Command::new("unshare")
        .args(["--user", "--map-root-user", "--pid", "--fork", "true"])
        .output();
    if !available.as_ref().is_ok_and(|out| out.status.success()) {
        eprintln!(
            "skipping real PID namespace test: unprivileged unshare unavailable: {available:?}"
        );
        return;
    }
    let temp = TempDir::new().unwrap();
    let mut daemon = ManagedChild(
        command(
            temp.path(),
            &["daemon", "start", "--foreground", "--port", "0"],
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap(),
    );
    let original = wait_ready(temp.path(), &mut daemon);
    let inside = |args: &[&str]| {
        Command::new("unshare")
            .args(["--user", "--map-root-user", "--pid", "--fork"])
            .arg(env!("CARGO_BIN_EXE_bsk"))
            .args(args)
            .env("BSK_HOME", temp.path())
            .env("HOME", temp.path())
            .env("BSK_AUTO_START", "0")
            .env("BSK_AUTO_UPDATE", "off")
            .env("BSK_BROWSER_WAIT_MS", "0")
            .env("BSK_DOCTOR_BROWSER_WAIT_MS", "0")
            .output()
            .unwrap()
    };
    success(&inside(&["--json", "status"]));
    success(&inside(&["daemon", "start"]));
    let doctor = inside(&["--json", "doctor"]);
    let checks: Vec<serde_json::Value> = serde_json::from_slice(&doctor.stdout).unwrap();
    let identity = checks
        .iter()
        .find(|c| c["name"] == "daemon local process identity")
        .unwrap();
    assert_eq!(identity["status"], "warn");
    assert_eq!(identity["ok"], true);
    let out = inside(&["daemon", "stop"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("cannot verify local daemon process"));
    assert!(daemon.0.try_wait().unwrap().is_none());
    let after: DaemonInfo =
        serde_json::from_slice(&std::fs::read(temp.path().join("daemon.json")).unwrap()).unwrap();
    assert_eq!(after, original);
    success(&run(temp.path(), &["daemon", "stop"]));
    let stopped = inside(&["--json", "status"]);
    assert!(!stopped.status.success());
    assert!(String::from_utf8_lossy(&stopped.stdout).contains("BSK_AUTO_START=0"));
    assert!(!temp.path().join("daemon.json").exists());
}

struct ManagedChild(Child);
impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn wait_ready(home: &Path, child: &mut ManagedChild) -> DaemonInfo {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "daemon exited before ready"
        );
        if let Ok(bytes) = std::fs::read(home.join("daemon.json"))
            && let Ok(info) = serde_json::from_slice(&bytes)
        {
            return info;
        }
        assert!(Instant::now() < deadline, "daemon not ready");
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn crash_recovery_reuses_lock_file_and_concurrent_starts_share_one_daemon() {
    let temp = TempDir::new().unwrap();
    let mut first = ManagedChild(
        command(
            temp.path(),
            &["daemon", "start", "--foreground", "--port", "0"],
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap(),
    );
    let old = wait_ready(temp.path(), &mut first);
    let lock_inode = std::fs::metadata(temp.path().join("daemon.lock"))
        .unwrap()
        .ino();
    first.0.kill().unwrap();
    first.0.wait().unwrap();
    assert!(
        old.sock_path.exists(),
        "forced exit should leave its socket"
    );
    let port = old.ws_port.to_string();
    let mut starts: Vec<_> = (0..4)
        .map(|_| {
            command(temp.path(), &["daemon", "start", "--port", &port])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for start in starts.drain(..) {
        success(&start.wait_with_output().unwrap());
    }
    let current: DaemonInfo =
        serde_json::from_slice(&std::fs::read(temp.path().join("daemon.json")).unwrap()).unwrap();
    assert_ne!(current.pid, old.pid);
    assert_eq!(
        std::fs::metadata(temp.path().join("daemon.lock"))
            .unwrap()
            .ino(),
        lock_inode
    );
    success(&run(temp.path(), &["daemon", "restart", "--port", &port]));
    let restarted: DaemonInfo =
        serde_json::from_slice(&std::fs::read(temp.path().join("daemon.json")).unwrap()).unwrap();
    assert_ne!(restarted.pid, current.pid);
    assert_eq!(restarted.ws_port, old.ws_port);
    assert_eq!(
        std::fs::metadata(temp.path().join("daemon.lock"))
            .unwrap()
            .ino(),
        lock_inode
    );
    success(&run(temp.path(), &["daemon", "stop"]));
    assert!(!temp.path().join("daemon.json").exists());
}
