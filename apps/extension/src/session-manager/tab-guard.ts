import { isAgentControlledTab, type SessionManager } from "./manager";

/** The subset of `chrome.tabs` the guard needs, injected so vitest never touches a real Chrome. */
export interface TabGuardTabsApi {
  get(tabId: number): Promise<{ id?: number; windowId?: number; openerTabId?: number } | undefined>;
  move(tabId: number, moveProperties: { windowId: number; index: number }): Promise<unknown>;
  update(tabId: number, updateProperties: { active: boolean }): Promise<unknown>;
}

/** The subset of `chrome.windows` the guard needs. */
export interface TabGuardWindowsApi {
  listNormalIds(): Promise<number[]>;
  getLastFocusedNormalId(): Promise<number | null>;
  /** Pull `tabId` out into a brand new focused window, used when the user has none. */
  createWithTab(tabId: number): Promise<unknown>;
  focus(windowId: number): Promise<unknown>;
}

/** Mirrors the `chrome.tabs.onCreated` / `onAttached` listener pair. */
export interface TabGuardEvents {
  onCreated: {
    addListener(cb: (tab: { id?: number; windowId?: number; openerTabId?: number }) => void): void;
    removeListener(
      cb: (tab: { id?: number; windowId?: number; openerTabId?: number }) => void,
    ): void;
  };
  onAttached: {
    addListener(cb: (tabId: number, info: { newWindowId: number }) => void): void;
    removeListener(cb: (tabId: number, info: { newWindowId: number }) => void): void;
  };
  /**
   * `chrome.windows.getLastFocused` answers with the Agent Window while the
   * agent is working, so it cannot name the window the user was last in. The
   * guard keeps its own order from focus events instead.
   */
  onFocusChanged?: {
    addListener(cb: (windowId: number) => void): void;
    removeListener(cb: (windowId: number) => void): void;
  };
}

export interface TabGuardOptions {
  manager: SessionManager;
  tabs: TabGuardTabsApi;
  windows: TabGuardWindowsApi;
  events: TabGuardEvents;
  onError?: (error: unknown) => void;
}

export const chromeTabGuardTabsApi: TabGuardTabsApi = {
  get: (tabId) => chrome.tabs.get(tabId),
  move: (tabId, moveProperties) => chrome.tabs.move(tabId, moveProperties),
  update: (tabId, updateProperties) => chrome.tabs.update(tabId, updateProperties),
};

export const chromeTabGuardWindowsApi: TabGuardWindowsApi = {
  async listNormalIds() {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    return wins.map((w) => w.id).filter((id): id is number => typeof id === "number");
  },
  async getLastFocusedNormalId() {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    return typeof win?.id === "number" ? win.id : null;
  },
  createWithTab: (tabId) => chrome.windows.create({ type: "normal", focused: true, tabId }),
  focus: (windowId) => chrome.windows.update(windowId, { focused: true }),
};

/**
 * The events the guard listens on, beside the tabs and windows adapters above.
 *
 * Exported so the production wiring is the thing under test. Built inline at the
 * call site, a missing listener is invisible: the guard treats every event as
 * optional and a test fixture supplies its own, so both stay green while the
 * extension never receives the event.
 */
export function chromeTabGuardEvents(): TabGuardEvents {
  return {
    onCreated: chrome.tabs.onCreated,
    onAttached: chrome.tabs.onAttached,
    onFocusChanged: chrome.windows.onFocusChanged,
  };
}

/**
 * Evict tabs that enter an Agent Window without belonging to its session.
 *
 * A tab stays when the session already claims it (`tab_create`, the session
 * home tab, or a committed `tab_borrow`) or when its opener is a tab the
 * session claims, which is how `target="_blank"` and `window.open` arrive.
 * Anything else is moved to a user window, which is focused with the tab
 * activated so it behaves as if it had opened there.
 *
 * Ownership is never inferred from event ordering: the guard reads the same
 * claim tables the tools write and mutates none of them.
 */
