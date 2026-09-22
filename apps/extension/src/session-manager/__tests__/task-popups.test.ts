import { afterEach, expect, it, vi } from "vitest";
import { handleSessionStop } from "@/tools/session";
import { handleTabBorrow, type TabManagementDeps } from "@/tools/tabs";
import { isAgentControlledTab, SessionManager } from "../manager";
import { withTaskPopups } from "../task-popups";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function event<T extends (...args: never[]) => void>() {
  const listeners = new Set<T>();
  return {
    listeners,
    addListener: (fn: T) => listeners.add(fn),
    removeListener: (fn: T) => listeners.delete(fn),
  };
}
async function fixture(remote = true) {
  vi.useFakeTimers();
  let next = 10;
  const removeWindow = vi.fn(async () => {});
  const manager = new SessionManager({
    remote: () => remote,
    agentWindow: {
      create: async () => ({ windowId: next++, initialTabIds: [] }),
      remove: removeWindow,
      ensureActiveTab: async (id) => id,
    },
  });
  const task = await manager.start("one"),
    other = await manager.start("two");
  const tabs = new Map<number, chrome.tabs.Tab>([
    [10, { id: 10, windowId: 10, active: true } as chrome.tabs.Tab],
    [11, { id: 11, windowId: 11, active: true } as chrome.tabs.Tab],
  ]);
  const targets =
    event<(e: { sourceTabId: number; sourceFrameId: number; tabId: number }) => void>();
  const removed = event<(id: number) => void>(),
    detached = event<(id: number) => void>();
  const opened = event<() => void>();
  const api = {
    get: vi.fn(async (id: number) => {
      const t = tabs.get(id);
      if (!t) throw new Error("missing tab");
      return { ...t };
    }),
    query: vi.fn(async (q: { windowId?: number }) =>
      [...tabs.values()].filter((t) => q.windowId === undefined || t.windowId === q.windowId),
    ),
    update: vi.fn(async (id: number, props: object) => Object.assign(tabs.get(id)!, props)),
    move: vi.fn(async (id: number, props: { windowId: number }) =>
      Object.assign(tabs.get(id)!, props),
    ),
    remove: vi.fn(async (id: number) => {
      tabs.delete(id);
    }),
    create: vi.fn(),
    onCreated: opened,
    onRemoved: removed,
    onDetached: detached,
  };
  vi.stubGlobal("chrome", { tabs: api, webNavigation: { onCreatedNavigationTarget: targets } });
  const open = (sourceTabId: number, tabId: number, windowId = 10, sourceFrameId = 0) => {
    tabs.set(tabId, { id: tabId, windowId } as chrome.tabs.Tab);
    for (const fn of opened.listeners) fn();
    for (const fn of targets.listeners) fn({ sourceTabId, sourceFrameId, tabId });
  };
  const deps = {
    tabs: api,
    windows: {
      get: vi.fn(async (id: number) => ({ id })),
      getLastFocused: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
    },
    agentOverlayReset: { resetAgentOverlays: vi.fn(async () => {}) },
    approveBorrow: vi.fn(async () => true),
  } as unknown as TabManagementDeps;
  return {
    manager,
    task,
    other,
    tabs,
    api,
    targets,
    removed,
    detached,
    opened,
    open,
    deps,
    removeWindow,
  };
}

it.each([
  false,
  true,
])("controls same-window and nested targets without destructive ownership, remote=%s", async (remote) => {
  const f = await fixture(remote);
  const work = withTaskPopups(f.manager, { session_id: "one" }, async (input) => {
    input(10);
    f.open(10, 20);
    f.open(20, 21);
  });
  await vi.advanceTimersByTimeAsync(100);
  await work;
  expect(f.task.observedTabs).toEqual(new Set([20, 21]));
  expect(f.task.agentCreatedTabs).toEqual(new Set([10]));
  expect(isAgentControlledTab(f.task, 20)).toBe(true);
  expect(f.api.move).not.toHaveBeenCalled();
  expect(f.targets.listeners.size + f.removed.listeners.size + f.detached.listeners.size).toBe(0);
});

it("preserves observed tabs and their window during actual session stop", async () => {
  const f = await fixture();
  const work = withTaskPopups(f.manager, { session_id: "one" }, async (input) => {
    input(10);
    f.open(10, 20);
  });
  await vi.advanceTimersByTimeAsync(100);
  await work;
  const result = await handleSessionStop(
    f.manager,
    { session_id: "one" },
    { tabManagement: f.deps, tabsQuery: f.api },
  );
  expect(result).toMatchObject({ window_released: true });
  expect(f.api.remove).toHaveBeenCalledWith(10);
  expect(f.api.remove).not.toHaveBeenCalledWith(20);
  expect(f.removeWindow).not.toHaveBeenCalled();
  expect(f.tabs.has(20)).toBe(true);
});

