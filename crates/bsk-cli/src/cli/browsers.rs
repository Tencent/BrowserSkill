//! `bsk browsers` — list connected extension clients (M4).

use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::system::BrowserListParams;
use bsk_protocol::system::BrowserStatusEntry;
use serde::Deserialize;

use crate::cli::browser_wait::{
    browser_connect_wait, browser_query_ipc_timeout, wait_for_browser_ms,
};
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Deserialize)]
struct ListReply {
    browsers: Vec<BrowserStatusEntry>,
}

pub fn dispatch(format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    run_list(info.sock_path, format)
}

fn run_list(sock: PathBuf, format: Format) -> Result<(), CliError> {
    let wait = browser_connect_wait();
    let params = BrowserListParams {
        wait_for_browser_ms: wait_for_browser_ms(wait),
    };
    let timeout = browser_query_ipc_timeout(wait, Duration::from_secs(5));
    let reply: ListReply = call(sock, params, timeout)?;
    match format {
        Format::Json => {
            println!(
                "{}",
                serde_json::to_string_pretty(&reply.browsers)
                    .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?
            );
        }
        Format::Human => {
            if reply.browsers.is_empty() {
                println!("(no browsers connected)");
                return Ok(());
            }
            let rows: Vec<[String; 5]> = reply
                .browsers
                .iter()
                .map(|b| {
                    [
                        b.instance_id.clone(),
                        format!("{} {}", b.browser_name, b.browser_version),
                        b.extension_version.clone(),
                        if b.label.is_empty() {
                            "-".into()
                        } else {
                            b.label.clone()
                        },
                        b.session_count.to_string(),
                    ]
                })
                .collect();
            let headers = ["INSTANCE", "BROWSER", "EXT", "LABEL", "SESSIONS"];
            let widths: [usize; 5] = std::array::from_fn(|i| {
                rows.iter()
                    .map(|r| r[i].len())
                    .max()
                    .unwrap_or(0)
                    .max(headers[i].len())
            });
            println!(
                "{:<w0$}  {:<w1$}  {:<w2$}  {:<w3$}  {}",
                headers[0],
                headers[1],
                headers[2],
                headers[3],
                headers[4],
                w0 = widths[0],
                w1 = widths[1],
                w2 = widths[2],
                w3 = widths[3],
            );
            for r in &rows {
                println!(
                    "{:<w0$}  {:<w1$}  {:<w2$}  {:<w3$}  {}",
                    r[0],
                    r[1],
                    r[2],
                    r[3],
                    r[4],
                    w0 = widths[0],
                    w1 = widths[1],
                    w2 = widths[2],
                    w3 = widths[3],
                );
            }
        }
    }
    Ok(())
}

fn call(
    sock: PathBuf,
    params: BrowserListParams,
    timeout: Duration,
) -> Result<ListReply, CliError> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build tokio runtime for browser.list RPC")
        .map_err(CliError::Local)?;
    rt.block_on(async move {
        let mut client = crate::ipc_client::IpcClient::connect(sock).await?;
        let outcome = client
            .call("browser-list-1", Method::BrowserList, Some(params), timeout)
            .await?;
        outcome.map_err(CliError::from_rpc)
    })
}
