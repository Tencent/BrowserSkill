//! Keep the packaged `skill/SKILL.md` in sync with the repo-root skill during dev builds.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let revision = std::process::Command::new("git")
        .args(["describe", "--always", "--dirty"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=BSK_BUILD_REVISION={revision}");
    if let Ok(output) = std::process::Command::new("git")
        .args(["rev-parse", "--git-path", "HEAD"])
        .output()
    {
        println!(
            "cargo:rerun-if-changed={}",
            String::from_utf8_lossy(&output.stdout).trim()
        );
    }
    if let Ok(reference) = std::process::Command::new("git")
        .args(["symbolic-ref", "-q", "HEAD"])
        .output()
        && reference.status.success()
        && let Ok(output) = std::process::Command::new("git")
            .args([
                "rev-parse",
                "--git-path",
                String::from_utf8_lossy(&reference.stdout).trim(),
            ])
            .output()
    {
        println!(
            "cargo:rerun-if-changed={}",
            String::from_utf8_lossy(&output.stdout).trim()
        );
    }
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let src = manifest.join("../../skill/SKILL.md");
    let dst = manifest.join("skill/SKILL.md");

    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed=build.rs");

    if !src.is_file() {
        // `cargo package` on crates.io ships `skill/SKILL.md` committed in-tree.
        return;
    }

    // The repo-root skill may be a symlink to the packaged skill.
    // Avoid copying a file onto itself through the symlink.
    if let (Ok(src_real), Ok(dst_real)) = (src.canonicalize(), dst.canonicalize()) {
        if src_real == dst_real {
            return;
        }
    }

    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).expect("create skill/ directory");
    }
    fs::copy(&src, &dst).expect("sync skill/SKILL.md from repo root");
}
