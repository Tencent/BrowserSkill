import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpFrameGraph, CdpTarget } from "@/browser-driver/frame-graph";
import { SessionManager } from "@/session-manager/manager";
import type { JavaScriptDialogInfo, ScrollToParams } from "@/transport/types";
import type { ViewportRect } from "../geometry";
import { handleScrollTo } from "../scroll";
import type { CdpRunner } from "../shared";

interface Call {
  target: CdpTarget;
  method: string;
  params?: Record<string, unknown>;
  aborted: boolean;
}

async function fixture(frame: "top" | "same-target" | "oopif" = "top") {
  const manager = new SessionManager({
    agentWindow: {
      create: async () => 100,
      remove: async () => {},
      ensureActiveTab: async () => 4,
    },
  });
  const ctx = await manager.start("aa11");
  ctx.refStore.set("e3", 1234, {
    tabId: 4,
    ...(frame !== "top" ? { frameId: "child" } : {}),
    ...(frame === "oopif" ? { cdpSessionId: "child-session" } : {}),
  });
  const abort = new AbortController();
  const graph: CdpFrameGraph = {
    rootFrameId: "main",
    frames: [
      { frameId: "main", target: { tabId: 4 } },
      {
        frameId: "child",
        parentFrameId: "main",
        ownerBackendNodeId: 99,
        target: { tabId: 4, ...(frame === "oopif" ? { sessionId: "child-session" } : {}) },
      },
    ],
  };
  const rectangles = new Map<number, ViewportRect | null>([
    [1234, { x: 10, y: 20, width: 100, height: 40 }],
    [99, { x: 204, y: 306, width: 400, height: 200 }],
  ]);
  const calls: Call[] = [];
  const hooks = {
    after: (_call: Call) => {},
    reply: (_call: Call): object | undefined => undefined,
  };
  const send = async <T>(target: CdpTarget, method: string, params?: object): Promise<T> => {
    const call = {
      target,
      method,
      params: params as Call["params"],
      aborted: abort.signal.aborted,
    };
    calls.push(call);
    const override = hooks.reply(call);
    hooks.after(call);
    if (override) return override as T;
    const args = call.params ?? {};
    const replies: Record<string, unknown> = {
      "DOM.getDocument": { root: { nodeId: 1 } },
      "DOM.querySelector": { nodeId: 2 },
      "DOM.describeNode": { node: { backendNodeId: 1234 } },
      "DOM.scrollIntoViewIfNeeded": {},
      "DOM.resolveNode": { object: { objectId: String(args.backendNodeId) } },
      "Runtime.callFunctionOn": {
        result: {
          value: String(args.functionDeclaration).includes("IntersectionObserver")
            ? rectangles.get(Number(args.objectId))
            : { width: 200, height: 100 },
        },
      },
      "Runtime.releaseObject": {},
      "Runtime.releaseObjectGroup": {},
      "Runtime.evaluate": { result: { value: { width: 200, height: 100 } } },
      "Page.getLayoutMetrics": {
        cssLayoutViewport: {
          clientWidth: target.sessionId ? 185 : 1280,
          clientHeight: target.sessionId ? 89 : 720,
        },
      },
      "DOM.getBoxModel": { model: { content: [204, 306, 604, 306, 604, 506, 204, 506] } },
    };
    if (!(method in replies)) throw new Error(`unexpected CDP call ${method}`);
    return replies[method] as T;
  };
  const cdp: CdpRunner = {
    send: (tabId, method, params) => send({ tabId }, method, params),
    sendToTarget: send,
    getFrameGraph: vi.fn(async () => {
      hooks.after({ target: { tabId: 4 }, method: "getFrameGraph", aborted: abort.signal.aborted });
      return graph;
    }),
    trackSessionTab: vi.fn(),
  };
  const tabsApi = {
    get: vi.fn(async (id: number) => ({ id, windowId: 100, active: true }) as chrome.tabs.Tab),
    query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
  };
  const run = (params: Partial<ScrollToParams> = {}) =>
    handleScrollTo(
      manager,
      { session_id: "aa11", ref: "@e3", ...params },
      { cdp, tabsApi, signal: abort.signal },
    );
  return { ctx, cdp, graph, rectangles, calls, hooks, abort, tabsApi, run };
}

