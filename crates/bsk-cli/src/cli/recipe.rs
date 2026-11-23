//! Replays a saved flow without a model turn per step.
//!
//! A recipe is an explicit, reviewable file. It replays confirmed decisions, not a
//! recording: each step passes the same control, target and `expect` checks as its
//! own command. This version replays only read and reversible steps. The CLI always
//! has it; MCP lists `bsk_recipe` only with `BSK_RECIPES=1`. See `docs/recipes.md`.
use super::{
    GlobalFlags, TOOL_IPC_TIMEOUT, business_rpc, ensure_daemon,
    error::{CliError, Format, exit_code_for},
    plan,
};
use anyhow::{Context, ensure};
use bsk_protocol::{ErrorCode, Method, RpcError};
use clap::{Args, Subcommand};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

mod draft;
pub(crate) mod model;
pub(crate) mod runner;
pub(crate) mod store;
pub(crate) mod vom;

use model::Refusal;
use store::Store;

/// Lists `bsk_recipe` in MCP, so clients that never replay pay nothing for its schema.
const ENABLE_ENV: &str = "BSK_RECIPES";
const SESSION_START_TIMEOUT: Duration = Duration::from_secs(60);
const SESSION_STOP_TIMEOUT: Duration = Duration::from_secs(60);

/// Whether MCP lists the recipe tool. The CLI command needs no switch.
pub(crate) fn enabled() -> bool {
    std::env::var_os(ENABLE_ENV).is_some_and(|value| value == "1")
}

