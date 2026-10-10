//! Start is nonblocking. Only explicit save/stop --out transfers bytes to the
//! CLI machine; output paths never travel to the extension.
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, anyhow, bail};
use base64::Engine;
use bsk_protocol::Method;
use bsk_protocol::tools::{
    VideoCompleteness, VideoGrant, VideoParams, VideoQuality, VideoReadResult, VideoRecording,
    VideoState,
};
use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::error::{CliError, Format};
use super::{TOOL_IPC_TIMEOUT, atomic_output, business_rpc};

#[derive(Debug, Clone, Args)]
pub struct VideoCmd {
    #[command(subcommand)]
    pub command: VideoCommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum VideoCommand {
    /// Record a fixed task tab as H.264 MP4 (no audio), then return immediately.
    Start(StartArgs),
    /// Read state, including an automatically stopped recording.
    Status(Selector),
    /// Stop idempotently. Optionally export to an explicit path.
    Stop(StopArgs),
    /// Save an already finished recording on this CLI's computer.
    Save(SaveArgs),
    /// List this connection's browser-owned recordings (retained for 24 hours).
    List(ListArgs),
    /// Delete a stopped browser copy; files already saved are unaffected.
    Discard(Selector),
}

#[derive(Debug, Clone, Args)]
pub struct StartArgs {
    #[arg(long)]
    pub session: String,
    #[arg(long)]
    pub tab_id: Option<i64>,
    #[arg(long, visible_alias = "max-duration", default_value = "60s", value_parser = parse_duration)]
    pub duration: u32,
    #[arg(long, default_value = "standard", value_parser = ["standard", "clear"])]
    pub quality: String,
    /// Reuse the same ID to recover a start whose reply was lost.
    #[arg(long)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct Selector {
    /// Omit only when exactly one recording matches.
    #[arg(long)]
    pub recording: Option<String>,
    /// Browser instance ID or label; required when connected browsers are ambiguous.
    #[arg(long)]
    pub browser: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct ListArgs {
    #[arg(long)]
    pub browser: Option<String>,
}

#[derive(Debug, Clone, Args)]
pub struct StopArgs {
    #[command(flatten)]
    pub selector: Selector,
    #[arg(long)]
    pub out: Option<PathBuf>,
    #[arg(long, requires = "out")]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Args)]
pub struct SaveArgs {
    #[command(flatten)]
    pub selector: Selector,
    #[arg(long)]
    pub out: PathBuf,
    #[arg(long)]
    pub overwrite: bool,
}

#[derive(Serialize, Deserialize)]
struct CachedGrant {
    browser: String,
    #[serde(flatten)]
    grant: VideoGrant,
}
#[derive(Deserialize)]
struct Listing {
    browser: String,
    recordings: Vec<VideoGrant>,
}
#[derive(Deserialize)]
struct Status {
    recording: VideoRecording,
}

fn parse_duration(value: &str) -> Result<u32, String> {
    let duration = super::navigate::parse_timeout_ms(value)?;
    if !(1000..=600_000).contains(&duration) {
        return Err("video duration must be 1s..10m".into());
    }
    Ok(duration)
}

fn call<T: serde::de::DeserializeOwned + Send + 'static>(
    sock: &Path,
    params: VideoParams,
) -> Result<T, CliError> {
    business_rpc::call(
        sock.to_path_buf(),
        "video",
        Method::ToolVideo,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}

fn capabilities(
    sock: &Path,
    browser: Option<String>,
    session: Option<String>,
) -> Result<(), CliError> {
    let reply: Value = call(sock, VideoParams::Capabilities { browser, session_id: session })
        .map_err(|error| CliError::Local(anyhow!("Video capability check failed: {error}. Update both the CLI daemon and extension if video is unsupported.")))?;
    if reply.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(anyhow!(
            "Video protocol version 1 is required; update the CLI daemon and extension"
        )
        .into());
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    id.strip_prefix("vid_").is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn cache_path(id: &str) -> anyhow::Result<PathBuf> {
    if !valid_id(id) {
        bail!("invalid recording ID");
    }
    Ok(crate::daemon::paths::ensure_bsk_home()?.join(format!("video-{id}.json")))
}

fn remember(value: &CachedGrant) -> anyhow::Result<()> {
    let path = cache_path(&value.grant.recording.recording_id)?;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    // NamedTempFile is created with owner-only permissions on Unix. The parent
    // is the existing per-user application directory on every platform.
    serde_json::to_writer(&mut temp, value)?;
    temp.as_file().sync_all()?;
    atomic_output::commit(temp.path(), &path, true)?;
    Ok(())
}

fn listing(sock: &Path, browser: Option<String>) -> Result<Listing, CliError> {
    capabilities(sock, browser.clone(), None)?;
    let list: Listing = call(sock, VideoParams::List { browser })?;
    for grant in &list.recordings {
        remember(&CachedGrant {
            browser: list.browser.clone(),
            grant: grant.clone(),
        })?;
    }
    Ok(list)
}

fn resolve(sock: &Path, selector: Selector) -> Result<CachedGrant, CliError> {
    if let Some(id) = &selector.recording {
        let path = cache_path(id)?;
        if selector.browser.is_none() && path.exists() {
            let cached: CachedGrant =
                serde_json::from_slice(&std::fs::read(path).context("read private video grant")?)
                    .context("parse private video grant")?;
            if cached.grant.recording.recording_id != *id {
                return Err(anyhow!("Video cache identity mismatch").into());
            }
            return Ok(cached);
        }
    }
    let list = listing(sock, selector.browser)?;
    let mut matches: Vec<_> = list
        .recordings
        .into_iter()
        .filter(|grant| {
            selector
                .recording
                .as_ref()
                .is_none_or(|id| *id == grant.recording.recording_id)
        })
        .collect();
    if matches.len() != 1 {
        return Err(anyhow!(
            "Choose one recording with --recording ({} matches); use bsk video list",
            matches.len()
        )
        .into());
    }
    Ok(CachedGrant {
        browser: list.browser,
        grant: matches.remove(0),
    })
}

pub fn dispatch(cmd: VideoCmd, format: Format) -> Result<(), CliError> {
    let sock = super::ensure_daemon::ensure_daemon()?.sock_path;
    match cmd.command {
        VideoCommand::Start(args) => {
            capabilities(&sock, None, Some(args.session.clone()))?;
            let result: CachedGrant = call(
                &sock,
                VideoParams::Start {
                    session_id: args.session,
                    tab_id: args.tab_id,
                    max_duration_ms: args.duration,
                    quality: if args.quality == "clear" {
                        VideoQuality::Clear
                    } else {
                        VideoQuality::Standard
                    },
                    request_id: args
                        .request_id
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                },
            )?;
            remember(&result)?;
            render(&result.grant.recording, None, format)
        }
        VideoCommand::List(args) => {
            let list = listing(&sock, args.browser)?;
            let recordings: Vec<_> = list
                .recordings
                .into_iter()
                .map(|grant| grant.recording)
                .collect();
            if matches!(format, Format::Json) {
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &json!({"browser": list.browser, "recordings": recordings})
                    )
                    .context("serialize video list")?
                );
            } else {
                for value in recordings {
                    render(&value, None, format)?;
                }
            }
            Ok(())
        }
        VideoCommand::Status(selector) => {
            let cached = resolve(&sock, selector)?;
            let result: Status = call(
                &sock,
                VideoParams::Status {
                    browser: cached.browser,
                    recording_id: cached.grant.recording.recording_id,
                    capability: cached.grant.capability,
                },
            )?;
            render(&result.recording, None, format)
        }
        VideoCommand::Stop(args) => {
            let mut cached = resolve(&sock, args.selector)?;
            let result: Status = call(
                &sock,
                VideoParams::Stop {
                    browser: cached.browser.clone(),
                    recording_id: cached.grant.recording.recording_id.clone(),
                    capability: cached.grant.capability.clone(),
                },
            )?;
            cached.grant.recording = result.recording;
            if let Some(out) = &args.out {
                save(&sock, &cached, out, args.overwrite)?;
                cached.grant.recording.exported = true;
            }
            render_finished(&cached.grant.recording, args.out.as_deref(), format)
        }
        VideoCommand::Save(args) => {
            let mut cached = resolve(&sock, args.selector)?;
            let result: Status = call(
                &sock,
                VideoParams::Status {
                    browser: cached.browser.clone(),
                    recording_id: cached.grant.recording.recording_id.clone(),
                    capability: cached.grant.capability.clone(),
                },
            )?;
            cached.grant.recording = result.recording;
            save(&sock, &cached, &args.out, args.overwrite)?;
            cached.grant.recording.exported = true;
            render_finished(&cached.grant.recording, Some(&args.out), format)
        }
        VideoCommand::Discard(selector) => {
            let cached = resolve(&sock, selector)?;
            let id = cached.grant.recording.recording_id;
            let _: Value = call(
                &sock,
                VideoParams::Discard {
                    browser: cached.browser,
                    recording_id: id.clone(),
                    capability: cached.grant.capability,
                },
            )?;
            let _ = std::fs::remove_file(cache_path(&id)?);
            println!(
                "{}",
                if matches!(format, Format::Json) {
                    json!({"recording_id": id, "discarded": true}).to_string()
                } else {
                    format!("Deleted {id}")
                }
            );
            Ok(())
        }
    }
}

fn render(recording: &VideoRecording, out: Option<&Path>, format: Format) -> Result<(), CliError> {
    if matches!(format, Format::Json) {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({"recording": recording, "path": out}))
                .context("serialize video status")?
        );
    } else {
        println!(
            "{} · {:?} · {:.1}s · {} bytes",
            recording.recording_id,
            recording.state,
            recording.duration_ms as f64 / 1000.0,
            recording.byte_size
        );
        if let Some(reason) = &recording.stop_reason {
            println!(
                "stop reason: {reason}; completeness: {:?}",
                recording.completeness
            );
        }
        if let Some(path) = out {
            println!("saved: {}", path.display());
        } else if recording.state == VideoState::Ready {
            println!(
                "Waiting to save: bsk video save --recording {} --out <file.mp4>",
                recording.recording_id
            );
        }
        if let Some(error) = &recording.error {
            println!("error: {error}");
        }
    }
    Ok(())
}

