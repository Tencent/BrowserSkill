//! `bsk tab …` subcommands. M6.1 landed `list`; M8 adds create / close /
//! select / borrow / return for Agent Window tab management and the
//! user-tab borrow ↔ return loop.

use std::path::PathBuf;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{
    TabBorrowParams, TabBorrowResult, TabCloseParams, TabCloseResult, TabCreateParams,
    TabCreateResult, TabInfo, TabListParams, TabListResult, TabReturnParams, TabReturnResult,
    TabScope, TabSelectParams, TabSelectResult,
};
use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;

use crate::cli::TOOL_IPC_TIMEOUT;
use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Clone, Args)]
pub struct TabCmd {
    #[command(subcommand)]
    pub sub: TabSub,
}

#[derive(Debug, Clone, Subcommand)]
pub enum TabSub {
    /// List tabs visible to the session, filtered by scope.
    List(TabListArgs),
    /// Open a new tab inside the session's Agent Window.
    Create(TabCreateArgs),
    /// Close a tab in the session's Agent Window.
    Close(TabCloseArgs),
    /// Activate (focus) a tab in the session's Agent Window.
    Select(TabSelectArgs),
    /// Borrow a user tab into the session's Agent Window.
    Borrow(TabBorrowArgs),
    /// Return a previously borrowed tab to its origin window.
    Return(TabReturnArgs),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, ValueEnum)]
pub enum CliScope {
    /// Tabs owned by the user (any window that is not an Agent Window).
    User,
    /// Tabs in this session's Agent Window only.
    Agent,
    /// Union of `user` + this session's `agent` tabs.
    #[default]
    All,
}

impl From<CliScope> for TabScope {
    fn from(value: CliScope) -> Self {
        match value {
            CliScope::User => TabScope::User,
            CliScope::Agent => TabScope::Agent,
            CliScope::All => TabScope::All,
        }
    }
}

#[derive(Debug, Clone, Args)]
pub struct TabListArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,

    /// View scope (defaults to `all`).
    #[arg(long, value_enum, default_value_t = CliScope::All)]
    pub scope: CliScope,
}

#[derive(Debug, Clone, Args)]
pub struct TabCreateArgs {
    /// Session id (must be active).
    #[arg(long)]
    pub session: String,
    /// Destination URL (default `chrome://newtab/`).
    #[arg(long)]
    pub url: Option<String>,
    /// Open as a *background* tab (default focuses the new tab).
    #[arg(long = "no-active", action = clap::ArgAction::SetTrue)]
    pub no_active: bool,
    /// Insertion index within the Agent Window's tab strip.
    #[arg(long)]
    pub index: Option<i32>,
}

#[derive(Debug, Clone, Args)]
pub struct TabCloseArgs {
    /// Tab id to close (must be in the session's Agent Window).
    pub tab_id: i64,
    #[arg(long)]
    pub session: String,
}

#[derive(Debug, Clone, Args)]
pub struct TabSelectArgs {
    /// Tab id to activate.
    pub tab_id: i64,
    #[arg(long)]
    pub session: String,
}

#[derive(Debug, Clone, Args)]
pub struct TabBorrowArgs {
    /// User-window tab id to borrow into the session's Agent Window.
    pub tab_id: i64,
    #[arg(long)]
    pub session: String,
    /// Skip the inline confirmation overlay when borrowing a tab.
    /// Accepted for forward compatibility; currently has no effect.
    #[arg(long = "no-confirm", action = clap::ArgAction::SetTrue)]
    pub no_confirm: bool,
}

#[derive(Debug, Clone, Args)]
pub struct TabReturnArgs {
    /// Borrowed tab id to return to its origin window.
    pub tab_id: i64,
    #[arg(long)]
    pub session: String,
}

pub fn dispatch(cmd: TabCmd, format: Format) -> Result<(), CliError> {
    let info = ensure_daemon().context("ensure daemon is running")?;
    match cmd.sub {
        TabSub::List(args) => run_list(info.sock_path, args, format),
        TabSub::Create(args) => run_create(info.sock_path, args, format),
        TabSub::Close(args) => run_close(info.sock_path, args, format),
        TabSub::Select(args) => run_select(info.sock_path, args, format),
        TabSub::Borrow(args) => run_borrow(info.sock_path, args, format),
        TabSub::Return(args) => run_return(info.sock_path, args, format),
    }
}

fn print_payload<T: Serialize>(
    value: &T,
    format: Format,
    human: impl FnOnce(),
) -> Result<(), CliError> {
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(value)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => human(),
    }
    Ok(())
}

