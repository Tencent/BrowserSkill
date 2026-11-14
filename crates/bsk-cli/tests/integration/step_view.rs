//! Public CLI contracts that must work (or fail locally) without any browser/daemon.
use serde_json::{Value, json};
use std::process::Command;
fn command(home: &std::path::Path) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_bsk"));
    c.env("BSK_HOME", home)
        .env("BSK_AUTO_START", "0")
        .env("BSK_AUTO_UPDATE", "off");
    c
}
#[test]
fn local_view_never_starts_or_requires_a_daemon_and_keeps_duplicate_matches() {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("no-daemon");
    let file = d.path().join("saved.json");
    std::fs::write(&file,serde_json::to_vec(&json!({"context_id":"historical","tab_id":42,"observation":{"text":"@vom 1\n@e1 button \"A\"\n@e2 button \"A\"","truncated":false}})).unwrap()).unwrap();
    let out = command(&home)
        .args([
            "view",
            file.to_str().unwrap(),
            "--find",
            "button",
            "--line-count",
            "2",
            "--json",
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["browser_calls"], 0);
    assert_eq!(v["historical"], true);
    assert!(v.get("context_id").is_none());
    assert_eq!(v["matching_lines"], json!([2, 3]));
    assert_eq!(v["partial_view"], true);
    assert!(!home.exists());
}
#[test]
fn malformed_action_fails_before_any_runtime_or_output_is_created() {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("no-daemon");
    let file = d.path().join("out.json");
    let out = command(&home)
        .args([
            "step",
            "--session",
            "s",
            "--action",
            "click",
            "--params",
            r#"{"ref":"e1","typo":1}"#,
            "--save-full",
            file.to_str().unwrap(),
            "--json",
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(v["message"].as_str().unwrap().contains("typo"));
    assert!(!file.exists());
    assert!(!home.exists());
}
#[test]
fn existing_step_output_fails_locally_and_is_not_overwritten() {
    let d = tempfile::tempdir().unwrap();
    let home = d.path().join("no-daemon");
    let file = d.path().join("out.json");
    std::fs::write(&file, "previous result").unwrap();
    let out = command(&home)
        .args([
            "step",
            "--session",
            "s",
            "--action",
            "click",
            "--params",
            r#"{"ref":"e1"}"#,
            "--save-full",
            file.to_str().unwrap(),
            "--json",
        ])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert_eq!(std::fs::read_to_string(file).unwrap(), "previous result");
    assert!(!home.exists());
}
