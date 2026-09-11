import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enforceAgentWindow, resolveTargetTab } from "@/tools/shared";
import {
  handleTabBorrow,
  handleTabCreate,
  handleTabList,
  handleTabReturn,
  handleTabSelect,
} from "@/tools/tabs";
import { SessionManager } from "../manager";

describe("remote task tabs", () => {
  let manager: SessionManager;
  let tabs: Map<number, any>;
  let api: any;
  beforeEach(() => {
    tabs = new Map([
      [1, { id: 1, windowId: 10, active: true, index: 0, url: "https://chat.example" }],
    ]);
    let id = 10;
    api = {
      get: vi.fn(async (id: number) => {
        if (!tabs.has(id)) throw new Error("missing");
        return tabs.get(id);
      }),
      query: vi.fn(async () => [...tabs.values()]),
      create: vi.fn(async (props: any) => {
        const tab = { id: ++id, index: tabs.size, ...props };
        tabs.set(tab.id, tab);
        return tab;
      }),
      update: vi.fn(async (id: number, props: any) => Object.assign(tabs.get(id), props)),
      remove: vi.fn(async (id: number) => {
        tabs.delete(id);
      }),
      move: vi.fn(),
      group: vi.fn(async () => 7),
    };
    vi.stubGlobal("chrome", {
      tabs: api,
      windows: {
        getAll: vi.fn(async () => [{ id: 10, focused: true, type: "normal" }]),
        remove: vi.fn(),
      },
      tabGroups: { update: vi.fn() },
    });
    manager = new SessionManager({ taskTabs: () => true, taskLabel: () => "WeKnora" });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("shares a host window, labels owned tabs, and never closes chat or another task", async () => {
    const a = await manager.start("task-a"),
      b = await manager.start("task-b");
    expect(a.agentWindowId).toBe(b.agentWindowId);
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({ active: false, windowId: 10 }),
    );
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ title: expect.stringContaining("WeKnora") }),
    );
    expect(manager.findByWindowId(10)).toBeNull();
    expect(manager.findByTabId(a.activeTabId!)).toBe(a);
    expect(await resolveTargetTab(manager, a, 1, api)).toMatchObject({ code: "permission_denied" });
    expect(await resolveTargetTab(manager, a, b.activeTabId, api)).toMatchObject({
      code: "not_found",
    });
    expect(enforceAgentWindow(a, { tabId: 1, windowId: 10 }, "click")).toMatchObject({
      code: "permission_denied",
    });
    await manager.stop(a.sessionId);
    expect(tabs.has(1)).toBe(true);
    expect(tabs.has(b.activeTabId!)).toBe(true);
    expect(chrome.windows.remove).not.toHaveBeenCalled();
  });
  it("selects task tabs logically without activating the user tab bar", async () => {
    const task = await manager.start("task-a");
    const made = await handleTabCreate(
      manager,
      { session_id: task.sessionId, url: "https://example.com" },
      { tabs: api },
    );
    expect(made).toHaveProperty("tab_id");
    await handleTabSelect(
      manager,
      { session_id: task.sessionId, tab_id: task.activeTabId! },
      { tabs: api },
    );
    expect(api.update).not.toHaveBeenCalled();
    const target = await resolveTargetTab(manager, task, undefined, api);
    expect(target).toMatchObject({ tabId: task.activeTabId, active: false });
    const listed = await handleTabList(manager, { session_id: task.sessionId, scope: "user" }, api);
    expect(listed).toMatchObject({ tabs: [expect.objectContaining({ tab_id: 1, scope: "user" })] });
  });
  it("requires approval for an existing tab and returns it without moving it", async () => {
    const task = await manager.start("task-a");
    const deny = await handleTabBorrow(
      manager,
      { session_id: task.sessionId, tab_id: 1 },
      { tabs: api, approveBorrow: async () => false },
    );
    expect(deny).toHaveProperty("code");
    expect(task.borrowedTabs.has(1)).toBe(false);
    const allowed = await handleTabBorrow(
      manager,
      { session_id: task.sessionId, tab_id: 1 },
      { tabs: api, approveBorrow: async () => true },
    );
    expect(allowed).toHaveProperty("tab_id", 1);
    expect(api.move).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
    expect(enforceAgentWindow(task, { tabId: 1, windowId: 10 }, "click")).toBeNull();
    await handleTabReturn(
      manager,
      { session_id: task.sessionId, tab_id: 1 },
      {
        tabs: api,
        agentOverlayReset: { resetAgentOverlays: async () => {} },
        cdp: { releaseSessionTab: async () => {} },
      },
    );
    expect(api.move).not.toHaveBeenCalled();
    expect(task.borrowedTabs.has(1)).toBe(false);
    expect(tabs.get(1).active).toBe(true);
  });
});
