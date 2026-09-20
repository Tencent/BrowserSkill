//! Task-scoped website evidence with explicit start / stop and bounded reads.
use super::{
    TOOL_IPC_TIMEOUT,
    ensure_daemon::ensure_daemon,
    error::{CliError, Format},
};
use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{DebugAction, DebugParams, DebugResult};
use clap::Args;

#[derive(Debug, Clone, Args)]
pub struct DebugArgs {
    /// Capture/inspect evidence, manage request rules, or replay a recorded request.
    #[arg(value_parser = ["start", "stop", "status", "requests", "request", "operations", "operation", "console", "pages", "export", "rules", "rule_add", "rule_enable", "rule_disable", "rule_remove", "replay", "capabilities", "activity", "wait", "pin", "unpin"])]
    pub action: String,
    /// Request, operation or rule ID returned by an earlier debug action.
    pub id: Option<String>,
    #[arg(long)]
    pub session: Option<String>,
    #[arg(long)]
    pub tab_id: Option<i64>,
    #[arg(long)]
    pub run_id: Option<String>,
    /// A short task name shown in the extension.
    #[arg(long)]
    pub name: Option<String>,
    /// Incremental cursor; records may reappear when their evidence changes.
    #[arg(long)]
    pub since: Option<u64>,
    /// List size: 1..100, default 30. Follow next_since to continue.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=100))]
    pub limit: Option<u32>,
    #[arg(long, value_parser = ["metadata", "request", "response", "headers", "timing"])]
    pub part: Option<String>,
    /// Body character or pages/console entry offset: 0..65536.
    #[arg(long, value_parser = clap::value_parser!(u32).range(0..=65536))]
    pub offset: Option<u32>,
    /// Body slice: 1..16384 characters, default 4096.
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=16384))]
    pub max_chars: Option<u32>,
    /// RFC 6901 JSON pointer applied to the selected complete, redacted body.
    #[arg(long)]
    pub pointer: Option<String>,
    /// Rule definition as JSON. Rules default to one match in the current capture.
    #[arg(long, conflicts_with = "rule_file")]
    pub rule: Option<String>,
    #[arg(long)]
    pub rule_file: Option<std::path::PathBuf>,
    /// Replay JSON with a unique key; reusing the key never sends twice.
    #[arg(long, conflicts_with = "replay_file")]
    pub replay: Option<String>,
    #[arg(long)]
    pub replay_file: Option<std::path::PathBuf>,
    /// Output budget: 4096..262144 UTF-8 JSON bytes, default 32768. Export is exempt.
    #[arg(long, value_parser = clap::value_parser!(u32).range(4096..=262144))]
    pub budget: Option<u32>,
    /// Requests only: URL substring (case-sensitive).
    #[arg(long)]
    pub url: Option<String>,
    #[arg(long)]
    pub method: Option<String>,
    #[arg(long)]
    pub resource_type: Option<String>,
    #[arg(long, value_parser = clap::value_parser!(u16).range(100..=599))]
    pub status: Option<u16>,
    #[arg(long, value_parser = ["pending", "complete", "failed", "redirected", "interrupted"])]
    pub state: Option<String>,
    #[arg(long, value_parser = ["all", "business", "resource", "extension"])]
    pub kind: Option<String>,
    /// Comma-separated optional request fields. Identity and body availability remain.
    #[arg(long, value_delimiter = ',')]
    pub fields: Option<Vec<String>>,
    /// Wait for the running command: 0..60000 ms, default 10000; does not resend it.
    #[arg(long, value_parser = clap::value_parser!(u32).range(0..=60000))]
    pub wait_ms: Option<u32>,
    /// Wait until this command is no longer running; otherwise wait until the session is idle.
    #[arg(long)]
    pub command_id: Option<String>,
    /// Export JSON to a new file, returning only its path and size to the agent.
    #[arg(long)]
    pub output: Option<std::path::PathBuf>,
}

