//! Per-user Windows logon autostart for the foreground daemon.
//!
//! The launcher is deliberately a tiny, pure-ASCII VBScript in the user's
//! Startup folder.  VBScript is read using the user's legacy code page on
//! some Windows installations, so non-ASCII executable paths are represented
//! with `ChrW` expressions instead of being written as source text.

#[cfg(any(windows, test))]
use std::io::Write;
#[cfg(any(windows, test))]
use std::path::Path;

#[cfg(windows)]
use std::path::PathBuf;

use anyhow::{Result, bail};

#[cfg(any(windows, test))]
use anyhow::Context;

#[cfg(any(windows, test))]
const AUTOSTART_FILE_NAME: &str = "bsk-daemon-autostart.vbs";
#[cfg(any(windows, test))]
const MANAGED_MARKER: &str = "' browser-skill managed autostart v1";

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallOutcome {
    Installed,
    Updated,
    AlreadyInstalled,
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UninstallOutcome {
    Removed,
    AlreadyAbsent,
}

/// Install the launcher for the current user.
#[cfg(windows)]
pub fn install() -> Result<()> {
    let startup = startup_dir()?;
    let executable = std::env::current_exe().context("locate bsk executable")?;
    let destination = startup.join(AUTOSTART_FILE_NAME);
    match install_at(&startup, &executable)? {
        InstallOutcome::Installed => {
            println!("installed daemon autostart: {}", destination.display())
        }
        InstallOutcome::Updated => println!("updated daemon autostart: {}", destination.display()),
        InstallOutcome::AlreadyInstalled => {
            println!(
                "daemon autostart already installed: {}",
                destination.display()
            )
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn install() -> Result<()> {
    bail!("daemon autostart is currently supported on Windows only")
}

/// Remove the launcher installed by [`install`].
#[cfg(windows)]
pub fn uninstall() -> Result<()> {
    let startup = startup_dir()?;
    let destination = startup.join(AUTOSTART_FILE_NAME);
    match uninstall_at(&startup)? {
        UninstallOutcome::Removed => {
            println!("removed daemon autostart: {}", destination.display())
        }
        UninstallOutcome::AlreadyAbsent => {
            println!("daemon autostart already absent: {}", destination.display())
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn uninstall() -> Result<()> {
    bail!("daemon autostart is currently supported on Windows only")
}

#[cfg(windows)]
fn startup_dir() -> Result<PathBuf> {
    dirs::data_dir()
        .map(|data| data.join("Microsoft\\Windows\\Start Menu\\Programs\\Startup"))
        .context("locate the per-user Windows Startup folder")
}

#[cfg(any(windows, test))]
fn install_at(startup: &Path, executable: &Path) -> Result<InstallOutcome> {
    std::fs::create_dir_all(startup)
        .with_context(|| format!("create Startup folder {}", startup.display()))?;
    let destination = startup.join(AUTOSTART_FILE_NAME);
    let script = render_script(executable);
    let had_existing = destination.exists();

    if had_existing {
        let existing = std::fs::read(&destination)
            .with_context(|| format!("read existing autostart file {}", destination.display()))?;
        if !existing.starts_with(MANAGED_MARKER.as_bytes()) {
            bail!(
                "refusing to overwrite unmanaged autostart file {}",
                destination.display()
            );
        }
        if existing == script.as_bytes() {
            return Ok(InstallOutcome::AlreadyInstalled);
        }
    }

    // Write beside the destination first so an interrupted render never leaves
    // a partial VBScript. Windows rename cannot replace an existing file, so a
    // managed destination is removed immediately before the final rename.
    let mut temp = tempfile::Builder::new()
        .prefix("bsk-daemon-autostart-")
        .suffix(".tmp")
        .tempfile_in(startup)
        .with_context(|| format!("create autostart temporary file in {}", startup.display()))?;
    temp.write_all(script.as_bytes())
        .with_context(|| format!("write autostart temporary file in {}", startup.display()))?;
    temp.as_file()
        .sync_all()
        .with_context(|| format!("flush autostart temporary file in {}", startup.display()))?;
    if destination.exists() {
        std::fs::remove_file(&destination)
            .with_context(|| format!("replace managed autostart file {}", destination.display()))?;
    }
    temp.persist(&destination)
        .map_err(|error| error.error)
        .with_context(|| format!("install autostart file {}", destination.display()))?;

    Ok(if had_existing {
        InstallOutcome::Updated
    } else {
        InstallOutcome::Installed
    })
}

#[cfg(any(windows, test))]
fn uninstall_at(startup: &Path) -> Result<UninstallOutcome> {
    let destination = startup.join(AUTOSTART_FILE_NAME);
    if !destination.exists() {
        return Ok(UninstallOutcome::AlreadyAbsent);
    }
    let existing = std::fs::read(&destination)
        .with_context(|| format!("read autostart file {}", destination.display()))?;
    if !existing.starts_with(MANAGED_MARKER.as_bytes()) {
        bail!(
            "refusing to remove unmanaged autostart file {}",
            destination.display()
        );
    }
    std::fs::remove_file(&destination)
        .with_context(|| format!("remove autostart file {}", destination.display()))?;
    Ok(UninstallOutcome::Removed)
}

#[cfg(any(windows, test))]
fn render_script(executable: &Path) -> String {
    let executable = executable.to_string_lossy();
    format!(
        "{MANAGED_MARKER}\r\nOption Explicit\r\nDim sh\r\nSet sh = CreateObject(\"WScript.Shell\")\r\nsh.Run ChrW(34) & {} & ChrW(34) & \" daemon start --foreground\", 0, False\r\n",
        vbs_string_expression(&executable)
    )
}

#[cfg(any(windows, test))]
fn vbs_string_expression(value: &str) -> String {
    let mut terms = Vec::new();
    let mut ascii = String::new();
    let flush_ascii = |terms: &mut Vec<String>, ascii: &mut String| {
        if !ascii.is_empty() {
            terms.push(format!("\"{ascii}\""));
            ascii.clear();
        }
    };

    for unit in value.encode_utf16() {
        if (0x20..=0x7e).contains(&unit) && unit != b'"' as u16 {
            ascii.push(char::from_u32(unit as u32).expect("ASCII UTF-16 unit"));
        } else {
            flush_ascii(&mut terms, &mut ascii);
            terms.push(format!("ChrW({unit})"));
        }
    }
    flush_ascii(&mut terms, &mut ascii);
    if terms.is_empty() {
        "\"\"".to_string()
    } else {
        terms.join(" & ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn script_is_ascii_and_starts_foreground_daemon() {
        let script = render_script(Path::new(r"C:\Program Files\BrowserSkill\bsk.exe"));
        assert!(script.is_ascii());
        assert!(script.contains(MANAGED_MARKER));
        assert!(script.contains("daemon start --foreground"));
        assert!(script.contains("WScript.Shell"));
        assert!(script.contains("ChrW(34)"));
    }

    #[test]
    fn unicode_executable_path_is_encoded_without_non_ascii_source() {
        let path = format!(
            r"C:\Users\{}{}\{}{}\bsk.exe",
            '\u{7528}', '\u{6237}', '\u{684c}', '\u{9762}'
        );
        let script = render_script(Path::new(&path));
        assert!(script.is_ascii());
        assert!(script.contains("ChrW(29992)"));
        assert!(script.contains("ChrW(25143)"));
    }

    #[test]
    fn install_and_uninstall_are_idempotent_and_protect_unmanaged_files() {
        let temp = TempDir::new().unwrap();
        let executable = temp.path().join("bsk.exe");
        assert_eq!(
            install_at(temp.path(), &executable).unwrap(),
            InstallOutcome::Installed
        );
        assert_eq!(
            install_at(temp.path(), &executable).unwrap(),
            InstallOutcome::AlreadyInstalled
        );
        let replacement = temp.path().join("other-bsk.exe");
        assert_eq!(
            install_at(temp.path(), &replacement).unwrap(),
            InstallOutcome::Updated
        );
        assert_eq!(
            uninstall_at(temp.path()).unwrap(),
            UninstallOutcome::Removed
        );
        assert_eq!(
            uninstall_at(temp.path()).unwrap(),
            UninstallOutcome::AlreadyAbsent
        );
        std::fs::write(temp.path().join(AUTOSTART_FILE_NAME), "user launcher").unwrap();
        assert!(install_at(temp.path(), &executable).is_err());
        assert!(uninstall_at(temp.path()).is_err());
    }
}
