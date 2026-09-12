//! `bsk screenshot` — viewport, DOM element / Canvas region ref PNGs,
//! and disk-streamed full-page captures.
//! The CLI alone owns the final output path; full-page image bytes arrive in
//! bounded chunks and become visible only after a complete atomic write.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, anyhow};
use bsk_protocol::Method;
use bsk_protocol::tools::{
    ScreenshotFullPageParams, ScreenshotFullPageResult, ScreenshotParams, ScreenshotReadParams,
    ScreenshotReadResult, ScreenshotReleaseParams, ScreenshotReleaseResult, ScreenshotResult,
};
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

    /// Optional `@eN` ref from the latest `bsk observe` or `bsk snapshot`.
    /// Crops the capture to the referenced DOM element or Canvas region.
    #[arg(long = "ref")]
    pub ref_: Option<String>,

    /// Scroll an ordinary web page from top to bottom and stitch a full-page PNG.
    #[arg(long, conflicts_with = "ref_")]
    pub full_page: bool,

    /// Full-page capture/encoding timeout (e.g. 30s, 5m). Defaults to 2m.
    #[arg(long, requires = "full_page", value_parser = crate::cli::navigate::parse_timeout_ms)]
    pub timeout: Option<u32>,

    /// Output PNG path. Defaults to `$TMPDIR/bsk-screenshot-<unix-ms>.png`.
    #[arg(long)]
    pub out: Option<PathBuf>,
}

pub fn dispatch(args: ScreenshotArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    run(info.sock_path, args, format)
}

