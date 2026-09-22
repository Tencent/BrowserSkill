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
import {
  isAgentControlledTab,
  type SessionContext,
  type SessionManager,
} from "@/session-manager/manager";
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
import {
  type BrowserNavigationApi,
  chromeBrowserNavigationApi,
  navigateWithBrowserApi,
} from "./browser-navigation";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { cdpError, isCdpExtensionAccessDenied } from "./errors";
import { NavigationDocument } from "./navigation-document";
import {
  type CdpRunner,
  type ChromeTabsApi,
  cdpBlockedUrlReason,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  type ResolvedTargetTab,
  resolveTargetTab,
} from "./shared";

export interface NavigationDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  browserNavigation?: BrowserNavigationApi;
  /** Agent requests opt in; recording also reuses navigation without changing execution policy. */
  backgroundExecution?: boolean;
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

let defaultDeps: NavigationDeps | null = null;
function getDefaultDeps(): NavigationDeps {
  if (!defaultDeps) {
    defaultDeps = {
      cdp: new ChromiumCdp(),
      tabsApi: chromeTabsApi,
      backgroundExecution: true,
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
  followNavigations?: boolean;
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
    const document = new NavigationDocument();
    document.retire(guard?.beforeLoaderId ?? undefined);
    const pendingRequests = new Set<string>();
    let navigationRevision = 0;
    let pendingLifecycle: { name: string; frameId?: string; loaderId?: string } | null = null;
    let listenerSub: { dispose(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortHandler: (() => void) | null = null;

    let observedMainFrameId = "";
    const currentFrameId = () =>
      (typeof frameId === "function" ? frameId() : frameId) || observedMainFrameId;

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
      if (guard?.followNavigations && (document.id || document.pending)) {
        if (document.pending || eventLoaderId !== document.id) return false;
      } else if (!eventLoaderIsRelevant(eventLoaderId, guard)) return false;
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
      const version = document.version;
      const readyState = await probeMainFrameReadyState(cdp, expectedTabId);
      if (guard?.followNavigations && (!document.isCurrent(version) || document.pending)) return;
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

    // Request intent is not a commit. Reconcile buffered current-document
    // events after cancellation, without accepting a probe from an older turn.
    const reconcilePending = async () => {
      if (settled || !document.pending || pendingRequests.size) return;
      const version = document.version;
      const revision = navigationRevision;
      const frame = await readMainFrameInfo(cdp, expectedTabId);
      if (
        settled ||
        !document.isCurrent(version) ||
        revision !== navigationRevision ||
        pendingRequests.size
      )
        return;
      if (frame.frameId !== currentFrameId() || frame.loaderId !== document.id) return;
      document.cancelPending();
      maybeFinishPending();
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

          if (guard?.followNavigations) {
            if (method === "Page.frameRequestedNavigation") {
              const p = params as { frameId?: string; disposition?: string };
              if (
                currentFrameId() &&
                p.frameId === currentFrameId() &&
                (!p.disposition || p.disposition === "currentTab")
              ) {
                document.begin();
                navigationRevision += 1;
              }
              return;
            }
            if (method === "Network.requestWillBeSent") {
              const p = params as {
                requestId?: string;
                frameId?: string;
                loaderId?: string;
                type?: string;
              };
              if (
                p.type === "Document" &&
                p.frameId === currentFrameId() &&
                p.requestId &&
                document.id &&
                p.loaderId !== document.id &&
                !document.isRetired(p.loaderId)
              ) {
                document.begin();
                navigationRevision += 1;
                pendingRequests.add(p.requestId);
              }
              return;
            }
            if (method === "Network.loadingFailed" || method === "Network.loadingFinished") {
              const p = params as { requestId?: string };
              if (p.requestId && pendingRequests.delete(p.requestId)) {
                navigationRevision += 1;
                void reconcilePending();
              }
              return;
            }
            if (
              method === "Page.frameStoppedLoading" ||
              method === "Page.navigatedWithinDocument"
            ) {
              const p = params as { frameId?: string };
              if (p.frameId === currentFrameId()) void reconcilePending();
              return;
            }
            if (method === "Page.frameNavigated") {
              const p = params as { frame?: { id?: string; parentId?: string; loaderId?: string } };
              if (
                !p.frame?.parentId &&
                lifecycleEventMatchesFrame(p.frame?.id) &&
                document.commit(p.frame?.loaderId)
              ) {
                observedMainFrameId = p.frame?.id ?? "";
                navigationRevision += 1;
                pendingRequests.clear();
                pendingLifecycle = null;
                sawRelevantLifecycle = false;
                lastLifecycle = undefined;
              }
            }
          }
          if (targetName === "commit" && method === "Page.frameNavigated") {
            const p = params as { frame?: { id?: string; parentId?: string; loaderId?: string } };
            const expectedFrameId = currentFrameId();
            if (expectedFrameId.length > 0) {
              if (p.frame?.id !== expectedFrameId) return;
            } else if (p.frame?.parentId) {
              return;
            }
            if (!acceptLifecycleEvent("commit", p.frame?.id, p.frame?.loaderId)) return;
            finish({ reached: "match", lastLifecycle: "commit" });
            return;
          }

          if (method !== "Page.lifecycleEvent") return;
          const p = params as { name?: string; frameId?: string; loaderId?: string };
          if (!p?.name) return;
          if (
            guard?.followNavigations &&
            document.pending &&
            p.loaderId === document.id &&
            lifecycleEventMatchesFrame(p.frameId)
          ) {
            // Keep evidence that this document met the wait condition until the
            // pending navigation is cancelled or a successor commits and clears it.
            if (!pendingLifecycle || !lifecycleMeetsOrExceeds(pendingLifecycle.name, targetName)) {
              pendingLifecycle = { name: p.name, frameId: p.frameId, loaderId: p.loaderId };
            }
            void reconcilePending();
            return;
          }
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
            if (guard?.followNavigations && (document.id || document.pending)) {
              if (document.pending || p.loaderId !== document.id) return;
            } else if (!eventLoaderIsRelevant(p.loaderId, guard)) return;
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

/** Navigation may leave an inaccessible document, so it owns CDP preparation. */
async function acquireNavigationExecution(
  manager: SessionManager,
  ctx: SessionContext,
  tabId: number,
  deps: NavigationDeps,
  signal = deps.signal,
): Promise<void> {
  signal?.throwIfAborted();
  if (
    !deps.backgroundExecution ||
    !deps.cdp.acquireBackgroundExecution ||
    !isAgentControlledTab(ctx, tabId)
  )
    return;
  if (manager.get(ctx.sessionId) !== ctx) throw new DOMException("Session ended", "AbortError");
  await deps.cdp.acquireBackgroundExecution?.(ctx.sessionId, tabId);
  if (manager.get(ctx.sessionId) !== ctx || !isAgentControlledTab(ctx, tabId)) {
    await deps.cdp.releaseSessionTab?.(ctx.sessionId, tabId);
    throw new DOMException("Target control ended during navigation setup", "AbortError");
  }
  signal?.throwIfAborted();
}

async function prepareNavigation(
  manager: SessionManager,
  ctx: SessionContext,
  target: ResolvedTargetTab,
  deps: NavigationDeps,
): Promise<"browser" | "cdp"> {
  deps.signal?.throwIfAborted();
  deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
  if (cdpBlockedUrlReason(target.url) || cdpBlockedUrlReason(target.pendingUrl)) return "browser";
  try {
    await acquireNavigationExecution(manager, ctx, target.tabId, deps);
    await ensureCdpReady(deps.cdp, target.tabId);
    // Successor request termination is part of navigation waiting, even if
    // optional network capture was unavailable during debugger attachment.
    await deps.cdp.send(target.tabId, "Network.enable", {});
    return "cdp";
  } catch (error) {
    // Only preflight access denial permits fallback. Never replay a sent action.
    if (!isCdpExtensionAccessDenied(error)) throw error;
    return "browser";
  }
}

function navigationError(error: unknown): RpcError {
  return error instanceof Error && error.name === "AbortError"
    ? { code: "cancelled", message: "Navigation cancelled" }
    : cdpError(error);
}

/** Recover only a failed preflight; never replay an already-dispatched navigation. */
async function recoverBrowserNavigation(
  deps: NavigationDeps,
  manager: SessionManager,
  ctx: SessionContext,
  target: ResolvedTargetTab,
  action: (api: BrowserNavigationApi) => Promise<unknown>,
  waitUntil: WaitUntil,
  timeoutMs: number,
  requestedUrl?: string,
): Promise<ReloadResult | RpcError> {
  const tabId = target.tabId;
  const controlled = isAgentControlledTab(ctx, tabId);
  const abort = linkedAbortSignal(deps.signal);
  const deadline = Date.now() + timeoutMs;
  const api = deps.browserNavigation ?? chromeBrowserNavigationApi;
  const checkControl = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const tab = await deps.tabsApi.get(tabId);
    signal.throwIfAborted();
    if (
      manager.get(ctx.sessionId) !== ctx ||
      tab.windowId !== target.windowId ||
      (controlled && !isAgentControlledTab(ctx, tabId))
    )
      throw new DOMException("Target control ended during navigation recovery", "AbortError");
    return tab;
  };
  try {
    const outcome = await navigateWithBrowserApi(
      api,
      tabId,
      () => action(api),
      waitUntil,
      timeoutMs,
      abort.signal,
      async (event, signal) => {
        // Chrome metadata may advance before its corresponding event arrives.
        // An obsolete handoff waits for that event; it is not a navigation error.
        const isCurrent = async () => {
          await checkControl(signal);
          const frame = await api.getFrame(tabId);
          signal.throwIfAborted();
          return !!event.documentId && frame?.documentId === event.documentId;
        };
        try {
          if (!(await isCurrent())) return false;
          const tab = await checkControl(signal);
          if (cdpBlockedUrlReason(event.url ?? tab.url))
            throw new Error("Navigation remains on a restricted page");
          await acquireNavigationExecution(manager, ctx, tabId, deps, signal);
          if (!(await isCurrent())) return false;
          await deps.cdp.send(tabId, "Page.enable", {});
          if (!(await isCurrent())) return false;
          if (waitUntil === "networkidle") {
            const frame = await readMainFrameInfo(deps.cdp, tabId);
            if (!(await isCurrent())) return false;
            if (!frame.frameId) throw new Error("No main frame after navigation");
            const remaining = deadline - Date.now();
            if (remaining <= 0) return false;
            const waiting = linkedAbortSignal(signal);
            const wait = startLifecycleWait(
              deps.cdp,
              tabId,
              frame.frameId,
              "networkIdle",
              remaining,
              waiting.signal,
              { loaderId: frame.loaderId ?? undefined },
            );
            try {
              await deps.cdp.send(tabId, "Page.setLifecycleEventsEnabled", { enabled: true });
              if ((await wait.promise).reached !== "match") return false;
            } finally {
              waiting.abort();
              waiting.cleanup();
            }
          }
          return await isCurrent();
        } catch (error) {
          // Do not hide ownership loss or failures of the current document.
          if (signal.aborted) throw error;
          if (!(await isCurrent())) return false;
          throw error;
        }
      },
      requestedUrl,
    );
    if (outcome.reached === "failed") return outcome.error;
    if (outcome.reached === "cancelled" || abort.signal.aborted)
      return { code: "cancelled", message: "navigation recovery aborted" };
    const tab = await checkControl(abort.signal);
    return {
      tab_id: tabId,
      final_url: outcome.url ?? tab.url,
      reached: outcome.reached === "match" ? waitUntil : "timeout",
      ...(outcome.reached === "timeout"
        ? {
            error_text: `timed out waiting for ${waitUntil} during navigation recovery after ${timeoutMs}ms`,
          }
        : {}),
    };
  } catch (error) {
    return abort.signal.aborted
      ? { code: "cancelled", message: "navigation recovery aborted" }
      : navigationError(error);
  } finally {
    abort.abort();
    abort.cleanup();
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
    if ((await prepareNavigation(manager, ctx, target, deps)) === "browser") {
      const recovered = await recoverBrowserNavigation(
        deps,
        manager,
        ctx,
        target,
        (api) => api.update(target.tabId, { url: params.url }),
        waitUntil,
        timeoutMs,
        params.url,
      );
      if (isRpcError(recovered)) return recovered;
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, { ...recovered, url: params.url });
    }
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
        followNavigations: true,
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
    return navigationError(err);
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
    if ((await prepareNavigation(manager, ctx, target, deps)) === "browser") {
      const recovered = await recoverBrowserNavigation(
        deps,
        manager,
        ctx,
        target,
        (api) => (direction === "back" ? api.goBack(target.tabId) : api.goForward(target.tabId)),
        waitUntil,
        timeoutMs,
      );
      if (isRpcError(recovered)) return recovered;
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
        ...recovered,
        previous_url: target.url,
      });
    }
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
      { beforeLoaderId: beforeFrame.loaderId, followNavigations: true },
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
    return navigationError(err);
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
    if ((await prepareNavigation(manager, ctx, target, deps)) === "browser") {
      const previousUrl = await readTabUrl(deps.tabsApi, target.tabId);
      const recovered = await recoverBrowserNavigation(
        deps,
        manager,
        ctx,
        target,
        (api) => api.reload(target.tabId, { bypassCache: ignoreCache }),
        waitUntil,
        timeoutMs,
      );
      if (isRpcError(recovered)) return recovered;
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
        ...recovered,
        previous_url: previousUrl,
      });
    }
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
      { beforeLoaderId: beforeFrame.loaderId, followNavigations: true },
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
    return navigationError(err);
  }
}

export const __testing__ = {
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_HISTORY_TIMEOUT_MS,
};
