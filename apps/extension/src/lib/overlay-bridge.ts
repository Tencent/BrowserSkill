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

/**
 * WXT shadow-host element name (`createShadowRootUi({ name })`) and the marker
 * attribute set on the host for the agent's own overlay UI. The VOM capture
 * adapter uses these to skip the overlay host and its shadow subtree.
 */
export const OVERLAY_HOST_NAME = "browser-skill-overlay";
export const OVERLAY_HOST_MARKER_ATTR = "data-bsk-overlay";

/** CSS selector for the WXT shadow host (tag + marker attribute). */
export const OVERLAY_HOST_SELECTOR = `${OVERLAY_HOST_NAME}, [${OVERLAY_HOST_MARKER_ATTR}]`;

export function isOverlayHostElementName(tagName: string): boolean {
  return tagName.toLowerCase() === OVERLAY_HOST_NAME;
}

export function isOverlayHostMarkerAttribute(attrName: string): boolean {
  return attrName.toLowerCase() === OVERLAY_HOST_MARKER_ATTR;
}

export function isOverlayHostNode(tagName: string, attributeNames?: Iterable<string>): boolean {
  if (isOverlayHostElementName(tagName)) return true;
  if (!attributeNames) return false;
  for (const name of attributeNames) {
    if (isOverlayHostMarkerAttribute(name)) return true;
  }
  return false;
}

/** Page-world `document.querySelector(...)` for the overlay shadow host. */
export const OVERLAY_HOST_LOOKUP_EXPR = `document.querySelector(${JSON.stringify(OVERLAY_HOST_SELECTOR)})`;

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
