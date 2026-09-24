import { describe, expect, it, vi } from "vitest";
import { type CdpDebuggerApi, ChromiumCdp } from "@/browser-driver/chromium-cdp";
import { SessionManager } from "@/session-manager/manager";
import { handleHover } from "../interaction";
import { resolveTargetTab } from "../shared";
import {
  type AgentOverlayResetApi,
  type ChromeTabGroupsApi,
  type ChromeWindowsApi,
  handleTabBorrow,
  handleTabClose,
  handleTabCreate,
  handleTabGroupCreate,
  handleTabGroupList,
  handleTabGroupUngroup,
  handleTabGroupUpdate,
  handleTabList,
  handleTabReturn,
  handleTabSelect,
  NEW_TAB_DEFAULT_URL,
  returnBorrowedTab,
  type TabGroupMutationApi,
  type TabMutationApi,
} from "../tabs";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  return {
    create: vi.fn(async () => {
      const id = ids[i++];
      if (id === undefined) throw new Error("ran out of fake window ids");
      return { windowId: id, initialTabIds: [] };
    }),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => 1),
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
    remove: ReturnType<typeof vi.fn>;
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
  const remove = vi.fn(async (windowId: number) => {
    state.windowsClosed.add(windowId);
  });
  return {
    api: { get, getLastFocused: lastFocused, create, remove },
    spies: { get, lastFocused, create, remove },
  };
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
    expect(sm.get("aa11")?.agentCreatedTabs.has(10)).toBe(true);
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

  it("does not claim any tab when chrome.tabs.create fails", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = { tabs: new Map(), nextTabId: 10, windowsClosed: new Set() };
    const { api, spies } = makeTabMutationApi(state);
    spies.create.mockRejectedValueOnce(new Error("chrome.tabs.create failed"));

    const res = await handleTabCreate(sm, { session_id: "aa11" }, { tabs: api });
    expect(res).toMatchObject({ code: "protocol_error" });

    expect(sm.get("aa11")?.agentCreatedTabs).toEqual(new Set([1]));
  });

  it("claims the returned id even when a user tab appears during tab creation", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    const state: FakeTabState = { tabs: new Map(), nextTabId: 10, windowsClosed: new Set() };
    const { api, spies } = makeTabMutationApi(state);
    let resolveCreate!: (tab: chrome.tabs.Tab) => void;
    const createResult = new Promise<chrome.tabs.Tab>((resolve) => {
      resolveCreate = resolve;
    });
    spies.create.mockImplementationOnce(() => createResult);

    const pending = handleTabCreate(sm, { session_id: "aa11" }, { tabs: api });
    // A user can create an unrelated same-window tab while Chrome is still
    // resolving the agent request. There is no pending slot for it to steal.
    expect(ctx.agentCreatedTabs.has(99)).toBe(false);
    resolveCreate({ id: 10, windowId: 100, active: true } as chrome.tabs.Tab);

    await expect(pending).resolves.toMatchObject({ tab_id: 10 });
    expect(ctx.agentCreatedTabs.has(10)).toBe(true);
    expect(ctx.agentCreatedTabs.has(99)).toBe(false);
  });
});

describe("handleTabClose", () => {
  it("does not infer remote popup ownership from its opener and explains how to borrow it", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]), remote: () => true });
    const ctx = await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[5, { id: 5, windowId: 100, openerTabId: 1 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    expect(
      await handleTabClose(sm, { session_id: "aa11", tab_id: 5 }, { tabs: api }),
    ).toMatchObject({ code: "permission_denied" });
    const approval = vi.fn(async () => true);
    expect(
      await handleTabBorrow(
        sm,
        { session_id: "aa11", tab_id: 5 },
        { tabs: api, approveBorrow: approval },
      ),
    ).toMatchObject({
      code: "invalid_params",
      message: expect.stringContaining("regular browser window"),
    });
    expect(ctx.agentCreatedTabs.has(5)).toBe(false);
    expect(spies.remove).not.toHaveBeenCalled();
    expect(approval).not.toHaveBeenCalled();
  });
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
    expect(res).toMatchObject({
      code: "permission_denied",
      data: { reason: "agent_window_scope" },
    });
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
    expect(res).toMatchObject({
      code: "permission_denied",
      data: { reason: "agent_window_scope" },
    });
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
    expect(res).toMatchObject({
      code: "permission_denied",
      data: { reason: "agent_window_scope" },
    });
  });
});

