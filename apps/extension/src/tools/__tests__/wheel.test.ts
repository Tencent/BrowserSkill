import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpFrameGraph, CdpTarget } from "@/browser-driver/frame-graph";
import { SessionManager } from "@/session-manager/manager";
import type { JavaScriptDialogInfo, WheelParams } from "@/transport/types";
import type { ViewportRect } from "../geometry";
import type { CdpRunner } from "../shared";
import { handleWheel } from "../wheel";

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
      "Input.dispatchMouseEvent": {},
      "DOM.getContentQuads": {
        quads: [
          frame === "same-target"
            ? [224, 346, 424, 346, 424, 426, 224, 426]
            : [10, 20, 110, 20, 110, 60, 10, 60],
        ],
      },
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
  const bypassOverlay = vi.fn(async (_tab: number, _enabled: boolean) => {});
  const run = (params: Partial<WheelParams> = {}) =>
    handleWheel(
      manager,
      { session_id: "aa11", delta_y: 120, ...params },
      { cdp, tabsApi, signal: abort.signal, bypassOverlay },
    );
  return { ctx, cdp, graph, rectangles, calls, hooks, abort, tabsApi, bypassOverlay, run };
}

afterEach(() => vi.restoreAllMocks());

describe("handleWheel", () => {
  it("moves to the viewport centre and sends signed native deltas and modifiers", async () => {
    const f = await fixture();
    expect(
      await f.run({ delta_x: -20.5, delta_y: 600, modifiers: ["ctrl", "shift"] }),
    ).toMatchObject({
      tab_id: 4,
      x: 640,
      y: 360,
      delta_x: -20.5,
      delta_y: 600,
    });
    expect(f.calls.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "Page.getLayoutMetrics", params: {} },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: 640, y: 360, modifiers: 10 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseWheel", x: 640, y: 360, deltaX: -20.5, deltaY: 600, modifiers: 10 },
      },
    ]);
    expect(f.bypassOverlay.mock.calls).toEqual([
      [4, true],
      [4, false],
    ]);
  });

  it("supports pure horizontal input", async () => {
    const f = await fixture();
    expect(await f.run({ delta_x: -120, delta_y: undefined })).toMatchObject({
      delta_x: -120,
      delta_y: 0,
    });
  });

  it.each([
    { ref: "@e3" },
    { selector: "#panel" },
  ])("resolves %j and cleans up measurement objects", async (target) => {
    const f = await fixture();
    expect(await f.run(target)).toMatchObject({
      x: 60,
      y: 40,
      delta_y: 120,
      ...(target.ref ? { used_ref: "e3" } : { used_selector: "#panel" }),
    });
    const group = f.calls.find((c) => c.method === "DOM.resolveNode")!.params!.objectGroup;
    expect(f.calls.at(-1)).toMatchObject({
      method: "Runtime.releaseObjectGroup",
      params: { objectGroup: group },
    });
  });

  it.each([
    "same-target",
    "oopif",
  ] as const)("projects %s refs and routes input to the root target", async (frame) => {
    const f = await fixture(frame);
    expect(await f.run({ ref: "@e3" })).toMatchObject({ x: 324, y: 386 });
    expect(
      f.calls
        .filter((c) => c.method === "DOM.scrollIntoViewIfNeeded")
        .map((c) => c.params!.backendNodeId),
    ).toEqual([99, 1234]);
    expect(f.cdp.getFrameGraph).toHaveBeenCalledTimes(1);
    expect(
      f.calls
        .filter((c) => c.method === "Input.dispatchMouseEvent")
        .every((c) => c.target.sessionId === undefined),
    ).toBe(true);
    if (frame === "oopif") {
      expect(f.calls.find((c) => c.params?.backendNodeId === 1234)!.target.sessionId).toBe(
        "child-session",
      );
      expect(
        f.calls
          .filter((c) => c.method === "Runtime.releaseObjectGroup")
          .map((c) => c.target.sessionId)
          .sort(),
      ).toEqual(["child-session", undefined].sort());
    }
  });

  it("chooses a point within an ordinary ancestor's clip", async () => {
    const f = await fixture();
    f.rectangles.set(1234, { x: 10, y: 20, width: 20, height: 40 });
    expect(await f.run({ ref: "@e3" })).toMatchObject({ x: 20, y: 40 });
  });

  it.each([
    1234, 99,
  ])("rejects a hidden or fully clipped node %i before sending input", async (node) => {
    const f = await fixture("oopif");
    f.rectangles.set(node, null);
    expect(await f.run({ ref: "@e3" })).toMatchObject({
      code: "permission_denied",
      data: { reason: "element_not_visible" },
    });
    expect(f.calls.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it.each([
    { delta_y: 0 },
    { delta_y: undefined },
    { delta_y: Number.NaN },
    { delta_x: Infinity },
    { ref: "" },
    { selector: " " },
    { ref: "@e3", selector: "#panel" },
    { timeout_ms: 0 },
    { timeout_ms: -1 },
    { timeout_ms: 1.5 },
  ])("rejects invalid params %j without browser calls", async (params) => {
    const f = await fixture();
    expect(await f.run(params)).toMatchObject({ code: "invalid_params" });
    expect(f.calls).toEqual([]);
    expect(f.tabsApi.query).not.toHaveBeenCalled();
    expect(f.bypassOverlay).not.toHaveBeenCalled();
  });

  it.each([
    { ref: null },
    { selector: 42 },
    { delta_y: null },
    { delta_x: "10" },
    { timeout_ms: null },
    { modifiers: "ctrl" },
    { modifiers: ["invalid"] },
  ])("rejects malformed wire params %j", async (params) => {
    const f = await fixture();
    expect(await f.run(params as unknown as Partial<WheelParams>)).toMatchObject({
      code: "invalid_params",
    });
    expect(f.calls).toEqual([]);
  });

  it.each(["stale", "other-tab"])("rejects %s refs", async (mode) => {
    const f = await fixture();
    if (mode === "stale") f.ctx.refStore.clear();
    else f.ctx.refStore.set("e3", 1234, { tabId: 8 });
    expect(await f.run({ ref: "@e3" })).toMatchObject({
      code: "not_found",
      data: { reason: "ref_not_found" },
    });
    expect(f.calls).toEqual([]);
  });

  it("reports missing selectors without sending input", async () => {
    const f = await fixture();
    f.hooks.reply = (c) => (c.method === "DOM.querySelector" ? { nodeId: 0 } : undefined);
    expect(await f.run({ selector: "#missing" })).toMatchObject({
      code: "not_found",
      data: { reason: "selector_not_found" },
    });
    expect(f.calls.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("enforces the Agent Window boundary", async () => {
    const f = await fixture();
    f.tabsApi.get.mockResolvedValue({ id: 4, windowId: 200, active: true } as chrome.tabs.Tab);
    expect(await f.run({ tab_id: 4 })).toMatchObject({ code: "permission_denied" });
    expect(f.calls).toEqual([]);
  });

  it.each([
    "getFrameGraph",
    "DOM.scrollIntoViewIfNeeded",
    "DOM.getContentQuads",
    "DOM.resolveNode",
    "Runtime.callFunctionOn",
    "Page.getLayoutMetrics",
    "Runtime.evaluate",
    "DOM.getBoxModel",
    "Input.dispatchMouseEvent",
  ])("stops at cancellation during %s, allowing only cleanup", async (method) => {
    const f = await fixture("oopif");
    f.hooks.after = (c) => {
      if (c.method === method) f.abort.abort();
    };
    expect(await f.run({ ref: "@e3" })).toMatchObject({ code: "cancelled" });
    expect(f.abort.signal.aborted).toBe(true);
    expect(f.calls.filter((c) => c.aborted && c.method !== "Runtime.releaseObjectGroup")).toEqual(
      [],
    );
    expect(f.bypassOverlay.mock.calls.at(-1)?.[1] ?? false).toBe(false);
  });

  it.each([
    "DOM.getDocument",
    "DOM.querySelector",
    "DOM.describeNode",
  ])("stops selector lookup after cancellation during %s", async (method) => {
    const f = await fixture();
    f.hooks.after = (c) => {
      if (c.method === method) f.abort.abort();
    };
    expect(await f.run({ selector: "#panel" })).toMatchObject({ code: "cancelled" });
    expect(f.calls.filter((c) => c.aborted)).toEqual([]);
  });

  it("does not start after early cancellation or cancellation during tab resolution", async () => {
    for (const early of [true, false]) {
      const f = await fixture();
      if (early) f.abort.abort();
      else
        f.tabsApi.query.mockImplementation(async () => {
          f.abort.abort();
          return [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab];
        });
      expect(await f.run()).toMatchObject({ code: "cancelled" });
      expect(f.calls).toEqual([]);
    }
  });

  it("does not run fallback scrolling after cancellation", async () => {
    const f = await fixture();
    f.hooks.reply = (c) => {
      if (c.method === "DOM.scrollIntoViewIfNeeded") {
        f.abort.abort();
        throw new Error("scroll failed");
      }
      return undefined;
    };
    expect(await f.run({ ref: "@e3" })).toMatchObject({ code: "cancelled" });
    expect(f.calls.map((c) => c.method)).toEqual(["DOM.scrollIntoViewIfNeeded"]);
  });

  it.each([
    "DOM.scrollIntoViewIfNeeded",
    "Page.getLayoutMetrics",
    "Input.dispatchMouseEvent",
  ])("stops before further input when the deadline expires during %s", async (method) => {
    const f = await fixture("oopif");
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    f.hooks.after = (c) => {
      if (c.method === method) now.mockReturnValue(201);
    };
    expect(await f.run({ ref: "@e3", timeout_ms: 100 })).toMatchObject({ code: "timeout" });
    expect(f.calls.some((c) => c.params?.type === "mouseWheel")).toBe(false);
    expect(f.calls.filter((c) => c.method === method)).toHaveLength(1);
  });

  it.each([
    "cancel",
    "timeout",
    "failure",
  ])("restores the overlay after %s while enabling bypass", async (mode) => {
    const f = await fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(100);
    f.bypassOverlay.mockImplementation(async (_tab, enabled) => {
      if (!enabled) return;
      if (mode === "cancel") f.abort.abort();
      if (mode === "timeout") now.mockReturnValue(201);
      if (mode === "failure") throw new Error("overlay unavailable");
    });
    expect(await f.run({ timeout_ms: 100 })).toMatchObject({
      code: mode === "cancel" ? "cancelled" : mode === "timeout" ? "timeout" : "cdp_failed",
    });
    expect(f.calls.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
    expect(f.bypassOverlay.mock.calls).toEqual([
      [4, true],
      [4, false],
    ]);
  });

  it("preserves the browser error while cleaning up objects and overlay", async () => {
    const f = await fixture();
    f.hooks.reply = (c) => {
      if (c.params?.type === "mouseWheel") throw new Error("wheel failed");
      if (c.method === "Runtime.releaseObjectGroup") throw new Error("target closed");
      return undefined;
    };
    f.bypassOverlay.mockImplementation(async (_tab, enabled) => {
      if (!enabled) throw new Error("target closed");
    });
    expect(await f.run({ ref: "@e3" })).toMatchObject({
      code: "cdp_failed",
      message: "wheel failed",
    });
    expect(f.calls.at(-1)!.method).toBe("Runtime.releaseObjectGroup");
    expect(f.bypassOverlay.mock.calls).toEqual([
      [4, true],
      [4, false],
    ]);
  });

  it("attaches dialogs handled during input", async () => {
    const f = await fixture();
    f.cdp.dialogCursor = () => 5;
    const dialogs: JavaScriptDialogInfo[] = [
      { sequence: 6, tab_id: 4, type: "alert", message: "wheel", handled: "accepted" },
    ];
    f.cdp.dialogsSince = vi.fn(() => dialogs);
    expect(await f.run()).toHaveProperty("dialogs", dialogs);
    expect(f.cdp.dialogsSince).toHaveBeenCalledWith(4, 5);
  });
});
