//! `bsk wheel` — dispatch a native Chromium mouse-wheel event.

use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{WheelParams, WheelResult};
use clap::{Args, ValueEnum};

use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::interaction::{parse_modifiers, split_target};
use crate::cli::navigate::parse_timeout_ms;

/// Per-event weighting profile for a burst (`--repeat` > 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum BurstEasing {
    /// Split the requested delta evenly across the burst.
    Linear,
    /// Front-load the requested delta and decay the tail (a flick that settles).
    EaseOut,
}

/// Geometric decay per event for [`BurstEasing::EaseOut`].
const EASE_OUT_DECAY: f64 = 0.82;

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
    ///
    /// With `--repeat` > 1 this is the total horizontal delta for the burst.
    #[arg(long = "delta-x", default_value = "0", allow_negative_numbers = true, value_parser = parse_finite_delta)]
    pub delta_x: f64,

    /// Vertical wheel input in CSS pixels (positive is down).
    ///
    /// With `--repeat` > 1 this is the total vertical delta for the burst.
    #[arg(long = "delta-y", default_value = "0", allow_negative_numbers = true, value_parser = parse_finite_delta)]
    pub delta_y: f64,

    /// Comma-separated modifiers (`alt,ctrl,shift,meta`).
    #[arg(long, default_value = "")]
    pub modifiers: String,

    /// Number of wheel events to dispatch in one invocation (1–200).
    ///
    /// The events share one daemon connection, so the per-event cost is the
    /// round trip rather than a process start.
    #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..=200))]
    pub repeat: u32,

    /// Milliseconds between events of a burst (0–5000); ignored when `--repeat` is 1.
    #[arg(long = "interval-ms", default_value_t = 16, value_parser = clap::value_parser!(u64).range(0..=5000))]
    pub interval_ms: u64,

    /// How a burst splits the requested delta across its events.
    #[arg(long = "ease", value_enum, default_value = "linear")]
    pub ease: BurstEasing,

    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

pub fn dispatch(args: WheelArgs, format: Format) -> Result<(), CliError> {
    validate_deltas(args.delta_x, args.delta_y)?;
    let (ref_, selector) = split_optional_target(args.target, args.ref_, args.selector)?;
    let modifiers = parse_modifiers(&args.modifiers)
        .map_err(|e| CliError::Local(anyhow::anyhow!("--modifiers: {e}")))?;
    let info = ensure_daemon().context("ensure daemon is running")?;

    let events = args.repeat.max(1);
    let deltas = burst_deltas(args.delta_x, args.delta_y, events, args.ease);
    let modifiers = if modifiers.is_empty() {
        None
    } else {
        Some(modifiers)
    };

    let mut last: Option<WheelResult> = None;
    let mut dispatched: u32 = 0;
    for (index, (delta_x, delta_y)) in deltas.iter().enumerate() {
        if index > 0 && args.interval_ms > 0 {
            std::thread::sleep(Duration::from_millis(args.interval_ms));
        }
        let params = WheelParams {
            session_id: args.session.clone(),
            ref_: ref_.clone(),
            selector: selector.clone(),
            tab_id: args.tab_id,
            delta_x: *delta_x,
            delta_y: *delta_y,
            modifiers: modifiers.clone(),
            timeout_ms: Some(args.timeout),
        };
        match crate::cli::business_rpc::call::<WheelParams, WheelResult>(
            info.sock_path.clone(),
            "wheel-1",
            Method::ToolWheel,
            Some(params),
            ipc_timeout(args.timeout),
        ) {
            Ok(reply) => {
                dispatched += 1;
                last = Some(reply);
            }
            Err(error) => {
                if dispatched > 0 {
                    eprintln!("wheel burst stopped after {dispatched} of {events} events");
                }
                return Err(error);
            }
        }
    }

    let Some(reply) = last else {
        return Err(CliError::Local(anyhow::anyhow!(
            "wheel burst dispatched no events"
        )));
    };
    if events == 1 {
        print_single(reply, format)?;
    } else {
        print_burst(
            reply,
            dispatched,
            args.interval_ms,
            args.delta_x,
            args.delta_y,
            format,
        )?;
    }
    Ok(())
}

