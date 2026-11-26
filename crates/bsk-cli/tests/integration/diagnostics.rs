//! Exercise the installed command boundary and inspect the completed ZIP.

use std::{collections::BTreeMap, fs, io::Read, path::Path, process::Command};

use bsk::skill_install::{SKILL_DIR_NAME, SOURCE_BUNDLED, SOURCE_MARKER_FILE};
use serde_json::{Value, json};
use tempfile::tempdir;

fn command(home: &Path, output: &str) -> Command {
    let root = home.parent().unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
    cmd.current_dir(root)
        .env("BSK_HOME", home)
        .env("DSH_HOME", root.join("dsh"))
        .env("BSK_AUTO_START", "1")
        .env("BSK_AUTO_UPDATE", "off")
        .env_remove("BSK_CANCEL_ON_STDIN_CLOSE")
        .args(["diagnostics", "export", "--json", "--output", output]);
    cmd
}

fn export(home: &Path) -> BTreeMap<String, String> {
    let result = command(home, "report.zip").output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let path = home.parent().unwrap().join("report.zip");
    let receipt: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(receipt["path"], "report.zip");
    assert_eq!(receipt["bytes"], fs::metadata(&path).unwrap().len());
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    (0..zip.len())
        .map(|i| {
            let mut entry = zip.by_index(i).unwrap();
            let mut data = String::new();
            entry.read_to_string(&mut data).unwrap();
            (entry.name().to_owned(), data)
        })
        .collect()
}

#[test]
fn offline_export_preserves_a_missing_home_and_managed_skill() {
    let root = tempdir().unwrap();
    let home = root.path().join("missing");
    let skill = root.path().join("dsh").join("skills").join(SKILL_DIR_NAME);
    fs::create_dir_all(&skill).unwrap();
    let old = include_bytes!("../fixtures/legacy-skills/crate.md");
    fs::write(skill.join("SKILL.md"), old).unwrap();
    fs::write(skill.join(SOURCE_MARKER_FILE), SOURCE_BUNDLED).unwrap();

    let files = export(&home);
    assert!(!home.exists());
    assert_eq!(fs::read(skill.join("SKILL.md")).unwrap(), old);
    assert_eq!(
        fs::read_to_string(skill.join(SOURCE_MARKER_FILE)).unwrap(),
        SOURCE_BUNDLED
    );
    assert_eq!(fs::read_dir(skill).unwrap().count(), 2);
    assert_eq!(
        serde_json::from_str::<Value>(&files["status.json"]).unwrap(),
        Value::Null
    );
    assert!(files["doctor.json"].contains("daemon.json not found"));
    let checks: Vec<Value> = serde_json::from_str(&files["doctor.json"]).unwrap();
    let home_check = checks
        .iter()
        .find(|c| c["name"] == "bsk home writable")
        .unwrap();
    assert_eq!(home_check["status"], "na");
    assert!(home_check["hint"].is_null());
    assert!(home_check["detail"].as_str().unwrap().contains("missing"));
    assert!(files["README.txt"].contains("status.json"));
    assert!(files["README.txt"].contains("no daemon log file found"));
    assert!(!files.contains_key("daemon-log.txt"));
    let meta: Value = serde_json::from_str(&files["metadata.json"]).unwrap();
    assert_eq!(meta["os"], std::env::consts::OS);
}

