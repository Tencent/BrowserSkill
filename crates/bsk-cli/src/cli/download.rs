//! `bsk download` — capture one browser download and atomically commit it.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use base64::Engine;
use bsk_protocol::Method;
use bsk_protocol::tools::{
    DownloadParams, DownloadResult, TransferChunkParams, TransferChunkResult, TransferIdParams,
    TransferReleaseResult,
};
use clap::Args;
use uuid::Uuid;

use crate::cli::atomic_output;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::cli::interaction::split_target;
use crate::cli::navigate::parse_timeout_ms;

#[derive(Debug, Clone, Args)]
pub struct DownloadArgs {
    /// Snapshot ref (`@e3`) or CSS selector for the download trigger.
    pub target: Option<String>,
    #[arg(long = "ref")]
    pub ref_: Option<String>,
    #[arg(long = "selector")]
    pub selector: Option<String>,
    #[arg(long)]
    pub out: PathBuf,
    #[arg(long)]
    pub session: String,
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,
    #[arg(long, default_value = "2m", value_parser = parse_timeout_ms)]
    pub timeout: u32,
    #[arg(long)]
    pub overwrite: bool,
}

pub fn dispatch(args: DownloadArgs, format: Format) -> Result<(), CliError> {
    if args.out.exists() && !args.overwrite {
        return Err(CliError::Local(anyhow::anyhow!(
            "output already exists (pass --overwrite to replace it): {}",
            args.out.display()
        )));
    }
    let info = ensure_daemon().context("ensure daemon is running")?;
    let (ref_, selector) = split_target(args.target, args.ref_, args.selector)?;
    let params = DownloadParams {
        session_id: args.session,
        ref_,
        selector,
        tab_id: args.tab_id,
        timeout_ms: Some(args.timeout),
        browser_relative_dir: None,
        max_byte_size: None,
    };
    let reply: DownloadResult = crate::cli::business_rpc::call(
        info.sock_path.clone(),
        "download",
        Method::ToolDownload,
        Some(params),
        ipc_timeout(args.timeout),
    )?;
    let transfer_id = reply.transfer_id.clone().ok_or_else(|| {
        CliError::Local(anyhow::anyhow!("daemon returned no download transfer id"))
    })?;
    let write_result = write_transfer(&info.sock_path, &transfer_id, &args.out, args.overwrite);
    let _: Result<TransferReleaseResult, CliError> = crate::cli::business_rpc::call(
        info.sock_path,
        "transfer-release",
        Method::TransferRelease,
        Some(TransferIdParams { transfer_id }),
        Duration::from_secs(5),
    );
    write_result?;
    match format {
        Format::Json => {
            let mut value = serde_json::to_value(&reply).unwrap();
            value["path"] = serde_json::json!(args.out.to_string_lossy());
            if let Some(obj) = value.as_object_mut() {
                obj.remove("transfer_id");
                obj.remove("browser_path");
            }
            println!("{}", serde_json::to_string_pretty(&value).unwrap());
        }
        Format::Human => println!("{}", args.out.display()),
    }
    Ok(())
}

fn write_transfer(sock: &Path, id: &str, out: &Path, overwrite: bool) -> Result<(), CliError> {
    let parent = out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let temp = parent.join(format!(".bsk-download-{}.part", Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .with_context(|| format!("create temporary download {}", temp.display()))
            .map_err(CliError::Local)?;
        let mut offset = 0u64;
        loop {
            let chunk: TransferChunkResult = crate::cli::business_rpc::call(
                sock.to_path_buf(),
                "transfer-read",
                Method::TransferRead,
                Some(TransferChunkParams {
                    transfer_id: id.to_string(),
                    offset,
                    data_base64: String::new(),
                }),
                Duration::from_secs(30),
            )?;
            let encoded = chunk.data_base64.as_deref().unwrap_or("");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|e| CliError::Local(anyhow::anyhow!("decode download chunk: {e}")))?;
            file.write_all(&bytes)
                .map_err(|e| CliError::Local(e.into()))?;
            offset = chunk.next_offset;
            if chunk.eof {
                break;
            }
        }
        file.sync_all().map_err(|e| CliError::Local(e.into()))?;
        drop(file);
        atomic_output::commit(&temp, out, overwrite)
            .with_context(|| format!("atomically commit download to {}", out.display()))
            .map_err(CliError::Local)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn ipc_timeout(timeout_ms: u32) -> Duration {
    Duration::from_millis(u64::from(timeout_ms) + 5_000)
}
