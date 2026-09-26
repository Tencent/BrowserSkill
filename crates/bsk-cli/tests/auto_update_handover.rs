//! A detached daemon that auto-updates hands over to a daemon started from
//! the new executable, and exits only once that daemon serves. When the new
//! executable fails its self-check, or its daemon cannot start, the previous
//! executable is put back and the running daemon keeps serving on its port.
//!
//! On Windows these tests need a host that permits Job breakaway; CI runs
//! them from `scripts/test-windows-daemon.ps1`.

use std::cell::RefCell;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

const EXE: &str = if cfg!(windows) { "bsk.exe" } else { "bsk" };
const MARKER: &[u8] = b"auto-update-handover-fixture";

/// Serves a manifest naming release 999.0.0 and an archive holding `binary`.
struct ReleaseServer {
    url: String,
    downloads: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl ReleaseServer {
    fn new(binary: &[u8]) -> Self {
        let (archive, suffix) = archive(binary);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let mut assets = serde_json::Map::new();
        assets.insert(
            bsk::cli::update::current_platform_key()
                .unwrap()
                .to_string(),
            serde_json::json!({
                "url": format!("{base}/bsk{suffix}"),
                "sha256": Sha256::digest(&archive).iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            }),
        );
        let manifest =
            serde_json::to_vec(&serde_json::json!({"version": "999.0.0", "assets": assets}))
                .unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let downloads = Arc::new(AtomicUsize::new(0));
        let worker = {
            let stop = Arc::clone(&stop);
            let downloads = Arc::clone(&downloads);
            let archive_request = format!("GET /bsk{suffix} ");
            thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let mut stream = match listener.accept() {
                        Ok((stream, _)) => stream,
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                            continue;
                        }
                        Err(err) => panic!("accept release request: {err}"),
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut request = Vec::new();
                    let mut chunk = [0; 1024];
                    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                        match stream.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(len) => request.extend_from_slice(&chunk[..len]),
                        }
                    }
                    let body = if request.starts_with(archive_request.as_bytes()) {
                        downloads.fetch_add(1, Ordering::SeqCst);
                        &archive
                    } else {
                        &manifest
                    };
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(body);
                }
            })
        };
        Self {
            url: format!("{base}/version.json"),
            downloads,
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

#[cfg(windows)]
fn archive(binary: &[u8]) -> (Vec<u8>, &'static str) {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    archive
        .start_file(
            "bsk.exe",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
    archive.write_all(binary).unwrap();
    (archive.finish().unwrap().into_inner(), ".zip")
}

#[cfg(not(windows))]
fn archive(binary: &[u8]) -> (Vec<u8>, &'static str) {
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(binary.len() as u64);
    header.set_mode(0o755);
    header.set_cksum();
    tar.append_data(&mut header, "bsk", Cursor::new(binary))
        .unwrap();
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gzip.write_all(&tar.into_inner().unwrap()).unwrap();
    (gzip.finish().unwrap(), ".tar.gz")
}

struct Fixture {
    _tmp: tempfile::TempDir,
    exe: PathBuf,
    home: PathBuf,
    original: Vec<u8>,
    release: Vec<u8>,
    server: ReleaseServer,
    daemon: RefCell<Option<Child>>,
}

impl Fixture {
    /// An installation of the current bsk whose next release is `release`.
    fn new(release: impl FnOnce(&Path) -> Vec<u8>) -> Self {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("bin dir");
        fs::create_dir(&dir).unwrap();
        let exe = dir.join(EXE);
        fs::copy(env!("CARGO_BIN_EXE_bsk"), &exe).unwrap();
        let home = tmp.path().join("home");
        fs::create_dir(&home).unwrap();
        let release = release(tmp.path());
        let server = ReleaseServer::new(&release);
        Self {
            original: fs::read(&exe).unwrap(),
            _tmp: tmp,
            exe,
            home,
            release,
            server,
            daemon: RefCell::new(None),
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.exe);
        command
            .env("BSK_HOME", &self.home)
            .env("BSK_UPDATE_MANIFEST_URL", &self.server.url)
            .env("BSK_AUTO_UPDATE", "off")
            .env("RUST_LOG", "info")
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env_remove("BSK_DAEMONIZED")
            .env_remove("BSK_DAEMON_REPLACES_PID")
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        command
    }

    /// Start a daemon as `bsk` starts one in the background, so it installs
    /// updates itself, and return its pid. It checks for updates at once.
    fn start_daemon(&self, port: u16) -> u32 {
        let child = self
            .command()
            .env("BSK_AUTO_UPDATE", "on")
            .env("BSK_DAEMONIZED", "1")
            .args([
                "daemon",
                "start",
                "--port",
                &port.to_string(),
                "--daemon-idle",
                "60s",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        *self.daemon.borrow_mut() = Some(child);
        pid
    }

    fn daemon_exited(&self) -> bool {
        self.daemon
            .borrow_mut()
            .as_mut()
            .is_some_and(|daemon| daemon.try_wait().unwrap().is_some())
    }

    fn json(&self, name: &str) -> Option<serde_json::Value> {
        serde_json::from_slice(&fs::read(self.home.join(name)).ok()?).ok()
    }

    fn info(&self) -> Option<serde_json::Value> {
        self.json("daemon.json")
    }

    fn record(&self) -> Option<serde_json::Value> {
        self.json("update-state.json")
    }

    fn installed(&self) -> Vec<u8> {
        // A scanner may briefly hold a freshly renamed file.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match fs::read(&self.exe) {
                Ok(bytes) => return bytes,
                Err(err) if Instant::now() < deadline => {
                    let _ = err;
                    thread::sleep(Duration::from_millis(50));
                }
                Err(err) => panic!("read {}: {err}", self.exe.display()),
            }
        }
    }

    /// Files next to the executable other than the executable itself.
    fn leftovers(&self) -> Vec<String> {
        fs::read_dir(self.exe.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != EXE)
            .collect()
    }

    fn wait_for(&self, description: &str, mut check: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if check() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let logs: Vec<_> = fs::read_dir(&self.home)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains("daemon.log"))
            .map(|entry| fs::read_to_string(entry.path()).unwrap_or_default())
            .collect();
        panic!(
            "timed out waiting for {description}; record: {:?}; daemon.json: {:?}; files next to {EXE}: {:?}; logs: {logs:?}",
            self.record(),
            self.info(),
            self.leftovers()
        );
    }

    fn status_succeeds(&self) {
        let status = self.command().args(["--json", "status"]).output().unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.command().args(["daemon", "stop"]).output();
        if let Some(daemon) = self.daemon.get_mut().as_mut() {
            let _ = daemon.kill();
            let _ = daemon.wait();
        }
    }
}

/// The current bsk with a trailing marker: the same program, but a
/// different file, so the tests can tell which one is installed.
fn marked_bsk(_: &Path) -> Vec<u8> {
    let mut binary = fs::read(env!("CARGO_BIN_EXE_bsk")).unwrap();
    binary.extend_from_slice(MARKER);
    binary
}

/// Compile a stand-in for a broken release.
fn compiled(dir: &Path, name: &str, main: &str) -> Vec<u8> {
    let source = dir.join(format!("{name}.rs"));
    fs::write(&source, format!("fn main() {{ {main} }}")).unwrap();
    let output = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let status = Command::new(rustc)
        .args(["--edition", "2021", "-o"])
        .arg(&output)
        .arg(&source)
        .status()
        .unwrap();
    assert!(status.success(), "compile {name}");
    fs::read(output).unwrap()
}

/// Answers `--version` like bsk, but its daemon fails to start.
fn release_whose_daemon_fails(dir: &Path) -> Vec<u8> {
    compiled(
        dir,
        "daemon_fails",
        r#"
        if std::env::args().nth(1).as_deref() == Some("--version") {
            println!("bsk 999.0.0");
            return;
        }
        std::process::exit(3);
        "#,
    )
}

/// Cannot even report its version.
fn release_that_cannot_run(dir: &Path) -> Vec<u8> {
    compiled(dir, "cannot_run", "std::process::exit(1);")
}

fn unused_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[test]
fn auto_update_exits_only_after_the_new_daemon_serves() {
    let fixture = Fixture::new(marked_bsk);
    let port = unused_port();
    let old_pid = fixture.start_daemon(port);

    fixture.wait_for("the replacement daemon", || {
        fixture
            .info()
            .is_some_and(|info| info["pid"] != old_pid && info["ws_port"] == port)
    });
    fixture.wait_for("the previous daemon to exit", || fixture.daemon_exited());

    let record = fixture.record().expect("the update is recorded");
    let new_pid = fixture.info().unwrap()["pid"].clone();
    assert_eq!(record["source"], "daemon", "{record}");
    assert_eq!(record["result"], "succeeded", "{record}");
    assert_eq!(record["stage"], "handover", "{record}");
    assert_eq!(record["target_version"], "999.0.0", "{record}");
    assert_eq!(record["daemon_pid"], new_pid, "{record}");
    assert!(record.get("previous_executable").is_none(), "{record}");
    assert!(fixture.installed() == fixture.release);
    // The replacement removes the executable its predecessor ran from.
    fixture.wait_for("leftover cleanup", || fixture.leftovers().is_empty());
    fixture.status_succeeds();
    assert_eq!(
        fixture.server.downloads.load(Ordering::SeqCst),
        1,
        "the replacement must not download the release again"
    );
}

#[test]
fn a_failed_handover_restores_the_previous_executable_and_keeps_serving() {
    let fixture = Fixture::new(release_whose_daemon_fails);
    let port = unused_port();
    let old_pid = fixture.start_daemon(port);

    fixture.wait_for("the failed handover to be recorded", || {
        fixture
            .record()
            .is_some_and(|record| record["result"] == "failed")
    });
    fixture.wait_for("the previous daemon to serve again", || {
        fixture
            .info()
            .is_some_and(|info| info["pid"] == old_pid && info["ws_port"] == port)
    });

    let record = fixture.record().unwrap();
    assert_eq!(record["stage"], "handover", "{record}");
    assert_eq!(
        record["recovery"],
        serde_json::json!({"state": "restored", "daemon_serving": true}),
        "{record}"
    );
    let error = record["error"].as_str().unwrap();
    assert!(error.contains("before it was ready"), "{error}");
    assert!(record["retry_after_epoch_secs"].is_u64(), "{record}");
    assert!(
        !fixture.daemon_exited(),
        "the previous daemon keeps running"
    );
    assert!(
        fixture.installed() == fixture.original,
        "the previous executable is back in place"
    );
    fixture.status_succeeds();
    fixture.wait_for("leftover cleanup", || {
        fixture
            .leftovers()
            .iter()
            .all(|name| !name.contains(".new-"))
    });
}

#[test]
fn a_release_that_cannot_run_is_never_handed_over_to() {
    let fixture = Fixture::new(release_that_cannot_run);
    let port = unused_port();
    let old_pid = fixture.start_daemon(port);
    fixture.wait_for("the daemon to serve", || {
        fixture.info().is_some_and(|info| info["pid"] == old_pid)
    });

    fixture.wait_for("the failed update to be recorded", || {
        fixture
            .record()
            .is_some_and(|record| record["result"] == "failed")
    });

    let record = fixture.record().unwrap();
    assert_eq!(record["stage"], "install", "{record}");
    assert_eq!(
        record["recovery"],
        serde_json::json!({"state": "unchanged"}),
        "{record}"
    );
    assert!(
        record["error"].as_str().unwrap().contains("self-check"),
        "{record}"
    );
    assert!(fixture.installed() == fixture.original);
    assert_eq!(fixture.info().unwrap()["pid"], old_pid, "never stopped");
    assert!(!fixture.daemon_exited());
    fixture.status_succeeds();
}
