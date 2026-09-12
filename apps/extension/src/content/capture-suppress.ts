/**
 * Content-script side of the capture-suppress bridge: hides the overlay
 * shadow host while the background captures a screenshot.
 *
 * `begin` sets `data-bsk-capture-hidden` on the host (overlay.css maps it
 * to `display: none !important`, which removes the whole shadow subtree
 * from compositing) and only acks after two animation frames — the first
 * frame commits the style change, the second guarantees the compositor
 * has produced a frame without the overlay, so the capture API cannot
 * pick up a stale frame that still contains it. `end` is
 * reference-counted so overlapping captures do not unhide the host early.
 */

import {
  CAPTURE_SUPPRESS,
  type CaptureSuppressAck,
  type CaptureSuppressMessage,
} from "@/lib/capture-suppress-bridge";

export const CAPTURE_HIDDEN_ATTR = "data-bsk-capture-hidden";

/**
 * Safety net for hidden/background tabs where rAF callbacks never fire:
 * the attribute is already set synchronously, so any frame the compositor
 * produces from now on excludes the overlay. Waiting longer would just
 * deadlock the capture.
 */
const FRAME_FALLBACK_MS = 500;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const raf = requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      cancelAnimationFrame(raf);
      resolve();
    }, FRAME_FALLBACK_MS);
  });
}

export interface CaptureSuppressController {
  /**
   * Handle one bridge message. Returns true when the ack is sent
   * asynchronously and the caller must keep the message channel open.
   */
  handleMessage(
    message: CaptureSuppressMessage,
    sendResponse: (ack: CaptureSuppressAck) => void,
  ): boolean;
  /** Re-apply the hidden attribute when the overlay host is (re)mounted. */
  onHostMounted(host: HTMLElement): void;
  /** Number of in-flight `begin` phases (exposed for tests). */
  readonly pendingCount: number;
}

export function createCaptureSuppressController(
  getHost: () => HTMLElement | null,
): CaptureSuppressController {
  let pending = 0;

  const ack: CaptureSuppressAck = { type: CAPTURE_SUPPRESS, ok: true };

  function setHidden(host: HTMLElement | null, hidden: boolean): void {
    if (!host) return;
    if (hidden) host.setAttribute(CAPTURE_HIDDEN_ATTR, "");
    else host.removeAttribute(CAPTURE_HIDDEN_ATTR);
  }

  return {
    get pendingCount() {
      return pending;
    },
    handleMessage(message, sendResponse) {
      if (message.phase === "begin") {
        pending += 1;
        setHidden(getHost(), true);
        void (async () => {
          await nextFrame();
          await nextFrame();
          sendResponse(ack);
        })();
        return true;
      }
      // `end` without a matching `begin` (e.g. a retried message) must not
      // drive the counter negative or clear a concurrent capture's flag.
      pending = Math.max(0, pending - 1);
      if (pending === 0) setHidden(getHost(), false);
      sendResponse(ack);
      return false;
    },
    onHostMounted(host) {
      // Host lost + rebuilt mid-capture: the fresh host must stay hidden
      // until the last `end` arrives.
      setHidden(host, pending > 0);
    },
  };
}
