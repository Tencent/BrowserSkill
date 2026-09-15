/**
 * Wire protocol and background-side helper for the "current action" line the
 * control pill shows under 「Agent 正在控制」.
 *
 * The background brackets every browser-input / navigation RPC with a `start`
 * and an `end` message for the target tab, so a human watching the Agent Window
 * can see *what* the agent is doing (click `@e3`, navigate to …, type into
 * `#search`) instead of just that it is doing something. The content script
 * keeps the last `start` until the matching `end`.
 *
 * Purely cosmetic: every method swallows errors (a tab without the content
 * script — chrome://, the Web Store, a closed tab — simply has no pill) and is
 * never able to fail or change the tool result it brackets.
 */

export const ACTION_STATUS_MSG = "bsk/action-status";

/** Longest target string the pill displays; longer values are cut to size. */
export const ACTION_STATUS_MAX_TARGET_CHARS = 60;

export type ActionStatusPhase = "start" | "end";

export interface ActionStatusMessage {
  type: typeof ACTION_STATUS_MSG;
  phase: ActionStatusPhase;
  /** Tool method name as the daemon sends it, e.g. `tool.click`. */
  tool: string;
  /** `@ref`, selector, url or key — truncated to {@link ACTION_STATUS_MAX_TARGET_CHARS}. */
  target?: string;
}

export interface ActionStatusAck {
  type: typeof ACTION_STATUS_MSG;
  ok: true;
}

export function isActionStatusMessage(msg: unknown): msg is ActionStatusMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.type !== ACTION_STATUS_MSG) return false;
  if (m.phase !== "start" && m.phase !== "end") return false;
  if (typeof m.tool !== "string") return false;
  return m.target === undefined || typeof m.target === "string";
}

/** Trim a target to the pill's budget; the CSS adds the ellipsis. */
export function truncateActionTarget(value: string): string {
  return value.length > ACTION_STATUS_MAX_TARGET_CHARS
    ? value.slice(0, ACTION_STATUS_MAX_TARGET_CHARS)
    : value;
}

/** Minimal `chrome.tabs.sendMessage` surface so tests can inject a fake. */
export type ActionStatusSendToTab = (
  tabId: number,
  message: ActionStatusMessage,
) => Promise<unknown>;

const defaultSendToTab: ActionStatusSendToTab = (tabId, message) =>
  chrome.tabs.sendMessage(tabId, message);

export interface ActionStatusNotifier {
  /** Announce the tool the agent just started running against `tabId`. */
  start(tabId: number, tool: string, target?: string): Promise<void>;
  /** Clear the action line. Reuses the tool remembered by `start` when omitted. */
  end(tabId: number, tool?: string): Promise<void>;
}

export function createActionStatusNotifier(
  sendToTab: ActionStatusSendToTab = defaultSendToTab,
): ActionStatusNotifier {
  /** Tool currently in flight per tab, so `end` can name it without bookkeeping. */
  const inflight = new Map<number, string>();

  /** Never throws: a failed delivery just means no action line in that tab. */
  async function deliver(tabId: number, message: ActionStatusMessage): Promise<void> {
    try {
      await sendToTab(tabId, message);
    } catch (err) {
      console.debug("[bsk action status] message dropped", err);
    }
  }

  return {
    async start(tabId, tool, target) {
      inflight.set(tabId, tool);
      await deliver(tabId, {
        type: ACTION_STATUS_MSG,
        phase: "start",
        tool,
        ...(target ? { target } : {}),
      });
    },

    async end(tabId, tool) {
      const resolved = tool ?? inflight.get(tabId) ?? "";
      inflight.delete(tabId);
      await deliver(tabId, { type: ACTION_STATUS_MSG, phase: "end", tool: resolved });
    },
  };
}
