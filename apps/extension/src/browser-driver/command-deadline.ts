import type { CdpDebuggee } from "./chromium-cdp";

// Renderer reads that observation issues on the agent's behalf. A read that
// chrome.debugger has already dispatched cannot be cancelled: the deadline
// only ends the caller's wait, ignores the late reply and lets the capture
// pipeline stop instead of issuing fallback reads against the same
// unresponsive page. Mutations, screenshots and user-requested waits keep
// their own limits.
const READ_COMMANDS = new Set([
  "Target.setAutoAttach",
  "DOMSnapshot.enable",
  "DOMSnapshot.captureSnapshot",
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Page.getLayoutMetrics",
  "Page.getFrameTree",
  "DOM.getFrameOwner",
]);
export const READ_TIMEOUT_MS = 10_000;
const SLOW_COMMAND_MS = 2_000;

export class CdpReadTimeoutError extends Error {
  constructor(method: string, tabId: number | undefined, timeout: number) {
    super(
      `Browser read ${method} timed out after ${timeout}ms (tab ${tabId}). Do not repeat the same read in a loop; report the timeout and let the browser task release control before retrying.`,
    );
    this.name = "CdpReadTimeoutError";
  }
}

export async function runCdpCommand<T>(
  target: CdpDebuggee,
  method: string,
  run: () => Promise<T>,
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
          reject(new CdpReadTimeoutError(method, target.tabId, READ_TIMEOUT_MS));
        }, READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
