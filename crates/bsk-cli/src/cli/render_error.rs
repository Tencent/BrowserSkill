//! Single source of truth for the human-readable summary, repair
//! hint, and exit code attached to every [`ErrorCode`] variant.
//!
//! Keeping the table in one place means:
//!   * the renderer in [`super::error::render`] never invents
//!     ad-hoc copy or exit codes,
//!   * `bsk-cli` subcommands that surface their own bespoke
//!     `eprintln!("error: ...")` lines are obvious anomalies during
//!     review, and
//!   * the M10.3 unit tests can lock in `ErrorCode → exit_code` so a
//!     silent regression bumps a test failure rather than escaping
//!     into shell scripts that depend on the documented contract.
//!
//! Exit code mapping follows design §3.1:
//!   * `0` — success (never produced by this module),
//!   * `1` — user error (parameters / sandbox / missing entity),
//!   * `2` — protocol or transport error (incl. `cancelled`),
//!   * `3` — browser / CDP failure,
//!   * `4` — timeout,
//!   * `5` — version mismatch.
//!
//! Strings are in English: the CLI is consumed by agents and other
//! automated tooling, so all user-facing copy uses English. Command
//! names, flags, field names, and `ErrorCode` literal values are
//! also English so the wire / CLI contract stays unambiguous. There
//! is no i18n framework wired up yet; if we ever introduce one, the
//! `summary` and `hint` strings here are the obvious extraction
//! candidates (one key per `ErrorCode` variant).
//!
//! `cancelled` is intentionally not in the design's enumerated table
//! but currently lands on `2` to keep parity with M3.5 behaviour and
//! the existing exit-code unit test. Tests that want to discriminate
//! cancellation should match on `ErrorCode::Cancelled` directly.

use bsk_protocol::ErrorCode;

/// Stable `RpcError.data.reason` values emitted by the extension for
/// finer-grained CLI rendering. Kept as string literals on the wire so
/// older peers can ignore unknown reasons and fall back to code-based copy.
pub mod reason {
    pub const AGENT_WINDOW_SCOPE: &str = "agent_window_scope";
    pub const ELEMENT_NOT_VISIBLE: &str = "element_not_visible";
    pub const REF_NOT_FOUND: &str = "ref_not_found";
    pub const SELECTOR_NOT_FOUND: &str = "selector_not_found";
    pub const TARGET_NOT_FILLABLE: &str = "target_not_fillable";
    pub const TARGET_NOT_SELECT: &str = "target_not_select";
    pub const OPTION_NOT_FOUND: &str = "option_not_found";
    pub const SINGLE_SELECT_VALUE_COUNT: &str = "single_select_value_count";
    pub const TAB_NOT_ACTIVE: &str = "tab_not_active";
    pub const BORROW_CONFLICT: &str = "borrow_conflict";
    pub const SESSION_BUSY: &str = crate::rpc_reason::SESSION_BUSY;
}

/// Per-code rendering metadata. The `summary` is what the CLI prints
/// after the leading `error: ` token; the `hint` (when present) is
/// what we print on the next line as `hint: ...`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderInfo {
    pub summary: &'static str,
    pub hint: Option<&'static str>,
    pub exit_code: u8,
}