fn print_single(reply: WheelResult, format: Format) -> Result<(), CliError> {
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

fn print_burst(
    last: WheelResult,
    events: u32,
    interval_ms: u64,
    total_x: f64,
    total_y: f64,
    format: Format,
) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let summary = serde_json::json!({
                "events": events,
                "interval_ms": interval_ms,
                "total_delta_x": total_x,
                "total_delta_y": total_y,
                "last": last,
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&summary)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            let target =
                format_used_target(last.used_ref.as_deref(), last.used_selector.as_deref());
            println!(
                "wheel burst ok events={events} interval={interval_ms}ms total=({total_x}, {total_y}) last_tab={} target={target}",
                last.tab_id
            );
            print_dialog_summaries(&last.dialogs);
        }
    }
    Ok(())
}

/// Split the requested total delta into per-event deltas.
///
/// `events == 1` returns the delta unchanged, so a single event keeps the exact
/// value the caller asked for. For larger bursts the weights are normalized, so
/// the events sum to the requested total instead of multiplying it.
fn burst_deltas(delta_x: f64, delta_y: f64, events: u32, easing: BurstEasing) -> Vec<(f64, f64)> {
    let count = events.max(1) as usize;
    if count == 1 {
        return vec![(delta_x, delta_y)];
    }
    let weights: Vec<f64> = match easing {
        BurstEasing::Linear => vec![1.0; count],
        BurstEasing::EaseOut => (0..count)
            .map(|index| EASE_OUT_DECAY.powi(index as i32))
            .collect(),
    };
    let total: f64 = weights.iter().sum();
    weights
        .iter()
        .map(|weight| (delta_x * weight / total, delta_y * weight / total))
        .collect()
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

    #[test]
    fn single_event_keeps_the_exact_requested_delta() {
        assert_eq!(
            burst_deltas(0.0, 600.0, 1, BurstEasing::Linear),
            vec![(0.0, 600.0)]
        );
        assert_eq!(
            burst_deltas(12.5, -3.0, 1, BurstEasing::EaseOut),
            vec![(12.5, -3.0)]
        );
    }

    #[test]
    fn burst_sums_to_the_requested_total() {
        for easing in [BurstEasing::Linear, BurstEasing::EaseOut] {
            for events in [2u32, 7, 15, 40] {
                let deltas = burst_deltas(0.0, 900.0, events, easing);
                assert_eq!(deltas.len(), events as usize);
                let sum: f64 = deltas.iter().map(|(_, dy)| dy).sum();
                assert!(
                    (sum - 900.0).abs() < 1e-9,
                    "{easing:?} with {events} events summed to {sum}"
                );
            }
        }
    }

    #[test]
    fn linear_burst_splits_evenly_and_ease_out_decays() {
        let linear = burst_deltas(0.0, 120.0, 4, BurstEasing::Linear);
        for (_, dy) in &linear {
            assert!((dy - 30.0).abs() < 1e-9);
        }

        let eased = burst_deltas(0.0, 120.0, 6, BurstEasing::EaseOut);
        assert!(eased[0].1 > eased[1].1);
        for pair in eased.windows(2) {
            assert!(pair[0].1 >= pair[1].1, "ease-out must not speed up");
        }
        assert!(
            eased[0].1 > 120.0 / 6.0,
            "first event carries more than an even share"
        );
    }

    #[test]
    fn burst_scales_both_axes_together() {
        let deltas = burst_deltas(45.0, -90.0, 5, BurstEasing::EaseOut);
        let sum_x: f64 = deltas.iter().map(|(dx, _)| dx).sum();
        let sum_y: f64 = deltas.iter().map(|(_, dy)| dy).sum();
        assert!((sum_x - 45.0).abs() < 1e-9);
        assert!((sum_y + 90.0).abs() < 1e-9);
        for (dx, dy) in &deltas {
            assert!(
                (dy / -90.0 - dx / 45.0).abs() < 1e-9,
                "axes keep one profile"
            );
        }
    }
}
