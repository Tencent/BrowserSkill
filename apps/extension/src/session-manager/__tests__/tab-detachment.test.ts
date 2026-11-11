import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSessionStop } from "@/tools/session";
import type { TabMutationApi } from "@/tools/tabs";
import { attachSessionEventHandler } from "../event-handler";
import { SessionManager } from "../manager";
import { expectedTabMoves } from "../tab-moves";

function event<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    addListener: (listener: (...args: T) => void) => listeners.add(listener),
    removeListener: (listener: (...args: T) => void) => listeners.delete(listener),
    emit: (...args: T) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

afterEach(() => {
  expectedTabMoves.clear();
  vi.restoreAllMocks();
});

async function fixture() {
  let nextWindow = 10;
  const remove = vi.fn();
  const manager = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: nextWindow++, initialTabIds: [] }),
      ensureActiveTab: async (id) => id,
      remove,
    },
  });
  const task = await manager.start("task");
  task.borrowedTabs.set(20, { tabId: 20, originalWindowId: 90, originalIndex: 0 });
  task.observedTabs = new Set([30]);
  const sibling = await manager.start("sibling");
  const windowEvents = event<[number]>();
  const tabEvents = {
    onDetached: event<[number, chrome.tabs.TabDetachInfo]>(),
    onAttached: event<[number, chrome.tabs.TabAttachInfo]>(),
    onRemoved: event<[number, chrome.tabs.TabRemoveInfo]>(),
  };
  const send = vi.fn();
  const resetAgentOverlays = vi.fn(async () => {});
  const detachSession = vi.fn(async () => {});
  const onSessionReleased = vi.fn(() => {
    expect(manager.has("task")).toBe(false);
  });
  const onSessionsChanged = vi.fn();
  const handler = attachSessionEventHandler({
    manager,
    transport: { send },
    windowEvents,
    tabEvents,
    cdp: { detachSession },
    agentOverlayReset: { resetAgentOverlays },
    onSessionReleased,
    onSessionsChanged,
  });
  const moveOut = (id: number) =>
    tabEvents.onDetached.emit(id, { oldWindowId: 10, oldPosition: 0 });
  return {
    manager,
    task,
    sibling,
    remove,
    windowEvents,
    tabEvents,
    send,
    resetAgentOverlays,
    detachSession,
    onSessionReleased,
    onSessionsChanged,
    handler,
    moveOut,
  };
}

describe("moving a task page out", () => {
  it.each([10, 20, 30])("releases the entire session immediately for owned tab %s", async (id) => {
    const f = await fixture();
    f.moveOut(id);
    expect(f.manager.get("task")).toBeNull();
    expect(f.manager.get("sibling")).toBe(f.sibling);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledExactlyOnceWith({
      event: "session.ended",
      payload: { session_id: "task", reason: "user_moved_tab", tab_id: id },
    });
    expect(f.onSessionReleased).toHaveBeenCalledExactlyOnceWith(f.task);
    expect(f.detachSession).toHaveBeenCalledExactlyOnceWith("task");
    expect(f.resetAgentOverlays.mock.calls).toEqual([
      [10, "task"],
      [20, "task"],
      [30, "task"],
    ]);
    // A delayed daemon stop cannot close the now-user-owned window.
    await f.manager.stop("task");
    expect(f.remove).not.toHaveBeenCalled();
    f.handler.dispose();
  });

  it("does not stop for free tabs and reports a multi-tab/last-tab move once", async () => {
    const f = await fixture();
    f.moveOut(40);
    expect(f.manager.has("task")).toBe(true);
    f.moveOut(10);
    f.moveOut(20);
    f.moveOut(30);
    f.windowEvents.emit(10);
    await Promise.resolve();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.onSessionReleased).toHaveBeenCalledTimes(1);
    expect(f.remove).not.toHaveBeenCalled();
    f.handler.dispose();
  });

  it("waits for a registered move's destination without ending a normal return", async () => {
    const f = await fixture();
    await expectedTabMoves.run({ tabId: 20, fromWindowId: 10, toWindowId: 90 }, async () => {});
    f.moveOut(20);
    f.tabEvents.onAttached.emit(20, { newWindowId: 90, newPosition: 0 });
    await Promise.resolve();
    expect(f.manager.get("task")).toBe(f.task);
    expect(f.send).not.toHaveBeenCalled();
    f.handler.dispose();
  });

  it("ends on an unexpected destination even if a later detach listener releases ownership", async () => {
    const f = await fixture();
    await expectedTabMoves.run({ tabId: 30, fromWindowId: 10, toWindowId: 90 }, async () => {});
    f.moveOut(30);
    f.manager.releaseObservedTab(30);
    f.tabEvents.onAttached.emit(30, { newWindowId: 80, newPosition: 0 });
    await Promise.resolve();
    expect(f.manager.has("task")).toBe(false);
    expect(f.resetAgentOverlays).toHaveBeenCalledWith(30, "task");
    f.handler.dispose();
  });

  it("never revives control when transport or renderer cleanup fails", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const f = await fixture();
    f.send.mockImplementation(() => {
      throw new Error("disconnected");
    });
    f.resetAgentOverlays.mockRejectedValue(new Error("no receiver"));
    f.detachSession.mockRejectedValue(new Error("already detached"));
    f.moveOut(20);
    await Promise.resolve();
    expect(f.manager.has("task")).toBe(false);
    expect(f.onSessionReleased).toHaveBeenCalledOnce();
    expect(f.resetAgentOverlays).toHaveBeenCalledTimes(3);
    expect(f.remove).not.toHaveBeenCalled();
    f.handler.dispose();
  });

  it.each([
    false,
    true,
  ])("does not finish an old close list after release, cancelled=%s", async (cancelled) => {
    const f = await fixture();
    f.task.borrowedTabs.clear();
    f.task.agentCreatedTabs.add(40).add(50);
    const abort = new AbortController();
    const removed: number[] = [];
    const tabs = {
      remove: vi.fn(async (id: number) => {
        removed.push(id);
        if (id === 10) {
          f.moveOut(40);
          if (cancelled) abort.abort();
        }
      }),
    };
    await handleSessionStop(
      f.manager,
      { session_id: "task" },
      {
        signal: abort.signal,
        tabManagement: { tabs: tabs as unknown as TabMutationApi },
        tabsQuery: { query: async () => [], get: vi.fn() },
      },
    );
    expect(removed).toEqual([10]);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.manager.has("task")).toBe(false);
    f.handler.dispose();
  });
});
