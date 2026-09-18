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
    /// Start/stop capture, inspect evidence, or compare two recorded operations.
    #[arg(value_parser = ["start", "stop", "status", "requests", "request", "operations", "operation", "compare"])]
    pub action: String,
    /// Request or operation ID returned by an earlier debug read.
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
    #[arg(long)]
    pub before: Option<String>,
    #[arg(long)]
    pub after: Option<String>,
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
}

impl DebugArgs {
    fn params(self) -> Result<DebugParams, CliError> {
        let action: DebugAction = serde_json::from_value(serde_json::Value::String(self.action))
            .context("invalid debug action")?;
        if matches!(action, DebugAction::Request | DebugAction::Operation) && self.id.is_none() {
            return Err(anyhow::anyhow!("request/operation requires an ID").into());
        }
        if action == DebugAction::Compare && (self.before.is_none() || self.after.is_none()) {
            return Err(
                anyhow::anyhow!("compare requires --before and --after operation IDs").into(),
            );
        }
        if self.pointer.is_some() && !matches!(self.part.as_deref(), Some("request" | "response")) {
            return Err(anyhow::anyhow!("--pointer requires --part request or response").into());
        }
        Ok(DebugParams {
            session_id: self.session,
            action,
            tab_id: self.tab_id,
            run_id: self.run_id,
            id: self.id,
            name: self.name,
            before: self.before,
            after: self.after,
            since: self.since,
            limit: self.limit,
            part: self.part,
            offset: self.offset,
            max_chars: self.max_chars,
            pointer: self.pointer,
        })
    }
}

pub fn dispatch(args: DebugArgs, _format: Format) -> Result<(), CliError> {
    let params = args.params()?;
    let info = ensure_daemon().context("ensure daemon is running")?;
    let result: DebugResult = super::business_rpc::call(
        info.sock_path,
        "debug",
        Method::ToolDebug,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )?;
    // Nested evidence keeps the same navigable representation in both modes.
    println!(
        "{}",
        serde_json::to_string_pretty(&result).context("render debug evidence")?
    );
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
