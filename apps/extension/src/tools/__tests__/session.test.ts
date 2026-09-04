import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleSessionStop } from "../session";
import type { ChromeTabsApi } from "../shared";
import { type AgentOverlayResetApi, type ChromeWindowsApi, type TabMutationApi } from "../tabs";

/** Build a read-only query api over a FakeState. */
function makeQuery(state: FakeState): ChromeTabsApi {
  return {
    get: vi.fn(async (id) => {
      const t = state.tabs.get(id);
      if (!t) throw new Error(`tab ${id} not found`);
      return t;
    }),
    query: vi.fn(async (q: chrome.tabs.QueryInfo) => {
      const w = q.windowId;
      return Array.from(state.tabs.values()).filter(
        (t) => typeof w !== "number" || t.windowId === w,
      );
    }),
  };
}

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  const create = vi.fn(async () => {
    const id = ids[i++];
    if (id === undefined) throw new Error("ran out of fake ids");
    return id;
  });
  const remove = vi.fn(async () => {});
  const ensureActiveTab = vi.fn(async () => 0);
  return { create, remove, ensureActiveTab };
}

interface FakeState {
  tabs: Map<number, chrome.tabs.Tab>;
  windowsClosed: Set<number>;
  moves: Array<{ tabId: number; windowId: number; index: number }>;
}

function makeApis(
  state: FakeState,
  opts?: { moveThrowsFor?: Set<number> },
): {
  tabs: TabMutationApi;
  windows: ChromeWindowsApi;
} {
  const tabs: TabMutationApi = {
    create: vi.fn(),
    remove: vi.fn(async (id: number) => {
      state.tabs.delete(id);
    }),
    update: vi.fn(async (_id, _p) => undefined),
    get: vi.fn(async (id) => {
      const t = state.tabs.get(id);
      if (!t) throw new Error(`tab ${id} not found`);
      return t;
    }),
    move: vi.fn(async (id, props) => {
      if (opts?.moveThrowsFor?.has(id)) throw new Error("simulated move failure");
      state.moves.push({
        tabId: id,
        windowId: typeof props.windowId === "number" ? props.windowId : -1,
        index: typeof props.index === "number" ? props.index : 0,
      });
      const t = state.tabs.get(id);
      if (t && typeof props.windowId === "number") {
        (t as { windowId?: number }).windowId = props.windowId;
      }
      return t!;
    }),
  };
  const windows: ChromeWindowsApi = {
    get: vi.fn(async (windowId: number) => {
      if (state.windowsClosed.has(windowId)) {
        throw new Error(`window ${windowId} closed`);
      }
      return { id: windowId } as chrome.windows.Window;
    }),
    getLastFocused: vi.fn(async () => ({ id: 500 }) as chrome.windows.Window),
    create: vi.fn(async () => ({ id: 999 }) as chrome.windows.Window),
    remove: vi.fn(async () => {}),
  };
  return { tabs, windows };
}

