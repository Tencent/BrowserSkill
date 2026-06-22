//! Smoke-test the §3.1 exit code mapping through the real binary.

#![cfg(unix)]

use std::path::PathBuf;
use std::process::Command;

fn bsk_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_bsk"))
}

#[test]
fn clap_usage_error_maps_to_user_error_exit_code() {
    // §3.1 maps argument/usage failures to the user-error bucket.
    let out = Command::new(bsk_bin())
        .args(["definitely-not-a-subcommand"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert_eq!(out.status.code(), Some(1));
}

#[test]
fn version_flag_prints_semver_and_exits_zero() {
    let out = Command::new(bsk_bin())
        .args(["--version"])
        .output()
        .unwrap();
    assert!(out.status.success());
    let body = String::from_utf8(out.stdout).unwrap();
    assert!(
        body.trim_end().starts_with("bsk "),
        "expected `bsk <version>` line, got: {body:?}"
    );
}
