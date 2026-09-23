/** Click-only hit-test suppression; independent of screenshot visibility and hover bypass. */
export const INPUT_PASSTHROUGH = "bsk/input-passthrough";
export const INPUT_PASSTHROUGH_ATTR = "data-bsk-input-passthrough";

export interface InputPassthroughMessage {
  type: typeof INPUT_PASSTHROUGH;
  phase: "begin" | "end";
  /** Identifies one click so cleanup after a lost ack cannot release another click. */
  id: string;
}

export interface InputPassthroughAck {
  type: typeof INPUT_PASSTHROUGH;
  ok: true;
}

export function isInputPassthroughMessage(message: unknown): message is InputPassthroughMessage {
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  return (
    m.type === INPUT_PASSTHROUGH &&
    (m.phase === "begin" || m.phase === "end") &&
    typeof m.id === "string" &&
    m.id.length > 0
  );
}

export type InputPassthroughSendToTab = (
  tabId: number,
  message: InputPassthroughMessage,
) => Promise<unknown>;

export const sendInputPassthrough: InputPassthroughSendToTab = (tabId, message) =>
  chrome.tabs.sendMessage(tabId, message);
