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

    const target = await resolveUserWindow(manager, windows);
    if (target === null) {
      await windows.createWithTab(tabId);
      return;
    }
    if (target === windowId) return;
    await tabs.move(tabId, { windowId: target, index: -1 });
    await windows.focus(target);
    await tabs.update(tabId, { active: true });
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
  return {
    dispose: () => {
      events.onCreated.removeListener(onCreated);
      events.onAttached.removeListener(onAttached);
    },
  };
}

async function resolveUserWindow(
  manager: SessionManager,
  windows: TabGuardWindowsApi,
): Promise<number | null> {
  const agentWindowIds = new Set(manager.list().map((ctx) => ctx.agentWindowId));
  const lastFocused = await windows.getLastFocusedNormalId();
  if (lastFocused !== null && !agentWindowIds.has(lastFocused)) return lastFocused;
  for (const id of await windows.listNormalIds()) {
    if (!agentWindowIds.has(id)) return id;
  }
  return null;
}
