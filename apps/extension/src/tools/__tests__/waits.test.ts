import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import { handleWaitForElement, handleWaitForNavigation, satisfiesState } from "../waits";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  return {
    create: vi.fn(async () => {
      const id = ids[i++];
      if (id === undefined) throw new Error("ran out of fake ids");
      return { windowId: id, initialTabIds: [] };
    }),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => 1),
  };
}

interface EventListener {
  (source: chrome.debugger.Debuggee, method: string, params: unknown): void;
}

function makeFakeCdp(
  opts: {
    windowId?: number;
    mainFrameId?: string;
    readyState?: string | null;
    /**
     * Extra method handlers, consulted before the built-ins. `wait_for`
     * probes call `DOM.*` / `Runtime.callFunctionOn`, none of which the
     * built-in set below covers.
     */
    handlers?: Record<string, (params: unknown) => unknown>;
  } = {},
) {
  const events: EventListener[] = [];
  const sent: Array<{ tabId: number; method: string; params?: object }> = [];
  const sendImpl = async (tabId: number, method: string, params?: object) => {
    sent.push({ tabId, method, params });
    const extra = opts.handlers?.[method];
    if (extra) return extra(params);
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

/** A session whose `@e1` ref points at backendNodeId 555 on tab 4. */
async function sessionWithRef() {
  const manager = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
  const ctx = await manager.start("aa11");
  ctx.refStore.set("e1", 555, { tabId: 4 });
  return manager;
}

/** Probe replies: `DOM.resolveNode` succeeds, `callFunctionOn` reports `state`. */
function probeHandlers(state: { attached: boolean; visible: boolean }) {
  return {
    "DOM.resolveNode": () => ({ object: { objectId: "obj-1" } }),
    "Runtime.callFunctionOn": () => ({ result: { value: state } }),
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

describe("satisfiesState", () => {
  it("treats hidden as the opposite of visible while preserving presence", () => {
    // 存在 + 可见
    expect(satisfiesState("visible", true, true)).toBe(true);
    expect(satisfiesState("hidden", true, true)).toBe(false);
    expect(satisfiesState("attached", true, true)).toBe(true);
    expect(satisfiesState("detached", true, true)).toBe(false);
    // 存在但不可见
    expect(satisfiesState("visible", true, false)).toBe(false);
    expect(satisfiesState("hidden", true, false)).toBe(true);
    expect(satisfiesState("attached", true, false)).toBe(true);
    expect(satisfiesState("detached", true, false)).toBe(false);
    // Absence satisfies hidden and detached; attached still distinguishes removal.
    expect(satisfiesState("visible", false, false)).toBe(false);
    expect(satisfiesState("hidden", false, false)).toBe(true);
    expect(satisfiesState("attached", false, false)).toBe(false);
    expect(satisfiesState("detached", false, false)).toBe(true);
  });
});

describe("handleWaitForElement argument validation", () => {
  it("requires exactly one of ref / selector", async () => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp();
    for (const params of [
      { session_id: "aa11", state: "visible" as const },
      { session_id: "aa11", state: "visible" as const, ref: "@e1", selector: "#a" },
      { session_id: "aa11", state: "visible" as const, ref: "  " },
      { session_id: "aa11", state: "visible" as const, selector: "" },
    ]) {
      const res = await handleWaitForElement(manager, params, {
        cdp: fake.cdp,
        tabsApi: fake.tabsApi,
      });
      expect(res).toMatchObject({ code: "invalid_params" });
    }
    // 一个 CDP 调用都不该发生：这些是本地就能判死的用法错误。
    expect(fake.sent).toHaveLength(0);
  });

  it("rejects an unknown state and out-of-range budgets", async () => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp();
    const base = { session_id: "aa11", ref: "@e1" };
    for (const params of [
      { ...base, state: "clickable" as never },
      { ...base, state: "visible" as const, timeout_ms: 0 },
      { ...base, state: "visible" as const, timeout_ms: 300_001 },
      { ...base, state: "visible" as const, poll_ms: 0 },
      { ...base, state: "visible" as const, poll_ms: 5 },
      { ...base, state: "visible" as const, poll_ms: 5_000 },
    ]) {
      const res = await handleWaitForElement(manager, params, {
        cdp: fake.cdp,
        tabsApi: fake.tabsApi,
      });
      expect(res).toMatchObject({ code: "invalid_params" });
    }
    expect(fake.sent).toHaveLength(0);
  });
});

describe("handleWaitForElement outcomes", () => {
  it("returns as soon as the state holds (visible)", async () => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp({ handlers: probeHandlers({ attached: true, visible: true }) });
    const res = await handleWaitForElement(
      manager,
      { session_id: "aa11", ref: "@e1", state: "visible", timeout_ms: 5_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({
      tab_id: 4,
      satisfied: true,
      attached: true,
      visible: true,
      // 线上是不带 `@` 的裸编号（CLI 的 `format_used_target` 负责补），
      // 回显 `@e1` 会让 CLI 打成 `@@e1`。
      used_ref: "e1",
    });
    // 命中一次就返回，不该再探第二次。
    expect(fake.sent.filter((c) => c.method === "Runtime.callFunctionOn")).toHaveLength(1);
  });

  it("reports the evidence when it times out, not an error", async () => {
    const manager = await sessionWithRef();
    // 一直都在、一直不可见：等 `visible` 必然超时，但「在但不可见」这条
    // 证据要能带回去 —— 它区分「还没出现」与「出来但没显形」。
    const fake = makeFakeCdp({ handlers: probeHandlers({ attached: true, visible: false }) });
    const res = await handleWaitForElement(
      manager,
      { session_id: "aa11", ref: "@e1", state: "visible", timeout_ms: 60, poll_ms: 16 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({
      tab_id: 4,
      satisfied: false,
      attached: true,
      visible: false,
      used_ref: "e1",
    });
    expect((res as { elapsed_ms: number }).elapsed_ms).toBeGreaterThanOrEqual(50);
    // 轮询确实跑了好几轮，而不是超时后补一次假探测。
    expect(fake.sent.filter((c) => c.method === "Runtime.callFunctionOn").length).toBeGreaterThan(
      1,
    );
  });

  it.each(["hidden", "detached"] as const)("an unmatched selector satisfies %s", async (state) => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp({
      handlers: {
        "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
        "DOM.querySelector": () => ({ nodeId: 0 }),
      },
    });
    const res = await handleWaitForElement(
      manager,
      { session_id: "aa11", selector: ".el-loading-mask", state, timeout_ms: 5_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({
      tab_id: 4,
      satisfied: true,
      attached: false,
      visible: false,
      used_selector: ".el-loading-mask",
    });
  });

  it("propagates a real CDP fault instead of calling it detached", async () => {
    const manager = await sessionWithRef();
    // `DOM.getDocument` 没有 root：这是故障，不是「元素不在」。
    // 把它折成 attached=false 会让一次坏掉的探测伪装成「元素确实消失了」。
    const fake = makeFakeCdp({ handlers: { "DOM.getDocument": () => ({ root: {} }) } });
    const res = await handleWaitForElement(
      manager,
      { session_id: "aa11", selector: "#mask", state: "detached", timeout_ms: 5_000 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ code: "cdp_failed" });
  });

  it("releases the object group it allocated", async () => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp({
      handlers: {
        ...probeHandlers({ attached: true, visible: false }),
        "Runtime.releaseObjectGroup": () => ({}),
      },
    });
    await handleWaitForElement(
      manager,
      { session_id: "aa11", ref: "@e1", state: "visible", timeout_ms: 20, poll_ms: 16 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(fake.sent.some((c) => c.method === "Runtime.releaseObjectGroup")).toBe(true);
  });
});

describe("wait-for-element regression coverage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const params = { session_id: "aa11", ref: "@e1", state: "detached" as const, timeout_ms: 100 };

  it.each([
    { ref: "@e999", state: "detached" as const },
    { ref: "@e999", state: "hidden" as const },
    { ref: "@e1", tab_id: 7, state: "detached" as const },
    { ref: "@e1", tab_id: 7, state: "hidden" as const },
  ])("preserves ref_not_found for %j", async (target) => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp();
    expect(await handleWaitForElement(manager, { ...params, ...target }, fake)).toMatchObject({
      code: "not_found",
      data: { reason: "ref_not_found" },
    });
    expect(fake.sent).toHaveLength(0);
  });

  it.each([
    "Debugger is not attached to the tab with id: 4.",
    "Session with given id not found.",
    "Cannot access a chrome-extension:// URL of different extension",
    "Cannot find context with specified id",
  ])("propagates resolveNode failure: %s", async (message) => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp({
      handlers: {
        "DOM.resolveNode": () => {
          throw new Error(message);
        },
      },
    });
    for (const state of ["detached", "hidden"] as const) {
      expect(await handleWaitForElement(manager, { ...params, state }, fake)).toMatchObject({
        code: "cdp_failed",
        message,
      });
    }
  });

  it.each([
    "No node with given id found",
    JSON.stringify({ code: -32000, message: "No node with given id found" }),
  ])("accepts confirmed removal and retains the target: %s", async (message) => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp({
      handlers: {
        "DOM.resolveNode": () => {
          throw new Error(message);
        },
      },
    });
    for (const state of ["detached", "hidden"] as const) {
      expect(await handleWaitForElement(manager, { ...params, state }, fake)).toMatchObject({
        satisfied: true,
        attached: false,
        visible: false,
        used_ref: "e1",
      });
    }
  });

  it.each(["detached", "hidden"] as const)("node removal satisfies %s", async (requestedState) => {
    const manager = await sessionWithRef();
    const state = { attached: true, visible: true };
    const fake = makeFakeCdp({ handlers: probeHandlers(state) });
    setTimeout(() => {
      state.attached = false;
      state.visible = false;
    }, 50);
    const pending = handleWaitForElement(
      manager,
      { ...params, state: requestedState, poll_ms: 100 },
      fake,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({
      satisfied: true,
      attached: false,
      visible: false,
      used_ref: "e1",
    });
  });

  it.each([
    "detached",
    "hidden",
  ] as const)("%s preserves ref invalidation after a successful probe", async (state) => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp({ handlers: probeHandlers({ attached: true, visible: true }) });
    const pending = handleWaitForElement(manager, { ...params, state }, fake);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.sent.filter((c) => c.method === "Runtime.callFunctionOn")).toHaveLength(1);
    // Navigation and debugger detachment both invalidate refs. Invalidation
    // alone cannot prove removal, even when a previous probe found the node.
    manager.invalidateTabRefs(4);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({
      code: "not_found",
      data: { reason: "ref_not_found" },
    });
    expect(fake.sent.filter((c) => c.method === "Runtime.callFunctionOn")).toHaveLength(1);
  });

  it.each([
    "detached",
    "hidden",
  ] as const)("%s preserves a child-frame session failure after a successful probe", async (state) => {
    const manager = await sessionWithRef();
    manager.get("aa11")?.refStore.set("e1", 555, { tabId: 4, cdpSessionId: "child-frame" });
    const fake = makeFakeCdp();
    const handlers = probeHandlers({ attached: true, visible: true });
    let detached = false;
    const message = "Session with given id not found.";
    const sendToTarget = vi.fn(async (_target, method: string) => {
      if (detached) throw new Error(message);
      return handlers[method as keyof typeof handlers]?.() ?? {};
    });
    fake.cdp.sendToTarget = sendToTarget as CdpRunner["sendToTarget"];
    const pending = handleWaitForElement(manager, { ...params, state }, fake);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendToTarget).toHaveBeenCalledWith(
      { tabId: 4, sessionId: "child-frame" },
      "Runtime.callFunctionOn",
      expect.any(Object),
    );
    detached = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ code: "cdp_failed", message });
    expect(fake.sent).toHaveLength(0);
  });

  it.each([
    { method: "DOM.resolveNode", reply: {} },
    { method: "Runtime.callFunctionOn", reply: { result: { value: { attached: true } } } },
    {
      method: "Runtime.callFunctionOn",
      reply: { result: { value: { attached: false, visible: true } } },
    },
    { method: "Runtime.callFunctionOn", reply: { exceptionDetails: { text: "probe threw" } } },
  ])("rejects malformed replies from $method", async ({ method, reply }) => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp({
      handlers: { ...probeHandlers({ attached: false, visible: false }), [method]: () => reply },
    });
    expect(await handleWaitForElement(manager, params, fake)).toMatchObject({ code: "cdp_failed" });
  });

  it("reserves a probe when timeout and poll are both 100ms", async () => {
    const manager = await sessionWithRef();
    const state = { attached: true, visible: false };
    const fake = makeFakeCdp({ handlers: probeHandlers(state) });
    setTimeout(() => {
      state.visible = true;
    }, 50);
    const pending = handleWaitForElement(
      manager,
      { ...params, state: "visible", poll_ms: 100 },
      fake,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ satisfied: true, visible: true, elapsed_ms: 50 });
  });

  it.each([
    "DOM.getDocument",
    "DOM.querySelector",
    "DOM.describeNode",
    "DOM.resolveNode",
    "Runtime.callFunctionOn",
  ])("bounds a slow %s and never continues a retired probe", async (method) => {
    const manager = await sessionWithRef();
    const handlers = {
      ...probeHandlers({ attached: true, visible: true }),
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "DOM.querySelector": () => ({ nodeId: 2 }),
      "DOM.describeNode": () => ({ node: { backendNodeId: 555 } }),
      "Runtime.releaseObjectGroup": () => ({}),
    };
    const reply = handlers[method as keyof typeof handlers]();
    const fake = makeFakeCdp({
      handlers: {
        ...handlers,
        [method]: () => new Promise((resolve) => setTimeout(() => resolve(reply), 500)),
      },
    });
    const pending = handleWaitForElement(
      manager,
      { session_id: "aa11", selector: "#result", state: "visible", timeout_ms: 100 },
      fake,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({
      satisfied: false,
      attached: null,
      visible: null,
      elapsed_ms: 100,
      used_selector: "#result",
    });
    const reads = () => fake.sent.filter((c) => c.method !== "Runtime.releaseObjectGroup");
    const count = reads().length;
    await vi.advanceTimersByTimeAsync(500);
    expect(reads()).toHaveLength(count);
    if (method === "DOM.resolveNode") {
      expect(fake.sent.filter((c) => c.method === "Runtime.releaseObjectGroup")).toHaveLength(2);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the last completed observation when a later probe overruns", async () => {
    const manager = await sessionWithRef();
    let probes = 0;
    const fake = makeFakeCdp({
      handlers: {
        ...probeHandlers({ attached: true, visible: false }),
        "Runtime.callFunctionOn": () =>
          ++probes === 1
            ? { result: { value: { attached: true, visible: false } } }
            : new Promise((resolve) =>
                setTimeout(
                  () => resolve({ result: { value: { attached: true, visible: true } } }),
                  500,
                ),
              ),
      },
    });
    const pending = handleWaitForElement(
      manager,
      { ...params, state: "visible", poll_ms: 16 },
      fake,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({
      satisfied: false,
      attached: true,
      visible: false,
      elapsed_ms: 100,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(probes).toBe(2);
  });

  it("rejects a late success even when the deadline timer has not run", async () => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp({
      handlers: {
        ...probeHandlers({ attached: true, visible: true }),
        "Runtime.callFunctionOn": () => {
          vi.advanceTimersByTime(500);
          return { result: { value: { attached: true, visible: true } } };
        },
      },
    });
    expect(
      await handleWaitForElement(manager, { ...params, state: "visible" }, fake),
    ).toMatchObject({
      satisfied: false,
      attached: null,
      visible: null,
      elapsed_ms: 500,
    });
  });

  it.each([
    "before",
    "sleep",
    "DOM.resolveNode",
    "Runtime.callFunctionOn",
  ])("cancels during %s", async (phase) => {
    const manager = await sessionWithRef();
    const abort = new AbortController();
    const fake = makeFakeCdp({
      handlers: {
        ...probeHandlers({ attached: true, visible: false }),
        ...(phase.startsWith("DOM.") || phase.startsWith("Runtime.")
          ? {
              [phase]: () =>
                new Promise((resolve) =>
                  setTimeout(() => resolve({ object: { objectId: "late" } }), 500),
                ),
            }
          : {}),
      },
    });
    if (phase === "before") abort.abort();
    const pending = handleWaitForElement(
      manager,
      { ...params, state: "visible" },
      { ...fake, signal: abort.signal },
    );
    await vi.advanceTimersByTimeAsync(10);
    abort.abort();
    expect(await pending).toMatchObject({ code: "cancelled" });
    const count = fake.sent.filter((c) => c.method !== "Runtime.releaseObjectGroup").length;
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.sent.filter((c) => c.method !== "Runtime.releaseObjectGroup")).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait for object-group cleanup", async () => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp({
      handlers: {
        ...probeHandlers({ attached: true, visible: true }),
        "Runtime.releaseObjectGroup": () => new Promise(() => {}),
      },
    });
    expect(
      await handleWaitForElement(manager, { ...params, state: "visible" }, fake),
    ).toMatchObject({ satisfied: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases frame-local handles in their own CDP session", async () => {
    const manager = await sessionWithRef();
    manager.get("aa11")?.refStore.set("e1", 555, { tabId: 4, cdpSessionId: "child-frame" });
    const fake = makeFakeCdp();
    const sendToTarget = vi.fn(async (_target, method) =>
      method === "DOM.resolveNode"
        ? { object: { objectId: "frame-object" } }
        : method === "Runtime.callFunctionOn"
          ? { result: { value: { attached: false, visible: false } } }
          : {},
    );
    fake.cdp.sendToTarget = sendToTarget as CdpRunner["sendToTarget"];
    expect(await handleWaitForElement(manager, params, fake)).toMatchObject({ satisfied: true });
    expect(sendToTarget).toHaveBeenLastCalledWith(
      { tabId: 4, sessionId: "child-frame" },
      "Runtime.releaseObjectGroup",
      { objectGroup: expect.any(String) },
    );
    expect(fake.sent).toHaveLength(0);
  });
  it("does not dispatch a read queued during attachment past the deadline", async () => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp();
    const dispatched = vi.fn();
    fake.cdp.sendGuarded = async (_target, _method, _params, guard) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      guard.onDispatch?.();
      dispatched();
      return {} as never;
    };
    const pending = handleWaitForElement(manager, params, fake);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ satisfied: false, attached: null });
    await vi.advanceTimersByTimeAsync(500);
    expect(dispatched).not.toHaveBeenCalled();
  });

  it.each([
    "No node with given id found",
    "Could not find node with given id",
    JSON.stringify({ code: -32000, message: "No node with given id found" }),
    JSON.stringify({ code: -32000, message: "Could not find node with given id" }),
  ])("re-queries a selector after removal during lookup: %s", async (message) => {
    const manager = await sessionWithRef();
    let queries = 0;
    const fake = makeFakeCdp({
      handlers: {
        "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
        "DOM.querySelector": () => ({ nodeId: ++queries === 1 ? 2 : 0 }),
        "DOM.describeNode": () => {
          throw new Error(message);
        },
      },
    });
    const pending = handleWaitForElement(
      manager,
      { session_id: "aa11", selector: "#mask", state: "hidden", timeout_ms: 100 },
      fake,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({
      satisfied: true,
      attached: false,
      visible: false,
      used_selector: "#mask",
    });
    expect(queries).toBe(2);
  });

  it.each([
    "hidden",
    "detached",
  ] as const)("does not satisfy %s when a visible replacement matches the selector", async (state) => {
    const manager = await sessionWithRef();
    let described = 0;
    const fake = makeFakeCdp({
      handlers: {
        ...probeHandlers({ attached: true, visible: true }),
        "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
        "DOM.querySelector": () => ({ nodeId: 2 }),
        "DOM.describeNode": () => {
          if (++described === 1) throw new Error("Could not find node with given id");
          return { node: { backendNodeId: 556 } };
        },
      },
    });
    const pending = handleWaitForElement(
      manager,
      { session_id: "aa11", selector: "#mask", state, timeout_ms: 100 },
      fake,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({
      satisfied: false,
      attached: true,
      visible: true,
      elapsed_ms: 100,
    });
  });

  it.each([
    false,
    true,
  ])("bounds repeated stale lookups and preserves evidence (initial probe=%s)", async (initialProbe) => {
    const manager = await sessionWithRef();
    let described = 0;
    const fake = makeFakeCdp({
      handlers: {
        ...probeHandlers({ attached: true, visible: true }),
        "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
        "DOM.querySelector": () => ({ nodeId: 2 }),
        "DOM.describeNode": () => {
          if (++described === 1 && initialProbe) return { node: { backendNodeId: 555 } };
          throw new Error("Could not find node with given id");
        },
      },
    });
    const pending = handleWaitForElement(
      manager,
      { session_id: "aa11", selector: "#mask", state: "hidden", timeout_ms: 100 },
      fake,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({
      satisfied: false,
      attached: initialProbe ? true : null,
      visible: initialProbe ? true : null,
      elapsed_ms: 100,
    });
    expect(fake.sent.filter((c) => c.method === "Runtime.callFunctionOn")).toHaveLength(
      initialProbe ? 1 : 0,
    );
  });

  it("preserves an invalid selector as a CDP error", async () => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp({
      handlers: {
        "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
        "DOM.querySelector": () => {
          throw new Error("DOM Error while querying");
        },
      },
    });
    expect(
      await handleWaitForElement(
        manager,
        { session_id: "aa11", selector: "[", state: "detached" },
        fake,
      ),
    ).toMatchObject({ code: "cdp_failed" });
  });
  it("ignores a late failure when the deadline callback is delayed", async () => {
    const manager = await sessionWithRef();
    const fake = makeFakeCdp({
      handlers: {
        "DOM.resolveNode": () => {
          vi.spyOn(performance, "now").mockReturnValue(500);
          throw new Error("Debugger connection lost");
        },
      },
    });
    expect(await handleWaitForElement(manager, params, fake)).toMatchObject({
      satisfied: false,
      attached: null,
      visible: null,
      elapsed_ms: 500,
    });
  });
});
