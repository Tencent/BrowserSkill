//! `bsk emulate` — emulate a mobile device environment on a tab via the
//! CDP Emulation domain (viewport metrics, user agent, touch), for
//! mobile page debugging.
//!
//! Device presets are resolved here, CLI-side: the extension only
//! executes the concrete override parameters it receives, so presets are
//! not duplicated in TypeScript.

use std::path::PathBuf;

use anyhow::Context;
use bsk_protocol::tools::{EmulateOverrides, EmulateParams, EmulateResult};
use bsk_protocol::{ErrorCode, Method, RpcError};
use clap::Args;

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

/// One built-in device preset: viewport metrics + UA + touch applied in
/// a single `--device` invocation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DevicePreset {
    pub name: &'static str,
    pub width: u32,
    pub height: u32,
    pub device_scale_factor: f64,
    pub mobile: bool,
    pub user_agent: &'static str,
    pub max_touch_points: u32,
}

const IPHONE_UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_UA: &str = "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/// Built-in device presets for `--device`. Keep names lowercase-kebab;
/// they are the public CLI identifiers.
pub const DEVICE_PRESETS: &[DevicePreset] = &[
    DevicePreset {
        name: "iphone-14",
        width: 390,
        height: 844,
        device_scale_factor: 3.0,
        mobile: true,
        user_agent: IPHONE_UA,
        max_touch_points: 5,
    },
    DevicePreset {
        name: "iphone-14-pro-max",
        width: 430,
        height: 932,
        device_scale_factor: 3.0,
        mobile: true,
        user_agent: IPHONE_UA,
        max_touch_points: 5,
    },
    DevicePreset {
        name: "iphone-se",
        width: 375,
        height: 667,
        device_scale_factor: 2.0,
        mobile: true,
        user_agent: IPHONE_UA,
        max_touch_points: 5,
    },
    DevicePreset {
        name: "pixel-7",
        width: 412,
        height: 915,
        device_scale_factor: 2.625,
        mobile: true,
        user_agent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36",
        max_touch_points: 5,
    },
    DevicePreset {
        name: "galaxy-s23",
        width: 360,
        height: 780,
        device_scale_factor: 3.0,
        mobile: true,
        user_agent: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36",
        max_touch_points: 5,
    },
    DevicePreset {
        name: "ipad-mini",
        width: 744,
        height: 1133,
        device_scale_factor: 2.0,
        mobile: true,
        user_agent: IPAD_UA,
        max_touch_points: 5,
    },
    DevicePreset {
        name: "galaxy-tab-s8",
        width: 800,
        height: 1280,
        device_scale_factor: 2.0,
        mobile: true,
        user_agent: "Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Safari/537.36",
        max_touch_points: 5,
    },
];

/// Comma-separated preset names for error messages.
pub fn preset_names() -> String {
    DEVICE_PRESETS
        .iter()
        .map(|p| p.name)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Look up a preset by its CLI name.
pub fn find_preset(name: &str) -> Option<&'static DevicePreset> {
    DEVICE_PRESETS.iter().find(|p| p.name == name)
}

#[derive(Debug, Clone, Args)]
pub struct EmulateArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Built-in device preset (iphone-14, iphone-14-pro-max, iphone-se,
    /// pixel-7, galaxy-s23, ipad-mini, galaxy-tab-s8). Manual flags
    /// override individual preset fields.
    #[arg(long)]
    pub device: Option<String>,

    /// Viewport width in CSS pixels (requires --height).
    #[arg(long, value_parser = viewport_dimension)]
    pub width: Option<u32>,

    /// Viewport height in CSS pixels (requires --width).
    #[arg(long, value_parser = viewport_dimension)]
    pub height: Option<u32>,

    /// Device pixel ratio (requires --width/--height without --device).
    #[arg(long, value_parser = device_pixel_ratio)]
    pub dpr: Option<f64>,

    /// Emulate a mobile viewport (requires --width/--height without
    /// --device).
    #[arg(long)]
    pub mobile: bool,

    /// User-Agent override string.
    #[arg(long)]
    pub ua: Option<String>,

    /// Accept-Language header override (requires --ua or --device).
    #[arg(long = "accept-language")]
    pub accept_language: Option<String>,

    /// Enable touch emulation (combines with --device or manual flags).
    #[arg(long)]
    pub touch: bool,

    /// Touch points reported while touch emulation is enabled (implies
    /// --touch).
    #[arg(long = "max-touch-points", value_parser = touch_points)]
    pub max_touch_points: Option<u32>,

    /// Clear all emulation overrides and restore the tab's real
    /// environment. Mutually exclusive with every other option.
    #[arg(long)]
    pub off: bool,
}

