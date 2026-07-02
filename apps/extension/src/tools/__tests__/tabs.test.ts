import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import {
  type AgentOverlayResetApi,
  type ChromeWindowsApi,
  handleTabBorrow,
  handleTabClose,
  handleTabCreate,
  handleTabList,
  handleTabReturn,
  handleTabSelect,
  NEW_TAB_DEFAULT_URL,
  returnBorrowedTab,
  type TabMutationApi,
} from "../tabs";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  return {
    create: vi.fn(async () => {
      const id = ids[i++];
      if (id === undefined) throw new Error("ran out of fake window ids");
      return id;
    }),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => {}),
  };
}

function fakeChromeTabsApi(tabs: Partial<chrome.tabs.Tab>[]) {
  return {
    query: vi.fn(async (_q: chrome.tabs.QueryInfo) =>
      tabs.map((t, i) => ({ id: i + 1, ...t }) as chrome.tabs.Tab),
    ),
  };
}

describe("handleTabList", () => {
  it("returns invalid_params for unknown scope values", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([10]) });
    await sm.start("aa11");
    const res = await handleTabList(
      sm,
      { session_id: "aa11", scope: "private" } as unknown as Parameters<typeof handleTabList>[1],
      fakeChromeTabsApi([]),
    );
    expect(res).toMatchObject({ code: "invalid_params" });
  });

  it("default scope=all unions user and agent tabs when scope is omitted", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabs = fakeChromeTabsApi([
      { windowId: 100, url: "chrome://newtab/", title: "Agent New Tab", active: true },
      { windowId: 200, url: "https://example.com", title: "Example", active: true },
    ]);
    const res = await handleTabList(sm, { session_id: "aa11" }, tabs);
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tabs).toHaveLength(2);
    expect(res.tabs.map((t) => t.scope).sort()).toEqual(["agent", "user"]);
  });

  it("scope=user excludes the requesting session's Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabs = fakeChromeTabsApi([
      { windowId: 100, url: "chrome://newtab/", title: "Agent New Tab", active: true },
      { windowId: 200, url: "https://example.com", title: "Example", active: true },
      { windowId: 200, url: "https://github.com", title: "GitHub", active: false },
    ]);
    const res = await handleTabList(sm, { session_id: "aa11", scope: "user" }, tabs);
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tabs).toHaveLength(2);
    expect(res.tabs.every((t) => t.scope === "user")).toBe(true);
    expect(res.tabs.map((t) => t.url)).toEqual(["https://example.com", "https://github.com"]);
  });

  it("scope=agent returns only the requesting session's Agent Window tabs", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabs = fakeChromeTabsApi([
      { windowId: 100, url: "chrome://newtab/", title: "Agent" },
      { windowId: 200, url: "https://example.com" },
    ]);
    const res = await handleTabList(sm, { session_id: "aa11", scope: "agent" }, tabs);
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tabs).toHaveLength(1);
    expect(res.tabs[0]).toMatchObject({ scope: "agent", url: "chrome://newtab/" });
  });

  it("hides other sessions' Agent Window tabs from scope=all (cross-session isolation)", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 200]) });
    await sm.start("aa11"); // agent window 100
    await sm.start("bb22"); // agent window 200
    const tabs = fakeChromeTabsApi([
      { windowId: 100, url: "chrome://newtab/" }, // aa11's agent window
      { windowId: 200, url: "https://internal-tools/" }, // bb22's agent window — must be hidden from aa11
      { windowId: 300, url: "https://example.com" },
    ]);
    const res = await handleTabList(sm, { session_id: "aa11", scope: "all" }, tabs);
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tabs.map((t) => t.url).sort()).toEqual(["chrome://newtab/", "https://example.com"]);
  });
});

// ---------------------------------------------------------------------------
// M8 helpers
// ---------------------------------------------------------------------------

interface FakeTabState {
  tabs: Map<number, chrome.tabs.Tab>;
  nextTabId: number;
  windowsClosed: Set<number>;
}

