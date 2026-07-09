// Navigation tools — `tool.navigate`, `tool.navigate_back`,
// `tool.navigate_forward`, `tool.reload` (design §7, plan M7.1 / M7.2).
//
// Each handler:
// 1. Resolves the target tab (sandbox: must be in the session's Agent
//    Window — review M7).
// 2. Attaches CDP, enables `Page` lifecycle events.
// 3. Kicks off the actual navigation (`Page.navigate`,
//    `Page.navigateToHistoryEntry`, or `Page.reload`).
// 4. Awaits the requested `wait_until` lifecycle phase, bounded by
//    `timeout_ms` and the caller's `AbortSignal`. Listener cleanup is
//    explicit so an aborted call never leaves a dangling listener
//    behind (review M7 abort guidance).
//
// The returned shape mirrors bsk-protocol's `NavigateResult` /
// `NavigateBackResult` / `NavigateForwardResult` / `ReloadResult`.

import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import type {
  NavigateBackParams,
  NavigateForwardParams,
  NavigateHistoryResult,
  NavigateParams,
  NavigateResult,
  ReloadParams,
  ReloadResult,
  RpcError,
  WaitUntil,
} from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

export interface NavigationDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  /** Optional AbortSignal — M7 abort hook (M10.2 will wire the full chain). */
  signal?: AbortSignal;
  /** Override default timeout when the caller omits `timeout_ms`. */
  defaultTimeoutMs?: number;
}

const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_HISTORY_TIMEOUT_MS = 15_000;

/**
 * Translate a wire `wait_until` value into the lifecycle event name
 * CDP emits. Exported for unit tests.
 */
export function cdpLifecycleName(wu: WaitUntil): string {
  switch (wu) {
    case "load":
      return "load";
    case "domcontentloaded":
      return "DOMContentLoaded";
    case "networkidle":
      return "networkIdle";
    case "commit":
      return "commit";
  }
}

interface ReadyStateProbeReply {
  result?: { value?: unknown };
}

/**
 * Read `document.readyState` on the tab's main execution context.
 * Returns `null` when CDP cannot evaluate (detached tab, etc.).
 */
