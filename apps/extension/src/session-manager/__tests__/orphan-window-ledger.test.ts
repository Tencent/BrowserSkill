import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager";
import {
  ORPHAN_AGENT_WINDOWS_STORAGE_KEY,
  OrphanAgentWindowLedger,
  type SessionStorageAreaLike,
} from "../orphan-window-ledger";

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
      new Map([[400, { ownedTabIds: [41], updatedAtMs: 1000 }]]),
    );

    // `tab_create` adds to `ctx.agentCreatedTabs` and automatically updates session storage.
    ctx.agentCreatedTabs.add(42);
    expect(await ledger.readAll()).toEqual(
      new Map([[400, { ownedTabIds: [41, 42], updatedAtMs: 1000 }]]),
    );

    // Preserving a tab for human inspection (`agentCreatedTabs.delete`) removes it from ownedTabIds.
    ctx.agentCreatedTabs.delete(42);
    expect(await ledger.readAll()).toEqual(
      new Map([[400, { ownedTabIds: [41], updatedAtMs: 1000 }]]),
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

    // Retired windows (110, 120, 130) were cleaned out of ledger; only active window 140 remains.
    expect([...(await restartedLedger.readAll()).keys()]).toEqual([140]);
  });
});
