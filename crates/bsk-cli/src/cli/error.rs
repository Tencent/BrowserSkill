//! Top-level CLI error type and rendering entry point.
//!
//! The single source of truth for `ErrorCode → { summary, hint,
//! exit_code }` lives in [`super::render_error`]; this module owns
//! [`CliError`] (the wrapper carrying daemon `RpcError`, transport
//! failures, and already-rendered errors) plus the [`render`]
//! function every business / admin command funnels through.
//!
//! Exit codes are documented in [`super::render_error`] and
//! design §3.1.

use std::io::Write;
use std::process::ExitCode;

use anyhow::Error;
use bsk_protocol::{ErrorCode, RpcError};
use clap::CommandFactory;
use clap::error::{ContextKind, ContextValue, ErrorKind};
use serde::Serialize;
use thiserror::Error;

use super::render_error;
use crate::daemon::start_error::recovery_hint;

/// Strongly-typed CLI error. Wraps either a structured daemon error or
/// a transport / setup failure (`anyhow::Error`).
#[derive(Debug, Error)]
pub enum CliError {
    /// Structured error reported by the daemon (or extension via the
    /// daemon's RPC layer).
    #[error("{message}")]
    Rpc {
        code: ErrorCode,
        message: String,
        /// Optional structured payload the daemon attaches for richer
        /// rendering (M10.1: `multiple_browsers_online` carries the
        /// browser list; `invalid_params` for ambiguous label match
        /// carries the matching instance ids).
        data: Option<serde_json::Value>,
        #[source]
        source: Option<Error>,
    },

    /// Command already rendered its structured payload; main should only
    /// return the matching non-zero exit code.
    #[error("{message}")]
    Rendered { code: ErrorCode, message: String },

    /// Command already rendered its result and only needs to communicate
    /// a command-specific non-zero status. Unlike `Rendered`, this is not
    /// pretending that a daemon protocol error occurred.
    #[error("command reported an unsuccessful status")]
    RenderedExit { exit_code: u8 },

    /// Local transport / setup failure (e.g. couldn't reach the
    /// daemon, JSON encode failed). Maps to exit code 2.
    #[error("{0:#}")]
    Local(#[from] Error),
}

impl CliError {
    pub fn from_rpc(err: RpcError) -> Self {
        CliError::Rpc {
            code: err.code,
            message: err.message,
            data: err.data,
            source: None,
        }
    }

    pub fn code(&self) -> Option<ErrorCode> {
        match self {
            CliError::Rpc { code, .. } => Some(*code),
            CliError::Rendered { code, .. } => Some(*code),
            CliError::RenderedExit { .. } => None,
            CliError::Local(_) => None,
        }
    }

    pub fn data(&self) -> Option<&serde_json::Value> {
        match self {
            CliError::Rpc { data, .. } => data.as_ref(),
            _ => None,
        }
    }

    /// Map this error to the CLI exit code (§3.1).
    pub fn exit_code(&self) -> u8 {
        if let CliError::RenderedExit { exit_code } = self {
            return *exit_code;
        }
        match self.code() {
            Some(code) => exit_code_for(code),
            None => 2, // local / protocol-level transport failure
        }
    }
}

/// Re-exported convenience wrapper around
/// [`render_error::exit_code_for`] so existing callers keep working.
pub fn exit_code_for(code: ErrorCode) -> u8 {
    render_error::exit_code_for(code)
}

/// Output rendering format selector for top-level CLI errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Human,
    Json,
}

/// Guidance for `--session` / `--tab-id` given before the subcommand.
const MISPLACED_COMMAND_OPTION_HINT: &str = "--session and --tab-id are command-specific \
     options; place them after a subcommand that supports them, e.g. `bsk click --session <id> \
     --tab-id <tab> --selector '#submit'`; run `bsk <cmd> --help` for supported options";