impl DebugArgs {
    fn params(self) -> Result<DebugParams, CliError> {
        let action: DebugAction = serde_json::from_value(serde_json::Value::String(self.action))
            .context("invalid debug action")?;
        if action != DebugAction::Capabilities && self.session.as_deref().is_none_or(str::is_empty)
        {
            return Err(
                anyhow::anyhow!("--session is required except for offline capabilities").into(),
            );
        }
        if matches!(
            action,
            DebugAction::Request
                | DebugAction::Operation
                | DebugAction::RuleEnable
                | DebugAction::RuleDisable
                | DebugAction::RuleRemove
                | DebugAction::Replay
                | DebugAction::Pin
                | DebugAction::Unpin
        ) && self.id.is_none()
        {
            return Err(anyhow::anyhow!("this debug action requires an ID").into());
        }
        if self.pointer.is_some() && !matches!(self.part.as_deref(), Some("request" | "response")) {
            return Err(anyhow::anyhow!("--pointer requires --part request or response").into());
        }
        if self.output.is_some() && action != DebugAction::Export {
            return Err(anyhow::anyhow!("--output requires export").into());
        }
        if (self.wait_ms.is_some() || self.command_id.is_some()) && action != DebugAction::Wait {
            return Err(anyhow::anyhow!("--wait-ms and --command-id require wait").into());
        }
        if (self.url.is_some()
            || self.method.is_some()
            || self.resource_type.is_some()
            || self.status.is_some()
            || self.state.is_some()
            || self.kind.is_some())
            && action != DebugAction::Requests
        {
            return Err(anyhow::anyhow!("filters require requests").into());
        }
        let rule = read_options(self.rule, self.rule_file)?;
        let replay = read_options(self.replay, self.replay_file)?;
        if (action == DebugAction::RuleAdd) != rule.is_some() {
            return Err(anyhow::anyhow!(
                "rule_add requires --rule or --rule-file; other actions do not accept rules"
            )
            .into());
        }
        if (action == DebugAction::Replay) != replay.is_some() {
            return Err(anyhow::anyhow!("replay requires --replay or --replay-file; other actions do not accept replay options").into());
        }
        Ok(DebugParams {
            session_id: self.session.unwrap_or_default(),
            action,
            tab_id: self.tab_id,
            run_id: self.run_id,
            id: self.id,
            name: self.name,
            since: self.since,
            limit: self.limit,
            part: self.part,
            offset: self.offset,
            max_chars: self.max_chars,
            pointer: self.pointer,
            rule,
            replay,
            budget: self.budget,
            url: self.url,
            method: self.method,
            resource_type: self.resource_type,
            status: self.status,
            state: self.state,
            kind: self.kind,
            fields: self.fields,
            wait_ms: self.wait_ms,
            command_id: self.command_id,
        })
    }
}

fn read_options<T: serde::de::DeserializeOwned>(
    inline: Option<String>,
    path: Option<std::path::PathBuf>,
) -> Result<Option<T>, CliError> {
    use std::io::Read;
    let text = if let Some(path) = path {
        let mut text = String::new();
        std::fs::File::open(path)
            .context("open debug options file")?
            .take(81921)
            .read_to_string(&mut text)
            .context("read debug options file")?;
        Some(text)
    } else {
        inline
    };
    text.map(|text| {
        if text.len() > 81920 {
            return Err(anyhow::anyhow!("debug options exceed 80 KiB").into());
        }
        serde_json::from_str(&text)
            .context("invalid debug options JSON")
            .map_err(Into::into)
    })
    .transpose()
}

pub fn dispatch(args: DebugArgs, _format: Format) -> Result<(), CliError> {
    let output = args.output.clone();
    let params = args.params()?;
    if params.action == DebugAction::Capabilities && params.session_id.is_empty() {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "cli": cli_identity(), "extension": null, "discovery": "cli_schema_only",
                "hint": "Pass --session to discover the connected extension's actual capabilities and limits",
                "parameters": bsk_protocol::tools::debug_parameter_schema(),
            })).context("render capabilities")?
        );
        return Ok(());
    }
    let timeout = if params.action == DebugAction::Wait {
        std::time::Duration::from_millis(u64::from(params.wait_ms.unwrap_or(10000)) + 5000)
    } else {
        TOOL_IPC_TIMEOUT
    };
    let export = params.action == DebugAction::Export;
    let budget = params.budget.unwrap_or(32768) as usize;
    let info = ensure_daemon().context("ensure daemon is running")?;
    let mut result: DebugResult = super::business_rpc::call(
        info.sock_path,
        "debug",
        Method::ToolDebug,
        Some(params),
        timeout,
    )?;
    if let Some(capabilities) = result
        .capabilities
        .as_mut()
        .and_then(serde_json::Value::as_object_mut)
    {
        capabilities.insert("cli".into(), cli_identity());
        capabilities.insert("execution".into(), serde_json::json!({"policy":"one command per session", "actions":["activity","wait"], "wait_ms":{"min":0,"max":60000,"default":10000}, "wait_semantics":"wait_complete means no longer running, not successful; waiting never executes or retries commands"}));
    }
    // Export the portable document directly so stdout redirection produces a usable JSON file.
    if export {
        let recording = result
            .recording
            .context("extension returned no debug recording")?;
        if let Some(path) = output {
            use std::io::Write;
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(std::path::Path::new("."));
            let mut file = tempfile::NamedTempFile::new_in(parent).context("create export file")?;
            serde_json::to_writer_pretty(&mut file, &recording).context("write debug export")?;
            file.write_all(b"\n").context("finish debug export")?;
            file.as_file().sync_all().context("sync debug export")?;
            let bytes = file
                .as_file()
                .metadata()
                .context("stat debug export")?
                .len();
            file.persist_noclobber(&path)
                .context("save debug export (destination must not exist)")?;
            println!(
                "{}",
                serde_json::json!({"path": path.canonicalize().unwrap_or(path), "bytes": bytes, "run_id": recording.run.id})
            );
        } else {
            println!(
                "{}",
                serde_json::to_string_pretty(&recording).context("render debug recording")?
            );
        }
    } else {
        let rendered = serde_json::to_string_pretty(&result).context("render debug evidence")?;
        if rendered.len() > budget {
            return Err(anyhow::anyhow!(
                "output exceeds budget after CLI metadata; increase --budget"
            )
            .into());
        }
        println!("{rendered}");
    }
    Ok(())
}

