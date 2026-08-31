//! `bsk click` / `bsk fill` / `bsk press` (M7 interaction tools).
//!
//! The `<target>` positional accepts either a snapshot ref (`@e3`,
//! `e3`) or a CSS selector. Use `--ref` / `--selector` explicitly when
//! the value is ambiguous.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{
    ClickParams, ClickResult, FillParams, FillResult, HoverParams, HoverResult, KeyModifier,
    MouseButton, PressParams, PressResult, SelectParams, SelectResult, TypeParams, TypeResult,
};
use clap::{Args, ValueEnum};

use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::navigate::parse_timeout_ms;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum CliMouseButton {
    Left,
    Middle,
    Right,
}

impl From<CliMouseButton> for MouseButton {
    fn from(v: CliMouseButton) -> Self {
        match v {
            CliMouseButton::Left => MouseButton::Left,
            CliMouseButton::Middle => MouseButton::Middle,
            CliMouseButton::Right => MouseButton::Right,
        }
    }
}

/// Decide whether a target string looks like a snapshot ref. Refs are
/// `@e<N>` or `e<N>` (decimal); anything else is treated as a CSS
/// selector.
pub(crate) fn looks_like_ref(target: &str) -> bool {
    let stripped = target.strip_prefix('@').unwrap_or(target);
    if let Some(rest) = stripped.strip_prefix('e') {
        return !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit());
    }
    false
}

/// Parse a CLI modifier list like `"ctrl,shift"` into the protocol
/// enum. Empty / blank string → empty vec.
pub(crate) fn parse_modifiers(input: &str) -> Result<Vec<KeyModifier>, String> {
    let mut out = Vec::new();
    for raw in input.split(',') {
        let m = raw.trim();
        if m.is_empty() {
            continue;
        }
        let normalised = match m.to_lowercase().as_str() {
            "alt" | "option" | "opt" => KeyModifier::Alt,
            "ctrl" | "control" => KeyModifier::Ctrl,
            "meta" | "cmd" | "command" | "super" => KeyModifier::Meta,
            "shift" => KeyModifier::Shift,
            other => return Err(format!("unknown modifier '{other}'")),
        };
        if !out.contains(&normalised) {
            out.push(normalised);
        }
    }
    Ok(out)
}

fn split_target(
    positional: Option<String>,
    explicit_ref: Option<String>,
    explicit_selector: Option<String>,
) -> Result<(Option<String>, Option<String>), CliError> {
    match (positional, explicit_ref, explicit_selector) {
        (None, None, None) => Err(CliError::Local(anyhow::anyhow!(
            "missing target: pass <ref-or-selector>, --ref @eN, or --selector <css>"
        ))),
        (None, Some(r), None) => Ok((Some(r), None)),
        (None, None, Some(s)) => Ok((None, Some(s))),
        (Some(t), None, None) => {
            if looks_like_ref(&t) {
                Ok((Some(t), None))
            } else {
                Ok((None, Some(t)))
            }
        }
        _ => Err(CliError::Local(anyhow::anyhow!(
            "pass exactly one of: <target>, --ref, or --selector"
        ))),
    }
}

fn split_type_target(
    positional: Option<String>,
    explicit_ref: Option<String>,
    explicit_selector: Option<String>,
    focused: bool,
) -> Result<(Option<String>, Option<String>), CliError> {
    if focused {
        if positional.is_some() || explicit_ref.is_some() || explicit_selector.is_some() {
            return Err(CliError::Local(anyhow::anyhow!(
                "pass a target or --focused, not both"
            )));
        }
        return Ok((None, None));
    }
    split_target(positional, explicit_ref, explicit_selector).map_err(|_| {
        CliError::Local(anyhow::anyhow!(
            "type requires exactly one of: <target>, --ref, --selector, or --focused"
        ))
    })
}

// ---------------------------------------------------------------------------
// bsk click
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Args)]
pub struct ClickArgs {
    /// Snapshot ref (`@e3`, `e3`) or CSS selector. Optional when `--ref`/`--selector` is used.
    pub target: Option<String>,

    /// Force-treat the value as a snapshot ref (overrides positional detection).
    #[arg(long = "ref")]
    pub ref_: Option<String>,

    /// Force-treat the value as a CSS selector.
    #[arg(long = "selector")]
    pub selector: Option<String>,