#[test]
fn log_and_doctor_errors_are_sanitized_in_the_archive() {
    let root = tempdir().unwrap();
    let home = root.path().join("bsk");
    fs::create_dir(&home).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&home, fs::Permissions::from_mode(0o750)).unwrap();
    }
    let update = json!({
        "source": "command", "from_version":"0.1.0", "target_version":"99.0.0",
        "executable":"bsk", "result":"failed", "started_at_epoch_secs":1, "updated_at_epoch_secs":1,
        "error":"download failed token=DEMO_UPDATE AUTH_TOKEN=Bearer DEMO_UPDATE_AUTH"
    });
    let log = concat!(
        "{\"token\": \"DEMO_TOKEN\"}\n",
        "{\"authorization\": \"Bearer DEMO_HEADER\"}\n",
        "token='DEMO_QUOTED'\n",
        "Cookie: a=DEMO_A; b=DEMO_B\n",
        "credentials=Basic DEMO_BASIC status=offline\n",
        "GITHUB_TOKEN=DEMO_GH MYSQL_PASSWORD=DEMO_DB 请求头Cookie: pref=DEMO_COOKIE\n",
        "{\"fields\":{\"smtpPassword\":\"DEMO_SMTP\",\"password_hash\":\"DEMO_HASH\",\"next_token\":\"DEMO_NEXT\",\"nextPageToken\":\"cursor-2\"}}\n",
        "{\"fields\":{\"message\":\"headers: {\\\"value\\\":\\\"k=DEMO_HEADER; b=DEMO_B\\\",\\\"name\\\":\\\"Set-Cookie\\\"} status=502\"}}\n",
        "refresh token: expired; retrying in 5s\n",
        "no token supplied; status=unhealthy\n"
    );
    fs::write(home.join("update-state.json"), update.to_string()).unwrap();
    fs::write(home.join("daemon.log.2026-01-02"), log).unwrap();
    fs::write(home.join("daemon.log.2026-01-01"), "older").unwrap();
    fs::write(home.join("daemon.log.private"), "DEMO_OTHER_FILE").unwrap();

    let files = export(&home);
    assert!(files.values().all(|s| !s.contains("DEMO_")));
    assert!(files["doctor.json"].contains("download failed token=[redacted]"));
    assert!(files["daemon-log.txt"].contains("no token supplied; status=unhealthy"));
    assert!(files["daemon-log.txt"].contains("Cookie: [redacted]"));
    assert!(files["daemon-log.txt"].contains("status=offline"));
    assert!(files["daemon-log.txt"].contains("status=502"));
    assert!(files["daemon-log.txt"].contains("retrying in 5s"));
    assert!(files["daemon-log.txt"].contains("cursor-2"));
    assert!(!home.join("run").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(home).unwrap().permissions().mode() & 0o777,
            0o750
        );
    }
}

#[test]
fn unreadable_sources_are_reported_and_the_dynamic_notes_are_sanitized() {
    let root = tempdir().unwrap();
    // A non-directory is reliably unreadable as a log directory, even as root.
    let home = root.path().join("token=DEMO_PATH");
    fs::write(&home, "keep").unwrap();
    let files = export(&home);
    assert!(files.values().all(|s| !s.contains("DEMO_PATH")));
    assert!(files["README.txt"].contains("daemon-log.txt unavailable"));
    assert!(files["README.txt"].contains("token=[redacted]"));
    assert_eq!(fs::read(home).unwrap(), b"keep");
}

#[test]
fn reports_invalid_metadata_without_replacing_it_or_starting_a_daemon() {
    let root = tempdir().unwrap();
    let home = root.path().join("bsk");
    fs::create_dir(&home).unwrap();
    let sources = ["daemon.json", "update-state.json", "settings.json"];
    for name in sources {
        fs::write(home.join(name), b"{").unwrap();
    }
    let files = export(&home);
    assert_eq!(files["status.json"], "null");
    assert!(files["doctor.json"].contains("update state unavailable"));
    assert!(files["doctor.json"].contains("settings.json unavailable"));
    assert!(files["doctor.json"].contains("read daemon discovery file"));
    for name in sources {
        assert_eq!(fs::read(home.join(name)).unwrap(), b"{");
    }
    assert!(!home.join("run").exists());
}

#[test]
fn oversized_log_omits_the_leading_fragment_and_caps_the_sanitized_bytes() {
    const LIMIT: usize = 4 * 1024 * 1024;
    let root = tempdir().unwrap();
    let home = root.path().join("bsk");
    fs::create_dir(&home).unwrap();
    // The input window begins inside the cookie. The next whole line fits
    // on disk, but [redacted] expands it past the output cap.
    let mut log = b"Cookie: ".to_vec();
    log.extend(std::iter::repeat_n(b'x', 1024));
    log.extend_from_slice(b"DEMO_FRAGMENT\n");
    log.extend(std::iter::repeat_n(b'a', LIMIT - 65));
    log.extend_from_slice(b" token=x token=y token=z token=q token=r token=s\nlast intact\n");
    fs::write(home.join("daemon.log"), log).unwrap();

    let files = export(&home);
    assert_eq!(files["daemon-log.txt"], "last intact\n");
    assert!(files["README.txt"].contains("truncated"));
}

