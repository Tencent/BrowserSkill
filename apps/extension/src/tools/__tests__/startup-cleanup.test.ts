import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { handleSessionStop } from "../session";

afterEach(() => vi.unstubAllGlobals());

function browser() {
  const liveTabs = new Map<number, chrome.tabs.Tab>([
    [7, { id: 7, windowId: 100, active: true } as chrome.tabs.Tab],
  ]);
  const tabs = {
    query: vi.fn(async () => [...liveTabs.values()]),
    remove: vi.fn(async (id: number) => {
      liveTabs.delete(id);
    }),
    update: vi.fn(),
    create: vi.fn(),
    get: vi.fn(async (id: number) => liveTabs.get(id)!),
    move: vi.fn(),
  };
  const windows = {
    create: vi.fn(async () => ({ id: 100, tabs: [...liveTabs.values()] })),
    remove: vi.fn(async () => {
      liveTabs.clear();
    }),
  };
  vi.stubGlobal("chrome", { tabs, windows });
  return { liveTabs, tabs, windows, manager: new SessionManager() };
}

describe("failed startup through the production stop handler", () => {
  it.each([
    false,
    true,
  ])("retains the initial tab when startup fails (cancel=%s)", async (cancel) => {
    const b = browser();
    const controller = new AbortController();
    if (cancel) {
      b.windows.create.mockImplementationOnce(async () => {
        controller.abort();
        return { id: 100, tabs: [...b.liveTabs.values()] };
      });
    } else {
      b.tabs.query.mockRejectedValueOnce(new Error("initialization failed"));
    }
    b.windows.remove.mockRejectedValueOnce(new Error("rollback close failed"));
    await expect(b.manager.start("broken", { signal: controller.signal })).rejects.toMatchObject({
      name: "SessionStartCleanupError",
    });
    const result = await handleSessionStop(
      b.manager,
      { session_id: "broken" },
      {
        tabManagement: { tabs: b.tabs },
        tabsQuery: b.tabs,
      },
    );
    expect(result).not.toHaveProperty("window_released", true);
    expect(b.tabs.remove).toHaveBeenCalledWith(7);
    expect(b.windows.remove).toHaveBeenCalledTimes(2);
    expect(b.liveTabs.size).toBe(0);
    expect(b.manager.has("broken")).toBe(false);
  });

  it("removes the initial tab while preserving a later user tab", async () => {
    const b = browser();
    b.tabs.query.mockRejectedValueOnce(new Error("initialization failed"));
    b.windows.remove.mockRejectedValueOnce(new Error("rollback close failed"));
    await expect(b.manager.start("broken")).rejects.toThrow(/cleanup/);
    b.liveTabs.set(99, { id: 99, windowId: 100 } as chrome.tabs.Tab);
    const result = await handleSessionStop(
      b.manager,
      { session_id: "broken" },
      {
        tabManagement: { tabs: b.tabs },
        tabsQuery: b.tabs,
      },
    );
    expect(result).toMatchObject({ window_released: true });
    expect([...b.liveTabs.keys()]).toEqual([99]);
    expect(b.windows.remove).toHaveBeenCalledTimes(1);
    expect(b.manager.has("broken")).toBe(false);
  });

  it("retains cleanup responsibility when an agent tab cannot close beside a user tab", async () => {
    const b = browser();
    b.tabs.query.mockRejectedValueOnce(new Error("initialization failed"));
    b.windows.remove.mockRejectedValueOnce(new Error("rollback close failed"));
    await expect(b.manager.start("broken")).rejects.toThrow(/cleanup/);
    b.liveTabs.set(99, { id: 99, windowId: 100 } as chrome.tabs.Tab);
    b.tabs.remove.mockRejectedValueOnce(new Error("tab close failed"));
    const deps = { tabManagement: { tabs: b.tabs }, tabsQuery: b.tabs };
    const failed = await handleSessionStop(b.manager, { session_id: "broken" }, deps);
    expect(failed).toMatchObject({ code: "protocol_error", data: { reason: "cleanup_failed" } });
    expect(b.manager.has("broken")).toBe(true);
    expect([...b.liveTabs.keys()]).toEqual([7, 99]);
    expect(b.windows.remove).toHaveBeenCalledTimes(1);
    expect(await handleSessionStop(b.manager, { session_id: "broken" }, deps)).toMatchObject({
      window_released: true,
    });
    expect([...b.liveTabs.keys()]).toEqual([99]);
    expect(b.manager.has("broken")).toBe(false);
  });
});