    #[arg(long)]
    pub session: String,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    #[arg(long, value_enum, default_value_t = CliMouseButton::Left)]
    pub button: CliMouseButton,

    /// Number of consecutive presses (double-click = 2).
    #[arg(
        long = "click-count",
        alias = "count",
        default_value_t = 1,
        value_parser = clap::value_parser!(u32).range(1..)
    )]
    pub click_count: u32,

    /// Comma-separated modifiers (`alt,ctrl,shift,meta`).
    #[arg(long, default_value = "")]
    pub modifiers: String,

    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,

    /// Capture id returned by `bsk screenshot --ref <surface>`.
    #[arg(long)]
    pub capture: Option<String>,

    /// X coordinate in capture-image pixels. Requires `--capture` and `--image-y`.
    #[arg(long = "image-x", allow_hyphen_values = true)]
    pub image_x: Option<f64>,

    /// Y coordinate in capture-image pixels. Requires `--capture` and `--image-x`.
    #[arg(long = "image-y", allow_hyphen_values = true)]
    pub image_y: Option<f64>,
}

pub fn dispatch_click(args: ClickArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let (ref_, selector) = split_target(
        args.target.clone(),
        args.ref_.clone(),
        args.selector.clone(),
    )?;
    let modifiers = parse_modifiers(&args.modifiers)
        .map_err(|e| CliError::Local(anyhow::anyhow!("--modifiers: {e}")))?;
    let point_arg_count = usize::from(args.capture.is_some())
        + usize::from(args.image_x.is_some())
        + usize::from(args.image_y.is_some());
    if point_arg_count != 0 && point_arg_count != 3 {
        return Err(CliError::Local(anyhow::anyhow!(
            "--capture, --image-x, and --image-y must be given together"
        )));
    }
    let params = ClickParams {
        session_id: args.session.clone(),
        ref_,
        selector,
        tab_id: args.tab_id,
        button: Some(args.button.into()),
        click_count: Some(args.click_count),
        modifiers: if modifiers.is_empty() {
            None
        } else {
            Some(modifiers)
        },
        timeout_ms: Some(args.timeout),
        capture_id: args.capture.clone(),
        image_x: args.image_x,
        image_y: args.image_y,
    };
    let reply: ClickResult = call(
        info.sock_path,
        Method::ToolClick,
        params,
        "click-1",
        args.timeout,
    )?;
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            let target =
                format_used_target(reply.used_ref.as_deref(), reply.used_selector.as_deref());
            println!(
                "click ok tab={} target={target} at=({}, {})",
                reply.tab_id, reply.x, reply.y
            );
            if let Some(capture_id) = &reply.capture_id {
                println!(
                    "capture={} image=({}, {}) coordinate_space=capture-image-pixel",
                    capture_id,
                    reply.image_x.unwrap_or_default(),
                    reply.image_y.unwrap_or_default()
                );
            }
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// bsk hover
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Args)]
pub struct HoverArgs {
    /// Snapshot ref (`@e3`, `e3`) or CSS selector. Optional when `--ref`/`--selector` is used.
    pub target: Option<String>,

    /// Force-treat the value as a snapshot ref (overrides positional detection).
    #[arg(long = "ref")]
    pub ref_: Option<String>,

    /// Force-treat the value as a CSS selector.
    #[arg(long = "selector")]
    pub selector: Option<String>,

    #[arg(long)]
    pub session: String,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Comma-separated modifiers (`alt,ctrl,shift,meta`).
    #[arg(long, default_value = "")]
    pub modifiers: String,

    /// Wait after moving the mouse so hover-triggered UI can settle.
    #[arg(long = "settle", default_value = "200ms", value_parser = parse_timeout_ms)]
    pub settle: u32,

    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

pub fn dispatch_hover(args: HoverArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let (ref_, selector) = split_target(
        args.target.clone(),
        args.ref_.clone(),
        args.selector.clone(),
    )?;
    let modifiers = parse_modifiers(&args.modifiers)
        .map_err(|e| CliError::Local(anyhow::anyhow!("--modifiers: {e}")))?;
    let params = HoverParams {
        session_id: args.session.clone(),
        ref_,
        selector,
        tab_id: args.tab_id,
        modifiers: if modifiers.is_empty() {
            None
        } else {
            Some(modifiers)
        },
        settle_ms: Some(args.settle),
        timeout_ms: Some(args.timeout),
    };
    let reply: HoverResult = call(
        info.sock_path,
        Method::ToolHover,
        params,
        "hover-1",
        args.timeout,
    )?;
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            let target =
                format_used_target(reply.used_ref.as_deref(), reply.used_selector.as_deref());
            println!(
                "hover ok tab={} target={target} at=({}, {})",
                reply.tab_id, reply.x, reply.y
            );
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// bsk fill
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Args)]
pub struct FillArgs {
    /// Snapshot ref (`@e3`, `e3`) or CSS selector. Optional when `--ref`/`--selector` is used.
    #[arg(value_name = "TARGET")]
    pub target: Option<String>,