/// Render clap failures using the CLI's error contract, while preserving
/// successful help/version output and the existing usage-error exit code.
pub fn render_parse_error(err: clap::Error, format: Format) -> ExitCode {
    if !err.use_stderr() {
        let _ = err.print();
        return ExitCode::SUCCESS;
    }

    let (err, hint) = match misplaced_command_option_error(&err) {
        Some(rebuilt) => (rebuilt, Some(MISPLACED_COMMAND_OPTION_HINT)),
        None => (err, None),
    };
    let exit = exit_code_for(ErrorCode::InvalidParams);
    match format {
        Format::Json => {
            let rendered = err.to_string();
            let error = CliError::Rpc {
                code: ErrorCode::InvalidParams,
                message: parse_error_summary(&err, &rendered),
                data: Some(serde_json::json!({
                    "reason": "cli_parse_error",
                    "details": rendered.trim_end(),
                })),
                source: None,
            };
            let hint = hint.or_else(|| render_error::hint_for_code(ErrorCode::InvalidParams));
            println!("{}", json_error_string(&error, exit, hint));
        }
        Format::Human => {
            let _ = err.print();
        }
    }
    ExitCode::from(exit)
}

/// clap's own did-you-mean can point `--session` at `--version` and print
/// `Usage: bsk --version <COMMAND>`. Rebuild the error so its tip and usage
/// describe where the option actually belongs.
fn misplaced_command_option_error(err: &clap::Error) -> Option<clap::Error> {
    let arg = match (err.kind(), err.get(ContextKind::InvalidArg)) {
        (ErrorKind::UnknownArgument, Some(ContextValue::String(arg)))
            if matches!(arg.as_str(), "--session" | "--tab-id") =>
        {
            arg.clone()
        }
        _ => return None,
    };
    let mut cmd = super::Cli::command();
    // The usage clap printed names the suggested argument when it found one;
    // otherwise it is the usage of the command being parsed, e.g. `bsk tab`.
    let usage = match (
        err.get(ContextKind::SuggestedArg),
        err.get(ContextKind::Usage),
    ) {
        (None, Some(ContextValue::StyledStr(usage))) => usage.clone(),
        _ => cmd.render_usage(),
    };
    let mut rebuilt = clap::Error::new(ErrorKind::UnknownArgument).with_cmd(&cmd);
    rebuilt.insert(ContextKind::InvalidArg, ContextValue::String(arg));
    rebuilt.insert(
        ContextKind::Suggested,
        ContextValue::StyledStrs(vec![MISPLACED_COMMAND_OPTION_HINT.into()]),
    );
    rebuilt.insert(ContextKind::Usage, ContextValue::StyledStr(usage));
    Some(rebuilt)
}

