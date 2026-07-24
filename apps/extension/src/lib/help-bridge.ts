/**
 * Wire protocol for the human-in-loop overlay, sent between the
 * background service worker and a tab's content script via
 * `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`.
 *
 * Mirrors the borrow-confirmation message style (see
 * `@/tools/borrow-confirmation`). The background asks a specific tab to
 * enter "help mode" (render HelpRequestOverlay + hide ControlOverlay);
 * the content script acks display, then later reports Done / Cancel.
 */

export const HELP_REQUEST = "bsk-help-request";
export const HELP_RESPONSE = "bsk-help-response";
export const HELP_CANCEL = "bsk-help-cancel";
export const HELP_ACK = "bsk-help-ack";
export const HELP_QUERY = "bsk-help-query";
export const HELP_FINISH = "bsk-help-finish";

export interface HelpRequestMessage {
  type: typeof HELP_REQUEST;
  requestId: string;
  prompt: string;
  /** Custom overlay title; omitted when the extension should use its default. */
  title?: string;
  /** Full task UI on the subject tab; compact status UI on related tabs. */
  displayMode?: "full" | "compact";
  /** CSS selectors to scroll to + flash-highlight (may be empty). */
  selectors: string[];
  timeoutMs: number;
}

export interface HelpAckMessage {
  type: typeof HELP_ACK;
  ok: true;
}

export interface HelpResponseMessage {
  type: typeof HELP_RESPONSE;
  outcome: "continued" | "cancelled";
  note?: string;
}

export interface HelpCancelMessage {
  type: typeof HELP_CANCEL;
  requestId: string;
}

export interface HelpQueryMessage {
  type: typeof HELP_QUERY;
}

export interface HelpQueryResponse {
  active: boolean;
  request?: Omit<HelpRequestMessage, "type">;
}

export interface HelpFinishMessage {
  type: typeof HELP_FINISH;
  requestId: string;
  outcome: "continued" | "cancelled";
  note?: string;
}

export function isHelpRequestMessage(msg: unknown): msg is HelpRequestMessage {
  if (typeof msg !== "object" || msg === null) {
    return false;
  }
  const m = msg as Record<string, unknown>;
  return (
    m.type === HELP_REQUEST &&
    typeof m.requestId === "string" &&
    typeof m.prompt === "string" &&
    (m.title === undefined || typeof m.title === "string") &&
    (m.displayMode === undefined || m.displayMode === "full" || m.displayMode === "compact") &&
    Array.isArray(m.selectors) &&
    m.selectors.every((selector) => typeof selector === "string") &&
    typeof m.timeoutMs === "number"
  );
}

export function isHelpCancelMessage(msg: unknown): msg is HelpCancelMessage {
  if (typeof msg !== "object" || msg === null) {
    return false;
  }
  const m = msg as Record<string, unknown>;
  return m.type === HELP_CANCEL && typeof m.requestId === "string";
}

export function isHelpResponseMessage(msg: unknown): msg is HelpResponseMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.type === HELP_RESPONSE &&
    (m.outcome === "continued" || m.outcome === "cancelled") &&
    (m.note === undefined || typeof m.note === "string")
  );
}

export function isHelpAckMessage(msg: unknown): msg is HelpAckMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === HELP_ACK && m.ok === true;
}

export function isHelpQueryMessage(msg: unknown): msg is HelpQueryMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === HELP_QUERY;
}

export function isHelpFinishMessage(msg: unknown): msg is HelpFinishMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.type === HELP_FINISH &&
    typeof m.requestId === "string" &&
    (m.outcome === "continued" || m.outcome === "cancelled") &&
    (m.note === undefined || typeof m.note === "string")
  );
}
