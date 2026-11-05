//! Emit JSON Schema files for handshake + §7 tool params/results (`schema/`).

use std::fs;
use std::path::PathBuf;

use bsk_protocol::system::{
    BrowserListParams, HandshakeParams, HandshakeResult, PingParams, PingResult, StatusParams,
    StatusResult,
};
use bsk_protocol::tools::*;
use bsk_protocol::{CancelParams, CancelResult};
use schemars::{JsonSchema, schema::RootSchema, schema_for};

/// Keep operation structs separate from the shared wire metadata without hiding
/// that metadata from clients generated from the published parameter schemas.
fn action_schema<T: JsonSchema>() -> RootSchema {
    let mut schema = schema_for!(T);
    let metadata = schema_for!(ActionMetadata);
    schema
        .schema
        .object
        .as_mut()
        .expect("action params are objects")
        .properties
        .extend(
            metadata
                .schema
                .object
                .expect("metadata is an object")
                .properties,
        );
    schema.definitions.extend(metadata.definitions);
    schema
}

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

macro_rules! dump_action {
    ($ty:ty, $file:literal) => {
        write_schema($file, action_schema::<$ty>());
    };
}

fn main() {
    dump!(PendingJavaScriptDialog, "pending_javascript_dialog");
    dump!(DialogStatusParams, "tool_dialog_status_params");
    dump!(DialogHandleParams, "tool_dialog_handle_params");
    dump!(OperationParams, "tool_operation_params");
    dump!(CooperateParams, "tool_cooperate_params");
    dump!(ActionExpectation, "action_expectation");
    dump!(ActionMetadata, "action_metadata");
    dump!(VideoParams, "tool_video_params");
    dump!(VideoRecording, "video_recording");
    dump!(VideoGrant, "video_grant");
    dump!(VideoReadResult, "tool_video_read_result");
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

    dump_action!(WindowResizeParams, "tool_window_resize_params");
    dump!(WindowResizeResult, "tool_window_resize_result");

    dump_action!(EmulateParams, "tool_emulate_params");
    dump!(EmulateResult, "tool_emulate_result");
    dump!(EmulateOverrides, "tool_emulate_overrides");
    dump!(UserAgentMetadata, "tool_emulate_user_agent_metadata");

    dump!(TabListParams, "tool_tab_list_params");
    dump!(TabListResult, "tool_tab_list_result");
    dump!(TabCreateParams, "tool_tab_create_params");
    dump!(TabCreateResult, "tool_tab_create_result");
    dump_action!(TabCloseParams, "tool_tab_close_params");
    dump!(TabCloseResult, "tool_tab_close_result");
    dump!(TabBorrowParams, "tool_tab_borrow_params");
    dump!(TabBorrowResult, "tool_tab_borrow_result");
    dump!(TabReturnParams, "tool_tab_return_params");
    dump!(TabReturnResult, "tool_tab_return_result");
    dump!(TabSelectParams, "tool_tab_select_params");
    dump!(TabSelectResult, "tool_tab_select_result");

    dump_action!(NavigateParams, "tool_navigate_params");
    dump!(NavigateResult, "tool_navigate_result");
    dump_action!(NavigateBackParams, "tool_navigate_back_params");
    dump!(NavigateBackResult, "tool_navigate_back_result");
    dump_action!(NavigateForwardParams, "tool_navigate_forward_params");
    dump!(NavigateForwardResult, "tool_navigate_forward_result");
    dump_action!(ReloadParams, "tool_reload_params");
    dump!(ReloadResult, "tool_reload_result");

    dump_action!(ClickParams, "tool_click_params");
    dump!(ClickResult, "tool_click_result");
    dump_action!(HoverParams, "tool_hover_params");
    dump!(HoverResult, "tool_hover_result");
    dump_action!(DragParams, "tool_drag_params");
    dump!(DragResult, "tool_drag_result");
    dump_action!(WheelParams, "tool_wheel_params");
    dump!(WheelResult, "tool_wheel_result");
    dump_action!(ScrollToParams, "tool_scroll_to_params");
    dump!(ScrollToResult, "tool_scroll_to_result");
    dump_action!(FocusParams, "tool_focus_params");
    dump!(FocusResult, "tool_focus_result");
    dump_action!(BlurParams, "tool_blur_params");
    dump!(BlurResult, "tool_blur_result");
    dump_action!(FillParams, "tool_fill_params");
    dump!(FillResult, "tool_fill_result");
    dump_action!(PressParams, "tool_press_params");
    dump!(PressResult, "tool_press_result");
    dump_action!(SelectParams, "tool_select_params");
    dump!(SelectResult, "tool_select_result");
    dump_action!(UploadParams, "tool_upload_params");
    dump!(UploadResult, "tool_upload_result");
    dump_action!(DownloadParams, "tool_download_params");
    dump!(DownloadResult, "tool_download_result");

    dump!(SnapshotParams, "tool_snapshot_params");
    dump!(SnapshotResult, "tool_snapshot_result");
    dump_action!(ObserveParams, "tool_observe_params");
    dump!(ObserveResult, "tool_observe_result");
    dump!(GetHtmlParams, "tool_get_html_params");
    dump!(GetHtmlResult, "tool_get_html_result");
    dump!(ExtractParams, "tool_extract_params");
    dump!(ExtractResult, "tool_extract_result");
    dump!(ScreenshotParams, "tool_screenshot_params");
    dump!(ScreenshotResult, "tool_screenshot_result");
    dump_action!(ScreenshotFullPageParams, "tool_screenshot_full_page_params");
    dump!(ScreenshotFullPageResult, "tool_screenshot_full_page_result");
    dump!(ScreenshotReadParams, "tool_screenshot_read_params");
    dump!(ScreenshotReadResult, "tool_screenshot_read_result");
    dump!(ScreenshotReleaseParams, "tool_screenshot_release_params");
    dump!(ScreenshotReleaseResult, "tool_screenshot_release_result");
    dump!(ConsoleParams, "tool_console_params");
    dump!(ConsoleResult, "tool_console_result");
    dump!(ConsoleEntry, "tool_console_entry");
    dump!(ConsoleStackFrame, "tool_console_stack_frame");
    dump_action!(DebugParams, "tool_debug_params");
    dump!(DebugResult, "tool_debug_result");
    dump!(NetworkParams, "tool_network_params");
    dump!(NetworkResult, "tool_network_result");
    dump!(NetworkEntry, "tool_network_entry");

    dump_action!(EvaluateParams, "tool_evaluate_params");
    dump!(EvaluateResult, "tool_evaluate_result");
    dump!(EvaluateError, "tool_evaluate_error");

    dump!(WaitForNavigationParams, "tool_wait_for_navigation_params");
    dump!(WaitForNavigationResult, "tool_wait_for_navigation_result");
    dump!(WaitForElementParams, "tool_wait_for_element_params");
    dump!(WaitForElementResult, "tool_wait_for_element_result");
    dump!(WaitMsParams, "tool_wait_ms_params");
    dump!(WaitMsResult, "tool_wait_ms_result");
    dump!(RequestHelpParams, "tool_request_help_params");
    dump!(RequestHelpResult, "tool_request_help_result");

    dump!(TraceV2, "trace_v2");
    dump!(TraceV3, "trace_v3");
    dump!(RecordedTrace, "trace");
    dump!(StepV2, "trace_step_v2");
    dump!(StepV3, "trace_step_v3");
    dump!(RecordedStep, "trace_step");
    dump!(RecordStartParams, "tool_record_start_params");
    dump!(RecordStartResult, "tool_record_start_result");
    dump!(RecordStopParams, "tool_record_stop_params");
    dump!(RecordStopResult, "tool_record_stop_result");
    dump!(RecordAwaitParams, "tool_record_await_params");
    dump!(RecordAwaitResult, "tool_record_await_result");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn composition_preserves_operation_fields_and_exposes_condition_limits() {
        let original = schema_for!(DragParams);
        let combined = action_schema::<DragParams>();
        let original_object = original.schema.object.unwrap();
        let combined_object = combined.schema.object.as_ref().unwrap();
        assert_eq!(combined_object.required, original_object.required);
        for (name, property) in original_object.properties {
            if name != "observation_id" {
                assert_eq!(combined_object.properties[&name], property, "{name}");
            }
        }
        let value = serde_json::to_value(combined).unwrap();
        assert_eq!(value["title"], "DragParams");
        assert_eq!(value["properties"]["expect"]["type"], "array");
        // Drag already exposed this optional field; retain its accepted wire shape.
        assert_eq!(
            value["properties"]["observation_id"]["type"],
            json!(["string", "null"])
        );
        assert_eq!(value["properties"]["expect"]["maxItems"], 16);
        assert_eq!(
            value["definitions"]["ActionExpectation"]["properties"]["target"]["maxLength"],
            1024
        );
        assert_eq!(
            value["definitions"]["ActionExpectation"]["properties"]["attribute"]["maxLength"],
            256
        );
        assert!(
            value["properties"]["observation_id"]["description"]
                .as_str()
                .unwrap()
                .contains("Strict-policy drag")
        );
    }

    #[test]
    fn published_action_schemas_include_shared_metadata() {
        for operation in [
            "window_resize",
            "emulate",
            "tab_close",
            "navigate",
            "navigate_back",
            "navigate_forward",
            "reload",
            "click",
            "hover",
            "drag",
            "wheel",
            "scroll_to",
            "focus",
            "blur",
            "fill",
            "press",
            "select",
            "upload",
            "download",
            "observe",
            "screenshot_full_page",
            "debug",
            "evaluate",
        ] {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(format!("schema/tool_{operation}_params.json"));
            let schema: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            for field in ["context_id", "observation_id", "depends_on", "expect"] {
                assert!(
                    schema["properties"].get(field).is_some(),
                    "{operation}.{field}"
                );
                assert!(
                    !schema["required"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(field))
                );
            }
            assert_eq!(
                schema["properties"]["expect"]["items"]["$ref"],
                "#/definitions/ActionExpectation"
            );
            assert_eq!(
                schema["definitions"]["ActionExpectation"]["additionalProperties"],
                false
            );
        }
    }
}
