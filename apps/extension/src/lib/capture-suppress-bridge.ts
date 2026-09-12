/**
 * Wire protocol and background-side helper for temporarily excluding the
 * extension's in-page overlay. Screenshots use it to avoid captured chrome;
 * coordinate-driven native input uses it so Chrome hit-tests the page.
 *
 * The background wraps each bounded operation in `withExtensionOverlayHidden`,
 * which sends `begin` (the content script hides the overlay host and only
 * acks once the compositor has produced an overlay-free frame) and always
 * follows up with `end`, even when the capture throws. Tabs without the
 * content script (chrome://, the Web Store, ...) host no overlay, so a
 * failed `begin` falls through to capturing directly.
 */

export const CAPTURE_SUPPRESS = "bsk/capture-suppress";

export type CaptureSuppressPhase = "begin" | "end";

export interface CaptureSuppressMessage {
  type: typeof CAPTURE_SUPPRESS;
  phase: CaptureSuppressPhase;
}

export interface CaptureSuppressAck {
  type: typeof CAPTURE_SUPPRESS;
  ok: true;
}

export function isCaptureSuppressMessage(msg: unknown): msg is CaptureSuppressMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return m.type === CAPTURE_SUPPRESS && (m.phase === "begin" || m.phase === "end");
}

/** Minimal `chrome.tabs.sendMessage` surface so tests can inject a fake. */
export type CaptureSuppressSendToTab = (
  tabId: number,
  message: CaptureSuppressMessage,
) => Promise<unknown>;

const defaultSendToTab: CaptureSuppressSendToTab = (tabId, message) =>
  chrome.tabs.sendMessage(tabId, message);

/**
 * Run `fn` with the target tab's overlay hidden. `end` is sent from a
 * `finally` so the overlay always reappears, and a missing content script
 * (or any other `begin` failure) simply skips suppression — there is no
 * overlay to hide in that tab.
 */
export async function withExtensionOverlayHidden<T>(
  tabId: number,
  fn: () => Promise<T>,
  sendToTab: CaptureSuppressSendToTab = defaultSendToTab,
): Promise<T> {
  let began = false;
  try {
    await sendToTab(tabId, { type: CAPTURE_SUPPRESS, phase: "begin" });
    began = true;
  } catch {
    // No content script in the target tab → no overlay can leak into the
    // capture; proceed without suppression.
  }
  try {
    return await fn();
  } finally {
    if (began) {
      await sendToTab(tabId, { type: CAPTURE_SUPPRESS, phase: "end" }).catch((err) => {
        console.debug("[bsk capture] overlay restore failed", err);
      });
    }
  }
}
