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
    #[arg(value_parser = ["start", "stop", "status", "requests", "request", "operations", "operation", "console", "pages", "export", "rules", "rule_add", "rule_enable", "rule_disable", "rule_remove", "replay"])]
    pub action: String,
    /// Request, operation or rule ID returned by an earlier debug action.
    pub id: Option<String>,
    #[arg(long)]
    pub session: String,
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
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=100))]
    pub limit: Option<u32>,
    #[arg(long, value_parser = ["metadata", "request", "response", "headers", "timing"])]
    pub part: Option<String>,
    #[arg(long, value_parser = clap::value_parser!(u32).range(0..=65536))]
    pub offset: Option<u32>,
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
}

impl DebugArgs {
    fn params(self) -> Result<DebugParams, CliError> {
        let action: DebugAction = serde_json::from_value(serde_json::Value::String(self.action))
            .context("invalid debug action")?;
        if matches!(
            action,
            DebugAction::Request
                | DebugAction::Operation
                | DebugAction::RuleEnable
                | DebugAction::RuleDisable
                | DebugAction::RuleRemove
                | DebugAction::Replay
        ) && self.id.is_none()
        {
            return Err(anyhow::anyhow!("this debug action requires an ID").into());
        }
        if self.pointer.is_some() && !matches!(self.part.as_deref(), Some("request" | "response")) {
            return Err(anyhow::anyhow!("--pointer requires --part request or response").into());
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
            session_id: self.session,
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
    let params = args.params()?;
    let export = params.action == DebugAction::Export;
    let info = ensure_daemon().context("ensure daemon is running")?;
    let result: DebugResult = super::business_rpc::call(
        info.sock_path,
        "debug",
        Method::ToolDebug,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )?;
    // Export the portable document directly so stdout redirection produces a usable JSON file.
    if export {
        let recording = result
            .recording
            .context("extension returned no debug recording")?;
        println!(
            "{}",
            serde_json::to_string_pretty(&recording).context("render debug recording")?
        );
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&result).context("render debug evidence")?
        );
    }
    Ok(())
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
