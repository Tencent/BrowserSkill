//! `bsk ext` — explicit extension lifecycle commands.

use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::system::{ExtensionReloadParams, ExtensionReloadResult};
use clap::{Args, Subcommand};

use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};
use crate::ipc_client::IpcClient;

#[derive(Debug, Clone, Subcommand)]
pub enum ExtensionCmd {
    /// Reload one idle extension after replacing an unpacked development build.
    Reload(ExtensionReloadArgs),
}

#[derive(Debug, Clone, Args)]
pub struct ExtensionReloadArgs {
    /// Browser instance id or label. Required when multiple browsers are connected.
    #[arg(long)]
    pub browser: Option<String>,
}

pub fn dispatch(command: ExtensionCmd, format: Format) -> Result<(), CliError> {
    match command {
        ExtensionCmd::Reload(args) => reload(args, format),
    }
}

fn reload(args: ExtensionReloadArgs, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    if !supports_extension_reload(info.protocol_version.as_deref().unwrap_or("")) {
        return Err(CliError::Local(anyhow::anyhow!(
            "bsk ext reload requires daemon protocol 2.1 or newer; update bsk and restart the daemon"
        )));
    }
    let params = ExtensionReloadParams {
        browser_instance_id: args.browser,
    };
    let result = call(info.sock_path, params, Duration::from_secs(10))?;
    match format {
        Format::Json => println!(
            "{}",
            serde_json::to_string_pretty(&result)
                .map_err(|error| CliError::Local(anyhow::anyhow!(error)))?
        ),
        Format::Human => println!(
            "Reload scheduled for BrowserSkill instance {}. Wait for it to reconnect before starting a session.",
            result.browser_instance_id
        ),
    }
    Ok(())
}

fn supports_extension_reload(protocol_version: &str) -> bool {
    matches!(
        bsk_protocol::system::compare_protocol(protocol_version, "2.1"),
        Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
    )
}

fn call(
    sock_path: std::path::PathBuf,
    params: ExtensionReloadParams,
    timeout: Duration,
) -> Result<ExtensionReloadResult, CliError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build tokio runtime for extension.reload RPC")
        .map_err(CliError::Local)?;
    runtime.block_on(async move {
        let mut client = IpcClient::connect(sock_path).await?;
        let outcome = client
            .call(
                "extension-reload-1",
                Method::ExtensionReload,
                Some(params),
                timeout,
            )
            .await?;
        outcome.map_err(CliError::from_rpc)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn reload_accepts_an_explicit_browser_instance() {
        let cli =
            crate::cli::Cli::try_parse_from(["bsk", "ext", "reload", "--browser", "b1234567"])
                .unwrap();
        let crate::cli::Command::Extension(ExtensionCmd::Reload(args)) = cli.command else {
            panic!("expected bsk ext reload");
        };
        assert_eq!(args.browser.as_deref(), Some("b1234567"));
    }

    #[test]
    fn reload_requires_protocol_2_1_but_accepts_later_minors() {
        assert!(!supports_extension_reload("2.0"));
        assert!(supports_extension_reload("2.1"));
        assert!(supports_extension_reload("2.2"));
        assert!(!supports_extension_reload("broken"));
    }
}
