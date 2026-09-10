// @vitest-environment node
// Opt in with BSK_WHEEL_CHROME=/path/to/chrome. Uses an isolated browser/profile.
import { describe, expect, it } from "vitest";
import type { CdpFrame, CdpFrameGraph, CdpTarget } from "@/browser-driver/frame-graph";
import { SessionManager } from "@/session-manager/manager";
import type { WheelParams } from "@/transport/types";
import type { CdpRunner } from "../shared";
import { handleWheel } from "../wheel";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Tree = { frame: { id: string; parentId?: string; name?: string }; childFrames?: Tree[] };

async function withBrowser(
  run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>,
  zoom = 1,
) {
  const { withChrome } = await import(
    new URL(
      "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
      import.meta.url,
    ).href
  );
  await withChrome(
    { executable: process.env.BSK_WHEEL_CHROME, deviceScale: 1, zoom },
    async (send: Send) => run(await harness(send)),
  );
}

async function harness(send: Send) {
  const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId: rootSession } = await send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await send("Page.bringToFront", {}, rootSession);
  const manager = new SessionManager({
    agentWindow: {
      create: async () => 100,
      remove: async () => {},
      ensureActiveTab: async () => 4,
    },
  });
  const ctx = await manager.start("aa11");
  const calls: { method: string; sessionId?: string }[] = [];
  const after = { command: (_method: string) => {} };
  const sessionFor = (target: CdpTarget) => target.sessionId ?? rootSession;
  const forward = async <T>(target: CdpTarget, method: string, params?: object): Promise<T> => {
    calls.push({ method, sessionId: target.sessionId });
    const result = await send<T>(method, params, sessionFor(target));
    after.command(method);
    return result;
  };
  const cdp: CdpRunner = {
    send: (_tab, method, params) => forward({ tabId: 4 }, method, params),
    sendToTarget: forward,
  };
  const evaluate = async <T>(expression: string, frame?: CdpFrame): Promise<T> => {
    const session = frame ? sessionFor(frame.target) : rootSession;
    const world = frame
      ? await send<{ executionContextId: number }>(
          "Page.createIsolatedWorld",
          {
            frameId: frame.frameId,
            worldName: "wheel-oracle",
          },
          session,
        )
      : undefined;
    const reply = await send<{ result: { value: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      {
        expression,
        contextId: world?.executionContextId,
        returnByValue: true,
        awaitPromise: true,
      },
      session,
    );
    expect(reply.exceptionDetails).toBeUndefined();
    return reply.result.value;
  };
  const rememberRef = (frame: CdpFrame, backendNodeId: number) =>
    ctx.refStore.set("e1", backendNodeId, {
      tabId: 4,
      frameId: frame.frameId,
      cdpSessionId: frame.target.sessionId,
    });
  const ref = async (frame: CdpFrame, selector = "#probe") => {
    const { executionContextId } = await send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      {
        frameId: frame.frameId,
        worldName: "wheel-oracle",
      },
      sessionFor(frame.target),
    );
    const { result } = await send<{ result: { objectId: string } }>(
      "Runtime.evaluate",
      {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        contextId: executionContextId,
      },
      sessionFor(frame.target),
    );
    const { node } = await send<{ node: { backendNodeId: number } }>(
      "DOM.describeNode",
      { objectId: result.objectId },
      sessionFor(frame.target),
    );
    await send("Runtime.releaseObject", { objectId: result.objectId }, sessionFor(frame.target));
    rememberRef(frame, node.backendNodeId);
  };
  const wheel = (params: Partial<WheelParams>, signal?: AbortSignal) =>
    handleWheel(
      manager,
      { session_id: "aa11", ...params },
      {
        cdp,
        signal,
        tabsApi: {
          get: async (id) => ({ id, windowId: 100, active: true }) as chrome.tabs.Tab,
          query: async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab],
        },
      },
    );
  const loadFrames = async () => {
    const { targetInfos } = await send<{ targetInfos: { targetId: string; type: string }[] }>(
      "Target.getTargets",
    );
    const sessions = [rootSession];
    for (const target of targetInfos.filter((t) => t.type === "iframe")) {
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true,
      });
      sessions.push(sessionId);
    }
    const frames: (CdpFrame & { name: string })[] = [];
    for (const session of sessions) {
      const { frameTree } = await send<{ frameTree: Tree }>("Page.getFrameTree", {}, session);
      const target = { tabId: 4, ...(session !== rootSession ? { sessionId: session } : {}) };
      const visit = (tree: Tree, parentFrameId = tree.frame.parentId) => {
        frames.push({ frameId: tree.frame.id, parentFrameId, target, name: tree.frame.name ?? "" });
        for (const child of tree.childFrames ?? []) visit(child, tree.frame.id);
      };
      visit(frameTree);
    }
    for (const frame of frames) {
      if (!frame.parentFrameId) continue;
      const parent = frames.find((f) => f.frameId === frame.parentFrameId)!;
      const owner = await send<{ backendNodeId: number }>(
        "DOM.getFrameOwner",
        { frameId: frame.frameId },
        sessionFor(parent.target),
      );
      frame.ownerBackendNodeId = owner.backendNodeId;
    }
    const graph: CdpFrameGraph = { rootFrameId: frames[0].frameId, frames };
    cdp.getFrameGraph = async () => graph;
    return frames;
  };
  return { send, rootSession, evaluate, ref, rememberRef, wheel, loadFrames, calls, after };
}

