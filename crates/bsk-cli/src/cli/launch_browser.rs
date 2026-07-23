//! Best-effort launch of a supported browser when `bsk session start`
//! fails with `no_browser_connected`.
//!
//! When the daemon reports that no browser extension is connected, it is
//! often simply because the browser process is not running, so the
//! BrowserSkill extension's background worker never started. Spawning the
//! browser lets an already-installed extension connect to the daemon, after
//! which the `session.start` retry succeeds. If the browser cannot be
//! launched (not installed), the caller surfaces the usual "install the
//! extension" hint instead.

use std::process::Command;
use std::time::Duration;

/// How long to wait, after launching the browser, for the extension to
/// reconnect to the daemon before giving up and showing the install hint.
pub const POST_LAUNCH_CONNECT_WAIT: Duration = Duration::from_secs(20);

/// Try to bring a supported browser online so the BrowserSkill extension
/// can connect to the daemon.
///
/// Returns `Ok(())` when a supported browser is already running or was
/// successfully launched, and `Err(_)` when no supported browser could be
/// found or started (the caller should then tell the user to install the
/// extension).
pub fn attempt_launch_browser() -> Result<(), String> {
    if is_any_supported_browser_running() {
        // Already running: the missing connection is an extension-level
        // problem (not installed / disabled), not a missing process, so
        // launching another instance would not help.
        return Ok(());
    }
    launch_default_browser()
}

/// Whether any supported browser process appears to be running.
#[cfg(unix)]
fn is_any_supported_browser_running() -> bool {
    let patterns: &[&str] = if cfg!(target_os = "macos") {
        &[
            "Google Chrome",
            "Chromium",
            "Microsoft Edge",
            "Brave Browser",
        ]
    } else {
        &["chrome", "chromium", "msedge", "brave"]
    };
    patterns.iter().any(|pattern| {
        Command::new("pgrep")
            .args(["-f", "-i", pattern])
            .output()
            .map(|out| {
                let stdout = String::from_utf8_lossy(&out.stdout);
                out.status.success() && !stdout.trim().is_empty()
            })
            .unwrap_or(false)
    })
}

#[cfg(windows)]
fn is_any_supported_browser_running() -> bool {
    const EXES: &[&str] = &["chrome.exe", "msedge.exe", "brave.exe"];
    EXES.iter().any(|exe| {
        Command::new("tasklist")
            .args(["/fi", &format!("IMAGENAME eq {exe}")])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).contains(exe))
            .unwrap_or(false)
    })
}

/// Launch the first supported browser found on the system.
#[cfg(target_os = "macos")]
fn launch_default_browser() -> Result<(), String> {
    const NAMES: &[&str] = &[
        "Google Chrome",
        "Google Chrome Canary",
        "Chromium",
        "Microsoft Edge",
        "Brave Browser",
    ];
    for name in NAMES {
        if Command::new("open")
            .args(["-a", name])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Ok(());
        }
    }
    Err("no supported browser found (install Chrome, Chromium, Edge, or Brave)".into())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn launch_default_browser() -> Result<(), String> {
    const NAMES: &[&str] = &[
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
        "brave-browser",
    ];
    for name in NAMES {
        // `spawn` returns immediately for a GUI browser; we intentionally
        // detach (drop the child handle) so the CLI call returns at once.
        if Command::new(name).arg("about:blank").spawn().is_ok() {
            return Ok(());
        }
    }
    Err("no supported browser found on PATH (install Chrome, Chromium, Edge, or Brave)".into())
}

#[cfg(windows)]
fn launch_default_browser() -> Result<(), String> {
    const EXES: &[&str] = &["chrome", "msedge", "brave"];
    for exe in EXES {
        if Command::new("cmd")
            .args(["/c", "start", "", exe])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Ok(());
        }
    }
    Err("no supported browser found (install Chrome, Chromium, Edge, or Brave)".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_launch_connect_wait_is_positive() {
        assert!(POST_LAUNCH_CONNECT_WAIT.as_secs() > 0);
    }
}
