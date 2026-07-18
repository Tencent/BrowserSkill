//! Emit JSON Schema files for handshake + §7 tool params/results (`schema/`).

use std::fs;
use std::path::PathBuf;

use bsk_protocol::system::{
    BrowserListParams, HandshakeParams, HandshakeResult, PingParams, PingResult, StatusParams,
    StatusResult,
};
use bsk_protocol::tools::*;
use bsk_protocol::{CancelParams, CancelResult};
use schemars::schema_for;

fn write_schema(name: &str, schema: impl serde::Serialize) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("schema");
    fs::create_dir_all(&dir).expect("create schema dir");
    let path = dir.join(format!("{name}.json"));
    let json = serde_json::to_string_pretty(&schema).expect("serialize schema");
    let mut json = json;
    json.push('\n');
    fs::write(&path, json).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

macro_rules! dump {
    ($ty:ty, $file:literal) => {
        write_schema($file, schema_for!($ty));
    };
}

fn main() {
    dump!(HandshakeParams, "handshake_params");
    dump!(HandshakeResult, "handshake_result");

    dump!(PingParams, "system_ping_params");
    dump!(PingResult, "system_ping_result");
    dump!(StatusParams, "system_status_params");
    dump!(StatusResult, "system_status_result");
    dump!(BrowserListParams, "browser_list_params");

    dump!(CancelParams, "cancel_params");
    dump!(CancelResult, "cancel_result");

    dump!(SessionStartParams, "tool_session_start_params");
    dump!(SessionStartResult, "tool_session_start_result");
    dump!(SessionStopParams, "tool_session_stop_params");
    dump!(SessionStopResult, "tool_session_stop_result");

    dump!(TabListParams, "tool_tab_list_params");
    dump!(TabListResult, "tool_tab_list_result");
    dump!(TabCreateParams, "tool_tab_create_params");
    dump!(TabCreateResult, "tool_tab_create_result");
    dump!(TabCloseParams, "tool_tab_close_params");
    dump!(TabCloseResult, "tool_tab_close_result");
    dump!(TabBorrowParams, "tool_tab_borrow_params");
    dump!(TabBorrowResult, "tool_tab_borrow_result");
    dump!(TabReturnParams, "tool_tab_return_params");
    dump!(TabReturnResult, "tool_tab_return_result");
    dump!(TabSelectParams, "tool_tab_select_params");
    dump!(TabSelectResult, "tool_tab_select_result");

    dump!(NavigateParams, "tool_navigate_params");
    dump!(NavigateResult, "tool_navigate_result");
    dump!(NavigateBackParams, "tool_navigate_back_params");
    dump!(NavigateBackResult, "tool_navigate_back_result");
    dump!(NavigateForwardParams, "tool_navigate_forward_params");
    dump!(NavigateForwardResult, "tool_navigate_forward_result");
    dump!(ReloadParams, "tool_reload_params");
    dump!(ReloadResult, "tool_reload_result");

    dump!(ClickParams, "tool_click_params");
    dump!(ClickResult, "tool_click_result");
    dump!(FillParams, "tool_fill_params");
    dump!(FillResult, "tool_fill_result");
    dump!(PressParams, "tool_press_params");
    dump!(PressResult, "tool_press_result");
    dump!(SelectParams, "tool_select_params");
    dump!(SelectResult, "tool_select_result");

    dump!(SnapshotParams, "tool_snapshot_params");
    dump!(SnapshotResult, "tool_snapshot_result");
    dump!(GetHtmlParams, "tool_get_html_params");
    dump!(GetHtmlResult, "tool_get_html_result");
    dump!(ScreenshotParams, "tool_screenshot_params");
    dump!(ScreenshotResult, "tool_screenshot_result");
    dump!(ConsoleParams, "tool_console_params");
    dump!(ConsoleResult, "tool_console_result");
    dump!(ConsoleEntry, "tool_console_entry");
    dump!(ConsoleStackFrame, "tool_console_stack_frame");
    dump!(NetworkParams, "tool_network_params");
    dump!(NetworkResult, "tool_network_result");
    dump!(NetworkEntry, "tool_network_entry");

    dump!(EvaluateParams, "tool_evaluate_params");
    dump!(EvaluateResult, "tool_evaluate_result");
    dump!(EvaluateError, "tool_evaluate_error");

    dump!(WaitForNavigationParams, "tool_wait_for_navigation_params");
    dump!(WaitForNavigationResult, "tool_wait_for_navigation_result");
    dump!(WaitMsParams, "tool_wait_ms_params");
    dump!(WaitMsResult, "tool_wait_ms_result");
    dump!(RequestHelpParams, "tool_request_help_params");
    dump!(RequestHelpResult, "tool_request_help_result");
}