    /// Text to type into the element.
    #[arg(long)]
    pub value: String,

    #[arg(long = "ref")]
    pub ref_: Option<String>,

    #[arg(long = "selector")]
    pub selector: Option<String>,

    #[arg(long)]
    pub session: String,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Skip the default "wipe the field first" pass.
    #[arg(long)]
    pub no_clear: bool,

    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

pub fn dispatch_fill(args: FillArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let (ref_, selector) = split_target(
        args.target.clone(),
        args.ref_.clone(),
        args.selector.clone(),
    )?;
    let params = FillParams {
        session_id: args.session.clone(),
        value: args.value.clone(),
        ref_,
        selector,
        tab_id: args.tab_id,
        clear_before: if args.no_clear { Some(false) } else { None },
        timeout_ms: Some(args.timeout),
    };
    let reply: FillResult = call(
        info.sock_path,
        Method::ToolFill,
        params,
        "fill-1",
        args.timeout,
    )?;
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            let target =
                format_used_target(reply.used_ref.as_deref(), reply.used_selector.as_deref());
            println!(
                "fill ok tab={} target={target} length={}",
                reply.tab_id, reply.value_length
            );
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// bsk type
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Args)]
#[group(id = "type_destination", required = true, multiple = false)]
pub struct TypeDestinationArgs {
    /// Snapshot ref (`@e3`, `e3`) or CSS selector to focus before insertion.
    #[arg(value_name = "TARGET")]
    pub target: Option<String>,

    #[arg(long = "ref")]
    pub ref_: Option<String>,

    #[arg(long = "selector")]
    pub selector: Option<String>,

    /// Insert into the unique focused text-entry target instead of focusing a target.
    #[arg(long)]
    pub focused: bool,
}

#[derive(Debug, Clone, Args)]
pub struct TypeArgs {
    #[command(flatten)]
    pub destination: TypeDestinationArgs,

    /// Text to dispatch through the live keyboard/IME editing session.
    #[arg(long)]
    pub text: String,

    #[arg(long)]
    pub session: String,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

pub fn dispatch_type(args: TypeArgs, format: Format) -> Result<(), CliError> {
    let (ref_, selector) = split_type_target(
        args.destination.target.clone(),
        args.destination.ref_.clone(),
        args.destination.selector.clone(),
        args.destination.focused,
    )?;
    let info = ensure_daemon().context("ensure daemon is running")?;
    let params = TypeParams {
        session_id: args.session.clone(),
        text: args.text.clone(),
        ref_,
        selector,
        focused: args.destination.focused,
        tab_id: args.tab_id,
        timeout_ms: Some(args.timeout),
    };
    let reply: TypeResult = call(
        info.sock_path,
        Method::ToolType,
        params,
        "type-1",
        args.timeout,
    )?;
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            let target = if args.destination.focused {
                "focused".into()
            } else {
                format_used_target(reply.used_ref.as_deref(), reply.used_selector.as_deref())
            };
            println!(
                "type dispatched tab={} target={target} length={} verification=dispatched",
                reply.tab_id, reply.text_length
            );
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// bsk press
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Args)]
pub struct PressArgs {
    /// Key spec (`Enter`, `Ctrl+A`, `ArrowLeft`, `a`).
    pub key: String,

    #[arg(long)]
    pub session: String,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Comma-separated modifiers in addition to anything baked into `<key>`.
    #[arg(long, default_value = "")]
    pub modifiers: String,

    /// Optional snapshot ref to focus before dispatching the key.
    #[arg(long = "ref")]
    pub ref_: Option<String>,

