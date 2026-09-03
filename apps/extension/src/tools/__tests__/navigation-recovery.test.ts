import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { BrowserNavigationApi } from "../browser-navigation";
import { handleNavigate, handleReload } from "../navigation";
import type { CdpRunner } from "../shared";

const denied = "Cannot access a chrome-extension:// URL of different extension";
const url = "https://example.test/recovered";

function event<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    listeners,
    addListener: (listener: T) => listeners.add(listener),
    removeListener: (listener: T) => listeners.delete(listener),
    fire: (...args: Parameters<T>) => {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

async function fixture() {
  const manager = new SessionManager({
    agentWindow: {
      create: vi.fn(async () => 100),
      remove: vi.fn(async () => {}),
      ensureActiveTab: vi.fn(async () => {}),
    },
  });
  await manager.start("test");
  type Listener = Parameters<BrowserNavigationApi["onCommitted"]["addListener"]>[0];
  const events = {
    onCommitted: event<Listener>(),
    onDOMContentLoaded: event<Listener>(),
    onCompleted: event<Listener>(),
    onErrorOccurred: event<Listener>(),
  };
  const cdpEvents = event<Parameters<NonNullable<CdpRunner["onEvent"]>>[0]>();
  const state = { blocked: true, destinationBlocked: false, emitIdle: true };
  const send = vi.fn(async (_tabId: number, method: string) => {
    if (state.blocked) throw new Error(denied);
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main", loaderId: "new-loader" } } };
    }
    if (method === "Runtime.evaluate") return { result: { value: "complete" } };
    if (method === "Page.setLifecycleEventsEnabled" && state.emitIdle) {
      cdpEvents.fire({ tabId: 4 }, "Page.lifecycleEvent", {
        frameId: "main",
        loaderId: "new-loader",
        name: "networkIdle",
      });
    }
    if (method === "Page.navigate") return { frameId: "main", loaderId: "new-loader" };
    return {};
  });
  const cdp: CdpRunner = {
    send: send as CdpRunner["send"],
    onEvent: (listener) => {
      cdpEvents.addListener(listener);
      return { dispose: () => cdpEvents.removeListener(listener) };
    },
  };
  const main = { tabId: 4, frameId: 0, documentId: "new-document" };
  const navigate = async () => {
    state.blocked = state.destinationBlocked;
    events.onCommitted.fire(main);
    events.onDOMContentLoaded.fire(main);
    events.onCompleted.fire(main);
  };
  const browserNavigation = { ...events, update: vi.fn(navigate), reload: vi.fn(navigate) };
  const tab = { id: 4, windowId: 100, active: true, url } as chrome.tabs.Tab;
  const tabsApi = { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]) };
  const deps = { cdp, tabsApi, browserNavigation, defaultTimeoutMs: 1000 };
  const expectCleanedUp = () => {
    for (const entry of Object.values(events)) expect(entry.listeners.size).toBe(0);
    expect(cdpEvents.listeners.size).toBe(0);
  };
  return { manager, deps, state, send, events, main, cdpEvents, expectCleanedUp };
}

