import type { FrameDocumentHandle } from "@/browser-driver/frame-handles";
import { type CdpRunner, sendToFrameHandle } from "@/tools/shared";

const SETTLE_MIN_MS = 150;
const SETTLE_QUIET_MS = 250;
const SETTLE_MAX_MS = 2_000;
const SETTLE_POLL_MS = 60;
const SETTLE_CLEANUP_TIMEOUT_MS = 500;
const SETTLE_WORLD_NAME = "__bsk_record_settle__";

let nextProbeToken = 0;

function buildQuietProbeExpression(token: string): string {
  return `(() => {
  const key = Symbol.for("bsk.record.quiet");
  const scope = globalThis;
  const root = document.documentElement;
  if (!root) return { idleMs: 0, readyState: document.readyState };
  let probe = scope[key];
  if (!probe) {
    const next = {
      changedAt: Date.now(),
      tokens: new Set(),
      timer: 0,
      observer: new MutationObserver(() => {
        next.changedAt = Date.now();
      }),
    };
    next.observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    probe = next;
    scope[key] = probe;
  }
  probe.tokens.add(${JSON.stringify(token)});
  clearTimeout(probe.timer);
  probe.timer = setTimeout(() => {
    if (scope[key] === probe) {
      probe.observer.disconnect();
      delete scope[key];
    }
  }, ${SETTLE_MAX_MS + 1_000});
  return { idleMs: Date.now() - probe.changedAt, readyState: document.readyState };
})()`;
}

function buildQuietCleanupExpression(token: string): string {
  return `(() => {
  const key = Symbol.for("bsk.record.quiet");
  const scope = globalThis;
  const probe = scope[key];
  if (!probe) return false;
  probe.tokens.delete(${JSON.stringify(token)});
  if (probe.tokens.size === 0) {
    clearTimeout(probe.timer);
    probe.observer.disconnect();
    delete scope[key];
  }
  return true;
})()`;
}

export interface DocumentSettleScope {
  tabId: number;
  /** Omit only for the target's root document. */
  frameId?: string;
  handle?: FrameDocumentHandle;
}

type SettleOutcome = "quiet" | "timeout" | "cancelled";

interface QuietProbe {
  idleMs: number;
  readyState: string;
}

interface ProbeContext {
  executionContextId?: number;
  installed: boolean;
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

async function sendInSettleScope<T>(
  cdp: CdpRunner,
  scope: DocumentSettleScope,
  method: string,
  params: object,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("document settle probe timed out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const pending = scope.handle
      ? sendToFrameHandle<T>(cdp, scope.handle, method, params)
      : cdp.send<T>(scope.tabId, method, params);
    void pending.catch(() => {});
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("document settle probe timed out")), remaining);
        if (signal) {
          onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener("abort", onAbort);
  }
}

async function resolveFrameId(
  cdp: CdpRunner,
  scope: DocumentSettleScope,
  deadline: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const explicit = scope.frameId ?? scope.handle?.frameId;
  if (explicit) return explicit;
  const tree = await sendInSettleScope<{ frameTree?: { frame?: { id?: string } } }>(
    cdp,
    scope,
    "Page.getFrameTree",
    {},
    deadline,
    signal,
  );
  return tree.frameTree?.frame?.id;
}

async function executionContextForScope(
  cdp: CdpRunner,
  scope: DocumentSettleScope,
  deadline: number,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const frameId = await resolveFrameId(cdp, scope, deadline, signal);
  if (!frameId) return undefined;
  const result = await sendInSettleScope<{ executionContextId?: number }>(
    cdp,
    scope,
    "Page.createIsolatedWorld",
    {
      frameId,
      worldName: SETTLE_WORLD_NAME,
      grantUniveralAccess: false,
    },
    deadline,
    signal,
  );
  return result.executionContextId;
}

async function readQuietProbe(
  cdp: CdpRunner,
  scope: DocumentSettleScope,
  context: ProbeContext,
  token: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<QuietProbe | null> {
  try {
    if (context.executionContextId === undefined) {
      context.executionContextId = await executionContextForScope(cdp, scope, deadline, signal);
      if (context.executionContextId === undefined) return null;
    }
    const reply = await sendInSettleScope<{ result?: { value?: unknown } }>(
      cdp,
      scope,
      "Runtime.evaluate",
      {
        expression: buildQuietProbeExpression(token),
        returnByValue: true,
        contextId: context.executionContextId,
      },
      deadline,
      signal,
    );
    context.installed = true;
    const value = reply.result?.value;
    if (!value || typeof value !== "object") return null;
    const { idleMs, readyState } = value as { idleMs?: unknown; readyState?: unknown };
    if (typeof idleMs !== "number" || typeof readyState !== "string") return null;
    return { idleMs, readyState };
  } catch {
    context.executionContextId = undefined;
    context.installed = false;
    return null;
  }
}

async function cleanupQuietProbe(
  cdp: CdpRunner,
  scope: DocumentSettleScope,
  context: ProbeContext,
  token: string,
): Promise<void> {
  if (!context.installed || context.executionContextId === undefined) return;
  const contextId = context.executionContextId;
  context.installed = false;
  try {
    await sendInSettleScope(
      cdp,
      scope,
      "Runtime.evaluate",
      {
        expression: buildQuietCleanupExpression(token),
        returnByValue: true,
        contextId,
      },
      Date.now() + SETTLE_CLEANUP_TIMEOUT_MS,
    );
  } catch {
    // Document may already have navigated or closed; the probe self-expires otherwise.
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
  const context: ProbeContext = { installed: false };
  const token = String(++nextProbeToken);

  try {
    for (;;) {
      if (options.signal?.aborted) return "cancelled";
      await sleep(SETTLE_POLL_MS, options.signal);
      if (options.signal?.aborted) return "cancelled";
      if (Date.now() >= deadline) return "timeout";

      const probe = await readQuietProbe(cdp, scope, context, token, deadline, options.signal);
      if (options.signal?.aborted) return "cancelled";
      const now = Date.now();
      if (now >= deadline) return "timeout";
      if (now < floor) continue;
      if (!probe || probe.readyState === "loading") continue;
      if (probe.idleMs >= SETTLE_QUIET_MS) return "quiet";
    }
  } finally {
    await cleanupQuietProbe(cdp, scope, context, token);
  }
}
