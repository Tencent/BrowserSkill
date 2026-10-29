//! `bsk drag`: an entire press, optional hold, move and release in one request.
use super::{
    dialogs::print_dialog_summaries,
    ensure_daemon::ensure_daemon,
    error::{CliError, Format},
    interaction::{CliMouseButton, parse_modifiers, split_target},
    navigate::parse_timeout_ms,
};
use anyhow::Context;
use bsk_protocol::{
    Method,
    tools::{DragParams, DragPoint, DragResult, DragTarget},
};
use clap::Args;
use std::time::Duration;

#[derive(Debug, Clone, Args)]
pub struct DragArgs {
    /// Source ref or CSS selector (selectors must match exactly one element).
    pub source: String,
    /// Destination ref or CSS selector; mutually exclusive with --dx/--dy.
    #[arg(long, conflicts_with_all = ["dx", "dy"], required_unless_present_any = ["dx", "dy"])]
    pub to: Option<String>,
    #[arg(long, allow_negative_numbers = true)]
    pub dx: Option<f64>,
    #[arg(long, allow_negative_numbers = true)]
    pub dy: Option<f64>,
    /// Source offset from its visible action point, in viewport CSS pixels.
    #[arg(long, default_value_t = 0.0, allow_negative_numbers = true)]
    pub from_offset_x: f64,
    #[arg(long, default_value_t = 0.0, allow_negative_numbers = true)]
    pub from_offset_y: f64,
    #[arg(long, requires = "to", allow_negative_numbers = true)]
    pub to_offset_x: Option<f64>,
    #[arg(long, requires = "to", allow_negative_numbers = true)]
    pub to_offset_y: Option<f64>,
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub tab_id: Option<i64>,
    #[arg(long)]
    pub observation_id: Option<String>,
    #[arg(long, value_enum, default_value_t = CliMouseButton::Left)]
    pub button: CliMouseButton,
    #[arg(long, default_value = "")]
    pub modifiers: String,
    #[arg(long, default_value = "0ms", value_parser = parse_hold_ms)]
    pub hold: u32,
    #[arg(long, default_value = "500ms", value_parser = parse_timeout_ms)]
    pub duration: u32,
    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

fn target(value: String, x: f64, y: f64) -> Result<DragTarget, CliError> {
    if value.trim().is_empty() || !x.is_finite() || !y.is_finite() {
        return Err(CliError::Local(anyhow::anyhow!(
            "drag target must be nonempty and offsets finite"
        )));
    }
    let (ref_, selector) = split_target(Some(value), None, None)?;
    Ok(DragTarget {
        ref_,
        selector,
        offset: if x == 0.0 && y == 0.0 {
            None
        } else {
            Some(DragPoint { x, y })
        },
    })
}

pub fn dispatch(args: DragArgs, format: Format) -> Result<(), CliError> {
    let source = target(args.source, args.from_offset_x, args.from_offset_y)?;
    let destination = args
        .to
        .map(|s| {
            target(
                s,
                args.to_offset_x.unwrap_or(0.0),
                args.to_offset_y.unwrap_or(0.0),
            )
        })
        .transpose()?;
    let delta = if destination.is_none() {
        Some(DragPoint {
            x: args.dx.unwrap_or(0.0),
            y: args.dy.unwrap_or(0.0),
        })
    } else {
        None
    };
    if delta
        .as_ref()
        .is_some_and(|d| !d.x.is_finite() || !d.y.is_finite() || (d.x == 0.0 && d.y == 0.0))
        || args.hold > 5000
        || !(1..=5000).contains(&args.duration)
        || args.timeout == 0
    {
        return Err(CliError::Local(anyhow::anyhow!(
            "drag requires a finite nonzero delta, hold 0..5000ms, duration 1..5000ms and positive timeout"
        )));
    }
    let modifiers =
        parse_modifiers(&args.modifiers).map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
    let params = DragParams {
        session_id: args.session,
        tab_id: args.tab_id,
        source,
        target: destination,
        delta,
        button: Some(args.button.into()),
        modifiers: Some(modifiers),
        hold_ms: Some(args.hold),
        duration_ms: Some(args.duration),
        timeout_ms: Some(args.timeout),
        observation_id: args.observation_id,
    };
    let info = ensure_daemon().context("ensure daemon is running")?;
    let reply: DragResult = super::business_rpc::call(
        info.sock_path,
        "drag-1",
        Method::ToolDrag,
        Some(params),
        Duration::from_millis(u64::from(args.timeout) + 15000),
    )?;
    match format {
        Format::Json => println!(
            "{}",
            serde_json::to_string_pretty(&reply).map_err(|e| CliError::Local(e.into()))?
        ),
        Format::Human => {
            println!(
                "drag input delivered tab={} from=({}, {}) to=({}, {}); observe to verify",
                reply.tab_id, reply.source.x, reply.source.y, reply.target.x, reply.target.y
            );
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn parse_hold_ms(value: &str) -> Result<u32, String> {
    if matches!(value, "0" | "0ms" | "0s") {
        Ok(0)
    } else {
        parse_timeout_ms(value)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Command};
    use clap::Parser;
    #[test]
    fn parses_drag_destinations_hold_and_negative_offsets() {
        for tail in [
            vec!["--to", "@e8"],
            vec!["--dx", "-240", "--dy", "20", "--hold", "500ms"],
        ] {
            let mut argv = vec!["bsk", "drag", "@e3", "--session", "test"];
            argv.extend(tail);
            let Command::Drag(args) = Cli::try_parse_from(argv).unwrap().command else {
                panic!("drag")
            };
            assert_eq!(args.source, "@e3");
            assert_eq!(args.duration, 500);
        }
        assert!(
            Cli::try_parse_from([
                "bsk",
                "drag",
                "e3",
                "--to",
                "e8",
                "--dx",
                "1",
                "--session",
                "test"
            ])
            .is_err()
        );
        assert!(Cli::try_parse_from(["bsk", "drag", "e3", "--session", "test"]).is_err());
    }
    #[test]
    fn invalid_drag_is_rejected_before_starting_daemon() {
        for tail in [
            vec!["--dx", "0"],
            vec!["--dx", "NaN"],
            vec!["--to", ""],
            vec!["--to", "e8", "--hold", "6s"],
            vec!["--to", "e8", "--modifiers", "unknown"],
        ] {
            let mut argv = vec!["bsk", "drag", "e3", "--session", "test"];
            argv.extend(tail);
            let Command::Drag(args) = Cli::try_parse_from(argv).unwrap().command else {
                panic!("drag")
            };
            assert!(matches!(
                dispatch(args, Format::Json),
                Err(CliError::Local(_))
            ));
        }
    }
}
