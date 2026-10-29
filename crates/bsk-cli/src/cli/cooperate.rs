use super::{
    TOOL_IPC_TIMEOUT, business_rpc,
    ensure_daemon::ensure_daemon,
    error::{CliError, Format},
};
use anyhow::Context;
use bsk_protocol::{
    Method,
    tools::{CooperateAction, CooperateParams},
};
use clap::{Args, ValueEnum};
use std::path::PathBuf;

pub(crate) mod presentation;
pub(crate) mod saved_reply;
pub(crate) mod settle;

#[derive(Debug, Clone, ValueEnum)]
pub enum Action {
    Enable,
    Status,
    Sync,
    Wait,
}

#[derive(Debug, Clone, Args)]
pub struct CooperateArgs {
    /// Synchronize default shared control, inspect ownership, or wait for hand-back.
    /// Enable remains an optional alias for synchronization and task-tab binding.
    #[arg(value_enum)]
    pub action: Action,
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub tab_id: Option<i64>,
    /// Bounded wait, up to 25 seconds. Waiting never holds the action queue.
    #[arg(long, value_parser = clap::value_parser!(u64).range(0..=25000))]
    pub timeout_ms: Option<u64>,
    #[arg(long)]
    pub max_tokens: Option<u32>,
    /// Fold only plain numbered fallback buttons outside literal-match windows (repeatable, sync only).
    ///
    /// Only stateless `button "item N"` lines may be omitted. Keeps business text,
    /// named/stateful controls and complete forms/dialogs. Use `bsk view <saved.json>
    /// --find <text>` for text search. Changes CLI presentation only; refs and guards are unchanged.
    #[arg(long, value_parser = nonempty_text)]
    pub match_text: Vec<String>,
    /// Keep numbered fallback buttons within this many lines before/after each match.
    #[arg(long, requires = "match_text", value_parser = clap::value_parser!(u32).range(0..=200))]
    pub context_lines: Option<u32>,
    /// Save the unfiltered reply to a new local JSON file before presenting it (sync only).
    #[arg(long)]
    pub save_full: Option<PathBuf>,
    /// Saved unfiltered predecessor; reuse its VOM only for an exact unchanged reply.
    #[arg(long)]
    pub baseline: Option<PathBuf>,
    /// Recover transient read-only sync refusals with wait then sync, at most 3 attempts.
    /// Never repeats a browser action. A human hold returns without a context.
    #[arg(long)]
    pub settle: bool,
}

pub fn dispatch(args: CooperateArgs, _format: Format) -> Result<(), CliError> {
    if !matches!(args.action, Action::Sync)
        && (!args.match_text.is_empty()
            || args.save_full.is_some()
            || args.settle
            || args.baseline.is_some())
    {
        return Err(CliError::Local(anyhow::anyhow!(
            "--match-text, --save-full, --baseline and --settle require cooperate sync"
        )));
    }
    let baseline = args
        .baseline
        .as_deref()
        .map(super::observation_view::read)
        .transpose()?;
    let session = args.session.clone();
    let saved = args
        .save_full
        .as_ref()
        .map(|path| saved_reply::SavedReply::prepare(path))
        .transpose()?;
    let daemon = ensure_daemon().context("ensure daemon is running")?;
    let params = CooperateParams {
        session_id: args.session,
        tab_id: args.tab_id,
        action: match args.action {
            Action::Enable => CooperateAction::Enable,
            Action::Status => CooperateAction::Status,
            Action::Sync => CooperateAction::Sync,
            Action::Wait => CooperateAction::Wait,
        },
        timeout_ms: args.timeout_ms,
        max_tokens: args.max_tokens,
    };
    let mut reply: serde_json::Value = if args.settle {
        settle::run(|action| {
            let mut current = params.clone();
            if matches!(action, CooperateAction::Wait) {
                current.timeout_ms = Some(args.timeout_ms.unwrap_or(1000));
            }
            current.action = action;
            business_rpc::call(
                daemon.sock_path.clone(),
                "cooperate",
                Method::ToolCooperate,
                Some(current),
                TOOL_IPC_TIMEOUT,
            )
        })?
    } else {
        business_rpc::call(
            daemon.sock_path,
            "cooperate",
            Method::ToolCooperate,
            Some(params),
            TOOL_IPC_TIMEOUT,
        )?
    };
    super::observation_view::attach(&mut reply, &session, baseline.as_ref());
    if let Some(saved) = saved {
        saved.finish(&reply)?;
    }
    if !args.match_text.is_empty() {
        presentation::filter(
            &mut reply,
            &args.match_text,
            args.context_lines.unwrap_or(12) as usize,
        );
    }
    if let Some(path) = args.save_full {
        reply["full_output_path"] = serde_json::json!(path);
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&reply).context("render cooperation result")?
    );
    Ok(())
}

fn nonempty_text(value: &str) -> Result<String, String> {
    if value.trim().is_empty() || value.contains(['\r', '\n']) {
        return Err("match text must be a nonempty single-line literal".into());
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Command {
        #[command(flatten)]
        cooperate: CooperateArgs,
    }

    #[test]
    fn parses_literal_matches_and_requires_a_match_for_context() {
        let parsed = Command::try_parse_from([
            "cooperate",
            "sync",
            "--session",
            "s",
            "--match-text",
            "a[b]",
            "--match-text",
            "时间",
            "--context-lines",
            "0",
        ])
        .unwrap()
        .cooperate;
        assert_eq!(parsed.match_text, ["a[b]", "时间"]);
        assert_eq!(parsed.context_lines, Some(0));
        for tail in [
            vec!["--match-text", " "],
            vec!["--context-lines", "3"],
            vec!["--match-text", "x", "--context-lines", "201"],
        ] {
            let mut argv = vec!["cooperate", "sync", "--session", "s"];
            argv.extend(tail);
            assert!(Command::try_parse_from(argv).is_err());
        }
    }

    #[test]
    fn rejects_filtered_wait_before_contacting_daemon() {
        let args =
            Command::try_parse_from(["cooperate", "wait", "--session", "s", "--match-text", "x"])
                .unwrap()
                .cooperate;
        assert!(
            dispatch(args, Format::Json)
                .unwrap_err()
                .to_string()
                .contains("require cooperate sync")
        );
    }

    #[test]
    fn existing_full_output_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("observation.json");
        std::fs::write(&path, "previous evidence").unwrap();
        let args = Command::try_parse_from([
            "cooperate",
            "sync",
            "--session",
            "s",
            "--save-full",
            path.to_str().unwrap(),
        ])
        .unwrap()
        .cooperate;
        assert!(dispatch(args, Format::Json).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "previous evidence");
    }
}
