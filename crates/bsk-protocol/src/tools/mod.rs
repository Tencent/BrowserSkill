//! Typed params/results for the `tool.*` RPC methods (§7).

pub mod console;
pub mod dialog;
pub mod emulate;
pub mod human_loop;
pub mod interaction;
pub mod navigation;
pub mod network;
pub mod observation;
pub mod record;
mod record_common;
mod record_v2;
mod record_v3;
pub mod script;
pub mod session;
pub mod tabs;
pub mod waits;
pub mod wheel;
pub mod window;

pub use console::*;
pub use dialog::*;
pub use emulate::*;
pub use human_loop::*;
pub use interaction::*;
pub use navigation::*;
pub use network::*;
pub use observation::*;
pub use record::*;
pub use script::*;
pub use session::*;
pub use tabs::*;
pub use waits::*;
pub use wheel::*;
pub use window::*;
