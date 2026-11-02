//! Exercise self-update with a real executable and a local release server.
#![cfg(windows)]

mod release_fixture;

use std::fs;
use std::io::{Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use bsk::daemon::info::DaemonInfo;
use sha2::{Digest, Sha256};

struct ReleaseServer {
    url: String,
    requests: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl ReleaseServer {
    fn new(binary: &[u8]) -> Self {
        let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(
                "bsk.exe",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        archive.write_all(binary).unwrap();
        let archive = archive.finish().unwrap().into_inner();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let manifest = serde_json::to_vec(&serde_json::json!({
            "version": release_fixture::newer_version(),
            "assets": {"windows-x64": {
                "url": format!("{url}/bsk.zip"),
                "sha256": Sha256::digest(&archive).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            }},
        }))
        .unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let requests = Arc::new(AtomicUsize::new(0));
        let worker_requests = Arc::clone(&requests);
        let worker = thread::spawn(move || {
            while !worker_stop.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(err) => panic!("accept release request: {err}"),
                };
                // Windows accept() inherits the listener's nonblocking mode.
                // Keep accept polling for shutdown, but read/write each request
                // in blocking mode with the bounded timeouts below.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let len = stream.read(&mut chunk).unwrap();
                    if len == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..len]);
                }
                let body = if request.starts_with(b"GET /bsk.zip ") {
                    worker_requests.fetch_add(1, Ordering::SeqCst);
                    &archive
                } else {
                    &manifest
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(body).unwrap();
            }
        });
        Self {
            url: format!("{url}/version.json"),
            requests,
            stop,
            worker: Some(worker),
        }
    }
}

impl Drop for ReleaseServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.worker.take().unwrap().join();
    }
}

#[test]
fn release_server_waits_for_delayed_and_fragmented_request_headers() {
    let server = ReleaseServer::new(b"test binary");
    let address = server
        .url
        .strip_prefix("http://")
        .unwrap()
        .strip_suffix("/version.json")
        .unwrap();
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    // Give accept() time to run before any bytes arrive, then split the
    // headers across writes. Both reads must wait rather than return WouldBlock.
    thread::sleep(Duration::from_millis(100));
    stream.write_all(b"GET /version.json HTTP/1.1\r\n").unwrap();
    thread::sleep(Duration::from_millis(100));
    stream.write_all(b"Host: localhost\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
    let (_, body) = response.split_once("\r\n\r\n").unwrap();
    let manifest: serde_json::Value = serde_json::from_str(body).unwrap();
    assert_eq!(manifest["version"], release_fixture::newer_version());
}

struct Fixture {
    _tmp: tempfile::TempDir,
    exe: PathBuf,
    home: PathBuf,
    binary: Vec<u8>,
    server: ReleaseServer,
    daemon: Option<Child>,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("中文 space %PATH% ! & (update)");
        fs::create_dir(&dir).unwrap();
        let exe = dir.join("bsk.exe");
        let home = tmp.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::copy(env!("CARGO_BIN_EXE_bsk"), &exe).unwrap();
        // The same program reporting a newer version, as a release must.
        let binary = release_fixture::newer_bsk(tmp.path());
        let server = ReleaseServer::new(&binary);
        Self {
            _tmp: tmp,
            exe,
            home,
            binary,
            server,
            daemon: None,
        }
    }

    fn command(&self) -> Command {
        let mut cmd = Command::new(&self.exe);
        cmd.env("BSK_HOME", &self.home)
            .env("BSK_UPDATE_MANIFEST_URL", &self.server.url)
            .env("BSK_AUTO_UPDATE", "off")
            .env("RUST_LOG", "info")
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env_remove("BSK_DAEMONIZED")
            .env_remove("BSK_DAEMON_REPLACES_PID")
            .stdin(Stdio::null())
            .creation_flags(0x0800_0000);
        cmd
    }

    fn wait_for(&self, description: &str, mut check: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            if check() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let leftovers = self.leftovers();
        let home_logs: Vec<_> = fs::read_dir(&self.home)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains("log"))
            .map(|entry| {
                (
                    entry.path(),
                    String::from_utf8_lossy(&fs::read(entry.path()).unwrap_or_default())
                        .into_owned(),
                )
            })
            .collect();
        panic!(
            "timed out waiting for {description}; files next to bsk.exe: {leftovers:?}; daemon logs: {home_logs:?}"
        );
    }

    fn info(&self) -> Option<DaemonInfo> {
        serde_json::from_slice(&fs::read(self.home.join("daemon.json")).ok()?).ok()
    }

    fn updated(&self) -> bool {
        // A locked executable may briefly reject reads during replacement.
        fs::read(&self.exe).is_ok_and(|binary| binary == self.binary)
    }

    /// Files next to the executable other than the executable itself and
    /// the update lock, which stays.
    fn leftovers(&self) -> Vec<String> {
        fs::read_dir(self.exe.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != "bsk.exe" && name != ".bsk.exe.update.lock")
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Stop only the daemon belonging to this isolated BSK_HOME. Also reap
        // the foreground process on assertion failures to avoid leaking locks.
        let _ = self.command().args(["daemon", "stop"]).output();
        if let Some(child) = self.daemon.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// A Job that forbids breakaway, like the one a sandboxed agent runs
/// commands in.
struct RestrictiveJob(std::os::windows::io::OwnedHandle);

impl RestrictiveJob {
    fn new() -> Self {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        // SAFETY: no name or inheritable security descriptor; this test owns it.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        assert!(!handle.is_null(), "{}", std::io::Error::last_os_error());
        let job = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        assert_ne!(
            unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            },
            0,
            "{}",
            std::io::Error::last_os_error()
        );
        Self(job)
    }

    fn assign(&self, child: &Child) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        assert_ne!(
            unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) },
            0,
            "{}",
            std::io::Error::last_os_error()
        );
    }
}