fn cli_identity() -> serde_json::Value {
    serde_json::json!({ "version": env!("CARGO_PKG_VERSION"), "build": option_env!("BSK_BUILD_REVISION").unwrap_or("unknown"), "protocol_version": crate::daemon::state::PROTOCOL_VERSION })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Command};
    use clap::Parser;

    fn parse(args: &[&str]) -> Result<DebugParams, CliError> {
        let cli = Cli::try_parse_from(args).map_err(|error| anyhow::anyhow!(error))?;
        let Command::Debug(debug) = cli.command else {
            panic!("debug command expected")
        };
        debug.params()
    }
    #[test]
    fn reads_an_exact_body_field_without_fetching_all_evidence() {
        let params = parse(&[
            "bsk",
            "debug",
            "request",
            "d1:n2",
            "--session",
            "abcd",
            "--part",
            "response",
            "--pointer",
            "/data/name",
        ])
        .unwrap();
        assert_eq!(params.action, DebugAction::Request);
        assert_eq!(params.id.as_deref(), Some("d1:n2"));
        assert_eq!(params.pointer.as_deref(), Some("/data/name"));
        assert!(params.run_id.is_none());
    }
    #[test]
    fn parses_explicit_rule_and_replay_definitions() {
        let rule = r#"{"match":{"url":"http://localhost:3000/api"},"effect":{"type":"mock","status":503,"body":"{}"}}"#;
        let params = parse(&[
            "bsk",
            "debug",
            "rule_add",
            "--session",
            "abcd",
            "--rule",
            rule,
        ])
        .unwrap();
        assert!(params.rule.is_some());
        let replay = r#"{"key":"attempt-one","body":"{\"name\":\"Bob\"}"}"#;
        let params = parse(&[
            "bsk",
            "debug",
            "replay",
            "d1:n1",
            "--session",
            "abcd",
            "--replay",
            replay,
        ])
        .unwrap();
        assert_eq!(params.replay.unwrap().key, "attempt-one");
        assert!(parse(&["bsk", "debug", "replay", "d1:n1", "--session", "abcd"]).is_err());
        assert!(
            parse(&[
                "bsk",
                "debug",
                "status",
                "--session",
                "abcd",
                "--rule",
                rule
            ])
            .is_err()
        );
    }

    #[test]
    fn reliability_options_are_discoverable_and_bounded() {
        assert!(parse(&["bsk", "debug", "capabilities"]).is_ok());
        assert!(parse(&["bsk", "debug", "activity"]).is_err());
        let p = parse(&[
            "bsk",
            "debug",
            "requests",
            "--session",
            "abcd",
            "--url",
            "/api",
            "--status",
            "503",
            "--budget",
            "4096",
            "--fields",
            "status,duration_ms",
        ])
        .unwrap();
        assert_eq!(p.fields.unwrap(), ["status", "duration_ms"]);
        assert_eq!(p.status, Some(503));
        for flags in [
            vec!["--budget", "4095"],
            vec!["--budget", "262145"],
            vec!["--limit", "200"],
            vec!["--wait-ms", "10"],
            vec!["--output", "evidence.json"],
        ] {
            let mut args = vec!["bsk", "debug", "requests", "--session", "abcd"];
            args.extend(flags);
            assert!(parse(&args).is_err());
        }
        assert!(
            parse(&[
                "bsk",
                "debug",
                "wait",
                "--session",
                "abcd",
                "--wait-ms",
                "60000",
                "--command-id",
                "running"
            ])
            .is_ok()
        );
        assert!(
            parse(&[
                "bsk",
                "debug",
                "export",
                "--session",
                "abcd",
                "--output",
                "evidence.json"
            ])
            .is_ok()
        );
    }

    #[test]
    fn validates_before_connecting_to_a_daemon() {
        assert!(parse(&["bsk", "debug", "request", "--session", "abcd"]).is_err());
        assert!(parse(&["bsk", "debug", "compare", "--session", "abcd"]).is_err());
        assert!(
            parse(&[
                "bsk",
                "debug",
                "requests",
                "--session",
                "abcd",
                "--limit",
                "101"
            ])
            .is_err()
        );
        assert!(
            parse(&[
                "bsk",
                "debug",
                "start",
                "--session",
                "abcd",
                "--name",
                "Save fails"
            ])
            .is_ok()
        );
    }
}