describe("handleSessionStop with auto-return", () => {
  it("leaves the session untouched when cancellation arrived before teardown", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    await sm.start("aa11");
    const cdp = { detachSession: vi.fn(async () => {}) };
    const controller = new AbortController();
    controller.abort();

    const res = await handleSessionStop(
      sm,
      { session_id: "aa11" },
      { cdp, signal: controller.signal },
    );

    expect(res).toMatchObject({ code: "cancelled" });
    expect(sm.has("aa11")).toBe(true);
    expect(cdp.detachSession).not.toHaveBeenCalled();
    expect(aw.remove).not.toHaveBeenCalled();
  });

  it("does not close the Agent Window when cancellation lands during CDP detach", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    await sm.start("aa11");
    const controller = new AbortController();
    let finishDetach: () => void = () => {};
    const detach = new Promise<void>((resolve) => {
      finishDetach = resolve;
    });
    const cdp = { detachSession: vi.fn(() => detach) };

    const stopping = handleSessionStop(
      sm,
      { session_id: "aa11" },
      { cdp, signal: controller.signal },
    );
    await vi.waitFor(() => expect(cdp.detachSession).toHaveBeenCalledWith("aa11"));
    controller.abort();
    finishDetach();

    const res = await stopping;
    expect(res).toMatchObject({ code: "cancelled" });
    expect(sm.has("aa11")).toBe(true);
    expect(aw.remove).not.toHaveBeenCalled();
  });

  it("returns every borrowed tab and closes the Agent Window in the right order", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(1, { tabId: 1, originalWindowId: 200, originalIndex: 0 });
    ctx.borrowedTabs.set(2, { tabId: 2, originalWindowId: 200, originalIndex: 1 });
    ctx.borrowedTabs.set(3, { tabId: 3, originalWindowId: 201, originalIndex: 2 });

    const state: FakeState = {
      tabs: new Map([
        [1, { id: 1, windowId: 100 } as chrome.tabs.Tab],
        [2, { id: 2, windowId: 100 } as chrome.tabs.Tab],
        [3, { id: 3, windowId: 100 } as chrome.tabs.Tab],
      ]),
      windowsClosed: new Set(),
      moves: [],
    };
    const { tabs, windows } = makeApis(state);
    const cdp = { detachSession: vi.fn(async () => {}) };
    const order: string[] = [];
    aw.remove.mockImplementation(async () => {
      order.push("remove-window");
    });
    cdp.detachSession.mockImplementation(async () => {
      order.push("cdp-detach");
    });

    // Wrap move to record when each tab was moved.
    const baseMove = tabs.move;
    tabs.move = vi.fn(async (id: number, p: chrome.tabs.MoveProperties) => {
      order.push(`move-${id}`);
      return baseMove(id, p);
    }) as unknown as TabMutationApi["move"];

    const res = await handleSessionStop(
      sm,
      { session_id: "aa11" },
      { cdp, tabManagement: { tabs, windows } },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.returned_tab_ids?.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(res.return_failures).toBeUndefined();
    expect(ctx.borrowedTabs.size).toBe(0);
    expect(sm.has("aa11")).toBe(false);

    // Order: every tab move happens before cdp.detach and window remove.
    const detachIdx = order.indexOf("cdp-detach");
    const removeIdx = order.indexOf("remove-window");
    for (const id of [1, 2, 3]) {
      const moveIdx = order.indexOf(`move-${id}`);
      expect(moveIdx).toBeGreaterThanOrEqual(0);
      expect(moveIdx).toBeLessThan(detachIdx);
      expect(moveIdx).toBeLessThan(removeIdx);
    }
    expect(detachIdx).toBeLessThan(removeIdx);
  });

  it("resets agent overlays for tabs returned during session_stop auto-cleanup", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 3 });

    const state: FakeState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      windowsClosed: new Set(),
      moves: [],
    };
    const { tabs, windows } = makeApis(state);
    const agentOverlayReset = {
      resetAgentOverlays: vi.fn(async () => {}),
    } satisfies AgentOverlayResetApi;

    const res = await handleSessionStop(
      sm,
      { session_id: "aa11" },
      {
        tabManagement: { tabs, windows, agentOverlayReset },
      },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(agentOverlayReset.resetAgentOverlays).toHaveBeenCalledWith(7, "aa11");
  });

  it("falls back when the original window is gone but still completes stop", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 3 });

    const state: FakeState = {
      tabs: new Map([[7, { id: 7, windowId: 100 } as chrome.tabs.Tab]]),
      windowsClosed: new Set([200]),
      moves: [],
    };
    const { tabs, windows } = makeApis(state);
    const res = await handleSessionStop(
      sm,
      { session_id: "aa11" },
      { tabManagement: { tabs, windows } },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.returned_tab_ids).toEqual([7]);
    expect(state.moves[0].windowId).toBe(500); // lastFocused fallback
    expect(sm.has("aa11")).toBe(false);
  });

  it("keeps the session open when any borrowed tab cannot be returned", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(1, { tabId: 1, originalWindowId: 200, originalIndex: 0 });
    ctx.borrowedTabs.set(2, { tabId: 2, originalWindowId: 200, originalIndex: 1 });

    const state: FakeState = {
      tabs: new Map([
        [1, { id: 1, windowId: 100 } as chrome.tabs.Tab],
        [2, { id: 2, windowId: 100 } as chrome.tabs.Tab],
      ]),
      windowsClosed: new Set(),
      moves: [],
    };
    const { tabs, windows } = makeApis(state, { moveThrowsFor: new Set([1]) });

    const res = await handleSessionStop(
      sm,
      { session_id: "aa11" },
      { tabManagement: { tabs, windows } },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.return_failures?.map((f) => f.tab_id)).toEqual([1]);
    expect(res.returned_tab_ids).toEqual([2]);
    expect(sm.has("aa11")).toBe(true);
    expect(ctx.borrowedTabs.has(1)).toBe(true);
    expect(ctx.borrowedTabs.has(2)).toBe(false);
    expect(aw.remove).not.toHaveBeenCalled();
  });

  it("clears the RefStore before window teardown", async () => {
    const aw = fakeAgentWindow([100]);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    // Insert a fake ref so we can verify clear() ran.
    ctx.refStore.set("e1", 123, { tabId: 7 });
    const state: FakeState = {
      tabs: new Map(),
      windowsClosed: new Set(),
      moves: [],
    };
    const { tabs, windows } = makeApis(state);
    await handleSessionStop(sm, { session_id: "aa11" }, { tabManagement: { tabs, windows } });
    expect(ctx.refStore.isEmpty()).toBe(true);
  });
});