#[test]
fn retains_the_latest_500_lines_without_replacing_existing_output() {
    let root = tempdir().unwrap();
    let home = root.path().join("bsk");
    fs::create_dir(&home).unwrap();
    let lines = (0..510).map(|n| format!("line {n}\n")).collect::<String>();
    fs::write(home.join("daemon.log"), lines).unwrap();
    let files = export(&home);
    assert_eq!(files["daemon-log.txt"].lines().count(), 500);
    assert!(files["daemon-log.txt"].starts_with("line 10\n"));
    assert!(files["daemon-log.txt"].ends_with("line 509\n"));
    assert!(files["README.txt"].contains("truncated"));

    let path = root.path().join("report.zip");
    fs::write(&path, b"existing bytes").unwrap();
    for (output, code) in [
        ("report.zip", "invalid_params"),
        ("no-parent/report.zip", "not_found"),
    ] {
        let retry = command(&home, output).output().unwrap();
        assert_eq!(retry.status.code(), Some(1));
        let error: Value = serde_json::from_slice(&retry.stdout).unwrap();
        assert_eq!(error["code"], code);
        assert_eq!(error["data"]["reason"], "local_file_error");
        assert!(error["hint"].as_str().unwrap().contains("--output"));
        assert!(!error["hint"].as_str().unwrap().contains("daemon"));
    }
    assert_eq!(fs::read(path).unwrap(), b"existing bytes");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_export_uses_one_status_snapshot_for_all_sessions() {
    use bsk::daemon::info::{DaemonInfo, write_to_path};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    let root = tempdir().unwrap();
    let home = root.path().join("bsk");
    fs::create_dir(&home).unwrap();
    let socket = home.join("daemon.sock");
    let pid = std::process::id();
    let info = DaemonInfo::now(pid, socket.clone(), 1234, env!("CARGO_PKG_VERSION"));
    write_to_path(&info, &home.join("daemon.json")).unwrap();
    fs::write(home.join("update-state.json"), b"{").unwrap();
    fs::write(
        home.join("daemon.log"),
        concat!(
            "{\"fields\":{\"session\":\"DEMO_SESSION_B\"}}\n",
            "{\"fields\":{\"session\":\"DEMO_SESSION_A\"}}\n",
            "{\"fields\":{\"session\":\"DEMO_ENDED\"}}\n",
            "session=DEMO_ENDED ended\n",
        ),
    )
    .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&calls);
    let server = crate::support::spawn_raw_ipc_server(&socket, move |req| {
        assert_eq!(req["method"], "system.status");
        assert!(req["params"]["wait_for_browser_ms"].is_null());
        count.fetch_add(1, Ordering::Relaxed);
        json!({"id":req["id"], "result":{
            "daemon_version":"0.1.0", "protocol_version":bsk::daemon::state::PROTOCOL_VERSION,
            "pid":pid, "uptime_secs":3, "ws_port":1234, "sock_path":"local",
            "browsers":[{"instance_id":"browser","browser_name":"Chrome","browser_version":"1",
                "extension_version":"1","label":"profile token=DEMO_LABEL","session_count":2}],
            "sessions":[
                {"session_id":"DEMO_SESSION_A","browser_instance_id":"browser","created_at_ms":1},
                {"session_id":"DEMO_SESSION_B","browser_instance_id":"browser","created_at_ms":2}
            ]
        }})
    });
    let files = tokio::task::spawn_blocking(move || {
        let files = export(&home);
        // A refused second export must not probe this daemon again.
        assert_eq!(
            command(&home, "report.zip").output().unwrap().status.code(),
            Some(1)
        );
        files
    })
    .await
    .unwrap();
    server.abort();
    let status: Value = serde_json::from_str(&files["status.json"]).unwrap();
    assert_eq!(status["pid"], pid, "{}", files["doctor.json"]);
    assert_eq!(status["sessions"].as_array().unwrap().len(), 2);
    let a = status["sessions"][0]["session_id"].as_str().unwrap();
    let b = status["sessions"][1]["session_id"].as_str().unwrap();
    assert_ne!(a, b);
    let mut log = files["daemon-log.txt"].lines();
    let mut log_session = || {
        serde_json::from_str::<Value>(log.next().unwrap()).unwrap()["fields"]["session"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(log_session(), b);
    assert_eq!(log_session(), a);
    let ended = log_session();
    assert_ne!(ended, a);
    assert_eq!(log.next().unwrap(), format!("session={ended} ended"));
    let checks: Vec<Value> = serde_json::from_str(&files["doctor.json"]).unwrap();
    let update = checks.iter().find(|c| c["name"] == "auto-update").unwrap();
    assert_eq!(update["status"], "warn");
    let detail = update["detail"].as_str().unwrap();
    assert!(detail.contains("daemon runs bsk 0.1.0"));
    assert!(detail.contains("update state unavailable"));
    assert!(!detail.contains("no update attempt recorded"));
    assert_eq!(status["browsers"][0]["label"], "profile token=[redacted]");
    assert!(files.values().all(|s| !s.contains("DEMO_")));
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}
