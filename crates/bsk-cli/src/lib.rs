//! `bsk` CLI internals shared with binary and integration tests.

pub mod cli;
pub mod daemon;
pub mod ipc_client;
pub mod rpc_reason {
    pub const SESSION_BUSY: &str = "session_busy";
    /// Stable `RpcError.data.reason` values the daemon attaches when a
    /// dispatch hits a session id that already ended, so the CLI can
    /// render why it vanished instead of a generic not-found.
    pub const SESSION_IDLE_TIMEOUT: &str = "session_idle_timeout";
    pub const SESSION_WINDOW_CLOSED: &str = "session_window_closed";
    pub const SESSION_USER_MOVED_TAB: &str = "user_moved_tab";
    pub const BROWSER_DISCONNECTED: &str = "browser_disconnected";
    /// Extension-side: repeated observation identity failures on the
    /// same tab in a short window — the site reloads itself when the
    /// debugger attaches (anti-debugging), see issues #454 / #465.
    pub const OBSERVE_IDENTITY_RELOAD_LOOP: &str = "observe_identity_reload_loop";
    /// Extension-side: borrow target already lives in an Agent Window.
    pub const BORROW_AGENT_WINDOW_TAB: &str = "borrow_agent_window_tab";
}
pub mod skill_install;

#[cfg(windows)]
mod windows_process;

pub use cli::{Cli, Command};
