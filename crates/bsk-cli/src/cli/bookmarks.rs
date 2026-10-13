//! `bsk bookmarks`: read or edit the selected local profile's bookmarks.

use std::time::Duration;

use anyhow::Context;
use bsk_protocol::Method;
use bsk_protocol::tools::{BookmarksParams, BookmarksResult};
use clap::{Args, Subcommand};

use crate::cli::ensure_daemon::ensure_daemon;
use crate::cli::error::{CliError, Format};

#[derive(Debug, Args)]
pub struct BookmarksArgs {
    #[arg(long)]
    pub session: String,
    #[command(subcommand)]
    pub command: BookmarksCommand,
}

#[derive(Debug, Subcommand)]
pub enum BookmarksCommand {
    /// Read the complete bookmark tree, including folder and bookmark metadata.
    Tree,
    /// Move an existing bookmark or folder. Chrome preserves its ID.
    Move {
        id: String,
        #[arg(long)]
        parent: String,
        #[arg(long)]
        index: Option<u32>,
    },
    /// Create a folder. This command cannot create a URL bookmark.
    CreateFolder {
        title: String,
        #[arg(long)]
        parent: String,
        #[arg(long)]
        index: Option<u32>,
    },
    /// Remove an empty folder. Refuse URL bookmarks and nonempty folders.
    RemoveEmptyFolder { id: String },
}

pub fn dispatch(args: BookmarksArgs, _format: Format) -> Result<(), CliError> {
    let mut params = BookmarksParams {
        session_id: args.session,
        id: None,
        parent_id: None,
        index: None,
        title: None,
    };
    let method = match args.command {
        BookmarksCommand::Tree => Method::ToolBookmarksTree,
        BookmarksCommand::Move { id, parent, index } => {
            params.id = Some(id);
            params.parent_id = Some(parent);
            params.index = index;
            Method::ToolBookmarksMove
        }
        BookmarksCommand::CreateFolder {
            title,
            parent,
            index,
        } => {
            params.title = Some(title);
            params.parent_id = Some(parent);
            params.index = index;
            Method::ToolBookmarksCreateFolder
        }
        BookmarksCommand::RemoveEmptyFolder { id } => {
            params.id = Some(id);
            Method::ToolBookmarksRemoveEmptyFolder
        }
    };
    let info = ensure_daemon().context("ensure daemon is running")?;
    let reply: BookmarksResult = crate::cli::business_rpc::call(
        info.sock_path,
        "bookmarks-1",
        method,
        Some(params),
        Duration::from_secs(35),
    )?;
    // The same JSON is readable in a terminal and usable as a backup.
    println!(
        "{}",
        serde_json::to_string_pretty(&reply).map_err(|e| CliError::Local(e.into()))?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Command};
    use clap::Parser;

    #[test]
    fn cli_requires_session_and_accepts_literal_folder_titles() {
        assert!(Cli::try_parse_from(["bsk", "bookmarks", "tree"]).is_err());
        assert!(
            Cli::try_parse_from([
                "bsk",
                "bookmarks",
                "--session",
                "s",
                "move",
                "2",
                "--parent",
                "1",
                "--index",
                "-1",
            ])
            .is_err()
        );
        let cli = Cli::try_parse_from([
            "bsk",
            "bookmarks",
            "--session",
            "s",
            "create-folder",
            "--parent",
            "1",
            "--",
            "--help",
        ])
        .unwrap();
        let Command::Bookmarks(args) = cli.command else {
            panic!("wrong command")
        };
        let BookmarksCommand::CreateFolder { title, parent, .. } = args.command else {
            panic!("wrong operation")
        };
        assert_eq!(
            (args.session.as_str(), title.as_str(), parent.as_str()),
            ("s", "--help", "1")
        );
        assert!(!Method::ToolBookmarksTree.requires_interrupt_gate());
        for method in [
            Method::ToolBookmarksMove,
            Method::ToolBookmarksCreateFolder,
            Method::ToolBookmarksRemoveEmptyFolder,
        ] {
            assert!(method.requires_interrupt_gate());
            assert!(method.is_mutating());
        }
    }
}
