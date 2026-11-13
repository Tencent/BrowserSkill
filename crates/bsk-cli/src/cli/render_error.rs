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
//!   * `5` — version mismatch,
//!   * `6` — pending dialog; decide explicitly, then retrieve the original result.
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

use bsk_protocol::{ErrorCode, RpcErrorReason};

/// Per-code rendering metadata. The `summary` is what the CLI prints
/// after the leading `error: ` token; `hint` is the CLI-facing recovery
/// hint and `mcp_hint` (when present) overrides it for MCP responses so
/// MCP clients receive MCP-native tool names instead of CLI flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderInfo {
    pub summary: &'static str,
    pub hint: Option<&'static str>,
    pub mcp_hint: Option<&'static str>,
    pub exit_code: u8,
}

const fn info(
    summary: &'static str,
    hint: Option<&'static str>,
    mcp_hint: Option<&'static str>,
    exit_code: u8,
) -> RenderInfo {
    RenderInfo {
        summary,
        hint,
        mcp_hint,
        exit_code,
    }
}

/// Look up the rendering info for a given error code.
pub fn info_for(code: ErrorCode) -> RenderInfo {
    match code {
        ErrorCode::DialogPending => info(
            "operation is waiting for an agent dialog decision",
            Some(
                "inspect `bsk dialog status --session <id> --json`; decide with dialog accept/dismiss, then retrieve the ORIGINAL result with `bsk operation await <operation-id> --session <id> --json`. Do not repeat the original action.",
            ),
            Some(
                "call bsk_assist(action='dialog_status', session_id=...), decide with dialog_accept or dialog_dismiss, then retrieve the ORIGINAL result with bsk_assist(action='operation_await', operation_id=..., session_id=...). Do not repeat the original action.",
            ),
            6,
        ),
        ErrorCode::PairingRequired => info(
            "local browser pairing is required",
            Some(
                "run `bsk daemon pair`, then paste the link into the extension's connection settings",
            ),
            Some(
                "local browser pairing is required; ask the user to run `bsk daemon pair` in a terminal and paste the pairing link into the extension's connection settings",
            ),
            1,
        ),
        ErrorCode::UnknownMethod => info(
            "daemon does not recognise this RPC method",
            Some(
                "upgrade both bsk CLI and the browser-skill extension; CLI and daemon may be on mismatched protocol versions",
            ),
            Some(
                "check bsk_session(action='status'); daemon and extension protocol versions may be out of sync — ask the user to update both to protocol 2.0",
            ),
            // Design §3.1 maps version / protocol incompatibility to
            // exit 5 and the design notes call out `unknown_method`
            // as the canonical "method-shape mismatch" path (review
            // I4: was previously 1 which is reserved for user-input
            // errors).
            5,
        ),
        ErrorCode::Unsupported => info(
            "this operation is not supported by the current build",
            Some(
                "check `bsk --version` and the bsk changelog to confirm whether the feature is available",
            ),
            Some(
                "call bsk_session(action='status') to confirm supported capabilities on this build",
            ),
            1,
        ),
        ErrorCode::InvalidParams => info(
            "invalid command parameters",
            Some("check your command arguments; run `bsk <cmd> --help` to see the expected format"),
            Some("check the MCP tool arguments against its input schema before retrying"),
            1,
        ),
        ErrorCode::NotFound => info(
            "requested resource does not exist",
            Some(
                "the session, tab, or browser may have stopped; run `bsk session list` / `bsk browsers` to see current state",
            ),
            Some(
                "the session, tab, or browser may have stopped; call bsk_session(action='list') or bsk_session(action='status') to see current state",
            ),
            1,
        ),
        ErrorCode::PermissionDenied => info(
            "operation denied by the Agent Window sandbox",
            Some(
                "tabs outside an Agent Window must first be borrowed via `bsk tab borrow <tab-id> --session <id>`",
            ),
            Some(
                "tabs outside an Agent Window must first be borrowed via bsk_tabs(action='borrow', tab_id=..., session_id=...)",
            ),
            1,
        ),
        ErrorCode::Timeout => info(
            "operation timed out",
            Some(
                "inspect the application result and synchronize before choosing another action; do not replay an action whose effect is unknown",
            ),
            Some(
                "inspect the application result and call bsk_session(action='sync') before choosing another action; do not replay an action whose effect is unknown",
            ),
            4,
        ),
        ErrorCode::CdpFailed => info(
            "browser rejected the underlying CDP call",
            Some(
                "confirm the tab is still in a loaded state and retry; reloading the tab usually resets a stuck DevTools session",
            ),
            Some(
                "confirm the tab is still in a loaded state; calling bsk_page(action='reload') usually resets a stuck DevTools session",
            ),
            3,
        ),
        ErrorCode::ProtocolError => info(
            "protocol error communicating with bsk daemon",
            Some(
                "ensure CLI and daemon protocol versions match — check `protocol version` in `bsk status`",
            ),
            Some(
                "ensure MCP server and daemon protocol versions match — check bsk_session(action='status')",
            ),
            2,
        ),
        ErrorCode::Cancelled => info(
            "operation cancelled",
            Some("the previous command was interrupted (Ctrl-C or a remote `cancel` request)"),
            None,
            2,
        ),
        ErrorCode::UserAborted => info(
            "operation interrupted by user",
            Some(
                "the user requested an interrupt (e.g. via the agent window's stop button); rerun if this was unintended",
            ),
            None,
            2,
        ),
        ErrorCode::VersionTooOld => info(
            "peer version is too old to communicate with this build",
            Some(
                "upgrade both bsk CLI and the browser-skill extension so both sides satisfy `min_compatible_protocol`",
            ),
            Some(
                "ask the user to upgrade both bsk CLI/daemon and the BrowserSkill extension to protocol 2.0",
            ),
            5,
        ),
        ErrorCode::MultipleBrowsersOnline => info(
            "multiple browsers are online",
            Some(
                "use `--browser <instance_id-or-label>` to target a specific browser (run `bsk browsers` to list online browsers)",
            ),
            Some(
                "pass browser=<instance_id-or-label> on bsk_session(action='open'|'start') after listing online browsers via bsk_session(action='status')",
            ),
            1,
        ),
        ErrorCode::NoBrowserConnected => info(
            "no browser is connected to the daemon",
            Some(
                "open the browser-skill extension in your browser and wait for the popup to show \"connected\"",
            ),
            None,
            1,
        ),
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
    let Some(raw_reason) = reason_for_data(data) else {
        return base;
    };
    let Some(reason) = RpcErrorReason::from_wire(raw_reason) else {
        return base;
    };
    let detail = data
        .and_then(|d| d.get("component"))
        .and_then(|value| value.as_str());
    match (code, reason) {
        (ErrorCode::Unsupported, RpcErrorReason::UnsupportedFeature) => info(
            "a connected component does not support the requested feature",
            match detail {
                Some("daemon") => Some(
                    "upgrade the bsk CLI/daemon binary to protocol 2.0+ and restart the daemon",
                ),
                Some("extension") => Some("upgrade the BrowserSkill extension to protocol 2.0+"),
                _ => Some(
                    "run `bsk status --json` and upgrade both CLI/daemon and extension to protocol 2.0+",
                ),
            },
            match detail {
                Some("daemon") => {
                    Some("ask the user to upgrade bsk CLI/daemon to protocol 2.0+ and restart it")
                }
                Some("extension") => {
                    Some("ask the user to upgrade the BrowserSkill extension to protocol 2.0+")
                }
                _ => Some(
                    "call bsk_session(action='status') and ask the user to upgrade both bsk CLI/daemon and extension to protocol 2.0+",
                ),
            },
            base.exit_code,
        ),
        (ErrorCode::NoBrowserConnected, RpcErrorReason::LocalPairingRequired)
        | (_, RpcErrorReason::LocalPairingRequired) => info(
            "the extension needs local pairing",
            Some(
                "run `bsk daemon pair`, then paste the link into the extension's connection settings",
            ),
            Some(
                "local browser pairing is required; ask the user to run `bsk daemon pair` in a terminal and paste the pairing link into the extension's connection settings",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::UserDenied) => info(
            "the user denied the tab borrow",
            Some("do not repeat the same authorization request"),
            None,
            base.exit_code,
        ),
        (_, RpcErrorReason::ConfirmationTimeout) => info(
            "timed out waiting for human confirmation",
            Some(
                "report the blocked step; do not automatically repeat the request or switch browser tools",
            ),
            None,
            base.exit_code,
        ),
        (_, RpcErrorReason::ConfirmationUiUnavailable) => info(
            "the browser could not display a confirmation request",
            Some(
                "report the unavailable confirmation UI; unattended users can change Automation settings in the extension",
            ),
            None,
            base.exit_code,
        ),
        (_, RpcErrorReason::BorrowInProgress) => info(
            "this tab already has a pending borrow request",
            Some("wait for the existing request; do not issue another borrow"),
            None,
            base.exit_code,
        ),
        (_, RpcErrorReason::BorrowOutcomeUnknown) => info(
            "the final tab borrow state could not be confirmed",
            Some(
                "inspect tab and session state before continuing; do not blindly retry the borrow",
            ),
            Some(
                "call bsk_tabs(action='list') and bsk_session(action='list') before continuing; do not blindly retry the borrow",
            ),
            base.exit_code,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::CdpExtensionAccessDenied) => info(
            "Chrome blocked CDP access to another extension's content in this tab",
            Some(
                "a web page can contain a restricted extension frame; disable the conflicting extension and reload, or use `bsk navigate <url>` to leave this page; reconnecting BrowserSkill alone does not remove the restriction",
            ),
            Some(
                "a web page can contain a restricted extension frame; disable the conflicting extension and reload, or call bsk_page(action='navigate', url=...) to leave this page; reconnecting BrowserSkill alone does not remove the restriction",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::InputNotReady) => info(
            "the browser did not become ready for native input",
            Some(
                "no click, key press or wheel input was sent; observe the page again before retrying",
            ),
            Some(
                "no click, key press or wheel input was sent; call bsk_inspect(action='observe') before retrying",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::InputClockUnavailable) => info(
            "the browser's native input clock could not be calibrated",
            Some(
                "synchronize and inspect the application result before deciding again; do not replay an uncertain submission",
            ),
            Some(
                "call bsk_session(action='sync') and inspect the application result before deciding again; do not replay an uncertain submission",
            ),
            base.exit_code,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::ObserveIdentityReloadLoop) => info(
            "the page kept losing observation identity — the site is likely reloading itself while the debugger is attached (anti-debugging)",
            Some(
                "do not observe again and do not reload this tab; the site rejects the debugger attach itself (see GitHub issues #454 and #465); continue on another page or hand the task back to the user",
            ),
            None,
            base.exit_code,
        ),
        (
            ErrorCode::InvalidParams | ErrorCode::NotFound | ErrorCode::PermissionDenied,
            RpcErrorReason::LocalFileError,
        ) => info(
            "local file validation failed",
            Some("check the local file path and permissions"),
            None,
            1,
        ),
        (ErrorCode::InvalidParams, RpcErrorReason::BorrowAgentWindowTab) => info(
            "the borrow target already lives inside an Agent Window",
            Some(
                "a tab the session did not open needs a user move to a user window first; a tab this session opened is already controlled and needs no borrow",
            ),
            None,
            base.exit_code,
        ),
        (ErrorCode::NotFound, RpcErrorReason::SessionIdleTimeout) => info(
            "the session stopped after its idle timeout",
            Some(
                "start a new session with `bsk session start`; run the daemon with a larger `--session-idle` (default 5m) for longer tasks; the Agent Window and any tab it opened were closed with the session",
            ),
            Some(
                "start a new session with bsk_session(action='open'|'start'); for longer tasks, ask the user to start the daemon with a larger `--session-idle` (default 5m); the Agent Window and any tab it opened were closed with the session",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::UserMovedTab) => info(
            "the session ended because the user moved a controlled tab out of its Agent Window",
            Some(
                "all pages were preserved and browser control ended; this session cannot resume. Ask the user before starting a new session or borrowing a page again",
            ),
            Some(
                "all pages were preserved and browser control ended; this session cannot resume. Ask the user before calling bsk_session(action='open'|'start') or bsk_tabs(action='borrow')",
            ),
            base.exit_code,
        ),
        (ErrorCode::NotFound, RpcErrorReason::SessionWindowClosed) => info(
            "the session ended because the user closed the Agent Window",
            Some(
                "start a new session; closing the Agent Window ends the session, while the window's stop button only cancels the running action",
            ),
            Some(
                "call bsk_session(action='open'|'start') to start a new session; closing the Agent Window ends the session, while the window's stop button only cancels the running action",
            ),
            base.exit_code,
        ),
        (ErrorCode::NotFound, RpcErrorReason::BrowserDisconnected) => info(
            "the browser was disconnected from the daemon",
            Some(
                "wait for the extension to reconnect, then start a new session; the session and its Agent Window are gone",
            ),
            Some(
                "wait for the extension to reconnect, then call bsk_session(action='open'|'start'); the previous session and its Agent Window are gone",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::CooperationSyncRequired) => info(
            "shared page control or observation changed",
            Some(
                "use `bsk cooperate wait --session SID`, then `bsk cooperate sync --session SID`; replan toward the assigned goal and check existing effects before another action",
            ),
            Some(
                "call bsk_assist(action='cooperate_wait', session_id=...), then bsk_session(action='sync', session_id=...); replan toward the assigned goal and check existing effects before another action",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::FrameUnobservable) => info(
            "page interaction coverage is unavailable",
            Some(
                "reload the tab once; if it persists, use read-only commands such as `bsk get-html` or `bsk snapshot`",
            ),
            Some(
                "reload once via bsk_page(action='reload'); if it persists, use read-only bsk_inspect(action='get_html'|'snapshot')",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::PageLoadFailed) => info(
            "the main page failed to load",
            Some("check the page URL and network connection, then reload and synchronize"),
            Some(
                "check the page URL and network connection, then call bsk_page(action='reload') and bsk_session(action='sync')",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::PreconditionFailed) => info(
            "a required business fact no longer matches",
            Some(
                "read the expected and actual values, then reconsider the action; do not silently replace the expected value",
            ),
            None,
            base.exit_code,
        ),
        (_, RpcErrorReason::PreconditionInvalid) => info(
            "the supplied precondition is malformed or unsupported",
            Some("check the `expect` fields and value types before retrying"),
            None,
            base.exit_code,
        ),
        (_, RpcErrorReason::ControlContextInvalid | RpcErrorReason::DocumentChanged) => info(
            "the control context no longer belongs to the current document or control state",
            Some(
                "run `bsk sync` to synchronize this tab and reconsider the action using the current page",
            ),
            Some(
                "call bsk_session(action='sync') to synchronize this tab and reconsider the action using the current page",
            ),
            base.exit_code,
        ),
        (ErrorCode::NotFound, RpcErrorReason::NoActiveSession) => info(
            "no active session is bound to the current caller scope",
            Some(
                "run `bsk open <url>` first to start a session and synchronize, or pass `--session <id>`",
            ),
            Some(
                "call bsk_session(action='open', url=...) first to start a session and synchronize, or pass session_id",
            ),
            base.exit_code,
        ),
        (ErrorCode::InvalidParams, RpcErrorReason::AmbiguousImplicitSession) => info(
            "active sessions exist in other scopes; refusing to hijack implicitly",
            Some(
                "pass `--session <id>` (see `bsk session list`), set `BSK_SCOPE=<name>`, or run `bsk open --scope <name> <url>`",
            ),
            Some(
                "pass session_id (see bsk_session(action='list')), or pass an explicit scope on bsk_session(action='open', scope=...)",
            ),
            base.exit_code,
        ),
        (ErrorCode::NotFound, RpcErrorReason::SessionStopped) => info(
            "the session previously bound to this scope has ended",
            Some("run `bsk open <url>` to start a fresh session in this scope"),
            Some("call bsk_session(action='open', url=...) to start a fresh session in this scope"),
            base.exit_code,
        ),
        (ErrorCode::InvalidParams, RpcErrorReason::ScopeBrowserConflict) => info(
            "the active session in this scope is bound to a different browser profile",
            Some(
                "run `bsk close` first, or pass `--scope <new-scope>` to open another browser profile in parallel",
            ),
            Some(
                "call bsk_session(action='stop') first, or pass a new `scope` on bsk_session(action='open') to open another browser profile in parallel",
            ),
            base.exit_code,
        ),
        (ErrorCode::InvalidParams, RpcErrorReason::ScopeIncognitoConflict) => info(
            "the active session in this scope has a different incognito mode",
            Some(
                "run `bsk close` first, or pass `--scope <new-scope>` to run normal and incognito sessions in parallel",
            ),
            Some(
                "call bsk_session(action='stop') first, or pass a new `scope` on bsk_session(action='open') to run normal and incognito sessions in parallel",
            ),
            base.exit_code,
        ),
        (ErrorCode::PermissionDenied, RpcErrorReason::UncertainPriorEffect) => info(
            "mutating action blocked because a prior action on this tab has an unconfirmed side effect",
            Some(
                "run `bsk sync` to observe the current page state and auto-reconcile, or inspect with `bsk read` / `bsk network` and run `bsk ledger resolve`; do not blindly replay the prior action",
            ),
            Some(
                "call bsk_session(action='sync') on this tab to observe current state and auto-reconcile, or inspect with bsk_inspect(action='read'|'network') and call bsk_ledger(action='resolve'); do not blindly replay the prior action",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::ObservationRequired | RpcErrorReason::ObservationChanged) => info(
            "this action needs an explicit current observation",
            Some(
                "for DOM data use read/extract without syncing again; actual scripts/visual actions require a fresh sync and explicit --observation. Never replay uncertain actions",
            ),
            Some(
                "for DOM data call bsk_inspect(action='read'|'extract') without syncing again; scripts/visual actions require a fresh bsk_session(action='sync') and explicit observation_id. Never replay uncertain actions",
            ),
            base.exit_code,
        ),
        (
            _,
            RpcErrorReason::TargetDetached
            | RpcErrorReason::TargetHidden
            | RpcErrorReason::TargetDisabled
            | RpcErrorReason::TargetReadonly
            | RpcErrorReason::TargetMoved
            | RpcErrorReason::TargetCovered
            | RpcErrorReason::TargetFocusLost,
        ) => info(
            "the selected target is not currently actionable",
            Some(
                "inspect or wait for the target; unrelated page updates do not require a new control context",
            ),
            Some(
                "inspect via bsk_inspect or wait via bsk_page(action='wait_for_element'); unrelated page updates do not require a new control context",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::VirtualRowRecycled) => info(
            "the target row was recycled in place and now belongs to a different record",
            Some(
                "nothing was sent; run `bsk cooperate sync` (or `bsk observe`) to refresh row refs before acting on the intended record",
            ),
            Some(
                "nothing was sent; call bsk_session(action='sync') or bsk_inspect(action='observe') to refresh row refs before acting on the intended record",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::HumanIntervention | RpcErrorReason::ControlHeld) => info(
            "the user has control of this tab",
            Some("wait for control to return, then synchronize before deciding on another action"),
            Some(
                "call bsk_assist(action='cooperate_wait'), then bsk_session(action='sync') before deciding on another action",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::ControlAuthorityRequired) => info(
            "the agent does not currently have control",
            Some(
                "wait for the user to return control, then inspect the current operation or dialog before deciding again; status and cancellation remain available; do not replay the original action",
            ),
            Some(
                "wait for the user to return control via bsk_assist(action='cooperate_wait'), then inspect the current operation or dialog before deciding again; status and cancellation remain available; do not replay the original action",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::InputCleanupFailed) => info(
            "input completed but temporary browser state could not be restored",
            Some("do not repeat the input; observe the page to check its result before continuing"),
            Some(
                "do not repeat the input; call bsk_inspect(action='observe') to check its result before continuing",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::ExtensionUnresponsive) => info(
            "extension is not responding",
            Some(
                "the browser is still connected; wait for it to recover, or reload the extension if commands keep failing",
            ),
            None,
            base.exit_code,
        ),
        (_, RpcErrorReason::ExtensionDisconnected) => info(
            "extension disconnected",
            Some(
                "wait for the extension to reconnect, then start a new session; do not repeat a click, key press, upload, or download that may already have reached the page",
            ),
            Some(
                "wait for the extension to reconnect, then call bsk_session(action='open'|'start'); do not repeat a click, key press, upload, or download that may already have reached the page",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::ExtensionReconnected) => info(
            "extension reconnected",
            Some(
                "start a new session; do not repeat a click, key press, upload, or download that may already have reached the page",
            ),
            Some(
                "call bsk_session(action='open'|'start'); do not repeat a click, key press, upload, or download that may already have reached the page",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::InputOutcomeUnknown) => info(
            "the browser input may already have taken effect",
            Some("do not repeat the input; observe the page to check its result before continuing"),
            Some(
                "do not repeat the input; call bsk_inspect(action='observe') to check its result before continuing",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::InputPaintUnconfirmed) => info(
            "wheel input was sent but paint completion could not be confirmed",
            Some(
                "do not repeat the wheel input; observe the page to check its scroll position before continuing",
            ),
            Some(
                "do not repeat the wheel input; call bsk_inspect(action='observe') to check its scroll position before continuing",
            ),
            base.exit_code,
        ),
        (ErrorCode::Timeout, RpcErrorReason::CancelCleanupTimeout) => info(
            "the browser operation did not finish cancellation in time",
            Some(
                "the operation may already have taken effect; observe the page before deciding whether to retry",
            ),
            Some(
                "the operation may already have taken effect; call bsk_inspect(action='observe') before deciding whether to retry",
            ),
            base.exit_code,
        ),
        (_, RpcErrorReason::TransferOutcomeUnknown) => info(
            "the file transfer outcome could not be confirmed",
            Some(
                "do not retry the transfer: the browser may already have applied it; inspect the page or stop safely",
            ),
            None,
            base.exit_code,
        ),
        (ErrorCode::Timeout, RpcErrorReason::TransferTimeout) => info(
            "the file transfer timed out after browser dispatch",
            Some(
                "do not retry when effect_state is unknown or committed; inspect the page before taking another action",
            ),
            Some(
                "do not retry when effect_state is unknown or committed; inspect the page via bsk_inspect before taking another action",
            ),
            base.exit_code,
        ),
        (ErrorCode::PermissionDenied, RpcErrorReason::ElementNotVisible) => info(
            "target element has no visible geometry",
            Some(
                "rerun snapshot and choose a visible child ref, or wait/scroll/reload before retrying",
            ),
            Some(
                "call bsk_inspect(action='snapshot') and choose a visible child ref, or wait/scroll/reload before retrying",
            ),
            base.exit_code,
        ),
        (ErrorCode::PermissionDenied, RpcErrorReason::IncognitoBorrowDisabled) => info(
            "tab borrowing is unavailable for incognito sessions and tabs",
            Some("create a new task tab with `bsk tab create <url> --session <id>`"),
            Some("create a new task tab with bsk_tabs(action='create', url=..., session_id=...)"),
            base.exit_code,
        ),
        (ErrorCode::PermissionDenied, RpcErrorReason::BorrowConflict) => info(
            "tab is borrowed by another session",
            Some(
                "return the tab from the borrowing session via `bsk tab return <tab-id> --session <id>` or stop that session",
            ),
            Some(
                "return the tab from the borrowing session via bsk_tabs(action='return', tab_id=..., session_id=...) or stop that session",
            ),
            base.exit_code,
        ),
        (ErrorCode::NotFound, RpcErrorReason::VisualCaptureStale) => info(
            "Canvas screenshot capture is no longer usable",
            Some(
                "run `bsk observe`, screenshot the current Canvas ref, and use its new capture_id",
            ),
            Some(
                "call bsk_inspect(action='observe'), screenshot the current Canvas ref via bsk_inspect(action='screenshot'), and use its new capture_id",
            ),
            base.exit_code,
        ),
        (
            ErrorCode::InvalidParams,
            RpcErrorReason::VisualCaptureInvalid | RpcErrorReason::VisualCoordinateInvalid,
        ) => info(
            "invalid screenshot-bound Canvas click",
            Some(
                "provide a visual ref, --capture, --image-x and --image-y in the original PNG dimensions",
            ),
            Some(
                "provide a visual ref along with capture_id, image_x, and image_y in the original PNG dimensions",
            ),
            base.exit_code,
        ),
        (ErrorCode::NotFound, RpcErrorReason::VisualTargetChanged) => info(
            "visual target needs a fresh observation",
            Some(
                "observe the page again and use the current visual ref; the previous identity or region cannot be used",
            ),
            Some(
                "call bsk_inspect(action='observe') again and use the current visual ref; the previous identity or region cannot be used",
            ),
            base.exit_code,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::VisualPixelBudgetExceeded) => info(
            "visual screenshot exceeds the image size limit",
            Some("the screenshot could not be reduced within the pixel budget"),
            None,
            base.exit_code,
        ),
        (ErrorCode::Unsupported, RpcErrorReason::RefKindUnsupported) => info(
            "this tool does not support the ref target type",
            Some(
                "use a DOM ref for DOM operations; visual-region refs require an available visual screenshot path",
            ),
            None,
            base.exit_code,
        ),
        (ErrorCode::NotFound, RpcErrorReason::RefNotFound) => info(
            "observation ref was not found for this tab",
            Some("rerun `bsk observe` for the current tab and use one of the returned refs"),
            Some(
                "call bsk_inspect(action='observe') for the current tab and use one of the returned refs",
            ),
            base.exit_code,
        ),
        (ErrorCode::NotFound, RpcErrorReason::SelectorNotFound) => info(
            "selector did not match any element",
            Some("verify the CSS selector or wait for the element to appear before retrying"),
            Some(
                "verify the CSS selector or wait for the element via bsk_page(action='wait_for_element') before retrying",
            ),
            base.exit_code,
        ),
        (ErrorCode::InvalidParams, RpcErrorReason::TargetNotFillable) => info(
            "target element is not fillable",
            Some(
                "observe the page and choose an enabled, editable text input, textarea, or contenteditable editor root; internal paragraphs and spans are not fill targets",
            ),
            Some(
                "call bsk_inspect(action='observe') and choose an enabled, editable text input, textarea, or contenteditable editor root; internal paragraphs and spans are not fill targets",
            ),
            base.exit_code,
        ),
        (ErrorCode::InvalidParams, RpcErrorReason::FillValueInvalid) => info(
            "the requested text does not fit the field constraints",
            Some(
                "check the field's input type and maxlength; use a compatible value without silently truncating or changing the user's intended data",
            ),
            None,
            base.exit_code,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::FillTargetChanged) => info(
            "the fill target changed during the action",
            Some(
                "observe the current page and field value; if the intended result is missing, use a fresh editable target before retrying",
            ),
            Some(
                "call bsk_inspect(action='observe') on the current page and field value; if the intended result is missing, use a fresh editable target before retrying",
            ),
            base.exit_code,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::FillFocusLost) => info(
            "the page moved focus away from the fill target",
            Some(
                "observe the page for a dialog or rerender and resolve it before retrying; fill manages field focus and does not require bringing the browser to the foreground",
            ),
            Some(
                "inspect the page for a dialog via bsk_assist(action='dialog_status') or rerender via bsk_inspect(action='observe') before retrying",
            ),
            base.exit_code,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::FillValueMismatch) => info(
            "the fill result could not be confirmed",
            Some(
                "observe the field before retrying; the page may have formatted the value. Continue if the visible result satisfies the user's intent; otherwise correct the remaining difference. Do not blindly repeat fill or immediately request human help",
            ),
            Some(
                "inspect the field via bsk_inspect(action='observe'|'read') before retrying; the page may have formatted the value. Continue if the visible result satisfies intent; otherwise correct the difference without blindly repeating fill",
            ),
            base.exit_code,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::FillFailed) => info(
            "fill encountered a browser or page-script error",
            Some(
                "observe the page before retrying because the field may already have changed; retry only if the intended result is missing and the target is still available",
            ),
            Some(
                "call bsk_inspect(action='observe') before retrying because the field may already have changed; retry only if the intended result is missing and the target is still available",
            ),
            base.exit_code,
        ),
        (ErrorCode::InvalidParams, RpcErrorReason::TargetNotSelect) => info(
            "target element is not a <select>",
            Some(
                "choose a native <select> ref or selector from the latest snapshot, or for custom ARIA dropdowns use `bsk click` on the combobox trigger first and then click the desired option",
            ),
            Some(
                "choose a native <select> ref or selector from the latest snapshot, or for custom ARIA dropdowns call bsk_interact(action='click') on the combobox trigger first and then click the desired option",
            ),
            base.exit_code,
        ),
        (ErrorCode::InvalidParams, RpcErrorReason::OptionNotFound) => info(
            "option value not found in <select>",
            Some(
                "check the inline `[options: ...]` candidates in the VOM observation or rerun `bsk snapshot`, then pass a valid value or unique option label via `--value`",
            ),
            Some(
                "check the inline `[options: ...]` candidates in the VOM observation or call bsk_inspect(action='snapshot'), then pass a valid value or unique option label in `values`",
            ),
            base.exit_code,
        ),
        (ErrorCode::InvalidParams, RpcErrorReason::OptionAmbiguous) => info(
            "option label matches multiple <select> options",
            Some(
                "multiple <option> elements share that visible label; pass the exact unambiguous option value via `--value`",
            ),
            Some(
                "multiple <option> elements share that visible label; pass the exact unambiguous option value in `values`",
            ),
            base.exit_code,
        ),
        (ErrorCode::InvalidParams, RpcErrorReason::SingleSelectValueCount) => info(
            "single-select requires exactly one option value",
            Some(
                "pass exactly one `--value` for a regular <select>; repeat `--value` only for <select multiple>",
            ),
            Some(
                "pass a single-element `values` array for a regular <select>; pass multiple values only for <select multiple>",
            ),
            base.exit_code,
        ),
        (ErrorCode::InvalidParams, RpcErrorReason::TabNotActive) => info(
            "screenshot requires the visible active tab",
            Some(
                "select the tab with `bsk tab select <tab-id> --session <id>` or omit `--tab-id` to capture the Agent Window's active tab",
            ),
            Some(
                "select the tab via bsk_tabs(action='select', tab_id=..., session_id=...) or omit tab_id to capture the Agent Window's active tab",
            ),
            base.exit_code,
        ),
        (ErrorCode::Timeout, RpcErrorReason::SessionBusy) => info(
            "previous session command is still running",
            Some(
                "wait for the current command to finish, or cancel it through its parent process or with Ctrl-C in the terminal running that command, then retry; if the caller is gone and the session stays busy, use `bsk daemon restart` (interrupts all sessions)",
            ),
            Some(
                "wait for the current command via bsk_debug(action='wait', session_id=...) or cancel it via bsk_assist(action='operation_cancel'); if a wedged process stays busy across restarts, ask the user to restart the daemon",
            ),
            base.exit_code,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::OperationSettling) => info(
            "an earlier command on this session is still finishing in the browser",
            Some(
                "nothing was sent; wait about a second and run the same command again (`bsk cooperate sync --settle` retries this automatically). Reload cannot help: it waits for the same command",
            ),
            Some(
                "nothing was sent; wait briefly and retry the read/sync call. Calling reload cannot help because it waits for the same command",
            ),
            base.exit_code,
        ),
        (ErrorCode::Cancelled, RpcErrorReason::UserCancelled) => info(
            "full-page screenshot cancelled by user input",
            Some("respect the interruption; do not automatically retry"),
            None,
            2,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::PageHidden) => info(
            "screenshot page became hidden",
            Some("keep the capture tab visible before starting another screenshot"),
            None,
            3,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::Navigation) => info(
            "screenshot page navigated",
            Some("inspect the current page before starting another screenshot"),
            None,
            3,
        ),
        (ErrorCode::Timeout, RpcErrorReason::WatchdogTimeout) => info(
            "screenshot lost contact with the page",
            Some(
                "check that the browser is responsive; increasing the total deadline does not repair page communication",
            ),
            None,
            4,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::StaleFrame) => info(
            "screenshot pixels did not update after scrolling",
            Some("keep the capture window visible; do not stitch repeated viewport images"),
            None,
            3,
        ),
        (ErrorCode::Timeout, RpcErrorReason::LoadingStalled) => info(
            "page loading stalled at the bottom",
            Some(
                "use --full-page --scope current only if the currently loaded document range satisfies the request",
            ),
            Some(
                "pass full_page=true with full_page_scope='current' on bsk_inspect(action='screenshot') only if the currently loaded document range satisfies the request",
            ),
            4,
        ),
        (ErrorCode::Timeout, RpcErrorReason::ScreenshotCaptureFailed) => info(
            "viewport screenshot timed out",
            Some(
                "check that the tab is responsive before capturing again; if capture keeps timing out, reload the tab or restart the browser",
            ),
            None,
            base.exit_code,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::ScreenshotCaptureFailed) => info(
            "the browser could not capture the tab image",
            Some(
                "both the visible-tab capture and the CDP compositor fallback failed inside the browser; this points at a browser-side rendering/readback issue — try reloading the tab, restarting the browser, or upgrading/downgrading Chrome",
            ),
            None,
            base.exit_code,
        ),
        (
            ErrorCode::CdpFailed | ErrorCode::Timeout | ErrorCode::InvalidParams,
            RpcErrorReason::RecordStartPageUnreachable,
        ) => info(
            "default start page https://example.com/ could not be opened",
            Some(
                "that site may be unreachable from your network. Pass --url with a page you can open, e.g. `bsk record start --url https://<site>/`",
            ),
            Some(
                "that default site may be unreachable from your network; pass an explicit reachable url to bsk_record(action='start', url='https://<site>/')",
            ),
            base.exit_code,
        ),
        (ErrorCode::Unsupported, RpcErrorReason::FileInputNotActivated) => info(
            "the upload trigger did not activate a file input",
            Some(
                "the page may use a non-input picker such as showOpenFilePicker(); when effect_state is none, re-observe and use `--mode drop` once only for a reliably identified attachment-receiving area — otherwise use `bsk request-help` with the exact original local path",
            ),
            Some(
                "the page may use a non-input picker such as showOpenFilePicker(); when effect_state is none, re-observe and call bsk_interact(action='upload', mode='drop') once only for a reliably identified attachment-receiving area — otherwise call bsk_assist(action='request_help') with the exact original local path",
            ),
            base.exit_code,
        ),
        (ErrorCode::Timeout | ErrorCode::CdpFailed, RpcErrorReason::FileInputProbeFailed) => info(
            "the browser upload transaction could not be established",
            Some(
                "do not retry the same upload blindly; use `bsk request-help` when human help is available",
            ),
            Some(
                "do not retry the same upload blindly; call bsk_assist(action='request_help') when human help is available",
            ),
            base.exit_code,
        ),
        (ErrorCode::Timeout | ErrorCode::CdpFailed, RpcErrorReason::SetFileInputFailed) => info(
            "the browser could not attach the staged file to the input",
            Some(
                "check that BrowserSkill has Chrome's 'Allow access to file URLs' permission; otherwise use `bsk request-help`",
            ),
            Some(
                "check that BrowserSkill has Chrome's 'Allow access to file URLs' permission; otherwise call bsk_assist(action='request_help')",
            ),
            base.exit_code,
        ),
        (ErrorCode::Unsupported, RpcErrorReason::UploadMechanismUnsupported) => info(
            "the browser does not support native file-drop upload",
            Some(
                "do not retry the same drop; use a standard file-input target or `bsk request-help`",
            ),
            Some(
                "do not retry the same drop; use a standard file-input target or bsk_assist(action='request_help')",
            ),
            base.exit_code,
        ),
        (
            ErrorCode::PermissionDenied | ErrorCode::Timeout | ErrorCode::CdpFailed,
            RpcErrorReason::FileDropTargetUnavailable,
        ) => info(
            "the file-drop target could not be safely resolved",
            Some(
                "rerun observe and select the attachment-receiving editor or drop zone itself; do not guess another target — no file was delivered when effect_state is none",
            ),
            Some(
                "call bsk_inspect(action='observe') and select the attachment-receiving editor or drop zone itself; do not guess another target — no file was delivered when effect_state is none",
            ),
            base.exit_code,
        ),
        (ErrorCode::Timeout | ErrorCode::CdpFailed, RpcErrorReason::FileDropFailed) => info(
            "the browser could not complete the native file drop",
            Some(
                "do not retry when effect_state is unknown; observe the page first, otherwise use `bsk request-help`",
            ),
            Some(
                "do not retry when effect_state is unknown; call bsk_inspect(action='observe') first, otherwise call bsk_assist(action='request_help')",
            ),
            base.exit_code,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::DownloadCaptureFailed) => info(
            "the browser download could not be attributed or completed",
            Some(
                "do not retry blindly; the target browser may not expose a reliable download intent signal",
            ),
            None,
            base.exit_code,
        ),
        (ErrorCode::CdpFailed, RpcErrorReason::DownloadPathMismatch) => info(
            "the browser did not use the requested download directory",
            Some(
                "find the saved file in the browser's Downloads list; check for a competing rename, a browser-rejected filename, or a different save location before retrying",
            ),
            None,
            base.exit_code,
        ),
        (_, RpcErrorReason::DialogPending) => info_for(ErrorCode::DialogPending),
        (_, RpcErrorReason::CancelledBeforeDispatch) => info(
            "request cancelled before reaching the browser",
            Some("no browser action was dispatched; safe to retry once ready"),
            None,
            base.exit_code,
        ),
        (_, RpcErrorReason::RestrictedTabUrl) => info(
            "browser page cannot be automated on a restricted internal URL",
            Some("navigate to an ordinary `http(s)://` page via `bsk navigate <url>`"),
            Some(
                "navigate to an ordinary `http(s)://` page via bsk_page(action='navigate', url=...)",
            ),
            base.exit_code,
        ),
        (
            _,
            RpcErrorReason::ReadParamsInvalid
            | RpcErrorReason::ReadTargetStale
            | RpcErrorReason::ReadSelectorInvalid
            | RpcErrorReason::ReadFieldAmbiguous
            | RpcErrorReason::ReadLimit
            | RpcErrorReason::ExtractParamsInvalid
            | RpcErrorReason::ExtractTargetStale
            | RpcErrorReason::ExtractTargetAmbiguous
            | RpcErrorReason::ExtractTargetHidden
            | RpcErrorReason::ExtractSelectorInvalid
            | RpcErrorReason::ExtractStructureInvalid
            | RpcErrorReason::ExtractFieldAmbiguous
            | RpcErrorReason::ExtractLimit
            | RpcErrorReason::UiLookupFailed
            | RpcErrorReason::TaskUnavailable
            | RpcErrorReason::TargetUnavailable
            | RpcErrorReason::TaskStopping
            | RpcErrorReason::UiDeadline
            | RpcErrorReason::PreviewBusy
            | RpcErrorReason::AgentWindowScope
            | RpcErrorReason::WindowResizeInactiveTab
            | RpcErrorReason::WindowResizeConstrained
            | RpcErrorReason::WindowResizeUnconfirmed
            | RpcErrorReason::WindowResizeViewportUnchanged
            | RpcErrorReason::RendererReadTimeout
            | RpcErrorReason::CleanupFailed
            | RpcErrorReason::SessionBusy
            | RpcErrorReason::SessionIdleTimeout
            | RpcErrorReason::SessionWindowClosed
            | RpcErrorReason::BrowserDisconnected
            | RpcErrorReason::NoActiveSession
            | RpcErrorReason::AmbiguousImplicitSession
            | RpcErrorReason::SessionStopped
            | RpcErrorReason::ScopeBrowserConflict
            | RpcErrorReason::ScopeIncognitoConflict
            | RpcErrorReason::RecordStartPageUnreachable
            | RpcErrorReason::UnsupportedFeature
            | RpcErrorReason::UncertainPriorEffect
            | RpcErrorReason::LocalFileError
            | RpcErrorReason::CdpExtensionAccessDenied
            | RpcErrorReason::ObserveIdentityReloadLoop
            | RpcErrorReason::BorrowAgentWindowTab
            | RpcErrorReason::BorrowConflict
            | RpcErrorReason::IncognitoBorrowDisabled
            | RpcErrorReason::ElementNotVisible
            | RpcErrorReason::VisualTargetChanged
            | RpcErrorReason::VisualPixelBudgetExceeded
            | RpcErrorReason::VisualCaptureStale
            | RpcErrorReason::VisualCaptureInvalid
            | RpcErrorReason::VisualCoordinateInvalid
            | RpcErrorReason::RefKindUnsupported
            | RpcErrorReason::RefNotFound
            | RpcErrorReason::SelectorNotFound
            | RpcErrorReason::TargetNotFillable
            | RpcErrorReason::FillValueInvalid
            | RpcErrorReason::FillTargetChanged
            | RpcErrorReason::FillFocusLost
            | RpcErrorReason::FillValueMismatch
            | RpcErrorReason::FillFailed
            | RpcErrorReason::TargetNotSelect
            | RpcErrorReason::OptionNotFound
            | RpcErrorReason::OptionAmbiguous
            | RpcErrorReason::SingleSelectValueCount
            | RpcErrorReason::TabNotActive
            | RpcErrorReason::OperationSettling
            | RpcErrorReason::UserCancelled
            | RpcErrorReason::PageHidden
            | RpcErrorReason::Navigation
            | RpcErrorReason::WatchdogTimeout
            | RpcErrorReason::StaleFrame
            | RpcErrorReason::LoadingStalled
            | RpcErrorReason::ScreenshotCaptureFailed
            | RpcErrorReason::FileInputNotActivated
            | RpcErrorReason::FileInputProbeFailed
            | RpcErrorReason::SetFileInputFailed
            | RpcErrorReason::UploadMechanismUnsupported
            | RpcErrorReason::FileDropTargetUnavailable
            | RpcErrorReason::FileDropFailed
            | RpcErrorReason::DownloadCaptureFailed
            | RpcErrorReason::DownloadPathMismatch
            | RpcErrorReason::TransferTimeout
            | RpcErrorReason::CancelCleanupTimeout
            | RpcErrorReason::Cancelled
            | RpcErrorReason::CliParseError,
        ) => base,
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

        assert_eq!(exit_code_for(ErrorCode::DialogPending), 6);
        assert_eq!(exit_code_for(ErrorCode::PairingRequired), 1);
    }

    /// Every code must carry a non-empty summary; an empty `summary`
    /// would render `error: ` with nothing after it.
    #[test]
    fn every_code_has_a_summary() {
        for code in ErrorCode::ALL {
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
        for code in ErrorCode::ALL {
            let info = info_for(*code);
            assert!(info.hint.is_some(), "hint missing for {code:?}");
        }
    }

    #[test]
    fn fill_reasons_provide_recovery_without_changing_exit_codes() {
        for (code, reason, hint_fragment) in [
            (
                ErrorCode::InvalidParams,
                RpcErrorReason::TargetNotFillable.as_str(),
                "enabled, editable",
            ),
            (
                ErrorCode::InvalidParams,
                RpcErrorReason::FillValueInvalid.as_str(),
                "maxlength",
            ),
            (
                ErrorCode::CdpFailed,
                RpcErrorReason::FillTargetChanged.as_str(),
                "fresh editable target",
            ),
            (
                ErrorCode::CdpFailed,
                RpcErrorReason::FillFocusLost.as_str(),
                "does not require bringing the browser",
            ),
            (
                ErrorCode::CdpFailed,
                RpcErrorReason::FillValueMismatch.as_str(),
                "Continue if the visible result satisfies",
            ),
            (
                ErrorCode::CdpFailed,
                RpcErrorReason::FillFailed.as_str(),
                "may already have changed",
            ),
        ] {
            let data = serde_json::json!({ "reason": reason });
            let info = info_for_error(code, Some(&data));
            assert!(info.hint.unwrap().contains(hint_fragment), "{reason}");
            assert_eq!(info.exit_code, info_for(code).exit_code);
        }
        let mismatch = serde_json::json!({ "reason": RpcErrorReason::FillValueMismatch.as_str() });
        let info = info_for_error(ErrorCode::CdpFailed, Some(&mismatch));
        assert_eq!(info.summary, "the fill result could not be confirmed");
        assert!(info.hint.unwrap().contains("Do not blindly repeat fill"));
        let unknown = serde_json::json!({ "reason": "future_fill_reason" });
        assert_eq!(
            info_for_error(ErrorCode::CdpFailed, Some(&unknown)),
            info_for(ErrorCode::CdpFailed)
        );
    }

    #[test]
    fn element_not_visible_overrides_permission_denied_copy() {
        let data = serde_json::json!({ "reason": RpcErrorReason::ElementNotVisible.as_str() });
        let info = info_for_error(ErrorCode::PermissionDenied, Some(&data));
        assert_eq!(info.summary, "target element has no visible geometry");
        assert!(
            info.hint.unwrap().contains("rerun snapshot"),
            "expected geometry-specific hint"
        );
        assert!(!info.summary.contains("sandbox"));
    }

    #[test]
    fn extension_access_denied_explains_the_frame_restriction_and_navigation_recovery() {
        let data =
            serde_json::json!({ "reason": RpcErrorReason::CdpExtensionAccessDenied.as_str() });
        let info = info_for_error(ErrorCode::CdpFailed, Some(&data));
        assert!(info.summary.contains("another extension"));
        let hint = info.hint.unwrap();
        assert!(hint.contains("restricted extension frame"));
        assert!(hint.contains("bsk navigate <url>"));
        assert!(hint.contains("disable the conflicting extension"));
        assert_eq!(info.exit_code, 3);
    }

    #[test]
    fn session_busy_overrides_timeout_copy() {
        let data = serde_json::json!({ "reason": RpcErrorReason::SessionBusy.as_str() });
        let info = info_for_error(ErrorCode::Timeout, Some(&data));
        assert_eq!(info.summary, "previous session command is still running");
        let hint = info.hint.unwrap();
        assert!(hint.contains("wait for the current command"));
        assert!(hint.contains("Ctrl-C in the terminal running that command"));
        assert!(hint.contains("parent process"));
        assert!(hint.contains("then retry"));
        assert!(hint.contains("bsk daemon restart"));
        assert!(hint.contains("interrupts all sessions"));
        assert!(!hint.contains("stop/restart"));
        assert_eq!(info.exit_code, 4);
    }

    #[test]
    fn operation_settling_does_not_suggest_reload() {
        let data = serde_json::json!({ "reason": RpcErrorReason::OperationSettling.as_str(), "dispatched": false });
        let info = info_for_error(ErrorCode::CdpFailed, Some(&data));
        assert_eq!(
            info.summary,
            "an earlier command on this session is still finishing in the browser"
        );
        let hint = info.hint.unwrap();
        assert!(hint.contains("nothing was sent"));
        assert!(hint.contains("run the same command again"));
        assert!(hint.contains("--settle"));
        assert!(!hint.contains("reloading the tab"));
        assert_eq!(info.exit_code, 3);
    }

    #[test]
    fn record_start_page_unreachable_overrides_cdp_failed_copy() {
        let data =
            serde_json::json!({ "reason": RpcErrorReason::RecordStartPageUnreachable.as_str() });
        let info = info_for_error(ErrorCode::CdpFailed, Some(&data));
        assert_eq!(
            info.summary,
            "default start page https://example.com/ could not be opened"
        );
        assert!(
            info.hint.unwrap().contains("--url"),
            "expected --url hint, got {:?}",
            info.hint
        );
        assert_eq!(info.exit_code, 3);
    }

    #[test]
    fn screenshot_capture_failed_overrides_cdp_failed_copy() {
        let data =
            serde_json::json!({ "reason": RpcErrorReason::ScreenshotCaptureFailed.as_str() });
        let info = info_for_error(ErrorCode::CdpFailed, Some(&data));
        assert_eq!(info.summary, "the browser could not capture the tab image");
        assert!(
            info.hint.unwrap().contains("CDP compositor fallback"),
            "expected screenshot-specific hint, got {:?}",
            info.hint
        );
        // Still the browser/CDP failure bucket.
        assert_eq!(info.exit_code, 3);
    }

    #[test]
    fn screenshot_capture_timeout_has_specific_guidance_and_timeout_exit_code() {
        let data =
            serde_json::json!({ "reason": RpcErrorReason::ScreenshotCaptureFailed.as_str() });
        let info = info_for_error(ErrorCode::Timeout, Some(&data));
        assert_eq!(info.summary, "viewport screenshot timed out");
        assert_eq!(
            info.hint,
            Some(
                "check that the tab is responsive before capturing again; if capture keeps timing out, reload the tab or restart the browser"
            )
        );
        assert_eq!(info.exit_code, 4);
    }

    #[test]
    fn control_authority_denial_does_not_request_a_blocked_renderer_sync() {
        let data = serde_json::json!({ "reason": "control_authority_required" });
        let info = info_for_error(ErrorCode::PermissionDenied, Some(&data));
        assert_eq!(info.exit_code, 1);
        let hint = info.hint.unwrap();
        assert!(hint.contains("return control"));
        assert!(hint.contains("do not replay"));
        assert!(!hint.contains("cooperate sync"));
    }

    #[test]
    fn full_page_recovery_distinguishes_stalled_loading_from_user_input() {
        let stalled = serde_json::json!({ "reason": RpcErrorReason::LoadingStalled.as_str() });
        let info = info_for_error(ErrorCode::Timeout, Some(&stalled));
        assert!(info.hint.unwrap().contains("--scope current"));
        assert!(!info.hint.unwrap().contains("increase"));
        assert_eq!(info.exit_code, 4);

        let cancelled = serde_json::json!({ "reason": RpcErrorReason::UserCancelled.as_str() });
        let info = info_for_error(ErrorCode::Cancelled, Some(&cancelled));
        assert!(info.hint.unwrap().contains("do not automatically retry"));
        assert_eq!(info.exit_code, 2);

        let hidden = serde_json::json!({ "reason": RpcErrorReason::PageHidden.as_str() });
        let info = info_for_error(ErrorCode::CdpFailed, Some(&hidden));
        assert!(info.hint.unwrap().contains("visible"));
        assert_eq!(info.exit_code, 3);
    }

    #[test]
    fn file_transfer_reasons_render_actionable_fallbacks() {
        let unsupported =
            serde_json::json!({ "reason": RpcErrorReason::FileInputNotActivated.as_str() });
        let info = info_for_error(ErrorCode::Unsupported, Some(&unsupported));
        assert_eq!(
            info.summary,
            "the upload trigger did not activate a file input"
        );
        let hint = info.hint.unwrap();
        assert!(hint.contains("--mode drop"));
        assert!(hint.contains("reliably identified attachment-receiving area"));
        assert!(hint.contains("exact original local path"));

        let control =
            serde_json::json!({ "reason": RpcErrorReason::FileInputProbeFailed.as_str() });
        let info = info_for_error(ErrorCode::Timeout, Some(&control));
        assert!(
            info.summary
                .contains("transaction could not be established")
        );
        assert!(info.hint.unwrap().contains("do not retry"));

        let unsupported_drop =
            serde_json::json!({ "reason": RpcErrorReason::UploadMechanismUnsupported.as_str() });
        let info = info_for_error(ErrorCode::Unsupported, Some(&unsupported_drop));
        assert_eq!(
            info.summary,
            "the browser does not support native file-drop upload"
        );
        assert!(info.hint.unwrap().contains("standard file-input"));

        let unavailable_target =
            serde_json::json!({ "reason": RpcErrorReason::FileDropTargetUnavailable.as_str() });
        let info = info_for_error(ErrorCode::PermissionDenied, Some(&unavailable_target));
        assert_eq!(
            info.summary,
            "the file-drop target could not be safely resolved"
        );
        assert!(info.hint.unwrap().contains("effect_state is none"));

        let failed_drop = serde_json::json!({ "reason": RpcErrorReason::FileDropFailed.as_str() });
        let info = info_for_error(ErrorCode::Timeout, Some(&failed_drop));
        assert!(info.summary.contains("native file drop"));
        assert!(info.hint.unwrap().contains("effect_state is unknown"));

        let download =
            serde_json::json!({ "reason": RpcErrorReason::DownloadCaptureFailed.as_str() });
        let info = info_for_error(ErrorCode::CdpFailed, Some(&download));
        assert!(info.summary.contains("download could not be attributed"));

        let path_mismatch = serde_json::json!({
            "reason": RpcErrorReason::DownloadPathMismatch.as_str(),
            "effect_state": "committed",
            "phase": "download"
        });
        let info = info_for_error(ErrorCode::CdpFailed, Some(&path_mismatch));
        assert!(info.summary.contains("requested download directory"));
        assert!(info.hint.unwrap().contains("browser-rejected filename"));

        let unknown =
            serde_json::json!({ "reason": RpcErrorReason::TransferOutcomeUnknown.as_str() });
        let info = info_for_error(ErrorCode::ProtocolError, Some(&unknown));
        assert!(info.summary.contains("outcome could not be confirmed"));
        assert!(info.hint.unwrap().contains("do not retry"));

        let timeout = serde_json::json!({ "reason": RpcErrorReason::TransferTimeout.as_str() });
        let info = info_for_error(ErrorCode::Timeout, Some(&timeout));
        assert!(info.summary.contains("timed out after browser dispatch"));
    }

    #[test]
    fn visual_screenshot_failures_have_specific_guidance() {
        let changed = serde_json::json!({ "reason": RpcErrorReason::VisualTargetChanged.as_str() });
        let info = info_for_error(ErrorCode::NotFound, Some(&changed));
        assert!(info.hint.unwrap().contains("observe"));
        let budget =
            serde_json::json!({ "reason": RpcErrorReason::VisualPixelBudgetExceeded.as_str() });
        let info = info_for_error(ErrorCode::CdpFailed, Some(&budget));
        assert!(info.summary.contains("image size limit"));
    }

    #[test]
    fn visual_ref_type_error_has_specific_guidance() {
        let data = serde_json::json!({ "reason": RpcErrorReason::RefKindUnsupported.as_str() });
        let info = info_for_error(ErrorCode::Unsupported, Some(&data));
        assert!(info.summary.contains("ref target type"));
        assert!(info.hint.unwrap().contains("DOM ref"));
        assert_eq!(info.exit_code, info_for(ErrorCode::Unsupported).exit_code);
    }

    #[test]
    fn ref_not_found_overrides_not_found_copy() {
        let data = serde_json::json!({ "reason": RpcErrorReason::RefNotFound.as_str() });
        let info = info_for_error(ErrorCode::NotFound, Some(&data));
        assert_eq!(info.summary, "observation ref was not found for this tab");
        assert!(info.hint.unwrap().contains("bsk observe"));
    }

    #[test]
    fn target_not_select_overrides_invalid_params_copy() {
        let data = serde_json::json!({ "reason": RpcErrorReason::TargetNotSelect.as_str() });
        let info = info_for_error(ErrorCode::InvalidParams, Some(&data));
        assert_eq!(info.summary, "target element is not a <select>");
        assert!(info.hint.unwrap().contains("native <select>"));
    }

    #[test]
    fn option_not_found_overrides_invalid_params_copy() {
        let data = serde_json::json!({ "reason": RpcErrorReason::OptionNotFound.as_str() });
        let info = info_for_error(ErrorCode::InvalidParams, Some(&data));
        assert_eq!(info.summary, "option value not found in <select>");
        assert!(info.hint.unwrap().contains("--value"));
    }

    #[test]
    fn option_ambiguous_and_virtual_row_recycled_provide_targeted_hints() {
        let amb = serde_json::json!({ "reason": RpcErrorReason::OptionAmbiguous.as_str() });
        let amb_info = info_for_error(ErrorCode::InvalidParams, Some(&amb));
        assert_eq!(
            amb_info.summary,
            "option label matches multiple <select> options"
        );
        assert!(amb_info.hint.unwrap().contains("--value"));

        let rec = serde_json::json!({ "reason": RpcErrorReason::VirtualRowRecycled.as_str() });
        let rec_info = info_for_error(ErrorCode::PermissionDenied, Some(&rec));
        assert!(rec_info.summary.contains("recycled in place"));
        assert!(rec_info.hint.unwrap().contains("cooperate sync"));
    }

    #[test]
    fn single_select_value_count_overrides_invalid_params_copy() {
        let data = serde_json::json!({ "reason": RpcErrorReason::SingleSelectValueCount.as_str() });
        let info = info_for_error(ErrorCode::InvalidParams, Some(&data));
        assert_eq!(
            info.summary,
            "single-select requires exactly one option value"
        );
        assert!(info.hint.unwrap().contains("exactly one"));
    }
    #[test]
    fn acknowledged_wheel_with_unconfirmed_paint_has_a_scroll_specific_hint() {
        for code in [
            ErrorCode::CdpFailed,
            ErrorCode::Timeout,
            ErrorCode::Cancelled,
            ErrorCode::UserAborted,
        ] {
            let info = info_for_error(
                code,
                Some(&serde_json::json!({
                    "reason": "input_paint_unconfirmed",
                    "effect_state": "unknown"
                })),
            );
            assert!(info.summary.contains("wheel input was sent"));
            let hint = info.hint.unwrap();
            assert!(hint.contains("do not repeat"));
            assert!(hint.contains("scroll position"));
            assert_eq!(info.exit_code, info_for(code).exit_code);
        }
    }

    #[test]
    fn input_recovery_hints_do_not_encourage_blind_replay() {
        let ready = info_for_error(
            ErrorCode::CdpFailed,
            Some(&serde_json::json!({"reason":"input_not_ready"})),
        );
        assert!(
            ready
                .hint
                .unwrap()
                .contains("no click, key press or wheel input was sent")
        );
        let cleanup = info_for_error(
            ErrorCode::CdpFailed,
            Some(&serde_json::json!({"reason":"input_cleanup_failed"})),
        );
        assert!(cleanup.hint.unwrap().contains("do not repeat"));
        for code in [
            ErrorCode::CdpFailed,
            ErrorCode::Timeout,
            ErrorCode::Cancelled,
        ] {
            let unknown = info_for_error(
                code,
                Some(&serde_json::json!({
                    "reason": "input_outcome_unknown",
                    "effect_state": "unknown"
                })),
            );
            assert!(unknown.summary.contains("may already have taken effect"));
            assert!(unknown.hint.unwrap().contains("do not repeat"));
            assert_eq!(unknown.exit_code, info_for(code).exit_code);
        }
        let timeout = info_for_error(
            ErrorCode::Timeout,
            Some(&serde_json::json!({"reason":"cancel_cleanup_timeout"})),
        );
        assert!(
            timeout
                .hint
                .unwrap()
                .contains("may already have taken effect")
        );
        assert_eq!(timeout.exit_code, 4);
    }

    #[test]
    fn extension_link_reasons_match_the_connection_state() {
        let silent = info_for_error(
            ErrorCode::Timeout,
            Some(&serde_json::json!({"reason":"extension_unresponsive"})),
        );
        assert_eq!(silent.summary, "extension is not responding");
        assert_eq!(silent.exit_code, 4);
        let reconnected = info_for_error(
            ErrorCode::ProtocolError,
            Some(&serde_json::json!({"reason":"extension_reconnected"})),
        );
        assert_eq!(reconnected.summary, "extension reconnected");
        assert!(reconnected.hint.unwrap().contains("do not repeat"));
        let disconnected = info_for_error(
            ErrorCode::ProtocolError,
            Some(&serde_json::json!({"reason":"extension_disconnected"})),
        );
        assert_eq!(disconnected.summary, "extension disconnected");
        assert_eq!(disconnected.exit_code, 2);
        assert!(!disconnected.hint.unwrap().contains("protocol version"));
    }

    /// Issue #465: a dead session surfaces *why* it stopped instead of
    /// a generic not-found, and the anti-debugging / borrow-target
    /// reasons get non-retry copy instead of the `cdp_failed` /
    /// `invalid_params` defaults.
    #[test]
    fn user_moved_tab_is_terminal_for_running_and_later_commands() {
        for code in [
            ErrorCode::UserAborted,
            ErrorCode::NotFound,
            ErrorCode::Timeout,
            ErrorCode::Cancelled,
            ErrorCode::CdpFailed,
            ErrorCode::ProtocolError,
        ] {
            let rendered = info_for_error(
                code,
                Some(&serde_json::json!({"reason": RpcErrorReason::UserMovedTab.as_str()})),
            );
            assert!(rendered.summary.contains("user moved a controlled tab"));
            let hint = rendered.hint.unwrap();
            assert!(hint.contains("all pages were preserved"));
            assert!(hint.contains("cannot resume"));
            assert!(hint.contains("Ask the user"));
            assert_eq!(rendered.exit_code, info_for(code).exit_code);
        }
    }

    #[test]
    fn ended_sessions_and_recurring_failures_get_reasoned_copy() {
        let idle = info_for_error(
            ErrorCode::NotFound,
            Some(&serde_json::json!({"reason": RpcErrorReason::SessionIdleTimeout.as_str()})),
        );
        assert_eq!(idle.summary, "the session stopped after its idle timeout");
        assert!(idle.hint.unwrap().contains("--session-idle"));
        assert_eq!(idle.exit_code, info_for(ErrorCode::NotFound).exit_code);

        let closed = info_for_error(
            ErrorCode::NotFound,
            Some(&serde_json::json!({"reason": RpcErrorReason::SessionWindowClosed.as_str()})),
        );
        assert_eq!(
            closed.summary,
            "the session ended because the user closed the Agent Window"
        );

        let browser_gone = info_for_error(
            ErrorCode::NotFound,
            Some(&serde_json::json!({"reason": RpcErrorReason::BrowserDisconnected.as_str()})),
        );
        assert_eq!(
            browser_gone.summary,
            "the browser was disconnected from the daemon"
        );

        let anti_debug = info_for_error(
            ErrorCode::CdpFailed,
            Some(
                &serde_json::json!({"reason": RpcErrorReason::ObserveIdentityReloadLoop.as_str()}),
            ),
        );
        assert!(anti_debug.summary.contains("anti-debugging"));
        // The reporter explicitly asked that this failure must not
        // propose reloading the tab; the hint forbids it instead.
        let anti_debug_hint = anti_debug.hint.unwrap();
        assert!(anti_debug_hint.contains("do not reload"));
        assert!(anti_debug_hint.contains("hand the task back"));
        assert_eq!(
            anti_debug.exit_code,
            info_for(ErrorCode::CdpFailed).exit_code
        );

        let borrow = info_for_error(
            ErrorCode::InvalidParams,
            Some(&serde_json::json!({"reason": RpcErrorReason::BorrowAgentWindowTab.as_str()})),
        );
        assert!(borrow.summary.contains("Agent Window"));
        assert!(borrow.hint.unwrap().contains("needs a user move"));
    }

    #[test]
    fn mcp_hints_never_emit_cli_only_commands() {
        const FORBIDDEN_CLI_CMDS: &[&str] = &[
            "bsk sync",
            "bsk cooperate",
            "bsk open",
            "bsk close",
            "bsk ledger",
            "bsk tab ",
            "bsk dialog",
            "bsk operation",
            "bsk observe",
            "bsk snapshot",
            "bsk get-html",
            "bsk request-help",
            "bsk record",
            "bsk navigate",
            "bsk session",
            "bsk browsers",
            "bsk <cmd>",
            "bsk --version",
            "bsk status",
            "bsk daemon restart",
        ];
        for &code in ErrorCode::ALL {
            let base = info_for(code);
            let effective = base.mcp_hint.or(base.hint).unwrap_or_default();
            for pat in FORBIDDEN_CLI_CMDS {
                assert!(
                    !effective.contains(pat),
                    "base MCP hint for {code:?} leaked CLI command `{pat}`: {effective}"
                );
            }
            for &reason in RpcErrorReason::ALL {
                let rendered = info_for_error(
                    code,
                    Some(&serde_json::json!({ "reason": reason.as_str() })),
                );
                let effective = rendered.mcp_hint.or(rendered.hint).unwrap_or_default();
                for pat in FORBIDDEN_CLI_CMDS {
                    assert!(
                        !effective.contains(pat),
                        "MCP hint for ({code:?}, {reason:?}) leaked CLI command `{pat}`: {effective}"
                    );
                }
            }
        }
    }
    #[test]
    fn target_control_errors_point_to_the_failed_check() {
        for (reason, phrase) in [
            ("precondition_failed", "business fact"),
            ("target_covered", "not currently actionable"),
            ("target_focus_lost", "not currently actionable"),
            ("control_context_invalid", "control context"),
            ("observation_required", "explicit current observation"),
            ("human_intervention", "user has control"),
        ] {
            let info = info_for_error(
                ErrorCode::PermissionDenied,
                Some(&serde_json::json!({"reason":reason})),
            );
            assert!(info.summary.contains(phrase));
        }
    }

    #[test]
    fn collection_errors_explain_recovery_without_waiting_again() {
        for (reason, summary, hint) in [
            ("frame_unobservable", "coverage is unavailable", "read-only"),
            ("page_load_failed", "main page failed to load", "network"),
        ] {
            let info = info_for_error(
                ErrorCode::PermissionDenied,
                Some(&serde_json::json!({"reason":reason})),
            );
            assert!(info.summary.contains(summary));
            assert!(info.hint.unwrap().contains(hint));
            assert!(!info.hint.unwrap().contains("cooperate wait"));
            assert_ne!(info.exit_code, 0);
        }
    }
}
