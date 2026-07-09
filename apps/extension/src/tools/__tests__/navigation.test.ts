import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import {
  eventLoaderIsRelevant,
  handleNavigate,
  handleNavigateBack,
  handleNavigateForward,
  handleReload,
  lifecycleAlreadyReached,
  lifecycleMeetsOrExceeds,
  shouldTrustReadyStateProbe,
} from "../navigation";

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

/**
 * Fake CDP runner that lets the test fire arbitrary lifecycle events
 * after collecting all the `send` calls. Returns `{cdp, fireLifecycle}`
 * so the test scripts the sequence: kick off navigate → fire load
 * event → assert resolution.
 */
function makeFakeCdp(opts?: {
  navigateFrameId?: string;
  navigateLoaderId?: string;
  initialUrl?: string;
  finalUrl?: string;
  historyEntries?: Array<{ id: number; url: string }>;
  historyIndex?: number;
  fireLifecycleDuringNavigate?: string;
  fireLifecycleDuringNavigateFrameId?: string;
  fireLifecycleDuringReload?: string;
  fireLifecycleDuringNavigateLoaderId?: string;
  beforeLoaderId?: string;
  readyState?: string;
  readyStateSequence?: string[];
}) {
  const readyStates = opts?.readyStateSequence ?? (opts?.readyState ? [opts.readyState] : []);
  let readyStateIdx = 0;
  const nextReadyState = () => {
    if (readyStates.length === 0) return "loading";
    const value = readyStates[Math.min(readyStateIdx, readyStates.length - 1)];
    if (readyStateIdx < readyStates.length - 1) readyStateIdx += 1;
    return value;
  };
  const events: EventListener[] = [];
  const sent: Array<{ tabId: number; method: string; params?: object }> = [];
  const methodHandlers: Record<string, (tabId: number, params?: object) => object> = {
    "Page.enable": () => ({}),
    "Page.setLifecycleEventsEnabled": () => ({}),
    "Page.navigate": () => {
      if (opts?.fireLifecycleDuringNavigate) {
        const payload = {
          name: opts.fireLifecycleDuringNavigate,
          frameId: opts.fireLifecycleDuringNavigateFrameId ?? opts.navigateFrameId ?? "frame-1",
          loaderId:
            opts.fireLifecycleDuringNavigateLoaderId ?? opts.navigateLoaderId ?? "loader-after",
        };
        for (const listener of [...events]) {
          listener({ tabId: 4 }, "Page.lifecycleEvent", payload);
        }
      }
      return {
        frameId: opts?.navigateFrameId ?? "frame-1",
        loaderId: opts?.navigateLoaderId ?? "loader-after",
      };
    },
    "Page.reload": () => {
      if (opts?.fireLifecycleDuringReload) {
        const payload = {
          name: opts.fireLifecycleDuringReload,
          frameId: opts.navigateFrameId ?? "frame-1",
          loaderId: opts.navigateLoaderId ?? "loader-after",
        };
        for (const listener of [...events]) {
          listener({ tabId: 4 }, "Page.lifecycleEvent", payload);
        }
      }
      return {};
    },
    "Runtime.enable": () => ({}),
    "Runtime.evaluate": () => ({ result: { value: nextReadyState() } }),
    "Page.getNavigationHistory": () => ({
      currentIndex: opts?.historyIndex ?? 1,
      entries: opts?.historyEntries ?? [
        { id: 11, url: "https://a.example/" },
        { id: 12, url: "https://b.example/" },
      ],
    }),
    "Page.navigateToHistoryEntry": () => ({}),
    "Page.getFrameTree": () => ({
      frameTree: {
        frame: {
          id: opts?.navigateFrameId ?? "frame-1",
          loaderId: opts?.beforeLoaderId ?? "loader-before",
        },
      },
    }),
  };

  const sendImpl = async (tabId: number, method: string, params?: object) => {
    sent.push({ tabId, method, params });
    const handler = methodHandlers[method];
    if (handler) return handler(tabId, params);
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
  const tabsApi = {
    get: vi.fn(
      async (tabId: number) =>
        ({
          id: tabId,
          windowId: 100,
          active: true,
          url: opts?.finalUrl ?? opts?.initialUrl ?? "https://example.com/",
        }) as chrome.tabs.Tab,
    ),
    query: vi.fn(async () => [
      {
        id: 4,
        windowId: 100,
        active: true,
        url: opts?.initialUrl ?? "https://example.com/",
      } as chrome.tabs.Tab,
    ]),
  };
  return {
    cdp,
    tabsApi,
    sent,
    fireLifecycle(
      name: string,
      frameId = opts?.navigateFrameId ?? "frame-1",
      loaderId = opts?.navigateLoaderId ?? "loader-after",
    ) {
      const payload = { name, frameId, loaderId };
      for (const listener of [...events]) listener({ tabId: 4 }, "Page.lifecycleEvent", payload);
    },
    fireFrameNavigated(frameId = opts?.navigateFrameId ?? "frame-1") {
      const payload = { frame: { id: frameId, url: opts?.finalUrl ?? "https://example.com/" } };
      for (const listener of [...events]) listener({ tabId: 4 }, "Page.frameNavigated", payload);
    },
    listeners: events,
  };
}

describe("lifecycleAlreadyReached", () => {
  it("maps document.readyState to CDP lifecycle phases", () => {
    expect(lifecycleAlreadyReached("loading", "load")).toBe(false);
    expect(lifecycleAlreadyReached("loading", "DOMContentLoaded")).toBe(false);
    expect(lifecycleAlreadyReached("loading", "commit")).toBe(true);
    expect(lifecycleAlreadyReached("interactive", "DOMContentLoaded")).toBe(true);
    expect(lifecycleAlreadyReached("interactive", "load")).toBe(false);
    expect(lifecycleAlreadyReached("complete", "load")).toBe(true);
    expect(lifecycleAlreadyReached("complete", "networkIdle")).toBe(false);
  });
});

describe("lifecycleMeetsOrExceeds", () => {
  it("treats later lifecycle phases as satisfying an earlier wait_until", () => {
    expect(lifecycleMeetsOrExceeds("load", "DOMContentLoaded")).toBe(true);
    expect(lifecycleMeetsOrExceeds("DOMContentLoaded", "load")).toBe(false);
    expect(lifecycleMeetsOrExceeds("networkIdle", "load")).toBe(true);
  });

  it("does not treat paint events as satisfying load", () => {
    expect(lifecycleMeetsOrExceeds("firstPaint", "load")).toBe(false);
    expect(lifecycleMeetsOrExceeds("firstContentfulPaint", "load")).toBe(false);
  });
});

describe("eventLoaderIsRelevant", () => {
  it("rejects events from the pre-navigation loader", () => {
    expect(eventLoaderIsRelevant("loader-before", { beforeLoaderId: "loader-before" })).toBe(false);
    expect(
      eventLoaderIsRelevant("loader-after", {
        beforeLoaderId: "loader-before",
        loaderId: "loader-after",
      }),
    ).toBe(true);
  });
});

describe("shouldTrustReadyStateProbe", () => {
  it("allows passive probes on a settled complete document", () => {
    expect(
      shouldTrustReadyStateProbe("complete", "load", {
        mode: "passive",
        beforeReadyState: "complete",
        sawRelevantLifecycle: false,
      }),
    ).toBe(true);
  });

  it("rejects after-navigation complete→complete with no lifecycle events", () => {
    expect(
      shouldTrustReadyStateProbe("complete", "load", {
        mode: "after-navigation",
        beforeReadyState: "complete",
        sawRelevantLifecycle: false,
      }),
    ).toBe(false);
  });

  it("allows after-navigation probe when lifecycle events were observed", () => {
    expect(
      shouldTrustReadyStateProbe("complete", "load", {
        mode: "after-navigation",
        beforeReadyState: "complete",
        sawRelevantLifecycle: true,
      }),
    ).toBe(true);
  });
});

describe("handleNavigate", () => {
  it("defaults wait_until to load and resolves on the load lifecycle", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({ finalUrl: "https://example.com/landing" });
    const navP = handleNavigate(
      sm,
      { session_id: "aa11", url: "https://example.com/landing" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    // Wait for Page.navigate to register the listener.
    await new Promise((r) => setTimeout(r, 5));
    fake.fireLifecycle("load");
    const res = await navP;
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tab_id).toBe(4);
    expect(res.url).toBe("https://example.com/landing");
    expect(res.final_url).toBe("https://example.com/landing");
    expect(res.reached).toBe("load");
    // Listener cleaned up after success.
    expect(fake.listeners.length).toBe(0);
  });

  it("registers lifecycle listeners before Page.navigate is sent", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      finalUrl: "https://example.com/fast",
      fireLifecycleDuringNavigate: "load",
    });
    const res = await handleNavigate(
      sm,
      {
        session_id: "aa11",
        url: "https://example.com/fast",
        wait_until: "load",
        timeout_ms: 20,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("load");
    expect(fake.listeners.length).toBe(0);
  });

  it("does not treat early subframe lifecycle as direct navigate completion", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      fireLifecycleDuringNavigate: "load",
      fireLifecycleDuringNavigateFrameId: "child-frame",
      navigateLoaderId: "loader-after",
    });
    const res = await handleNavigate(
      sm,
      {
        session_id: "aa11",
        url: "https://example.com/",
        wait_until: "load",
        timeout_ms: 20,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("timeout");
    expect(res.error_text).toMatch(/timed out/);
    expect(fake.listeners.length).toBe(0);
  });

  it("does not complete navigate on stale loader lifecycle with readyState complete", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      readyState: "complete",
      beforeLoaderId: "loader-before",
      navigateLoaderId: "loader-after",
      fireLifecycleDuringNavigate: "load",
      fireLifecycleDuringNavigateLoaderId: "loader-before",
    });
    const res = await handleNavigate(
      sm,
      {
        session_id: "aa11",
        url: "https://example.com/",
        wait_until: "load",
        timeout_ms: 20,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("timeout");
  });

  it("ignores stale loader lifecycle and accepts the new navigation loader", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      beforeLoaderId: "loader-before",
      navigateLoaderId: "loader-after",
      fireLifecycleDuringNavigate: "load",
      fireLifecycleDuringNavigateLoaderId: "loader-before",
    });
    const navP = handleNavigate(
      sm,
      {
        session_id: "aa11",
        url: "https://example.com/",
        wait_until: "load",
        timeout_ms: 1_000,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    await new Promise((r) => setTimeout(r, 5));
    fake.fireLifecycle("load", "frame-1", "loader-after");
    const res = await navP;
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("load");
  });

  it("returns reached=timeout when no matching lifecycle fires", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp();
    const navP = handleNavigate(
      sm,
      {
        session_id: "aa11",
        url: "https://example.com/",
        wait_until: "load",
        timeout_ms: 20,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    await new Promise((r) => setTimeout(r, 5));
    // Fire an earlier lifecycle so the handler can record "last reached"
    // but still time out before `load`.
    fake.fireLifecycle("commit");
    fake.fireLifecycle("DOMContentLoaded");
    const res = await navP;
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("timeout");
    expect(res.error_text).toMatch(/timed out/);
    // No leftover listener after timeout.
    expect(fake.listeners.length).toBe(0);
  });

  it("aborts when the AbortSignal is fired", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp();
    const abort = new AbortController();
    const navP = handleNavigate(
      sm,
      {
        session_id: "aa11",
        url: "https://example.com/",
        wait_until: "load",
        timeout_ms: 5_000,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );
    await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    const res = await navP;
    expect(res).toMatchObject({ code: "cancelled" });
    expect(fake.listeners.length).toBe(0);
  });

  it("resolves wait_until=domcontentloaded when only load fires during navigate", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      fireLifecycleDuringNavigate: "load",
    });
    const res = await handleNavigate(
      sm,
      {
        session_id: "aa11",
        url: "https://example.com/",
        wait_until: "domcontentloaded",
        timeout_ms: 1_000,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("domcontentloaded");
  });

  it("treats Page.frameNavigated as wait_until=commit", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp();
    const navP = handleNavigate(
      sm,
      {
        session_id: "aa11",
        url: "https://example.com/",
        wait_until: "commit",
        timeout_ms: 1_000,
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    await new Promise((r) => setTimeout(r, 5));
    fake.fireFrameNavigated();
    const res = await navP;
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("commit");
    expect(fake.listeners.length).toBe(0);
  });
});

