//! Keep the packaged `skill/SKILL.md` in sync with the repo-root skill during dev builds.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
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
