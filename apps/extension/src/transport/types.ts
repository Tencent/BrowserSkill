// Wire-protocol shapes mirroring bsk-protocol (see crates/bsk-protocol/schema/*.json). The
// daemon serialises Rust structs via serde; these TS types intentionally
// stay structural (interface, not class) so the same JSON parses on both
// sides without extra adapters.

export type RpcId = string;

export type ErrorCode =
  | "unknown_method"
  | "unsupported"
  | "invalid_params"
  | "not_found"
  | "permission_denied"
  | "timeout"
  | "cdp_failed"
  | "protocol_error"
  | "cancelled"
  | "version_too_old"
  | "multiple_browsers_online"
  | "no_browser_connected";

/** Stable `RpcError.data.reason` values for CLI hint selection. */
export type RpcErrorReason =
  | "agent_window_scope"
  | "element_not_visible"
  | "ref_not_found"
  | "selector_not_found"
  | "target_not_fillable"
  | "target_not_select"
  | "option_not_found"
  | "single_select_value_count"
  | "tab_not_active"
  | "borrow_conflict";

export interface RpcErrorData {
  reason?: RpcErrorReason;
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

export function isRequestFrame(f: ProtocolFrame): f is RequestFrame {
  return typeof (f as RequestFrame).method === "string";
}

export function isResponseFrame(f: ProtocolFrame): f is ResponseFrame {
  return (
    typeof (f as ResponseFrame).id === "string" &&
    ("result" in (f as object) || "error" in (f as object))
  );
}

export function isEventFrame(f: ProtocolFrame): f is EventFrame {
  return typeof (f as EventFrame).event === "string";
}

export interface BrowserPeerInfo {
  name: string;
  version: string;
}

export interface HandshakeParams {
  client: string;
  version: string;
  protocol_version: string;
  instance_id: string;
  browser: BrowserPeerInfo;
  label: string;
  /**
   * **Deprecated** — legacy app-semver floor for old daemons. New code
   * sends `"0.0.0"` and ignores on read.
   */
  min_compatible_peer?: string;
  /** Lowest daemon **protocol** version this extension accepts. */
  min_compatible_protocol?: string;
}

export interface HandshakeResult {
  server: string;
  version: string;
  protocol_version: string;
  /** Deprecated legacy app-semver floor; absent on newer daemons. */
  min_compatible_peer?: string;
  /** Protocol floor advertised by the daemon; absent on legacy daemons. */
  min_compatible_protocol?: string;
}

export type ConnectionState = "disconnected" | "connecting" | "connected" | "version_skew";

// --------------------------------------------------------------------------
// M6 tool payloads — mirror bsk-protocol (crates/bsk-protocol/src/tools/*.rs)
// --------------------------------------------------------------------------

export type JavaScriptDialogType = "alert" | "confirm" | "prompt" | "beforeunload";
export type JavaScriptDialogHandledAction = "accepted" | "dismissed";

export interface JavaScriptDialogInfo {
  tab_id: number;
  type: JavaScriptDialogType;
  message: string;
  url?: string;
  default_prompt?: string;
  has_browser_handler?: boolean;
  handled: JavaScriptDialogHandledAction;
  sequence: number;
}

export type ConsoleEntryKind = "console" | "exception" | "log";

export interface ConsoleStackFrame {
  function_name?: string;
  url?: string;
  line?: number;
  column?: number;
}

export interface ConsoleEntry {
  sequence: number;
  kind: ConsoleEntryKind;
  level: string;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp?: number;
  stack_trace?: ConsoleStackFrame[];
  truncated: boolean;
}

export interface ConsoleParams {
  session_id: string;
  tab_id?: number;
  since?: number;
  limit?: number;
  max_text_chars?: number;
  include_stack?: boolean;
}

export interface ConsoleResult {
  tab_id: number;
  entries: ConsoleEntry[];
  next_since: number;
  truncated: boolean;
}

export type TabScopeFilter = "user" | "agent" | "all";

export interface TabInfo {
  tab_id: number;
  title?: string;
  url?: string;
  window_id?: number;
  active?: boolean;
  scope?: "user" | "agent";
}

export interface TabListParams {
  session_id: string;
  scope?: TabScopeFilter;
}

export interface TabListResult {
  tabs: TabInfo[];
}

// --- M8 tab management payloads (M8.1) ---

export interface TabCreateParams {
  session_id: string;
  url?: string;
  active?: boolean;
  index?: number;
}

export interface TabCreateResult {
  tab_id: number;
  window_id: number;
  url: string;
}

export interface TabCloseParams {
  session_id: string;
  tab_id: number;
}

export interface TabCloseResult {
  tab_id: number;
}

export interface TabSelectParams {
  session_id: string;
  tab_id: number;
}

export interface TabSelectResult {
  tab_id: number;
  window_id: number;
}

export interface TabBorrowParams {
  session_id: string;
  tab_id: number;
  confirm?: boolean;
}

export interface TabBorrowResult {
  tab_id: number;
  original_window_id: number;
  original_index: number;
  agent_window_id: number;
}

export interface TabReturnParams {
  session_id: string;
  tab_id: number;
}

export interface TabReturnResult {
  tab_id: number;
  returned_to_window_id: number;
  returned_to_index: number;
  fallback?: boolean;
}

export interface ScreenshotParams {
  session_id: string;
  tab_id?: number;
  /** `@eN` ref from the last `tool.snapshot`. */
  ref?: string;
}

export interface ScreenshotResult {
  image_base64: string;
  width: number;
  height: number;
  format: string;
  tab_id: number;
  dialogs?: JavaScriptDialogInfo[];
}

export interface SnapshotParams {
  session_id: string;
  tab_id?: number;
  max_depth?: number;
  max_tokens?: number;
}

export interface SnapshotResult {
  text: string;
  ref_count: number;
  tab_id: number;
  truncated?: boolean;
  dialogs?: JavaScriptDialogInfo[];
}

export interface GetHtmlParams {
  session_id: string;
  tab_id?: number;
  ref?: string;
  max_bytes?: number;
}

export interface GetHtmlResult {
  html: string;
  truncated?: boolean;
  byte_size: number;
  tab_id: number;
  dialogs?: JavaScriptDialogInfo[];
}

// --------------------------------------------------------------------------
// M7 tool payloads — navigation (mirror bsk-protocol)
// --------------------------------------------------------------------------

export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

export interface NavigateParams {
  session_id: string;
  url: string;
  tab_id?: number;
  wait_until?: WaitUntil;
  timeout_ms?: number;
}

export interface NavigateResult {
  tab_id: number;
  url: string;
  final_url?: string;
  reached: string;
  error_text?: string;
  dialogs?: JavaScriptDialogInfo[];
}

export interface NavigateBackParams {
  session_id: string;
  tab_id?: number;
  wait_until?: WaitUntil;
  timeout_ms?: number;
}

export interface NavigateForwardParams extends NavigateBackParams {}

export interface NavigateHistoryResult {
  tab_id: number;
  previous_url?: string;
  final_url?: string;
  reached: string;
  error_text?: string;
  dialogs?: JavaScriptDialogInfo[];
}

export interface ReloadParams {
  session_id: string;
  tab_id?: number;
  wait_until?: WaitUntil;
  timeout_ms?: number;
  hard?: boolean;
}

export type ReloadResult = NavigateHistoryResult;

// --------------------------------------------------------------------------
// M7 tool payloads — interaction (mirror bsk-protocol)
// --------------------------------------------------------------------------

export type MouseButton = "left" | "middle" | "right";
export type KeyModifier = "alt" | "ctrl" | "meta" | "shift";

export interface ClickParams {
  session_id: string;
  ref?: string;
  selector?: string;
  tab_id?: number;
  button?: MouseButton;
  click_count?: number;
  modifiers?: KeyModifier[];
  timeout_ms?: number;
}

export interface ClickResult {
  tab_id: number;
  used_ref?: string;
  used_selector?: string;
  x: number;
  y: number;
  dialogs?: JavaScriptDialogInfo[];
}

export interface FillParams {
  session_id: string;
  value: string;
  ref?: string;
  selector?: string;
  tab_id?: number;
  clear_before?: boolean;
  timeout_ms?: number;
}

export interface FillResult {
  tab_id: number;
  used_ref?: string;
  used_selector?: string;
  value_length: number;
  dialogs?: JavaScriptDialogInfo[];
}

export interface PressParams {
  session_id: string;
  key: string;
  modifiers?: KeyModifier[];
  ref?: string;
  selector?: string;
  tab_id?: number;
  hold_ms?: number;
  timeout_ms?: number;
}

export interface PressResult {
  tab_id: number;
  key: string;
  code: string;
  modifiers: KeyModifier[];
  dialogs?: JavaScriptDialogInfo[];
}

export interface SelectParams {
  session_id: string;
  values: string[];
  ref?: string;
  selector?: string;
  tab_id?: number;
  timeout_ms?: number;
}

export interface SelectResult {
  tab_id: number;
  used_ref?: string;
  used_selector?: string;
  multiple: boolean;
  selected_values: string[];
  selected_labels: string[];
  dialogs?: JavaScriptDialogInfo[];
}

// --------------------------------------------------------------------------
// M9 tool payloads — evaluate / wait_for_navigation / wait_ms
// --------------------------------------------------------------------------

export interface EvaluateParams {
  session_id: string;
  expression: string;
  tab_id?: number;
  await_promise?: boolean;
  return_by_value?: boolean;
  timeout_ms?: number;
}

export interface EvaluateError {
  text: string;
  line?: number;
  column?: number;
}

export interface EvaluateResult {
  ok: boolean;
  tab_id: number;
  value?: unknown;
  error?: EvaluateError;
  dialogs?: JavaScriptDialogInfo[];
}

export interface WaitForNavigationParams {
  session_id: string;
  tab_id?: number;
  wait_until?: WaitUntil;
  timeout_ms?: number;
}

export type WaitForNavigationReached = WaitUntil | "timeout";

export interface WaitForNavigationResult {
  tab_id: number;
  reached: WaitForNavigationReached;
  error_text?: string;
  dialogs?: JavaScriptDialogInfo[];
}

// --------------------------------------------------------------------------
// Human-in-loop payloads — request_help (mirror bsk-protocol)
// --------------------------------------------------------------------------

export interface HelpTarget {
  ref?: string;
  selector?: string;
}

export type HelpOutcome = "continued" | "cancelled" | "timed_out" | "navigated";

export interface ResolvedTarget {
  matched: boolean;
  ref?: string;
  selector?: string;
}

export interface RequestHelpParams {
  session_id: string;
  tab_id?: number;
  prompt: string;
  title?: string;
  targets?: HelpTarget[];
  timeout_ms?: number;
}

export interface RequestHelpResult {
  outcome: HelpOutcome;
  note?: string;
  tab_id: number;
  resolved_targets?: ResolvedTarget[];
}