/// Look up the rendering info for a given error code.
pub fn info_for(code: ErrorCode) -> RenderInfo {
    match code {
        ErrorCode::UnknownMethod => RenderInfo {
            summary: "daemon does not recognise this RPC method",
            hint: Some(
                "upgrade both bsk CLI and the browser-skill extension; CLI and daemon may be on mismatched protocol versions",
            ),
            // Design §3.1 maps version / protocol incompatibility to
            // exit 5 and the design notes call out `unknown_method`
            // as the canonical "method-shape mismatch" path (review
            // I4: was previously 1 which is reserved for user-input
            // errors).
            exit_code: 5,
        },
        ErrorCode::Unsupported => RenderInfo {
            summary: "this operation is not supported by the current build",
            hint: Some(
                "check `bsk --version` and the bsk changelog to confirm whether the feature is available",
            ),
            exit_code: 1,
        },
        ErrorCode::InvalidParams => RenderInfo {
            summary: "invalid command parameters",
            hint: Some(
                "check your command arguments; run `bsk <cmd> --help` to see the expected format",
            ),
            exit_code: 1,
        },
        ErrorCode::NotFound => RenderInfo {
            summary: "requested resource does not exist",
            hint: Some(
                "the session, tab, or browser may have stopped; run `bsk session list` / `bsk browsers` to see current state",
            ),
            exit_code: 1,
        },
        ErrorCode::PermissionDenied => RenderInfo {
            summary: "operation denied by the Agent Window sandbox",
            hint: Some(
                "tabs outside an Agent Window must first be borrowed via `bsk tab borrow <tab-id> --session <id>`",
            ),
            exit_code: 1,
        },
        ErrorCode::Timeout => RenderInfo {
            summary: "operation timed out",
            hint: Some(
                "retry the command; if timeouts persist, check `bsk logs` and confirm the browser is still responding",
            ),
            exit_code: 4,
        },
        ErrorCode::CdpFailed => RenderInfo {
            summary: "browser rejected the underlying CDP call",
            hint: Some(
                "confirm the tab is still in a loaded state and retry; reloading the tab usually resets a stuck DevTools session",
            ),
            exit_code: 3,
        },
        ErrorCode::ProtocolError => RenderInfo {
            summary: "protocol error communicating with bsk daemon",
            hint: Some(
                "ensure CLI and daemon protocol versions match — check `protocol version` in `bsk status`",
            ),
            exit_code: 2,
        },
        ErrorCode::Cancelled => RenderInfo {
            summary: "operation cancelled",
            hint: Some(
                "the previous command was interrupted (Ctrl-C or a remote `cancel` request)",
            ),
            exit_code: 2,
        },
        ErrorCode::UserAborted => RenderInfo {
            summary: "operation interrupted by user",
            hint: Some(
                "the user requested an interrupt (e.g. via the agent window's stop button); rerun if this was unintended",
            ),
            exit_code: 2,
        },
        ErrorCode::VersionTooOld => RenderInfo {
            summary: "peer version is too old to communicate with this build",
            hint: Some(
                "upgrade both bsk CLI and the browser-skill extension so both sides satisfy `min_compatible_protocol`",
            ),
            exit_code: 5,
        },
        ErrorCode::MultipleBrowsersOnline => RenderInfo {
            summary: "multiple browsers are online",
            hint: Some(
                "use `--browser <instance_id-or-label>` to target a specific browser (run `bsk browsers` to list online browsers)",
            ),
            exit_code: 1,
        },
        ErrorCode::NoBrowserConnected => RenderInfo {
            summary: "no browser is connected to the daemon",
            hint: Some(
                "if your browser is open, check that the browser-skill extension is installed and enabled and wait for the popup to show \"connected\"; if it is not installed, add it from the Chrome Web Store (or your browser's extension store) and open it once",
            ),
            exit_code: 1,
        },
    }
}

/// Convenience accessor used by [`super::error::render`] when it
/// needs only the exit code.
pub fn exit_code_for(code: ErrorCode) -> u8 {
    info_for(code).exit_code
}

/// Convenience accessor used by [`super::error::render`] when it
/// needs only the hint.
pub fn hint_for_code(code: ErrorCode) -> Option<&'static str> {
    info_for(code).hint
}

/// Convenience accessor for the human summary; useful when the CLI
/// wants a friendly first line independent of the daemon's
/// machine-oriented message.
pub fn summary_for(code: ErrorCode) -> &'static str {
    info_for(code).summary
}

/// Extract `data.reason` when present and a non-empty string.
pub fn reason_for_data(data: Option<&serde_json::Value>) -> Option<&str> {
    data?.get("reason")?.as_str().filter(|s| !s.is_empty())
}