/// Parse a `--width` / `--height` viewport dimension (CSS pixels).
fn viewport_dimension(s: &str) -> Result<u32, String> {
    let value: u32 = s
        .parse()
        .map_err(|_| format!("invalid viewport dimension {s:?}: expected a positive integer"))?;
    if (1..=7680).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "viewport dimension {value} out of range (1..=7680)"
        ))
    }
}

/// Parse a `--dpr` device pixel ratio.
fn device_pixel_ratio(s: &str) -> Result<f64, String> {
    let value: f64 = s
        .parse()
        .map_err(|_| format!("invalid device pixel ratio {s:?}: expected a number"))?;
    if value.is_finite() && value > 0.0 {
        Ok(value)
    } else {
        Err(format!(
            "device pixel ratio {value} out of range (must be positive and finite)"
        ))
    }
}

/// Parse a `--max-touch-points` value.
fn touch_points(s: &str) -> Result<u32, String> {
    let value: u32 = s
        .parse()
        .map_err(|_| format!("invalid max touch points {s:?}: expected a positive integer"))?;
    if value >= 1 {
        Ok(value)
    } else {
        Err("max touch points must be at least 1".to_string())
    }
}

fn invalid_params(message: &str) -> CliError {
    CliError::from_rpc(RpcError {
        code: ErrorCode::InvalidParams,
        message: message.to_string(),
        data: None,
    })
}

/// Validate the argument combination and build the wire params. Pure so
/// it can be unit-tested without a daemon.
pub fn build_params(args: &EmulateArgs) -> Result<EmulateParams, CliError> {
    let has_manual = args.width.is_some()
        || args.height.is_some()
        || args.dpr.is_some()
        || args.mobile
        || args.ua.is_some()
        || args.accept_language.is_some()
        || args.touch
        || args.max_touch_points.is_some();

    if args.off {
        if args.device.is_some() || has_manual {
            return Err(invalid_params(
                "--off cannot be combined with --device or manual emulation options",
            ));
        }
        return Ok(EmulateParams {
            session_id: args.session.clone(),
            tab_id: args.tab_id,
            off: Some(true),
            overrides: None,
        });
    }

    if args.device.is_none() && !has_manual {
        return Err(invalid_params(&format!(
            "nothing to do: pass --device <preset> ({}), manual options (--width/--height/--dpr/--mobile/--ua/--touch), or --off",
            preset_names()
        )));
    }

    match (args.width, args.height) {
        (Some(_), None) | (None, Some(_)) => {
            return Err(invalid_params(
                "--width and --height must be provided together",
            ));
        }
        _ => {}
    }

    if args.device.is_none() && args.width.is_none() && (args.dpr.is_some() || args.mobile) {
        return Err(invalid_params(
            "--dpr and --mobile require --width/--height (viewport metrics need dimensions)",
        ));
    }

    let mut overrides = match args.device.as_deref() {
        Some(name) => {
            let preset = find_preset(name).ok_or_else(|| {
                invalid_params(&format!(
                    "unknown device preset {name:?} (available: {})",
                    preset_names()
                ))
            })?;
            EmulateOverrides {
                width: Some(preset.width),
                height: Some(preset.height),
                device_scale_factor: Some(preset.device_scale_factor),
                mobile: Some(preset.mobile),
                user_agent: Some(preset.user_agent.to_string()),
                accept_language: None,
                user_agent_metadata: None,
                touch: Some(true),
                max_touch_points: Some(preset.max_touch_points),
            }
        }
        None => EmulateOverrides::default(),
    };

    if let (Some(w), Some(h)) = (args.width, args.height) {
        overrides.width = Some(w);
        overrides.height = Some(h);
    }
    if let Some(dpr) = args.dpr {
        overrides.device_scale_factor = Some(dpr);
    }
    if args.mobile {
        overrides.mobile = Some(true);
    }
    if let Some(ua) = &args.ua {
        overrides.user_agent = Some(ua.clone());
    }
    if let Some(accept_language) = &args.accept_language {
        overrides.accept_language = Some(accept_language.clone());
    }
    if args.touch || args.max_touch_points.is_some() {
        overrides.touch = Some(true);
    }
    if let Some(max_touch_points) = args.max_touch_points {
        overrides.max_touch_points = Some(max_touch_points);
    }

    if overrides.accept_language.is_some() && overrides.user_agent.is_none() {
        return Err(invalid_params("--accept-language requires --ua"));
    }

    Ok(EmulateParams {
        session_id: args.session.clone(),
        tab_id: args.tab_id,
        off: None,
        overrides: Some(overrides),
    })
}