fn run(sock: PathBuf, args: ScreenshotArgs, format: Format) -> Result<(), CliError> {
    if args.full_page {
        return run_full_page(sock, args, format);
    }
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
            let mut json = serde_json::json!({
                "tab_id": reply.tab_id,
                "width": reply.width,
                "height": reply.height,
                "format": reply.format,
                "path": out_path.to_string_lossy(),
                "byte_size": bytes.len(),
            });
            if let Some(id) = &reply.capture_id {
                json["capture_id"] = serde_json::json!(id);
            }
            if let Some(reason) = &reply.capture_unavailable {
                json["capture_unavailable"] = serde_json::json!(reason);
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&json)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            println!("{}", out_path.display());
            if let Some(id) = &reply.capture_id {
                println!(
                    "capture: {id} ({}x{} original PNG pixels; single use)",
                    reply.width, reply.height
                );
            }
            if let Some(reason) = &reply.capture_unavailable {
                println!("capture unavailable: {reason}");
            }
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn run_full_page(sock: PathBuf, args: ScreenshotArgs, format: Format) -> Result<(), CliError> {
    let timeout = args.timeout.unwrap_or(120_000);
    let reply: ScreenshotFullPageResult = crate::cli::business_rpc::call(
        sock.clone(),
        "screenshot-full-page",
        Method::ToolScreenshotFullPage,
        Some(ScreenshotFullPageParams {
            session_id: args.session.clone(),
            tab_id: args.tab_id,
            timeout_ms: Some(timeout),
        }),
        Duration::from_millis(u64::from(timeout) + 5_000),
    )?;
    let out = args.out.unwrap_or_else(default_out_path);
    let result = write_full_page(&sock, &args.session, &reply, &out);
    // Cleanup must run even after Ctrl-C or a local write failure. Unlike the
    // business call, this small release RPC is not itself cancelled by stdin.
    let _ = release_full_page(&sock, &args.session, &reply.capture_id);
    result?;
    match format {
        Format::Json => {
            let json = serde_json::json!({
                "tab_id": reply.tab_id,
                "width": reply.width,
                "height": reply.height,
                "format": reply.format,
                "path": out.to_string_lossy(),
                "byte_size": reply.byte_size,
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&json).map_err(|e| CliError::Local(e.into()))?
            );
        }
        Format::Human => {
            println!("{}", out.display());
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn write_full_page(
    sock: &Path,
    session: &str,
    reply: &ScreenshotFullPageResult,
    out: &Path,
) -> Result<(), CliError> {
    let parent = out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temp = parent.join(format!(
        ".bsk-screenshot-{}.part",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create screenshot temporary file {}", temp.display()))
            .map_err(CliError::Local)?;
        let mut offset = 0;
        loop {
            let chunk: ScreenshotReadResult = crate::cli::business_rpc::call(
                sock.to_path_buf(),
                "screenshot-read",
                Method::ToolScreenshotRead,
                Some(ScreenshotReadParams {
                    session_id: session.into(),
                    capture_id: reply.capture_id.clone(),
                    offset,
                }),
                TOOL_IPC_TIMEOUT,
            )?;
            let bytes = validate_chunk(&chunk, offset, reply.byte_size)?;
            file.write_all(&bytes)
                .context("write screenshot chunk")
                .map_err(CliError::Local)?;
            offset = chunk.next_offset;
            if chunk.eof {
                break;
            }
        }
        file.sync_all()
            .context("flush screenshot")
            .map_err(CliError::Local)?;
        drop(file);
        // Keep screenshot's existing overwrite semantics, but never replace a
        // previous image with an interrupted or partially transferred PNG.
        crate::cli::atomic_output::commit(&temp, out, true)
            .with_context(|| format!("save screenshot to {}", out.display()))
            .map_err(CliError::Local)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn validate_chunk(
    chunk: &ScreenshotReadResult,
    offset: u64,
    total: u64,
) -> Result<Vec<u8>, CliError> {
    use base64::Engine;
    if chunk.data_base64.len() > 349_528 {
        return Err(CliError::Local(anyhow!("screenshot chunk exceeds 256 KiB")));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&chunk.data_base64)
        .context("decode screenshot chunk")
        .map_err(CliError::Local)?;
    if bytes.len() > 256 * 1024
        || bytes.is_empty()
        || offset.checked_add(bytes.len() as u64) != Some(chunk.next_offset)
        || chunk.next_offset > total
        || chunk.eof != (chunk.next_offset == total)
    {
        return Err(CliError::Local(anyhow!(
            "incomplete or invalid screenshot chunk"
        )));
    }
    Ok(bytes)
}

fn release_full_page(sock: &Path, session: &str, capture_id: &str) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut client = crate::ipc_client::IpcClient::connect(sock).await?;
            let _: Result<ScreenshotReleaseResult, _> = client
                .call(
                    "screenshot-release",
                    Method::ToolScreenshotRelease,
                    Some(ScreenshotReleaseParams {
                        session_id: session.into(),
                        capture_id: capture_id.into(),
                    }),
                    Duration::from_secs(5),
                )
                .await?;
            Ok::<_, anyhow::Error>(())
        })
        .await?
    })
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
    fn full_page_arguments_are_explicit_and_ref_is_exclusive() {
        use clap::Parser;
        let parse = |extra: &[&str]| {
            let mut args = vec!["bsk", "screenshot", "--session", "s1"];
            args.extend_from_slice(extra);
            crate::cli::Cli::try_parse_from(args)
        };
        assert!(parse(&[]).is_ok());
        assert!(parse(&["--ref", "@e1"]).is_ok());
        assert!(parse(&["--full-page", "--timeout", "5m"]).is_ok());
        assert!(parse(&["--full-page", "--ref", "@e1"]).is_err());
        assert!(parse(&["--timeout", "5m"]).is_err());
        assert!(parse(&["--full-page", "--timeout", "0ms"]).is_err());
    }

    #[test]
    fn rejects_incomplete_or_oversized_export_chunks() {
        let valid = ScreenshotReadResult {
            data_base64: "cG5n".into(),
            next_offset: 3,
            eof: true,
        };
        assert_eq!(validate_chunk(&valid, 0, 3).unwrap(), b"png");
        assert!(validate_chunk(&valid, 1, 4).is_err());
        assert!(validate_chunk(&valid, 0, 4).is_err());
        assert!(
            validate_chunk(
                &ScreenshotReadResult {
                    eof: false,
                    ..valid.clone()
                },
                0,
                3
            )
            .is_err()
        );
        assert!(
            validate_chunk(
                &ScreenshotReadResult {
                    data_base64: String::new(),
                    next_offset: 0,
                    eof: false
                },
                0,
                3
            )
            .is_err()
        );
        assert!(
            validate_chunk(
                &ScreenshotReadResult {
                    data_base64: "A".repeat(349_532),
                    ..valid
                },
                0,
                300_000
            )
            .is_err()
        );
    }

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
