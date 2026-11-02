//! Releases of the bsk under test for update tests. A release must report the
//! version its manifest names, so tests serve a copy whose version string is
//! replaced by a newer one of the same length.

#![allow(dead_code)]

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// Builds once per test process: each fixture takes seconds on Windows.
fn cached(key: &str, build: impl FnOnce() -> Vec<u8>) -> Vec<u8> {
    static BUILT: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    let built = BUILT.get_or_init(Default::default);
    if let Some(binary) = built.lock().unwrap().get(key) {
        return binary.clone();
    }
    let binary = build();
    built
        .lock()
        .unwrap()
        .insert(key.to_string(), binary.clone());
    binary
}

/// Newer than the bsk under test and of the same length: every digit becomes
/// 9, so `0.3.1` becomes `9.9.9`.
pub fn newer_version() -> String {
    let current = env!("CARGO_PKG_VERSION");
    let newer: String = current
        .chars()
        .map(|c| if c.is_ascii_digit() { '9' } else { c })
        .collect();
    assert_ne!(newer, current, "the bsk under test is already {current}");
    newer
}

/// The bsk under test, reporting [`newer_version`]. On macOS the copy is
/// signed again (ad hoc), since the kernel refuses modified signed code.
pub fn newer_bsk(dir: &Path) -> Vec<u8> {
    cached("newer bsk", || build_newer_bsk(dir))
}

fn build_newer_bsk(dir: &Path) -> Vec<u8> {
    let current = env!("CARGO_PKG_VERSION").as_bytes();
    let newer = newer_version();
    let original = fs::read(env!("CARGO_BIN_EXE_bsk")).unwrap();
    let mut binary = Vec::with_capacity(original.len());
    let mut rest = original.as_slice();
    while let Some(at) = rest
        .windows(current.len())
        .position(|window| window == current)
    {
        binary.extend_from_slice(&rest[..at]);
        binary.extend_from_slice(newer.as_bytes());
        rest = &rest[at + current.len()..];
    }
    binary.extend_from_slice(rest);
    assert_ne!(binary, original, "the version string was not found");
    resign(dir, binary)
}

#[cfg(target_os = "macos")]
fn resign(dir: &Path, binary: Vec<u8>) -> Vec<u8> {
    let path = dir.join("newer-bsk");
    fs::write(&path, binary).unwrap();
    let status = std::process::Command::new("codesign")
        .args(["--force", "--sign", "-"])
        .arg(&path)
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "codesign {}", path.display());
    fs::read(path).unwrap()
}

#[cfg(not(target_os = "macos"))]
fn resign(_dir: &Path, binary: Vec<u8>) -> Vec<u8> {
    binary
}

/// Compile a stand-in for a broken release from the body of its `main`.
pub fn compiled(dir: &Path, name: &str, main: &str) -> Vec<u8> {
    cached(&format!("compiled {name}"), || compile(dir, name, main))
}

fn compile(dir: &Path, name: &str, main: &str) -> Vec<u8> {
    let source = dir.join(format!("{name}.rs"));
    fs::write(&source, format!("fn main() {{ {main} }}")).unwrap();
    let output = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let status = std::process::Command::new(rustc)
        .args(["--edition", "2021", "-o"])
        .arg(&output)
        .arg(&source)
        .status()
        .unwrap();
    assert!(status.success(), "compile {name}");
    fs::read(output).unwrap()
}