/// One-line `message` for JSON callers. clap renders `error: <summary>`
/// followed by blank-line separated tips and usage, which stay in
/// `data.details`. The summary can wrap, e.g. a missing required argument
/// or the possible values for an invalid one, so join its lines.
fn parse_error_summary(err: &clap::Error, rendered: &str) -> String {
    // A bare subcommand group renders its help page instead of an error.
    if err.kind() == ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand {
        return "a subcommand is required but one was not provided".into();
    }
    let rendered = rendered.strip_prefix("error: ").unwrap_or(rendered);
    rendered
        .split("\n\n")
        .next()
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `--json` error shape. Top-level fields (review I2 fix to round-1):
/// `{ code, message, hint, exit_code, data }`. The previous shape
/// nested everything under an `"error"` key — design §10 / §3.1
/// describe `error.code` as the daemon-level field name on the
/// **wire**, not as a CLI rendering envelope, so the extra
/// indirection is a leftover from M3.5 that was easy to script
/// against.
#[derive(Debug, Serialize)]
struct JsonError {
    code: Option<ErrorCode>,
    message: String,
    hint: Option<&'static str>,
    exit_code: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

/// Build the `--json` payload for a [`CliError`]. Pulled out of
/// [`render`] so the JSON shape can be unit-tested without capturing
/// stdout (review I2 fix to round-1).
fn json_error_string(err: &CliError, exit: u8, hint: Option<&'static str>) -> String {
    let body = JsonError {
        code: err.code(),
        message: err.to_string(),
        hint,
        exit_code: exit,
        data: err.data().cloned(),
    };
    serde_json::to_string_pretty(&body)
        .unwrap_or_else(|_| "{\"message\":\"failed to encode error\"}".into())
}

/// Renderer extension hook for commands that want to inject a
/// structured "extra section" between the centralised summary and
/// the centralised hint (review I3 fix to round-1).
///
/// Implementations write directly to a generic `&mut dyn Write` so
/// tests can capture into a `Vec<u8>` and assert on the rendered
/// stderr output. Production callers receive a write handle wrapping
/// `std::io::stderr()`.
///
/// Examples: `bsk session start` writes the connected-browsers table
/// here for `multiple_browsers_online`; the matching ambiguous-label
/// error writes a bullet list of candidate `instance_id`s.
pub trait RenderExtras {
    fn write_extras(&self, out: &mut dyn std::io::Write) -> std::io::Result<()>;
}

impl<F> RenderExtras for F
where
    F: Fn(&mut dyn std::io::Write) -> std::io::Result<()>,
{
    fn write_extras(&self, out: &mut dyn std::io::Write) -> std::io::Result<()> {
        self(out)
    }
}

/// Resolve centralised render metadata for a [`CliError`], when it
/// carries an [`ErrorCode`].
fn render_info_for(err: &CliError) -> Option<render_error::RenderInfo> {
    err.code()
        .map(|code| render_error::info_for_error(code, err.data()))
}

/// Hint line for human / JSON rendering, including the local-failure
/// fallback when there is no daemon [`ErrorCode`].
fn hint_for(
    err: &CliError,
    render_info: Option<&render_error::RenderInfo>,
) -> Option<&'static str> {
    render_info
        .and_then(|info| info.hint)
        .or_else(|| match err {
            CliError::Local(error) => recovery_hint(error).or(Some(
                "is the daemon running? try `bsk daemon start` or `bsk status`",
            )),
            _ => None,
        })
}

/// Render an error to stderr (human-readable) or stdout (`--json`),
/// returning the matching `ExitCode`.
///
/// Both formats route through [`render_error::info_for`] so the
/// summary / hint / exit-code stay in sync. Commands that have
/// already printed a bespoke human-readable rendering must wrap
/// their result in [`CliError::Rendered`] so this function only
/// surfaces the matching exit code.
pub fn render(err: &CliError, format: Format) -> ExitCode {
    render_with_extras(err, format, None)
}

/// Variant of [`render`] that lets a command inject a per-error
/// "extra section" between the summary and the hint without giving
/// up the centralised summary/hint/exit-code table (review I3).
///
/// In `--json` mode the extras are skipped — the structured payload
/// already lives in `error.data` and per-command renderers shouldn't
/// duplicate it. In human mode the order is:
///
/// ```text
///   error: <centralised summary>
///   <extras (caller-controlled)>
///   hint: <centralised hint>
///   details: <raw daemon message, when it adds context>
/// ```
pub fn render_with_extras(
    err: &CliError,
    format: Format,
    extras: Option<&dyn RenderExtras>,
) -> ExitCode {
    let exit = err.exit_code();
    if matches!(
        err,
        CliError::Rendered { .. } | CliError::RenderedExit { .. }
    ) {
        return ExitCode::from(exit);
    }
    let render_info = render_info_for(err);
    let hint = hint_for(err, render_info.as_ref());

    match format {
        Format::Json => {
            let json = json_error_string(err, exit, hint);
            println!("{json}");
        }
        Format::Human => {
            let summary = match render_info {
                Some(info) => info.summary.to_string(),
                None => err.to_string(),
            };
            let raw = err.to_string();
            let mut out = std::io::stderr();
            // Prefer the friendly summary from the `render_error`
            // table so users see a clear English error message instead
            // of the daemon's terse machine-oriented message. Fall back to
            // whatever the wrapped error renders for transport /
            // setup failures that have no `ErrorCode`.
            let _ = writeln!(out, "error: {summary}");
            if let Some(extras) = extras
                && let Err(e) = extras.write_extras(&mut out)
            {
                let _ = writeln!(out, "(failed to render extras: {e})");
            }
            if let Some(h) = hint {
                let _ = writeln!(out, "hint: {h}");
            }
            // When the wrapped daemon message adds context the
            // summary hides ("session reservation vanished before
            // commit", a CDP description, etc.), surface it on a
            // `details:` line so power users still see it without
            // burying the friendly summary.
            if err.code().is_some() && !raw.is_empty() && raw != summary {
                let _ = writeln!(out, "details: {raw}");
            }
        }
    }
    ExitCode::from(exit)
}

/// Test-only helper that writes the same human-mode output [`render`]
/// would emit to stderr into a string. Used by `bsk session start`'s
/// I3 unit tests to lock in the "summary → extras → hint → details"
/// order without redirecting the real stderr.
#[cfg(test)]
pub(crate) fn render_human_to_string(err: &CliError, extras: Option<&dyn RenderExtras>) -> String {
    let mut buf: Vec<u8> = Vec::new();
    if matches!(
        err,
        CliError::Rendered { .. } | CliError::RenderedExit { .. }
    ) {
        return String::new();
    }
    let render_info = render_info_for(err);
    let summary = match render_info {
        Some(info) => info.summary.to_string(),
        None => err.to_string(),
    };
    let hint = hint_for(err, render_info.as_ref());
    let _ = writeln!(buf, "error: {summary}");
    if let Some(extras) = extras
        && let Err(e) = extras.write_extras(&mut buf)
    {
        let _ = writeln!(buf, "(failed to render extras: {e})");
    }
    if let Some(h) = hint {
        let _ = writeln!(buf, "hint: {h}");
    }
    let raw = err.to_string();
    if err.code().is_some() && !raw.is_empty() && raw != summary {
        let _ = writeln!(buf, "details: {raw}");
    }
    String::from_utf8(buf).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_code_matches_design_table() {
        // Mirror of `render_error::tests::exit_codes_match_design_table`
        // — keeps both call sites in lockstep with design §3.1.
        assert_eq!(exit_code_for(ErrorCode::InvalidParams), 1);
        assert_eq!(exit_code_for(ErrorCode::NotFound), 1);
        assert_eq!(exit_code_for(ErrorCode::PermissionDenied), 1);
        assert_eq!(exit_code_for(ErrorCode::NoBrowserConnected), 1);
        assert_eq!(exit_code_for(ErrorCode::MultipleBrowsersOnline), 1);
        assert_eq!(exit_code_for(ErrorCode::Unsupported), 1);

        assert_eq!(exit_code_for(ErrorCode::ProtocolError), 2);
        assert_eq!(exit_code_for(ErrorCode::Cancelled), 2);

        assert_eq!(exit_code_for(ErrorCode::CdpFailed), 3);
        assert_eq!(exit_code_for(ErrorCode::Timeout), 4);
        // Review I4: `unknown_method` is a version-mismatch symptom
        // and lives in the version-incompatibility bucket, not the
        // user-error bucket.
        assert_eq!(exit_code_for(ErrorCode::UnknownMethod), 5);
        assert_eq!(exit_code_for(ErrorCode::VersionTooOld), 5);
    }

    #[test]
    fn cli_error_from_rpc_preserves_code() {
        let rpc = RpcError {
            code: ErrorCode::NoBrowserConnected,
            message: "no browser".into(),
            data: None,
        };
        let cli = CliError::from_rpc(rpc);
        assert_eq!(cli.code(), Some(ErrorCode::NoBrowserConnected));
        assert_eq!(cli.exit_code(), 1);
    }

    #[test]
    fn cli_error_from_anyhow_is_protocol_level() {
        let any: CliError = anyhow::anyhow!("daemon unreachable").into();
        assert_eq!(any.code(), None);
        assert_eq!(any.exit_code(), 2);
    }

    #[test]
    fn rendered_error_uses_structured_exit_code() {
        let err = CliError::Rendered {
            code: ErrorCode::CdpFailed,
            message: "already rendered".into(),
        };
        assert_eq!(err.code(), Some(ErrorCode::CdpFailed));
        assert_eq!(err.exit_code(), 3);
    }

    #[test]
    fn rendered_exit_uses_command_specific_status_without_protocol_code() {
        let err = CliError::RenderedExit { exit_code: 1 };
        assert_eq!(err.code(), None);
        assert_eq!(err.exit_code(), 1);
    }

    /// Review I2: the `--json` payload must be flat at the top level.
    /// The previous shape nested everything under `"error"` which was
    /// awkward for shell scripts (`jq -r '.error.code'`) and contradicted
    /// the design's wire-level naming.
    #[test]
    fn json_error_shape_is_flat() {
        let cli = CliError::from_rpc(RpcError {
            code: ErrorCode::MultipleBrowsersOnline,
            message: "more than one browser".into(),
            data: Some(serde_json::json!({"browsers": [{"instance_id": "alpha"}]})),
        });
        let exit = cli.exit_code();
        let hint = hint_for(&cli, render_info_for(&cli).as_ref());
        let json = json_error_string(&cli, exit, hint);
        let parsed: serde_json::Value =
            serde_json::from_str(&json).expect("--json output must parse");
        assert_eq!(
            parsed.get("code"),
            Some(&serde_json::json!("multiple_browsers_online"))
        );
        assert_eq!(parsed.get("exit_code"), Some(&serde_json::json!(1)));
        assert_eq!(
            parsed.get("message"),
            Some(&serde_json::json!("more than one browser"))
        );
        assert!(
            parsed.get("hint").and_then(|v| v.as_str()).is_some(),
            "every code in the table provides a hint today"
        );
        assert_eq!(
            parsed.get("data"),
            Some(&serde_json::json!({"browsers": [{"instance_id": "alpha"}]}))
        );
        assert!(
            parsed.get("error").is_none(),
            "the deprecated `error` envelope must not appear in --json output"
        );
    }

    #[test]
    fn json_error_shape_omits_data_and_code_for_local_failures() {
        let local: CliError = anyhow::anyhow!("daemon unreachable").into();
        let exit = local.exit_code();
        let hint = hint_for(&local, render_info_for(&local).as_ref()).or(Some(
            "is the daemon running? try `bsk daemon start` or `bsk status`",
        ));
        let json = json_error_string(&local, exit, hint);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.get("code"), Some(&serde_json::Value::Null));
        assert!(
            parsed.get("data").is_none(),
            "no data field for local failures"
        );
        assert_eq!(parsed.get("exit_code"), Some(&serde_json::json!(2)));
        assert_eq!(
            parsed.get("message"),
            Some(&serde_json::json!("daemon unreachable"))
        );
    }

    #[test]
    fn startup_recovery_survives_contexts_in_human_and_json_output() {
        use crate::daemon::start_error::DaemonStartFailure;

        assert_ne!(
            DaemonStartFailure::AutoStartDisabled.hint(),
            DaemonStartFailure::IndependentStartFailed.hint()
        );
        for (failure, recovery_action) in [
            (
                DaemonStartFailure::AutoStartDisabled,
                "restore the daemon in its owning environment with its original configuration",
            ),
            (
                DaemonStartFailure::IndependentStartFailed,
                "use `bsk daemon start --foreground` in a persistent host task",
            ),
        ] {
            let error = anyhow::Error::new(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "startup fixture cause",
            ))
            .context(failure)
            .context("automatic daemon startup failed")
            .context("ensure daemon is running");
            let cli = CliError::Local(error);
            let hint = hint_for(&cli, render_info_for(&cli).as_ref());
            assert_eq!(hint, Some(failure.hint()));
            let json: serde_json::Value =
                serde_json::from_str(&json_error_string(&cli, cli.exit_code(), hint)).unwrap();
            assert!(json["code"].is_null());
            assert_eq!(json["exit_code"], 2);
            assert_eq!(json["hint"], failure.hint());
            assert!(
                json["message"]
                    .as_str()
                    .unwrap()
                    .contains("startup fixture cause")
            );
            // Message-only consumers must still receive an actionable recovery step.
            assert!(json["message"].as_str().unwrap().contains(recovery_action));
            assert!(!json.to_string().contains("run_in_background"));
            assert!(json.get("data").is_none());
            let human = render_human_to_string(&cli, None);
            assert!(human.contains("startup fixture cause"));
            assert!(human.contains(recovery_action));
            assert!(!human.contains("run_in_background"));
            assert!(human.contains(&format!("hint: {}", failure.hint())));
            assert!(!human.contains("try `bsk daemon start` or `bsk status`"));
        }
    }

    #[test]
    fn ordinary_local_errors_keep_their_existing_hint() {
        use crate::daemon::start_error::DaemonStartFailure;

        // Even identical wording must not classify an untyped error as startup recovery.
        let cli = CliError::Local(anyhow::anyhow!(
            DaemonStartFailure::AutoStartDisabled.to_string()
        ));
        assert_eq!(
            hint_for(&cli, None),
            Some("is the daemon running? try `bsk daemon start` or `bsk status`")
        );
    }

    #[test]
    fn permission_denied_element_not_visible_renders_geometry_hint() {
        let cli = CliError::from_rpc(RpcError {
            code: ErrorCode::PermissionDenied,
            message: "element not visible (no content quads)".into(),
            data: Some(serde_json::json!({ "reason": "element_not_visible" })),
        });
        let stderr = render_human_to_string(&cli, None);
        assert!(stderr.contains("target element has no visible geometry"));
        assert!(stderr.contains("rerun snapshot"));
        assert!(!stderr.contains("Agent Window sandbox"));
        assert!(!stderr.contains("tab borrow"));
        assert!(stderr.contains("details: element not visible"));
    }

    #[test]
    fn permission_denied_agent_window_scope_keeps_sandbox_hint() {
        let cli = CliError::from_rpc(RpcError {
            code: ErrorCode::PermissionDenied,
            message: "click can only act on tabs inside the Agent Window".into(),
            data: Some(serde_json::json!({ "reason": "agent_window_scope" })),
        });
        let stderr = render_human_to_string(&cli, None);
        assert!(stderr.contains("operation denied by the Agent Window sandbox"));
        assert!(stderr.contains("tab borrow"));
    }

    #[test]
    fn not_found_ref_uses_observe_hint_in_json() {
        let cli = CliError::from_rpc(RpcError {
            code: ErrorCode::NotFound,
            message: "ref @e99 unknown for tab 7".into(),
            data: Some(serde_json::json!({ "reason": "ref_not_found" })),
        });
        let exit = cli.exit_code();
        let hint = hint_for(&cli, render_info_for(&cli).as_ref());
        let json = json_error_string(&cli, exit, hint);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.get("code"), Some(&serde_json::json!("not_found")));
        assert!(
            parsed
                .get("hint")
                .and_then(|v| v.as_str())
                .unwrap()
                .contains("bsk observe")
        );
        assert!(
            !parsed
                .get("hint")
                .and_then(|v| v.as_str())
                .unwrap()
                .contains("bsk browsers")
        );
    }

    #[test]
    fn not_found_selector_uses_selector_hint_in_json() {
        let cli = CliError::from_rpc(RpcError {
            code: ErrorCode::NotFound,
            message: "selector .missing did not match".into(),
            data: Some(serde_json::json!({ "reason": "selector_not_found" })),
        });
        let exit = cli.exit_code();
        let hint = hint_for(&cli, render_info_for(&cli).as_ref());
        let json = json_error_string(&cli, exit, hint);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(
            parsed
                .get("hint")
                .and_then(|v| v.as_str())
                .unwrap()
                .contains("CSS selector")
        );
    }
    #[test]
    fn pre_input_errors_keep_their_diagnostics_without_a_readiness_reason() {
        for (code, message) in [
            (ErrorCode::Cancelled, "click aborted"),
            (
                ErrorCode::InvalidParams,
                "click_count must be greater than zero",
            ),
            (ErrorCode::CdpFailed, "action geometry query failed"),
        ] {
            let cli = CliError::from_rpc(RpcError {
                code,
                message: message.into(),
                data: Some(serde_json::json!({"effect_state": "none"})),
            });
            let human = render_human_to_string(&cli, None);
            assert!(human.contains(message));
            assert!(!human.contains("did not become ready"));
            assert!(!human.contains("observe the page again before retrying"));
        }
    }

    #[test]
    fn unknown_input_keeps_the_original_message_in_human_and_json_output() {
        let message = "visual target changed after the first click";
        let cli = CliError::from_rpc(RpcError {
            code: ErrorCode::NotFound,
            message: message.into(),
            data: Some(
                serde_json::json!({"reason": "input_outcome_unknown", "effect_state": "unknown"}),
            ),
        });
        let human = render_human_to_string(&cli, None);
        assert!(human.contains("do not repeat the input"));
        assert!(human.contains(&format!("details: {message}")));
        let json: serde_json::Value = serde_json::from_str(&json_error_string(
            &cli,
            cli.exit_code(),
            hint_for(&cli, render_info_for(&cli).as_ref()),
        ))
        .unwrap();
        assert_eq!(json["message"], message);
        assert_eq!(json["data"]["effect_state"], "unknown");
    }
}