#[derive(Debug, Clone, Args)]
pub struct RecipeCmd {
    #[command(subcommand)]
    pub command: RecipeCommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum RecipeCommand {
    /// List saved recipes with their parameters and status.
    List {
        /// Only recipes allowed on this origin, such as https://erp.example.com.
        #[arg(long)]
        site: Option<String>,
    },
    /// Show one recipe, its status and what a reviewer should check.
    Show { name: String },
    /// Delete a saved recipe, its revisions and its run history.
    Rm { name: String },
    /// Check a recipe file and save it as the next revision.
    Save {
        #[arg(long)]
        file: PathBuf,
    },
    /// Approve, as a person at a terminal, the steps whose risk a recipe lowers.
    Approve { name: String },
    /// Draft a recipe from what a session just did. Run this before stopping it.
    Draft(DraftArgs),
    /// Replay a recipe. Stops at the first deviation and hands the page back.
    Run(RunArgs),
}

#[derive(Debug, Clone, Args)]
pub struct DraftArgs {
    #[arg(long)]
    pub session: String,
    /// Recipe name: lowercase letters, digits, -, _ and .
    #[arg(long)]
    pub name: String,
    /// What the recipe does. Required before saving.
    #[arg(long, default_value = "")]
    pub description: String,
    /// Also write the draft to this new file, ready to edit and save.
    #[arg(long)]
    pub out: Option<PathBuf>,
}

#[derive(Debug, Clone, Args)]
pub struct RunArgs {
    pub name: String,
    /// A parameter value as key=value (repeatable).
    #[arg(long = "param", value_parser = parse_param)]
    pub params: Vec<(String, String)>,
    /// Run in this session, on its current tab, and leave it open. Without this, a
    /// new session is started, named recipe:<name>, and stopped when the run completes.
    #[arg(long)]
    pub session: Option<String>,
    #[arg(long, requires = "session")]
    pub tab_id: Option<i64>,
    /// Target browser instance ID or unique label for a new session.
    #[arg(long, conflicts_with = "session")]
    pub browser: Option<String>,
    /// Keep a session this run started open after it completes.
    #[arg(long, conflicts_with = "session")]
    pub keep_session: bool,
    /// The run_id of an uncertain run whose effect you checked in the application's
    /// records. Until then the recipe does not run again.
    #[arg(long, value_name = "RUN_ID")]
    pub checked: Option<String>,
}

fn parse_param(value: &str) -> Result<(String, String), String> {
    value
        .split_once('=')
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .ok_or_else(|| "a parameter is key=value".to_owned())
}

/// One run, however the caller asked for it.
#[derive(Debug, Clone, Default)]
pub(crate) struct RunRequest {
    pub(crate) name: String,
    pub(crate) params: BTreeMap<String, String>,
    pub(crate) session: Option<String>,
    pub(crate) tab_id: Option<i64>,
    pub(crate) browser: Option<String>,
    pub(crate) keep_session: bool,
    /// The `run_id` of an uncertain run whose effect the caller has checked.
    pub(crate) checked: Option<String>,
}

/// A daemon older than this CLI cannot even parse the request for a session's log.
const RUN_LOG_HINT: &str = "If the daemon is older than this CLI, restart it";
/// Reasons that say the site no longer matches the recipe. A person, the caller, the
/// budget or a session that is gone says nothing about that.
const DRIFT: [&str; 7] = [
    "target_not_found",
    "target_ambiguous",
    "requires_failed",
    "origin_mismatch",
    "until_timeout",
    "output_missing",
    "step_refused",
];

/// Whether a run's ending counts toward marking its recipe stale.
fn drifted(reason: Option<&str>) -> bool {
    reason.is_some_and(|reason| DRIFT.contains(&reason))
}

/// A missing session is the caller's to fix; only an unknown request needs a restart.
fn run_log_failure(error: CliError) -> CliError {
    if runner::session_gone(&error) {
        error
    } else {
        CliError::Local(anyhow::anyhow!("{error}. {RUN_LOG_HINT}."))
    }
}

fn refused(recipe: &str, refusal: &Refusal) -> (Value, u8) {
    (
        json!({"status":"refused","recipe":recipe,"reason":refusal.reason,"message":refusal.message}),
        2,
    )
}

/// A lowered risk is a person's decision, never the author's alone.
fn unapproved(store: &Store, recipe: &model::Recipe) -> Option<Refusal> {
    let lowered = recipe.downgrades().len();
    (!store.approved(recipe)).then(|| {
        Refusal::new(
            "approval_required",
            format!(
                "This recipe lowers the risk of {lowered} step(s), so it runs only after a person \
                 reviews them and runs `bsk recipe approve {}` in a terminal. An agent must never \
                 approve them.",
                recipe.name
            ),
        )
    })
}

/// A run whose effect is unknown holds the recipe until the caller names it as checked.
fn held(store: &Store, name: &str, checked: Option<&str>) -> Option<Refusal> {
    let unchecked = store.unchecked(name)?;
    if checked == Some(unchecked.run_id.as_str()) {
        return None;
    }
    let what = match (unchecked.reason.as_str(), &unchecked.at) {
        ("interrupted", _) => "its process ended before it reported".to_owned(),
        (reason, Some(at)) => format!("{reason} at {at}"),
        (reason, None) => reason.to_owned(),
    };
    Some(Refusal::new(
        "effect_unchecked",
        format!(
            "Run {run} stopped with an effect nobody has checked ({what}), so repeating it could \
             do it twice. Check the application's records for what it did, then run again with \
             --checked {run} (checked in MCP).",
            run = unchecked.run_id
        ),
    ))
}

/// Shows a person what a recipe lowers and records their confirmation. It needs a
/// terminal and refuses piped input. Agents must never invoke this action.
fn approve(name: &str) -> Result<(), CliError> {
    use std::io::{BufRead, IsTerminal, Write};
    let store = Store::open().map_err(CliError::Local)?;
    let recipe = match store.load(name) {
        Ok(recipe) => recipe,
        Err(refusal) => {
            let (reply, exit) = refused(name, &refusal);
            return print(&reply, exit);
        }
    };
    let downgrades = recipe.downgrades();
    if downgrades.is_empty() {
        return print(
            &json!({"name":name,"revision":recipe.revision,"approval_required":false}),
            0,
        );
    }
    if !(std::io::stdin().is_terminal() && std::io::stderr().is_terminal()) {
        let (reply, exit) = refused(
            name,
            &Refusal::new(
                "approval_needs_person",
                "approve asks a person at a terminal to confirm each lowered risk; an agent must \
                 not approve them",
            ),
        );
        return print(&reply, exit);
    }
    let prompt = || -> std::io::Result<String> {
        let mut out = std::io::stderr().lock();
        writeln!(
            out,
            "Recipe {name}, revision {}: {}",
            recipe.revision, recipe.description
        )?;
        writeln!(out, "Site: {}", recipe.site.origins.join(", "))?;
        writeln!(
            out,
            "These steps look irreversible, but the recipe declares them reversible:"
        )?;
        for step in &downgrades {
            let key = step["key"]
                .as_str()
                .map(|key| format!(" {key} on"))
                .unwrap_or_default();
            writeln!(
                out,
                "  {}/{}: {}{key} {} \"{}\"",
                step["segment"].as_str().unwrap_or_default(),
                step["step"],
                step["action"].as_str().unwrap_or_default(),
                step["target"]["role"].as_str().unwrap_or_default(),
                step["target"]["name"].as_str().unwrap_or_default(),
            )?;
        }
        write!(
            out,
            "Approve only if each one can be undone. Type the recipe name to approve: "
        )?;
        out.flush()?;
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        Ok(line)
    };
    let answer = prompt()
        .context("ask for approval")
        .map_err(CliError::Local)?;
    if answer.trim() != name {
        return print(
            &json!({"approved":false,"name":name,"reason":"not_confirmed"}),
            1,
        );
    }
    store
        .approve(&recipe)
        .context("record the approval")
        .map_err(CliError::Local)?;
    print(
        &json!({"approved":true,"name":name,"revision":recipe.revision,
            "steps":downgrades.len()}),
        0,
    )
}

/// Replays a recipe. `call` reaches the daemon, so the CLI and MCP share this.
pub(crate) fn run(
    request: &RunRequest,
    mut call: impl FnMut(Method, Value, Duration) -> Result<Value, CliError>,
) -> (Value, u8) {
    let name = request.name.as_str();
    let store = match Store::open() {
        Ok(store) => store,
        Err(error) => {
            return refused(
                name,
                &Refusal::new("storage_unavailable", format!("{error:#}")),
            );
        }
    };
    let _recipe_lock = match store.lock_recipe(name) {
        Ok(lock) => lock,
        Err(refusal) => return refused(name, &refusal),
    };
    let recipe = match store.load(name) {
        Ok(recipe) => recipe,
        Err(refusal) => return refused(name, &refusal),
    };
    if let Err(error) = store.read_state(name) {
        return refused(
            name,
            &Refusal::new("storage_unavailable", format!("{error:#}")),
        );
    }
    if let Some(refusal) = unapproved(&store, &recipe) {
        return refused(name, &refusal);
    }
    if let Some(refusal) = held(&store, name, request.checked.as_deref()) {
        return refused(name, &refusal);
    }
    if let Some(checked) = &request.checked {
        store.release(name, checked);
    }
    let bound = recipe
        .resolve_params(&request.params)
        .and_then(|values| Ok((recipe.bind(&values)?, store::params_digest(&values))));
    let (bound, digest) = match bound {
        Ok(bound) => bound,
        Err(error) => {
            return refused(name, &Refusal::new("invalid_params", format!("{error:#}")));
        }
    };

    // An existing session may be doing something else: check before touching it.
    // The lock is held until this function returns.
    let mut _lock = None;
    let mut borrowed = Vec::new();
    if let Some(session) = &request.session {
        match store.lock_session(session) {
            Ok(lock) => _lock = Some(lock),
            Err(refusal) => return refused(name, &refusal),
        }
        match call(
            Method::SessionRunLog,
            json!({"session_id":session}),
            Duration::from_secs(5),
        ) {
            Ok(log) => {
                borrowed = serde_json::from_value(log["borrowed_tabs"].clone()).unwrap_or_default();
            }
            Err(error) => {
                return refused(
                    name,
                    &Refusal::new("session_unavailable", run_log_failure(error).to_string()),
                );
            }
        }
    }
    let (session, started) = match &request.session {
        Some(session) => (session.clone(), false),
        None => {
            // The overlay and the operation history both name the recipe at work.
            let label = format!("recipe:{name}");
            let mut params = json!({"task_name":label,"controller":{"name":label},"focused":false});
            if let Some(browser) = &request.browser {
                params["browser_instance_id"] = browser.as_str().into();
            }
            match call(Method::SessionStart, params, SESSION_START_TIMEOUT) {
                Ok(reply) => match reply["session_id"].as_str() {
                    Some(session) => (session.to_owned(), true),
                    None => {
                        return refused(
                            name,
                            &Refusal::new("session_unavailable", "the session did not start"),
                        );
                    }
                },
                Err(error) => {
                    return refused(
                        name,
                        &Refusal::new("session_unavailable", error.to_string()),
                    );
                }
            }
        }
    };

    let run_id = format!("r-{}", business_rpc::random_short_id());
    if let Err(error) = store.start_run(name, &run_id) {
        let (mut reply, exit) = refused(
            name,
            &Refusal::new("storage_unavailable", format!("{error:#}")),
        );
        if started {
            reply["session_id"] = session.as_str().into();
            match call(
                Method::SessionStop,
                json!({"session_id":session,"all":false}),
                SESSION_STOP_TIMEOUT,
            ) {
                Ok(_) => reply["session_stopped"] = true.into(),
                Err(error) => reply["session_stop_error"] = error.to_string().into(),
            }
        }
        return (reply, exit);
    }
    let mut log = store.run_log(name, &run_id);
    log.event(
        "start",
        json!({"revision":recipe.revision,"params_digest":digest,"session_started":started}),
    );
    let options = runner::Options::new(session.clone(), request.tab_id, borrowed);
    let outcome = runner::run(&bound, options, &mut log, &mut call);
    log.event(
        "end",
        json!({"status":outcome.status,"reason":outcome.reply["reason"],"at":outcome.at,
            "effects":outcome.reply["effects"],"elapsed_ms":outcome.reply["elapsed_ms"]}),
    );
    let deviated = drifted(outcome.reply["reason"].as_str());
    store.record_outcome(
        name,
        outcome.status,
        outcome.at.as_deref().filter(|_| deviated),
    );
    // Nobody knows yet what this run did, so the next one waits until someone checks.
    let unchecked = (outcome.status == "uncertain").then(|| store::Unchecked {
        run_id: run_id.clone(),
        reason: outcome.reply["reason"]
            .as_str()
            .unwrap_or("effect_unknown")
            .to_owned(),
        at: outcome.at.clone(),
        since_ms: 0,
    });
    let storage_error = store.finish_run(name, &run_id, unchecked).err();

    let mut reply = outcome.reply;
    if let Some(error) = storage_error {
        reply["storage_error"] =
            format!("{error:#}; the run marker is retained and must be checked before replay")
                .into();
    }
    reply["run_id"] = run_id.into();
    reply["recipe"] = name.into();
    reply["revision"] = recipe.revision.into();
    reply["session_id"] = session.as_str().into();
    // A session this run opened ends with it, unless the caller must continue in it.
    let finished = matches!(outcome.status, "completed" | "refused");
    if started && finished && !request.keep_session {
        match call(
            Method::SessionStop,
            json!({"session_id":session,"all":false}),
            SESSION_STOP_TIMEOUT,
        ) {
            Ok(_) => reply["session_stopped"] = true.into(),
            Err(error) => reply["session_stop_error"] = error.to_string().into(),
        }
    }
    (reply, outcome.exit)
}

/// What the session did, plus the facts only the live browser can add.
pub(crate) fn draft(
    session: &str,
    name: &str,
    description: &str,
    mut call: impl FnMut(Method, Value, Duration) -> Result<Value, CliError>,
) -> Result<Value, CliError> {
    let log: crate::daemon::run_log::RunLog = {
        let value = call(
            Method::SessionRunLog,
            json!({"session_id":session}),
            Duration::from_secs(5),
        )
        .map_err(run_log_failure)?;
        serde_json::from_value(value)
            .context("read the session's run log")
            .map_err(CliError::Local)?
    };
    let tabs = call(
        Method::ToolTabList,
        json!({"session_id":session,"scope":"agent"}),
        TOOL_IPC_TIMEOUT,
    )
    .unwrap_or_default();
    let url = tabs["tabs"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|tab| tab["active"] == true)
        .and_then(|tab| tab["url"].as_str());
    let network = call(
        Method::ToolNetwork,
        json!({"session_id":session,"limit":500,"max_text_chars":300}),
        TOOL_IPC_TIMEOUT,
    );
    let mut reply = self::draft::build(
        &log,
        name,
        description,
        url,
        &network
            .as_ref()
            .map(self::draft::writes)
            .unwrap_or_default(),
    );
    if network.is_err()
        && let Some(warnings) = reply["warnings"].as_array_mut()
    {
        warnings.push(
            "Network history was unavailable, so requests that changed data could not be listed."
                .into(),
        );
    }
    if let Ok(existing) = Store::open().and_then(|store| {
        store
            .load(name)
            .map_err(|refusal| anyhow::anyhow!(refusal.message))
    }) && let Some(warnings) = reply["warnings"].as_array_mut()
    {
        warnings.push(
            format!(
                "A recipe named {name} already exists at revision {revision}. Save this draft \
                 under another name, or set \"revision\": {revision} in it to replace that recipe.",
                revision = existing.revision
            )
            .into(),
        );
    }
    Ok(reply)
}

/// Saves a document, reporting what a person should check.
pub(crate) fn save(document: &[u8]) -> (Value, u8) {
    let failed = |reason: &str, message: String| {
        (json!({"saved":false,"reason":reason,"message":message}), 2)
    };
    let declared_revision = serde_json::from_slice::<Value>(document)
        .is_ok_and(|value| value.get("revision").is_some());
    let recipe = match store::parse_document(document) {
        Ok(recipe) => recipe,
        Err(refusal) => return failed(refusal.reason, refusal.message),
    };
    let store = match Store::open() {
        Ok(store) => store,
        Err(error) => return failed("storage_unavailable", format!("{error:#}")),
    };
    match store.save(recipe, declared_revision) {
        Ok(reply) => (reply, 0),
        Err(refusal) => failed(refusal.reason, refusal.message),
    }
}

pub(crate) fn list(site: Option<&str>) -> (Value, u8) {
    match Store::open().and_then(|store| store.list(site)) {
        Ok(reply) => (reply, 0),
        Err(error) => (
            json!({"reason":"storage_unavailable","message":format!("{error:#}")}),
            2,
        ),
    }
}

pub(crate) fn show(name: &str) -> (Value, u8) {
    match Store::open()
        .map_err(|error| Refusal::new("storage_unavailable", format!("{error:#}")))
        .and_then(|store| store.show(name))
    {
        Ok(reply) => (reply, 0),
        Err(refusal) => refused(name, &refusal),
    }
}

pub(crate) fn remove(name: &str) -> (Value, u8) {
    match Store::open()
        .map_err(|error| Refusal::new("storage_unavailable", format!("{error:#}")))
        .and_then(|store| store.remove(name))
    {
        Ok(true) => (json!({"removed":true,"name":name}), 0),
        Ok(false) => refused(
            name,
            &Refusal::new("recipe_not_found", format!("no recipe named {name}")),
        ),
        Err(error) => refused(name, &error),
    }
}

fn print(reply: &Value, exit: u8) -> Result<(), CliError> {
    println!(
        "{}",
        serde_json::to_string_pretty(reply).context("render recipe result")?
    );
    if exit == 0 {
        Ok(())
    } else {
        Err(CliError::RenderedExit { exit_code: exit })
    }
}

fn write_new_file(path: &std::path::Path, value: &Value) -> anyhow::Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("create {}", path.display()))?;
    file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
    Ok(())
}