describe("handleTabBorrow", () => {
  it("reports an unknown effect when cancellation rollback fails", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 4 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const abort = new AbortController();
    spies.move.mockImplementationOnce(async () => {
      abort.abort();
      return {} as chrome.tabs.Tab;
    });
    spies.move.mockRejectedValueOnce(new Error("Original window closed"));
    expect(
      await handleTabBorrow(
        sm,
        { session_id: "aa11", tab_id: 7, confirm: false },
        { tabs: api, signal: abort.signal, approveBorrow: async () => true },
      ),
    ).toMatchObject({
      data: { reason: "borrow_outcome_unknown", effect_state: "unknown", original_window_id: 200 },
    });
  });

  it("returns a moved tab if its session ends before the borrow commits", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 4 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    spies.move.mockImplementationOnce(async (id, props) => {
      await sm.stop("aa11");
      return { id, windowId: props.windowId } as chrome.tabs.Tab;
    });
    expect(
      await handleTabBorrow(
        sm,
        { session_id: "aa11", tab_id: 7, confirm: false },
        { tabs: api, approveBorrow: async () => true },
      ),
    ).toMatchObject({ code: "cancelled" });
    expect(spies.move).toHaveBeenLastCalledWith(7, { windowId: 200, index: 4 });
  });

  it.each([
    undefined,
    false,
    true,
  ])("legacy confirm=%s cannot bypass the browser approver", async (confirm) => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    Object.assign(sm.get("aa11")!, { unattended: true });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 4 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    let respond!: (allowed: boolean) => void;
    const approveBorrow = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          respond = resolve;
        }),
    );
    const pending = handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7, confirm },
      { tabs: api, approveBorrow },
    );
    await vi.waitFor(() => expect(approveBorrow).toHaveBeenCalledOnce());
    expect(spies.move).not.toHaveBeenCalled();
    respond(false);
    expect(await pending).toMatchObject({ code: "cancelled", data: { reason: "user_denied" } });
    expect(spies.move).not.toHaveBeenCalled();
  });

  it("missing approval wiring never silently borrows a user tab", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const { api, spies } = makeTabMutationApi({
      tabs: new Map([[7, { id: 7, windowId: 200, index: 0 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    });
    expect(
      await handleTabBorrow(sm, { session_id: "aa11", tab_id: 7, confirm: false }, { tabs: api }),
    ).toMatchObject({ code: "permission_denied", data: { reason: "confirmation_ui_unavailable" } });
    expect(spies.move).not.toHaveBeenCalled();
  });

  it("returns an existing successful borrow without moving or asking again", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 4 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const approveBorrow = vi.fn().mockResolvedValue(true);
    const first = await handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, approveBorrow },
    );
    expect(
      await handleTabBorrow(sm, { session_id: "aa11", tab_id: 7 }, { tabs: api, approveBorrow }),
    ).toEqual(first);
    expect(approveBorrow).toHaveBeenCalledTimes(1);
    expect(spies.move).toHaveBeenCalledTimes(1);
  });

  it("does not create a second prompt while the same session is awaiting consent", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 4 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    let allow!: (value: boolean) => void;
    const approveBorrow = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          allow = resolve;
        }),
    );
    const pending = handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, approveBorrow },
    );
    await vi.waitFor(() => expect(allow).toBeDefined());
    expect(
      await handleTabBorrow(sm, { session_id: "aa11", tab_id: 7 }, { tabs: api, approveBorrow }),
    ).toMatchObject({ data: { reason: "borrow_in_progress" } });
    allow(true);
    expect(await pending).toMatchObject({ tab_id: 7 });
    expect(approveBorrow).toHaveBeenCalledTimes(1);
    expect(spies.move).toHaveBeenCalledTimes(1);
  });

  it("ignores late consent after cancellation and releases the pending reservation", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 4 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    let allow!: (value: boolean) => void;
    const signal = new AbortController();
    const pending = handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7 },
      {
        tabs: api,
        signal: signal.signal,
        approveBorrow: () =>
          new Promise<boolean>((resolve) => {
            allow = resolve;
          }),
      },
    );
    await vi.waitFor(() => expect(allow).toBeDefined());
    signal.abort();
    allow(true);
    expect(await pending).toMatchObject({ code: "cancelled" });
    expect(spies.move).not.toHaveBeenCalled();
    expect(
      await handleTabBorrow(
        sm,
        { session_id: "aa11", tab_id: 7, confirm: false },
        { tabs: api, approveBorrow: async () => true },
      ),
    ).toMatchObject({ tab_id: 7 });
  });

  it("moves the tab into the Agent Window and records the original position", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 4 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const res = await handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, approveBorrow: async () => true },
    );
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
    const res = await handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, approveBorrow: async () => true },
    );
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
    const res = await handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, approveBorrow: async () => true },
    );
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
      handleTabBorrow(
        sm,
        { session_id: "aa11", tab_id: 7 },
        { tabs: api, approveBorrow: async () => true },
      ),
      handleTabBorrow(
        sm,
        { session_id: "bb22", tab_id: 7 },
        { tabs: api, approveBorrow: async () => true },
      ),
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
    const res = await handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, approveBorrow: async () => true },
    );
    expect(res).toMatchObject({
      code: "permission_denied",
      data: { reason: "agent_window_scope" },
    });
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

  it("discards the legacy confirm input and treats approver errors as cancellation", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 200, index: 0 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const approveBorrow = vi.fn(async (_ctx: unknown) => {
      throw new Error("confirmation dismissed");
    });

    const res = await handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7, confirm: true },
      { tabs: api, approveBorrow },
    );

    expect(approveBorrow).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "aa11", tabId: 7 }),
    );
    expect(approveBorrow.mock.calls[0]?.[0]).not.toHaveProperty("confirm");
    expect(res).toMatchObject({ code: "cancelled" });
    expect(spies.move).not.toHaveBeenCalled();
  });
});