describe("handleNavigateBack / Forward", () => {
  it("navigates to the previous history entry", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      historyIndex: 1,
      historyEntries: [
        { id: 11, url: "https://a.example/" },
        { id: 12, url: "https://b.example/" },
      ],
    });
    const navP = handleNavigateBack(
      sm,
      { session_id: "aa11", wait_until: "load", timeout_ms: 1_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    await new Promise((r) => setTimeout(r, 5));
    fake.fireLifecycle("load");
    const res = await navP;
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    const navigateCall = fake.sent.find((c) => c.method === "Page.navigateToHistoryEntry");
    expect(navigateCall?.params).toEqual({ entryId: 11 });
    expect(res.previous_url).toBe("https://b.example/");
  });

  it("returns invalid_params when there is no previous history", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({ historyIndex: 0 });
    const res = await handleNavigateBack(
      sm,
      { session_id: "aa11" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ code: "invalid_params", message: /no previous/i });
  });

  it("navigateForward advances by +1 history entry", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      historyIndex: 0,
      historyEntries: [
        { id: 11, url: "https://a.example/" },
        { id: 12, url: "https://b.example/" },
      ],
    });
    const navP = handleNavigateForward(
      sm,
      { session_id: "aa11", wait_until: "load", timeout_ms: 1_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    await new Promise((r) => setTimeout(r, 5));
    fake.fireLifecycle("load");
    const res = await navP;
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    const navigateCall = fake.sent.find((c) => c.method === "Page.navigateToHistoryEntry");
    expect(navigateCall?.params).toEqual({ entryId: 12 });
  });

  it("navigateForward returns invalid_params at the head of the history", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      historyIndex: 1,
      historyEntries: [
        { id: 11, url: "https://a.example/" },
        { id: 12, url: "https://b.example/" },
      ],
    });
    const res = await handleNavigateForward(
      sm,
      { session_id: "aa11" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ code: "invalid_params", message: /no forward/i });
  });
});