describe("handleSessionStop window release (issue #57)", () => {
  const agentWindowId = 100;

  it("releases the window when user-created tabs remain", async () => {
    const aw = fakeAgentWindow([agentWindowId]);
    // ensureActiveTab returns the home tab id (10). We override the fake to
    // return a known id.
    aw.ensureActiveTab = vi.fn(async () => 10);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    ctx.agentCreatedTabs.add(11);
    ctx.agentCreatedTabs.add(12);
    // home tab id from ensureActiveTab override
    ctx.agentCreatedTabs.add(10); // home tab
    // user tab 99 (created via Chrome UI, NOT in agentCreatedTabs)
    const state: FakeState = {
      tabs: new Map([
        [10, { id: 10, windowId: agentWindowId } as chrome.tabs.Tab],
        [11, { id: 11, windowId: agentWindowId } as chrome.tabs.Tab],
        [12, { id: 12, windowId: agentWindowId } as chrome.tabs.Tab],
        [99, { id: 99, windowId: agentWindowId } as chrome.tabs.Tab],
      ]),
      windowsClosed: new Set(),
      moves: [],
    };
    const { tabs, windows } = makeApis(state);
    const query = makeQuery(state);

    const res = await handleSessionStop(
      sm,
      { session_id: "aa11" },
      { tabManagement: { tabs, windows }, tabsQuery: query },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.window_released).toBe(true);
    // agent tabs + home removed, user tab 99 kept
    expect((tabs.remove as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort()).toEqual([
      10, 11, 12,
    ]);
    expect(state.tabs.has(99)).toBe(true);
    // window released (dropOnly), not closed
    expect(aw.remove).not.toHaveBeenCalled();
    expect(sm.has("aa11")).toBe(false);
  });

  it("closes the window (not release) when no user tabs remain", async () => {
    const aw = fakeAgentWindow([agentWindowId]);
    aw.ensureActiveTab = vi.fn(async () => 10);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    ctx.agentCreatedTabs.add(11);
    ctx.agentCreatedTabs.add(10); // home tab
    const state: FakeState = {
      tabs: new Map([
        [10, { id: 10, windowId: agentWindowId } as chrome.tabs.Tab],
        [11, { id: 11, windowId: agentWindowId } as chrome.tabs.Tab],
      ]),
      windowsClosed: new Set(),
      moves: [],
    };
    const { tabs, windows } = makeApis(state);
    const query = makeQuery(state);

    const res = await handleSessionStop(
      sm,
      { session_id: "aa11" },
      { tabManagement: { tabs, windows }, tabsQuery: query },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.window_released).toBeFalsy();
    expect(aw.remove).toHaveBeenCalledWith(agentWindowId);
    expect(sm.has("aa11")).toBe(false);
  });

  it("is non-fatal when an agent tab is already gone", async () => {
    const aw = fakeAgentWindow([agentWindowId]);
    aw.ensureActiveTab = vi.fn(async () => 10);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    ctx.agentCreatedTabs.add(11); // no longer in state → remove throws
    ctx.agentCreatedTabs.add(10); // home tab
    const state: FakeState = {
      tabs: new Map([[10, { id: 10, windowId: agentWindowId } as chrome.tabs.Tab]]),
      windowsClosed: new Set(),
      moves: [],
    };
    const { tabs, windows } = makeApis(state);
    (tabs.remove as ReturnType<typeof vi.fn>).mockImplementation(async (id: number) => {
      if (id === 11) throw new Error("tab 11 already closed");
      state.tabs.delete(id); // home (10) removed normally
    });
    const query = makeQuery(state);

    const res = await handleSessionStop(
      sm,
      { session_id: "aa11" },
      { tabManagement: { tabs, windows }, tabsQuery: query },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    // user tab 10? no — 10 is home, removed. window would be empty → close.
    expect(res.window_released).toBeFalsy();
    expect(aw.remove).toHaveBeenCalled();
  });

  it("degrades to close-window when tabsQuery is missing", async () => {
    const aw = fakeAgentWindow([agentWindowId]);
    aw.ensureActiveTab = vi.fn(async () => 10);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    ctx.agentCreatedTabs.add(11);
    ctx.agentCreatedTabs.add(10); // home tab
    const state: FakeState = {
      tabs: new Map([
        [10, { id: 10, windowId: agentWindowId } as chrome.tabs.Tab],
        [11, { id: 11, windowId: agentWindowId } as chrome.tabs.Tab],
      ]),
      windowsClosed: new Set(),
      moves: [],
    };
    const { tabs, windows } = makeApis(state);

    const res = await handleSessionStop(
      sm,
      { session_id: "aa11" },
      { tabManagement: { tabs, windows } }, // no tabsQuery
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    // No query available → conservatively close the window.
    expect(res.window_released).toBeFalsy();
    expect(aw.remove).toHaveBeenCalledWith(agentWindowId);
  });

  it("degrades to close-window when tabsQuery.query throws", async () => {
    const aw = fakeAgentWindow([agentWindowId]);
    aw.ensureActiveTab = vi.fn(async () => 10);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    ctx.agentCreatedTabs.add(11);
    ctx.agentCreatedTabs.add(10); // home tab
    const state: FakeState = {
      tabs: new Map([[11, { id: 11, windowId: agentWindowId } as chrome.tabs.Tab]]),
      windowsClosed: new Set(),
      moves: [],
    };
    const { tabs, windows } = makeApis(state);
    const query = makeQuery(state);
    (query.query as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error("query failed");
    });

    const res = await handleSessionStop(
      sm,
      { session_id: "aa11" },
      { tabManagement: { tabs, windows }, tabsQuery: query },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.window_released).toBeFalsy();
    expect(aw.remove).toHaveBeenCalled();
  });

  it("tracks agentCreatedTabs across tab_create / tab_close", async () => {
    const aw = fakeAgentWindow([agentWindowId]);
    aw.ensureActiveTab = vi.fn(async () => 10);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    // Simulate handleTabCreate adding, then handleTabClose removing.
    ctx.agentCreatedTabs.add(11);
    expect(ctx.agentCreatedTabs.has(11)).toBe(true);
    ctx.agentCreatedTabs.delete(11); // as handleTabClose does on success
    expect(ctx.agentCreatedTabs.has(11)).toBe(false);
    // Unknown id delete is a safe no-op (user-closed tab).
    expect(() => ctx.agentCreatedTabs.delete(999)).not.toThrow();
  });

  it("closes the window (not release) when an agent tab fails to close", async () => {
    // Regression: a leaked agent tab (still in agentCreatedTabs, but
    // still present because Step 4 remove() threw) must NOT be mistaken
    // for a user tab. Otherwise the window would be released (dropOnly)
    // and the agent tab would leak (issue #57 regression).
    const aw = fakeAgentWindow([agentWindowId]);
    aw.ensureActiveTab = vi.fn(async () => 10);
    const sm = new SessionManager({ agentWindow: aw });
    const ctx = await sm.start("aa11");
    ctx.agentCreatedTabs.add(11); // Step 4 remove() will throw for this tab
    ctx.agentCreatedTabs.add(10); // home tab
    const state: FakeState = {
      tabs: new Map([
        [10, { id: 10, windowId: agentWindowId } as chrome.tabs.Tab],
        [11, { id: 11, windowId: agentWindowId } as chrome.tabs.Tab],
      ]),
      windowsClosed: new Set(),
      moves: [],
    };
    const { tabs, windows } = makeApis(state);
    (tabs.remove as ReturnType<typeof vi.fn>).mockImplementation(async (id: number) => {
      if (id === 11) throw new Error("tab 11 failed to close");
      state.tabs.delete(id); // home (10) removed normally; 11 lingers
    });
    const query = makeQuery(state);

    const res = await handleSessionStop(
      sm,
      { session_id: "aa11" },
      { tabManagement: { tabs, windows }, tabsQuery: query },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    // The leaked agent tab must NOT keep the window open.
    expect(res.window_released).toBeFalsy();
    expect(aw.remove).toHaveBeenCalledWith(agentWindowId);
    expect(sm.has("aa11")).toBe(false);
  });
});