describe("handleTabReturn", () => {
  it.each([
    "not_found",
    "cdp_failed",
  ])("detaches after selector resolution fails with %s", async (code) => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api } = makeTabMutationApi(state);
    const { api: windows } = makeWindowsApi(state);
    const debuggerApi = {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async (_target: unknown, method: string) => {
        if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
        if (method === "DOM.querySelector") {
          if (code === "cdp_failed") throw new Error("selector query failed");
          return { nodeId: 0 };
        }
        return {};
      }),
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    const cdp = new ChromiumCdp(debuggerApi as unknown as CdpDebuggerApi);

    const hover = await handleHover(
      sm,
      { session_id: "aa11", tab_id: 7, selector: "#missing" },
      {
        cdp,
        tabsApi: { get: api.get, query: vi.fn(async () => []) },
      },
    );
    expect(hover).toMatchObject({ code });
    expect(cdp.isAttached(7)).toBe(true);

    const returned = await handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 7 },
      {
        tabs: api,
        windows,
        cdp,
        agentOverlayReset: { resetAgentOverlays: vi.fn(async () => {}) },
      },
    );
    expect(returned).toMatchObject({ returned_to_window_id: 200 });
    expect(ctx.borrowedTabs.has(7)).toBe(false);
    expect(cdp.isAttached(7)).toBe(false);
    expect(debuggerApi.detach).toHaveBeenCalledExactlyOnceWith({ tabId: 7 });
    cdp.dispose();
  });

  it("honours cancellation while preparing a validated return", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const { api: windows } = makeWindowsApi(state);
    const controller = new AbortController();
    const beforeReturn = vi.fn(async () => {
      controller.abort();
    });
    const result = await handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 7 },
      {
        tabs: api,
        windows,
        signal: controller.signal,
        beforeReturn,
      },
    );

    expect(result).toMatchObject({ code: "cancelled" });
    expect(beforeReturn).toHaveBeenCalledExactlyOnceWith("aa11", 7);
    expect(spies.move).not.toHaveBeenCalled();
    expect(ctx.borrowedTabs.has(7)).toBe(true);
  });

  it.each([
    "original",
    "fallback",
    "cleanup_failed",
    "failed",
    "cancelled",
  ])("releases CDP only after a successful return (%s)", async (mode) => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api, spies } = makeTabMutationApi(state);
    const { api: windowsApi } = makeWindowsApi(state, { lastFocused: 500 });
    const success = mode !== "failed" && mode !== "cancelled";
    if (mode === "fallback") spies.move.mockRejectedValueOnce(new Error("original move failed"));
    if (mode === "failed") spies.move.mockRejectedValue(new Error("move failed"));
    let windowAtRelease: number | undefined;
    const cdp = {
      releaseSessionTab: vi.fn(async () => {
        windowAtRelease = state.tabs.get(7)?.windowId;
        if (mode === "cleanup_failed") throw new Error("debugger release failed");
      }),
    };
    const controller = new AbortController();
    if (mode === "cancelled") controller.abort();

    const result = await handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 7 },
      {
        tabs: api,
        windows: windowsApi,
        cdp,
        signal: controller.signal,
        agentOverlayReset: { resetAgentOverlays: vi.fn(async () => {}) },
      },
    );

    expect("code" in result).toBe(!success);
    expect(ctx.borrowedTabs.has(7)).toBe(!success);
    expect(cdp.releaseSessionTab).toHaveBeenCalledTimes(success ? 1 : 0);
    if (success) {
      expect(cdp.releaseSessionTab).toHaveBeenCalledWith("aa11", 7);
      expect(windowAtRelease).toBe(mode === "fallback" ? 500 : 200);
      expect(spies.move).toHaveBeenCalledTimes(mode === "fallback" ? 2 : 1);
    }
  });

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

  it("closes a newly created fallback window when cancellation wins before the move", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set([200]),
    };
    const { api, spies } = makeTabMutationApi(state);
    const { api: windowsApi, spies: winSpies } = makeWindowsApi(state, {
      lastFocused: 100,
      createWindowId: 777,
    });
    let resolveCreate: (window: chrome.windows.Window) => void = () => {};
    winSpies.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const controller = new AbortController();

    const pending = handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, windows: windowsApi, signal: controller.signal },
    );
    await vi.waitFor(() => expect(winSpies.create).toHaveBeenCalledOnce());
    controller.abort();
    resolveCreate({ id: 777 } as chrome.windows.Window);

    await expect(pending).resolves.toMatchObject({ code: "cancelled" });
    expect(winSpies.remove).toHaveBeenCalledWith(777);
    expect(spies.move).not.toHaveBeenCalled();
    expect(ctx.borrowedTabs.has(7)).toBe(true);
  });

  it("surfaces the fallback window id when cancellation cleanup fails", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 4 });
    const state: FakeTabState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set([200]),
    };
    const { api, spies } = makeTabMutationApi(state);
    const { api: windowsApi, spies: winSpies } = makeWindowsApi(state, {
      lastFocused: 100,
      createWindowId: 777,
    });
    let resolveCreate: (window: chrome.windows.Window) => void = () => {};
    winSpies.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    winSpies.remove.mockRejectedValueOnce(new Error("window removal denied"));
    const controller = new AbortController();

    const pending = handleTabReturn(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, windows: windowsApi, signal: controller.signal },
    );
    await vi.waitFor(() => expect(winSpies.create).toHaveBeenCalledOnce());
    controller.abort();
    resolveCreate({ id: 777 } as chrome.windows.Window);

    await expect(pending).resolves.toMatchObject({
      code: "protocol_error",
      data: { reason: "cleanup_failed", resource_type: "window", resource_id: 777 },
      message: expect.stringMatching(/fallback window 777.*window removal denied/),
    });
    expect(spies.move).not.toHaveBeenCalled();
    expect(ctx.borrowedTabs.has(7)).toBe(true);
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

