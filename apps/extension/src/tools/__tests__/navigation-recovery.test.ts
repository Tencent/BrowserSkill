import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import { type BrowserNavigationApi, navigateWithBrowserApi } from "../browser-navigation";
import {
  handleNavigate,
  handleNavigateBack,
  handleNavigateForward,
  handleReload,
} from "../navigation";
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
      create: vi.fn(async () => ({ windowId: 100, initialTabIds: [] })),
      remove: vi.fn(async () => {}),
      ensureActiveTab: vi.fn(async () => 4),
    },
  });
  await manager.start("test");
  type Listener = Parameters<BrowserNavigationApi["onCommitted"]["addListener"]>[0];
  const events = {
    onBeforeNavigate: event<Listener>(),
    onCommitted: event<Listener>(),
    onDOMContentLoaded: event<Listener>(),
    onCompleted: event<Listener>(),
    onErrorOccurred: event<Listener>(),
    onReferenceFragmentUpdated: event<Listener>(),
    onHistoryStateUpdated: event<Listener>(),
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
  const main = { tabId: 4, frameId: 0, documentId: "new-document", url };
  const navigate = async () => {
    state.blocked = state.destinationBlocked;
    tab.url = url;
    events.onBeforeNavigate.fire(main);
    events.onCommitted.fire(main);
    events.onDOMContentLoaded.fire(main);
    events.onCompleted.fire(main);
  };
  const browserNavigation = {
    ...events,
    update: vi.fn(navigate),
    reload: vi.fn(navigate),
    goBack: vi.fn(navigate),
    goForward: vi.fn(navigate),
    getFrame: vi
      .fn(async () => ({ documentId: main.documentId }))
      .mockResolvedValueOnce({ documentId: "old-document" }),
  };
  const tab = { id: 4, windowId: 100, active: true, url } as chrome.tabs.Tab;
  const tabsApi = { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]) };
  const deps = {
    cdp,
    tabsApi,
    browserNavigation,
    defaultTimeoutMs: 1000,
    backgroundExecution: true,
  };
  const expectCleanedUp = () => {
    for (const entry of Object.values(events)) expect(entry.listeners.size).toBe(0);
    expect(cdpEvents.listeners.size).toBe(0);
  };
  return { manager, deps, state, send, events, main, cdpEvents, expectCleanedUp, tab };
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
    f.events.onBeforeNavigate.fire(f.main);
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
      f.events.onBeforeNavigate.fire(f.main);
      f.events.onErrorOccurred.fire({ ...f.main, error: "net::ERR_NAME_NOT_RESOLVED" });
    });
    const result = await handleNavigate(f.manager, { session_id: "test", url }, f.deps);
    expect(result).toMatchObject({ code: "cdp_failed", message: "net::ERR_NAME_NOT_RESOLVED" });
    f.expectCleanedUp();
  });
});

