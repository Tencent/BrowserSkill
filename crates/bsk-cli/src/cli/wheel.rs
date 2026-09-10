//! `bsk wheel` — dispatch a native Chromium mouse-wheel event.

use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{WheelParams, WheelResult};
use clap::Args;

use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::interaction::{parse_modifiers, split_target};
use crate::cli::navigate::parse_timeout_ms;

#[derive(Debug, Clone, Args)]
pub struct WheelArgs {
    /// Optional snapshot ref (`@e3`, `e3`) or CSS selector used as the wheel hit-test point.
    pub target: Option<String>,

    #[arg(long = "ref")]
    pub ref_: Option<String>,

    #[arg(long = "selector")]
    pub selector: Option<String>,

    #[arg(long)]
    pub session: String,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Horizontal wheel input in CSS pixels (positive is right).
    #[arg(long = "delta-x", default_value = "0", allow_negative_numbers = true, value_parser = parse_finite_delta)]
    pub delta_x: f64,

    /// Vertical wheel input in CSS pixels (positive is down).
    #[arg(long = "delta-y", default_value = "0", allow_negative_numbers = true, value_parser = parse_finite_delta)]
    pub delta_y: f64,

    /// Comma-separated modifiers (`alt,ctrl,shift,meta`).
    #[arg(long, default_value = "")]
    pub modifiers: String,

    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

pub fn dispatch(args: WheelArgs, format: Format) -> Result<(), CliError> {
    validate_deltas(args.delta_x, args.delta_y)?;
    let (ref_, selector) = split_optional_target(args.target, args.ref_, args.selector)?;
    let modifiers = parse_modifiers(&args.modifiers)
        .map_err(|e| CliError::Local(anyhow::anyhow!("--modifiers: {e}")))?;
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = WheelParams {
        session_id: args.session,
        ref_,
        selector,
        tab_id: args.tab_id,
        delta_x: args.delta_x,
        delta_y: args.delta_y,
        modifiers: if modifiers.is_empty() {
            None
        } else {
            Some(modifiers)
        },
        timeout_ms: Some(args.timeout),
    };
    let reply: WheelResult = crate::cli::business_rpc::call(
        info.sock_path,
        "wheel-1",
        Method::ToolWheel,
        Some(params),
        ipc_timeout(args.timeout),
    )?;
    match format {
        Format::Json => println!(
            "{}",
            serde_json::to_string_pretty(&reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
        ),
        Format::Human => {
            let target =
                format_used_target(reply.used_ref.as_deref(), reply.used_selector.as_deref());
            println!(
                "wheel ok tab={} target={target} at=({}, {}) delta=({}, {})",
                reply.tab_id, reply.x, reply.y, reply.delta_x, reply.delta_y
            );
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn parse_finite_delta(value: &str) -> Result<f64, String> {
    let parsed = value
        .parse::<f64>()
        .map_err(|_| format!("'{value}' is not a valid number"))?;
    if !parsed.is_finite() {
        return Err("wheel deltas must be finite numbers".into());
    }
    Ok(parsed)
}

fn validate_deltas(delta_x: f64, delta_y: f64) -> Result<(), CliError> {
    if !delta_x.is_finite() || !delta_y.is_finite() {
        return Err(CliError::Local(anyhow::anyhow!(
            "wheel deltas must be finite numbers"
        )));
    }
    if delta_x == 0.0 && delta_y == 0.0 {
        return Err(CliError::Local(anyhow::anyhow!(
            "at least one of --delta-x or --delta-y must be non-zero"
        )));
    }
    Ok(())
}

fn split_optional_target(
    positional: Option<String>,
    explicit_ref: Option<String>,
    explicit_selector: Option<String>,
) -> Result<(Option<String>, Option<String>), CliError> {
    if [&positional, &explicit_ref, &explicit_selector]
        .iter()
        .any(|target| target.as_ref().is_some_and(|value| value.trim().is_empty()))
    {
        return Err(CliError::Local(anyhow::anyhow!(
            "wheel target must not be empty"
        )));
    }
    if positional.is_none() && explicit_ref.is_none() && explicit_selector.is_none() {
        Ok((None, None))
    } else {
        split_target(positional, explicit_ref, explicit_selector)
    }
}

fn format_used_target(used_ref: Option<&str>, used_selector: Option<&str>) -> String {
    used_ref
        .map(|r| format!("@{r}"))
        .or_else(|| used_selector.map(str::to_string))
        .unwrap_or_else(|| "viewport-center".into())
}

fn ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms))
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(u64::from(timeout_ms / 1_000) + 15))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_target_supports_viewport_refs_and_selectors() {
        assert_eq!(
            split_optional_target(None, None, None).unwrap(),
            (None, None)
        );
        assert_eq!(
            split_optional_target(Some("@e3".into()), None, None).unwrap(),
            (Some("@e3".into()), None)
        );
        assert_eq!(
            split_optional_target(Some("#panel".into()), None, None).unwrap(),
            (None, Some("#panel".into()))
        );
    }

    #[test]
    fn finite_nonzero_deltas_are_required() {
        assert!(parse_finite_delta("600").is_ok());
        assert!(parse_finite_delta("NaN").is_err());
        assert!(validate_deltas(0.0, 0.0).is_err());
        assert!(validate_deltas(0.0, -120.0).is_ok());
    }
    #[test]
    fn rejects_empty_conflicting_targets_and_nonfinite_deltas() {
        for target in ["", " "] {
            assert!(split_optional_target(Some(target.into()), None, None).is_err());
            assert!(split_optional_target(None, Some(target.into()), None).is_err());
            assert!(split_optional_target(None, None, Some(target.into())).is_err());
        }
        assert!(split_optional_target(Some("e3".into()), Some("e4".into()), None).is_err());
        assert!(split_optional_target(None, Some("e3".into()), Some("#panel".into())).is_err());
        assert!(validate_deltas(f64::INFINITY, 120.0).is_err());
        assert!(validate_deltas(0.0, f64::NAN).is_err());
    }

    #[test]
    fn rejects_invalid_commands_before_starting_the_daemon() {
        use crate::cli::{Cli, Command};
        use clap::Parser;
        for options in [
            vec![],
            vec!["--delta-y", "120", "--ref", ""],
            vec!["--delta-y", "120", "--ref", "e3", "--selector", "#panel"],
            vec!["--delta-y", "120", "--modifiers", "invalid"],
        ] {
            let mut argv = vec!["bsk", "wheel", "--session", "s1"];
            argv.extend(options);
            let Command::Wheel(args) = Cli::try_parse_from(argv).unwrap().command else {
                panic!("wheel");
            };
            assert!(matches!(
                dispatch(args, Format::Json),
                Err(CliError::Local(_))
            ));
        }
    }
}
