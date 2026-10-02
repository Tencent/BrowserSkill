import { describe, expect, it, vi } from "vitest";
import { handleSessionStart, handleSessionStop } from "@/tools/session";
import { enforceAgentWindow, resolveTargetTab } from "@/tools/shared";
import {
  handleTabBorrow,
  handleTabClose,
  handleTabCreate,
  handleTabList,
  handleTabReturn,
} from "@/tools/tabs";
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
      url: "about:blank",
    } as chrome.tabs.Tab);
    return id;
  });
  const windows = {
    create: vi.fn(async () => ({ windowId: 99, initialTabIds: [] })),
    ensureActiveTab: vi.fn(async () => 90),
    remove: vi.fn(async () => {}),
  };
  const queryHost = vi.fn(async (windowId: number) =>
    [...pages.values()].filter((tab) => tab.windowId === windowId),
  );
  const manager = new SessionManager({
    agentWindow: windows,
    sharedWindow: { host, get, create, remove, query: queryHost },
  });
  const query = vi.fn(async () => [...pages.values()]);
  return { manager, pages, host, get, create, remove, windows, query, queryHost };
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

  it("falls back to a live controlled page when the remembered active tab is gone", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    ctx.activeTabId = 999;
    expect(
      await resolveTargetTab(f.manager, ctx, undefined, { get: f.get, query: f.query }),
    ).toMatchObject({ tabId: 20 });
  });

  it("normal tool stop preserves user pages without dedicated-window cleanup", async () => {
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
    expect(f.create).toHaveBeenCalledOnce();
  });

  it.each([
    "tool",
    "stop",
    "stopAll",
  ] as const)("%s preserves the host when only the session tab remains, without a close event", async (method) => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    f.pages.delete(1);
    const send = vi.fn();
    const events = { addListener: vi.fn(), removeListener: vi.fn() };
    const handler = attachSessionEventHandler({
      manager: f.manager,
      transport: { send } as never,
      windowEvents: events,
    });
    let hostAlive = true;
    const stoppingDuringRemove: boolean[] = [];
    const remove = f.remove.getMockImplementation()!;
    f.remove.mockImplementation(async (id) => {
      stoppingDuringRemove.push(ctx.stopping === true);
      await remove(id);
      f.manager.forgetClosedTab(id);
      if (![...f.pages.values()].some((tab) => tab.windowId === 10)) {
        hostAlive = false;
        events.addListener.mock.calls[0][0](10);
      }
    });
    try {
      if (method === "tool")
        expect(await handleSessionStop(f.manager, { session_id: "a" })).toEqual({});
      else if (method === "stopAll") await f.manager.stopAll();
      else await f.manager.stop("a");
      expect(hostAlive).toBe(true);
      expect([...f.pages.values()]).toMatchObject([{ id: 21, windowId: 10, active: false }]);
      expect(f.manager.findByTabId(21)).toBeNull();
      expect(f.manager.has("a")).toBe(false);
      expect(stoppingDuringRemove).toEqual([true]);
      expect(f.manager.isWindowCloseExpected(ctx)).toBe(false);
      expect(send).not.toHaveBeenCalled();
    } finally {
      handler.dispose();
    }
  });

  it("queries the host once and removes only live owned tabs without individual lookups", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    ctx.agentCreatedTabs.add(await f.create(10, false));
    ctx.agentCreatedTabs.add(await f.create(10, false));
    ctx.agentCreatedTabs.add(await f.create(10, false));
    f.pages.get(21)!.windowId = 11;
    f.pages.delete(22);
    f.pages.delete(1);
    f.get.mockClear();
    await f.manager.stop("a");
    expect(f.queryHost).toHaveBeenCalledExactlyOnceWith(10);
    expect(f.get).not.toHaveBeenCalled();
    expect(f.remove.mock.calls).toEqual([[20], [23]]);
    expect(f.pages.get(21)?.windowId).toBe(11);
    expect(f.pages.get(24)?.windowId).toBe(10);
  });

  it.each([
    "url",
    "pendingUrl",
  ] as const)("keeps a placeholder used by the user during failed stop (%s)", async (urlField) => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    f.pages.delete(1);
    f.remove.mockImplementationOnce(async () => {
      f.pages.get(21)![urlField] = "https://user.example/";
      throw new Error("remove denied");
    });
    await expect(f.manager.stop("a")).rejects.toThrow("remove denied");
    expect(f.remove.mock.calls).toEqual([[20]]);
    expect(f.pages.get(21)?.[urlField]).toBe("https://user.example/");
    expect(f.manager.get("a")).toBe(ctx);
    expect(ctx.stopping).toBe(false);
  });

  it.each([
    "tab_return",
    "session_stop",
    "fallback",
    "placeholder_failure",
    "cancel_return",
    "cancel_stop",
    "move_failure",
    "fallback_same_host",
    "rollback_failure",
  ] as const)("%s preserves a host containing only a cross-window borrowed tab", async (method) => {
    const f = fixture();
    const controller = new AbortController();
    const ctx = await f.manager.start("a", { inWindow: true });
    f.pages.get(1)!.windowId = 11;
    f.pages.set(2, { id: 2, windowId: 11 } as chrome.tabs.Tab);
    const move = vi.fn(async (id: number, props: chrome.tabs.MoveProperties) => {
      const tab = f.pages.get(id)!;
      tab.windowId = props.windowId!;
      tab.index = props.index;
      return tab;
    });
    const deps = {
      tabs: {
        get: f.get,
        create: vi.fn(async (props: chrome.tabs.CreateProperties) =>
          f.get(await f.create(props.windowId!, props.active ?? true)),
        ),
        remove: f.remove,
        move,
        update: vi.fn(async (id: number) => f.get(id)),
      },
      tabsQuery: { query: (props: chrome.tabs.QueryInfo) => f.queryHost(props.windowId!) },
      windows: {
        get: vi.fn(async () => {
          if (method === "fallback" || method === "fallback_same_host")
            throw new Error("No window with id: 11");
          return { id: 11 } as chrome.windows.Window;
        }),
        getLastFocused: vi.fn(
          async () =>
            ({
              id: method === "fallback_same_host" ? 10 : 12,
              type: "normal",
            }) as chrome.windows.Window,
        ),
        create: vi.fn(),
        remove: vi.fn(),
      },
      approveBorrow: vi.fn(async () => true),
      agentOverlayReset: { resetAgentOverlays: vi.fn(async () => {}) },
      signal: controller.signal,
    };
    expect(await handleTabBorrow(f.manager, { session_id: "a", tab_id: 1 }, deps)).toMatchObject({
      original_window_id: 11,
    });
    f.pages.delete(20);
    f.manager.forgetClosedTab(20);
    const send = vi.fn();
    const handler = attachSessionEventHandler({
      manager: f.manager,
      transport: { send } as never,
      windowEvents: { addListener: vi.fn(), removeListener: vi.fn() },
    });
    try {
      if (method === "placeholder_failure")
        f.create.mockRejectedValueOnce(new Error("create denied"));
      if (method === "cancel_return" || method === "cancel_stop" || method === "rollback_failure") {
        const create = deps.tabs.create.getMockImplementation()!;
        deps.tabs.create.mockImplementationOnce(async (props) => {
          const tab = await create(props);
          controller.abort();
          return tab;
        });
      }
      if (method === "move_failure") move.mockRejectedValue(new Error("move denied"));
      if (method === "rollback_failure")
        f.remove.mockRejectedValueOnce(new Error("rollback denied"));
      const result =
        method === "session_stop" || method === "cancel_stop"
          ? await handleSessionStop(
              f.manager,
              { session_id: "a" },
              { tabManagement: deps, signal: controller.signal },
            )
          : await handleTabReturn(f.manager, { session_id: "a", tab_id: 1 }, deps);
      if (method === "placeholder_failure") {
        expect(result).toMatchObject({
          code: "cdp_failed",
          message: expect.stringContaining("create denied"),
        });
        expect(move).toHaveBeenCalledOnce();
        expect(f.pages.get(1)?.windowId).toBe(10);
        expect(ctx.borrowedTabs.has(1)).toBe(true);
        expect(f.manager.has("a")).toBe(true);
        expect(ctx.stopping).toBeFalsy();
        return;
      }
      if (
        method === "cancel_return" ||
        method === "cancel_stop" ||
        method === "move_failure" ||
        method === "rollback_failure"
      ) {
        expect(result).toMatchObject({
          code:
            method === "move_failure"
              ? "cdp_failed"
              : method === "rollback_failure"
                ? "protocol_error"
                : "cancelled",
        });
        expect(
          [...f.pages.values()].filter((tab) => tab.windowId === 10).map((tab) => tab.id),
        ).toEqual(method === "rollback_failure" ? [1, 21] : [1]);
        expect(ctx.borrowedTabs.has(1)).toBe(true);
        expect(f.manager.has("a")).toBe(true);
        expect(ctx.stopping).toBeFalsy();
        if (method === "rollback_failure")
          expect(result).toMatchObject({
            data: { reason: "cleanup_failed", resource_type: "tab", resource_id: 21 },
          });
        else expect(f.remove).toHaveBeenCalledWith(21);
        return;
      }
      expect(result).not.toHaveProperty("code");
      if (method === "fallback_same_host") {
        expect(f.pages.get(1)?.windowId).toBe(10);
        expect(f.create).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(f.manager.has("a")).toBe(false));
        return;
      }
      expect(f.pages.get(1)?.windowId).toBe(method === "fallback" ? 12 : 11);
      expect([...f.pages.values()].filter((tab) => tab.windowId === 10)).toMatchObject([
        { id: 21 },
      ]);
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.create).toHaveBeenLastCalledWith(10, false);
      expect(f.manager.findByTabId(21)).toBeNull();
      await vi.waitFor(() => expect(f.manager.has("a")).toBe(false));
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "session.window_closed" }),
      );
      expect(ctx.borrowedTabs.size).toBe(0);
    } finally {
      handler.dispose();
    }
  });

  it.each([
    "stop",
    "stopAll",
  ] as const)("direct %s keeps retryable state on deletion failure", async (method) => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    f.pages.delete(1);
    f.remove.mockRejectedValueOnce(new Error("delete denied"));
    await expect(method === "stop" ? f.manager.stop("a") : f.manager.stopAll()).rejects.toThrow(
      "delete denied",
    );
    expect(f.manager.get("a")).toBe(ctx);
    expect(ctx.agentCreatedTabs.has(20)).toBe(true);
    expect([...f.pages.keys()]).toEqual([20]);
    expect(f.remove).toHaveBeenCalledWith(21);
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

  it("preserves cleanup state when the host query fails", async () => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    f.queryHost.mockRejectedValue(new Error("query denied"));
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

  it("defers empty cleanup until tab_close finishes after Chrome's removal event", async () => {
    const f = fixture();
    await f.manager.start("a", { inWindow: true });
    const empty = vi.fn();
    f.manager.onEmpty(empty);
    f.remove.mockImplementation(async (id) => {
      f.pages.delete(id);
      f.manager.forgetClosedTab(id);
      expect(empty).not.toHaveBeenCalled();
    });
    const result = await handleTabClose(
      f.manager,
      { session_id: "a", tab_id: 20 },
      { tabs: { get: f.get, remove: f.remove, create: vi.fn(), move: vi.fn(), update: vi.fn() } },
    );
    expect(result).toEqual({ tab_id: 20 });
    expect(empty).toHaveBeenCalledOnce();
  });

  it.each([
    true,
    false,
  ])("does not close a created tab moved during CDP setup (attach event=%s)", async (attachEvent) => {
    const f = fixture();
    const ctx = await f.manager.start("a", { inWindow: true });
    const empty = vi.fn();
    f.manager.onEmpty(empty);
    const update = vi.fn();
    const releaseSessionTab = vi.fn(async () => {});
    const result = await handleTabCreate(
      f.manager,
      { session_id: "a", url: "https://agent.example/new" },
      {
        tabs: {
          create: async (props) => {
            const id = await f.create(props.windowId!, props.active ?? true);
            return f.get(id);
          },
          get: f.get,
          remove: f.remove,
          move: vi.fn(),
          update,
        },
        cdp: {
          acquireBackgroundExecution: vi.fn(async (_sessionId, tabId) => {
            expect(ctx.pendingOperations).toBe(1);
            f.pages.delete(20);
            f.manager.forgetClosedTab(20);
            f.pages.get(tabId)!.windowId = 11;
            if (attachEvent) ctx.agentCreatedTabs.delete(tabId);
            f.manager.checkEmpty(ctx);
            expect(empty).not.toHaveBeenCalled();
          }),
          releaseSessionTab,
        },
      },
    );
    expect(result).toMatchObject({ code: "cdp_failed" });
    expect(f.pages.get(21)?.windowId).toBe(11);
    expect(f.remove).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(ctx.agentCreatedTabs.has(21)).toBe(false);
    expect(releaseSessionTab).toHaveBeenCalledWith("a", 21);
    expect(empty).toHaveBeenCalledOnce();
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
    expect(ctx.borrowedTabs.get(1)?.originalWindowId).toBe(10);
    expect(move).not.toHaveBeenCalled();
    f.pages.get(1)!.windowId = 11;
    expect(await handleTabReturn(f.manager, { session_id: "a", tab_id: 1 }, deps)).toMatchObject({
      tab_id: 1,
    });
    expect(releaseSessionTab).toHaveBeenCalledWith("a", 1);
    await f.manager.stop("a");
    expect(f.pages.has(1)).toBe(true);
    expect(f.pages.get(1)?.windowId).toBe(11);
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
