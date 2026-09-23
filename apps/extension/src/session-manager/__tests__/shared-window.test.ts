import { describe, expect, it, vi } from "vitest";
import { handleSessionStart, handleSessionStop } from "@/tools/session";
import { enforceAgentWindow, resolveTargetTab } from "@/tools/shared";
import { handleTabBorrow, handleTabList, handleTabReturn } from "@/tools/tabs";
import { attachSessionEventHandler } from "../event-handler";
import { SessionManager } from "../manager";

function fixture() {
  let nextId = 20;
  const pages = new Map<number, chrome.tabs.Tab>([
    [
      1,
      {
        id: 1,
        windowId: 10,
        active: true,
        index: 0,
        url: "https://user.example/",
      } as chrome.tabs.Tab,
    ],
  ]);
  const host = vi.fn(
    async () => ({ id: 10, type: "normal", incognito: false }) as chrome.windows.Window,
  );
  const get = vi.fn(async (id: number) => {
    const tab = pages.get(id);
    if (!tab) throw new Error("No tab with id");
    return tab;
  });
  const remove = vi.fn(async (id: number) => {
    pages.delete(id);
  });
  const create = vi.fn(async (windowId: number, active: boolean) => {
    const id = nextId++;
    pages.set(id, {
      id,
      windowId,
      active,
      index: id,
      url: "https://agent.example/",
    } as chrome.tabs.Tab);
    return id;
  });
  const windows = {
    create: vi.fn(async () => ({ windowId: 99, initialTabIds: [] })),
    ensureActiveTab: vi.fn(async () => 90),
    remove: vi.fn(async () => {}),
  };
  const manager = new SessionManager({
    agentWindow: windows,
    sharedWindow: {
      host,
      window: async (windowId) =>
        ({ id: windowId, type: "normal", incognito: false }) as chrome.windows.Window,
      active: async (windowId) =>
        [...pages.values()].find((tab) => tab.windowId === windowId && tab.active)!,
      get,
      create,
      remove,
    },
  });
  const query = vi.fn(async () => [...pages.values()]);
  return { manager, pages, host, get, create, remove, windows, query };
}

