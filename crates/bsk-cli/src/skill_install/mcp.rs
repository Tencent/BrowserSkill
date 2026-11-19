//! Optional MCP configuration installed alongside the skill.
//!
//! Preserve existing settings and refuse to replace a different server entry.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use serde_json::{Value, json};

use super::harness::HarnessId;

#[derive(Debug, Serialize)]
pub struct McpInstallResult {
    pub harness: String,
    pub path: PathBuf,
    pub status: &'static str,
}

pub fn supported(harness: HarnessId) -> bool {
    matches!(
        harness,
        HarnessId::Codex | HarnessId::ClaudeCode | HarnessId::Cursor
    )
}

pub fn install(home: &Path, harness: HarnessId, executable: &Path) -> Result<McpInstallResult> {
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    install_at(home, &codex_home, harness, executable)
}

fn install_at(
    home: &Path,
    codex_home: &Path,
    harness: HarnessId,
    executable: &Path,
) -> Result<McpInstallResult> {
    let command = executable
        .to_str()
        .context("bsk executable path is not valid Unicode")?;
    let (path, is_toml) = match harness {
        HarnessId::Codex => (codex_home.join("config.toml"), true),
        HarnessId::ClaudeCode => (home.join(".claude.json"), false),
        HarnessId::Cursor => (home.join(".cursor/mcp.json"), false),
        _ => bail!("MCP setup is not supported for {}", harness.cli_name()),
    };
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        bail!("{} is a symlink; configure MCP manually", path.display());
    }
    let original = match fs::read_to_string(&path) {
        Ok(content) => Some(content),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err).with_context(|| format!("read {}", path.display())),
    };
    let existing = original.as_deref().unwrap_or("");
    let updated = if is_toml {
        update_toml(existing, command)?
    } else {
        update_json(existing, command)?
    };
    let status = if let Some(updated) = updated {
        let parent = path
            .parent()
            .context("configuration has no parent directory")?;
        fs::create_dir_all(parent)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        if let Ok(meta) = fs::metadata(&path) {
            temp.as_file().set_permissions(meta.permissions())?;
        }
        temp.write_all(updated.as_bytes())?;
        temp.as_file().sync_all()?;
        if let Some(original) = original {
            ensure!(
                fs::read_to_string(&path).ok().as_deref() == Some(original.as_str()),
                "{} changed during MCP setup; retry",
                path.display()
            );
            temp.persist(&path)
                .map_err(|err| err.error)
                .with_context(|| format!("write {}", path.display()))?;
        } else {
            temp.persist_noclobber(&path)
                .map_err(|err| err.error)
                .with_context(|| format!("create {}", path.display()))?;
        }
        "installed"
    } else {
        "already configured"
    };
    Ok(McpInstallResult {
        harness: harness.cli_name().into(),
        path,
        status,
    })
}

fn update_toml(existing: &str, command: &str) -> Result<Option<String>> {
    let mut doc = existing
        .parse::<toml_edit::DocumentMut>()
        .context("invalid Codex TOML configuration")?;
    if let Some(item) = doc.get("mcp_servers") {
        ensure!(item.is_table(), "mcp_servers is not a table");
    } else {
        doc["mcp_servers"] = toml_edit::table();
    }
    let servers = doc["mcp_servers"].as_table_mut().unwrap();
    if let Some(entry) = servers.get("browser-skill") {
        let identical = entry.get("command").and_then(|v| v.as_str()) == Some(command)
            && entry
                .get("args")
                .and_then(|v| v.as_array())
                .is_some_and(|a| a.len() == 1 && a.get(0).and_then(|v| v.as_str()) == Some("mcp"));
        ensure!(
            identical,
            "a different browser-skill MCP entry already exists; edit it manually"
        );
        return Ok(None);
    }
    let mut entry = toml_edit::Table::new();
    entry["command"] = toml_edit::value(command);
    let mut args = toml_edit::Array::new();
    args.push("mcp");
    entry["args"] = toml_edit::value(args);
    servers["browser-skill"] = toml_edit::Item::Table(entry);
    Ok(Some(doc.to_string()))
}

fn update_json(existing: &str, command: &str) -> Result<Option<String>> {
    let mut doc: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(existing).context("invalid MCP JSON configuration")?
    };
    let root = doc
        .as_object_mut()
        .context("MCP configuration must be an object")?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("mcpServers must be an object")?;
    if let Some(entry) = servers.get("browser-skill") {
        ensure!(
            entry.get("command").and_then(Value::as_str) == Some(command)
                && entry.get("args") == Some(&json!(["mcp"])),
            "a different browser-skill MCP entry already exists; edit it manually"
        );
        return Ok(None);
    }
    servers.insert(
        "browser-skill".into(),
        json!({"command":command, "args":["mcp"]}),
    );
    Ok(Some(format!("{}\n", serde_json::to_string_pretty(&doc)?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_preserving_existing_settings_and_refuses_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let codex = home.join("custom codex");
        fs::create_dir_all(&codex).unwrap();
        let config = codex.join("config.toml");
        fs::write(
            &config,
            "# keep me\nmodel = \"example\"\n[mcp_servers.other]\ncommand = \"other\"\n",
        )
        .unwrap();
        let binary = Path::new("/path with spaces/bsk");
        assert_eq!(
            install_at(home, &codex, HarnessId::Codex, binary)
                .unwrap()
                .status,
            "installed"
        );
        let first = fs::read_to_string(&config).unwrap();
        assert!(first.contains("# keep me") && first.contains("[mcp_servers.other]"));
        assert_eq!(
            install_at(home, &codex, HarnessId::Codex, binary)
                .unwrap()
                .status,
            "already configured"
        );
        assert!(install_at(home, &codex, HarnessId::Codex, Path::new("/other/bsk")).is_err());
        assert_eq!(fs::read_to_string(&config).unwrap(), first);

        for harness in [HarnessId::ClaudeCode, HarnessId::Cursor] {
            let result = install_at(home, &codex, harness, binary).unwrap();
            let value: Value =
                serde_json::from_str(&fs::read_to_string(&result.path).unwrap()).unwrap();
            assert_eq!(value["mcpServers"]["browser-skill"]["args"], json!(["mcp"]));
            assert_eq!(
                install_at(home, &codex, harness, binary).unwrap().status,
                "already configured"
            );
        }
    }
}
