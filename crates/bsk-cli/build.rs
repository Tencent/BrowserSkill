//! Embed the canonical skill directory, including resources, without modifying sources.

use std::{env, fs, path::Path};

fn collect(root: &Path, dir: &Path, files: &mut Vec<String>) {
    println!("cargo:rerun-if-changed={}", dir.display());
    for entry in fs::read_dir(dir).expect("read skill directory") {
        let entry = entry.expect("read skill entry");
        let kind = entry.file_type().expect("read skill file type");
        let path = entry.path();
        if kind.is_dir() {
            collect(root, &path, files);
        } else {
            assert!(kind.is_file(), "skill resources must be regular files");
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            assert!(
                !name.split('/').any(|part| part.starts_with('.')),
                "hidden skill resource"
            );
            files.push(name);
        }
    }
}

fn emit_build_revision() {
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
}

fn main() {
    emit_build_revision();
    println!("cargo:rerun-if-changed=build.rs");
    let manifest = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let root = Path::new(&manifest).join("skill");
    let mut files = Vec::new();
    collect(&root, &root, &mut files);
    files.sort();
    assert!(
        files.iter().any(|name| name == "SKILL.md"),
        "missing SKILL.md"
    );
    let mut output = String::from("pub const BUNDLED_FILES: &[(&str, &[u8])] = &[\n");
    for name in files {
        output.push_str(&format!(
            "({name:?}, include_bytes!({:?})),\n",
            root.join(&name)
        ));
    }
    output.push_str("];\n");
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("skill_bundle.rs"),
        output,
    )
    .expect("generate embedded skill bundle");
}