describe("restricted source navigation handoff", () => {
  it.each([
    "chrome://newtab/",
    "edge://newtab/",
  ])("leaves %s without CDP preflight or tab selection", async (source) => {
    const f = await fixture();
    f.tab.url = source;
    f.tab.active = false;
    const acquire = vi.fn(async () => {
      expect(f.state.blocked).toBe(false);
    });
    f.deps.cdp.acquireBackgroundExecution = acquire;
    const navigate = f.deps.browserNavigation.update.getMockImplementation()!;
    f.deps.browserNavigation.update.mockImplementation(async () => {
      expect(f.send).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      await navigate();
    });
    expect(await handleNavigate(f.manager, { session_id: "test", url }, f.deps)).toMatchObject({
      reached: "load",
    });
    expect(acquire).toHaveBeenCalledExactlyOnceWith("test", 4);
    expect(f.deps.browserNavigation.update).toHaveBeenCalledExactlyOnceWith(4, { url });
    expect(f.tab.active).toBe(false);
    f.expectCleanedUp();
  });

  it.each([
    "commit",
    "domcontentloaded",
    "load",
    "networkidle",
  ] as const)("prepares at commit before waiting for %s, including a pending browser action", async (wait_until) => {
    const f = await fixture();
    f.tab.url = "chrome://newtab/";
    let releaseAction!: () => void;
    f.deps.browserNavigation.update.mockImplementation(async () => {
      f.state.blocked = false;
      f.tab.url = url;
      f.events.onBeforeNavigate.fire(f.main);
      f.events.onCommitted.fire(f.main);
      await new Promise<void>((resolve) => {
        releaseAction = resolve;
      });
    });
    f.deps.cdp.acquireBackgroundExecution = vi.fn(async () => {
      // This simulates load blocked on rAF until execution is established.
      f.events.onDOMContentLoaded.fire(f.main);
      f.events.onCompleted.fire(f.main);
      releaseAction();
    });
    expect(
      await handleNavigate(f.manager, { session_id: "test", url, wait_until }, f.deps),
    ).toMatchObject({ reached: wait_until });
    expect(f.deps.cdp.acquireBackgroundExecution).toHaveBeenCalledOnce();
    f.expectCleanedUp();
  });

  it.each([
    handleReload,
    handleNavigateBack,
    handleNavigateForward,
  ])("recovers reload/history from a restricted source", async (handler) => {
    const f = await fixture();
    f.tab.url = "chrome://newtab/";
    f.tab.active = false;
    f.deps.cdp.acquireBackgroundExecution = vi.fn(async () => {});
    expect(await handler(f.manager, { session_id: "test" }, f.deps)).toMatchObject({
      reached: "load",
      previous_url: "chrome://newtab/",
    });
    const action =
      handler === handleReload
        ? f.deps.browserNavigation.reload
        : handler === handleNavigateBack
          ? f.deps.browserNavigation.goBack
          : f.deps.browserNavigation.goForward;
    expect(action).toHaveBeenCalledOnce();
    expect(f.deps.cdp.acquireBackgroundExecution).toHaveBeenCalledOnce();
    f.expectCleanedUp();
  });

  it("keeps a fast load pending until execution preparation completes", async () => {
    const f = await fixture();
    f.tab.url = "chrome://newtab/";
    let release!: () => void;
    f.deps.cdp.acquireBackgroundExecution = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let done = false;
    const work = handleNavigate(f.manager, { session_id: "test", url }, f.deps).then((r) => {
      done = true;
      return r;
    });
    await vi.waitFor(() => expect(f.deps.cdp.acquireBackgroundExecution).toHaveBeenCalledOnce());
    expect(done).toBe(false);
    release();
    expect(await work).toMatchObject({ reached: "load" });
    f.expectCleanedUp();
  });

  it("routes preparation access denial into recovery without replaying CDP navigation", async () => {
    const f = await fixture();
    f.deps.cdp.acquireBackgroundExecution = vi.fn(async () => {
      if (f.state.blocked) throw new Error(denied);
    });
    expect(await handleNavigate(f.manager, { session_id: "test", url }, f.deps)).toMatchObject({
      reached: "load",
    });
    expect(f.deps.cdp.acquireBackgroundExecution).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls.some(([, method]) => method === "Page.navigate")).toBe(false);
    f.expectCleanedUp();
  });

  it("cleans up on timeout while commit handoff is stalled", async () => {
    const f = await fixture();
    f.tab.url = "chrome://newtab/";
    let release!: () => void;
    f.deps.cdp.acquireBackgroundExecution = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const result = await handleNavigate(
      f.manager,
      { session_id: "test", url, timeout_ms: 20 },
      f.deps,
    );
    expect(result).toMatchObject({ reached: "timeout" });
    f.expectCleanedUp();
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("waits rather than acquiring for an obsolete commit without its successor event", async () => {
    const f = await fixture();
    f.tab.url = "chrome://newtab/";
    f.deps.browserNavigation.getFrame.mockResolvedValue({ documentId: "replacement" });
    f.deps.cdp.acquireBackgroundExecution = vi.fn(async () => {});
    expect(
      await handleNavigate(f.manager, { session_id: "test", url, timeout_ms: 20 }, f.deps),
    ).toMatchObject({
      reached: "timeout",
    });
    expect(f.deps.cdp.acquireBackgroundExecution).not.toHaveBeenCalled();
    f.expectCleanedUp();
  });
});

it("releases execution when control ends during commit preparation", async () => {
  const f = await fixture();
  f.tab.url = "chrome://newtab/";
  f.deps.cdp.releaseSessionTab = vi.fn(async () => {});
  f.deps.cdp.acquireBackgroundExecution = vi.fn(async () => {
    f.manager.get("test")!.agentCreatedTabs.clear();
  });
  expect(await handleNavigate(f.manager, { session_id: "test", url }, f.deps)).toMatchObject({
    code: "cancelled",
  });
  expect(f.deps.cdp.releaseSessionTab).toHaveBeenCalledExactlyOnceWith("test", 4);
  expect(f.send).not.toHaveBeenCalled();
  f.expectCleanedUp();
});

it("does not bypass unrelated execution preparation failures", async () => {
  const f = await fixture();
  f.deps.cdp.acquireBackgroundExecution = vi.fn(async () => {
    throw new Error("Another debugger is already attached");
  });
  expect(await handleNavigate(f.manager, { session_id: "test", url }, f.deps)).toMatchObject({
    code: "cdp_failed",
  });
  expect(f.deps.browserNavigation.update).not.toHaveBeenCalled();
  f.expectCleanedUp();
});

it("ignores the departing page's aborted load before the new navigation starts", async () => {
  const f = await fixture();
  f.tab.url = "chrome://newtab/";
  const navigate = f.deps.browserNavigation.update.getMockImplementation()!;
  f.deps.browserNavigation.update.mockImplementation(async () => {
    f.events.onErrorOccurred.fire({ tabId: 4, frameId: 0, error: "net::ERR_ABORTED" });
    await navigate();
  });
  expect(await handleNavigate(f.manager, { session_id: "test", url }, f.deps)).toMatchObject({
    reached: "load",
  });
  f.expectCleanedUp();
});

it("leaves recording callers' execution policy unchanged", async () => {
  const f = await fixture();
  f.state.blocked = false;
  f.deps.backgroundExecution = false;
  f.deps.cdp.acquireBackgroundExecution = vi.fn(async () => {});
  await handleNavigate(f.manager, { session_id: "test", url, timeout_ms: 1 }, f.deps);
  expect(f.deps.cdp.acquireBackgroundExecution).not.toHaveBeenCalled();
  expect(f.send.mock.calls.some(([, method]) => method === "Page.navigate")).toBe(true);
});

it.each([
  "",
  "about:blank",
])("routes a pending restricted source with URL %j through browser navigation", async (source) => {
  const f = await fixture();
  f.tab.url = source;
  f.tab.pendingUrl = "chrome://newtab/";
  f.deps.cdp.acquireBackgroundExecution = vi.fn(async () => {
    expect(f.deps.browserNavigation.update).toHaveBeenCalledOnce();
  });
  expect(await handleNavigate(f.manager, { session_id: "test", url }, f.deps)).toMatchObject({
    reached: "load",
  });
  expect(f.deps.cdp.acquireBackgroundExecution).toHaveBeenCalledOnce();
});

it.each([
  "before",
  "after",
])("ignores the unfinished source commit %s the requested navigation starts", async (order) => {
  const f = await fixture();
  f.tab.url = "chrome://newtab/";
  f.deps.cdp.acquireBackgroundExecution = vi.fn(async () => {
    expect(f.state.blocked).toBe(false);
  });
  f.deps.browserNavigation.update.mockImplementation(async () => {
    const old = { ...f.main, documentId: "late-source-document", url: "chrome://new-tab-page/" };
    if (order === "after") f.events.onBeforeNavigate.fire(f.main);
    f.events.onCommitted.fire(old);
    if (order === "before") f.events.onBeforeNavigate.fire(f.main);
    f.events.onErrorOccurred.fire({ ...old, error: "net::ERR_ABORTED" });
    f.state.blocked = false;
    f.tab.url = url;
    f.events.onCommitted.fire(f.main);
    f.events.onCompleted.fire(f.main);
  });
  expect(await handleNavigate(f.manager, { session_id: "test", url }, f.deps)).toMatchObject({
    reached: "load",
  });
  expect(f.deps.cdp.acquireBackgroundExecution).toHaveBeenCalledOnce();
  f.expectCleanedUp();
});

it("accepts the committed document after a server redirect", async () => {
  const f = await fixture();
  f.tab.url = "chrome://newtab/";
  f.deps.browserNavigation.update.mockImplementation(async () => {
    f.events.onBeforeNavigate.fire(f.main);
    f.state.blocked = false;
    f.tab.url = `${url}/redirected`;
    const redirected = { ...f.main, url: f.tab.url, transitionQualifiers: ["server_redirect"] };
    f.events.onCommitted.fire(redirected);
    f.events.onCompleted.fire(redirected);
  });
  expect(await handleNavigate(f.manager, { session_id: "test", url }, f.deps)).toMatchObject({
    reached: "load",
    final_url: `${url}/redirected`,
  });
  f.expectCleanedUp();
});

it("still reports an aborted requested navigation", async () => {
  const f = await fixture();
  f.tab.url = "chrome://newtab/";
  f.deps.browserNavigation.update.mockImplementation(async () => {
    f.events.onBeforeNavigate.fire(f.main);
    f.events.onErrorOccurred.fire({ ...f.main, error: "net::ERR_ABORTED" });
  });
  expect(await handleNavigate(f.manager, { session_id: "test", url }, f.deps)).toMatchObject({
    code: "cdp_failed",
    message: "net::ERR_ABORTED",
  });
  f.expectCleanedUp();
});

it("follows a successor while ignoring a rejected obsolete handoff", async () => {
  const f = await fixture();
  f.tab.url = "chrome://newtab/";
  let current = "old";
  f.deps.browserNavigation.getFrame
    .mockReset()
    .mockImplementation(async () => ({ documentId: current }));
  const first = { ...f.main, documentId: "first" };
  const second = { ...f.main, documentId: "second", url: `${url}/second` };
  let rejectFirst!: (error: Error) => void;
  f.deps.cdp.acquireBackgroundExecution = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    )
    .mockResolvedValue(undefined);
  f.deps.browserNavigation.update.mockImplementation(async () => {
    f.state.blocked = false;
    f.tab.url = url;
    current = first.documentId;
    f.events.onBeforeNavigate.fire(first);
    f.events.onCommitted.fire(first);
  });
  const work = handleNavigate(f.manager, { session_id: "test", url }, f.deps);
  await vi.waitFor(() => expect(rejectFirst).toBeDefined());
  f.events.onBeforeNavigate.fire(second);
  current = second.documentId;
  f.tab.url = second.url;
  f.events.onCommitted.fire(second);
  f.events.onErrorOccurred.fire({ ...first, error: "net::ERR_ABORTED" });
  f.events.onCompleted.fire(first);
  rejectFirst(new Error("old attachment disappeared"));
  f.events.onCompleted.fire(second);
  expect(await work).toMatchObject({ reached: "load", final_url: second.url });
  expect(f.deps.cdp.acquireBackgroundExecution).toHaveBeenCalledTimes(2);
  f.expectCleanedUp();
});