function makeTabMutationApi(state: FakeTabState): {
  api: TabMutationApi;
  spies: {
    create: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    move: ReturnType<typeof vi.fn>;
  };
} {
  const create = vi.fn(async (props: chrome.tabs.CreateProperties) => {
    const id = state.nextTabId++;
    const tab = {
      id,
      windowId: props.windowId ?? 1,
      url: props.url ?? "",
      pendingUrl: props.url,
      active: props.active ?? true,
      index: props.index ?? state.tabs.size,
    } as chrome.tabs.Tab;
    state.tabs.set(id, tab);
    return tab;
  });
  const remove = vi.fn(async (tabId: number) => {
    state.tabs.delete(tabId);
  });
  const update = vi.fn(async (tabId: number, props: chrome.tabs.UpdateProperties) => {
    const t = state.tabs.get(tabId);
    if (!t) throw new Error(`update: tab ${tabId} not found`);
    if (props.active !== undefined) (t as { active?: boolean }).active = props.active;
    return t;
  });
  const get = vi.fn(async (tabId: number) => {
    const t = state.tabs.get(tabId);
    if (!t) throw new Error(`get: tab ${tabId} not found`);
    return t;
  });
  const move = vi.fn(async (tabId: number, props: chrome.tabs.MoveProperties) => {
    const t = state.tabs.get(tabId);
    if (!t) throw new Error(`move: tab ${tabId} not found`);
    if (typeof props.windowId === "number") {
      if (state.windowsClosed.has(props.windowId)) {
        throw new Error(`move: window ${props.windowId} closed`);
      }
      (t as { windowId?: number }).windowId = props.windowId;
    }
    if (typeof props.index === "number") {
      (t as { index?: number }).index = props.index === -1 ? 999 : props.index;
    }
    return t;
  });
  return {
    api: { create, remove, update, get, move },
    spies: { create, remove, update, get, move },
  };
}

function makeWindowsApi(
  state: FakeTabState,
  opts?: { lastFocused?: number | null; createWindowId?: number },
): {
  api: ChromeWindowsApi;
  spies: {
    get: ReturnType<typeof vi.fn>;
    lastFocused: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
} {
  const get = vi.fn(async (windowId: number) => {
    if (state.windowsClosed.has(windowId)) {
      throw new Error(`window ${windowId} closed`);
    }
    return { id: windowId } as chrome.windows.Window;
  });
  const lastFocused = vi.fn(async () => {
    if (opts?.lastFocused === null) {
      throw new Error("no last focused window");
    }
    return { id: opts?.lastFocused ?? 500 } as chrome.windows.Window;
  });
  const create = vi.fn(async (_props: chrome.windows.CreateData) => {
    const id = opts?.createWindowId ?? 999;
    return { id } as chrome.windows.Window;
  });
  return { api: { get, getLastFocused: lastFocused, create }, spies: { get, lastFocused, create } };
}

describe("handleTabCreate", () => {
  it("creates a tab inside the requesting session's Agent Window with the default URL", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = { tabs: new Map(), nextTabId: 10, windowsClosed: new Set() };
    const { api, spies } = makeTabMutationApi(state);
    const res = await handleTabCreate(sm, { session_id: "aa11" }, { tabs: api });
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(spies.create).toHaveBeenCalledWith({
      windowId: 100,
      url: NEW_TAB_DEFAULT_URL,
      active: true,
    });
    expect(res).toMatchObject({ tab_id: 10, window_id: 100 });
  });

  it("forwards explicit url + index + active=false", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = { tabs: new Map(), nextTabId: 10, windowsClosed: new Set() };
    const { api, spies } = makeTabMutationApi(state);
    const res = await handleTabCreate(
      sm,
      {
        session_id: "aa11",
        url: "https://example.com/",
        active: false,
        index: 2,
      },
      { tabs: api },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(spies.create).toHaveBeenCalledWith({
      windowId: 100,
      url: "https://example.com/",
      active: false,
      index: 2,
    });
    expect(res.url).toBe("https://example.com/");
  });

  it("rejects negative index", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = { tabs: new Map(), nextTabId: 10, windowsClosed: new Set() };
    const { api } = makeTabMutationApi(state);
    const res = await handleTabCreate(sm, { session_id: "aa11", index: -1 }, { tabs: api });
    expect(res).toMatchObject({ code: "invalid_params" });
  });
});

