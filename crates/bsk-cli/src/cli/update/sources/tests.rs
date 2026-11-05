use super::*;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

struct Server {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Server {
    fn new(responses: Vec<(&str, u16, Vec<u8>)>) -> Self {
        Self::with_delay(responses, Duration::ZERO)
    }

    fn with_delay(responses: Vec<(&str, u16, Vec<u8>)>, delay: Duration) -> Self {
        let responses: BTreeMap<_, _> = responses
            .into_iter()
            .map(|(path, status, body)| (path.to_owned(), (status, body)))
            .collect();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let worker = {
            let requests = Arc::clone(&requests);
            let stop = Arc::clone(&stop);
            thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(connection) => connection,
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(err) => panic!("accept test request: {err}"),
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = Vec::new();
                    let mut chunk = [0; 1024];
                    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        match stream.read(&mut chunk) {
                            Ok(0) | Err(_) => break,
                            Ok(len) => request.extend_from_slice(&chunk[..len]),
                        }
                    }
                    let request = String::from_utf8_lossy(&request);
                    let path = request.split_whitespace().nth(1).unwrap_or("");
                    requests.lock().unwrap().push(path.to_owned());
                    thread::sleep(delay);
                    let (status, body) = responses
                        .get(path)
                        .map(|(status, body)| (*status, body.as_slice()))
                        .unwrap_or((404, b"not found"));
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(body);
                }
            })
        };
        Self {
            base,
            requests,
            stop,
            worker: Some(worker),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap()
}

fn manifest() -> serde_json::Value {
    let mut assets = serde_json::Map::new();
    for platform in [
        "darwin-arm64",
        "darwin-x64",
        "linux-arm64",
        "linux-x64",
        "windows-x64",
    ] {
        assets.insert(
            platform.to_owned(),
            serde_json::json!({
                "url": "https://example.test/original.tar.gz", "sha256": "a".repeat(64),
            }),
        );
    }
    serde_json::json!({"version": "99.0.0", "tag": "cli-v99.0.0", "assets": assets})
}

fn manifest_bytes() -> Vec<u8> {
    serde_json::to_vec(&manifest()).unwrap()
}

fn fetch(server: &Server, override_url: Option<&str>) -> Result<UpdateManifest> {
    Sources {
        domestic_manifest: &server.url("/domestic.json"),
        domestic_base: &server.url("/domestic"),
        github_manifest: &server.url("/github.json"),
    }
    .fetch_manifest(&client(), override_url, "0.1.0", "darwin-arm64")
}

#[test]
fn domestic_manifest_and_all_platform_archives_take_priority() {
    let server = Server::new(vec![("/domestic.json", 200, manifest_bytes())]);
    let manifest = fetch(&server, None).unwrap();
    assert_eq!(server.requests(), ["/domestic.json"]);
    for (platform, filename, archive) in [
        (
            "darwin-arm64",
            "bsk-macos-arm64.tar.gz",
            "aarch64-apple-darwin.tar.gz",
        ),
        (
            "darwin-x64",
            "bsk-macos-intel.tar.gz",
            "x86_64-apple-darwin.tar.gz",
        ),
        (
            "linux-arm64",
            "bsk-linux-arm64.tar.gz",
            "aarch64-unknown-linux-musl.tar.gz",
        ),
        (
            "linux-x64",
            "bsk-linux-x64.tar.gz",
            "x86_64-unknown-linux-musl.tar.gz",
        ),
        (
            "windows-x64",
            "bsk-windows-x64.zip",
            "x86_64-pc-windows-msvc.zip",
        ),
    ] {
        let candidate = manifest
            .update_candidate("0.1.0", platform)
            .unwrap()
            .unwrap();
        assert_eq!(
            candidate.asset.url,
            server.url(&format!("/domestic/{filename}"))
        );
        assert_eq!(
            candidate.asset.fallback_url.unwrap(),
            format!("{GITHUB_RELEASE_BASE}/cli-v99.0.0/bsk-v99.0.0-{archive}")
        );
        assert_eq!(candidate.asset.sha256.unwrap(), "a".repeat(64));
    }
}

#[test]
fn unavailable_or_unusable_domestic_manifests_fall_back_to_github() {
    let mut missing_platform = manifest();
    missing_platform["assets"] = serde_json::json!({});
    let mut missing_checksum = manifest();
    missing_checksum["assets"]["darwin-arm64"] = serde_json::json!({"url": "no-checksum.tar.gz"});
    let mut invalid_checksum = manifest();
    invalid_checksum["assets"]["darwin-arm64"]["sha256"] = serde_json::json!("not-a-sha256");
    for (status, body) in [
        (503, b"unavailable".to_vec()),
        (200, b"<html>not a manifest</html>".to_vec()),
        (200, serde_json::to_vec(&missing_platform).unwrap()),
        (200, serde_json::to_vec(&missing_checksum).unwrap()),
        (200, serde_json::to_vec(&invalid_checksum).unwrap()),
    ] {
        let server = Server::new(vec![
            ("/domestic.json", status, body),
            ("/github.json", 200, manifest_bytes()),
        ]);
        let manifest = fetch(&server, None).unwrap();
        assert_eq!(server.requests(), ["/domestic.json", "/github.json"]);
        // Metadata failure does not prevent trying a healthy domestic archive.
        assert_eq!(
            manifest.assets["darwin-arm64"].url,
            server.url("/domestic/bsk-macos-arm64.tar.gz")
        );
    }
}

