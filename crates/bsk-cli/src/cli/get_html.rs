//! `bsk get-html` — dump raw DOM HTML (M6.4). Optionally narrows to a
//! single subtree by `@eN` ref. Defaults its `--max-bytes` budget to
//! the bsk-protocol spec (`524288`) when the user does not override
//! it — the extension would otherwise apply the same default
//! locally.

use std::path::{Path, PathBuf};

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{GetHtmlParams, GetHtmlResult};
use clap::Args;

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::dialogs::print_dialog_summaries;
use crate::cli::ensure_daemon::ensure_daemon_optimistic as ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct GetHtmlArgs {
    /// Session id (omit to resolve via caller scope).
    #[arg(long)]
    pub session: Option<String>,

    /// Explicit caller scope name for multi-agent isolation.
    #[arg(long)]
    pub scope: Option<String>,

    /// Target tab. Defaults to the Agent Window's active tab.
    #[arg(long = "tab-id")]
    pub tab_id: Option<i64>,

    /// Optional `@eN` ref from the last `bsk snapshot`. Scopes the
    /// dump to the matching subtree.
    #[arg(long = "ref")]
    pub ref_: Option<String>,

    /// Maximum HTML bytes to return before truncation.
    #[arg(long = "max-bytes")]
    pub max_bytes: Option<u32>,

    /// Write HTML to this path instead of stdout. With `--json`, stdout reports the
    /// path and sizes without the HTML.
    #[arg(long)]
    pub out: Option<PathBuf>,
}

pub fn dispatch(
    args: GetHtmlArgs,
    ctx: &crate::cli::business_rpc::ClientContext,
    format: Format,
) -> Result<(), CliError> {
    let op_ctx = ctx.with_scope(args.scope.as_deref());
    let info = ensure_daemon().context("ensure daemon is running")?;
    run(info.sock_path, &op_ctx, args, format)
}

fn run(
    sock: PathBuf,
    ctx: &crate::cli::business_rpc::ClientContext,
    args: GetHtmlArgs,
    format: Format,
) -> Result<(), CliError> {
    let params = GetHtmlParams {
        session_id: args.session.clone().unwrap_or_default(),
        tab_id: args.tab_id,
        ref_: args.ref_.clone(),
        max_bytes: args.max_bytes,
    };
    let reply: GetHtmlResult = call(sock, ctx, params)?;
    if let Some(out) = &args.out {
        std::fs::write(out, reply.html.as_bytes())
            .with_context(|| format!("write HTML to {}", out.display()))
            .map_err(CliError::Local)?;
    }
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(&json_reply(&reply, args.out.as_deref()))
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => {
            if args.out.is_some() {
                println!(
                    "tab={} bytes={} truncated={}",
                    reply.tab_id, reply.byte_size, reply.truncated
                );
            } else {
                println!("{}", reply.html);
                if reply.truncated {
                    eprintln!(
                        "warning: HTML truncated (full size {} bytes). Pass `--max-bytes N` to widen.",
                        reply.byte_size
                    );
                }
            }
            print_dialog_summaries(&reply.dialogs);
        }
    }
    Ok(())
}

fn call(
    sock: PathBuf,
    ctx: &crate::cli::business_rpc::ClientContext,
    params: GetHtmlParams,
) -> Result<GetHtmlResult, CliError> {
    ctx.call::<GetHtmlParams, GetHtmlResult>(
        sock,
        "get-html",
        Method::ToolGetHtml,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}

/// JSON output. With `--out` the HTML lives only in the file, so stdout reports
/// where it went instead of repeating a payload that can be hundreds of KB.
fn json_reply(reply: &GetHtmlResult, out: Option<&Path>) -> serde_json::Value {
    let Some(out) = out else {
        return serde_json::to_value(reply).unwrap_or(serde_json::Value::Null);
    };
    let mut json = serde_json::json!({
        "tab_id": reply.tab_id,
        "path": out.to_string_lossy(),
        "written_bytes": reply.html.len(),
        "byte_size": reply.byte_size,
        "truncated": reply.truncated,
    });
    if !reply.dialogs.is_empty() {
        json["dialogs"] = serde_json::to_value(&reply.dialogs).unwrap_or_default();
    }
    json
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply() -> GetHtmlResult {
        GetHtmlResult {
            html: "<html><body>secret page body</body></html>".into(),
            truncated: true,
            byte_size: 343_001,
            tab_id: 7,
            dialogs: Vec::new(),
        }
    }

    #[test]
    fn json_with_out_reports_the_file_instead_of_the_html() {
        let json = json_reply(&reply(), Some(Path::new("/tmp/page.html")));
        assert_eq!(
            json,
            serde_json::json!({
                "tab_id": 7,
                "path": "/tmp/page.html",
                "written_bytes": 42,
                "byte_size": 343_001,
                "truncated": true,
            })
        );
        assert!(!json.to_string().contains("secret page body"));
    }

    #[test]
    fn json_without_out_still_returns_the_html() {
        let json = json_reply(&reply(), None);
        assert_eq!(json["html"], "<html><body>secret page body</body></html>");
        assert_eq!(json["byte_size"], 343_001);
    }
}