export function attachAgentWindowTabGuard(options: TabGuardOptions): { dispose: () => void } {
  const { manager, tabs, windows, events, onError } = options;

  /** User windows in the order they were last focused, most recent first. */
  const recentUserWindows: number[] = [];
  const noteFocus = (windowId: number): void => {
    // chrome.windows.WINDOW_ID_NONE is -1 and means focus left the browser.
    if (typeof windowId !== "number" || windowId < 0) return;
    if (manager.list().some((ctx) => ctx.agentWindowId === windowId)) return;
    const seen = recentUserWindows.indexOf(windowId);
    if (seen !== -1) recentUserWindows.splice(seen, 1);
    recentUserWindows.unshift(windowId);
    if (recentUserWindows.length > 16) recentUserWindows.length = 16;
  };

  const report = (error: unknown): void => {
    if (onError) onError(error);
    else console.warn("[browser-skill] agent-window tab guard failed", error);
  };

  const evictIfForeign = async (
    tabId: number,
    windowId: number,
    openerTabId: number | undefined,
  ): Promise<void> => {
    const ctx = manager.findByWindowId(windowId);
    if (!ctx) return;
    if (isAgentControlledTab(ctx, tabId)) return;
    // tab_borrow reserves the tab before it calls chrome.tabs.move and only
    // writes borrowedTabs once the move lands, so a committed-borrow check
    // alone would evict the tab mid-borrow.
    if (manager.findBorrowingSession(tabId, null) === ctx.sessionId) return;
    if (openerTabId !== undefined && isAgentControlledTab(ctx, openerTabId)) return;

    // `tab_create` registers ownership only once `chrome.tabs.create` resolves,
    // and popup observation decides later still. Both reach this listener
    // first, so the read above is not final: wait for what the session already
    // has in flight, then read again. Waiting on the operation rather than on a
    // delay is what makes this correct instead of merely usually right.
    await manager.settlePendingTabClaims(ctx.sessionId);
    if (!stillForeign(ctx, tabId, windowId, openerTabId)) return;

    const target = await resolveUserWindow(manager, windows, recentUserWindows);
    // A popup reaches onCreated before its navigation-target event, so the wait
    // above can find nothing in flight and return at once. The claim is then
    // registered while this lookup is still running. Settle again rather than
    // treat the first empty read as final.
    await manager.settlePendingTabClaims(ctx.sessionId);
    // Every await above is a point where the tab may have been claimed, moved
    // by the user, or the session torn down. Re-read both before touching it.
    if (!stillForeign(ctx, tabId, windowId, openerTabId)) return;
    const current = await tabs.get(tabId);
    if (!current || current.windowId !== windowId) return;
    if (!stillForeign(ctx, tabId, windowId, openerTabId)) return;

    if (target === null) {
      await windows.createWithTab(tabId);
      return;
    }
    if (target === windowId) return;
    const outcome = await moveWithRetries(tabs, tabId, target, windowId, () =>
      stillForeign(ctx, tabId, windowId, openerTabId),
    );
    if (outcome === "cancelled") return;
    await windows.focus(target);
    await tabs.update(tabId, { active: true });
  };

  /** Re-read the claim tables and the session, which any await may have changed. */
  const stillForeign = (
    ctx: { sessionId: string; agentWindowId: number },
    tabId: number,
    windowId: number,
    openerTabId: number | undefined,
  ): boolean => {
    const current = manager.findByWindowId(windowId);
    if (!current || current.sessionId !== ctx.sessionId) return false;
    if (isAgentControlledTab(current, tabId)) return false;
    if (manager.findBorrowingSession(tabId, null) === current.sessionId) return false;
    if (openerTabId !== undefined && isAgentControlledTab(current, openerTabId)) return false;
    return true;
  };

  const onCreated = (tab: { id?: number; windowId?: number; openerTabId?: number }): void => {
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number") return;
    void evictIfForeign(tab.id, tab.windowId, tab.openerTabId).catch(report);
  };

  const onAttached = (tabId: number, info: { newWindowId: number }): void => {
    void (async () => {
      const tab = await tabs.get(tabId);
      await evictIfForeign(tabId, info.newWindowId, tab?.openerTabId);
    })().catch(report);
  };

  events.onCreated.addListener(onCreated);
  events.onAttached.addListener(onAttached);
  events.onFocusChanged?.addListener(noteFocus);
  return {
    dispose: () => {
      events.onCreated.removeListener(onCreated);
      events.onAttached.removeListener(onAttached);
      events.onFocusChanged?.removeListener(noteFocus);
    },
  };
}

async function resolveUserWindow(
  manager: SessionManager,
  windows: TabGuardWindowsApi,
  recentUserWindows: readonly number[],
): Promise<number | null> {
  const agentWindowIds = new Set(manager.list().map((ctx) => ctx.agentWindowId));
  const open = new Set(await windows.listNormalIds());
  // Observed focus first: Chrome's own answer is the Agent Window while the
  // agent works, and the open-window order below is arbitrary rather than
  // most-recently-used.
  for (const id of recentUserWindows) {
    if (!agentWindowIds.has(id) && open.has(id)) return id;
  }
  const lastFocused = await windows.getLastFocusedNormalId();
  if (lastFocused !== null && !agentWindowIds.has(lastFocused) && open.has(lastFocused)) {
    return lastFocused;
  }
  for (const id of open) {
    if (!agentWindowIds.has(id)) return id;
  }
  return null;
}

/**
 * Chrome refuses a move while the user is dragging the tab, which is transient.
 * Retry a bounded number of times and give up rather than loop.
 *
 * Each backoff is long enough for the tab to stop being ours or to leave the
 * window we judged it in, so both are re-read before every attempt. The caller
 * focuses the destination and activates the tab, which it must not do when the
 * move was abandoned, so the outcome is reported rather than implied.
 */
async function moveWithRetries(
  tabs: TabGuardTabsApi,
  tabId: number,
  windowId: number,
  sourceWindowId: number,
  stillForeign: () => boolean,
): Promise<"moved" | "cancelled"> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!stillForeign()) return "cancelled";
    if (attempt > 0) {
      const current = await tabs.get(tabId);
      if (!current || current.windowId !== sourceWindowId) return "cancelled";
      if (!stillForeign()) return "cancelled";
    }
    try {
      await tabs.move(tabId, { windowId, index: -1 });
      return "moved";
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}
