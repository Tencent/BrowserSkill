import type { CdpTarget } from "@/browser-driver/frame-graph";
import { type CdpRunner, sendToCdpTarget } from "@/tools/shared";

const SETTLE_MIN_MS = 150;
const SETTLE_QUIET_MS = 250;
const SETTLE_MAX_MS = 2_000;
const SETTLE_POLL_MS = 60;
const SETTLE_WORLD_NAME = "__bsk_record_settle__";

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

export interface DocumentSettleScope {
  target: CdpTarget;
  /** Omit only for the target's root document. */
  frameId?: string;
}

type SettleOutcome = "quiet" | "timeout" | "cancelled";

interface QuietProbe {
  idleMs: number;
  readyState: string;
}

interface ProbeContext {
  executionContextId?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function executionContextForScope(
  cdp: CdpRunner,
  scope: DocumentSettleScope,
): Promise<number | undefined> {
  if (!scope.frameId) return undefined;
  const result = await sendToCdpTarget<{ executionContextId?: number }>(
    cdp,
    scope.target,
    "Page.createIsolatedWorld",
    {
      frameId: scope.frameId,
      worldName: SETTLE_WORLD_NAME,
      grantUniveralAccess: false,
    },
  );
  return result.executionContextId;
}

async function readQuietProbe(
  cdp: CdpRunner,
  scope: DocumentSettleScope,
  context: ProbeContext,
): Promise<QuietProbe | null> {
  try {
    if (scope.frameId && context.executionContextId === undefined) {
      context.executionContextId = await executionContextForScope(cdp, scope);
      if (context.executionContextId === undefined) return null;
    }
    const reply = await sendToCdpTarget<{ result?: { value?: unknown } }>(
      cdp,
      scope.target,
      "Runtime.evaluate",
      {
        expression: QUIET_PROBE,
        returnByValue: true,
        ...(context.executionContextId !== undefined
          ? { contextId: context.executionContextId }
          : {}),
      },
    );
    const value = reply.result?.value;
    if (!value || typeof value !== "object") return null;
    const { idleMs, readyState } = value as { idleMs?: unknown; readyState?: unknown };
    if (typeof idleMs !== "number" || typeof readyState !== "string") return null;
    return { idleMs, readyState };
  } catch {
    context.executionContextId = undefined;
    return null;
  }
}

export async function waitForDocumentSettled(
  cdp: CdpRunner,
  scope: DocumentSettleScope,
  options: { signal?: AbortSignal } = {},
): Promise<SettleOutcome> {
  const startedAt = Date.now();
  const floor = startedAt + SETTLE_MIN_MS;
  const deadline = startedAt + SETTLE_MAX_MS;
  const context: ProbeContext = {};

  for (;;) {
    if (options.signal?.aborted) return "cancelled";
    await sleep(SETTLE_POLL_MS, options.signal);
    if (options.signal?.aborted) return "cancelled";

    const probe = await readQuietProbe(cdp, scope, context);
    const now = Date.now();
    if (now < floor) continue;
    if (now >= deadline) return "timeout";
    if (!probe || probe.readyState === "loading") continue;
    if (probe.idleMs >= SETTLE_QUIET_MS) return "quiet";
  }
}
