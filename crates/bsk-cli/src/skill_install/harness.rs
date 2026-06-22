//! Agent harness identifiers, install paths, and local detection heuristics.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use serde::Serialize;

use super::SKILL_DIR_NAME;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessId {
    Codex,
    CodexInternal,
    ClaudeCode,
    ClaudeCodeInternal,
    Cursor,
    Openclaw,
    OpenclawInternal,
    Codebuddy,
    Workbuddy,
    PiAgent,
    Hermes,
}

impl HarnessId {
    pub const ALL: &'static [HarnessId] = &[
        HarnessId::Codex,
        HarnessId::CodexInternal,
        HarnessId::ClaudeCode,
        HarnessId::ClaudeCodeInternal,
        HarnessId::Cursor,
        HarnessId::Openclaw,
        HarnessId::OpenclawInternal,
        HarnessId::Codebuddy,
        HarnessId::Workbuddy,
        HarnessId::PiAgent,
        HarnessId::Hermes,
    ];

    pub fn index(self) -> usize {
        Self::ALL.iter().position(|h| *h == self).unwrap_or(0)
    }

    pub fn cli_name(self) -> &'static str {
        match self {
            HarnessId::Codex => "codex",
            HarnessId::CodexInternal => "codex-internal",
            HarnessId::ClaudeCode => "claude-code",
            HarnessId::ClaudeCodeInternal => "claudecode-internal",
            HarnessId::Cursor => "cursor",
            HarnessId::Openclaw => "openclaw",
            HarnessId::OpenclawInternal => "openclaw-internal",
            HarnessId::Codebuddy => "codebuddy",
            HarnessId::Workbuddy => "workbuddy",
            HarnessId::PiAgent => "pi",
            HarnessId::Hermes => "hermes",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            HarnessId::Codex => "Codex",
            HarnessId::CodexInternal => "Codex (internal)",
            HarnessId::ClaudeCode => "Claude Code",
            HarnessId::ClaudeCodeInternal => "Claude Code (internal)",
            HarnessId::Cursor => "Cursor",
            HarnessId::Openclaw => "OpenClaw",
            HarnessId::OpenclawInternal => "OpenClaw (internal)",
            HarnessId::Codebuddy => "CodeBuddy",
            HarnessId::Workbuddy => "WorkBuddy",
            HarnessId::PiAgent => "Pi",
            HarnessId::Hermes => "Hermes Agent",
        }
    }

    pub fn skills_dir_for_home(self, home: &Path) -> PathBuf {
        match self {
            HarnessId::Codex => home.join(".agents").join("skills"),
            HarnessId::CodexInternal => home.join(".codex-internal").join("skills"),
            HarnessId::ClaudeCode => home.join(".claude").join("skills"),
            HarnessId::ClaudeCodeInternal => home.join(".claude-internal").join("skills"),
            HarnessId::Cursor => home.join(".cursor").join("skills"),
            HarnessId::Openclaw => home.join(".openclaw").join("skills"),
            HarnessId::OpenclawInternal => home.join(".openclaw-internal").join("skills"),
            HarnessId::Codebuddy => home.join(".codebuddy").join("skills"),
            HarnessId::Workbuddy => home.join(".workbuddy").join("skills"),
            HarnessId::PiAgent => home.join(".pi").join("agent").join("skills"),
            HarnessId::Hermes => hermes_home_for_user_home(home).join("skills"),
        }
    }

    pub fn skill_dest_dir_for_home(self, home: &Path) -> PathBuf {
        self.skills_dir_for_home(home).join(SKILL_DIR_NAME)
    }

    pub fn report_for_home(self, home: &Path) -> HarnessReport {
        let skills_dir = self.skills_dir_for_home(home);
        let dest = skills_dir.join(SKILL_DIR_NAME).join("SKILL.md");
        let (detected, detection_detail) = self.detect_for_home(home);
        HarnessReport {
            id: self,
            skills_dir,
            detected,
            detection_detail,
            installed: dest.is_file(),
        }
    }

    fn detect_for_home(self, home: &Path) -> (bool, Option<String>) {
        let mut signals: Vec<String> = Vec::new();
        let mut push = |signal: &str| signals.push(signal.to_string());

        match self {
            HarnessId::Codex => {
                if home.join(".codex").is_dir() {
                    push("~/.codex");
                }
                if home.join(".agents").join("skills").is_dir() {
                    push("~/.agents/skills");
                }
                if command_exists("codex") {
                    push("`codex` on PATH");
                }
            }
            HarnessId::CodexInternal => {
                if home.join(".codex-internal").is_dir() {
                    push("~/.codex-internal");
                }
                if command_exists("codex-internal") {
                    push("`codex-internal` on PATH");
                }
            }
            HarnessId::ClaudeCode => {
                if home.join(".claude").is_dir() {
                    push("~/.claude");
                }
                if command_exists("claude") {
                    push("`claude` on PATH");
                }
            }
            HarnessId::ClaudeCodeInternal => {
                if home.join(".claude-internal").is_dir() {
                    push("~/.claude-internal");
                }
                for cmd in [
                    "claude-internal",
                    "claudecode-internal",
                    "claude-code-internal",
                ] {
                    if command_exists(cmd) {
                        signals.push(format!("`{cmd}` on PATH"));
                    }
                }
            }
            HarnessId::Cursor => {
                if home.join(".cursor").is_dir() {
                    push("~/.cursor");
                }
                if command_exists("cursor") {
                    push("`cursor` on PATH");
                }
            }
            HarnessId::Openclaw => {
                if home.join(".openclaw").is_dir() {
                    push("~/.openclaw");
                }
                if command_exists("openclaw") {
                    push("`openclaw` on PATH");
                }
            }
            HarnessId::OpenclawInternal => {
                if home.join(".openclaw-internal").is_dir() {
                    push("~/.openclaw-internal");
                }
                if command_exists("openclaw-internal") {
                    push("`openclaw-internal` on PATH");
                }
            }
            HarnessId::Codebuddy => {
                if home.join(".codebuddy").is_dir() {
                    push("~/.codebuddy");
                }
                for cmd in ["codebuddy", "codebody"] {
                    if command_exists(cmd) {
                        signals.push(format!("`{cmd}` on PATH"));
                    }
                }
            }
            HarnessId::Workbuddy => {
                if home.join(".workbuddy").is_dir() {
                    push("~/.workbuddy");
                }
                if command_exists("workbuddy") {
                    push("`workbuddy` on PATH");
                }
            }
            HarnessId::PiAgent => {
                if home.join(".pi").join("agent").is_dir() {
                    push("~/.pi/agent");
                } else if home.join(".pi").is_dir() {
                    push("~/.pi");
                }
                if command_exists("pi") {
                    push("`pi` on PATH");
                }
            }
            HarnessId::Hermes => {
                let hermes_home = hermes_home_for_user_home(home);
                if hermes_home.is_dir() {
                    let label = hermes_home_signal_label(&hermes_home, home);
                    push(&label);
                }
                if command_exists("hermes") {
                    push("`hermes` on PATH");
                }
            }
        }

        let detected = !signals.is_empty();
        let detail = if signals.is_empty() {
            None
        } else {
            Some(signals.join(", "))
        };
        (detected, detail)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessReport {
    pub id: HarnessId,
    pub skills_dir: PathBuf,
    pub detected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detection_detail: Option<String>,
    pub installed: bool,
}

pub fn all_harness_reports() -> Result<Vec<HarnessReport>> {
    let home = home_dir()?;
    Ok(HarnessId::ALL
        .iter()
        .copied()
        .map(|id| id.report_for_home(&home))
        .collect())
}

pub fn parse_harness_id(raw: &str) -> Result<HarnessId> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "codex" => Ok(HarnessId::Codex),
        "codex-internal" | "codex_internal" | "codexinternal" => Ok(HarnessId::CodexInternal),
        "claude-code" | "claude_code" | "claude" | "claudecode" | "cc" => Ok(HarnessId::ClaudeCode),
        "claudecode-internal"
        | "claude-code-internal"
        | "claude_code_internal"
        | "claude-internal"
        | "claude_internal" => Ok(HarnessId::ClaudeCodeInternal),
        "cursor" => Ok(HarnessId::Cursor),
        "openclaw" | "open-claw" => Ok(HarnessId::Openclaw),
        "openclaw-internal" | "openclaw_internal" | "open-claw-internal" => {
            Ok(HarnessId::OpenclawInternal)
        }
        "codebuddy" | "code-body" | "codebody" | "code-buddy" => Ok(HarnessId::Codebuddy),
        "workbuddy" | "work-buddy" => Ok(HarnessId::Workbuddy),
        "pi" | "pi-agent" | "pi_agent" | "piagent" => Ok(HarnessId::PiAgent),
        "hermes" | "hermes-agent" | "hermes_agent" | "hermesagent" => Ok(HarnessId::Hermes),
        other => bail!(
            "unknown harness '{other}'; expected one of: {}",
            HarnessId::ALL
                .iter()
                .map(|h| h.cli_name())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

pub(crate) fn home_dir() -> Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| anyhow::anyhow!("could not resolve home directory"))
}