#[test]
fn manifest_timeout_falls_back_without_waiting_for_the_slow_source() {
    let slow = Server::with_delay(
        vec![("/version.json", 200, manifest_bytes())],
        Duration::from_millis(400),
    );
    let healthy = Server::new(vec![("/version.json", 200, manifest_bytes())]);
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(100))
        .build()
        .unwrap();
    let manifest = Sources {
        domestic_manifest: &slow.url("/version.json"),
        domestic_base: &slow.base,
        github_manifest: &healthy.url("/version.json"),
    }
    .fetch_manifest(&client, None, "0.1.0", "darwin-arm64")
    .unwrap();
    assert_eq!(manifest.version, Version::new(99, 0, 0));
    assert_eq!(slow.requests(), ["/version.json"]);
    assert_eq!(healthy.requests(), ["/version.json"]);
}

#[test]
fn both_manifest_failures_include_sources_urls_and_http_causes() {
    let server = Server::new(vec![("/domestic.json", 503, Vec::new())]);
    let failure = fetch(&server, None).unwrap_err();
    let error = format!("{failure:#}");
    assert!(error.contains("fetch the bsk update manifest"), "{error}");
    assert!(error.contains("domestic ("), "{error}");
    assert!(error.contains("GitHub fallback ("), "{error}");
    assert!(error.contains(&server.url("/domestic.json")), "{error}");
    assert!(error.contains(&server.url("/github.json")), "{error}");
    assert!(error.contains("503") && error.contains("404"), "{error}");
    assert!(error.contains("network/proxy"), "{error}");
    let cli_error = CliError::Local(failure.context("update failed"));
    let human = crate::cli::error::render_human_to_string(&cli_error, None);
    assert!(human.contains(&format!("hint: {RECOVERY_HINT}")), "{human}");
    assert!(!human.contains("is the daemon running?"), "{human}");
}

#[test]
fn explicit_manifest_override_keeps_its_asset_urls_and_does_not_use_public_sources() {
    let server = Server::new(vec![("/custom.json", 200, manifest_bytes())]);
    let manifest = fetch(&server, Some(&server.url("/custom.json"))).unwrap();
    assert_eq!(
        manifest.assets["darwin-arm64"].url,
        "https://example.test/original.tar.gz"
    );
    assert!(manifest.assets["darwin-arm64"].fallback_url.is_none());
    let error = fetch(&server, Some(&server.url("/missing.json")))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("custom (") && error.contains("404"),
        "{error}"
    );
    assert_eq!(server.requests(), ["/custom.json", "/missing.json"]);
}

fn archive() -> Vec<u8> {
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(10);
    header.set_mode(0o755);
    header.set_cksum();
    tar.append_data(&mut header, "bsk", Cursor::new(b"new binary"))
        .unwrap();
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gzip.write_all(&tar.into_inner().unwrap()).unwrap();
    gzip.finish().unwrap()
}

fn candidate(server: &Server, sha256: Option<String>) -> UpdateCandidate {
    UpdateCandidate {
        current: Version::new(0, 1, 0),
        latest: Version::new(99, 0, 0),
        tag: "cli-v99.0.0".into(),
        release_url: None,
        asset: ManifestAsset {
            url: server.url("/domestic.tar.gz"),
            sha256,
            fallback_url: Some(server.url("/github.tar.gz")),
        },
    }
}

#[test]
fn healthy_domestic_archive_never_contacts_github() {
    let archive = archive();
    let server = Server::new(vec![("/domestic.tar.gz", 200, archive.clone())]);
    let candidate = candidate(&server, Some(hex_sha256(&archive)));
    assert_eq!(
        download_candidate_binary(&candidate, &client()).unwrap(),
        b"new binary"
    );
    assert_eq!(server.requests(), ["/domestic.tar.gz"]);
}

#[test]
fn archive_http_checksum_and_extraction_failures_fall_back_to_github() {
    for (status, domestic_body, github_body) in [
        (404, Vec::new(), archive()),
        (200, b"stale or corrupt mirror archive".to_vec(), archive()),
        // Both responses match the hash but are not valid tar archives. The
        // second request proves extraction errors also advance to GitHub.
        (200, b"invalid tar".to_vec(), b"invalid tar".to_vec()),
    ] {
        let server = Server::new(vec![
            ("/domestic.tar.gz", status, domestic_body),
            ("/github.tar.gz", 200, github_body.clone()),
        ]);
        let candidate = candidate(&server, Some(hex_sha256(&github_body)));
        let result = download_candidate_binary(&candidate, &client());
        if github_body == b"invalid tar" {
            let error = result.unwrap_err().to_string();
            assert!(
                error.contains("domestic (") && error.contains("GitHub fallback ("),
                "{error}"
            );
        } else {
            assert_eq!(result.unwrap(), b"new binary");
        }
        assert_eq!(server.requests(), ["/domestic.tar.gz", "/github.tar.gz"]);
    }
}

#[test]
fn both_archive_failures_preserve_checksum_and_http_errors_and_urls() {
    let server = Server::new(vec![("/domestic.tar.gz", 200, b"stale mirror".to_vec())]);
    let candidate = candidate(&server, Some(hex_sha256(&archive())));
    let error = download_candidate_binary(&candidate, &client())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("download and verify the bsk update"),
        "{error}"
    );
    assert!(
        error.contains("checksum mismatch") && error.contains("404"),
        "{error}"
    );
    for path in ["/domestic.tar.gz", "/github.tar.gz"] {
        assert!(error.contains(&server.url(path)), "{error}");
    }
}

#[test]
fn archives_without_checksums_are_never_downloaded() {
    let server = Server::new(Vec::new());
    let error = download_candidate_binary(&candidate(&server, None), &client()).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("does not include a sha256 checksum")
    );
    assert!(server.requests().is_empty());
}