it("keeps native succession active throughout network-idle waiting", async () => {
  const f = await fixture();
  f.tab.url = "chrome://newtab/";
  f.state.emitIdle = false;
  let current = "old";
  f.deps.browserNavigation.getFrame
    .mockReset()
    .mockImplementation(async () => ({ documentId: current }));
  const send = f.send.getMockImplementation()!;
  f.send.mockImplementation(async (tabId, method) =>
    method === "Page.getFrameTree"
      ? { frameTree: { frame: { id: "main", loaderId: current } } }
      : send(tabId, method),
  );
  const first = { ...f.main, documentId: "first" };
  const second = { ...f.main, documentId: "second", url: `${url}/second` };
  f.deps.browserNavigation.update.mockImplementation(async () => {
    f.state.blocked = false;
    f.tab.url = url;
    current = first.documentId;
    f.events.onBeforeNavigate.fire(first);
    f.events.onCommitted.fire(first);
  });
  let settled = false;
  const work = handleNavigate(
    f.manager,
    { session_id: "test", url, wait_until: "networkidle" },
    f.deps,
  ).then((result) => {
    settled = true;
    return result;
  });
  await vi.waitFor(() => expect(f.cdpEvents.listeners.size).toBe(1));
  f.events.onBeforeNavigate.fire(second);
  current = second.documentId;
  f.tab.url = second.url;
  f.events.onCommitted.fire(second);
  await vi.waitFor(() =>
    expect(
      f.send.mock.calls.filter(([, method]) => method === "Page.setLifecycleEventsEnabled"),
    ).toHaveLength(2),
  );
  f.cdpEvents.fire({ tabId: 4 }, "Page.lifecycleEvent", {
    frameId: "main",
    loaderId: "first",
    name: "networkIdle",
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  f.cdpEvents.fire({ tabId: 4 }, "Page.lifecycleEvent", {
    frameId: "main",
    loaderId: "second",
    name: "networkIdle",
  });
  expect(await work).toMatchObject({ reached: "networkidle", final_url: second.url });
  f.expectCleanedUp();
});

it("keeps one deadline across multiple document handoffs", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  try {
    const work = navigateWithBrowserApi(
      f.deps.browserNavigation,
      4,
      () => f.deps.browserNavigation.update(),
      "load",
      60,
      undefined,
      () => new Promise<void>(() => {}),
      url,
    );
    await vi.advanceTimersByTimeAsync(40);
    const second = { ...f.main, documentId: "second", url: `${url}/second` };
    f.events.onBeforeNavigate.fire(second);
    f.events.onCommitted.fire(second);
    f.events.onCompleted.fire(second);
    await vi.advanceTimersByTimeAsync(20);
    expect(await work).toMatchObject({ reached: "timeout" });
    f.expectCleanedUp();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  "abort",
  "fragment",
  "history",
] as const)("resumes the committed document after a successor ends without commit (%s)", async (kind) => {
  const f = await fixture();
  let settled = false;
  const attempt = { ...f.main, documentId: undefined, url: `${url}/cancelled` };
  const work = navigateWithBrowserApi(
    f.deps.browserNavigation,
    4,
    async () => {
      f.events.onBeforeNavigate.fire(f.main);
      f.events.onCommitted.fire(f.main);
      f.events.onBeforeNavigate.fire(attempt);
      f.events.onCompleted.fire(f.main);
    },
    "load",
    1000,
  ).then((result) => {
    settled = true;
    return result;
  });
  await vi.waitFor(() => expect(f.deps.browserNavigation.getFrame).toHaveBeenCalledOnce());
  await Promise.resolve();
  expect(settled).toBe(false);
  if (kind === "abort") f.events.onErrorOccurred.fire({ ...attempt, error: "net::ERR_ABORTED" });
  else if (kind === "fragment") f.events.onReferenceFragmentUpdated.fire(f.main);
  else f.events.onHistoryStateUpdated.fire(f.main);
  expect(await work).toMatchObject({ reached: "match", lastLifecycle: "load" });
  f.expectCleanedUp();
});

it("does not let a late cancellation probe complete a successor document", async () => {
  const f = await fixture();
  let resolveFrame!: (value: { documentId: string }) => void;
  f.deps.browserNavigation.getFrame
    .mockReset()
    .mockImplementationOnce(async () => ({ documentId: "old-document" }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFrame = resolve;
        }),
    );
  const attempt = { ...f.main, documentId: undefined, url: `${url}/attempt` };
  let settled = false;
  const work = navigateWithBrowserApi(
    f.deps.browserNavigation,
    4,
    async () => {
      f.events.onBeforeNavigate.fire(f.main);
      f.events.onCommitted.fire(f.main);
      f.events.onBeforeNavigate.fire(attempt);
      f.events.onCompleted.fire(f.main);
      f.events.onErrorOccurred.fire({ ...attempt, error: "net::ERR_ABORTED" });
    },
    "load",
    1000,
  ).then((result) => {
    settled = true;
    return result;
  });
  await vi.waitFor(() => expect(resolveFrame).toBeDefined());
  const next = { ...f.main, documentId: "successor", url: `${url}/successor` };
  f.events.onBeforeNavigate.fire(next);
  f.events.onCommitted.fire(next);
  resolveFrame({ documentId: f.main.documentId });
  f.events.onCompleted.fire(f.main);
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  f.events.onCompleted.fire(next);
  expect(await work).toMatchObject({ reached: "match", url: next.url });
  f.expectCleanedUp();
});
