//! Process-level coverage of argument errors, output streams, and exit codes.

use std::path::Path;
use std::process::{Command, Output};

use serde_json::Value;

/// clap names the binary after argv[0]: `bsk.exe` on Windows.
fn usage(rest: &str) -> String {
    let bin = Path::new(env!("CARGO_BIN_EXE_bsk"))
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    format!("Usage: {bin} {rest}")
}

fn bsk(args: &[&str]) -> Output {
    let home = tempfile::tempdir().unwrap();
    Command::new(env!("CARGO_BIN_EXE_bsk"))
        .args(args)
        .env("BSK_HOME", home.path())
        .env("BSK_AUTO_UPDATE", "off")
        .env("NO_COLOR", "1")
        .output()
        .expect("run bsk")
}

fn json_usage_error(output: &Output) -> Value {
    assert_eq!(output.status.code(), Some(1));
    assert!(
        output.stderr.is_empty(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let error: Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|err| {
        panic!(
            "expected JSON error: {err}; stdout: {}",
            String::from_utf8_lossy(&output.stdout)
        )
    });
    assert_eq!(error["code"], "invalid_params");
    assert_eq!(error["exit_code"], 1);
    assert_eq!(error["data"]["reason"], "cli_parse_error");
    let message = error["message"].as_str().unwrap();
    assert!(!message.is_empty());
    assert!(
        !message.contains('\n'),
        "message should be one line: {message:?}"
    );
    assert!(!message.starts_with("error:"), "{message:?}");
    assert!(!message.contains('\x1b'), "{message:?}");
    let details = error["data"]["details"].as_str().unwrap();
    assert!(!details.is_empty());
    assert!(!details.contains('\x1b'), "{details:?}");
    assert!(!error["hint"].as_str().unwrap().is_empty());
    assert!(error.get("error").is_none(), "keep the flat error contract");
    error
}

#[test]
fn misplaced_session_and_tab_flags_report_json_and_position_guidance() {
    for args in [
        vec!["--session", "s1", "click", "--selector", "#submit"],
        vec!["--session=s1", "click", "--selector", "#submit"],
        vec!["--tab-id", "7", "click", "--session", "s1"],
        vec!["--tab-id=7", "click", "--session", "s1"],
        vec!["tab", "--session", "s1", "list"],
    ] {
        // clap can stop before it reaches --json. Both placements must work.
        for json_first in [true, false] {
            let mut argv = args.clone();
            if json_first {
                argv.insert(0, "--json");
            } else {
                argv.push("--json");
            }
            let error = json_usage_error(&bsk(&argv));
            let hint = error["hint"].as_str().unwrap();
            assert!(hint.contains("after"), "{hint}");
            assert!(hint.contains("bsk click --session"), "{hint}");
            let message = error["message"].as_str().unwrap();
            assert!(message.starts_with("unexpected argument '--"), "{message}");
            let details = error["data"]["details"].as_str().unwrap();
            assert!(details.contains(hint), "{details}");
            assert!(!details.contains("--version"), "{details}");
        }
    }
}

#[test]
fn all_argument_failures_use_the_json_contract() {
    for args in [
        vec!["--json", "click"],              // missing required session
        vec!["click", "--json", "--session"], // missing option value
        vec!["click", "--session", "s1", "--tab-id", "bad", "--json"],
        vec!["click", "--session", "s1", "--button", "bad", "--json"],
        vec!["unknown-command", "--json"],
        vec!["status", "--unknown", "--json"],
        vec!["--json"],        // missing command
        vec!["tab", "--json"], // missing nested command
        vec!["--json", "tab"], // bare subcommand group renders help
        vec!["--quiet", "--json", "click"],
        vec!["--json", "--json", "status"], // conflicting flag
    ] {
        json_usage_error(&bsk(&args));
    }
}

#[test]
fn json_message_is_the_clap_summary_and_details_keep_the_full_text() {
    let missing = json_usage_error(&bsk(&["--json", "click"]));
    assert_eq!(
        missing["message"],
        "the following required arguments were not provided: --session <SESSION>"
    );
    assert!(
        missing["data"]["details"]
            .as_str()
            .unwrap()
            .contains(&usage("click --session <SESSION>"))
    );

    let invalid = json_usage_error(&bsk(&[
        "click",
        "--session",
        "s1",
        "--button",
        "bad",
        "--json",
    ]));
    assert_eq!(
        invalid["message"],
        "invalid value 'bad' for '--button <BUTTON>' [possible values: left, middle, right]"
    );

    let typo = json_usage_error(&bsk(&["clik", "--json"]));
    assert_eq!(typo["message"], "unrecognized subcommand 'clik'");
    assert!(
        typo["data"]["details"]
            .as_str()
            .unwrap()
            .contains("a similar subcommand exists: 'click'")
    );

    let bare_group = json_usage_error(&bsk(&["--json", "tab"]));
    assert_eq!(
        bare_group["message"],
        "a subcommand is required but one was not provided"
    );
    assert!(
        bare_group["data"]["details"]
            .as_str()
            .unwrap()
            .contains(&usage("tab"))
    );
}

#[test]
fn json_errors_stay_plain_text_when_color_is_forced() {
    let home = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .args(["--session", "s1", "click", "--json"])
        .env("BSK_HOME", home.path())
        .env("BSK_AUTO_UPDATE", "off")
        .env_remove("NO_COLOR")
        .env("CLICOLOR_FORCE", "1")
        .output()
        .unwrap();
    json_usage_error(&output);
}

#[test]
fn invalid_tab_value_keeps_its_diagnostic_without_a_position_hint() {
    let error = json_usage_error(&bsk(&[
        "click",
        "--session",
        "s1",
        "--tab-id",
        "bad",
        "--json",
    ]));
    assert!(error["message"].as_str().unwrap().contains("bad"));
    assert!(error["hint"].as_str().unwrap().contains("--help"));
    assert!(!error["hint"].as_str().unwrap().contains("after"));
}

#[cfg(unix)]
#[test]
fn non_utf8_arguments_still_produce_a_json_error() {
    use std::os::unix::ffi::OsStringExt;

    let home = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .args(["click", "--session"])
        .arg(std::ffi::OsString::from_vec(vec![0xff]))
        .arg("--json")
        .env("BSK_HOME", home.path())
        .env("BSK_AUTO_UPDATE", "off")
        .output()
        .unwrap();
    json_usage_error(&output);
}

#[test]
fn human_usage_errors_keep_stderr_and_replace_the_misleading_suggestion() {
    for (args, usage) in [
        (
            vec!["--session", "s1", "click"],
            usage("[OPTIONS] <COMMAND>"),
        ),
        (vec!["--tab-id", "7", "click"], usage("[OPTIONS] <COMMAND>")),
        (
            vec!["tab", "--session", "s1", "list"],
            usage("tab [OPTIONS] <COMMAND>"),
        ),
    ] {
        let output = bsk(&args);
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("unexpected argument"), "{stderr}");
        assert!(stderr.contains("tip: --session and --tab-id"), "{stderr}");
        assert!(stderr.contains("bsk click --session"), "{stderr}");
        assert!(stderr.contains(&usage), "{stderr}");
        // clap's did-you-mean pointed `--session` at `--version` (#387).
        assert!(!stderr.contains("--version"), "{stderr}");
    }
    let output = bsk(&["click"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("--session")
    );
}

#[test]
fn help_and_version_remain_successful_text_even_with_json() {
    for args in [
        vec!["--help"],
        vec!["--json", "--help"],
        vec!["click", "--json", "--help"],
        vec!["--json", "tab", "list", "--help"],
        vec!["--json", "help", "click"],
        vec!["--version"],
        vec!["--json", "--version"],
    ] {
        let output = bsk(&args);
        assert!(output.status.success(), "{args:?}: {output:?}");
        assert!(output.stderr.is_empty());
        assert!(String::from_utf8(output.stdout).unwrap().contains("bsk"));
    }
}

#[test]
fn json_inside_a_value_or_after_double_dash_does_not_select_json_output() {
    for args in [
        vec!["click", "--", "--json"],
        vec!["click", "--selector=--json"],
        vec!["click", "--selector=#submit --json"],
    ] {
        let output = bsk(&args);
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty(), "{args:?}: {output:?}");
        assert!(!output.stderr.is_empty());
    }
    json_usage_error(&bsk(&["--json", "click", "--", "--json"]));
}

#[test]
fn redirected_stdout_contains_a_complete_json_error() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("error.json");
    let output = Command::new(env!("CARGO_BIN_EXE_bsk"))
        .args([
            "--session",
            "s1",
            "click",
            "--selector",
            "#submit",
            "--json",
        ])
        .env("BSK_HOME", home.path())
        .env("BSK_AUTO_UPDATE", "off")
        .env("NO_COLOR", "1")
        .stdout(std::fs::File::create(&path).unwrap())
        .output()
        .unwrap();
    json_usage_error(&Output {
        stdout: std::fs::read(path).unwrap(),
        ..output
    });
    assert!(!home.path().join("daemon.json").exists());
}
