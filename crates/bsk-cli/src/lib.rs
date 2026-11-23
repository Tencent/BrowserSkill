//! `bsk` CLI internals shared with binary and integration tests.

pub mod cli;
pub mod daemon;
pub mod ipc_client;
pub mod skill_install;

#[cfg(windows)]
mod windows_process;

pub use cli::{Cli, Command};