describe("handleTabClose", () => {
  it("removes a tab inside the Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[5, { id: 5, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const res = await handleTabClose(sm, { session_id: "aa11", tab_id: 5 }, { tabs: api });
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tab_id).toBe(5);
    expect(spies.remove).toHaveBeenCalledWith(5);
  });

  it("rejects closing a borrowed tab — caller must tab_return first", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(8, { tabId: 8, originalWindowId: 200, originalIndex: 3 });
    const state: FakeTabState = {
      tabs: new Map([[8, { id: 8, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const res = await handleTabClose(sm, { session_id: "aa11", tab_id: 8 }, { tabs: api });
    expect(res).toMatchObject({ code: "invalid_params" });
    expect(spies.remove).not.toHaveBeenCalled();
  });

  it("refuses to close a tab outside the Agent Window with permission_denied", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[9, { id: 9, windowId: 200 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api } = makeTabMutationApi(state);
    const res = await handleTabClose(sm, { session_id: "aa11", tab_id: 9 }, { tabs: api });
    expect(res).toMatchObject({ code: "permission_denied", data: { reason: "agent_window_scope" } });
  });

  it("rejects when another session has borrowed the tab", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 200]) });
    await sm.start("aa11");
    const ctxB = await sm.start("bb22");
    ctxB.borrowedTabs.set(7, { tabId: 7, originalWindowId: 300, originalIndex: 1 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api } = makeTabMutationApi(state);
    const res = await handleTabClose(sm, { session_id: "aa11", tab_id: 7 }, { tabs: api });
    expect(res).toMatchObject({ code: "permission_denied", data: { reason: "borrow_conflict" } });
  });
});