pub fn dispatch(args: EmulateArgs, format: Format) -> Result<(), CliError> {
    let device = args.device.clone();
    let params = build_params(&args)?;
    let info = ensure_daemon().context("ensure daemon is running")?;
    let reply = call(info.sock_path, params)?;
    render(&reply, device.as_deref(), format)
}

fn call(sock: PathBuf, params: EmulateParams) -> Result<EmulateResult, CliError> {
    crate::cli::business_rpc::call::<EmulateParams, EmulateResult>(
        sock,
        "emulate",
        Method::ToolEmulate,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}

fn render(reply: &EmulateResult, device: Option<&str>, format: Format) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            if reply.cleared {
                println!("tab={} emulation cleared", reply.tab_id);
            } else {
                print!("tab={} emulation applied", reply.tab_id);
                if let Some(device) = device {
                    print!(" device={device}");
                }
                if let Some(applied) = &reply.applied {
                    if let (Some(w), Some(h)) = (applied.width, applied.height) {
                        print!(" viewport={w}x{h}");
                        if let Some(dpr) = applied.device_scale_factor {
                            print!("@{dpr}x");
                        }
                        if applied.mobile == Some(true) {
                            print!(" mobile");
                        }
                    }
                    if applied.user_agent.is_some() {
                        print!(" ua");
                    }
                    if applied.touch == Some(true) {
                        print!(" touch");
                    }
                }
                println!();
            }
            if let Some(note) = &reply.note {
                println!("note: {note}");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_args() -> EmulateArgs {
        EmulateArgs {
            session: "s1".into(),
            tab_id: None,
            device: None,
            width: None,
            height: None,
            dpr: None,
            mobile: false,
            ua: None,
            accept_language: None,
            touch: false,
            max_touch_points: None,
            off: false,
        }
    }

    fn build(args: &EmulateArgs) -> EmulateParams {
        build_params(args).expect("build_params should succeed")
    }

    #[test]
    fn preset_alone_applies_full_environment() {
        let args = EmulateArgs {
            device: Some("iphone-14".into()),
            ..base_args()
        };
        let params = build(&args);
        let o = params.overrides.unwrap();
        assert_eq!(o.width, Some(390));
        assert_eq!(o.height, Some(844));
        assert_eq!(o.device_scale_factor, Some(3.0));
        assert_eq!(o.mobile, Some(true));
        assert!(o.user_agent.unwrap().contains("iPhone"));
        assert_eq!(o.touch, Some(true));
        assert_eq!(o.max_touch_points, Some(5));
        assert!(params.off.is_none());
    }

    #[test]
    fn every_preset_is_applicable() {
        assert_eq!(DEVICE_PRESETS.len(), 7);
        for preset in DEVICE_PRESETS {
            let args = EmulateArgs {
                device: Some(preset.name.into()),
                ..base_args()
            };
            let o = build(&args).overrides.unwrap();
            assert_eq!(o.width, Some(preset.width));
            assert_eq!(o.height, Some(preset.height));
            assert!(o.user_agent.is_some());
        }
    }

    #[test]
    fn manual_flags_override_preset_fields() {
        let args = EmulateArgs {
            device: Some("pixel-7".into()),
            width: Some(500),
            height: Some(900),
            dpr: Some(2.0),
            ua: Some("custom-ua".into()),
            ..base_args()
        };
        let o = build(&args).overrides.unwrap();
        assert_eq!(o.width, Some(500));
        assert_eq!(o.height, Some(900));
        assert_eq!(o.device_scale_factor, Some(2.0));
        assert_eq!(o.user_agent.as_deref(), Some("custom-ua"));
        // Untouched preset fields survive.
        assert_eq!(o.mobile, Some(true));
        assert_eq!(o.touch, Some(true));
    }

    #[test]
    fn manual_only_viewport_and_ua() {
        let args = EmulateArgs {
            width: Some(390),
            height: Some(844),
            dpr: Some(3.0),
            mobile: true,
            ua: Some("Mozilla/5.0 (iPhone…)".into()),
            touch: true,
            ..base_args()
        };
        let o = build(&args).overrides.unwrap();
        assert_eq!(o.width, Some(390));
        assert_eq!(o.device_scale_factor, Some(3.0));
        assert_eq!(o.mobile, Some(true));
        assert_eq!(o.touch, Some(true));
        assert_eq!(o.max_touch_points, None);
    }

    #[test]
    fn touch_alone_is_valid() {
        let args = EmulateArgs {
            touch: true,
            ..base_args()
        };
        let o = build(&args).overrides.unwrap();
        assert_eq!(o.touch, Some(true));
        assert!(o.width.is_none());
    }

    #[test]
    fn max_touch_points_implies_touch() {
        let args = EmulateArgs {
            max_touch_points: Some(5),
            ..base_args()
        };
        let o = build(&args).overrides.unwrap();
        assert_eq!(o.touch, Some(true));
        assert_eq!(o.max_touch_points, Some(5));
    }

    #[test]
    fn off_builds_clear_params() {
        let args = EmulateArgs {
            off: true,
            ..base_args()
        };
        let params = build(&args);
        assert_eq!(params.off, Some(true));
        assert!(params.overrides.is_none());
    }

    #[test]
    fn off_is_exclusive() {
        for args in [
            EmulateArgs {
                off: true,
                device: Some("iphone-14".into()),
                ..base_args()
            },
            EmulateArgs {
                off: true,
                touch: true,
                ..base_args()
            },
            EmulateArgs {
                off: true,
                width: Some(390),
                height: Some(844),
                ..base_args()
            },
        ] {
            let err = build_params(&args).unwrap_err();
            assert!(err.to_string().contains("--off"));
        }
    }

    #[test]
    fn empty_invocation_is_rejected_with_guidance() {
        let err = build_params(&base_args()).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("--device"));
        assert!(msg.contains("--off"));
        assert!(msg.contains("iphone-14"));
    }

    #[test]
    fn unknown_preset_lists_available() {
        let args = EmulateArgs {
            device: Some("nokia-3310".into()),
            ..base_args()
        };
        let err = build_params(&args).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("nokia-3310"));
        assert!(msg.contains("iphone-14"));
    }

    #[test]
    fn width_height_must_pair() {
        for args in [
            EmulateArgs {
                width: Some(390),
                ..base_args()
            },
            EmulateArgs {
                height: Some(844),
                ..base_args()
            },
        ] {
            let err = build_params(&args).unwrap_err();
            assert!(err.to_string().contains("together"));
        }
    }

    #[test]
    fn dpr_and_mobile_require_dimensions_without_preset() {
        for args in [
            EmulateArgs {
                dpr: Some(3.0),
                ..base_args()
            },
            EmulateArgs {
                mobile: true,
                ..base_args()
            },
        ] {
            let err = build_params(&args).unwrap_err();
            assert!(err.to_string().contains("--width/--height"));
        }
    }

    #[test]
    fn dpr_without_dimensions_is_fine_with_preset() {
        let args = EmulateArgs {
            device: Some("iphone-se".into()),
            dpr: Some(2.5),
            ..base_args()
        };
        let o = build(&args).overrides.unwrap();
        assert_eq!(o.device_scale_factor, Some(2.5));
        assert_eq!(o.width, Some(375));
    }

    #[test]
    fn accept_language_requires_ua() {
        let args = EmulateArgs {
            accept_language: Some("zh-CN".into()),
            ..base_args()
        };
        let err = build_params(&args).unwrap_err();
        assert!(err.to_string().contains("--ua"));
        // …but pairs fine with a preset (which carries a UA).
        let args = EmulateArgs {
            device: Some("iphone-14".into()),
            accept_language: Some("zh-CN".into()),
            ..base_args()
        };
        let o = build(&args).overrides.unwrap();
        assert_eq!(o.accept_language.as_deref(), Some("zh-CN"));
    }

    #[test]
    fn preset_names_are_unique_and_listed() {
        let names = preset_names();
        for preset in DEVICE_PRESETS {
            assert!(names.contains(preset.name));
            assert_eq!(find_preset(preset.name), Some(preset));
        }
        assert!(find_preset("IPHONE-14").is_none());
    }
}