describe("background tab initialization", () => {
  it("establishes execution before the destination can start without selecting the tab", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    const state: FakeTabState = { tabs: new Map(), nextTabId: 50, windowsClosed: new Set() };
    const { api, spies } = makeTabMutationApi(state);
    const acquireBackgroundExecution = vi.fn(async (session: string, tabId: number) => {
      expect(session).toBe("aa11");
      expect(ctx.agentCreatedTabs.has(tabId)).toBe(true);
      expect(state.tabs.get(tabId)).toMatchObject({ url: "about:blank", active: false });
      expect(spies.update).not.toHaveBeenCalled();
    });
    expect(
      await handleTabCreate(
        sm,
        { session_id: "aa11", url: "https://fixture.test", active: false },
        { tabs: api, cdp: { acquireBackgroundExecution } },
      ),
    ).toMatchObject({ tab_id: 50, url: "https://fixture.test" });
    expect(acquireBackgroundExecution).toHaveBeenCalledOnce();
    expect(spies.update).toHaveBeenCalledExactlyOnceWith(50, { url: "https://fixture.test" });
  });

  it.each([
    false,
    true,
  ])("rolls back failed or cancelled initialization (cancel=%s)", async (cancel) => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    const state: FakeTabState = { tabs: new Map(), nextTabId: 50, windowsClosed: new Set() };
    const { api, spies } = makeTabMutationApi(state);
    const controller = new AbortController();
    const cdp = {
      acquireBackgroundExecution: vi.fn(async () => {
        if (cancel) controller.abort();
        else throw new Error("unsupported");
      }),
      releaseSessionTab: vi.fn(async () => {}),
    };
    expect(
      await handleTabCreate(
        sm,
        { session_id: "aa11", url: "https://fixture.test", active: false },
        { tabs: api, cdp, signal: controller.signal },
      ),
    ).toMatchObject({ code: cancel ? "cancelled" : "cdp_failed" });
    expect(cdp.releaseSessionTab).toHaveBeenCalledWith("aa11", 50);
    expect(spies.update).not.toHaveBeenCalled();
    expect(state.tabs.has(50)).toBe(false);
    expect(ctx.agentCreatedTabs.has(50)).toBe(false);
  });
});

it("creates a CDP-ready blank default tab so later navigation starts under the policy", async () => {
  const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
  await sm.start("aa11");
  const state: FakeTabState = { tabs: new Map(), nextTabId: 50, windowsClosed: new Set() };
  const { api, spies } = makeTabMutationApi(state);
  const acquireBackgroundExecution = vi.fn(async () => {});
  expect(
    await handleTabCreate(
      sm,
      { session_id: "aa11", active: false },
      { tabs: api, cdp: { acquireBackgroundExecution } },
    ),
  ).toMatchObject({ url: "about:blank" });
  expect(acquireBackgroundExecution).toHaveBeenCalledWith("aa11", 50);
  expect(spies.update).not.toHaveBeenCalled();
});

it("returns a borrowed page without activating it when execution setup fails", async () => {
  const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
  const ctx = await sm.start("aa11");
  const state: FakeTabState = {
    tabs: new Map([
      [
        7,
        {
          id: 7,
          windowId: 200,
          index: 4,
          active: false,
          url: "https://fixture.test",
        } as chrome.tabs.Tab,
      ],
    ]),
    nextTabId: 50,
    windowsClosed: new Set(),
  };
  const { api, spies } = makeTabMutationApi(state);
  const cdp = {
    acquireBackgroundExecution: vi.fn(async () => {
      throw new Error("unsupported");
    }),
    releaseSessionTab: vi.fn(async () => {}),
  };
  expect(
    await handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7 },
      {
        tabs: api,
        windows: makeWindowsApi(state).api,
        cdp,
        approveBorrow: async () => true,
        agentOverlayReset: { resetAgentOverlays: async () => {} },
      },
    ),
  ).toMatchObject({ code: "cdp_failed" });
  expect(state.tabs.get(7)).toMatchObject({ windowId: 200, index: 4, active: false });
  expect(ctx.borrowedTabs.has(7)).toBe(false);
  expect(cdp.releaseSessionTab).toHaveBeenCalledWith("aa11", 7);
  expect(spies.update).not.toHaveBeenCalled();
});