describe("handleTabSelect", () => {
  it("activates a tab inside the Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[3, { id: 3, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const res = await handleTabSelect(sm, { session_id: "aa11", tab_id: 3 }, { tabs: api });
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res).toEqual({ tab_id: 3, window_id: 100 });
    expect(spies.update).toHaveBeenCalledWith(3, { active: true });
  });

  it("rejects activating a tab in a different session's Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 200]) });
    await sm.start("aa11");
    await sm.start("bb22");
    const state: FakeTabState = {
      tabs: new Map([[3, { id: 3, windowId: 200 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api } = makeTabMutationApi(state);
    const res = await handleTabSelect(sm, { session_id: "aa11", tab_id: 3 }, { tabs: api });
    expect(res).toMatchObject({ code: "permission_denied", data: { reason: "agent_window_scope" } });
  });

  it("rejects a borrowed tab that is no longer in the Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(3, { tabId: 3, originalWindowId: 200, originalIndex: 0 });
    const state: FakeTabState = {
      tabs: new Map([[3, { id: 3, windowId: 200 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api } = makeTabMutationApi(state);
    const res = await handleTabSelect(sm, { session_id: "aa11", tab_id: 3 }, { tabs: api });
    expect(res).toMatchObject({ code: "permission_denied", data: { reason: "agent_window_scope" } });
  });
});

describe("handleTabBorrow", () => {
  it("moves the tab into the Agent Window and records the original position", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 4 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const res = await handleTabBorrow(sm, { session_id: "aa11", tab_id: 7 }, { tabs: api });
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res).toEqual({
      tab_id: 7,
      original_window_id: 200,
      original_index: 4,
      agent_window_id: 100,
    });
    expect(ctx.borrowedTabs.get(7)).toEqual({
      tabId: 7,
      originalWindowId: 200,
      originalIndex: 4,
    });
    expect(spies.move).toHaveBeenCalledWith(7, { windowId: 100, index: -1 });
    expect(spies.update).toHaveBeenCalledWith(7, { active: true });
  });

  it("refuses to borrow a tab already inside the Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100, index: 0 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api } = makeTabMutationApi(state);
    const res = await handleTabBorrow(sm, { session_id: "aa11", tab_id: 7 }, { tabs: api });
    expect(res).toMatchObject({ code: "invalid_params" });
  });

  it("refuses to borrow a tab already held by another session", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 200]) });
    await sm.start("aa11");
    const ctxB = await sm.start("bb22");
    ctxB.borrowedTabs.set(7, { tabId: 7, originalWindowId: 300, originalIndex: 1 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 0 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api } = makeTabMutationApi(state);
    const res = await handleTabBorrow(sm, { session_id: "aa11", tab_id: 7 }, { tabs: api });
    expect(res).toMatchObject({ code: "permission_denied", data: { reason: "borrow_conflict" } });
  });

  it("allows only one concurrent borrow of the same tab across sessions", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 200]) });
    await sm.start("aa11");
    await sm.start("bb22");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 300, index: 1 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api } = makeTabMutationApi(state);

    const [a, b] = await Promise.all([
      handleTabBorrow(sm, { session_id: "aa11", tab_id: 7 }, { tabs: api }),
      handleTabBorrow(sm, { session_id: "bb22", tab_id: 7 }, { tabs: api }),
    ]);

    const results = [a, b];
    expect(results.filter((r) => !("code" in r))).toHaveLength(1);
    expect(results.filter((r) => "code" in r && r.code === "permission_denied")).toHaveLength(1);
    expect(sm.list().filter((ctx) => ctx.borrowedTabs.has(7))).toHaveLength(1);
  });

  it("refuses to borrow a tab inside another session's Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 200]) });
    await sm.start("aa11");
    await sm.start("bb22");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 0 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api } = makeTabMutationApi(state);
    const res = await handleTabBorrow(sm, { session_id: "aa11", tab_id: 7 }, { tabs: api });
    expect(res).toMatchObject({ code: "permission_denied", data: { reason: "agent_window_scope" } });
  });

  it("returns cancelled when the approver declines", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 0 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const res = await handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, approveBorrow: async () => false },
    );
    expect(res).toMatchObject({ code: "cancelled" });
    expect(ctx.borrowedTabs.has(7)).toBe(false);
    expect(spies.move).not.toHaveBeenCalled();
  });

  it("passes confirm to the approver and treats approver errors as cancellation", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 0 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const approveBorrow = vi.fn(async () => {
      throw new Error("confirmation dismissed");
    });

    const res = await handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7, confirm: false },
      { tabs: api, approveBorrow },
    );

    expect(approveBorrow).toHaveBeenCalledWith({ sessionId: "aa11", tabId: 7, confirm: false });
    expect(res).toMatchObject({ code: "cancelled" });
    expect(spies.move).not.toHaveBeenCalled();
  });
});