describe("shared user window sessions (#243)", () => {
  it("creates a new inactive page without claiming user pages or indexing the host as owned", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true, focused: false });
    expect(f.create).toHaveBeenCalledWith(10, false);
    expect([...ctx.agentCreatedTabs]).toEqual([20]);
    expect(f.manager.findByWindowId(10)).toBeNull();
    expect(f.windows.create).not.toHaveBeenCalled();
  });

  it.each([
    true,
    false,
  ])("rejects an ineligible last-focused host (incognito=%s)", async (incognito) => {
    const f = fixture();
    f.host.mockResolvedValue({ id: 99, type: "normal", incognito } as chrome.windows.Window);
    if (!incognito) await f.manager.start("owned");
    await expect(f.manager.start("a", { inWindow: true })).rejects.toThrow("Focus");
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])("isolates two sessions regardless of registration order (%s)", async (reverse) => {
    const f = fixture();
    for (const id of reverse ? ["b", "a"] : ["a", "b"])
      await f.manager.start(id, { inWindow: true });
    const a = f.manager.get("a")!;
    const b = f.manager.get("b")!;
    const api = { get: f.get, query: f.query };
    expect(await resolveTargetTab(f.manager, a, b.activeTabId, api)).toMatchObject({
      code: "not_found",
    });
    expect(await resolveTargetTab(f.manager, b, a.activeTabId, api)).toMatchObject({
      code: "not_found",
    });
    expect(enforceAgentWindow(a, { tabId: 1, windowId: 10 }, "click")).toMatchObject({
      code: "permission_denied",
    });
    expect(await resolveTargetTab(f.manager, a, undefined, api)).toMatchObject({
      tabId: a.activeTabId,
    });
    const list = await handleTabList(f.manager, { session_id: "a", scope: "all" }, api);
    expect(list).toMatchObject({
      tabs: [
        { tab_id: 1, scope: "user" },
        { tab_id: a.activeTabId, scope: "agent" },
      ],
    });
    await f.manager.stop("a");
    expect(f.pages.has(1)).toBe(true);
    expect(f.pages.has(b.activeTabId!)).toBe(true);
    expect(f.manager.get("b")).toBe(b);
    expect(f.windows.remove).not.toHaveBeenCalled();
  });

  it("does not accept dialogs on user pages, even if those pages have been read", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    expect(await resolveTargetTab(f.manager, ctx, 1, { get: f.get, query: f.query })).toMatchObject(
      { tabId: 1 },
    );
    expect(f.manager.canAutoAcceptDialog(1, 10)).toBe(false);
    expect(f.manager.canAutoAcceptDialog(ctx.activeTabId!, 10)).toBe(true);
    expect(f.manager.canAutoAcceptDialog(ctx.activeTabId!, 11)).toBe(false);
  });

  it("normal tool stop never queries or removes the host window", async () => {
    const f = fixture();
    await f.manager.start("a", { inWindow: true });
    f.query.mockRejectedValue(new Error("query denied"));
    expect(
      await handleSessionStop(
        f.manager,
        { session_id: "a" },
        { tabsQuery: { get: f.get, query: f.query } },
      ),
    ).toEqual({});
    expect(f.query).not.toHaveBeenCalled();
    expect(f.windows.remove).not.toHaveBeenCalled();
    expect(f.pages.has(1)).toBe(true);
  });

  it.each([
    "stop",
    "stopAll",
  ] as const)("direct %s keeps retryable state on deletion failure", async (method) => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    f.remove.mockRejectedValue(new Error("delete denied"));
    await expect(method === "stop" ? f.manager.stop("a") : f.manager.stopAll()).rejects.toThrow(
      "delete denied",
    );
    expect(f.manager.get("a")).toBe(ctx);
    expect(ctx.agentCreatedTabs.has(20)).toBe(true);
    expect(f.windows.remove).not.toHaveBeenCalled();
  });

  it("cancellation after creation removes only the created page", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.create.mockImplementation(async () => {
      abort.abort();
      return 20;
    });
    await expect(f.manager.start("a", { inWindow: true, signal: abort.signal })).rejects.toThrow(
      "aborted",
    );
    expect(f.remove).toHaveBeenCalledWith(20);
    expect(f.windows.remove).not.toHaveBeenCalled();
  });

  it("rejects dimensions and remote mode before creating resources", async () => {
    const f = fixture();
    expect(
      await handleSessionStart(f.manager, {
        session_id: "a",
        in_window: true,
        width: 800,
        height: 600,
      }),
    ).toMatchObject({ code: "invalid_params" });
    const remote = new SessionManager({ remote: () => true });
    expect(await handleSessionStart(remote, { session_id: "a", in_window: true })).toMatchObject({
      code: "unsupported",
    });
    expect(f.create).not.toHaveBeenCalled();
  });

  it("reports failed cancellation cleanup as a tab resource and never closes the host", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.create.mockImplementation(async () => {
      abort.abort();
      return 20;
    });
    f.remove.mockRejectedValue(new Error("delete denied"));
    expect(
      await handleSessionStart(
        f.manager,
        { session_id: "a", in_window: true },
        { signal: abort.signal },
      ),
    ).toMatchObject({
      code: "protocol_error",
      data: { reason: "cleanup_failed", resource_type: "tab", resource_id: 20 },
    });
    expect(f.manager.get("a")?.agentCreatedTabs.has(20)).toBe(true);
    expect(f.windows.remove).not.toHaveBeenCalled();
  });

  it("does not close reclaimed pages or the host during normal stop", async () => {
    const f = fixture();
    await f.manager.start("a", { inWindow: true });
    f.pages.get(20)!.windowId = 11;
    await f.manager.stop("a");
    expect(f.pages.has(20)).toBe(true);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.windows.remove).not.toHaveBeenCalled();
  });

  it("does not roll back a page reclaimed during startup by deleting it", async () => {
    const f = fixture();
    f.get.mockImplementation(async (id) => ({ ...f.pages.get(id)!, windowId: 11 }));
    await expect(f.manager.start("a", { inWindow: true })).rejects.toThrow("moved");
    expect(f.manager.has("a")).toBe(false);
    expect(f.pages.has(20)).toBe(true);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.windows.remove).not.toHaveBeenCalled();
  });

  it("preserves cleanup state when a live-page lookup fails", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    f.get.mockRejectedValue(new Error("query denied"));
    await expect(f.manager.stop("a")).rejects.toThrow("query denied");
    expect(f.manager.get("a")).toBe(ctx);
    expect(ctx.agentCreatedTabs.has(20)).toBe(true);
    expect(f.windows.remove).not.toHaveBeenCalled();
  });

  it("defers empty lifecycle until a tab transaction commits and refuses concurrent stop", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    const empty = vi.fn();
    f.manager.onEmpty(empty);
    await f.manager.withTabOperation(ctx, async () => {
      f.manager.forgetClosedTab(20);
      expect(empty).not.toHaveBeenCalled();
      await expect(f.manager.stop("a")).rejects.toThrow("pending");
      ctx.agentCreatedTabs.add(21);
    });
    expect(empty).not.toHaveBeenCalled();
    f.manager.forgetClosedTab(21);
    expect(empty).toHaveBeenCalledOnce();
    expect(f.windows.remove).not.toHaveBeenCalled();
  });

  it("borrows and returns a same-window user page without moving or closing it", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    const move = vi.fn();
    const releaseSessionTab = vi.fn(async () => {});
    const deps = {
      tabs: {
        get: f.get,
        create: vi.fn(),
        remove: f.remove,
        move,
        update: vi.fn(async () => f.pages.get(1)!),
      },
      approveBorrow: vi.fn(async () => true),
      cdp: { releaseSessionTab },
      overlayReset: { resetAgentOverlays: vi.fn(async () => {}) },
    };
    expect(await handleTabBorrow(f.manager, { session_id: "a", tab_id: 1 }, deps)).toMatchObject({
      tab_id: 1,
    });
    expect(ctx.borrowedTabs.get(1)?.stationary).toBe(true);
    expect(move).not.toHaveBeenCalled();
    expect(await handleTabReturn(f.manager, { session_id: "a", tab_id: 1 }, deps)).toMatchObject({
      tab_id: 1,
    });
    expect(releaseSessionTab).toHaveBeenCalledWith("a", 1);
    await f.manager.stop("a");
    expect(f.pages.has(1)).toBe(true);
    expect(move).not.toHaveBeenCalled();
  });

  it("resolves an empty target without ending the session; lifecycle ends it once", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    const send = vi.fn();
    const detachSession = vi.fn(async () => {});
    const events = { addListener: vi.fn(), removeListener: vi.fn() };
    const handler = attachSessionEventHandler({
      manager: f.manager,
      transport: { send } as never,
      windowEvents: events,
      cdp: { detachSession },
    });
    f.pages.delete(20);
    expect(
      await resolveTargetTab(f.manager, ctx, undefined, { get: f.get, query: f.query }),
    ).toMatchObject({ code: "not_found" });
    expect(f.manager.has("a")).toBe(true);
    f.manager.forgetClosedTab(20);
    f.manager.forgetClosedTab(20);
    await vi.waitFor(() => expect(f.manager.has("a")).toBe(false));
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      event: "session.tabs_closed",
      payload: { session_id: "a", reason: "no_controlled_tabs" },
    });
    handler.dispose();
  });
});