/// Runs `bsk --json update --yes` once its parent has put it in a Job, and
/// writes the outcome to `BSK_GATED_OUTPUT`.
#[test]
#[ignore = "subprocess entry point"]
fn gated_update_process() {
    let mut go = String::new();
    std::io::stdin().read_line(&mut go).unwrap();
    let output = Command::new(std::env::var_os("BSK_GATED_EXE").unwrap())
        .args(["--json", "update", "--yes"])
        .stdin(Stdio::null())
        .creation_flags(0x0800_0000)
        .output()
        .unwrap();
    let result = serde_json::json!({
        "code": output.status.code(),
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr),
    });
    fs::write(
        std::env::var_os("BSK_GATED_OUTPUT").unwrap(),
        serde_json::to_vec(&result).unwrap(),
    )
    .unwrap();
}

#[test]
fn update_from_a_restrictive_job_leaves_a_background_daemon_running() {
    let fixture = Fixture::new();
    let port = unused_port();
    let start = fixture
        .command()
        .args(["daemon", "start", "--port", &port.to_string()])
        .output()
        .unwrap();
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    let before = fixture.info().unwrap();
    let job = RestrictiveJob::new();
    let result_path = fixture._tmp.path().join("gated-update.json");

    let mut gated = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "gated_update_process", "--ignored", "--quiet"])
        .env("BSK_GATED_EXE", &fixture.exe)
        .env("BSK_GATED_OUTPUT", &result_path)
        .env("BSK_HOME", &fixture.home)
        .env("BSK_UPDATE_MANIFEST_URL", &fixture.server.url)
        .env("BSK_AUTO_UPDATE", "off")
        .env("RUST_LOG", "info")
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env_remove("BSK_DAEMONIZED")
        .env_remove("BSK_DAEMON_REPLACES_PID")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .unwrap();
    job.assign(&gated);
    gated.stdin.take().unwrap().write_all(b"go\n").unwrap();
    assert!(gated.wait().unwrap().success());

    let result: serde_json::Value =
        serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
    assert_eq!(result["code"], 0, "{result}");
    let report: serde_json::Value =
        serde_json::from_str(result["stdout"].as_str().unwrap()).unwrap();
    assert_eq!(report["daemon"], "left_running", "{report}");
    assert!(
        report["message"]
            .as_str()
            .unwrap()
            .contains("cannot start an independent daemon"),
        "{report}"
    );
    assert!(fixture.updated(), "the release is installed");
    // The daemon it could not have started again keeps serving.
    let after = fixture.info().expect("the daemon keeps serving");
    assert_eq!(after.pid, before.pid);
    assert_eq!(after.ws_port, port);
    let status = fixture
        .command()
        .args(["--json", "status"])
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
}

#[test]
fn manual_update_replaces_the_running_executable_in_place() {
    let fixture = Fixture::new();
    let out = fixture
        .command()
        .args(["--json", "update", "--yes"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(report["status"], "updated");
    assert!(
        fixture.updated(),
        "the new binary must be in place when the command returns"
    );
    assert!(
        fixture.info().is_none(),
        "an update must not start a previously absent daemon"
    );
    assert_eq!(fixture.server.requests.load(Ordering::SeqCst), 1);

    // The CLI ran from the image it moved aside; the next daemon removes it.
    let leftovers = fixture.leftovers();
    assert!(
        leftovers.len() == 1 && leftovers[0].starts_with(".bsk.exe.old-"),
        "{leftovers:?}"
    );
    let start = fixture
        .command()
        .args(["daemon", "start", "--port", &unused_port().to_string()])
        .output()
        .unwrap();
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    fixture.wait_for("leftover cleanup", || fixture.leftovers().is_empty());
}

#[test]
fn automatic_update_exits_old_daemon_and_restarts_on_the_same_port() {
    let mut fixture = Fixture::new();
    let port = unused_port();
    let log = fs::File::create(fixture.home.join("foreground.log")).unwrap();
    let child = fixture
        .command()
        .env("BSK_AUTO_UPDATE", "on")
        // Exercise the environment inherited by a normally detached daemon.
        .env("BSK_DAEMONIZED", "1")
        .args([
            "daemon",
            "start",
            "--port",
            &port.to_string(),
            "--session-idle",
            "1234ms",
            "--daemon-idle",
            "30s",
        ])
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap();
    let old_pid = child.id();
    fixture.daemon = Some(child);
    fixture.wait_for("replacement daemon", || {
        fixture.updated()
            && fixture
                .info()
                .is_some_and(|info| info.pid != old_pid && info.ws_port == port)
    });
    // The old daemon exits only after it has seen the replacement serve.
    let deadline = Instant::now() + Duration::from_secs(30);
    while fixture
        .daemon
        .as_mut()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_none()
    {
        assert!(Instant::now() < deadline, "old daemon must exit");
        thread::sleep(Duration::from_millis(50));
    }
    // The replacement removes the image its predecessor ran from.
    fixture.wait_for("leftover cleanup", || fixture.leftovers().is_empty());
    let status = fixture
        .command()
        .args(["--json", "status"])
        .output()
        .unwrap();
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert_eq!(
        fixture.server.requests.load(Ordering::SeqCst),
        1,
        "the replacement must not download another update immediately"
    );
}

fn unused_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