describe("handleReload", () => {
  it("resolves when reload finishes before the waiter runs (lifecycle during reload)", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      readyState: "complete",
      beforeLoaderId: "loader-before",
      navigateLoaderId: "loader-after",
      fireLifecycleDuringReload: "load",
    });
    const res = await handleReload(
      sm,
      { session_id: "aa11", wait_until: "load", timeout_ms: 1_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("load");
    expect(fake.listeners.length).toBe(0);
  });

  it("resolves via readyState probe when reload settles without lifecycle events", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({ readyStateSequence: ["loading", "complete"] });
    const res = await handleReload(
      sm,
      { session_id: "aa11", wait_until: "load", timeout_ms: 1_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.reached).toBe("load");
    expect(fake.listeners.length).toBe(0);
  });

  it("issues Page.reload with ignoreCache=false by default", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp();
    const navP = handleReload(
      sm,
      { session_id: "aa11", wait_until: "load", timeout_ms: 1_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    await new Promise((r) => setTimeout(r, 5));
    fake.fireLifecycle("load");
    const res = await navP;
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    const reloadCall = fake.sent.find((c) => c.method === "Page.reload");
    expect(reloadCall?.params).toEqual({ ignoreCache: false });
    expect(res.reached).toBe("load");
  });

  it("hard=true sets ignoreCache", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp();
    const navP = handleReload(
      sm,
      { session_id: "aa11", hard: true, wait_until: "load", timeout_ms: 1_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    await new Promise((r) => setTimeout(r, 5));
    fake.fireLifecycle("load");
    await navP;
    const reloadCall = fake.sent.find((c) => c.method === "Page.reload");
    expect(reloadCall?.params).toEqual({ ignoreCache: true });
  });
});