it.each([
  [true, false],
  [true, true],
  [false, true],
])("independently releases and closes failed creation (release=%s, close=%s)", async (releaseFails, closeFails) => {
  const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
  const ctx = await sm.start("aa11");
  const state: FakeTabState = { tabs: new Map(), nextTabId: 50, windowsClosed: new Set() };
  const { api, spies } = makeTabMutationApi(state);
  if (closeFails) spies.remove.mockRejectedValueOnce(new Error("close failed"));
  const cdp = {
    acquireBackgroundExecution: vi.fn(async () => {
      throw new Error("setup failed");
    }),
    releaseSessionTab: vi.fn(async () => {
      if (releaseFails) throw new Error("release failed");
    }),
  };
  const result = await handleTabCreate(
    sm,
    { session_id: "aa11", active: false },
    { tabs: api, cdp },
  );
  expect(result).toMatchObject({ code: "protocol_error" });
  expect(JSON.stringify(result)).toContain("setup failed");
  if (releaseFails) expect(JSON.stringify(result)).toContain("release failed");
  if (closeFails) expect(JSON.stringify(result)).toContain("close failed");
  expect(cdp.releaseSessionTab).toHaveBeenCalledWith("aa11", 50);
  expect(spies.remove).toHaveBeenCalledWith(50);
  expect(state.tabs.has(50)).toBe(closeFails);
  expect(ctx.agentCreatedTabs.has(50)).toBe(closeFails);
});

it("keeps borrowed tabs as the default target and preserves explicit targeting", async () => {
  const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
  const ctx = await sm.start("aa11");
  const state: FakeTabState = {
    tabs: new Map([
      [
        7,
        {
          id: 7,
          windowId: 200,
          index: 3,
          active: false,
          url: "https://borrow.test",
        } as chrome.tabs.Tab,
      ],
      [8, { id: 8, windowId: 100, active: true } as chrome.tabs.Tab],
    ]),
    nextTabId: 50,
    windowsClosed: new Set(),
  };
  const { api, spies } = makeTabMutationApi(state);
  const update = spies.update.getMockImplementation() as (
    tabId: number,
    props: chrome.tabs.UpdateProperties,
  ) => Promise<chrome.tabs.Tab>;
  spies.update.mockImplementation(async (id, props) => {
    const tab = await update(id, props);
    if (props.active)
      for (const other of state.tabs.values()) {
        if (other.id !== id && other.windowId === tab.windowId) other.active = false;
      }
    return tab;
  });
  const tabsApi = {
    get: api.get,
    query: vi.fn(async (q: chrome.tabs.QueryInfo) =>
      [...state.tabs.values()].filter((t) => t.windowId === q.windowId && (!q.active || t.active)),
    ),
  };
  const cdp = {
    acquireBackgroundExecution: vi.fn(async () => {}),
    releaseSessionTab: vi.fn(async () => {}),
  };
  expect(
    await handleTabBorrow(
      sm,
      { session_id: "aa11", tab_id: 7 },
      { tabs: api, cdp, approveBorrow: async () => true },
    ),
  ).toMatchObject({ tab_id: 7 });
  expect(await resolveTargetTab(sm, ctx, undefined, tabsApi)).toMatchObject({ tabId: 7 });
  expect(await resolveTargetTab(sm, ctx, 8, tabsApi)).toMatchObject({ tabId: 8 });
  expect(cdp.acquireBackgroundExecution).toHaveBeenCalledWith("aa11", 7);
  const { api: windows } = makeWindowsApi(state);
  expect(
    await handleTabReturn(sm, { session_id: "aa11", tab_id: 7 }, { tabs: api, windows, cdp }),
  ).not.toHaveProperty("code");
  expect(state.tabs.get(7)).toMatchObject({ windowId: 200, index: 3 });
  expect(ctx.borrowedTabs.has(7)).toBe(false);
  expect(cdp.releaseSessionTab).toHaveBeenCalledWith("aa11", 7);
});

// ---------------------------------------------------------------------------
// tool.tab_group_create / _update / _list / _ungroup
// ---------------------------------------------------------------------------

type FakeChromeTabGroup = chrome.tabGroups.TabGroup;

interface FakeGroupState {
  groups: Map<number, FakeChromeTabGroup>;
  tabGroupOf: Map<number, number>;
  nextGroupId: number;
}