describe("handleTabReturn", () => {
  it("returns the tab to its original window/index and clears borrowedTabs", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100, index: 999 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const { api: windowsApi } = makeWindowsApi(state);
    const res = await handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, windows: windowsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.returned_to_window_id).toBe(200);
    expect(res.returned_to_index).toBe(4);
    expect(res.fallback).toBeUndefined();
    expect(ctx.borrowedTabs.has(7)).toBe(false);
    expect(spies.move).toHaveBeenCalledWith(7, { windowId: 200, index: 4 });
  });

  it("resets agent overlays in a returned tab after a successful tab_return", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100, index: 999 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api } = makeTabMutationApi(state);
    const { api: windowsApi } = makeWindowsApi(state);
    const agentOverlayReset = {
      resetAgentOverlays: vi.fn(async () => {}),
    } satisfies AgentOverlayResetApi;

    const res = await handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, windows: windowsApi, agentOverlayReset },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(agentOverlayReset.resetAgentOverlays).toHaveBeenCalledWith(7, "aa11");
  });

  it("falls back to the last focused normal window when the original is gone", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set([200]),
    };
    const { api, spies } = makeTabMutationApi(state);
    const { api: windowsApi, spies: winSpies } = makeWindowsApi(state, { lastFocused: 500 });
    const res = await handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, windows: windowsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.returned_to_window_id).toBe(500);
    expect(res.fallback).toBe(true);
    expect(spies.move).toHaveBeenCalledWith(7, { windowId: 500, index: -1 });
    expect(winSpies.create).not.toHaveBeenCalled();
  });

  it("creates a new window when no normal window remains", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set([200]),
    };
    const { api } = makeTabMutationApi(state);
    const { api: windowsApi, spies: winSpies } = makeWindowsApi(state, {
      lastFocused: null,
      createWindowId: 777,
    });
    const res = await handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, windows: windowsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.returned_to_window_id).toBe(777);
    expect(res.fallback).toBe(true);
    expect(winSpies.create).toHaveBeenCalledOnce();
  });

  it("falls back to a new window when getLastFocused only returns the Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set([200]),
    };
    const { api } = makeTabMutationApi(state);
    const { api: windowsApi, spies: winSpies } = makeWindowsApi(state, {
      lastFocused: 100,
      createWindowId: 777,
    });
    const res = await handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, windows: windowsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.returned_to_window_id).toBe(777);
    expect(winSpies.create).toHaveBeenCalledOnce();
  });

  it("does not fall back into another session's Agent Window (creates a new window instead)", async () => {
    // Regression: a returned borrowed tab whose original window is gone
    // must never be parked in *another* session's Agent Window. Agent
    // Windows are `type: "normal"`, so getLastFocused({windowTypes:
    // ["normal"]}) can return session bb22's window (200). Without the
    // isAgentWindowId guard the tab would be moved into window 200,
    // letting bb22 write to it and destroying it when bb22 stops.
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 200]) });
    const ctx = await sm.start("aa11");
    await sm.start("bb22"); // owns Agent Window 200
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 300, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set([300]),
    };
    const { api, spies } = makeTabMutationApi(state);
    const { api: windowsApi, spies: winSpies } = makeWindowsApi(state, {
      lastFocused: 200, // session bb22's Agent Window
      createWindowId: 777,
    });
    const res = await handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, windows: windowsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.returned_to_window_id).toBe(777);
    expect(res.fallback).toBe(true);
    expect(winSpies.create).toHaveBeenCalledOnce();
    expect(spies.move).not.toHaveBeenCalledWith(7, expect.objectContaining({ windowId: 200 }));
  });

  it("returnBorrowedTab honours an explicit isAgentWindowId predicate", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 300, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set([300]),
    };
    const { api, spies } = makeTabMutationApi(state);
    const { api: windowsApi, spies: winSpies } = makeWindowsApi(state, {
      lastFocused: 555,
      createWindowId: 777,
    });
    const res = await returnBorrowedTab(ctx, 7, {
      tabs: api,
      windows: windowsApi,
      isAgentWindowId: (windowId) => windowId === 555,
    });
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.toWindowId).toBe(777);
    expect(res.fallback).toBe(true);
    expect(winSpies.create).toHaveBeenCalledOnce();
    expect(spies.move).not.toHaveBeenCalledWith(7, expect.objectContaining({ windowId: 555 }));
  });

  it("returns not_found when the tab is not borrowed by this session", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = { tabs: new Map(), nextTabId: 50, windowsClosed: new Set() };
    const { api } = makeTabMutationApi(state);
    const { api: windowsApi } = makeWindowsApi(state);
    const res = await handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 9999 },
      { tabs: api, windows: windowsApi },
    );
    expect(res).toMatchObject({ code: "not_found" });
  });

  it("returnBorrowedTab surfaces a chrome.tabs.move failure as cdp_failed", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api } = makeTabMutationApi(state);
    api.move = vi.fn(async () => {
      throw new Error("simulated move failure");
    });
    const { api: windowsApi } = makeWindowsApi(state);
    const res = await returnBorrowedTab(ctx, 7, { tabs: api, windows: windowsApi });
    expect(res).toMatchObject({ code: "cdp_failed" });
  });

  it("falls back to a new window when moving back to the original position fails", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    spies.move.mockImplementationOnce(async () => {
      throw new Error("original index no longer valid");
    });
    const { api: windowsApi } = makeWindowsApi(state, {
      lastFocused: 100,
      createWindowId: 777,
    });

    const res = await returnBorrowedTab(ctx, 7, { tabs: api, windows: windowsApi });

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.toWindowId).toBe(777);
    expect(res.fallback).toBe(true);
    expect(spies.move).toHaveBeenLastCalledWith(7, { windowId: 777, index: 0 });
  });
});
