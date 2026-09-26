//! A daemon owned by a terminal or supervisor (`--foreground`) reports new
//! versions but never replaces itself: only its owner can restart it.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

/// Serves a manifest that names a newer release and counts archive downloads.
struct ReleaseServer {
    url: String,
    downloads: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl ReleaseServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let mut assets = serde_json::Map::new();
        assets.insert(
            bsk::cli::update::current_platform_key()
                .unwrap()
                .to_string(),
            serde_json::json!({"url": format!("{base}/bsk.archive"), "sha256": "00"}),
        );
        let manifest =
            serde_json::to_vec(&serde_json::json!({"version": "999.0.0", "assets": assets}))
                .unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let downloads = Arc::new(AtomicUsize::new(0));
        let worker = {
            let stop = Arc::clone(&stop);
            let downloads = Arc::clone(&downloads);
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
                    if request.starts_with(b"GET /bsk.archive ") {
                        downloads.fetch_add(1, Ordering::SeqCst);
                    }
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        manifest.len()
                    );
                    let _ = stream.write_all(&manifest);
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

struct Daemon(Child);

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn bsk(home: &Path, server: &ReleaseServer) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bsk"));
    command
        .env("BSK_HOME", home)
        .env("BSK_UPDATE_MANIFEST_URL", &server.url)
        .env("BSK_AUTO_UPDATE", "on")
        .env("RUST_LOG", "info")
        .env("NO_PROXY", "127.0.0.1,localhost")
        .env_remove("BSK_DAEMONIZED")
        .env_remove("BSK_DAEMON_REPLACES_PID")
        .stdin(Stdio::null());
    command
}

#[test]
fn foreground_daemon_reports_updates_without_replacing_itself() {
    let server = ReleaseServer::start();
    let tmp = tempfile::TempDir::new().unwrap();
    let home = tmp.path().join("home");
    fs::create_dir(&home).unwrap();
    let log_path = tmp.path().join("foreground.log");
    let log = fs::File::create(&log_path).unwrap();
    let mut daemon = Daemon(
        bsk(&home, &server)
            .args(["daemon", "start", "--foreground", "--port", "0"])
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap(),
    );

    let deadline = Instant::now() + Duration::from_secs(30);
    while !fs::read_to_string(&log_path)
        .unwrap_or_default()
        .contains("belongs to its terminal or supervisor")
    {
        assert!(
            daemon.0.try_wait().unwrap().is_none(),
            "daemon exited: {}",
            fs::read_to_string(&log_path).unwrap_or_default()
        );
        assert!(
            Instant::now() < deadline,
            "no update report: {}",
            fs::read_to_string(&log_path).unwrap_or_default()
        );
        thread::sleep(Duration::from_millis(50));
    }

    assert!(
        daemon.0.try_wait().unwrap().is_none(),
        "the daemon keeps serving"
    );
    assert_eq!(
        server.downloads.load(Ordering::SeqCst),
        0,
        "a host-managed daemon must not download the release"
    );
    let cache: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("update-check.json")).unwrap()).unwrap();
    assert_eq!(cache["latest_version"], "999.0.0");
    assert_eq!(cache["auto_update"], false);

    // The CLI hint follows the daemon's policy, not the CLI's own switch.
    let status = bsk(&home, &server).arg("status").output().unwrap();
    let stderr = String::from_utf8_lossy(&status.stderr);
    assert!(stderr.contains("999.0.0. Run `bsk update`."), "{stderr}");
}