fn run_create(sock: PathBuf, args: TabCreateArgs, format: Format) -> Result<(), CliError> {
    let params = TabCreateParams {
        session_id: args.session,
        url: args.url,
        active: if args.no_active { Some(false) } else { None },
        index: args.index,
    };
    let reply: TabCreateResult = ipc_call("tab-create-1", Method::ToolTabCreate, sock, params)?;
    print_payload(&reply, format, || {
        println!(
            "tab_id={} window_id={} url={}",
            reply.tab_id,
            reply.window_id,
            if reply.url.is_empty() {
                "<pending>"
            } else {
                reply.url.as_str()
            },
        );
    })
}

fn run_close(sock: PathBuf, args: TabCloseArgs, format: Format) -> Result<(), CliError> {
    let params = TabCloseParams {
        session_id: args.session,
        tab_id: args.tab_id,
    };
    let reply: TabCloseResult = ipc_call("tab-close-1", Method::ToolTabClose, sock, params)?;
    print_payload(&reply, format, || {
        println!("closed tab_id={}", reply.tab_id)
    })
}

fn run_select(sock: PathBuf, args: TabSelectArgs, format: Format) -> Result<(), CliError> {
    let params = TabSelectParams {
        session_id: args.session,
        tab_id: args.tab_id,
    };
    let reply: TabSelectResult = ipc_call("tab-select-1", Method::ToolTabSelect, sock, params)?;
    print_payload(&reply, format, || {
        println!(
            "selected tab_id={} window_id={}",
            reply.tab_id, reply.window_id
        )
    })
}

fn run_borrow(sock: PathBuf, args: TabBorrowArgs, format: Format) -> Result<(), CliError> {
    let params = TabBorrowParams {
        session_id: args.session,
        tab_id: args.tab_id,
        // M8: confirm is ignored on the daemon/extension side; we
        // surface the CLI flag so the same invocation keeps working
        // once M10 wires the inline overlay.
        confirm: if args.no_confirm { Some(false) } else { None },
    };
    let reply: TabBorrowResult = ipc_call("tab-borrow-1", Method::ToolTabBorrow, sock, params)?;
    print_payload(&reply, format, || {
        println!(
            "borrowed tab_id={} from window={} index={} → agent_window={}",
            reply.tab_id, reply.original_window_id, reply.original_index, reply.agent_window_id
        );
    })
}

fn run_return(sock: PathBuf, args: TabReturnArgs, format: Format) -> Result<(), CliError> {
    let params = TabReturnParams {
        session_id: args.session,
        tab_id: args.tab_id,
    };
    let reply: TabReturnResult = ipc_call("tab-return-1", Method::ToolTabReturn, sock, params)?;
    print_payload(&reply, format, || {
        let suffix = if reply.fallback {
            " (fallback window)"
        } else {
            ""
        };
        println!(
            "returned tab_id={} to window={} index={}{}",
            reply.tab_id, reply.returned_to_window_id, reply.returned_to_index, suffix
        );
    })
}

fn ipc_call<P, R>(
    rpc_id_prefix: &'static str,
    method: Method,
    sock: PathBuf,
    params: P,
) -> Result<R, CliError>
where
    P: serde::Serialize + Send + 'static,
    R: serde::de::DeserializeOwned + Send + 'static,
{
    crate::cli::business_rpc::call::<P, R>(
        sock,
        rpc_id_prefix,
        method,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}

fn run_list(sock: PathBuf, args: TabListArgs, format: Format) -> Result<(), CliError> {
    let params = TabListParams {
        session_id: args.session.clone(),
        scope: args.scope.into(),
    };
    let reply: TabListResult = call(sock, params)?;
    match format {
        Format::Json => {
            let json = serde_json::to_string_pretty(&reply)
                .map_err(|e| CliError::Local(anyhow::anyhow!(e)))?;
            println!("{json}");
        }
        Format::Human => render_tabs_table(&reply.tabs),
    }
    Ok(())
}

fn render_tabs_table(tabs: &[TabInfo]) {
    if tabs.is_empty() {
        println!("(no tabs)");
        return;
    }
    let rows: Vec<[String; 5]> = tabs
        .iter()
        .map(|t| {
            [
                t.tab_id.to_string(),
                t.scope.map(scope_label).unwrap_or("-").to_string(),
                t.window_id
                    .map(|w| w.to_string())
                    .unwrap_or_else(|| "-".into()),
                truncate(t.title.as_deref().unwrap_or("-"), 40),
                t.url.clone().unwrap_or_else(|| "-".into()),
            ]
        })
        .collect();
    let headers = ["TAB", "SCOPE", "WIN", "TITLE", "URL"];
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

fn scope_label(scope: TabScope) -> &'static str {
    match scope {
        TabScope::User => "user",
        TabScope::Agent => "agent",
        TabScope::All => "all",
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn call(sock: PathBuf, params: TabListParams) -> Result<TabListResult, CliError> {
    crate::cli::business_rpc::call::<TabListParams, TabListResult>(
        sock,
        "tab-list",
        Method::ToolTabList,
        Some(params),
        TOOL_IPC_TIMEOUT,
    )
}