export async function probeMainFrameReadyState(
  cdp: CdpRunner,
  tabId: number,
): Promise<string | null> {
  try {
    await cdp.send(tabId, "Runtime.enable", {});
    const reply = await cdp.send<ReadyStateProbeReply>(tabId, "Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    const value = reply.result?.value;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** `wait_until` phases in navigation order (paint events excluded). */
const WAIT_UNTIL_PHASE_ORDER = ["commit", "DOMContentLoaded", "load", "networkIdle"] as const;

/**
 * Whether a lifecycle event name satisfies the requested phase (exact
 * match or a later phase in the navigation pipeline).
 */
export function lifecycleMeetsOrExceeds(observed: string, targetName: string): boolean {
  if (observed === targetName) return true;
  const oi = WAIT_UNTIL_PHASE_ORDER.indexOf(observed as (typeof WAIT_UNTIL_PHASE_ORDER)[number]);
  const ti = WAIT_UNTIL_PHASE_ORDER.indexOf(targetName as (typeof WAIT_UNTIL_PHASE_ORDER)[number]);
  if (oi < 0 || ti < 0) return false;
  return oi >= ti;
}

/**
 * Whether the main document has already reached (or passed) the CDP
 * lifecycle phase named by `targetName`, inferred from
 * `document.readyState`.
 */
export function lifecycleAlreadyReached(readyState: string, targetName: string): boolean {
  switch (targetName) {
    case "load":
      return readyState === "complete";
    case "DOMContentLoaded":
      return readyState === "interactive" || readyState === "complete";
    case "commit":
      return readyState === "interactive" || readyState === "complete" || readyState === "loading";
    case "networkIdle":
      // Must come from `Page.lifecycleEvent`; readyState does not imply network idle.
      return false;
    default:
      return false;
  }
}

/** When a readyState probe may short-circuit an in-flight lifecycle wait. */
export type LifecycleProbeMode = "passive" | "after-navigation";

/**
 * Decide whether `document.readyState` is safe to treat as "already
 * done" for the requested lifecycle target.
 *
 * * `passive` — `wait_for_navigation` on a settled page (no navigation
 *   initiated by this handler).
 * * `after-navigation` — following `navigate` / `reload` / history;
 *   rejects `complete`→`complete` with no observed lifecycle events so
 *   we do not confuse the previous document for the new load.
 */
export function shouldTrustReadyStateProbe(
  readyState: string,
  targetName: string,
  context: {
    mode: LifecycleProbeMode;
    beforeReadyState: string | null;
    sawRelevantLifecycle: boolean;
  },
): boolean {
  if (!lifecycleAlreadyReached(readyState, targetName)) return false;
  if (context.mode === "passive") return true;
  if (context.sawRelevantLifecycle) return true;
  if (context.beforeReadyState === "complete" && readyState === "complete") {
    return false;
  }
  return true;
}

let defaultDeps: { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } | null = null;
function getDefaultDeps(): { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } {
  if (!defaultDeps) {
    defaultDeps = {
      cdp: new ChromiumCdp(),
      tabsApi: chromeTabsApi,
    };
  }
  return defaultDeps;
}

/**
 * Wait for the lifecycle event matching `targetName` on `frameId`, or
 * resolve early when the AbortSignal fires / `timeoutMs` elapses.
 * Returns either `{ reached: "load" }` on success, or
 * `{ reached: "timeout", lastReached?: "<wait_until>" }` if the
 * timeout hit before the requested name.
 */
interface WaitOutcome {
  reached: "match" | "timeout" | "cancelled";
  lastLifecycle?: string;
}

interface LifecycleWait {
  promise: Promise<WaitOutcome>;
  refresh(): void;
  tryProbe(mode: LifecycleProbeMode, beforeReadyState?: string | null): Promise<void>;
}

/** Loader / frame guards for active navigations (stale document rejection). */
export interface LifecycleWaitGuard {
  loaderId?: string | (() => string | null | undefined);
  beforeLoaderId?: string | null;
}

function currentLoaderId(guard: LifecycleWaitGuard | undefined): string {
  if (!guard?.loaderId) return "";
  return typeof guard.loaderId === "function" ? (guard.loaderId() ?? "") : guard.loaderId;
}

/** Reject lifecycle events from the pre-navigation loader or wrong loader. */
export function eventLoaderIsRelevant(
  eventLoaderId: string | undefined,
  guard: LifecycleWaitGuard | undefined,
): boolean {
  const before = guard?.beforeLoaderId ?? null;
  if (eventLoaderId && before && eventLoaderId === before) return false;
  const expected = currentLoaderId(guard);
  if (expected.length > 0) {
    if (!eventLoaderId) return false;
    return eventLoaderId === expected;
  }
  return true;
}

function startLifecycleWait(
  cdp: CdpRunner,
  expectedTabId: number,
  frameId: string | (() => string | null | undefined),
  targetName: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  guard?: LifecycleWaitGuard,
): LifecycleWait {
  let refresh = () => {};
  let tryProbe = async (_mode: LifecycleProbeMode, _beforeReadyState?: string | null) => {};
  const promise = new Promise<WaitOutcome>((resolve) => {
    let settled = false;
    let sawRelevantLifecycle = false;
    let lastLifecycle: string | undefined;
    let pendingLifecycle: { name: string; frameId?: string; loaderId?: string } | null = null;
    let listenerSub: { dispose(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    const currentFrameId = () => (typeof frameId === "function" ? (frameId() ?? "") : frameId);

    const noteRelevantLifecycle = (name: string) => {
      sawRelevantLifecycle = true;
      lastLifecycle = name;
    };

    const lifecycleEventMatchesFrame = (eventFrameId?: string): boolean => {
      const expectedFrameId = currentFrameId();
      if (expectedFrameId.length === 0) return true;
      return eventFrameId === expectedFrameId;
    };

    const acceptLifecycleEvent = (
      name: string,
      eventFrameId?: string,
      eventLoaderId?: string,
    ): boolean => {
      if (!eventLoaderIsRelevant(eventLoaderId, guard)) return false;
      if (!lifecycleEventMatchesFrame(eventFrameId)) return false;
      noteRelevantLifecycle(name);
      return true;
    };

    const cleanup = () => {
      if (listenerSub) {
        listenerSub.dispose();
        listenerSub = null;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (abortHandler && signal) {
        signal.removeEventListener("abort", abortHandler);
        abortHandler = null;
      }
    };

    const finish = (outcome: WaitOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const maybeFinishPending = () => {
      if (settled || !pendingLifecycle) return;
      if (
        !acceptLifecycleEvent(
          pendingLifecycle.name,
          pendingLifecycle.frameId,
          pendingLifecycle.loaderId,
        )
      ) {
        return;
      }
      if (lifecycleMeetsOrExceeds(pendingLifecycle.name, targetName)) {
        finish({ reached: "match", lastLifecycle: pendingLifecycle.name });
      }
    };
    refresh = maybeFinishPending;

    tryProbe = async (mode: LifecycleProbeMode, beforeReadyState: string | null = null) => {
      if (settled) return;
      const readyState = await probeMainFrameReadyState(cdp, expectedTabId);
      if (readyState === null) return;
      if (
        shouldTrustReadyStateProbe(readyState, targetName, {
          mode,
          beforeReadyState,
          sawRelevantLifecycle,
        })
      ) {
        finish({ reached: "match", lastLifecycle: targetName });
      }
    };

    if (signal?.aborted) {
      finish({ reached: "cancelled", lastLifecycle });
      return;
    }

    if (cdp.onEvent) {
      listenerSub = cdp.onEvent(
        (source: chrome.debugger.Debuggee, method: string, params: unknown) => {
          if (settled) return;
          if (source.tabId !== expectedTabId) return;

          if (targetName === "commit" && method === "Page.frameNavigated") {
            const p = params as { frame?: { id?: string; parentId?: string } };
            const expectedFrameId = currentFrameId();
            if (expectedFrameId.length > 0) {
              if (p.frame?.id !== expectedFrameId) return;
            } else if (p.frame?.parentId) {
              return;
            }
            if (!acceptLifecycleEvent("commit", p.frame?.id)) return;
            finish({ reached: "match", lastLifecycle: "commit" });
            return;
          }

          if (method !== "Page.lifecycleEvent") return;
          const p = params as { name?: string; frameId?: string; loaderId?: string };
          if (!p?.name) return;
          if (currentFrameId().length === 0) {
            // A static empty `frameId` means the caller does not know
            // which frame to filter on (M9.2 `wait_for_navigation`
            // observes a navigation it did not initiate). Match by
            // tab-id only in that case. A callback form that
            // currently returns "" is the M7 navigate path — the
            // frame becomes known after `Page.navigate` resolves, so
            // we still stash until `refresh()` runs.
            if (typeof frameId !== "function") {
              if (!acceptLifecycleEvent(p.name, p.frameId, p.loaderId)) return;
              if (lifecycleMeetsOrExceeds(p.name, targetName)) {
                finish({ reached: "match", lastLifecycle: p.name });
              }
              return;
            }
            if (!eventLoaderIsRelevant(p.loaderId, guard)) return;
            if (!lifecycleEventMatchesFrame(p.frameId)) return;
            pendingLifecycle = { name: p.name, frameId: p.frameId, loaderId: p.loaderId };
            return;
          }
          if (!acceptLifecycleEvent(p.name, p.frameId, p.loaderId)) return;
          if (lifecycleMeetsOrExceeds(p.name, targetName)) {
            finish({ reached: "match", lastLifecycle: p.name });
          }
        },
      );
    }

    if (signal) {
      abortHandler = () => {
        finish({ reached: "cancelled", lastLifecycle });
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    timer = setTimeout(() => {
      finish({ reached: "timeout", lastLifecycle });
    }, timeoutMs);
  });

  return {
    promise,
    refresh: () => refresh(),
    tryProbe: (mode, beforeReadyState) => tryProbe(mode, beforeReadyState),
  };
}

/**
 * Wait for a lifecycle phase on an already-settled page (`passive`
 * readyState probe). Used by `wait_for_navigation`.
 */
export async function waitForLifecyclePassive(
  cdp: CdpRunner,
  expectedTabId: number,
  frameId: string,
  targetName: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<WaitOutcome> {
  const wait = startLifecycleWait(cdp, expectedTabId, frameId, targetName, timeoutMs, signal);
  await wait.tryProbe("passive");
  return wait.promise;
}

interface MainFrameInfo {
  frameId: string | null;
  loaderId: string | null;
}

async function readMainFrameInfo(cdp: CdpRunner, tabId: number): Promise<MainFrameInfo> {
  try {
    const tree = await cdp.send<{
      frameTree?: { frame?: { id?: string; loaderId?: string } };
    }>(tabId, "Page.getFrameTree", {});
    return {
      frameId: tree.frameTree?.frame?.id ?? null,
      loaderId: tree.frameTree?.frame?.loaderId ?? null,
    };
  } catch {
    return { frameId: null, loaderId: null };
  }
}

/** Shared tail for navigate / reload / history after the CDP command ran. */
async function finishLifecycleWait(
  wait: LifecycleWait,
  waitPromise: Promise<WaitOutcome>,
  beforeReadyState: string | null,
): Promise<WaitOutcome> {
  await wait.tryProbe("after-navigation", beforeReadyState);
  return waitPromise;
}

function linkedAbortSignal(signal: AbortSignal | undefined): {
  signal: AbortSignal;
  abort(): void;
  cleanup(): void;
} {
  const controller = new AbortController();
  let abortHandler: (() => void) | null = null;
  if (signal?.aborted) {
    controller.abort();
  } else if (signal) {
    abortHandler = () => controller.abort();
    signal.addEventListener("abort", abortHandler, { once: true });
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    cleanup: () => {
      if (abortHandler && signal) {
        signal.removeEventListener("abort", abortHandler);
        abortHandler = null;
      }
    },
  };
}

/**
 * Subscribe to `Page.lifecycleEvent` so the listener is already
 * attached BEFORE the navigate / reload command is sent. Returns a
 * disposable + a way to fetch the latest known frameId — useful when
 * we don't know the frameId up front (history navigation re-uses the
 * existing frame, so we filter by tabId only).
 */
export async function ensureCdpReady(cdp: CdpRunner, tabId: number): Promise<void> {
  await cdp.send(tabId, "Page.enable", {});
  await cdp.send(tabId, "Page.setLifecycleEventsEnabled", { enabled: true });
}

async function readTabUrl(api: ChromeTabsApi, tabId: number): Promise<string | undefined> {
  try {
    const t = await api.get(tabId);
    return t.url ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// tool.navigate
// ---------------------------------------------------------------------------

export async function handleNavigate(
  manager: SessionManager,
  params: NavigateParams,
  deps: NavigationDeps = getDefaultDeps(),
): Promise<NavigateResult | RpcError> {
  if (!params || typeof params.url !== "string" || params.url.length === 0) {
    return { code: "invalid_params", message: "navigate requires a url" };
  }
  const ctxOrErr = lookupSession(manager, params, "navigate");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "navigate");
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const waitUntil: WaitUntil = params.wait_until ?? "load";
  const timeoutMs = params.timeout_ms ?? deps.defaultTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;

  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    await ensureCdpReady(deps.cdp, target.tabId);
    const expected = cdpLifecycleName(waitUntil);
    const beforeReadyState = await probeMainFrameReadyState(deps.cdp, target.tabId);
    const beforeFrame = await readMainFrameInfo(deps.cdp, target.tabId);
    let frameId = "";
    let loaderId = "";
    const waitAbort = linkedAbortSignal(deps.signal);
    const wait = startLifecycleWait(
      deps.cdp,
      target.tabId,
      () => frameId,
      expected,
      timeoutMs,
      waitAbort.signal,
      {
        loaderId: () => loaderId,
        beforeLoaderId: beforeFrame.loaderId,
      },
    );
    const waitPromise = wait.promise;
    let nav: { frameId: string; loaderId?: string; errorText?: string };
    try {
      nav = await deps.cdp.send<{ frameId: string; loaderId?: string; errorText?: string }>(
        target.tabId,
        "Page.navigate",
        { url: params.url },
      );
    } catch (err) {
      waitAbort.abort();
      await waitPromise;
      waitAbort.cleanup();
      throw err;
    }
    frameId = nav.frameId ?? "";
    loaderId = nav.loaderId ?? "";
    wait.refresh();
    if (nav.errorText) {
      waitAbort.abort();
      await waitPromise;
      waitAbort.cleanup();
      return {
        code: "cdp_failed",
        message: `Page.navigate rejected: ${nav.errorText}`,
      };
    }
    const outcome = await finishLifecycleWait(wait, waitPromise, beforeReadyState);
    waitAbort.cleanup();
    if (outcome.reached === "cancelled") {
      return { code: "cancelled", message: "navigate aborted" };
    }
    const finalUrl = await readTabUrl(deps.tabsApi, target.tabId);
    if (outcome.reached === "match") {
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
        tab_id: target.tabId,
        url: params.url,
        final_url: finalUrl,
        reached: waitUntil,
      });
    }
    return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
      tab_id: target.tabId,
      url: params.url,
      final_url: finalUrl,
      reached: "timeout",
      error_text: `timed out waiting for lifecycle "${expected}" after ${timeoutMs}ms${
        outcome.lastLifecycle ? `; last observed "${outcome.lastLifecycle}"` : ""
      }`,
    });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Shared history navigation (back / forward / reload)
// ---------------------------------------------------------------------------

interface HistoryDeps extends NavigationDeps {}

interface HistoryEntry {
  id: number;
  url: string;
}

async function handleHistory(
  manager: SessionManager,
  params: { session_id?: string; tab_id?: number; wait_until?: WaitUntil; timeout_ms?: number },
  direction: "back" | "forward",
  deps: HistoryDeps,
): Promise<NavigateHistoryResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, `navigate_${direction}`);
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, `navigate_${direction}`);
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const waitUntil: WaitUntil = params.wait_until ?? "load";
  const timeoutMs = params.timeout_ms ?? deps.defaultTimeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;

  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    await ensureCdpReady(deps.cdp, target.tabId);
    const history = await deps.cdp.send<{ currentIndex: number; entries: HistoryEntry[] }>(
      target.tabId,
      "Page.getNavigationHistory",
      {},
    );
    const idx = history.currentIndex;
    const entries = history.entries ?? [];
    const targetIdx = direction === "back" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= entries.length) {
      return {
        code: "invalid_params",
        message:
          direction === "back"
            ? "no previous history entry to navigate back to"
            : "no forward history entry to navigate to",
      };
    }
    const previousUrl = entries[idx]?.url;
    const targetEntry = entries[targetIdx];

    const beforeFrame = await readMainFrameInfo(deps.cdp, target.tabId);
    const expected = cdpLifecycleName(waitUntil);
    const beforeReadyState = await probeMainFrameReadyState(deps.cdp, target.tabId);
    const waitAbort = linkedAbortSignal(deps.signal);
    const wait = startLifecycleWait(
      deps.cdp,
      target.tabId,
      beforeFrame.frameId ?? "",
      expected,
      timeoutMs,
      waitAbort.signal,
      { beforeLoaderId: beforeFrame.loaderId },
    );
    const waitPromise = wait.promise;
    try {
      await deps.cdp.send(target.tabId, "Page.navigateToHistoryEntry", { entryId: targetEntry.id });
    } catch (err) {
      waitAbort.abort();
      await waitPromise;
      waitAbort.cleanup();
      throw err;
    }

    const outcome = await finishLifecycleWait(wait, waitPromise, beforeReadyState);
    waitAbort.cleanup();
    if (outcome.reached === "cancelled") {
      return { code: "cancelled", message: `navigate_${direction} aborted` };
    }
    const finalUrl = await readTabUrl(deps.tabsApi, target.tabId);
    if (outcome.reached === "match") {
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
        tab_id: target.tabId,
        previous_url: previousUrl,
        final_url: finalUrl,
        reached: waitUntil,
      });
    }
    return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
      tab_id: target.tabId,
      previous_url: previousUrl,
      final_url: finalUrl,
      reached: "timeout",
      error_text: `timed out waiting for lifecycle "${expected}" after ${timeoutMs}ms${
        outcome.lastLifecycle ? `; last observed "${outcome.lastLifecycle}"` : ""
      }`,
    });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function handleNavigateBack(
  manager: SessionManager,
  params: NavigateBackParams,
  deps: NavigationDeps = getDefaultDeps(),
): Promise<NavigateHistoryResult | RpcError> {
  return handleHistory(manager, params, "back", deps);
}

export function handleNavigateForward(
  manager: SessionManager,
  params: NavigateForwardParams,
  deps: NavigationDeps = getDefaultDeps(),
): Promise<NavigateHistoryResult | RpcError> {
  return handleHistory(manager, params, "forward", deps);
}

// ---------------------------------------------------------------------------
// tool.reload
// ---------------------------------------------------------------------------

export async function handleReload(
  manager: SessionManager,
  params: ReloadParams,
  deps: NavigationDeps = getDefaultDeps(),
): Promise<ReloadResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "reload");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "reload");
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const waitUntil: WaitUntil = params.wait_until ?? "load";
  const timeoutMs = params.timeout_ms ?? deps.defaultTimeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS;
  const ignoreCache = params.hard === true;

  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    await ensureCdpReady(deps.cdp, target.tabId);
    const previousUrl = await readTabUrl(deps.tabsApi, target.tabId);
    const beforeFrame = await readMainFrameInfo(deps.cdp, target.tabId);
    const expected = cdpLifecycleName(waitUntil);
    const beforeReadyState = await probeMainFrameReadyState(deps.cdp, target.tabId);
    const waitAbort = linkedAbortSignal(deps.signal);
    const wait = startLifecycleWait(
      deps.cdp,
      target.tabId,
      beforeFrame.frameId ?? "",
      expected,
      timeoutMs,
      waitAbort.signal,
      { beforeLoaderId: beforeFrame.loaderId },
    );
    const waitPromise = wait.promise;
    try {
      await deps.cdp.send(target.tabId, "Page.reload", { ignoreCache });
    } catch (err) {
      waitAbort.abort();
      await waitPromise;
      waitAbort.cleanup();
      throw err;
    }

    const outcome = await finishLifecycleWait(wait, waitPromise, beforeReadyState);
    waitAbort.cleanup();
    if (outcome.reached === "cancelled") {
      return { code: "cancelled", message: "reload aborted" };
    }
    const finalUrl = await readTabUrl(deps.tabsApi, target.tabId);
    if (outcome.reached === "match") {
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
        tab_id: target.tabId,
        previous_url: previousUrl,
        final_url: finalUrl,
        reached: waitUntil,
      });
    }
    return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
      tab_id: target.tabId,
      previous_url: previousUrl,
      final_url: finalUrl,
      reached: "timeout",
      error_text: `timed out waiting for lifecycle "${expected}" after ${timeoutMs}ms${
        outcome.lastLifecycle ? `; last observed "${outcome.lastLifecycle}"` : ""
      }`,
    });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const __testing__ = {
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_HISTORY_TIMEOUT_MS,
};
