import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager";
import { withTaskPopups } from "../task-popups";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture({ remote = true }: { remote?: boolean } = {}) {
  let next = 10;
  const manager = new SessionManager({
    remote: () => remote,
    agentWindow: {
      create: async () => ({ windowId: next++, initialTabIds: [] }),
      remove: vi.fn(async () => {}),
      ensureActiveTab: async (windowId: number) => windowId,
    },
  });
  const task = await manager.start("one");
  const other = await manager.start("two");
  const tabs = new Map<number, { id: number; windowId: number; active?: boolean }>([
    [10, { id: 10, windowId: 10, active: true }],
    [11, { id: 11, windowId: 11, active: true }],
  ]);
  const targetListeners = new Set<(event: { sourceTabId: number; tabId: number }) => void>();
  const openListeners = new Set<() => void>();
  const move = vi.fn(async (id: number, props: { windowId: number }) =>
    Object.assign(tabs.get(id)!, props),
  );
  const listener = <T>(set: Set<T>) => ({
    addListener: (fn: T) => set.add(fn),
    removeListener: (fn: T) => set.delete(fn),
  });
  vi.stubGlobal("chrome", {
    tabs: {
      query: async (info: { windowId: number }) =>
        [...tabs.values()].filter((tab) => tab.windowId === info.windowId && tab.active),
      get: async (id: number) => tabs.get(id),
      move,
      onCreated: listener(openListeners),
    },
    webNavigation: { onCreatedNavigationTarget: listener(targetListeners) },
  });
  /** Chrome opens a tab and, a moment later, reports what navigated to it. */
  const open = (sourceTabId: number, tabId: number, windowId = 10) => {
    tabs.set(tabId, { id: tabId, windowId });
    for (const fn of openListeners) fn();
    for (const fn of targetListeners) fn({ sourceTabId, tabId });
  };
  return { manager, task, other, tabs, targetListeners, openListeners, open, move };
}

describe("action-scoped popup attribution", () => {
  it("claims noopener and nested targets and moves a popup window into the task", async () => {
    const f = await fixture();
    await withTaskPopups(f.manager, { session_id: "one" }, async () => {
      f.open(10, 20);
      f.open(20, 21, 200); // Nested popup that opened its own window.
      f.open(11, 22); // Another task's source.
      f.tabs.set(23, { id: 23, windowId: 10 }); // Appeared without a reported source.
    });
    expect(f.task.agentCreatedTabs).toEqual(new Set([10, 20, 21]));
    expect(f.move).toHaveBeenCalledWith(21, { windowId: 10, index: -1 });
    expect(f.targetListeners.size).toBe(0);
    expect(f.openListeners.size).toBe(0);
    f.open(10, 24); // Outside an agent action.
    expect(f.task.agentCreatedTabs.has(24)).toBe(false);
  });

  it("moves a local session's popup window into its Agent Window", async () => {
    const f = await fixture({ remote: false });
    await withTaskPopups(f.manager, { session_id: "one", tab_id: 10 }, async () => {
      f.open(10, 30, 300);
    });
    expect(f.move).toHaveBeenCalledWith(30, { windowId: 10, index: -1 });
    expect(f.tabs.get(30)!.windowId).toBe(10);
  });

  it("cannot take a tab from another task or use an unauthorized source", async () => {
    const f = await fixture();
    await withTaskPopups(f.manager, { session_id: "one", tab_id: 11 }, async () => f.open(11, 30));
    await withTaskPopups(f.manager, { session_id: "one" }, async () => f.open(10, 11, 11));
    expect(f.task.agentCreatedTabs).toEqual(new Set([10]));
    expect(f.other.agentCreatedTabs).toEqual(new Set([11]));
  });

  it("waits for a late target only when a tab appeared during the action", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    // Nothing opened: the action must not pay for the event tail.
    await withTaskPopups(f.manager, { session_id: "one" }, async () => {});
    expect(f.targetListeners.size).toBe(0);

    let settled = false;
    const action = withTaskPopups(f.manager, { session_id: "one" }, async () => {
      for (const fn of f.openListeners) fn();
    }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    for (const fn of f.targetListeners) fn({ sourceTabId: 10, tabId: 40 });
    f.tabs.set(40, { id: 40, windowId: 10 });
    await vi.advanceTimersByTimeAsync(100);
    await action;
    expect(f.task.agentCreatedTabs.has(40)).toBe(true);
  });

  it("cleans listeners on failure and rejects targets after source authorization ends", async () => {
    const f = await fixture();
    await expect(
      withTaskPopups(f.manager, { session_id: "one" }, async () => {
        f.task.agentCreatedTabs.delete(10);
        f.open(10, 20);
        throw new Error("input failed");
      }),
    ).rejects.toThrow("input failed");
    expect(f.task.agentCreatedTabs.size).toBe(0);
    expect(f.targetListeners.size).toBe(0);
    expect(f.openListeners.size).toBe(0);
  });
});
