/**
 * Wire protocol for the human-in-loop overlay, sent between the
 * background service worker and a tab's content script via
 * `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`.
 *
 * Mirrors the borrow-confirmation message style (see
 * `@/tools/borrow-confirmation`). The background asks a specific tab to
 * enter "help mode" (render HelpRequestOverlay + hide ControlOverlay);
 * the content script replies once the user clicks Continue / Cancel.
 */

export const HELP_REQUEST = "bsk-help-request";
export const HELP_RESPONSE = "bsk-help-response";
export const HELP_CANCEL = "bsk-help-cancel";

export interface HelpRequestMessage {
  type: typeof HELP_REQUEST;
  requestId: string;
  prompt: string;
  /** Custom overlay title; omitted when the extension should use its default. */
  title?: string;
  /** CSS selectors to scroll to + flash-highlight (may be empty). */
  selectors: string[];
  timeoutMs: number;
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
