/**
 * Wire protocol for `chrome.runtime.sendMessage`-driven communication
 * between the content-script control overlay and the background SW.
 *
 * Content script → background:
 *  - `{ kind: "overlay.who_am_i", tabId, windowId }` → background
 *      replies `{ sessionId: string | null }` so the overlay knows
 *      whether to render itself.
 *  - `{ kind: "overlay.interrupt", sessionId }` → background asks the
 *      daemon (via a `session.user_interrupt` WS event) to cancel
 *      every inflight + queued tool call for that session with
 *      `ErrorCode::UserAborted`. The Agent Window, CDP attachment,
 *      and conversation context are preserved.
 */

export const OVERLAY_MSG_WHO_AM_I = "overlay.who_am_i";
export const OVERLAY_MSG_INTERRUPT = "overlay.interrupt";

export interface OverlayWhoAmIRequest {
  kind: typeof OVERLAY_MSG_WHO_AM_I;
  tabId?: number;
  windowId?: number;
}

export interface OverlayWhoAmIResponse {
  sessionId: string | null;
}

export interface OverlayInterruptRequest {
  kind: typeof OVERLAY_MSG_INTERRUPT;
  sessionId: string;
}

export interface OverlayInterruptResponse {
  ok: boolean;
}

/** Background → content: temporarily disable overlay click blocker for CDP clicks. */
export const OVERLAY_AUTOMATION_BYPASS = "bh-automation-bypass";

export interface OverlayAutomationBypassMessage {
  type: typeof OVERLAY_AUTOMATION_BYPASS;
  enabled: boolean;
}

/** Background → content: clear overlays that belong only inside an Agent tab. */
export const OVERLAY_AGENT_OVERLAY_RESET = "bh-agent-overlay-reset";

export interface OverlayAgentOverlayResetMessage {
  type: typeof OVERLAY_AGENT_OVERLAY_RESET;
  sessionId: string;
}

export function isOverlayAgentOverlayResetMessage(
  message: unknown,
): message is OverlayAgentOverlayResetMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { type?: unknown; sessionId?: unknown };
  return candidate.type === OVERLAY_AGENT_OVERLAY_RESET && typeof candidate.sessionId === "string";
}

export type OverlayMessage = OverlayWhoAmIRequest | OverlayInterruptRequest;