function makeTabGroupApis(
  tabState: FakeTabState,
  groupState: FakeGroupState,
  /**
   * Simulates the real-world Chromium quirk (observed manually against
   * Edge 153) where a freshly created group lands in the tabs' *previous*
   * window rather than the requested `createProperties.windowId`. Exists
   * only to exercise `handleTabGroupCreate`'s self-heal path.
   */
  options: { ignoreCreateWindowId?: boolean } = {},
): {
  tabGroups: TabGroupMutationApi;
  tabGroupsApi: ChromeTabGroupsApi;
  spies: {
    group: ReturnType<typeof vi.fn>;
    ungroup: ReturnType<typeof vi.fn>;
    queryTabs: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    move: ReturnType<typeof vi.fn>;
  };
} {
  const group = vi.fn(async (opts: chrome.tabs.GroupOptions) => {
    const tabIds = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds];
    let groupId = opts.groupId;
    if (groupId === undefined) {
      groupId = groupState.nextGroupId++;
      // The "ignore" path always lands in a fixed window unrelated to the
      // tabs' own windowId, mirroring the real quirk observed against Edge
      // 153: the freshly created group escaped to the browser's regular
      // window regardless of what `createProperties.windowId` requested.
      const windowId = options.ignoreCreateWindowId
        ? 999
        : (opts.createProperties?.windowId ?? tabState.tabs.get(tabIds[0])?.windowId ?? 1);
      groupState.groups.set(groupId, {
        id: groupId,
        windowId,
        title: "",
        color: "grey",
        collapsed: false,
      } as FakeChromeTabGroup);
      // A tab's own windowId always matches wherever its group physically
      // lives (matches the real browser, and is what let this test suite
      // catch a mismatch that a window-agnostic fake would have hidden).
      for (const id of tabIds) {
        const t = tabState.tabs.get(id);
        if (t) (t as { windowId?: number }).windowId = windowId;
      }
    }
    for (const id of tabIds) groupState.tabGroupOf.set(id, groupId);
    return groupId;
  });
  const ungroup = vi.fn(async (tabIds: number | number[]) => {
    for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) groupState.tabGroupOf.delete(id);
  });
  const queryTabs = vi.fn(async (q: chrome.tabs.QueryInfo) =>
    [...tabState.tabs.values()].filter(
      (t) =>
        typeof t.id === "number" &&
        (q.windowId === undefined || t.windowId === q.windowId) &&
        (q.groupId === undefined || groupState.tabGroupOf.get(t.id) === q.groupId),
    ),
  );
  const get = vi.fn(async (groupId: number) => {
    const g = groupState.groups.get(groupId);
    if (!g) throw new Error(`group ${groupId} not found`);
    return g;
  });
  const query = vi.fn(async (q: chrome.tabGroups.QueryInfo) =>
    [...groupState.groups.values()].filter((g) => q.windowId === undefined || g.windowId === q.windowId),
  );
  const update = vi.fn(async (groupId: number, props: chrome.tabGroups.UpdateProperties) => {
    const g = groupState.groups.get(groupId);
    if (!g) return undefined;
    const updated = { ...g, ...props };
    groupState.groups.set(groupId, updated);
    return updated;
  });
  const move = vi.fn(async (groupId: number, props: chrome.tabGroups.MoveProperties) => {
    const g = groupState.groups.get(groupId);
    if (!g) throw new Error(`move: group ${groupId} not found`);
    // Mirrors the real quirk this fallback exists for: `tabGroups.move`
    // resolves without error but does not actually relocate anything
    // against an unfocused window.
    if (options.ignoreCreateWindowId) return g;
    const updated = { ...g, ...(typeof props.windowId === "number" ? { windowId: props.windowId } : {}) };
    groupState.groups.set(groupId, updated);
    return updated;
  });
  return {
    tabGroups: { group, ungroup, queryTabs },
    tabGroupsApi: { get, query, update, move },
    spies: { group, ungroup, queryTabs, get, query, update, move },
  };
}

function emptyGroupState(): FakeGroupState {
  return { groups: new Map(), tabGroupOf: new Map(), nextGroupId: 1 };
}