pub fn dispatch(
    cmd: RecipeCmd,
    flags: &GlobalFlags,
    ctx: &business_rpc::ClientContext,
    _format: Format,
) -> Result<(), CliError> {
    {
        let rejected = || -> anyhow::Result<()> {
            ensure!(
                flags.context.is_none()
                    && flags.observation.is_none()
                    && flags.expect.is_none()
                    && flags.depends_on.is_empty(),
                "--context, --observation, --expect and --depends-on do not apply to recipes; a run synchronizes for itself and keeps expect on its steps"
            );
            Ok(())
        };
        rejected().map_err(|error| {
            CliError::from_rpc(RpcError {
                code: ErrorCode::InvalidParams,
                message: error.to_string(),
                data: None,
            })
        })?;
    }
    let op_ctx = ctx.without_action_metadata();
    match cmd.command {
        RecipeCommand::List { site } => {
            let (reply, exit) = list(site.as_deref());
            print(&reply, exit)
        }
        RecipeCommand::Show { name } => {
            let (reply, exit) = show(&name);
            print(&reply, exit)
        }
        RecipeCommand::Rm { name } => {
            let (reply, exit) = remove(&name);
            print(&reply, exit)
        }
        RecipeCommand::Approve { name } => approve(&name),
        RecipeCommand::Save { file } => {
            let bytes = std::fs::read(&file)
                .with_context(|| format!("read {}", file.display()))
                .map_err(CliError::Local)?;
            let (reply, exit) = save(&bytes);
            print(&reply, exit)
        }
        RecipeCommand::Draft(args) => {
            let (daemon, _protocol) = ensure_daemon::ensure_daemon_optimistic_with_protocol()
                .context("ensure daemon is running")?;
            let reply = draft(
                &args.session,
                &args.name,
                &args.description,
                |method, params, timeout| {
                    op_ctx.call(
                        daemon.sock_path.clone(),
                        "recipe",
                        method,
                        Some(params),
                        timeout,
                    )
                },
            )?;
            if let Some(out) = &args.out {
                write_new_file(out, &reply["draft"]).map_err(CliError::Local)?;
            }
            print(&reply, 0)
        }
        RecipeCommand::Run(args) => {
            let request = RunRequest {
                name: args.name,
                params: args.params.into_iter().collect(),
                session: args.session,
                tab_id: args.tab_id,
                browser: args.browser,
                keep_session: args.keep_session,
                checked: args.checked,
            };
            // A missing file or an unapproved risk needs no daemon.
            if let Ok(store) = Store::open() {
                let _lock = match store.lock_recipe(&request.name) {
                    Ok(lock) => lock,
                    Err(refusal) => {
                        let (reply, exit) = refused(&request.name, &refusal);
                        return print(&reply, exit);
                    }
                };
                let refusal = match store.load(&request.name) {
                    Ok(recipe) => match store.read_state(&request.name) {
                        Err(error) => {
                            Some(Refusal::new("storage_unavailable", format!("{error:#}")))
                        }
                        Ok(_) => unapproved(&store, &recipe)
                            .or_else(|| held(&store, &request.name, request.checked.as_deref())),
                    },
                    Err(refusal) => Some(refusal),
                };
                if let Some(refusal) = refusal {
                    let (reply, exit) = refused(&request.name, &refusal);
                    return print(&reply, exit);
                }
            }
            let (daemon, protocol) = ensure_daemon::ensure_daemon_optimistic_with_protocol()
                .context("ensure daemon is running")?;
            plan::check_protocol(&protocol).map_err(CliError::Local)?;
            let (mut reply, mut exit) = run(&request, |method, params, timeout| {
                op_ctx.call(
                    daemon.sock_path.clone(),
                    "recipe",
                    method,
                    Some(params),
                    timeout,
                )
            });
            if business_rpc::cancel_requested() {
                reply["cancelled"] = true.into();
                exit = exit_code_for(ErrorCode::Cancelled);
            }
            print(&reply, exit)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[derive(Parser)]
    struct Command {
        #[command(subcommand)]
        recipe: RecipeCommand,
    }

    #[test]
    fn only_a_page_that_deviates_counts_toward_a_stale_recipe() {
        for reason in ["target_not_found", "requires_failed", "until_timeout"] {
            assert!(drifted(Some(reason)), "{reason}");
        }
        for reason in [
            Some("session_unavailable"),
            Some("human_intervention"),
            Some("cancelled"),
            Some("budget_exceeded"),
            Some("effect_unknown"),
            None,
        ] {
            assert!(!drifted(reason), "{reason:?}");
        }
    }

    #[test]
    fn run_arguments_keep_values_intact_and_reject_contradictions() {
        let parsed = Command::try_parse_from([
            "recipe",
            "run",
            "report",
            "--param",
            "q=a=b",
            "--param",
            "empty=",
            "--session",
            "s",
            "--tab-id",
            "4",
        ])
        .unwrap();
        let RecipeCommand::Run(args) = parsed.recipe else {
            panic!();
        };
        assert_eq!(
            args.params,
            [
                ("q".to_string(), "a=b".to_string()),
                ("empty".to_string(), String::new())
            ]
        );
        for argv in [
            vec!["recipe", "run", "r", "--param", "novalue"],
            vec!["recipe", "run", "r", "--tab-id", "4"],
            vec!["recipe", "run", "r", "--session", "s", "--keep-session"],
            vec!["recipe", "run", "r", "--session", "s", "--browser", "b"],
            vec!["recipe", "draft", "--session", "s"],
        ] {
            assert!(Command::try_parse_from(argv.clone()).is_err(), "{argv:?}");
        }
    }
}
