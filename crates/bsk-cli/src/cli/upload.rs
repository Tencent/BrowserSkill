//! `bsk upload` — stage caller-readable files and attach them to a page.

use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use base64::Engine;
use bsk_protocol::Method;
use bsk_protocol::tools::{
    TransferBeginParams, TransferBeginResult, TransferChunkParams, TransferChunkResult,
    TransferIdParams, TransferReadyResult, TransferReleaseResult, UploadFile, UploadParams,
    UploadResult,
};
use clap::Args;

use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::interaction::split_target;
use crate::cli::navigate::parse_timeout_ms;

#[derive(Debug, Clone, Args)]
pub struct UploadArgs {
    /// Snapshot ref (`@e3`) or CSS selector for the file input / chooser trigger.
    pub target: Option<String>,
    #[arg(long = "ref")]
    pub ref_: Option<String>,
    #[arg(long = "selector")]
    pub selector: Option<String>,
    /// Local file to upload. Repeat for a multiple-file input.
    #[arg(long = "file", required = true)]
    pub files: Vec<PathBuf>,
    #[arg(long)]
    pub session: String,
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,
    #[arg(long, default_value = "2m", value_parser = parse_timeout_ms)]
    pub timeout: u32,
}

pub fn dispatch(args: UploadArgs, format: Format) -> Result<(), CliError> {
    if args.files.len() > crate::daemon::file_transfer::MAX_UPLOAD_FILES {
        return Err(CliError::Local(anyhow::anyhow!(
            "upload accepts at most {} files",
            crate::daemon::file_transfer::MAX_UPLOAD_FILES
        )));
    }
    let info = ensure_daemon().context("ensure daemon is running")?;
    let (ref_, selector) = split_target(args.target, args.ref_, args.selector)?;
    let mut staged = Vec::new();
    let result = (|| {
        for path in &args.files {
            staged.push(stage_file(&info.sock_path, &args.session, path)?);
        }
        let params = UploadParams {
            session_id: args.session,
            ref_,
            selector,
            tab_id: args.tab_id,
            files: staged
                .iter()
                .map(|(id, name)| UploadFile {
                    transfer_id: id.clone(),
                    name: name.clone(),
                    staged_path: None,
                })
                .collect(),
            timeout_ms: Some(args.timeout),
        };
        crate::cli::business_rpc::call::<_, UploadResult>(
            info.sock_path.clone(),
            "upload",
            Method::ToolUpload,
            Some(params),
            ipc_timeout(args.timeout),
        )
    })();
    if result.is_err() {
        for (id, _) in &staged {
            let _ = release(&info.sock_path, id);
        }
    }
    let reply = result?;
    match format {
        Format::Json => println!("{}", serde_json::to_string_pretty(&reply).unwrap()),
        Format::Human => println!(
            "upload ok tab={} files={}",
            reply.tab_id,
            reply.file_names.join(", ")
        ),
    }
    Ok(())
}

fn stage_file(sock: &PathBuf, session: &str, path: &PathBuf) -> Result<(String, String), CliError> {
    let mut file = File::open(path)
        .with_context(|| format!("open upload file {}", path.display()))
        .map_err(CliError::Local)?;
    let meta = file
        .metadata()
        .with_context(|| format!("read upload file metadata {}", path.display()))
        .map_err(CliError::Local)?;
    if !meta.is_file() {
        return Err(CliError::Local(anyhow::anyhow!(
            "upload source is not a regular file: {}",
            path.display()
        )));
    }
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| CliError::Local(anyhow::anyhow!("upload file has no valid basename")))?
        .to_string();
    let begin: TransferBeginResult = crate::cli::business_rpc::call(
        sock.clone(),
        "transfer-begin",
        Method::TransferBegin,
        Some(TransferBeginParams {
            session_id: session.to_string(),
            name: name.clone(),
            byte_size: meta.len(),
        }),
        Duration::from_secs(10),
    )?;
    let staged = (|| {
        let mut offset = 0u64;
        let mut buf = vec![0u8; begin.chunk_size as usize];
        loop {
            let n = file.read(&mut buf).map_err(|e| CliError::Local(e.into()))?;
            if n == 0 {
                break;
            }
            let reply: TransferChunkResult = crate::cli::business_rpc::call(
                sock.clone(),
                "transfer-chunk",
                Method::TransferChunk,
                Some(TransferChunkParams {
                    transfer_id: begin.transfer_id.clone(),
                    offset,
                    data_base64: base64::engine::general_purpose::STANDARD.encode(&buf[..n]),
                }),
                Duration::from_secs(30),
            )?;
            offset = reply.next_offset;
        }
        let _: TransferReadyResult = crate::cli::business_rpc::call(
            sock.clone(),
            "transfer-finish",
            Method::TransferFinish,
            Some(TransferIdParams {
                transfer_id: begin.transfer_id.clone(),
            }),
            Duration::from_secs(10),
        )?;
        Ok::<_, CliError>(())
    })();
    if let Err(err) = staged {
        let _ = release(sock, &begin.transfer_id);
        return Err(err);
    }
    Ok((begin.transfer_id, name))
}

fn release(sock: &PathBuf, id: &str) -> Result<TransferReleaseResult, CliError> {
    crate::cli::business_rpc::call(
        sock.clone(),
        "transfer-release",
        Method::TransferRelease,
        Some(TransferIdParams {
            transfer_id: id.to_string(),
        }),
        Duration::from_secs(5),
    )
}

fn ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms) + 5_000)
}