describe("handleTabGroupCreate", () => {
  it("groups Agent Window tabs into a new group and returns its info", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabState: FakeTabState = {
      tabs: new Map([
        [5, { id: 5, windowId: 100, index: 0 } as chrome.tabs.Tab],
        [6, { id: 6, windowId: 100, index: 1 } as chrome.tabs.Tab],
      ]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api: tabs } = makeTabMutationApi(tabState);
    const { tabGroups, tabGroupsApi, spies } = makeTabGroupApis(tabState, emptyGroupState());
    const res = await handleTabGroupCreate(
      sm,
      { session_id: "aa11", tab_ids: [5, 6], title: "Research", color: "blue" },
      { tabs, tabGroups, tabGroupsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tab_ids.sort()).toEqual([5, 6]);
    expect(res.title).toBe("Research");
    expect(res.color).toBe("blue");
    expect(spies.group).toHaveBeenCalledWith({
      tabIds: [5, 6],
      createProperties: { windowId: 100 },
    });
    expect(spies.update).toHaveBeenCalledWith(res.group_id, { title: "Research", color: "blue" });
  });

  it("refuses a tab outside the Agent Window with permission_denied", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabState: FakeTabState = {
      tabs: new Map([[9, { id: 9, windowId: 200 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api: tabs } = makeTabMutationApi(tabState);
    const { tabGroups, tabGroupsApi, spies } = makeTabGroupApis(tabState, emptyGroupState());
    const res = await handleTabGroupCreate(
      sm,
      { session_id: "aa11", tab_ids: [9] },
      { tabs, tabGroups, tabGroupsApi },
    );
    expect(res).toMatchObject({ code: "permission_denied", data: { reason: "agent_window_scope" } });
    expect(spies.group).not.toHaveBeenCalled();
  });

  it("adds tabs to an existing Agent Window group via group_id", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabState: FakeTabState = {
      tabs: new Map([
        [5, { id: 5, windowId: 100, index: 0 } as chrome.tabs.Tab],
        [6, { id: 6, windowId: 100, index: 1 } as chrome.tabs.Tab],
      ]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api: tabs } = makeTabMutationApi(tabState);
    const groupState = emptyGroupState();
    groupState.groups.set(1, { id: 1, windowId: 100, title: "Existing", color: "grey", collapsed: false });
    groupState.tabGroupOf.set(5, 1);
    const { tabGroups, tabGroupsApi } = makeTabGroupApis(tabState, groupState);
    const res = await handleTabGroupCreate(
      sm,
      { session_id: "aa11", tab_ids: [6], group_id: 1 },
      { tabs, tabGroups, tabGroupsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.group_id).toBe(1);
    expect(res.tab_ids.sort()).toEqual([5, 6]);
  });

  it("rejects group_id belonging to another window with permission_denied", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabState: FakeTabState = {
      tabs: new Map([[5, { id: 5, windowId: 100 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api: tabs } = makeTabMutationApi(tabState);
    const groupState = emptyGroupState();
    groupState.groups.set(1, { id: 1, windowId: 999, title: "", color: "grey", collapsed: false });
    const { tabGroups, tabGroupsApi, spies } = makeTabGroupApis(tabState, groupState);
    const res = await handleTabGroupCreate(
      sm,
      { session_id: "aa11", tab_ids: [5], group_id: 1 },
      { tabs, tabGroups, tabGroupsApi },
    );
    expect(res).toMatchObject({ code: "permission_denied", data: { reason: "agent_window_scope" } });
    expect(spies.group).not.toHaveBeenCalled();
  });

  it("falls back to per-tab moves when the browser ignores both createProperties.windowId and tabGroups.move", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabState: FakeTabState = {
      tabs: new Map([
        [5, { id: 5, windowId: 100, index: 0 } as chrome.tabs.Tab],
        [6, { id: 6, windowId: 100, index: 1 } as chrome.tabs.Tab],
      ]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api: tabs, spies: tabSpies } = makeTabMutationApi(tabState);
    const { tabGroups, tabGroupsApi, spies: groupSpies } = makeTabGroupApis(tabState, emptyGroupState(), {
      ignoreCreateWindowId: true,
    });
    const res = await handleTabGroupCreate(
      sm,
      { session_id: "aa11", tab_ids: [5, 6] },
      { tabs, tabGroups, tabGroupsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    // Group-level relocation was attempted first...
    expect(groupSpies.move).toHaveBeenCalledWith(res.group_id, { windowId: 100, index: -1 });
    // ...but since it silently no-opped, each tab was moved back individually.
    expect(tabSpies.move).toHaveBeenCalledWith(5, { windowId: 100, index: -1 });
    expect(tabSpies.move).toHaveBeenCalledWith(6, { windowId: 100, index: -1 });
    expect(tabState.tabs.get(5)?.windowId).toBe(100);
    expect(tabState.tabs.get(6)?.windowId).toBe(100);
  });

  it("reports a clear error and ungroups the tabs when no relocation attempt lands them in the Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabState: FakeTabState = {
      tabs: new Map([[5, { id: 5, windowId: 100, index: 0 } as chrome.tabs.Tab]]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const { api: baseTabs } = makeTabMutationApi(tabState);
    // Even the per-tab fallback fails to relocate here — worst case
    // observed on some hosts for tabs that are members of a tab group.
    const tabs: TabMutationApi = { ...baseTabs, move: vi.fn(async (id, p) => baseTabs.get(id)) };
    const { tabGroups, tabGroupsApi, spies } = makeTabGroupApis(tabState, emptyGroupState(), {
      ignoreCreateWindowId: true,
    });
    const res = await handleTabGroupCreate(
      sm,
      { session_id: "aa11", tab_ids: [5] },
      { tabs, tabGroups, tabGroupsApi },
    );
    expect(res).toMatchObject({ code: "cdp_failed", data: { reason: "group_window_mismatch" } });
    expect(spies.ungroup).toHaveBeenCalledWith([5]);
  });

  it("rejects an empty tab_ids array", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabState: FakeTabState = { tabs: new Map(), nextTabId: 50, windowsClosed: new Set() };
    const { api: tabs } = makeTabMutationApi(tabState);
    const { tabGroups, tabGroupsApi } = makeTabGroupApis(tabState, emptyGroupState());
    const res = await handleTabGroupCreate(
      sm,
      { session_id: "aa11", tab_ids: [] },
      { tabs, tabGroups, tabGroupsApi },
    );
    expect(res).toMatchObject({ code: "invalid_params" });
  });
});

describe("handleTabGroupUpdate", () => {
  it("renames, recolors, and collapses an Agent Window group", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabState: FakeTabState = { tabs: new Map(), nextTabId: 50, windowsClosed: new Set() };
    const groupState = emptyGroupState();
    groupState.groups.set(1, { id: 1, windowId: 100, title: "Old", color: "grey", collapsed: false });
    const { tabGroupsApi } = makeTabGroupApis(tabState, groupState);
    const res = await handleTabGroupUpdate(
      sm,
      { session_id: "aa11", group_id: 1, title: "New", color: "red", collapsed: true },
      { tabGroupsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res).toMatchObject({ group_id: 1, title: "New", color: "red", collapsed: true });
  });

  it("refuses a group outside the Agent Window with permission_denied", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabState: FakeTabState = { tabs: new Map(), nextTabId: 50, windowsClosed: new Set() };
    const groupState = emptyGroupState();
    groupState.groups.set(1, { id: 1, windowId: 999, title: "", color: "grey", collapsed: false });
    const { tabGroupsApi, spies } = makeTabGroupApis(tabState, groupState);
    const res = await handleTabGroupUpdate(
      sm,
      { session_id: "aa11", group_id: 1, title: "New" },
      { tabGroupsApi },
    );
    expect(res).toMatchObject({ code: "permission_denied", data: { reason: "agent_window_scope" } });
    expect(spies.update).not.toHaveBeenCalled();
  });

  it("rejects an invalid color", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const res = await handleTabGroupUpdate(
      sm,
      {
        session_id: "aa11",
        group_id: 1,
        color: "chartreuse" as unknown as Parameters<typeof handleTabGroupUpdate>[1]["color"],
      },
      {},
    );
    expect(res).toMatchObject({ code: "invalid_params" });
  });
});

describe("handleTabGroupList", () => {
  it("lists only groups in the session's Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 200]) });
    await sm.start("aa11");
    const tabState: FakeTabState = {
      tabs: new Map([
        [5, { id: 5, windowId: 100 } as chrome.tabs.Tab],
        [6, { id: 6, windowId: 200 } as chrome.tabs.Tab],
      ]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const groupState = emptyGroupState();
    groupState.groups.set(1, { id: 1, windowId: 100, title: "Mine", color: "blue", collapsed: false });
    groupState.groups.set(2, { id: 2, windowId: 200, title: "Other window", color: "red", collapsed: false });
    groupState.tabGroupOf.set(5, 1);
    groupState.tabGroupOf.set(6, 2);
    const { tabGroups, tabGroupsApi } = makeTabGroupApis(tabState, groupState);
    const res = await handleTabGroupList(sm, { session_id: "aa11" }, { tabGroups, tabGroupsApi });
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({ group_id: 1, title: "Mine", tab_ids: [5] });
  });
});

describe("handleTabGroupUngroup", () => {
  it("removes every tab from the group and leaves them open", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabState: FakeTabState = {
      tabs: new Map([
        [5, { id: 5, windowId: 100 } as chrome.tabs.Tab],
        [6, { id: 6, windowId: 100 } as chrome.tabs.Tab],
      ]),
      nextTabId: 50,
      windowsClosed: new Set(),
    };
    const groupState = emptyGroupState();
    groupState.groups.set(1, { id: 1, windowId: 100, title: "", color: "grey", collapsed: false });
    groupState.tabGroupOf.set(5, 1);
    groupState.tabGroupOf.set(6, 1);
    const { tabGroups, tabGroupsApi, spies } = makeTabGroupApis(tabState, groupState);
    const res = await handleTabGroupUngroup(
      sm,
      { session_id: "aa11", group_id: 1 },
      { tabGroups, tabGroupsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tab_ids.sort()).toEqual([5, 6]);
    expect(spies.ungroup).toHaveBeenCalledWith([5, 6]);
    expect(groupState.tabGroupOf.size).toBe(0);
    expect(tabState.tabs.has(5)).toBe(true);
    expect(tabState.tabs.has(6)).toBe(true);
  });

  it("refuses a group outside the Agent Window with permission_denied", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const tabState: FakeTabState = { tabs: new Map(), nextTabId: 50, windowsClosed: new Set() };
    const groupState = emptyGroupState();
    groupState.groups.set(1, { id: 1, windowId: 999, title: "", color: "grey", collapsed: false });
    const { tabGroups, tabGroupsApi, spies } = makeTabGroupApis(tabState, groupState);
    const res = await handleTabGroupUngroup(
      sm,
      { session_id: "aa11", group_id: 1 },
      { tabGroups, tabGroupsApi },
    );
    expect(res).toMatchObject({ code: "permission_denied", data: { reason: "agent_window_scope" } });
    expect(spies.ungroup).not.toHaveBeenCalled();
  });
});
