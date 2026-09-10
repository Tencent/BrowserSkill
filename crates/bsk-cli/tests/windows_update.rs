//! Exercise self-update with a real executable and a local release server.
#![cfg(windows)]

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

const MARKER: &[u8] = b"windows-update-regression-fixture";

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
            "version": "999.0.0",
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
    assert_eq!(manifest["version"], "999.0.0");
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
        // A PE overlay distinguishes the replacement without requiring a
        // second build or changing the executable's behavior/version.
        let mut binary = fs::read(&exe).unwrap();
        binary.extend_from_slice(MARKER);
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
        let diagnostics: Vec<_> = fs::read_dir(self.exe.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "log"))
            .map(|entry| {
                (
                    entry.path(),
                    String::from_utf8_lossy(&fs::read(entry.path()).unwrap_or_default())
                        .into_owned(),
                )
            })
            .collect();
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
            "timed out waiting for {description}; helper logs: {diagnostics:?}; daemon logs: {home_logs:?}"
        );
    }

    fn info(&self) -> Option<DaemonInfo> {
        serde_json::from_slice(&fs::read(self.home.join("daemon.json")).ok()?).ok()
    }

    fn updated(&self) -> bool {
        // A locked executable may briefly reject reads during replacement.
        fs::read(&self.exe).is_ok_and(|binary| binary == self.binary)
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

#[test]
fn manual_update_replaces_the_running_executable_after_cli_exit() {
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
    assert_eq!(report["status"], "staged");
    fixture.wait_for("CLI replacement and helper cleanup", || {
        fixture.updated() && fs::read_dir(fixture.exe.parent().unwrap()).unwrap().count() == 1
    });
    assert!(
        fixture.info().is_none(),
        "an update must not start a previously absent daemon"
    );
    assert_eq!(fixture.server.requests.load(Ordering::SeqCst), 1);
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
    assert!(
        fixture
            .daemon
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_some(),
        "old daemon must exit"
    );
    fixture.wait_for("helper cleanup", || {
        fs::read_dir(fixture.exe.parent().unwrap()).unwrap().count() == 1
    });
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
        "the replacement must not stage another update immediately"
    );
}

fn unused_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