fn render_finished(
    recording: &VideoRecording,
    out: Option<&Path>,
    format: Format,
) -> Result<(), CliError> {
    render(recording, out, format)?;
    if recording.state == VideoState::Failed
        || recording.completeness == Some(VideoCompleteness::Partial)
    {
        return Err(CliError::RenderedExit { exit_code: 1 });
    }
    Ok(())
}

fn save(sock: &Path, cached: &CachedGrant, out: &Path, overwrite: bool) -> Result<(), CliError> {
    let recording = &cached.grant.recording;
    if recording.state != VideoState::Ready {
        return Err(anyhow!("Recording is not ready; stop it before saving").into());
    }
    if recording.byte_size == 0 || recording.byte_size > 256 * 1024 * 1024 {
        return Err(anyhow!("Invalid video artifact size").into());
    }
    if !overwrite && out.exists() {
        return Err(anyhow!("Output exists; choose another path or pass --overwrite").into());
    }
    let parent = out
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temp = tempfile::Builder::new()
        .prefix(".bsk-video-")
        .suffix(".part")
        .tempfile_in(parent)
        .context("create adjacent video temporary file")?;
    let mut offset = 0;
    while offset < recording.byte_size {
        let chunk: VideoReadResult = call(
            sock,
            VideoParams::Read {
                browser: cached.browser.clone(),
                recording_id: recording.recording_id.clone(),
                capability: cached.grant.capability.clone(),
                offset,
            },
        )?;
        let bytes = validate_chunk(&chunk, &recording.recording_id, offset, recording.byte_size)?;
        temp.write_all(&bytes).context("write video chunk")?;
        offset = chunk.next_offset;
    }
    temp.as_file().sync_all().context("flush video")?;
    atomic_output::commit(temp.path(), out, overwrite).context("commit video output")?;
    // The file is already committed. A lost acknowledgement must not pretend
    // the user's save failed or remove the browser's recoverable copy.
    let _: Result<Value, _> = call(
        sock,
        VideoParams::Exported {
            browser: cached.browser.clone(),
            recording_id: recording.recording_id.clone(),
            capability: cached.grant.capability.clone(),
        },
    );
    Ok(())
}