it("does not monitor action preparation or long work without native input", async () => {
  const f = await fixture();
  const work = withTaskPopups(f.manager, { session_id: "one" }, async (input) => {
    f.open(10, 20);
    await vi.advanceTimersByTimeAsync(30000);
    f.open(10, 21);
    input(10);
    f.open(10, 22);
  });
  await vi.advanceTimersByTimeAsync(100);
  await work;
  expect(f.task.observedTabs).toEqual(new Set([22]));
});

it("does not extend the input window or add a tail for unrelated tab creation", async () => {
  const f = await fixture();
  const work = withTaskPopups(f.manager, { session_id: "one" }, async (input) => {
    input(10);
    f.open(11, 30, 500);
    await vi.advanceTimersByTimeAsync(101);
    f.open(10, 20);
  });
  await vi.advanceTimersByTimeAsync(100);
  await work;
  expect(f.task.observedTabs?.size ?? 0).toBe(0);
  expect(f.opened.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("leaves cross-window popups unclaimed, borrowable and safe from the original task's stop", async () => {
  const f = await fixture();
  f.api.move.mockRejectedValueOnce(new Error("Window busy"));
  const work = withTaskPopups(f.manager, { session_id: "one" }, async (input) => {
    input(10);
    f.open(10, 20, 500);
    f.open(20, 21);
  });
  await vi.advanceTimersByTimeAsync(100);
  await work;
  expect(f.api.move).not.toHaveBeenCalled();
  expect(isAgentControlledTab(f.task, 20)).toBe(false);
  expect(isAgentControlledTab(f.task, 21)).toBe(false);
  f.api.move
    .mockReset()
    .mockImplementation(async (id, props) => Object.assign(f.tabs.get(id)!, props));
  expect(await handleTabBorrow(f.manager, { session_id: "two", tab_id: 20 }, f.deps)).toMatchObject(
    { tab_id: 20 },
  );
  await handleSessionStop(
    f.manager,
    { session_id: "one" },
    { tabManagement: f.deps, tabsQuery: f.api },
  );
  expect(f.api.remove).not.toHaveBeenCalledWith(20);
  expect(f.tabs.get(20)?.windowId).toBe(11);
});

it("requires a main-frame source event and rejects another task's source", async () => {
  const f = await fixture();
  const work = withTaskPopups(f.manager, { session_id: "one" }, async (input) => {
    input(10);
    f.open(10, 20, 10, 4);
    f.open(11, 21);
  });
  await vi.advanceTimersByTimeAsync(100);
  await work;
  expect(f.task.observedTabs?.size ?? 0).toBe(0);
});

it.each([
  "removed",
  "detached",
  "revoked",
  "moved",
])("invalidates a source that is %s during tracking", async (kind) => {
  const f = await fixture();
  const work = withTaskPopups(f.manager, { session_id: "one" }, async (input) => {
    input(10);
    if (kind === "removed" || kind === "detached") for (const fn of f[kind].listeners) fn(10);
    if (kind === "revoked") f.task.agentCreatedTabs.delete(10);
    if (kind === "moved") f.tabs.get(10)!.windowId = 500;
    f.open(10, 20);
  });
  await vi.advanceTimersByTimeAsync(100);
  await work;
  expect(f.task.observedTabs?.size ?? 0).toBe(0);
});

it("bounds candidate queries and prevents late claims after the RPC result", async () => {
  const f = await fixture();
  const gate = deferred<chrome.tabs.Tab>();
  const get = f.api.get.getMockImplementation()!;
  f.api.get.mockImplementation((id) => (id === 20 ? gate.promise : get(id)));
  const work = withTaskPopups(f.manager, { session_id: "one" }, async (input) => {
    input(10);
    f.open(10, 20);
    return 42;
  });
  await vi.advanceTimersByTimeAsync(600);
  expect(await work).toBe(42);
  gate.resolve({ id: 20, windowId: 10 } as chrome.tabs.Tab);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.task.observedTabs?.size ?? 0).toBe(0);
  expect(f.targets.listeners.size + f.removed.listeners.size + f.detached.listeners.size).toBe(0);
});

it("removes every listener immediately on abort, even before the tool settles", async () => {
  const f = await fixture(),
    action = deferred<void>(),
    controller = new AbortController();
  const work = withTaskPopups(
    f.manager,
    { session_id: "one" },
    async (input) => {
      input(10);
      await action.promise;
    },
    undefined,
    controller.signal,
  );
  expect(f.targets.listeners.size).toBe(1);
  controller.abort();
  expect(f.targets.listeners.size + f.removed.listeners.size + f.detached.listeners.size).toBe(0);
  f.open(10, 20);
  action.resolve();
  await work;
  expect(isAgentControlledTab(f.task, 20)).toBe(false);
});

it.each([
  "cancel",
  "other claim",
  "reservation",
  "target detached",
])("revalidates after lookup: %s", async (change) => {
  const f = await fixture(),
    controller = new AbortController(),
    gate = deferred<chrome.tabs.Tab>();
  const get = f.api.get.getMockImplementation()!;
  f.api.get.mockImplementation((id) => (id === 20 ? gate.promise : get(id)));
  const work = withTaskPopups(
    f.manager,
    { session_id: "one" },
    async (input) => {
      input(10);
      f.open(10, 20);
    },
    undefined,
    controller.signal,
  );
  await vi.advanceTimersByTimeAsync(0);
  if (change === "cancel") controller.abort();
  if (change === "other claim") f.other.agentCreatedTabs.add(20);
  if (change === "reservation") f.manager.tryReserveBorrow(20, "two");
  if (change === "target detached") for (const fn of f.detached.listeners) fn(20);
  gate.resolve({ id: 20, windowId: 10 } as chrome.tabs.Tab);
  await vi.advanceTimersByTimeAsync(100);
  await work;
  expect(f.task.observedTabs?.has(20) ?? false).toBe(false);
});

it("rejects duplicate borrowing of created and observed targets across sessions", async () => {
  const f = await fixture();
  f.tabs.set(20, { id: 20, windowId: 500 } as chrome.tabs.Tab);
  f.task.agentCreatedTabs.add(20);
  for (const session_id of ["one", "two"])
    expect(await handleTabBorrow(f.manager, { session_id, tab_id: 20 }, f.deps)).toMatchObject({
      code: "permission_denied",
    });
  f.task.agentCreatedTabs.delete(20);
  f.task.observedTabs = new Set([20]);
  expect(await handleTabBorrow(f.manager, { session_id: "two", tab_id: 20 }, f.deps)).toMatchObject(
    { code: "permission_denied" },
  );
  expect(f.api.move).not.toHaveBeenCalled();
  expect(f.manager.releaseObservedTab(20)).toEqual(["one"]);
  expect(isAgentControlledTab(f.task, 20)).toBe(false);
});

it("observes late events until 100ms after the last input without extending for events", async () => {
  const f = await fixture();
  let actionReturned = false;
  let settled = false;
  const work = withTaskPopups(f.manager, { session_id: "one" }, async (input) => {
    input(10);
    await vi.advanceTimersByTimeAsync(40);
    input(10);
    actionReturned = true;
    return 42;
  }).then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(actionReturned).toBe(true);
  await vi.advanceTimersByTimeAsync(50);
  f.open(10, 20);
  f.open(11, 30, 500);
  await vi.advanceTimersByTimeAsync(49);
  expect(settled).toBe(false);
  expect(f.task.observedTabs).toEqual(new Set([20]));
  await vi.advanceTimersByTimeAsync(1);
  expect(await work).toBe(42);
  f.open(10, 21);
  expect(isAgentControlledTab(f.task, 21)).toBe(false);
  expect(f.targets.listeners.size + f.removed.listeners.size + f.detached.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not add a tail when no input was sent", async () => {
  const f = await fixture();
  expect(await withTaskPopups(f.manager, { session_id: "one" }, async () => 42)).toBe(42);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels the remaining input interval after the action returns", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const work = withTaskPopups(
    f.manager,
    { session_id: "one" },
    async (input) => {
      input(10);
      return 42;
    },
    undefined,
    controller.signal,
  );
  await vi.advanceTimersByTimeAsync(50);
  controller.abort();
  expect(await work).toBe(42);
  f.open(10, 20);
  expect(isAgentControlledTab(f.task, 20)).toBe(false);
  expect(f.targets.listeners.size + f.removed.listeners.size + f.detached.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves observed tabs and their window when the final tab query fails", async () => {
  const f = await fixture();
  const work = withTaskPopups(f.manager, { session_id: "one" }, async (input) => {
    input(10);
    f.open(10, 20);
  });
  await vi.advanceTimersByTimeAsync(100);
  await work;
  f.api.query.mockRejectedValueOnce(new Error("temporary Chrome query failure"));
  const result = await handleSessionStop(
    f.manager,
    { session_id: "one" },
    {
      tabManagement: f.deps,
      tabsQuery: f.api,
    },
  );
  expect(result).toMatchObject({ window_released: true });
  expect(f.removeWindow).not.toHaveBeenCalled();
  expect(f.api.remove).toHaveBeenCalledWith(10);
  expect(f.api.remove).not.toHaveBeenCalledWith(20);
  expect(f.tabs.has(20)).toBe(true);
  expect(f.manager.get("one")).toBeNull();
});
