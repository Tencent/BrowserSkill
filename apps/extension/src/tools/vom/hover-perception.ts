import type { CdpRunner } from "../shared";

function abortError(): Error {
  const error = new Error("hover perception aborted");
  error.name = "AbortError";
  return error;
}

export async function waitForHover(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function clearHover(cdp: CdpRunner, tabId: number): Promise<void> {
  await cdp
    .send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: -10,
      y: -10,
    })
    .catch(() =>
      cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 }).catch(() => {
        // Best effort cleanup.
      }),
    );
}

/**
 * Wall-clock budget for a probe phase.
 *
 * Callers ask whether the *next* candidate still fits before starting it,
 * rather than checking elapsed time at the top of the loop. A top-of-loop
 * check lets a candidate start with 1ms of budget left and then run to
 * completion, overshooting by a full settle window.
 */
export class ProbeBudget {
  private readonly startedAt = Date.now();

  constructor(private readonly totalMs: number) {}

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** True when a candidate costing `estimatedMs` still fits in the budget. */
  canAfford(estimatedMs: number): boolean {
    return this.elapsedMs + estimatedMs <= this.totalMs;
  }
}

export type OverlayBypass = (tabId: number, enabled: boolean) => Promise<void>;

export interface OverlayBypassScopeOptions {
  /**
   * Called when the overlay could not be restored. Defaults to `console.error`
   * so a stuck-bypassed overlay is never silent; tests inject a spy.
   */
  onRestoreFailure?: (error: unknown) => void;
}

const overlayBypassDepth = new Map<number, number>();

/**
 * Runs `body` with the agent overlay bypassed, restoring it afterwards.
 *
 * Reference counted per tab so nested probe phases share a single bypass span
 * instead of toggling the overlay once per phase. Restore failures are
 * reported rather than swallowed, and the depth is released even when restore
 * throws so a failure cannot pin the overlay off for the tab's lifetime.
 */
export async function withOverlayBypass<T>(
  bypass: OverlayBypass | undefined,
  tabId: number,
  body: () => Promise<T>,
  options: OverlayBypassScopeOptions = {},
): Promise<T> {
  if (!bypass) return body();

  const depth = overlayBypassDepth.get(tabId) ?? 0;
  overlayBypassDepth.set(tabId, depth + 1);
  if (depth === 0) {
    try {
      await bypass(tabId, true);
    } catch (error) {
      // Failing to hide the overlay only risks probing our own UI, so continue.
      console.debug("[bsk hover] overlay bypass could not be enabled", error);
    }
  }

  try {
    return await body();
  } finally {
    const current = overlayBypassDepth.get(tabId) ?? 1;
    if (current <= 1) {
      overlayBypassDepth.delete(tabId);
      try {
        await bypass(tabId, false);
      } catch (error) {
        (options.onRestoreFailure ?? defaultRestoreFailure)(error);
      }
    } else {
      overlayBypassDepth.set(tabId, current - 1);
    }
  }
}

function defaultRestoreFailure(error: unknown): void {
  console.error("[bsk hover] agent overlay could not be restored after probing", error);
}

/** Test seam: drops any bypass depth left behind by a crashed probe. */
export function resetOverlayBypassDepth(): void {
  overlayBypassDepth.clear();
}