fn validate_chunk(
    chunk: &VideoReadResult,
    id: &str,
    offset: u64,
    total: u64,
) -> anyhow::Result<Vec<u8>> {
    if chunk.data_base64.len() > 349_528 {
        bail!("video chunk exceeds 256 KiB");
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&chunk.data_base64)
        .context("decode video chunk")?;
    if chunk.recording_id != id
        || chunk.offset != offset
        || chunk.byte_size != total
        || bytes.is_empty()
        || bytes.len() > 256 * 1024
        || chunk.next_offset != offset + bytes.len() as u64
        || chunk.next_offset > total
    {
        bail!("video transfer returned inconsistent chunk metadata");
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn accepts_the_issue_duration_flag_and_requires_an_explicit_save_path() {
        for option in ["--duration", "--max-duration"] {
            let parsed = crate::cli::Cli::try_parse_from([
                "bsk",
                "video",
                "start",
                "--session",
                "task",
                option,
                "5m",
            ])
            .unwrap();
            let crate::cli::Command::Video(VideoCmd {
                command: VideoCommand::Start(args),
            }) = parsed.command
            else {
                panic!("expected video start");
            };
            assert_eq!(args.duration, 300_000);
        }
        assert!(crate::cli::Cli::try_parse_from(["bsk", "video", "save"]).is_err());
    }

    #[test]
    fn bounds_duration_and_artifact_identity() {
        assert_eq!(parse_duration("1m").unwrap(), 60_000);
        for value in ["0s", "999ms", "11m"] {
            assert!(parse_duration(value).is_err());
        }
        assert!(!valid_id("../../other"));
        assert!(!valid_id("vid_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    }
    #[test]
    fn rejects_wrong_artifacts_offsets_and_empty_chunks() {
        let mut chunk = VideoReadResult {
            recording_id: "test".into(),
            offset: 0,
            byte_size: 3,
            next_offset: 3,
            data_base64: "YWJj".into(),
        };
        assert_eq!(validate_chunk(&chunk, "test", 0, 3).unwrap(), b"abc");
        assert!(validate_chunk(&chunk, "other", 0, 3).is_err());
        assert!(validate_chunk(&chunk, "test", 1, 3).is_err());
        chunk.data_base64.clear();
        chunk.next_offset = 0;
        assert!(validate_chunk(&chunk, "test", 0, 3).is_err());
    }
}
