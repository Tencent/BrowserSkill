import type { RpcErrorData, RpcErrorReason } from "@/transport/types";
import type { CdpDebuggee } from "./chromium-cdp";

// Renderer reads that observation issues on the agent's behalf. A read that
// chrome.debugger has already dispatched cannot be cancelled: the deadline
// only ends the caller's wait, ignores the late reply and lets the capture
// pipeline stop instead of issuing fallback reads against the same
// unresponsive page. Mutations, screenshots and user-requested waits keep
// their own limits.
const RENDERER_READS = new Set([
  "DOMSnapshot.enable",
  "DOMSnapshot.captureSnapshot",
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Page.getLayoutMetrics",
  "Page.getFrameTree",
  "DOM.getFrameOwner",
]);
// Answered by the browser process; bounded so attach and frame discovery
// cannot hang, but its timeout says nothing about the renderer.
const READ_COMMANDS = new Set([...RENDERER_READS, "Target.setAutoAttach"]);
export const READ_TIMEOUT_MS = 10_000;
const SLOW_COMMAND_MS = 2_000;
/** `data.reason` reported to gateways for a renderer that stopped answering. */
export const RENDERER_READ_TIMEOUT: RpcErrorReason = "renderer_read_timeout";
const RECOVERY =
  "Do not repeat the same read on this tab; switch tab, navigate elsewhere, or finish the turn and report the unresponsive page.";

export function isRendererRead(method: string): boolean {
  return RENDERER_READS.has(method);
}

export class CdpReadTimeoutError extends Error {
  constructor(method: string, tabId: number | undefined, timeout: number) {
    super(
      `Browser read ${method} timed out after ${timeout}ms (tab ${tabId}); the renderer is not answering. ${RECOVERY}`,
    );
    this.name = "CdpReadTimeoutError";
  }

  /** A read refused because an earlier, timed-out read on the tab is still
   * running in Chrome. Queueing behind it would only add another deadline. */
  static stillPending(method: string, tabId: number | undefined): CdpReadTimeoutError {
    const error = new CdpReadTimeoutError(method, tabId, 0);
    error.message = `Browser read ${method} refused: an earlier read on tab ${tabId} is still running in the renderer. ${RECOVERY}`;
    return error;
  }
}

/** RPC error details for a timed-out renderer read; empty for other errors. */
export function readTimeoutDetails(error: unknown): { data?: RpcErrorData } {
  return error instanceof Error && error.name === "CdpReadTimeoutError"
    ? { data: { reason: RENDERER_READ_TIMEOUT } }
    : {};
}

export async function runCdpCommand<T>(
  target: CdpDebuggee,
  method: string,
  run: () => Promise<T>,
  onTimeout?: (pending: Promise<unknown>) => void,
): Promise<T> {
  const started = Date.now();
  let timedOut = false;
  const details = () => ({
    tabId: target.tabId,
    frameSessionId: target.sessionId,
    method,
    elapsedMs: Date.now() - started,
  });
  const settled = (outcome: "returned" | "failed") => {
    if (Date.now() - started < SLOW_COMMAND_MS) return;
    // A reply after the deadline proves Chrome was still busy, not detached.
    const log = timedOut ? console.warn : console.debug;
    log("[bsk cdp] slow command settled", { ...details(), outcome, late: timedOut });
  };
  const pending = run().then(
    (value) => {
      settled("returned");
      return value;
    },
    (error) => {
      settled("failed");
      throw error;
    },
  );
  if (!READ_COMMANDS.has(method)) return pending;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          timedOut = true;
          console.warn("[bsk cdp] read timed out", details());
          // The race already observes `pending`; a late rejection is handled.
          onTimeout?.(pending);
          reject(new CdpReadTimeoutError(method, target.tabId, READ_TIMEOUT_MS));
        }, READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
