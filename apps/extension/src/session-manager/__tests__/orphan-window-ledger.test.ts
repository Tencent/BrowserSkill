import { describe, expect, it, vi } from "vitest";
import { handleTabBorrow, returnBorrowedTab } from "@/tools/tabs";
import { type SessionContext, SessionManager } from "../manager";
import {
  ORPHAN_AGENT_WINDOWS_STORAGE_KEY,
  OrphanAgentWindowLedger,
  type SessionStorageAreaLike,
} from "../orphan-window-ledger";
import { RefStore } from "../ref-store";

function createMemorySessionStorage(): {
  area: SessionStorageAreaLike;
  snapshot: () => Record<string, unknown>;
} {
  const data: Record<string, unknown> = {};
  return {
    area: {
      async get(key: string) {
        return key in data ? { [key]: structuredClone(data[key]) } : {};
      },
      async set(items: Record<string, unknown>) {
        for (const [key, value] of Object.entries(items)) {
          data[key] = structuredClone(value);
        }
      },
    },
    snapshot: () => structuredClone(data),
  };
}

describe("OrphanAgentWindowLedger + SessionManager", () => {
  it("persists owned agent tabs across session mutations and deletes clean stops", async () => {
    const mem = createMemorySessionStorage();
    const ledger = new OrphanAgentWindowLedger({ storage: () => mem.area, now: () => 1000 });
    const manager = new SessionManager({
      orphanLedger: ledger,
      agentWindow: {
        create: async () => ({ windowId: 400, initialTabIds: [41] }),
        ensureActiveTab: async () => 41,
        remove: async () => {},
      },
    });

    const ctx = await manager.start("s1");
    expect(await ledger.readAll()).toEqual(
      new Map([[400, { sessionId: "s1", ownedTabIds: [41], updatedAtMs: 1000 }]]),
    );

    // `tab_create` adds to `ctx.agentCreatedTabs` and automatically updates session storage.
    ctx.agentCreatedTabs.add(42);
    expect(await ledger.readAll()).toEqual(
      new Map([[400, { sessionId: "s1", ownedTabIds: [41, 42], updatedAtMs: 1000 }]]),
    );

    // Borrowing a user tab persists its return metadata in the orphan ledger.
    ctx.borrowedTabs.set(77, { tabId: 77, originalWindowId: 1, originalIndex: 2 });
    expect(await ledger.readAll()).toEqual(
      new Map([
        [
          400,
          {
            sessionId: "s1",
            ownedTabIds: [41, 42],
            borrowedTabs: [{ tabId: 77, originalWindowId: 1, originalIndex: 2 }],
            updatedAtMs: 1000,
          },
        ],
      ]),
    );
    ctx.borrowedTabs.delete(77);

    // Preserving a tab for human inspection (`agentCreatedTabs.delete`) removes it from ownedTabIds.
    ctx.agentCreatedTabs.delete(42);
    expect(await ledger.readAll()).toEqual(
      new Map([[400, { sessionId: "s1", ownedTabIds: [41], updatedAtMs: 1000 }]]),
    );

    // Clean session release removes the window from the orphan ledger.
    manager.release("s1");
    expect(await ledger.readAll()).toEqual(new Map());
    expect(mem.snapshot()[ORPHAN_AGENT_WINDOWS_STORAGE_KEY]).toEqual({});
  });

  it("closes orphaned pure Agent Windows on SW restart while never closing active or user-occupied windows", async () => {
    const mem = createMemorySessionStorage();
    let nextWindowId = 100;
    const crashedWorkerLedger = new OrphanAgentWindowLedger({
      storage: () => mem.area,
      now: () => 500,
    });
    const crashedManager = new SessionManager({
      orphanLedger: crashedWorkerLedger,
      agentWindow: {
        create: async () => {
          nextWindowId += 10;
          return { windowId: nextWindowId, initialTabIds: [nextWindowId + 1] };
        },
        ensureActiveTab: async (wid) => wid + 1,
        remove: async () => {},
      },
    });

    // Simulate 4 Agent Windows created before the MV3 Service Worker was killed:
    // - Window 110: pure orphan Agent Window (only agent-owned tabs 111, 112) -> MUST CLOSE
    // - Window 120: contains agent tab 121 + uncontrolled user tab 999 -> MUST NOT CLOSE
    // - Window 130: contains borrowed user tab 888 (never in agentCreatedTabs) after home tab closed -> MUST NOT CLOSE
    // - Window 140: re-adopted / active session in restarted SW -> MUST NOT CLOSE
    const sPureOrphan = await crashedManager.start("pure-orphan");
    sPureOrphan.agentCreatedTabs.add(112);

    await crashedManager.start("mixed-user-tab");

    const sBorrowedOnly = await crashedManager.start("borrowed-only");
    sBorrowedOnly.borrowedTabs.set(888, {
      tabId: 888,
      originalWindowId: 1,
      originalIndex: 0,
    });
    sBorrowedOnly.agentCreatedTabs.delete(131);

    await crashedManager.start("still-active");

    // Flush queued ledger writes from the previous SW instance.
    await crashedWorkerLedger.readAll();

    // Simulate fresh Service Worker startup with shared `chrome.storage.session`.
    const restartedLedger = new OrphanAgentWindowLedger({
      storage: () => mem.area,
      now: () => 2000,
    });
    const restartedManager = new SessionManager({
      orphanLedger: restartedLedger,
      agentWindow: {
        create: async () => ({ windowId: 140, initialTabIds: [141] }),
        ensureActiveTab: async () => 141,
        remove: async () => {},
      },
    });
    await restartedManager.start("still-active");

    const openWindows = new Map<number, Array<{ id: number }>>([
      [110, [{ id: 111 }, { id: 112 }]],
      [120, [{ id: 121 }, { id: 999 }]],
      [130, [{ id: 888 }]],
      [140, [{ id: 141 }]],
      [1, [{ id: 50 }, { id: 51 }]], // Normal user window never tracked in ledger
    ]);
    const removeWindow = vi.fn(async (windowId: number) => {
      openWindows.delete(windowId);
    });

    const report = await restartedManager.reapOrphanAgentWindows({
      queryWindowTabs: async (windowId) => {
        const tabs = openWindows.get(windowId);
        if (!tabs) throw new Error(`No window with id: ${windowId}`);
        return tabs;
      },
      removeWindow,
    });

    expect(report).toEqual({
      closedWindowIds: [110],
      preservedWindowIds: [120, 130],
    });
    expect(removeWindow).toHaveBeenCalledExactlyOnceWith(110);
    expect(openWindows.has(120)).toBe(true);
    expect(openWindows.has(130)).toBe(true);
    expect(openWindows.has(140)).toBe(true);
    expect(openWindows.has(1)).toBe(true);

    // Retired windows (110, 120) were cleaned out of ledger; active window 140 and window 130
    // (which still holds unreturned borrowed tab 888) remain tracked for future recovery.
    expect([...(await restartedLedger.readAll()).keys()]).toEqual([130, 140]);
  });

  it("returns tracked borrowed tabs on SW restart and closes emptied orphan windows without closing user tabs", async () => {
    const mem = createMemorySessionStorage();
    let nextWindowId = 200;
    const crashedLedger = new OrphanAgentWindowLedger({ storage: () => mem.area, now: () => 500 });
    const crashedManager = new SessionManager({
      orphanLedger: crashedLedger,
      agentWindow: {
        create: async () => {
          nextWindowId += 10;
          return { windowId: nextWindowId, initialTabIds: [nextWindowId + 1] };
        },
        ensureActiveTab: async (wid) => wid + 1,
        remove: async () => {},
      },
    });

    // Window 210: agent tab 211 + borrowed tab 801 -> return 801 to window 1, then close window 210
    const sMixedBorrowed = await crashedManager.start("with-borrowed");
    sMixedBorrowed.borrowedTabs.set(801, { tabId: 801, originalWindowId: 1, originalIndex: 1 });

    // Window 220: only borrowed tab 802 (home tab 221 closed) -> return 802 to window 1, auto-closing window 220
    const sBorrowedOnly = await crashedManager.start("borrowed-only");
    sBorrowedOnly.borrowedTabs.set(802, { tabId: 802, originalWindowId: 1, originalIndex: 0 });
    sBorrowedOnly.agentCreatedTabs.delete(221);

    // Window 230: agent tab 231 + borrowed tab 803 + uncontrolled user tab 950 -> return 803, preserve window 230
    const sWithUserTab = await crashedManager.start("borrowed-plus-user");
    sWithUserTab.borrowedTabs.set(803, { tabId: 803, originalWindowId: 1, originalIndex: 2 });

    // Window 240: agent tab 241 + borrowed tab 804 whose move fails -> NEVER close window 240
    const sReturnFails = await crashedManager.start("return-fails");
    sReturnFails.borrowedTabs.set(804, { tabId: 804, originalWindowId: 1, originalIndex: 0 });

    await crashedLedger.readAll();

    // Restarted SW state
    const restartedLedger = new OrphanAgentWindowLedger({
      storage: () => mem.area,
      now: () => 2000,
    });
    const restartedManager = new SessionManager({ orphanLedger: restartedLedger });

    const tabStore = new Map<number, chrome.tabs.Tab>([
      [50, { id: 50, windowId: 1, index: 0 } as chrome.tabs.Tab],
      [211, { id: 211, windowId: 210, index: 0 } as chrome.tabs.Tab],
      [801, { id: 801, windowId: 210, index: 1 } as chrome.tabs.Tab],
      [802, { id: 802, windowId: 220, index: 0 } as chrome.tabs.Tab],
      [231, { id: 231, windowId: 230, index: 0 } as chrome.tabs.Tab],
      [803, { id: 803, windowId: 230, index: 1 } as chrome.tabs.Tab],
      [950, { id: 950, windowId: 230, index: 2 } as chrome.tabs.Tab],
      [241, { id: 241, windowId: 240, index: 0 } as chrome.tabs.Tab],
      [804, { id: 804, windowId: 240, index: 1 } as chrome.tabs.Tab],
    ]);
    const liveWindows = new Set([1, 210, 220, 230, 240]);
    const resetAgentOverlays = vi.fn(async () => {});
    const tabsApi = {
      get: vi.fn(async (id: number) => {
        const tab = tabStore.get(id);
        if (!tab) throw new Error(`missing tab ${id}`);
        return { ...tab };
      }),
      query: vi.fn(async (q: chrome.tabs.QueryInfo) =>
        [...tabStore.values()].filter((t) => q.windowId === undefined || t.windowId === q.windowId),
      ),
      move: vi.fn(async (id: number, props: chrome.tabs.MoveProperties) => {
        if (id === 804) throw new Error("tab move blocked");
        const tab = tabStore.get(id)!;
        const oldWin = tab.windowId;
        if (typeof props.windowId === "number") tab.windowId = props.windowId;
        if (typeof props.index === "number" && props.index >= 0) tab.index = props.index;
        // Chrome closes a window when its last tab is moved out.
        if (![...tabStore.values()].some((t) => t.windowId === oldWin)) {
          liveWindows.delete(oldWin);
        }
        return { ...tab };
      }),
      create: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
    };
    const windowsApi = {
      get: vi.fn(async (id: number) => {
        if (!liveWindows.has(id)) throw new Error(`No window with id: ${id}`);
        return { id, incognito: false } as chrome.windows.Window;
      }),
      getLastFocused: vi.fn(async () => ({ id: 1, incognito: false }) as chrome.windows.Window),
      create: vi.fn(),
      remove: vi.fn(),
    };
    const removeWindow = vi.fn(async (windowId: number) => {
      liveWindows.delete(windowId);
      for (const [id, tab] of tabStore) {
        if (tab.windowId === windowId) tabStore.delete(id);
      }
    });

    const report = await restartedManager.reapOrphanAgentWindows({
      queryWindowTabs: async (windowId) => {
        if (!liveWindows.has(windowId)) throw new Error(`No window with id: ${windowId}`);
        return [...tabStore.values()].filter((t) => t.windowId === windowId);
      },
      removeWindow,
      returnBorrowedTab: async (windowId, borrowed, entry, orphanWindowIds) => {
        const orphanCtx: SessionContext = {
          sessionId: entry.sessionId ?? `orphan-${windowId}`,
          agentWindowId: windowId,
          refStore: new RefStore(),
          borrowedTabs: new Map((entry.borrowedTabs ?? []).map((item) => [item.tabId, item])),
          agentCreatedTabs: new Set(entry.ownedTabIds),
          createdAtMs: entry.updatedAtMs,
        };
        const outcome = await returnBorrowedTab(orphanCtx, borrowed.tabId, {
          tabs: tabsApi,
          tabsQuery: tabsApi,
          windows: windowsApi,
          agentOverlayReset: { resetAgentOverlays },
          isAgentWindowId: (id) =>
            restartedManager.isTrackedAgentWindow(id) || orphanWindowIds.has(id),
        });
        return !("code" in outcome);
      },
    });

    expect(report).toEqual({
      closedWindowIds: [210, 220],
      preservedWindowIds: [230, 240],
    });
    // Borrowed tabs 801, 802, 803 were all safely returned to user window 1, never closed.
    expect(tabStore.get(801)?.windowId).toBe(1);
    expect(tabStore.get(802)?.windowId).toBe(1);
    expect(tabStore.get(803)?.windowId).toBe(1);
    // Uncontrolled user tab 950 and failed-return borrowed tab 804 were NEVER closed.
    expect(tabStore.get(950)?.windowId).toBe(230);
    expect(tabStore.get(804)?.windowId).toBe(240);
    // Agent-only tab 211 was closed with orphan window 210.
    expect(removeWindow).toHaveBeenCalledExactlyOnceWith(210);
    expect(tabStore.has(211)).toBe(false);
    expect(liveWindows.has(210)).toBe(false);
    expect(liveWindows.has(220)).toBe(false);
    expect(liveWindows.has(230)).toBe(true);
    expect(liveWindows.has(240)).toBe(true);
    expect(resetAgentOverlays).toHaveBeenCalledWith(801, "with-borrowed");
    expect(resetAgentOverlays).toHaveBeenCalledWith(802, "borrowed-only");
    expect(resetAgentOverlays).toHaveBeenCalledWith(803, "borrowed-plus-user");

    // Windows 210/220/230 had all borrowed tabs returned and were retired; window 240 retains
    // its unreturned borrowed tab 804 so a subsequent restart can still return it.
    const remainingLedger = await restartedLedger.readAll();
    expect(remainingLedger.has(210)).toBe(false);
    expect(remainingLedger.has(220)).toBe(false);
    expect(remainingLedger.has(230)).toBe(false);
    expect(remainingLedger.get(240)?.borrowedTabs).toEqual([
      expect.objectContaining({ tabId: 804, originalWindowId: 1 }),
    ]);

    // On a later SW restart where moving 804 succeeds, reapOrphans returns 804 and retires 240.
    tabsApi.move.mockImplementation(async (id: number, props: chrome.tabs.MoveProperties) => {
      const tab = tabStore.get(id)!;
      const oldWin = tab.windowId;
      tab.windowId = props.windowId ?? tab.windowId;
      if ([...tabStore.values()].every((t) => t.windowId !== oldWin)) liveWindows.delete(oldWin);
      return { ...tab };
    });
    const secondReport = await restartedManager.reapOrphanAgentWindows({
      queryWindowTabs: async (windowId) => {
        if (!liveWindows.has(windowId)) throw new Error(`No window with id: ${windowId}`);
        return [...tabStore.values()].filter((t) => t.windowId === windowId);
      },
      removeWindow,
      returnBorrowedTab: async (windowId, borrowed, entry, orphanWindowIds) => {
        const orphanCtx: SessionContext = {
          sessionId: entry.sessionId ?? `orphan-${windowId}`,
          agentWindowId: windowId,
          refStore: new RefStore(),
          borrowedTabs: new Map((entry.borrowedTabs ?? []).map((item) => [item.tabId, item])),
          agentCreatedTabs: new Set(entry.ownedTabIds),
          createdAtMs: entry.updatedAtMs,
        };
        const outcome = await returnBorrowedTab(orphanCtx, borrowed.tabId, {
          tabs: tabsApi,
          tabsQuery: tabsApi,
          windows: windowsApi,
          agentOverlayReset: { resetAgentOverlays },
          isAgentWindowId: (id) =>
            restartedManager.isTrackedAgentWindow(id) || orphanWindowIds.has(id),
        });
        return !("code" in outcome);
      },
    });
    expect(secondReport).toEqual({ closedWindowIds: [240], preservedWindowIds: [] });
    expect(tabStore.get(804)?.windowId).toBe(1);
    expect((await restartedLedger.readAll()).size).toBe(0);
  });

  it("persists borrowed return metadata BEFORE tabs.move, aborts move if persistence fails, and unstages on move failure", async () => {
    const storage = createMemorySessionStorage();
    let failWrites = false;
    const guardedArea: SessionStorageAreaLike = {
      get: (key) => storage.area.get(key),
      set: async (items) => {
        if (failWrites) throw new Error("storage quota exceeded");
        await storage.area.set(items);
      },
    };
    const ledger = new OrphanAgentWindowLedger({
      storage: () => guardedArea,
      now: () => 5000,
    });
    const manager = new SessionManager({
      orphanLedger: ledger,
      agentWindow: {
        create: async () => ({ windowId: 300, initialTabIds: [301] }),
        remove: async () => {},
        ensureActiveTab: async () => 301,
      },
    });
    await manager.start("wal-borrow");

    const tabStore = new Map<number, chrome.tabs.Tab>([
      [
        301,
        { id: 301, windowId: 300, index: 0, active: true, url: "about:blank" } as chrome.tabs.Tab,
      ],
      [
        700,
        {
          id: 700,
          windowId: 1,
          index: 2,
          active: true,
          url: "https://user.test",
        } as chrome.tabs.Tab,
      ],
    ]);
    let ledgerDuringMove: unknown;
    let failMove = false;
    const tabsApi = {
      get: vi.fn(async (id: number) => {
        const t = tabStore.get(id);
        if (!t) throw new Error(`No tab ${id}`);
        return { ...t };
      }),
      query: vi.fn(async (q: chrome.tabs.QueryInfo) =>
        [...tabStore.values()].filter((t) => q.windowId === undefined || t.windowId === q.windowId),
      ),
      move: vi.fn(async (id: number, props: chrome.tabs.MoveProperties) => {
        ledgerDuringMove = storage.snapshot()[ORPHAN_AGENT_WINDOWS_STORAGE_KEY];
        if (failMove) throw new Error("move rejected");
        const t = tabStore.get(id)!;
        t.windowId = props.windowId ?? t.windowId;
        return { ...t };
      }),
      create: vi.fn(),
      remove: vi.fn(),
      update: vi.fn(),
    };

    // 1) If ledger persistence fails, handleTabBorrow returns protocol_error BEFORE moving the user tab.
    failWrites = true;
    const failedWrite = await handleTabBorrow(
      manager,
      { session_id: "wal-borrow", tab_id: 700 },
      { tabs: tabsApi, approveBorrow: vi.fn(async () => true) },
    );
    expect(failedWrite).toMatchObject({ code: "protocol_error" });
    expect(tabsApi.move).not.toHaveBeenCalled();

    // 2) If tabs.move fails after staging, unstageBorrowedTab removes the uncommitted entry from the ledger.
    failWrites = false;
    failMove = true;
    const failedMove = await handleTabBorrow(
      manager,
      { session_id: "wal-borrow", tab_id: 700 },
      { tabs: tabsApi, approveBorrow: vi.fn(async () => true) },
    );
    expect("code" in failedMove).toBe(true);
    expect((await ledger.readAll()).get(300)?.borrowedTabs).toBeUndefined();

    // 3) On normal borrow, the ledger ALREADY contains tab 700's return metadata when tabs.move executes!
    failMove = false;
    const ok = await handleTabBorrow(
      manager,
      { session_id: "wal-borrow", tab_id: 700 },
      { tabs: tabsApi, approveBorrow: vi.fn(async () => true) },
    );
    expect(ok).toMatchObject({ tab_id: 700, original_window_id: 1, original_index: 2 });
    expect(
      (ledgerDuringMove as Record<string, { borrowedTabs?: unknown[] }>)["300"]?.borrowedTabs,
    ).toEqual([expect.objectContaining({ tabId: 700, originalWindowId: 1, originalIndex: 2 })]);

    // 4) If a borrow move succeeds, gets aborted, and rollback back to the original window FAILS
    //    (borrow_outcome_unknown / effect_state="unknown"), keep the staged ledger entry so a
    //    subsequent SW restart can still return the stranded user tab!
    tabStore.set(701, {
      id: 701,
      windowId: 1,
      index: 3,
      active: false,
      url: "https://stranded.test",
    } as chrome.tabs.Tab);
    const ac = new AbortController();
    let moveCalls701 = 0;
    const baseMove = tabsApi.move.getMockImplementation()!;
    tabsApi.move.mockImplementation(async (id: number, props: chrome.tabs.MoveProperties) => {
      if (id === 701) {
        moveCalls701 += 1;
        if (moveCalls701 === 1) {
          // Move into Agent Window succeeds, then borrow is cancelled before commit.
          const moved = await baseMove(id, props);
          ac.abort();
          return moved;
        }
        // Rollback move back to original window fails (e.g. original window closed).
        throw new Error("No window with id: 1");
      }
      return baseMove(id, props);
    });
    const stranded = await handleTabBorrow(
      manager,
      { session_id: "wal-borrow", tab_id: 701 },
      {
        tabs: tabsApi,
        signal: ac.signal,
        approveBorrow: vi.fn(async () => true),
      },
    );
    expect(stranded).toMatchObject({
      code: "protocol_error",
      data: { reason: "borrow_outcome_unknown", effect_state: "unknown" },
    });
    expect((await ledger.readAll()).get(300)?.borrowedTabs).toContainEqual(
      expect.objectContaining({ tabId: 701, originalWindowId: 1, originalIndex: 3 }),
    );
  });
});
