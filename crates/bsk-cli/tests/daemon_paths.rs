//! Path resolution stays compatible; failures identify the directory and repair action.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

use tempfile::TempDir;

#[test]
fn home_resolution_preserves_platform_defaults_and_explicit_overrides() {
    const CHILD: &str = "BSK_PATH_RESOLUTION_TEST";
    if std::env::var_os(CHILD).is_some() {
        let expected = std::env::var("BSK_HOME")
            .ok()
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".bsk")))
            .unwrap();
        assert_eq!(bsk::daemon::paths::bsk_home().unwrap(), expected);
        return;
    }
    // Use child environments so no test can change another test's HOME.
    // Resolve only: do not prepare or write to the account's real home.
    let temp = TempDir::new().unwrap();
    for home in [None, Some(Path::new("")), Some(temp.path())] {
        for bsk_home in [None, Some(Path::new("")), Some(temp.path())] {
            let mut child = Command::new(std::env::current_exe().unwrap());
            child
                .args([
                    "--exact",
                    "home_resolution_preserves_platform_defaults_and_explicit_overrides",
                ])
                .env(CHILD, "1")
                .env_remove("HOME")
                .env_remove("BSK_HOME");
            if let Some(home) = home {
                child.env("HOME", home);
            }
            if let Some(home) = bsk_home {
                child.env("BSK_HOME", home);
            }
            let out = child.output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stdout)
            );
        }
    }
}

#[test]
fn doctor_reports_unwritable_resolved_home_without_changing_resolution() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping permission denial check for root");
        return;
    }
    for explicit in [false, true] {
        let temp = TempDir::new().unwrap();
        let blocked = temp.path().join("blocked");
        std::fs::create_dir(&blocked).unwrap();
        let home = blocked.join(".bsk");
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o500)).unwrap();
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bsk"));
        cmd.args(["--json", "doctor"])
            .env("HOME", &blocked)
            .env_remove("BSK_HOME")
            .env("BSK_AUTO_START", "0")
            .env("BSK_AUTO_UPDATE", "off")
            .env("BSK_DOCTOR_BROWSER_WAIT_MS", "0");
        if explicit {
            cmd.env("BSK_HOME", &home);
        }
        let out = cmd.output().unwrap();
        std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(!out.status.success());
        let checks: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
        let check = checks
            .iter()
            .find(|c| c["name"] == "bsk home writable")
            .unwrap();
        assert_eq!(check["status"], "fail");
        let detail = check["detail"].as_str().unwrap();
        assert!(detail.contains(home.to_str().unwrap()), "{detail}");
        assert!(detail.contains("create bsk home"), "{detail}");
        assert!(detail.contains("Permission denied"), "{detail}");
        assert!(
            detail.contains(if explicit {
                "from BSK_HOME"
            } else {
                "from platform home lookup"
            }),
            "{detail}"
        );
        assert!(check["hint"].as_str().unwrap().contains("BSK_HOME"));
        assert!(
            !home.exists(),
            "must not create a daemon home or fall back elsewhere"
        );
    }
}

#[test]
fn inaccessible_discovery_reports_the_path_and_bsk_home_hint() {
    if unsafe { libc::geteuid() } == 0 {
        eprintln!("skipping permission denial check for root");
        return;
    }
    let temp = TempDir::new().unwrap();
    let blocked = temp.path().join("blocked");
    std::fs::create_dir(&blocked).unwrap();
    let home = blocked.join("bsk");
    std::fs::create_dir(&home).unwrap();
    let info = home.join("daemon.json");
    let original = b"inaccessible discovery must not be parsed or removed";
    std::fs::write(&info, original).unwrap();
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o0)).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .args(["--json", "status"])
        .env("BSK_HOME", &home)
        .env("BSK_AUTO_START", "0")
        .env("BSK_AUTO_UPDATE", "off")
        .output()
        .unwrap();
    std::fs::set_permissions(&blocked, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(!out.status.success());
    let error = String::from_utf8_lossy(&out.stdout);
    assert!(error.contains(info.to_str().unwrap()), "{error}");
    assert!(error.contains("Permission denied"), "{error}");
    assert!(error.contains("set BSK_HOME"), "{error}");
    assert!(
        !error.contains("automatic daemon startup is disabled"),
        "{error}"
    );
    assert_eq!(std::fs::read(info).unwrap(), original);
    assert!(!home.join("daemon.lock").exists());
}
