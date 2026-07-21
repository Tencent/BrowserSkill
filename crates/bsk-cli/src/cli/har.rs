//! `bsk har …` — start, inspect, and export HAR 1.2 recordings.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{
    HarStartParams, HarStartResult, HarStatusParams, HarStatusResult, HarStopParams, HarStopResult,
};
use clap::{Args, Subcommand};

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

const DEFAULT_MAX_BODY_BYTES: u64 = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BODY_BYTES: u64 = 20 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES: u32 = 5000;
const DEFAULT_SETTLE_TIMEOUT_MS: u64 = 2000;
const MAX_BODY_BYTES: u64 = 10 * 1024 * 1024;
const MAX_TOTAL_BODY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ENTRIES: u32 = 10_000;
const MAX_SETTLE_TIMEOUT_MS: u64 = 10_000;

#[derive(Debug, Clone, Args)]
pub struct HarCmd {
    #[command(subcommand)]
    pub sub: HarSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum HarSub {
    /// Start recording network activity for a tab.
    Start(HarStartArgs),
    /// Show the active recording and its current size.
    Status(HarStatusArgs),
    /// Stop recording and write a HAR 1.2 file.
    Stop(HarStopArgs),
}

#[derive(Debug, Clone, Args)]
pub struct HarStartArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Do not retain request or response bodies.
    #[arg(long = "no-content", action = clap::ArgAction::SetTrue)]
    pub no_content: bool,

    /// Do not redact credentials in headers or common sensitive query parameters.
    #[arg(long = "include-sensitive", action = clap::ArgAction::SetTrue)]
    pub include_sensitive: bool,

    /// Maximum decoded bytes retained for one response body.
    #[arg(long, default_value_t = DEFAULT_MAX_BODY_BYTES, value_parser = clap::value_parser!(u64).range(1..=MAX_BODY_BYTES))]
    pub max_body_bytes: u64,

    /// Maximum decoded response-body bytes retained by the whole recording.
    #[arg(long, default_value_t = DEFAULT_MAX_TOTAL_BODY_BYTES, value_parser = clap::value_parser!(u64).range(1..=MAX_TOTAL_BODY_BYTES))]
    pub max_total_body_bytes: u64,

    /// Maximum HAR entries retained by the recording.
    #[arg(long, default_value_t = DEFAULT_MAX_ENTRIES, value_parser = clap::value_parser!(u32).range(1..=MAX_ENTRIES as i64))]
    pub max_entries: u32,
}

#[derive(Debug, Clone, Args)]
pub struct HarStatusArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,
}

#[derive(Debug, Clone, Args)]
pub struct HarStopArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// Output path. Defaults to `$TMPDIR/bsk-har-<unix-ms>.har`.
    #[arg(long)]
    pub out: Option<PathBuf>,

    /// Milliseconds to wait for in-flight requests before finalizing the archive.
    #[arg(long, default_value_t = DEFAULT_SETTLE_TIMEOUT_MS, value_parser = clap::value_parser!(u64).range(0..=MAX_SETTLE_TIMEOUT_MS))]
    pub settle_timeout_ms: u64,
}

pub fn dispatch(cmd: HarCmd, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    match cmd.sub {
        HarSub::Start(args) => run_start(info.sock_path, args, format),
        HarSub::Status(args) => run_status(info.sock_path, args, format),
        HarSub::Stop(args) => run_stop(info.sock_path, args, format),
    }
}

fn run_start(sock: PathBuf, args: HarStartArgs, format: Format) -> Result<(), CliError> {
    let params = HarStartParams {
        session_id: args.session,
        tab_id: args.tab_id,
        capture_content: Some(!args.no_content),
        sanitize: Some(!args.include_sensitive),
        max_body_bytes: Some(args.max_body_bytes),
        max_total_body_bytes: Some(args.max_total_body_bytes),
        max_entries: Some(args.max_entries),
    };
    let reply: HarStartResult = call("har-start", Method::ToolHarStart, sock, params)?;
    match format {
        Format::Json => print_json(&reply),
        Format::Human => {
            println!(
                "HAR recording started (tab {}, content={}, sanitized={})",
                reply.tab_id, reply.capture_content, reply.sanitize
            );
            Ok(())
        }
    }
}

fn run_status(sock: PathBuf, args: HarStatusArgs, format: Format) -> Result<(), CliError> {
    let reply: HarStatusResult = call(
        "har-status",
        Method::ToolHarStatus,
        sock,
        HarStatusParams {
            session_id: args.session,
        },
    )?;
    match format {
        Format::Json => print_json(&reply),
        Format::Human if !reply.active => {
            println!("(no active HAR recording)");
            Ok(())
        }
        Format::Human => {
            println!(
                "HAR recording active: tab={} entries={} in_flight={} body_bytes={} truncated={}",
                reply.tab_id.unwrap_or_default(),
                reply.entry_count,
                reply.in_flight,
                reply.body_bytes,
                reply.truncated
            );
            Ok(())
        }
    }
}

fn run_stop(sock: PathBuf, args: HarStopArgs, format: Format) -> Result<(), CliError> {
    let HarStopArgs {
        session,
        out,
        settle_timeout_ms,
    } = args;
    let out = out.unwrap_or_else(default_out_path);
    if let Some(parent) = out.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create HAR output directory {}", parent.display()))
            .map_err(CliError::Local)?;
    }
    let reply: HarStopResult = call(
        "har-stop",
        Method::ToolHarStop,
        sock,
        HarStopParams {
            session_id: session,
            settle_timeout_ms: Some(settle_timeout_ms),
        },
    )?;
    let mut bytes = serde_json::to_vec_pretty(&reply.har)
        .context("serialize HAR archive")
        .map_err(CliError::Local)?;
    bytes.push(b'\n');
    std::fs::write(&out, &bytes)
        .with_context(|| format!("write HAR to {}", out.display()))
        .map_err(CliError::Local)?;
    match format {
        Format::Json => print_json(&serde_json::json!({
            "path": out.to_string_lossy(),
            "tab_id": reply.tab_id,
            "entry_count": reply.entry_count,
            "body_bytes": reply.body_bytes,
            "truncated": reply.truncated,
            "byte_size": bytes.len(),
        })),
        Format::Human => {
            println!("{}", out.display());
            if reply.truncated {
                eprintln!(
                    "warning: HAR capture is incomplete; inspect log.comment and entry metadata"
                );
            }
            Ok(())
        }
    }
}

fn call<P, R>(prefix: &str, method: Method, sock: PathBuf, params: P) -> Result<R, CliError>
where
    P: serde::Serialize + Send + 'static,
    R: serde::de::DeserializeOwned + Send + 'static,
{
    crate::cli::business_rpc::call(sock, prefix, method, Some(params), TOOL_IPC_TIMEOUT)
}

fn print_json(value: &impl serde::Serialize) -> Result<(), CliError> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
    );
    Ok(())
}

fn default_out_path() -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis();
    std::env::temp_dir().join(format!("bsk-har-{millis}.har"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_output_has_har_extension() {
        assert_eq!(
            default_out_path().extension().and_then(|v| v.to_str()),
            Some("har")
        );
    }
}