/// Mirrors [`get_hermes_home()`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_constants.py):
/// `HERMES_HOME` when set, else `%LOCALAPPDATA%\\hermes` on native Windows, else `~/.hermes`.
fn hermes_home_for_user_home(home: &Path) -> PathBuf {
    if let Ok(override_home) = std::env::var("HERMES_HOME") {
        let trimmed = override_home.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let trimmed = local.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("hermes");
            }
        }
        return home.join("AppData").join("Local").join("hermes");
    }

    #[cfg(not(windows))]
    {
        home.join(".hermes")
    }
}

fn hermes_home_signal_label(hermes_home: &Path, user_home: &Path) -> String {
    if std::env::var("HERMES_HOME")
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return format!("$HERMES_HOME ({})", hermes_home.display());
    }

    #[cfg(windows)]
    {
        let default = user_home.join("AppData").join("Local").join("hermes");
        if hermes_home == default
            || std::env::var("LOCALAPPDATA")
                .ok()
                .is_some_and(|local| hermes_home == PathBuf::from(local.trim()).join("hermes"))
        {
            return "%LOCALAPPDATA%\\hermes".to_string();
        }
    }

    if hermes_home == user_home.join(".hermes") {
        return "~/.hermes".to_string();
    }

    hermes_home.display().to_string()
}