    /// Optional CSS selector to focus before dispatching the key.
    #[arg(long = "selector")]
    pub selector: Option<String>,

    /// Hold the key down for N milliseconds between keyDown and keyUp.
    #[arg(long = "hold-ms")]
    pub hold_ms: Option<u32>,

    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

pub fn dispatch_press(args: PressArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let modifiers = parse_modifiers(&args.modifiers)
        .map_err(|e| CliError::Local(anyhow::anyhow!("--modifiers: {e}")))?;
    let params = PressParams {
        session_id: args.session.clone(),
        key: args.key.clone(),
        modifiers: if modifiers.is_empty() {
            None
        } else {
            Some(modifiers)
        },
        ref_: args.ref_.clone(),
        selector: args.selector.clone(),
        tab_id: args.tab_id,
        hold_ms: args.hold_ms,
        timeout_ms: Some(args.timeout),
    };
    let reply: PressResult = call(
        info.sock_path,
        Method::ToolPress,
        params,
        "press-1",
        args.timeout,
    )?;
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            let mods = if reply.modifiers.is_empty() {
                String::new()
            } else {
                format!(
                    " modifiers=[{}]",
                    reply
                        .modifiers
                        .iter()
                        .map(modifier_label)
                        .collect::<Vec<_>>()
                        .join(",")
                )
            };
            println!(
                "press ok tab={} key={} code={}{mods}",
                reply.tab_id, reply.key, reply.code
            );
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// bsk select
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Args)]
pub struct SelectArgs {
    /// Snapshot ref (`@e3`, `e3`) or CSS selector. Optional when `--ref`/`--selector` is used.
    #[arg(value_name = "TARGET")]
    pub target: Option<String>,

    /// Option `value` to select. Repeat for multi-select (`--value a --value b`).
    #[arg(long = "value", required = true)]
    pub values: Vec<String>,

    #[arg(long = "ref")]
    pub ref_: Option<String>,

    #[arg(long = "selector")]
    pub selector: Option<String>,

