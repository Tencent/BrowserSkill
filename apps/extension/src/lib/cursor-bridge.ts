/**
 * Wire protocol and background-side helper for the cosmetic in-page agent
 * cursor.
 *
 * CDP `Input.dispatchMouseEvent` moves the real pointer instantly and
 * invisibly, so a human watching the Agent Window cannot tell that the agent
 * clicked or hovered anything. The background sends one `bsk/cursor` message
 * per action to the tab's content script, which glides a virtual cursor to the
 * target before the CDP event fires and ripples on click.
 *
 * The cursor is purely cosmetic: every method swallows errors (a tab without
 * the content script — chrome://, the Web Store, a closed tab — simply has no
 * cursor) and is never able to fail or delay an agent action beyond its own
 * animation. Coordinates are viewport CSS pixels, the same space
 * `Input.dispatchMouseEvent` takes.
 */

export const CURSOR_MSG = "bsk/cursor";

/** Longest wait a `move` may add before the real CDP event is dispatched. */
export const CURSOR_MAX_ANIMATION_MS = 800;

/** ms of glide per pixel of travel. */
const MOVE_MS_PER_PX = 0.6;
const MOVE_MIN_MS = 120;
const MOVE_MAX_MS = 500;

/** Viewport CSS-pixel point, identical to the CDP input coordinate space. */
export interface CursorPoint {
  x: number;
  y: number;
}

export type CursorButton = "left" | "right" | "middle";

export interface CursorMoveMessage {
  type: typeof CURSOR_MSG;
  action: "move";
  x: number;
  y: number;
  durationMs: number;
  label?: string;
}

export interface CursorClickMessage {
  type: typeof CURSOR_MSG;
  action: "click";
  x: number;
  y: number;
  button?: CursorButton;
}

export interface CursorHideMessage {
  type: typeof CURSOR_MSG;
  action: "hide";
}

export type CursorMessage = CursorMoveMessage | CursorClickMessage | CursorHideMessage;

export interface CursorAck {
  type: typeof CURSOR_MSG;
  ok: true;
}

export function isCursorMessage(msg: unknown): msg is CursorMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.type !== CURSOR_MSG) return false;
  if (m.action === "hide") return true;
  if (typeof m.x !== "number" || typeof m.y !== "number") return false;
  if (m.action === "move") return typeof m.durationMs === "number";
  if (m.action === "click") {
    return (
      m.button === undefined || m.button === "left" || m.button === "right" || m.button === "middle"
    );
  }
  return false;
}

/**
 * Glide time for a move. The first move of a session (`from` unknown) is
 * instant; afterwards the duration scales with the distance travelled so short
 * hops stay snappy and long jumps stay visible, clamped to 120–500 ms.
 */
export function cursorMoveDuration(from: CursorPoint | null | undefined, to: CursorPoint): number {
  if (!from) return 0;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (!Number.isFinite(distance)) return 0;
  return Math.round(Math.min(Math.max(distance * MOVE_MS_PER_PX, MOVE_MIN_MS), MOVE_MAX_MS));
}

/** Minimal `chrome.tabs.sendMessage` surface so tests can inject a fake. */
export type CursorSendToTab = (tabId: number, message: CursorMessage) => Promise<unknown>;

const defaultSendToTab: CursorSendToTab = (tabId, message) =>
  chrome.tabs.sendMessage(tabId, message);

export interface CursorVisualizer {
  move(
    tabId: number,
    point: CursorPoint,
    opts?: { durationMs?: number; label?: string },
  ): Promise<void>;
  click(tabId: number, point: CursorPoint, opts?: { button?: CursorButton }): Promise<void>;
  hide(tabId: number): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCursorVisualizer(
  sendToTab: CursorSendToTab = defaultSendToTab,
): CursorVisualizer {
  /** Returns whether the tab actually accepted the message. Never throws. */
  async function deliver(tabId: number, message: CursorMessage): Promise<boolean> {
    try {
      await sendToTab(tabId, message);
      return true;
    } catch (err) {
      // No content script in the target tab (chrome://, the Web Store, a tab
      // that just closed) → there is no cursor to drive. The action proceeds.
      console.debug("[bsk cursor] message dropped", err);
      return false;
    }
  }

  return {
    async move(tabId, point, opts = {}) {
      const durationMs = Math.min(Math.max(opts.durationMs ?? 0, 0), CURSOR_MAX_ANIMATION_MS);
      const message: CursorMoveMessage = {
        type: CURSOR_MSG,
        action: "move",
        x: point.x,
        y: point.y,
        durationMs,
        ...(opts.label ? { label: opts.label } : {}),
      };
      if (!(await deliver(tabId, message))) return;
      // Give the glide time to be seen before the real CDP event fires.
      if (durationMs > 0) await delay(durationMs);
    },

    async click(tabId, point, opts = {}) {
      const message: CursorClickMessage = {
        type: CURSOR_MSG,
        action: "click",
        x: point.x,
        y: point.y,
        ...(opts.button ? { button: opts.button } : {}),
      };
      await deliver(tabId, message);
    },

    async hide(tabId) {
      await deliver(tabId, { type: CURSOR_MSG, action: "hide" });
    },
  };
}