describe("navigation after Chrome denies extension-frame access", () => {
  it.each([
    "load",
    "commit",
    "domcontentloaded",
    "networkidle",
  ] as const)("recovers the same tab with the requested %s checkpoint", async (waitUntil) => {
    const f = await fixture();
    const result = await handleNavigate(
      f.manager,
      {
        session_id: "test",
        url,
        wait_until: waitUntil,
      },
      f.deps,
    );

    expect(result).toMatchObject({ tab_id: 4, final_url: url, reached: waitUntil });
    expect(f.deps.browserNavigation.update).toHaveBeenCalledExactlyOnceWith(4, { url });
    expect(f.send.mock.calls.some(([, method]) => method === "Page.navigate")).toBe(false);
    expect(f.send).toHaveBeenCalledWith(4, "Page.enable", {});
    f.expectCleanedUp();
  });

  it("recovers reload through tabs.reload and preserves hard reload", async () => {
    const f = await fixture();
    const result = await handleReload(f.manager, { session_id: "test", hard: true }, f.deps);
    expect(result).toMatchObject({ tab_id: 4, reached: "load" });
    expect(f.deps.browserNavigation.reload).toHaveBeenCalledExactlyOnceWith(4, {
      bypassCache: true,
    });
    expect(f.deps.browserNavigation.update).not.toHaveBeenCalled();
    f.expectCleanedUp();
  });

  it("reports the restriction when reload leaves the conflicting frame present", async () => {
    const f = await fixture();
    f.state.destinationBlocked = true;
    const result = await handleReload(f.manager, { session_id: "test" }, f.deps);
    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { reason: "cdp_extension_access_denied" },
    });
    expect(f.deps.browserNavigation.reload).toHaveBeenCalledOnce();
    f.expectCleanedUp();
  });

  it("does not fall back for unrelated debugger failures", async () => {
    const f = await fixture();
    f.send.mockRejectedValue(new Error("Another debugger is already attached"));
    const result = await handleNavigate(f.manager, { session_id: "test", url }, f.deps);
    expect(result).toMatchObject({
      code: "cdp_failed",
      message: "Another debugger is already attached",
    });
    expect(f.deps.browserNavigation.update).not.toHaveBeenCalled();
    f.expectCleanedUp();
  });

  it("does not replay navigation when a dispatched CDP command fails", async () => {
    const f = await fixture();
    f.state.blocked = false;
    const send = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (tabId, method) => {
      if (method === "Page.navigate") throw new Error(denied);
      return send(tabId, method);
    });
    const result = await handleNavigate(f.manager, { session_id: "test", url }, f.deps);
    expect(result).toMatchObject({
      code: "cdp_failed",
      data: { reason: "cdp_extension_access_denied" },
    });
    expect(f.deps.browserNavigation.update).not.toHaveBeenCalled();
    f.expectCleanedUp();
  });

  it("keeps the Agent Window guard in front of the recovery", async () => {
    const f = await fixture();
    f.deps.tabsApi.get.mockResolvedValue({
      id: 4,
      windowId: 200,
      active: true,
      url,
    } as chrome.tabs.Tab);
    const result = await handleNavigate(f.manager, { session_id: "test", tab_id: 4, url }, f.deps);
    expect(result).toMatchObject({ code: "permission_denied" });
    expect(f.send).not.toHaveBeenCalled();
    expect(f.deps.browserNavigation.update).not.toHaveBeenCalled();
  });

  it("ignores old-document, subframe, and other-tab completion events", async () => {
    const f = await fixture();
    f.deps.browserNavigation.update.mockImplementation(async () => {});
    let settled = false;
    const work = handleNavigate(f.manager, { session_id: "test", url }, f.deps).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(f.deps.browserNavigation.update).toHaveBeenCalledOnce());
    f.events.onCompleted.fire(f.main);
    f.events.onCommitted.fire({ ...f.main, tabId: 9 });
    f.events.onCommitted.fire({ ...f.main, frameId: 1 });
    f.events.onCompleted.fire(f.main);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.events.onCommitted.fire(f.main);
    f.events.onCompleted.fire({ ...f.main, documentId: "old-document" });
    await Promise.resolve();
    expect(settled).toBe(false);
    f.state.blocked = false;
    f.events.onCompleted.fire(f.main);
    expect(await work).toMatchObject({ reached: "load" });
    f.expectCleanedUp();
  });

  it("does not infer network idle from a browser load event", async () => {
    const f = await fixture();
    f.state.emitIdle = false;
    const result = await handleNavigate(
      f.manager,
      {
        session_id: "test",
        url,
        wait_until: "networkidle",
        timeout_ms: 10,
      },
      f.deps,
    );
    expect(result).toMatchObject({ reached: "timeout" });
    f.expectCleanedUp();
  });

  it("cleans up browser listeners on timeout", async () => {
    const f = await fixture();
    f.deps.browserNavigation.update.mockImplementation(async () => {});
    const result = await handleNavigate(
      f.manager,
      { session_id: "test", url, timeout_ms: 10 },
      f.deps,
    );
    expect(result).toMatchObject({ reached: "timeout" });
    f.expectCleanedUp();
  });

  it("does not navigate an already-cancelled request", async () => {
    const f = await fixture();
    const result = await handleNavigate(
      f.manager,
      { session_id: "test", url },
      {
        ...f.deps,
        signal: AbortSignal.abort(),
      },
    );
    expect(result).toMatchObject({ code: "cancelled" });
    expect(f.deps.browserNavigation.update).not.toHaveBeenCalled();
    f.expectCleanedUp();
  });

  it("cleans up browser listeners when cancelled after dispatch", async () => {
    const f = await fixture();
    const ac = new AbortController();
    f.deps.browserNavigation.update.mockImplementation(async () => {
      ac.abort();
    });
    const result = await handleNavigate(
      f.manager,
      { session_id: "test", url },
      { ...f.deps, signal: ac.signal },
    );
    expect(result).toMatchObject({ code: "cancelled" });
    expect(f.deps.browserNavigation.update).toHaveBeenCalledOnce();
    f.expectCleanedUp();
  });

  it("reports browser navigation errors and releases listeners", async () => {
    const f = await fixture();
    f.deps.browserNavigation.update.mockImplementation(async () => {
      f.events.onErrorOccurred.fire({ ...f.main, error: "net::ERR_NAME_NOT_RESOLVED" });
    });
    const result = await handleNavigate(f.manager, { session_id: "test", url }, f.deps);
    expect(result).toMatchObject({ code: "cdp_failed", message: "net::ERR_NAME_NOT_RESOLVED" });
    f.expectCleanedUp();
  });
});