describe("existing-tab sessions (#279)", () => {
  it("reuses the current tab without creating, moving, or closing browser resources", async () => {
    const f = fixture();
    const approveBorrow = vi.fn(async () => true);
    expect(
      await handleSessionStart(
        f.manager,
        { session_id: "reuse", current_tab: true },
        { approveBorrow },
      ),
    ).toMatchObject({ container_mode: "existing_tab", agent_window_id: 10 });

    const ctx = f.manager.get("reuse")!;
    expect(ctx.container).toEqual({ mode: "existing_tab", hostWindowId: 10, rootTabId: 1 });
    expect(ctx.borrowedTabs.get(1)).toMatchObject({ stationary: true });
    expect(ctx.agentCreatedTabs.size).toBe(0);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.windows.create).not.toHaveBeenCalled();

    const releaseSessionTab = vi.fn(async () => {});
    expect(
      await handleSessionStop(
        f.manager,
        { session_id: "reuse" },
        {
          cdp: { releaseSessionTab, detachSession: vi.fn(async () => {}) },
          tabManagement: {
            agentOverlayReset: { resetAgentOverlays: vi.fn(async () => {}) },
          },
        },
      ),
    ).toEqual({ returned_tab_ids: [1] });
    expect(releaseSessionTab).toHaveBeenCalledWith("reuse", 1);
    expect(f.pages.get(1)).toMatchObject({ windowId: 10, index: 0 });
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.windows.remove).not.toHaveBeenCalled();
  });

  it("does not register a session when the user denies current-tab approval", async () => {
    const f = fixture();
    expect(
      await handleSessionStart(
        f.manager,
        { session_id: "denied", current_tab: true },
        { approveBorrow: async () => false },
      ),
    ).toMatchObject({ code: "cancelled", data: { reason: "user_denied" } });
    expect(f.manager.has("denied")).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
  });
});