/// Look up rendering info using `(code, data.reason)` when a reason-
/// specific override exists; otherwise fall back to [`info_for`].
pub fn info_for_error(code: ErrorCode, data: Option<&serde_json::Value>) -> RenderInfo {
    let base = info_for(code);
    let Some(reason) = reason_for_data(data) else {
        return base;
    };
    match (code, reason) {
        (ErrorCode::PermissionDenied, reason::ELEMENT_NOT_VISIBLE) => RenderInfo {
            summary: "target element has no visible geometry",
            hint: Some(
                "rerun snapshot and choose a visible child ref, or wait/scroll/reload before retrying",
            ),
            exit_code: base.exit_code,
        },
        (ErrorCode::PermissionDenied, reason::BORROW_CONFLICT) => RenderInfo {
            summary: "tab is borrowed by another session",
            hint: Some(
                "return the tab from the borrowing session via `bsk tab return <tab-id> --session <id>` or stop that session",
            ),
            exit_code: base.exit_code,
        },
        (ErrorCode::NotFound, reason::REF_NOT_FOUND) => RenderInfo {
            summary: "snapshot ref was not found for this tab",
            hint: Some("rerun `bsk snapshot` for the current tab and use one of the returned refs"),
            exit_code: base.exit_code,
        },
        (ErrorCode::NotFound, reason::SELECTOR_NOT_FOUND) => RenderInfo {
            summary: "selector did not match any element",
            hint: Some("verify the CSS selector or wait for the element to appear before retrying"),
            exit_code: base.exit_code,
        },
        (ErrorCode::InvalidParams, reason::TARGET_NOT_FILLABLE) => RenderInfo {
            summary: "target element is not fillable",
            hint: Some(
                "choose an input, textarea, or contenteditable element from the latest snapshot",
            ),
            exit_code: base.exit_code,
        },
        (ErrorCode::InvalidParams, reason::TARGET_NOT_SELECT) => RenderInfo {
            summary: "target element is not a <select>",
            hint: Some(
                "choose a native <select> ref or selector from the latest snapshot, or use `bsk click` / `bsk fill` for other controls",
            ),
            exit_code: base.exit_code,
        },
        (ErrorCode::InvalidParams, reason::OPTION_NOT_FOUND) => RenderInfo {
            summary: "option value not found in <select>",
            hint: Some(
                "rerun `bsk snapshot` or `bsk get-html` to list valid option values, then pass them via `--value`",
            ),
            exit_code: base.exit_code,
        },
        (ErrorCode::InvalidParams, reason::SINGLE_SELECT_VALUE_COUNT) => RenderInfo {
            summary: "single-select requires exactly one option value",
            hint: Some(
                "pass exactly one `--value` for a regular <select>; repeat `--value` only for <select multiple>",
            ),
            exit_code: base.exit_code,
        },
        (ErrorCode::InvalidParams, reason::TAB_NOT_ACTIVE) => RenderInfo {
            summary: "screenshot requires the visible active tab",
            hint: Some(
                "select the tab with `bsk tab select <tab-id> --session <id>` or omit `--tab-id` to capture the Agent Window's active tab",
            ),
            exit_code: base.exit_code,
        },
        (ErrorCode::Timeout, reason::SESSION_BUSY) => RenderInfo {
            summary: "previous session command is still running",
            hint: Some(
                "wait for the current command to finish, cancel it with Ctrl-C, or stop/restart the session",
            ),
            exit_code: base.exit_code,
        },
        _ => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lock the exit-code mapping for every `ErrorCode` variant so a
    /// silent regression flips a test instead of escaping into shell
    /// scripts that depend on the documented values.
    #[test]
    fn exit_codes_match_design_table() {
        // Design §3.1 — exit-code buckets:
        //   1 user error (parameters / sandbox / missing entity)
        //   2 protocol error (daemon ↔ extension transport)
        //   3 browser / CDP failure
        //   4 timeout
        //   5 version incompatibility
        assert_eq!(exit_code_for(ErrorCode::InvalidParams), 1);
        assert_eq!(exit_code_for(ErrorCode::NotFound), 1);
        assert_eq!(exit_code_for(ErrorCode::PermissionDenied), 1);
        assert_eq!(exit_code_for(ErrorCode::NoBrowserConnected), 1);
        assert_eq!(exit_code_for(ErrorCode::MultipleBrowsersOnline), 1);
        assert_eq!(exit_code_for(ErrorCode::Unsupported), 1);

        assert_eq!(exit_code_for(ErrorCode::ProtocolError), 2);
        assert_eq!(exit_code_for(ErrorCode::Cancelled), 2);
        assert_eq!(exit_code_for(ErrorCode::UserAborted), 2);

        assert_eq!(exit_code_for(ErrorCode::CdpFailed), 3);
        assert_eq!(exit_code_for(ErrorCode::Timeout), 4);
        // Review I4: `unknown_method` joins `version_too_old` in the
        // version-incompatibility bucket. The error code is the
        // canonical "method shape mismatch" symptom of a CLI/daemon
        // version drift, so it must NOT be filed under generic user
        // errors (exit 1).
        assert_eq!(exit_code_for(ErrorCode::UnknownMethod), 5);
        assert_eq!(exit_code_for(ErrorCode::VersionTooOld), 5);
    }

    /// Every code must carry a non-empty summary; an empty `summary`
    /// would render `error: ` with nothing after it.
    #[test]
    fn every_code_has_a_summary() {
        for code in EVERY_CODE {
            let info = info_for(*code);
            assert!(
                !info.summary.is_empty(),
                "summary missing for {code:?}: {info:?}"
            );
        }
    }

    /// Every code should at least *try* to provide a hint; a missing
    /// hint is allowed but at the time of writing every variant has
    /// one. This guards against accidental drift where a new variant
    /// lands without thinking about UX.
    #[test]
    fn every_code_has_a_hint_today() {
        for code in EVERY_CODE {
            let info = info_for(*code);
            assert!(info.hint.is_some(), "hint missing for {code:?}");
        }
    }

    /// Exhaustive list used by the table-driven assertions above. Kept
    /// here (rather than in bsk-protocol) so a test failure shows up
    /// next to the rendering data the test is guarding.
    const EVERY_CODE: &[ErrorCode] = &[
        ErrorCode::UnknownMethod,
        ErrorCode::Unsupported,
        ErrorCode::InvalidParams,
        ErrorCode::NotFound,
        ErrorCode::PermissionDenied,
        ErrorCode::Timeout,
        ErrorCode::CdpFailed,
        ErrorCode::ProtocolError,
        ErrorCode::Cancelled,
        ErrorCode::UserAborted,
        ErrorCode::VersionTooOld,
        ErrorCode::MultipleBrowsersOnline,
        ErrorCode::NoBrowserConnected,
    ];

    #[test]
    fn element_not_visible_overrides_permission_denied_copy() {
        let data = serde_json::json!({ "reason": reason::ELEMENT_NOT_VISIBLE });
        let info = info_for_error(ErrorCode::PermissionDenied, Some(&data));
        assert_eq!(info.summary, "target element has no visible geometry");
        assert!(
            info.hint.unwrap().contains("rerun snapshot"),
            "expected geometry-specific hint"
        );
        assert!(!info.summary.contains("sandbox"));
    }

    #[test]
    fn session_busy_overrides_timeout_copy() {
        let data = serde_json::json!({ "reason": reason::SESSION_BUSY });
        let info = info_for_error(ErrorCode::Timeout, Some(&data));
        assert_eq!(info.summary, "previous session command is still running");
        assert!(
            info.hint.unwrap().contains("wait for the current command"),
            "expected session-busy-specific hint"
        );
        assert_eq!(info.exit_code, 4);
    }

    #[test]
    fn ref_not_found_overrides_not_found_copy() {
        let data = serde_json::json!({ "reason": reason::REF_NOT_FOUND });
        let info = info_for_error(ErrorCode::NotFound, Some(&data));
        assert_eq!(info.summary, "snapshot ref was not found for this tab");
        assert!(info.hint.unwrap().contains("bsk snapshot"));
    }

    #[test]
    fn target_not_select_overrides_invalid_params_copy() {
        let data = serde_json::json!({ "reason": reason::TARGET_NOT_SELECT });
        let info = info_for_error(ErrorCode::InvalidParams, Some(&data));
        assert_eq!(info.summary, "target element is not a <select>");
        assert!(info.hint.unwrap().contains("native <select>"));
    }

    #[test]
    fn option_not_found_overrides_invalid_params_copy() {
        let data = serde_json::json!({ "reason": reason::OPTION_NOT_FOUND });
        let info = info_for_error(ErrorCode::InvalidParams, Some(&data));
        assert_eq!(info.summary, "option value not found in <select>");
        assert!(info.hint.unwrap().contains("--value"));
    }

    #[test]
    fn single_select_value_count_overrides_invalid_params_copy() {
        let data = serde_json::json!({ "reason": reason::SINGLE_SELECT_VALUE_COUNT });
        let info = info_for_error(ErrorCode::InvalidParams, Some(&data));
        assert_eq!(
            info.summary,
            "single-select requires exactly one option value"
        );
        assert!(info.hint.unwrap().contains("exactly one"));
    }
}
