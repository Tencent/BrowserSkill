//! `bsk screenshot` — capture a PNG of the Agent Window's active tab
//! or a snapshot ref subtree (M6.2). CLI is responsible for decoding
//! the base64 returned by the extension and writing the binary to
//! disk; the wire payload stays human-readable.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow};
use bsk_protocol::Method;
use bsk_protocol::tools::{ScreenshotParams, ScreenshotResult};
use clap::Args;

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct ScreenshotArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Optional `@eN` ref from the last `bsk snapshot`. Crops the
    /// capture to the matching element.
    #[arg(long = "ref")]
    pub ref_: Option<String>,

    /// Output PNG path. Defaults to `$TMPDIR/bsk-screenshot-<unix-ms>.png`.
    #[arg(long)]
    pub out: Option<PathBuf>,
}

pub fn dispatch(args: ScreenshotArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    run(info.sock_path, args, format)
}

fn run(sock: PathBuf, args: ScreenshotArgs, format: Format) -> Result<(), CliError> {
    let params = ScreenshotParams {
        session_id: args.session.clone(),
        tab_id: args.tab_id,
        ref_: args.ref_.clone(),
    };
    let reply: ScreenshotResult = call(sock, params)?;
    let out_path = match &args.out {
        Some(p) => p.clone(),
        None => default_out_path(),
    };
    let bytes = decode_base64(&reply.image_base64)
        .map_err(|e| CliError::Local(anyhow!("decode screenshot base64: {e}")))?;
    std::fs::write(&out_path, &bytes)
        .with_context(|| format!("write screenshot to {}", out_path.display()))
        .map_err(CliError::Local)?;
    match format {
        Format::Json => {
            let json = serde_json::json!({
                "tab_id": reply.tab_id,
                "width": reply.width,
                "height": reply.height,
                "format": reply.format,
                "path": out_path.to_string_lossy(),
                "byte_size": bytes.len(),
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&json)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            println!("{}", out_path.display());
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn default_out_path() -> PathBuf {
    let mut dir = std::env::temp_dir();
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    dir.push(format!("bsk-screenshot-{ts}.png"));
    dir
}

fn call(sock: PathBuf, params: ScreenshotParams) -> Result<ScreenshotResult, CliError> {
    crate::cli::business_rpc::call::<ScreenshotParams, ScreenshotResult>(
        sock,
        "screenshot",
        Method::ToolScreenshot,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}

/// Standalone base64 decoder so we don't pull `base64` crate just for
/// one call site. Accepts standard alphabet with optional padding.
pub(crate) fn decode_base64(input: &str) -> Result<Vec<u8>, &'static str> {
    let mut bits: u32 = 0;
    let mut nbits: u32 = 0;
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    for b in input.bytes() {
        let v: u32 = match b {
            b'A'..=b'Z' => (b - b'A') as u32,
            b'a'..=b'z' => (b - b'a' + 26) as u32,
            b'0'..=b'9' => (b - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' | b' ' | b'\t' => continue,
            _ => return Err("invalid base64 character"),
        };
        bits = (bits << 6) | v;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            out.push(((bits >> nbits) & 0xff) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_base64_round_trip() {
        // "browser-skill" base64-encoded
        assert_eq!(
            decode_base64("YnJvd3Nlci1za2lsbA").unwrap(),
            b"browser-skill"
        );
    }

    #[test]
    fn decode_base64_ignores_padding_and_whitespace() {
        assert_eq!(
            decode_base64("YnJvd3Nlci1za2lsbA==").unwrap(),
            b"browser-skill"
        );
        assert_eq!(
            decode_base64("YnJvd3Nlci1za2lsbA==\n").unwrap(),
            b"browser-skill"
        );
    }

    #[test]
    fn decode_base64_rejects_garbage() {
        assert!(decode_base64("***").is_err());
    }

    #[test]
    fn default_out_path_lives_in_tmpdir() {
        let p = default_out_path();
        assert!(p.starts_with(std::env::temp_dir()));
        assert!(
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.starts_with("bsk-screenshot-"))
                .unwrap_or(false)
        );
    }
}