const LISTEN = `window.wheels = []; window.blockWheel = false;
  document.addEventListener('wheel', event => {
    window.wheels.push({ trusted:event.isTrusted, dx:event.deltaX, dy:event.deltaY,
      mode:event.deltaMode, ctrl:event.ctrlKey, shift:event.shiftKey,
      ids:event.composedPath().map(node=>node.id).filter(Boolean) });
    if (window.blockWheel) event.preventDefault();
  }, { capture:true, passive:false });`;

describe.skipIf(!process.env.BSK_WHEEL_CHROME)("real browser wheel", () => {
  it("sends trusted viewport input in both directions and horizontally", async () => {
    await withBrowser(async (h) => {
      await h.evaluate(
        `document.body.style.cssText='margin:0;width:4000px;height:6000px'; ${LISTEN}`,
      );
      expect(await h.wheel({ delta_y: 300 })).toMatchObject({ delta_x: 0, delta_y: 300 });
      await expect.poll(() => h.evaluate<number>("scrollY")).toBe(300);
      expect(await h.wheel({ delta_y: -100 })).not.toHaveProperty("code");
      await expect.poll(() => h.evaluate<number>("scrollY")).toBe(200);
      expect(await h.wheel({ delta_x: 200 })).not.toHaveProperty("code");
      await expect.poll(() => h.evaluate<number>("scrollX")).toBe(200);
      expect(
        await h.evaluate("window.wheels.map(({trusted,dx,dy,mode})=>({trusted,dx,dy,mode}))"),
      ).toEqual([
        { trusted: true, dx: 0, dy: 300, mode: 0 },
        { trusted: true, dx: 0, dy: -100, mode: 0 },
        { trusted: true, dx: 200, dy: 0, mode: 0 },
      ]);
    });
  });

  it.each([
    1, 1.25,
  ])("targets a nested scroller and respects preventDefault at zoom %s", async (zoom) => {
    await withBrowser(async (h) => {
      await h.evaluate(
        `document.body.innerHTML = '<div id="panel" style="margin:50px;width:400px;height:250px;overflow:auto"><div id="content" style="width:2000px;height:3000px"></div></div>'; ${LISTEN}`,
      );
      expect(await h.wheel({ selector: "#panel", delta_y: 120 })).not.toHaveProperty("code");
      await expect
        .poll(() => h.evaluate<number>("document.querySelector('#panel').scrollTop"))
        .toBeCloseTo(120 / zoom, 0);
      expect(await h.evaluate("scrollY")).toBe(0);
      expect(await h.evaluate("window.wheels[0].ids")).toContain("panel");
      const before = await h.evaluate<number>("document.querySelector('#panel').scrollTop");
      await h.evaluate("window.blockWheel=true; window.wheels=[]");
      expect(
        await h.wheel({
          selector: "#panel",
          delta_x: 25,
          delta_y: -50,
          modifiers: ["ctrl", "shift"],
        }),
      ).not.toHaveProperty("code");
      await expect.poll(() => h.evaluate<number>("window.wheels.length")).toBe(1);
      const event = await h.evaluate<{ dx: number; dy: number }>("window.wheels[0]");
      expect(event).toMatchObject({ trusted: true, ctrl: true, shift: true });
      // Native Chromium adjusts wheel deltas by page zoom before DOM delivery.
      expect(event.dx).toBeCloseTo(25 / zoom, 3);
      expect(event.dy).toBeCloseTo(-50 / zoom, 3);
      await h.evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      expect(await h.evaluate("document.querySelector('#panel').scrollTop")).toBe(before);
    }, zoom);
  });

  it("hits the visible portion of a target clipped by a small ancestor", async () => {
    await withBrowser(async (h) => {
      await h.evaluate(
        `document.body.innerHTML='<div style="height:200px"></div><div id="clip" style="height:80px;width:200px;overflow:auto"><div id="probe" style="height:400px;width:100px"></div></div>'; ${LISTEN}`,
      );
      expect(await h.wheel({ selector: "#probe", delta_y: 100 })).not.toHaveProperty("code");
      await expect.poll(() => h.evaluate<number>("window.wheels.length")).toBe(1);
      expect(await h.evaluate("window.wheels[0].ids")).toContain("probe");
      await expect
        .poll(() => h.evaluate<number>("document.querySelector('#clip').scrollTop"))
        .toBeGreaterThan(0);
    });
  });

  it.each([
    { fixture: "snapshot-coordinates", zoom: 1 },
    { fixture: "snapshot-coordinates", zoom: 1.25 },
    { fixture: "oopif-scrollbars", zoom: 0.8 },
  ])("routes wheel to nested frames: $fixture at zoom $zoom", async ({ fixture, zoom }) => {
    const { createEvalServer } = await import(
      new URL("../../../../../evals/browser/lib/server.mjs", import.meta.url).href
    );
    const server = createEvalServer();
    const { baseUrl } = await server.start();
    try {
      await withBrowser(async (h) => {
        await h.send("Page.navigate", { url: `${baseUrl}/${fixture}?run=wheel` }, h.rootSession);
        await expect
          .poll(
            () =>
              server
                .snapshot("wheel")
                .events.some(
                  (e: { type: string; data: { root?: boolean } }) =>
                    e.type === "geometry.ready" && e.data.root,
                ),
            { timeout: 10_000 },
          )
          .toBe(true);
        const frames = await h.loadFrames();
        expect(frames.length).toBe(fixture === "snapshot-coordinates" ? 5 : 3);
        expect(frames.some((frame) => frame.target.sessionId)).toBe(true);
        for (const frame of frames) await h.evaluate(`${LISTEN} window.blockWheel=true`, frame);
        for (const frame of frames) {
          for (const other of frames) await h.evaluate("window.wheels=[]", other);
          await h.ref(frame);
          expect(await h.wheel({ ref: "e1", delta_y: 90 })).not.toHaveProperty("code");
          await expect.poll(() => h.evaluate<number>("window.wheels.length", frame)).toBe(1);
          const event = await h.evaluate<{ dy: number }>("window.wheels[0]", frame);
          expect(event).toMatchObject({
            trusted: true,
            dx: 0,
            ids: expect.arrayContaining(["probe"]),
          });
          expect(event.dy).toBeCloseTo(90 / zoom, 3);
          for (const other of frames.filter((other) => other !== frame))
            expect(await h.evaluate("window.wheels.length", other)).toBe(0);
        }
      }, zoom);
    } finally {
      await server.stop();
    }
  }, 30_000);

  it("cancels during selector lookup before scrolling or input", async () => {
    await withBrowser(async (h) => {
      await h.evaluate(
        `document.body.innerHTML='<div style="height:2000px"></div><button id="probe">Target</button>'; ${LISTEN}`,
      );
      const abort = new AbortController();
      h.after.command = (method) => {
        if (method === "DOM.getDocument") abort.abort();
      };
      expect(await h.wheel({ selector: "#probe", delta_y: 100 }, abort.signal)).toMatchObject({
        code: "cancelled",
      });
      expect(h.calls.map((c) => c.method)).toEqual(["DOM.getDocument"]);
      expect(await h.evaluate("({y:scrollY,count:window.wheels.length})")).toEqual({
        y: 0,
        count: 0,
      });
    });
  });
});
