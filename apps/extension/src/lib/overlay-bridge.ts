/**
 * Wire protocol for `chrome.runtime.sendMessage`-driven communication
 * between the content-script control overlay and the background SW.
 *
 * Content script → background:
 *  - `{ kind: "overlay.ready" }` → background decides the per-tab state first
 *      (see overlayStateForTab) and pushes the authoritative overlay state for
 *      that tab. It also proactively pushes on tab create and control-mode
 *      change, so a tab usually receives state before it ever sends ready.
 *  - `{ kind: "overlay.interrupt", sessionId }` → background asks the
 *      daemon (via a `session.user_interrupt` WS event) to cancel
 *      every inflight + queued tool call for that session with
 *      `ErrorCode::UserAborted`. The Agent Window, CDP attachment,
 *      and conversation context are preserved.
 */

export const OVERLAY_MSG_WHO_AM_I = "overlay.who_am_i";
export const OVERLAY_MSG_READY = "overlay.ready";
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

export interface OverlayReadyRequest {
  kind: typeof OVERLAY_MSG_READY;
}

export type OverlayMode = "control" | "interrupting" | "paused" | "hidden";

/** Background → content: complete, authoritative control-overlay state. */
export const OVERLAY_AGENT_STATE = "bh-agent-overlay-state";

/**
 * Orders the overlay state and reset messages one background worker sends:
 * `generation` counts them, and `epoch` names the worker instance, whose
 * counter starts over when the worker restarts.
 */
export interface OverlayVersion {
  epoch: string;
  generation: number;
}

export interface OverlayAgentStateMessage extends OverlayVersion {
  type: typeof OVERLAY_AGENT_STATE;
  sessionId: string | null;
  mode: OverlayMode;
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

export interface OverlayAgentOverlayResetMessage extends OverlayVersion {
  type: typeof OVERLAY_AGENT_OVERLAY_RESET;
  sessionId: string;
}

function isOverlayVersion(candidate: { epoch?: unknown; generation?: unknown }): boolean {
  return typeof candidate.epoch === "string" && typeof candidate.generation === "number";
}

export function isOverlayAgentOverlayResetMessage(
  message: unknown,
): message is OverlayAgentOverlayResetMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as {
    type?: unknown;
    sessionId?: unknown;
    epoch?: unknown;
    generation?: unknown;
  };
  return (
    candidate.type === OVERLAY_AGENT_OVERLAY_RESET &&
    typeof candidate.sessionId === "string" &&
    isOverlayVersion(candidate)
  );
}

/**
 * Page side: admits overlay state and reset messages in the order the
 * background worker sent them, dropping one that arrives after a newer one.
 * A late `control` state after a newer `hidden` state or reset would
 * otherwise pin the full-viewport blocker on the page. A message from
 * another worker instance is newer, as a worker never outlives its
 * successor, and messages from the instance it replaced stay dropped.
 */
export class OverlayVersionGate {
  private last: OverlayVersion | null = null;
  private readonly retiredEpochs = new Set<string>();

  /** Whether the message with this version is current; records it if so. */
  admit(version: OverlayVersion): boolean {
    const last = this.last;
    if (last && version.epoch === last.epoch) {
      // The same message again, such as a re-sent state, is still current.
      if (version.generation < last.generation) return false;
    } else if (this.retiredEpochs.has(version.epoch)) {
      return false;
    } else if (last) {
      this.retiredEpochs.add(last.epoch);
    }
    this.last = { epoch: version.epoch, generation: version.generation };
    return true;
  }
}

export function isOverlayAgentStateMessage(message: unknown): message is OverlayAgentStateMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as {
    type?: unknown;
    sessionId?: unknown;
    mode?: unknown;
    epoch?: unknown;
    generation?: unknown;
  };
  return (
    candidate.type === OVERLAY_AGENT_STATE &&
    (typeof candidate.sessionId === "string" || candidate.sessionId === null) &&
    (candidate.mode === "control" ||
      candidate.mode === "interrupting" ||
      candidate.mode === "paused" ||
      candidate.mode === "hidden") &&
    isOverlayVersion(candidate)
  );
}

export type OverlayMessage = OverlayWhoAmIRequest | OverlayReadyRequest | OverlayInterruptRequest;