fn command_exists(name: &str) -> bool {
    #[cfg(windows)]
    {
        std::process::Command::new("where")
            .arg(name)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {name} >/dev/null 2>&1"))
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_aliases() {
        assert_eq!(parse_harness_id("codebody").unwrap(), HarnessId::Codebuddy);
        assert_eq!(
            parse_harness_id("claude-internal").unwrap(),
            HarnessId::ClaudeCodeInternal
        );
        assert_eq!(parse_harness_id("pi-agent").unwrap(), HarnessId::PiAgent);
        assert_eq!(parse_harness_id("hermes-agent").unwrap(), HarnessId::Hermes);
    }

    #[test]
    fn detects_cursor_from_home_layout() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        std::fs::create_dir_all(home.join(".cursor")).unwrap();
        let report = HarnessId::Cursor.report_for_home(home);
        assert!(report.detected);
    }

    #[test]
    fn openclaw_internal_not_detected_from_install_root_only() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        std::fs::create_dir_all(home.join(".local/lib/openclaw-internal")).unwrap();
        let report = HarnessId::OpenclawInternal.report_for_home(home);
        assert!(!report.detected);
    }

    #[test]
    fn skills_dirs_match_harness_spec() {
        let home = Path::new("/home/user");
        assert_eq!(
            HarnessId::Codex.skills_dir_for_home(home),
            PathBuf::from("/home/user/.agents/skills")
        );
        assert_eq!(
            HarnessId::CodexInternal.skills_dir_for_home(home),
            PathBuf::from("/home/user/.codex-internal/skills")
        );
        assert_eq!(
            HarnessId::ClaudeCodeInternal.skills_dir_for_home(home),
            PathBuf::from("/home/user/.claude-internal/skills")
        );
        assert_eq!(
            HarnessId::OpenclawInternal.skills_dir_for_home(home),
            PathBuf::from("/home/user/.openclaw-internal/skills")
        );
        assert_eq!(
            HarnessId::Codebuddy.skills_dir_for_home(home),
            PathBuf::from("/home/user/.codebuddy/skills")
        );
        assert_eq!(
            HarnessId::Workbuddy.skills_dir_for_home(home),
            PathBuf::from("/home/user/.workbuddy/skills")
        );
        assert_eq!(
            HarnessId::PiAgent.skills_dir_for_home(home),
            PathBuf::from("/home/user/.pi/agent/skills")
        );
        assert_eq!(
            HarnessId::Hermes.skills_dir_for_home(home),
            PathBuf::from("/home/user/.hermes/skills")
        );
    }

    #[test]
    fn detects_workbuddy_from_home_layout() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        std::fs::create_dir_all(home.join(".workbuddy")).unwrap();
        let report = HarnessId::Workbuddy.report_for_home(home);
        assert!(report.detected);
        assert_eq!(report.skills_dir, home.join(".workbuddy").join("skills"));
    }

    #[test]
    fn detects_pi_agent_from_home_layout() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        std::fs::create_dir_all(home.join(".pi").join("agent")).unwrap();
        let report = HarnessId::PiAgent.report_for_home(home);
        assert!(report.detected);
        assert_eq!(
            report.skills_dir,
            home.join(".pi").join("agent").join("skills")
        );
    }

    #[test]
    fn detects_hermes_from_home_layout() {
        let tmp = tempfile::TempDir::new().unwrap();
        let home = tmp.path();
        std::fs::create_dir_all(home.join(".hermes")).unwrap();
        let report = HarnessId::Hermes.report_for_home(home);
        assert!(report.detected);
        assert_eq!(report.skills_dir, home.join(".hermes").join("skills"));
    }

    #[test]
    fn hermes_skills_dir_honors_hermes_home_env() {
        let tmp = tempfile::TempDir::new().unwrap();
        let custom = tmp.path().join("custom-hermes");
        std::fs::create_dir_all(&custom).unwrap();
        let previous = std::env::var("HERMES_HOME").ok();
        // SAFETY: harness tests do not run in parallel with other env-mutating tests.
        unsafe {
            std::env::set_var("HERMES_HOME", &custom);
        }
        let home = Path::new("/home/user");
        assert_eq!(
            HarnessId::Hermes.skills_dir_for_home(home),
            custom.join("skills")
        );
        unsafe {
            match previous {
                Some(value) => std::env::set_var("HERMES_HOME", value),
                None => std::env::remove_var("HERMES_HOME"),
            }
        }
    }
}
