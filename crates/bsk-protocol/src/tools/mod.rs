//! Typed params/results for the 21 `tool.*` RPC methods (§7).

pub mod console;
pub mod dialog;
pub mod human_loop;
pub mod interaction;
pub mod navigation;
pub mod observation;
pub mod script;
pub mod session;
pub mod tabs;
pub mod waits;

pub use console::*;
pub use dialog::*;
pub use human_loop::*;
pub use interaction::*;
pub use navigation::*;
pub use observation::*;
pub use script::*;
pub use session::*;
pub use tabs::*;
pub use waits::*;
