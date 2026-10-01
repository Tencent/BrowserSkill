//! Keep console output readable when the text is not ASCII.
//!
//! `bsk` prints UTF-8 on every platform. A Windows console, however, starts
//! on an OEM code page — 936/GBK on a Simplified Chinese system — and
//! reinterprets those bytes, so the non-ASCII text a page contributes
//! (snapshot names, element labels, error hints) reaches the user as
//! mojibake: `微众银行` renders as `寰紬閾惰`. Pointing the console at UTF-8
//! for the lifetime of the process fixes the rendering, and the previous
//! code page is restored on drop so the user's shell is left as found.

/// Code page identifier for UTF-8.
#[cfg(windows)]
const UTF8_CODE_PAGE: u32 = 65001;

/// Switches the attached Windows console to UTF-8 output for its lifetime.
///
/// Holds the previous code page and restores it when dropped, so the guard
/// must outlive every write. A no-op on non-Windows hosts, when no console is
/// attached, and when the console already uses UTF-8. Redirected streams are
/// never touched: those receive the raw bytes verbatim, with no code page in
/// the path.
#[must_use = "the console reverts to its previous code page when the guard drops"]
pub struct Utf8Console {
    #[cfg(windows)]
    restore: Option<u32>,
}

impl Utf8Console {
    /// Enable UTF-8 console output when a console is attached and not UTF-8.
    pub fn enable() -> Self {
        #[cfg(windows)]
        {
            // SAFETY: no pointer arguments; a missing console is reported as
            // code page 0, which `restore_code_page` rejects.
            let current = unsafe { GetConsoleOutputCP() };
            let mut restore = None;
            if let Some(code_page) = restore_code_page(console_attached(), current) {
                // SAFETY: plain code page id; no pointers.
                if unsafe { SetConsoleOutputCP(UTF8_CODE_PAGE) } != 0 {
                    restore = Some(code_page);
                }
            }
            Self { restore }
        }
        #[cfg(not(windows))]
        {
            Self {}
        }
    }
}

#[cfg(windows)]
impl Drop for Utf8Console {
    fn drop(&mut self) {
        if let Some(code_page) = self.restore {
            // SAFETY: plain code page id; no pointers.
            unsafe {
                SetConsoleOutputCP(code_page);
            }
        }
    }
}

/// The code page to restore afterwards, or `None` when nothing must change.
///
/// Split out from [`Utf8Console::enable`] so the decision can be tested
/// without an attached console.
#[cfg(windows)]
fn restore_code_page(attached: bool, current: u32) -> Option<u32> {
    if !attached || current == 0 || current == UTF8_CODE_PAGE {
        return None;
    }
    Some(current)
}

/// Whether the process owns a console on either output stream.
///
/// `stderr` counts because diagnostics and the update hint go there, and a
/// single console serves both streams.
#[cfg(windows)]
fn console_attached() -> bool {
    std::io::stdout().is_terminal() || std::io::stderr().is_terminal()
}

#[cfg(windows)]
use std::io::IsTerminal;
#[cfg(windows)]
use windows_sys::Win32::System::Console::{GetConsoleOutputCP, SetConsoleOutputCP};

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn redirected_output_is_left_alone() {
        assert_eq!(restore_code_page(false, 936), None);
    }

    #[test]
    fn a_utf8_console_is_left_alone() {
        assert_eq!(restore_code_page(true, UTF8_CODE_PAGE), None);
    }

    #[test]
    fn a_missing_console_is_left_alone() {
        assert_eq!(restore_code_page(true, 0), None);
    }

    #[test]
    fn an_oem_code_page_is_remembered_for_restore() {
        assert_eq!(restore_code_page(true, 936), Some(936));
        assert_eq!(restore_code_page(true, 437), Some(437));
    }

    #[test]
    fn the_guard_is_inert_under_a_redirected_harness() {
        // `cargo test` captures both streams, so no console is attached and
        // enabling the guard must not touch global console state.
        let guard = Utf8Console::enable();
        assert!(guard.restore.is_none());
    }
}
