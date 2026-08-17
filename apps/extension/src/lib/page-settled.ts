// Deciding *when* a page is worth observing.
//
// A fixed delay cannot serve both a modal that toggles in one frame and a
// route change that renders for a second. Instead of guessing, ask the page:
// a document that has stopped mutating and is no longer loading is done
// reacting to whatever the user just did.

import type { CdpRunner } from "@/tools/shared";
import { SETTLE_MAX_MS, SETTLE_MIN_MS, SETTLE_POLL_MS, SETTLE_QUIET_MS } from "./record-constants";

/**
 * Installed once per document. Records only the timestamp of the last DOM
 * change so each poll stays O(1) no matter how large the page is.
 */
const QUIET_PROBE = `(() => {
  const scope = window;
  let probe = scope.__bskRecordQuiet;
  if (!probe) {
    probe = { changedAt: Date.now() };
    const observer = new MutationObserver(() => {
      probe.changedAt = Date.now();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    scope.__bskRecordQuiet = probe;
  }
  return { idleMs: Date.now() - probe.changedAt, readyState: document.readyState };
})()`;

export type SettleOutcome =
  /** The page stopped changing on its own. */
  | "quiet"
  /** Still changing when the budget ran out; observe it as it is. */
  | "timeout"
  /** A newer action took over; this observation is no longer wanted. */
  | "cancelled";

interface QuietProbe {
  idleMs: number;
  readyState: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readQuietProbe(cdp: CdpRunner, tabId: number): Promise<QuietProbe | null> {
  try {
    const reply = await cdp.send<{ result?: { value?: unknown } }>(tabId, "Runtime.evaluate", {
      expression: QUIET_PROBE,
      returnByValue: true,
    });
    const value = reply.result?.value;
    if (!value || typeof value !== "object") return null;
    const { idleMs, readyState } = value as { idleMs?: unknown; readyState?: unknown };
    if (typeof idleMs !== "number" || typeof readyState !== "string") return null;
    return { idleMs, readyState };
  } catch {
    // An unreadable page is a page mid-swap; that is a reason to keep waiting,
    // not a reason to give up.
    return null;
  }
}

/** Wait until the page has finished reacting, or until the budget runs out. */
export async function waitForPageSettled(
  cdp: CdpRunner,
  tabId: number,
  options: { cancelled?: () => boolean } = {},
): Promise<SettleOutcome> {
  const startedAt = Date.now();
  const floor = startedAt + SETTLE_MIN_MS;
  const deadline = startedAt + SETTLE_MAX_MS;

  for (;;) {
    if (options.cancelled?.()) return "cancelled";
    await sleep(SETTLE_POLL_MS);
    if (options.cancelled?.()) return "cancelled";

    const probe = await readQuietProbe(cdp, tabId);
    const now = Date.now();
    if (now < floor) continue;
    if (now >= deadline) return "timeout";
    if (!probe) continue;
    if (probe.readyState === "loading") continue;
    if (probe.idleMs >= SETTLE_QUIET_MS) return "quiet";
  }
}