    #[arg(long)]
    pub session: String,

    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    #[arg(long, default_value = "30s", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

pub fn dispatch_select(args: SelectArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    let (ref_, selector) = split_target(
        args.target.clone(),
        args.ref_.clone(),
        args.selector.clone(),
    )?;
    let params = SelectParams {
        session_id: args.session.clone(),
        values: args.values.clone(),
        ref_,
        selector,
        tab_id: args.tab_id,
        timeout_ms: Some(args.timeout),
    };
    let reply: SelectResult = call(
        info.sock_path,
        Method::ToolSelect,
        params,
        "select-1",
        args.timeout,
    )?;
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            let target =
                format_used_target(reply.used_ref.as_deref(), reply.used_selector.as_deref());
            let values = reply.selected_values.join(",");
            let labels = reply.selected_labels.join(",");
            println!(
                "select ok tab={} target={target} multiple={} values=[{values}] labels=[{labels}]",
                reply.tab_id, reply.multiple
            );
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn format_used_target(used_ref: Option<&str>, used_selector: Option<&str>) -> String {
    used_ref
        .map(|r| format!("@{r}"))
        .or_else(|| used_selector.map(str::to_string))
        .unwrap_or_else(|| "?".into())
}

fn modifier_label(m: &KeyModifier) -> &'static str {
    match m {
        KeyModifier::Alt => "alt",
        KeyModifier::Ctrl => "ctrl",
        KeyModifier::Meta => "meta",
        KeyModifier::Shift => "shift",
    }
}

fn call<P, R>(
    sock: PathBuf,
    method: Method,
    params: P,
    id: &'static str,
    timeout_ms: u32,
) -> Result<R, CliError>
where
    P: serde::Serialize + Send + 'static,
    R: serde::de::DeserializeOwned + Send + 'static,
{
    crate::cli::business_rpc::call::<P, R>(
        sock,
        id,
        method,
        Some(params),
        interaction_ipc_timeout(timeout_ms),
    )
}

fn interaction_ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms))
        .checked_add(Duration::from_secs(15))
        .unwrap_or(Duration::from_secs(u64::from(timeout_ms / 1_000) + 15))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_like_ref_handles_both_forms() {
        assert!(looks_like_ref("@e3"));
        assert!(looks_like_ref("e42"));
        assert!(!looks_like_ref("button"));
        assert!(!looks_like_ref(".btn"));
        assert!(!looks_like_ref("@"));
        assert!(!looks_like_ref("e"));
    }

    #[test]
    fn parse_modifiers_round_trips() {
        assert!(parse_modifiers("").unwrap().is_empty());
        let v = parse_modifiers("ctrl,Shift").unwrap();
        assert_eq!(v, vec![KeyModifier::Ctrl, KeyModifier::Shift]);
        let v = parse_modifiers("cmd").unwrap();
        assert_eq!(v, vec![KeyModifier::Meta]);
        let v = parse_modifiers("ctrl,ctrl").unwrap();
        assert_eq!(v, vec![KeyModifier::Ctrl]);
        assert!(parse_modifiers("garbage").is_err());
    }

    #[test]
    fn split_target_picks_ref_path_for_ref_strings() {
        let (r, s) = split_target(Some("@e3".into()), None, None).unwrap();
        assert_eq!(r.as_deref(), Some("@e3"));
        assert!(s.is_none());
    }

    #[test]
    fn split_target_picks_selector_for_anything_else() {
        let (r, s) = split_target(Some(".btn".into()), None, None).unwrap();
        assert!(r.is_none());
        assert_eq!(s.as_deref(), Some(".btn"));
    }

    #[test]
    fn interaction_ipc_timeout_tracks_user_timeout_with_grace() {
        assert_eq!(
            interaction_ipc_timeout(60_000),
            Duration::from_secs(60) + Duration::from_secs(15)
        );
    }

    #[test]
    fn fill_clap_accepts_target_positional_with_value_flag() {
        use clap::Parser;

        #[derive(Parser)]
        #[command(name = "fill")]
        struct Wrapper {
            #[command(flatten)]
            args: FillArgs,
        }

        let parsed =
            Wrapper::try_parse_from(["fill", "@e138", "--value", "deepseek", "--session", "ohli"])
                .expect("fill args should parse");
        assert_eq!(parsed.args.target.as_deref(), Some("@e138"));
        assert_eq!(parsed.args.value, "deepseek");
        assert_eq!(parsed.args.session, "ohli");
    }

    #[test]
    fn type_clap_accepts_explicit_target_and_text_flag() {
        use clap::Parser;

        #[derive(Parser)]
        #[command(name = "type")]
        struct Wrapper {
            #[command(flatten)]
            args: TypeArgs,
        }

        let parsed =
            Wrapper::try_parse_from(["type", "@e138", "--text", "测试", "--session", "ohli"])
                .expect("type args should parse");
        assert_eq!(parsed.args.destination.target.as_deref(), Some("@e138"));
        assert_eq!(parsed.args.text, "测试");
        assert_eq!(parsed.args.session, "ohli");
    }

    #[test]
    fn type_targeting_requires_exactly_one_explicit_mode() {
        use clap::Parser;

        #[derive(Parser)]
        #[command(name = "type")]
        struct Wrapper {
            #[command(flatten)]
            args: TypeArgs,
        }

        let parsed =
            Wrapper::try_parse_from(["type", "--focused", "--text", "测试", "--session", "ohli"])
                .expect("focused type args should parse");
        assert!(parsed.args.destination.focused);
        assert!(parsed.args.destination.target.is_none());

        let focused = split_type_target(None, None, None, true).unwrap();
        assert_eq!(focused, (None, None));

        let missing = split_type_target(None, None, None, false).unwrap_err();
        assert!(missing.to_string().contains("--focused"));

        let mixed = split_type_target(Some("@e1".into()), None, None, true).unwrap_err();
        assert!(mixed.to_string().contains("not both"));
    }

    #[test]
    fn select_clap_accepts_target_positional_with_repeated_value_flags() {
        use clap::Parser;

        #[derive(Parser)]
        #[command(name = "select")]
        struct Wrapper {
            #[command(flatten)]
            args: SelectArgs,
        }

        let parsed = Wrapper::try_parse_from([
            "select",
            "@e138",
            "--value",
            "us",
            "--value",
            "ca",
            "--session",
            "ohli",
        ])
        .expect("select args should parse");
        assert_eq!(parsed.args.target.as_deref(), Some("@e138"));
        assert_eq!(parsed.args.values, vec!["us", "ca"]);
        assert_eq!(parsed.args.session, "ohli");
    }
}
