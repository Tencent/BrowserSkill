//! `bsk` CLI internals shared with binary and integration tests.

pub mod cli;
pub mod daemon;
pub mod ipc_client;
pub mod rpc_reason {
    pub const SESSION_BUSY: &str = "session_busy";
}
pub mod skill_install;

pub use cli::{Cli, Command};
