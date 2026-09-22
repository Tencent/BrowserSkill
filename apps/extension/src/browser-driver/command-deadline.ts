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
export const CAPTURE_READ_TIMEOUT_MS = 20_000;
const SLOW_COMMAND_MS = 2_000;
/** Compatibility reason for bounded CDP reads, including browser-side attach
 * and reads refused behind a pending command. `phase` distinguishes these. */
export const RENDERER_READ_TIMEOUT: RpcErrorReason = "renderer_read_timeout";
const RECOVERY =
  "Do not retry reads on this tab while the earlier command is pending. Navigation alone does not clear the read gate; it reopens when the command settles or its debugger session detaches. Use another tab or report the unavailable read.";

export function isRendererRead(method: string): boolean {
  return RENDERER_READS.has(method);
}

// Frame discovery opts into a deadline; navigation's frame-tree reads retain
// their caller's budget. These other capture queries need no new deadline, but
// must not be queued behind a read that is still running after its timeout.
const GUARDED_READS = new Set([
  ...READ_COMMANDS,
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.describeNode",
  "DOM.resolveNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
]);

export class CdpReadTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly tabId: number | undefined,
    timeout: number,
    readonly sessionId?: string,
    readonly phase: "deadline" | "blocked" = "deadline",
  ) {
    super(
      `Browser read ${method} timed out after ${timeout}ms (tab ${tabId}); the ${isRendererRead(method) ? "renderer" : "browser"} is not answering. ${RECOVERY}`,
    );
    this.name = "CdpReadTimeoutError";
  }

  /** A read refused because an earlier, timed-out read on the tab is still
   * running in Chrome. Queueing behind it would only add another deadline. */
  static stillPending(
    method: string,
    tabId: number | undefined,
    sessionId?: string,
  ): CdpReadTimeoutError {
    const error = new CdpReadTimeoutError(method, tabId, 0, sessionId, "blocked");
    error.message = `Browser read ${method} refused: an earlier read on tab ${tabId} is still pending in Chrome. ${RECOVERY}`;
    return error;
  }
}

/** Retain the existing reason while distinguishing deadlines from refused reads. */
export function readTimeoutDetails(error: unknown): { data?: RpcErrorData } {
  return error instanceof Error && error.name === "CdpReadTimeoutError"
    ? {
        data: {
          reason: RENDERER_READ_TIMEOUT,
          ...(error instanceof CdpReadTimeoutError
            ? {
                phase: error.phase,
                method: error.method,
                ...(error.phase === "deadline"
                  ? {
                      process: error.method === "Target.setAutoAttach" ? "browser" : "renderer",
                    }
                  : {}),
              }
            : {}),
        },
      }
    : {};
}

/** Only Chrome settling the original command (or detaching its session) opens
 * this gate. A caller timing out does not cancel that command. */
export class CdpReadGate {
  private readonly tabs = new Map<number | undefined, Map<string, Set<CdpReadTimeoutError>>>();

  run<T>(
    target: CdpDebuggee,
    method: string,
    run: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> {
    let sessions = this.tabs.get(target.tabId);
    if (!sessions) this.tabs.set(target.tabId, (sessions = new Map()));
    const key = target.sessionId ?? "root";
    let blocked = sessions.get(key);
    if (!blocked) sessions.set(key, (blocked = new Set()));
    const error = sessions.get("root")?.values().next().value ?? blocked.values().next().value;
    if (error && GUARDED_READS.has(method))
      return Promise.reject(
        CdpReadTimeoutError.stillPending(method, target.tabId, error.sessionId),
      );
    let timeout: CdpReadTimeoutError | undefined;
    // Capture the set, so an old reply cannot modify a replacement attachment.
    return runCdpCommand(target, method, run, timeoutMs, {
      timedOut: (error) => {
        timeout = error;
        blocked.add(error);
      },
      settled: () => {
        if (timeout) blocked.delete(timeout);
      },
    });
  }

  reset(tabId: number, sessionId?: string): void {
    if (sessionId) this.tabs.get(tabId)?.delete(sessionId);
    else this.tabs.delete(tabId);
  }

  clear(): void {
    this.tabs.clear();
  }
}

export async function runCdpCommand<T>(
  target: CdpDebuggee,
  method: string,
  run: () => Promise<T>,
  timeoutMs = method === "DOMSnapshot.captureSnapshot" || method === "Accessibility.getFullAXTree"
    ? CAPTURE_READ_TIMEOUT_MS
    : method !== "Page.getFrameTree" && READ_COMMANDS.has(method)
      ? READ_TIMEOUT_MS
      : undefined,
  lifecycle?: { timedOut(error: CdpReadTimeoutError): void; settled(): void },
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
    lifecycle?.settled();
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
  if (timeoutMs === undefined) return pending;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          timedOut = true;
          console.warn("[bsk cdp] read timed out", details());
          const error = new CdpReadTimeoutError(method, target.tabId, timeoutMs, target.sessionId);
          lifecycle?.timedOut(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