afterEach(() => vi.restoreAllMocks());

describe("handleScrollTo", () => {
  it("scrolls a ref and returns renderer-clipped bounds", async () => {
    const f = await fixture();
    expect(await f.run()).toMatchObject({
      tab_id: 4,
      used_ref: "e3",
      x: 10,
      y: 20,
      width: 100,
      height: 40,
    });
    expect(f.calls[0]).toMatchObject({
      method: "DOM.scrollIntoViewIfNeeded",
      params: { backendNodeId: 1234 },
    });
    const group = f.calls.find((call) => call.method === "DOM.resolveNode")!.params!.objectGroup;
    expect(f.calls.at(-1)).toMatchObject({
      method: "Runtime.releaseObjectGroup",
      params: { objectGroup: group },
    });
  });

  it("resolves a selector and tracks the attached tab even when it is missing", async () => {
    const f = await fixture();
    expect(await f.run({ ref: undefined, selector: "#target" })).toMatchObject({
      used_selector: "#target",
    });
    f.hooks.reply = ({ method }) => (method === "DOM.querySelector" ? { nodeId: 0 } : undefined);
    expect(await f.run({ ref: undefined, selector: "#missing" })).toMatchObject({
      code: "not_found",
      data: { reason: "selector_not_found" },
    });
    expect(f.cdp.trackSessionTab).toHaveBeenCalledWith("aa11", 4);
  });

  it.each([
    "same-target",
    "oopif",
  ] as const)("projects %s refs and scrolls their owners", async (frame) => {
    const f = await fixture(frame);
    expect(await f.run()).toMatchObject({ x: 224, y: 346, width: 200, height: 80 });
    expect(
      f.calls
        .filter((call) => call.method === "DOM.scrollIntoViewIfNeeded")
        .map((call) => call.params!.backendNodeId),
    ).toEqual([99, 1234]);
    expect(f.cdp.getFrameGraph).toHaveBeenCalledTimes(1);
    if (frame === "oopif")
      expect(f.calls.find((call) => call.params?.backendNodeId === 1234)!.target.sessionId).toBe(
        "child-session",
      );
  });

  it("clips OOPIF bounds to occupied scrollbars without changing the frame scale", async () => {
    const f = await fixture("oopif");
    f.rectangles.set(1234, { x: 180, y: 80, width: 5, height: 9 });
    expect(await f.run()).toMatchObject({ x: 564, y: 466, width: 10, height: 18 });
  });

  it("clips against the iframe owner's ordinary DOM ancestors", async () => {
    const f = await fixture("oopif");
    f.rectangles.set(99, { x: 204, y: 306, width: 400, height: 80 });
    expect(await f.run()).toMatchObject({ x: 224, y: 346, width: 200, height: 40 });
  });

  it.each([1234, 99])("rejects a hidden or fully clipped node %i", async (node) => {
    const f = await fixture("oopif");
    f.rectangles.set(node, null);
    expect(await f.run()).toMatchObject({
      code: "permission_denied",
      data: { reason: "element_not_visible" },
    });
    expect(f.calls.at(-1)!.method).toBe("Runtime.releaseObjectGroup");
  });

  it.each([
    { ref: undefined },
    { selector: "#target" },
    { timeout_ms: 0 },
  ])("rejects invalid params %j", async (params) => {
    const f = await fixture();
    expect(await f.run(params)).toMatchObject({ code: "invalid_params" });
    expect(f.calls).toEqual([]);
  });

  it.each(["stale", "other-tab"])("rejects %s refs before scrolling", async (mode) => {
    const f = await fixture();
    if (mode === "stale") f.ctx.refStore.clear();
    else f.ctx.refStore.set("e3", 1234, { tabId: 8 });
    expect(await f.run()).toMatchObject({ code: "not_found", data: { reason: "ref_not_found" } });
    expect(f.calls).toEqual([]);
  });

  it("enforces the Agent Window boundary", async () => {
    const f = await fixture();
    f.tabsApi.query.mockResolvedValue([{ id: 4, windowId: 200, active: true } as chrome.tabs.Tab]);
    f.tabsApi.get.mockResolvedValue({ id: 4, windowId: 200, active: true } as chrome.tabs.Tab);
    expect(await f.run({ tab_id: 4 })).toMatchObject({ code: "permission_denied" });
    expect(f.calls).toEqual([]);
  });

  it.each([
    "getFrameGraph",
    "DOM.scrollIntoViewIfNeeded",
    "DOM.resolveNode",
    "Runtime.callFunctionOn",
    "Page.getLayoutMetrics",
    "Runtime.evaluate",
    "DOM.getBoxModel",
  ])("honors cancellation during %s and only cleans up afterwards", async (method) => {
    const f = await fixture("oopif");
    f.hooks.after = (call) => {
      if (call.method === method) f.abort.abort();
    };
    expect(await f.run()).toMatchObject({ code: "cancelled" });
    expect(
      f.calls.filter((call) => call.aborted && call.method !== "Runtime.releaseObjectGroup"),
    ).toEqual([]);
  });

  it.each([
    "DOM.getDocument",
    "DOM.querySelector",
    "DOM.describeNode",
  ])("cancels selector resolution during %s", async (method) => {
    const f = await fixture();
    f.hooks.after = (call) => {
      if (call.method === method) f.abort.abort();
    };
    expect(await f.run({ ref: undefined, selector: "#target" })).toMatchObject({
      code: "cancelled",
    });
    expect(f.calls.filter((call) => call.aborted)).toEqual([]);
  });

  it("does not start after early cancellation", async () => {
    const f = await fixture();
    f.abort.abort();
    expect(await f.run()).toMatchObject({ code: "cancelled" });
    expect(f.calls).toEqual([]);
    expect(f.tabsApi.query).not.toHaveBeenCalled();
  });

  it("does not issue fallback scrolling after cancellation", async () => {
    const f = await fixture();
    f.hooks.reply = ({ method }) => {
      if (method === "DOM.scrollIntoViewIfNeeded") {
        f.abort.abort();
        throw new Error("scroll failed");
      }
      return undefined;
    };
    expect(await f.run()).toMatchObject({ code: "cancelled" });
    expect(f.calls.map((call) => call.method)).toEqual(["DOM.scrollIntoViewIfNeeded"]);
  });

  it("stops target scrolling after a deadline expires while scrolling its owner", async () => {
    const f = await fixture("oopif");
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    f.hooks.after = ({ method }) => {
      if (method === "DOM.scrollIntoViewIfNeeded") now.mockReturnValue(201);
    };
    expect(await f.run({ timeout_ms: 100 })).toMatchObject({ code: "timeout" });
    expect(f.calls.filter((call) => call.method === "DOM.scrollIntoViewIfNeeded")).toHaveLength(1);
  });

  it("reports measurement exceptions and releases objects even if cleanup fails", async () => {
    const f = await fixture();
    f.hooks.reply = ({ method }) => {
      if (method === "Runtime.callFunctionOn")
        return { exceptionDetails: { text: "measurement failed" } };
      if (method === "Runtime.releaseObjectGroup") throw new Error("target closed");
      return undefined;
    };
    expect(await f.run()).toMatchObject({ code: "cdp_failed", message: "measurement failed" });
    expect(f.calls.at(-1)!.method).toBe("Runtime.releaseObjectGroup");
  });

  it("attaches dialogs observed during scrolling", async () => {
    const f = await fixture();
    f.cdp.dialogCursor = () => 5;
    const dialogs: JavaScriptDialogInfo[] = [
      {
        sequence: 6,
        tab_id: 4,
        type: "alert",
        message: "scrolled",
        handled: "accepted",
        url: "https://example.test",
      },
    ];
    f.cdp.dialogsSince = vi.fn(() => dialogs);
    expect(await f.run()).toHaveProperty("dialogs", dialogs);
    expect(f.cdp.dialogsSince).toHaveBeenCalledWith(4, 5);
  });
});
