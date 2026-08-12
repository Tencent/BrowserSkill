import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import { handleWaitForNavigation } from "../waits";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  return {
    create: vi.fn(async () => {
      const id = ids[i++];
      if (id === undefined) throw new Error("ran out of fake ids");
      return id;
    }),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => {}),
  };
}

interface EventListener {
  (source: chrome.debugger.Debuggee, method: string, params: unknown): void;
}

function makeFakeCdp(
  opts: { windowId?: number; mainFrameId?: string; readyState?: string | null } = {},
) {
  const events: EventListener[] = [];
  const sent: Array<{ tabId: number; method: string; params?: object }> = [];
  const sendImpl = async (tabId: number, method: string, params?: object) => {
    sent.push({ tabId, method, params });
    if (method === "Page.enable") return {};
    if (method === "Page.setLifecycleEventsEnabled") return {};
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: opts.mainFrameId ?? "frame-1" } } };
    }
    if (method === "Runtime.enable") return {};
    if (method === "Runtime.evaluate") {
      if (opts.readyState === null) {
        throw new Error("probe failed");
      }
      return { result: { value: opts.readyState ?? "loading" } };
    }
    throw new Error(`unexpected CDP call ${method}`);
  };
  const send = vi.fn(sendImpl);
  const cdp: CdpRunner = {
    send: send as unknown as <T = unknown>(
      tabId: number,
      method: string,
      params?: object,
    ) => Promise<T>,
    trackSessionTab: vi.fn(),
    onEvent: vi.fn((handler: EventListener) => {
      events.push(handler);
      return {
        dispose: () => {
          const idx = events.indexOf(handler);
          if (idx >= 0) events.splice(idx, 1);
        },
      };
    }),
  };
  const windowId = opts.windowId ?? 100;
  const tabsApi = {
    get: vi.fn(async (tabId: number) => ({ id: tabId, windowId, active: true }) as chrome.tabs.Tab),
    query: vi.fn(async () => [{ id: 4, windowId, active: true } as chrome.tabs.Tab]),
  };
  return {
    cdp,
    tabsApi,
    sent,
    fireLifecycle(name: string, tabId = 4, frameId = opts.mainFrameId ?? "frame-1") {
      const payload = { name, frameId, loaderId: "loader-1" };
      for (const listener of [...events]) listener({ tabId }, "Page.lifecycleEvent", payload);
    },
    listeners: events,
  };
}

describe("handleWaitForNavigation", () => {
  it("resolves immediately when the page is already past the requested lifecycle", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({ readyState: "complete" });
    const res = await handleWaitForNavigation(
      sm,
      { session_id: "aa11", wait_until: "load", timeout_ms: 5_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("load");
    expect(fake.listeners.length).toBe(0);
  });

  it("resolves on the requested lifecycle event (defaults to load)", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp();
    const p = handleWaitForNavigation(
      sm,
      { session_id: "aa11", timeout_ms: 1_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    await new Promise((r) => setTimeout(r, 5));
    fake.fireLifecycle("load");
    const res = await p;
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("load");
    expect(res.tab_id).toBe(4);
    expect(res.error_text).toBeUndefined();
    expect(fake.listeners.length).toBe(0);
  });

  it("ignores matching lifecycle events from subframes", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({ mainFrameId: "main-frame" });
    const p = handleWaitForNavigation(
      sm,
      { session_id: "aa11", timeout_ms: 1_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    await new Promise((r) => setTimeout(r, 5));
    fake.fireLifecycle("load", 4, "child-frame");
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.listeners.length).toBe(1);

    fake.fireLifecycle("load", 4, "main-frame");
    const res = await p;
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("load");
    expect(fake.listeners.length).toBe(0);
  });

  it("does not treat readyState complete as networkidle (must wait for event)", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({ readyState: "complete" });
    const p = handleWaitForNavigation(
      sm,
      { session_id: "aa11", wait_until: "networkidle", timeout_ms: 20 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    const res = await p;
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("timeout");
  });

  it("returns cancelled immediately when the AbortSignal is already aborted", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp();
    const abort = new AbortController();
    abort.abort();
    const res = await handleWaitForNavigation(
      sm,
      { session_id: "aa11", wait_until: "load", timeout_ms: 5_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );
    expect(res).toMatchObject({ code: "cancelled" });
    // No CDP call should have been issued.
    expect(fake.sent.length).toBe(0);
  });

  it("allows waiting on a borrowed tab moved inside the Agent Window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 0 });
    const fake = makeFakeCdp();
    fake.tabsApi.get = vi.fn(
      async () => ({ id: 7, windowId: 100, active: true }) as chrome.tabs.Tab,
    );
    const p = handleWaitForNavigation(
      sm,
      { session_id: "aa11", tab_id: 7, timeout_ms: 1_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    await new Promise((r) => setTimeout(r, 5));
    fake.fireLifecycle("load", 7);
    const res = await p;
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("load");
    expect(res.tab_id).toBe(7);
  });
});
