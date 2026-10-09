// Public protocol payloads are generated from bsk-protocol.
// Transport envelopes deliberately admit unknown method/event names for versioned peers.
import type {
  ErrorCode,
  HandshakeRequest,
  NavigateBackResult,
  SessionStopOutcome,
  TabScope,
} from "./generated/types";

export { TRACE_VERSION_V2, TRACE_VERSION_V3, VOM_FORMAT_VERSION } from "./generated/methods";
export type * from "./generated/types";
export type HandshakeParams = HandshakeRequest;
export type HandshakeResult = import("./generated/input").HandshakeResponse;
export type SessionStopResult = SessionStopOutcome;
export type RpcId = string;
export type NavigateHistoryResult = NavigateBackResult;
export type TabScopeFilter = TabScope;
export type ConnectionState = "disconnected" | "connecting" | "connected" | "version_skew";

export type RpcErrorReason =
  | "ui_lookup_failed"
  | "task_unavailable"
  | "target_unavailable"
  | "task_stopping"
  | "ui_deadline"
  | "preview_busy"
  | "agent_window_scope"
  | "element_not_visible"
  | "input_not_ready"
  | "input_outcome_unknown"
  | "input_paint_unconfirmed"
  | "input_cleanup_failed"
  | "ref_not_found"
  | "ref_kind_unsupported"
  | "visual_capture_stale"
  | "visual_capture_invalid"
  | "visual_coordinate_invalid"
  | "visual_target_changed"
  | "visual_pixel_budget_exceeded"
  | "selector_not_found"
  | "target_not_fillable"
  | "fill_value_invalid"
  | "fill_target_changed"
  | "fill_focus_lost"
  | "fill_value_mismatch"
  | "fill_failed"
  | "target_not_select"
  | "option_not_found"
  | "single_select_value_count"
  | "tab_not_active"
  | "restricted_tab_url"
  | "cdp_extension_access_denied"
  | "borrow_conflict"
  | "borrow_in_progress"
  | "user_denied"
  | "confirmation_timeout"
  | "confirmation_ui_unavailable"
  | "borrow_outcome_unknown"
  | "screenshot_capture_failed"
  | "renderer_read_timeout"
  | "user_cancelled"
  | "page_hidden"
  | "navigation"
  | "watchdog_timeout"
  | "stale_frame"
  | "loading_stalled"
  | "file_input_probe_failed"
  | "file_input_not_activated"
  | "set_file_input_failed"
  | "upload_mechanism_unsupported"
  | "file_drop_target_unavailable"
  | "file_drop_failed"
  | "download_capture_failed"
  | "download_path_mismatch"
  | "transfer_outcome_unknown"
  | "transfer_timeout"
  | "cleanup_failed";

export type TransferEffectState = "none" | "committed" | "unknown";
export type TransferCleanupState = "complete" | "failed";

export interface RpcErrorData {
  reason?: RpcErrorReason;
  effect_state?: TransferEffectState;
  phase?: string;
  cleanup_state?: TransferCleanupState;
  [key: string]: unknown;
}

export interface RpcError {
  code: ErrorCode;
  message: string;
  data?: RpcErrorData;
}

export interface RequestFrame {
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface OkResponseFrame {
  id: RpcId;
  result: unknown;
}

export interface ErrResponseFrame {
  id: RpcId;
  error: RpcError;
}

export type ResponseFrame = OkResponseFrame | ErrResponseFrame;

export interface EventFrame {
  event: string;
  payload?: unknown;
}

export type ProtocolFrame = RequestFrame | ResponseFrame | EventFrame;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRequestFrame(f: unknown): f is RequestFrame {
  return (
    isObject(f) &&
    typeof f.id === "string" &&
    typeof f.method === "string" &&
    !("result" in f) &&
    !("error" in f) &&
    !("event" in f)
  );
}

export function isResponseFrame(f: unknown): f is ResponseFrame {
  if (!isObject(f) || typeof f.id !== "string" || "method" in f || "event" in f) return false;
  if ("result" in f) return !("error" in f);
  return (
    isObject(f.error) &&
    typeof f.error.code === "string" &&
    typeof f.error.message === "string" &&
    (f.error.data === undefined || isObject(f.error.data))
  );
}

export function isEventFrame(f: unknown): f is EventFrame {
  return (
    isObject(f) &&
    typeof f.event === "string" &&
    !("id" in f) &&
    !("method" in f) &&
    !("result" in f) &&
    !("error" in f)
  );
}

export function isProtocolFrame(f: unknown): f is ProtocolFrame {
  return isRequestFrame(f) || isResponseFrame(f) || isEventFrame(f);
}
