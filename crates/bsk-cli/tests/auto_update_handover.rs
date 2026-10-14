//! A detached daemon that auto-updates hands over to a daemon started from
//! the new executable, and exits only once that daemon serves the release's
//! version on its port. When the new executable fails its self-check, or its
//! daemon cannot start, the previous executable is put back and the running
//! daemon keeps serving on its port. `bsk update` restarts the daemon with the
//! same guarantees.
//!
//! On Windows these tests need a host that permits Job breakaway; CI runs
//! them from `scripts/test-windows-daemon.ps1`.

mod release_fixture;

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

use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};

const EXE: &str = if cfg!(windows) { "bsk.exe" } else { "bsk" };
const MARKER: &[u8] = b"auto-update-handover-fixture";

/// Serves a manifest naming [`release_fixture::newer_version`] and an
/// archive holding `binary`.
struct ReleaseServer {
    url: String,
    downloads: Arc<AtomicUsize>,
    hold_archive: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl ReleaseServer {
    /// `archive_delay` holds back the archive, keeping a download in flight.
    fn new(binary: &[u8], archive_delay: Duration) -> Self {
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
        let manifest = serde_json::to_vec(
            &serde_json::json!({"version": release_fixture::newer_version(), "assets": assets}),
        )
        .unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let downloads = Arc::new(AtomicUsize::new(0));
        let hold_archive = Arc::new(AtomicBool::new(false));
        let worker = {
            let stop = Arc::clone(&stop);
            let downloads = Arc::clone(&downloads);
            let hold_archive = Arc::clone(&hold_archive);
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
                        while hold_archive.load(Ordering::SeqCst) && !stop.load(Ordering::SeqCst) {
                            thread::sleep(Duration::from_millis(10));
                        }
                        thread::sleep(archive_delay);
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
            hold_archive,
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
        Self::with_archive_delay(release, Duration::ZERO)
    }

    fn with_archive_delay(release: impl FnOnce(&Path) -> Vec<u8>, delay: Duration) -> Self {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("bin dir");
        fs::create_dir(&dir).unwrap();
        let exe = dir.join(EXE);
        fs::copy(env!("CARGO_BIN_EXE_bsk"), &exe).unwrap();
        let home = tmp.path().join("home");
        fs::create_dir(&home).unwrap();
        let release = release(tmp.path());
        let server = ReleaseServer::new(&release, delay);
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
        self.start_daemon_idling_after(port, "60s")
    }

    fn start_daemon_idling_after(&self, port: u16, idle: &str) -> u32 {
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
                idle,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        *self.daemon.borrow_mut() = Some(child);
        pid
    }

    /// Start a daemon owned by this test, as a terminal or supervisor would.
    fn start_foreground_daemon(&self, port: u16) -> u32 {
        let child = self
            .command()
            .args([
                "daemon",
                "start",
                "--foreground",
                "--port",
                &port.to_string(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        *self.daemon.borrow_mut() = Some(child);
        pid
    }

    /// `bsk --json update --yes`, returning its report.
    fn update(&self) -> serde_json::Value {
        let out = self
            .command()
            .args(["--json", "update", "--yes"])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
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

    /// Files next to the executable other than the executable itself and
    /// the update lock, which stays.
    fn leftovers(&self) -> Vec<String> {
        let lock = format!(".{EXE}.update.lock");
        fs::read_dir(self.exe.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name != EXE && *name != lock)
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

/// The release: the bsk under test, reporting the newer version.
fn newer_bsk(dir: &Path) -> Vec<u8> {
    release_fixture::newer_bsk(dir)
}

/// The bsk under test with a trailing marker: a different file that still
/// reports the current version, not the one its manifest names.
fn mislabelled_bsk(_: &Path) -> Vec<u8> {
    let mut binary = fs::read(env!("CARGO_BIN_EXE_bsk")).unwrap();
    binary.extend_from_slice(MARKER);
    binary
}

/// Answers `--version` like the release; its daemon then runs `daemon`.
fn stand_in(dir: &Path, name: &str, daemon: &str) -> Vec<u8> {
    release_fixture::compiled(
        dir,
        name,
        &format!(
            r#"
            if std::env::args().nth(1).as_deref() == Some("--version") {{
                println!("bsk {}");
                return;
            }}
            {daemon}
            "#,
            release_fixture::newer_version()
        ),
    )
}

/// Its daemon fails to start.
fn release_whose_daemon_fails(dir: &Path) -> Vec<u8> {
    stand_in(dir, "daemon_fails", "std::process::exit(3);")
}

/// Its daemon takes the daemon lock, then never serves.
fn release_whose_daemon_hangs(dir: &Path) -> Vec<u8> {
    stand_in(
        dir,
        "daemon_hangs",
        r#"
        let home = std::env::var_os("BSK_HOME").unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(std::path::Path::new(&home).join("daemon.lock"))
            .unwrap();
        lock.lock().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(600));
        "#,
    )
}

/// Cannot even report its version.
fn release_that_cannot_run(dir: &Path) -> Vec<u8> {
    release_fixture::compiled(dir, "cannot_run", "std::process::exit(1);")
}

/// Passes the self-check only after 3 seconds; its daemon fails to start.
fn release_with_a_slow_self_check(dir: &Path) -> Vec<u8> {
    release_fixture::compiled(
        dir,
        "slow_self_check",
        &format!(
            r#"
            if std::env::args().nth(1).as_deref() == Some("--version") {{
                std::thread::sleep(std::time::Duration::from_secs(3));
                println!("bsk {}");
                return;
            }}
            std::process::exit(3);
            "#,
            release_fixture::newer_version()
        ),
    )
}

/// Start a daemon from the installed executable, as the next command would.
fn daemon_starts_again(fixture: &Fixture) {
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
    fixture.status_succeeds();
}

fn unused_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn start_test_session(
    fixture: &Fixture,
    port: u16,
) -> (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    serde_json::Value,
) {
    let browser_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let mut request = format!("ws://127.0.0.1:{port}/")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Origin",
        format!("chrome-extension://{browser_id}").parse().unwrap(),
    );
    let (mut browser, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    browser
        .send(Message::Text(
            serde_json::json!({
                "id": "handshake", "method": "system.handshake", "params": {
                    "client": "browser-skill-extension", "version": env!("CARGO_PKG_VERSION"),
                    "protocol_version": bsk::daemon::state::PROTOCOL_VERSION,
                    "instance_id": browser_id, "browser": {"name": "chrome", "version": "149"},
                    "min_compatible_protocol": "1.0", "label": "update-race"
                }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let handshake = browser.next().await.unwrap().unwrap().into_text().unwrap();
    let handshake: serde_json::Value = serde_json::from_str(&handshake).unwrap();
    assert!(handshake.get("result").is_some(), "{handshake}");

    let mut start = fixture.command();
    start.args([
        "--json",
        "session",
        "start",
        "--browser",
        browser_id,
        "--no-focus",
    ]);
    let started = tokio::task::spawn_blocking(move || start.output().unwrap());
    let request = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let frame = browser.next().await.unwrap().unwrap();
            if let Message::Text(text) = frame {
                let request: serde_json::Value = serde_json::from_str(&text).unwrap();
                if request["method"] == "tool.session_start" {
                    break request;
                }
            }
        }
    })
    .await
    .unwrap();
    let session_id = request["params"]["session_id"].clone();
    browser
        .send(Message::Text(
            serde_json::json!({
                "id": request["id"], "result": {"session_id": session_id, "agent_window_id": 71}
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let output = started.await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    (browser, session_id)
}

#[test]
fn a_session_started_during_download_postpones_installation() {
    let fixture = Fixture::new(mislabelled_bsk);
    fixture.server.hold_archive.store(true, Ordering::SeqCst);
    let port = unused_port();
    let pid = fixture.start_daemon(port);
    fixture.wait_for("the blocked archive request", || {
        fixture.server.downloads.load(Ordering::SeqCst) == 1
    });

    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (_browser, session_id) = start_test_session(&fixture, port).await;

        fixture.server.hold_archive.store(false, Ordering::SeqCst);
        fixture.wait_for("the update decision after the download", || {
            fixture
                .record()
                .is_some_and(|record| record["result"] != "in_progress")
        });
        let record = fixture.record().unwrap();
        assert_eq!(record["result"], "skipped", "{record}");
        assert_eq!(record["skip_reason"], "active_sessions", "{record}");
        assert_ne!(record["stage"], "install", "{record}");
        assert!(record.get("retry_after_epoch_secs").is_none(), "{record}");
        assert!(fixture.installed() == fixture.original);
        assert_eq!(fixture.info().unwrap()["pid"], pid);
        let status = fixture
            .command()
            .args(["--json", "status"])
            .output()
            .unwrap();
        assert!(status.status.success());
        let status: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
        assert!(
            status["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["session_id"] == session_id),
            "{status}"
        );
    });
}

#[test]
fn a_failed_auto_update_reopens_session_admission() {
    for release in [mislabelled_bsk, release_whose_daemon_fails] {
        let fixture = Fixture::new(release);
        let port = unused_port();
        let pid = fixture.start_daemon(port);
        fixture.wait_for("rollback after the update failed", || {
            fixture
                .record()
                .is_some_and(|record| record["result"] == "failed")
                && fixture.info().is_some_and(|info| info["pid"] == pid)
        });
        assert!(fixture.installed() == fixture.original);
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (_browser, _session) = start_test_session(&fixture, port).await;
            fixture.status_succeeds();
        });
    }
}

#[test]
fn auto_update_exits_only_after_the_new_daemon_serves() {
    let fixture = Fixture::new(newer_bsk);
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
    assert_eq!(
        record["target_version"],
        release_fixture::newer_version(),
        "{record}"
    );
    assert_eq!(
        record["daemon_version"],
        release_fixture::newer_version(),
        "{record}"
    );
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
    // Confirmed only once the resumed daemon has published daemon.json.
    fixture.wait_for("the resumed service to be confirmed", || {
        fixture.record().is_some_and(|record| {
            record["recovery"] == serde_json::json!({"state": "restored", "daemon_serving": true})
        })
    });

    let record = fixture.record().unwrap();
    assert_eq!(record["stage"], "handover", "{record}");
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
fn an_update_installed_after_the_daemon_went_idle_is_undone() {
    // The daemon idles out while the new executable's self-check runs, so the
    // install finishes after shutdown began and must be rolled back.
    let fixture = Fixture::new(release_with_a_slow_self_check);
    fixture.start_daemon_idling_after(unused_port(), "1s");

    fixture.wait_for("the daemon to idle out", || fixture.daemon_exited());

    let record = fixture.record().unwrap();
    assert_eq!(record["result"], "failed", "{record}");
    assert_eq!(
        record["recovery"],
        serde_json::json!({"state": "restored", "daemon_serving": false}),
        "{record}"
    );
    let error = record["error"].as_str().unwrap();
    assert!(error.contains("handover abandoned"), "{error}");
    assert!(
        fixture.installed() == fixture.original,
        "the previous executable is back in place"
    );
    daemon_starts_again(&fixture);
}

#[test]
fn a_download_still_in_flight_when_the_daemon_idles_out_installs_nothing() {
    let fixture = Fixture::with_archive_delay(release_whose_daemon_fails, Duration::from_secs(4));
    fixture.start_daemon_idling_after(unused_port(), "1s");

    fixture.wait_for("the daemon to idle out", || fixture.daemon_exited());

    let record = fixture.record().unwrap();
    assert_eq!(record["result"], "failed", "{record}");
    assert_eq!(
        record["recovery"],
        serde_json::json!({"state": "unchanged"}),
        "{record}"
    );
    let error = record["error"].as_str().unwrap();
    assert!(
        error.contains("stopped before the update was installed"),
        "{error}"
    );
    assert!(fixture.installed() == fixture.original);
    daemon_starts_again(&fixture);
}

#[test]
fn a_dynamic_port_daemon_resumes_on_the_port_it_was_given() {
    let fixture = Fixture::new(release_whose_daemon_fails);
    let old_pid = fixture.start_daemon(0);
    let mut port = None;
    fixture.wait_for("the daemon to serve", || {
        port = fixture
            .info()
            .filter(|info| info["pid"] == old_pid)
            .and_then(|info| info["ws_port"].as_u64());
        port.is_some()
    });
    let port = port.unwrap();

    fixture.wait_for("the resumed service to be confirmed", || {
        fixture.record().is_some_and(|record| {
            record["recovery"] == serde_json::json!({"state": "restored", "daemon_serving": true})
        })
    });

    let info = fixture.info().unwrap();
    assert_eq!(info["pid"], old_pid, "the previous daemon serves again");
    assert_eq!(info["ws_port"], port, "{info}");
    let port = u16::try_from(port).unwrap();
    std::net::TcpStream::connect(("127.0.0.1", port))
        .expect("browsers can reconnect to the original port");
    fixture.status_succeeds();
}

#[test]
fn manual_update_leaves_a_host_managed_daemon_to_its_owner() {
    let fixture = Fixture::new(newer_bsk);
    let port = unused_port();
    let pid = fixture.start_foreground_daemon(port);
    fixture.wait_for("the foreground daemon", || {
        fixture
            .info()
            .is_some_and(|info| info["pid"] == pid && info["host_managed"] == true)
    });

    let report = fixture.update();

    assert_eq!(report["status"], "updated", "{report}");
    assert_eq!(report["daemon"], "left_to_host", "{report}");
    assert!(
        report["message"]
            .as_str()
            .unwrap()
            .contains("restart it there"),
        "{report}"
    );
    assert!(fixture.installed() == fixture.release);
    assert!(!fixture.daemon_exited(), "the owner's daemon keeps running");
    assert_eq!(fixture.info().unwrap()["pid"], pid);
    fixture.status_succeeds();
    assert_eq!(fixture.record().unwrap()["result"], "succeeded");
}

#[test]
fn manual_update_restarts_a_background_daemon_on_its_port() {
    let fixture = Fixture::new(newer_bsk);
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
    let old_pid = fixture.info().unwrap()["pid"].clone();

    let report = fixture.update();

    assert_eq!(report["daemon"], "restarted", "{report}");
    assert!(fixture.installed() == fixture.release);
    let info = fixture.info().unwrap();
    assert_ne!(info["pid"], old_pid);
    assert_eq!(info["ws_port"], port, "restarted on the port it served");
    assert!(info.get("host_managed").is_none(), "{info}");
    let record = fixture.record().unwrap();
    assert_eq!(record["result"], "succeeded", "{record}");
    assert_eq!(record["stage"], "restart", "{record}");
    assert_eq!(record["daemon_pid"], info["pid"], "{record}");
    fixture.status_succeeds();
}

#[test]
fn a_release_that_cannot_run_or_reports_another_version_is_never_handed_over_to() {
    for (release, expected_error) in [
        (
            release_that_cannot_run as fn(&Path) -> Vec<u8>,
            "exited with",
        ),
        (
            mislabelled_bsk,
            concat!("printed \"bsk ", env!("CARGO_PKG_VERSION"), "\""),
        ),
    ] {
        let fixture = Fixture::new(release);
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
        let error = record["error"].as_str().unwrap();
        assert!(error.contains("self-check"), "{error}");
        assert!(error.contains(expected_error), "{error}");
        assert!(fixture.installed() == fixture.original);
        assert_eq!(fixture.info().unwrap()["pid"], old_pid, "never stopped");
        assert!(!fixture.daemon_exited());
        fixture.status_succeeds();
    }
}

#[test]
fn manual_update_stops_a_new_daemon_stuck_on_the_lock_and_restores_the_service() {
    let fixture = Fixture::new(release_whose_daemon_hangs);
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

    let out = fixture
        .command()
        .args(["--json", "update", "--yes"])
        .output()
        .unwrap();

    // `--json` reports the error on stdout.
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!out.status.success(), "the update must fail: {output}");
    assert!(output.contains("rolled back"), "{output}");
    assert!(fixture.installed() == fixture.original);
    // The stuck daemon was stopped, so the previous version got the lock and
    // serves the original port again.
    let info = fixture.info().expect("a daemon serves again");
    assert_eq!(info["ws_port"], port, "{info}");
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"), "{info}");
    fixture.status_succeeds();
    let record = fixture.record().unwrap();
    assert_eq!(record["stage"], "restart", "{record}");
    assert_eq!(
        record["recovery"],
        serde_json::json!({"state": "restored", "daemon_serving": true}),
        "{record}"
    );
    let error = record["error"].as_str().unwrap();
    assert!(error.contains("was not ready within"), "{error}");
}

#[test]
fn a_resumed_daemon_that_cannot_serve_again_is_recorded_as_not_serving() {
    let fixture = Fixture::new(release_whose_daemon_fails);
    let port = unused_port();
    fixture.start_daemon(port);
    fixture.wait_for("the daemon to serve", || {
        fixture.info().is_some_and(|info| info["ws_port"] == port)
    });

    // Take the port the moment the daemon releases it for the handover, so
    // the previous version cannot bind it again after the replacement fails.
    let listener = loop {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            break listener;
        }
        assert!(!fixture.daemon_exited(), "the daemon exited early");
    };
    fixture.wait_for("the daemon to give up", || fixture.daemon_exited());

    let record = fixture.record().unwrap();
    assert_eq!(record["result"], "failed", "{record}");
    assert_eq!(
        record["recovery"],
        serde_json::json!({"state": "restored", "daemon_serving": false}),
        "{record}"
    );
    let error = record["error"].as_str().unwrap();
    assert!(error.contains("before it was ready"), "{error}");
    assert!(
        error.contains("the previous version could not serve again"),
        "{error}"
    );
    assert!(fixture.installed() == fixture.original);
    drop(listener);
}
