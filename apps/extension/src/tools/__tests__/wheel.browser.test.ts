// @vitest-environment node
// Opt in with BSK_TEST_CHROME=/path/to/chrome. Uses an isolated browser/profile.
import { describe, expect, it } from "vitest";
import {
  type FrameDocumentGraph,
  type FrameDocumentHandle,
  type FrameDocumentInfo,
  type FrameNodeHandle,
  toFrameDocumentHandle,
} from "@/browser-driver/frame-handles";
import { SessionManager } from "@/session-manager/manager";
import type { WheelParams } from "@/transport/types";
import { type CdpRunner, createStubCdpRunner } from "../shared";
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
    { executable: process.env.BSK_TEST_CHROME, deviceScale: 1, zoom },
    async (send: Send) => run(await harness(send)),
  );
}

async function harness(send: Send) {
  const { product } = await send<{ product: string }>("Browser.getVersion");
  const chromeMajor = Number(/\/(\d+)\./.exec(product)?.[1] ?? 0);
  // Chromium < 158 left CDP mouseWheel deltas unscaled at ingress so Blink's
  // viewport-to-CSS conversion divided them by page zoom; Chromium 158+ scales
  // CDP mouseWheel deltas as CSS pixels across browser zoom.
  const expectedDelta = (delta: number, zoom: number) =>
    chromeMajor >= 158 ? delta : delta / zoom;
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
      create: async () => ({ windowId: 100, initialTabIds: [] }),
      remove: async () => {},
      ensureActiveTab: async () => 4,
    },
  });
  const ctx = await manager.start("aa11");
  const calls: { method: string; sessionId?: string }[] = [];
  const after = { command: (_method: string) => {} };
  type FrameRecord = FrameDocumentInfo & { name: string; targetSession?: string };
  let currentFrames: FrameRecord[] = [];
  const sessionForFrame = (frameId?: string) =>
    (frameId ? currentFrames.find((f) => f.frameId === frameId)?.targetSession : undefined) ??
    rootSession;
  const forward = async <T>(
    handle: FrameDocumentHandle | FrameNodeHandle | { tabId: number; frameId?: string },
    method: string,
    params?: object,
  ): Promise<T> => {
    const targetSession = handle.frameId
      ? currentFrames.find((f) => f.frameId === handle.frameId)?.targetSession
      : undefined;
    calls.push({ method, sessionId: targetSession });
    const result = await send<T>(method, params, targetSession ?? rootSession);
    after.command(method);
    return result;
  };
  const cdp: CdpRunner = createStubCdpRunner({
    send: (_tab, method, params) => forward({ tabId: 4 }, method, params),
    sendToFrame: forward,
  });
  const evaluate = async <T>(expression: string, frame?: FrameRecord): Promise<T> => {
    const session = frame ? sessionForFrame(frame.frameId) : rootSession;
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
  const rememberRef = (frame: FrameRecord, backendNodeId: number) =>
    ctx.refStore.set("e1", backendNodeId, {
      tabId: 4,
      frameId: frame.frameId,
      loaderId: frame.loaderId,
    });
  const ref = async (frame: FrameRecord, selector = "#probe") => {
    const frameSession = sessionForFrame(frame.frameId);
    const { executionContextId } = await send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      {
        frameId: frame.frameId,
        worldName: "wheel-oracle",
      },
      frameSession,
    );
    const { result } = await send<{ result: { objectId: string } }>(
      "Runtime.evaluate",
      {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        contextId: executionContextId,
      },
      frameSession,
    );
    const { node } = await send<{ node: { backendNodeId: number } }>(
      "DOM.describeNode",
      { objectId: result.objectId },
      frameSession,
    );
    await send("Runtime.releaseObject", { objectId: result.objectId }, frameSession);
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
    const frames: FrameRecord[] = [];
    for (const session of sessions) {
      const { frameTree } = await send<{ frameTree: Tree }>("Page.getFrameTree", {}, session);
      const targetSession = session !== rootSession ? session : undefined;
      const visit = (tree: Tree, parentFrameId = tree.frame.parentId) => {
        frames.push({
          handle: toFrameDocumentHandle(4, { frameId: tree.frame.id, loaderId: "" }),
          frameId: tree.frame.id,
          loaderId: "",
          parentFrameId,
          processKey: targetSession ? `oopif:${targetSession}` : "root",
          isOutOfProcess: Boolean(targetSession),
          ...(targetSession ? { targetSession } : {}),
          name: tree.frame.name ?? "",
        });
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
        parent.targetSession ?? rootSession,
      );
      (frame as { ownerBackendNodeId?: number }).ownerBackendNodeId = owner.backendNodeId;
    }
    currentFrames = frames;
    const graph: FrameDocumentGraph = { rootFrameId: frames[0].frameId, frames };
    cdp.getFrameDocuments = async () => graph;
    return frames;
  };
  return {
    send,
    rootSession,
    evaluate,
    ref,
    rememberRef,
    wheel,
    loadFrames,
    expectedDelta,
    calls,
    after,
  };
}

const LISTEN = `window.wheels = []; window.blockWheel = false;
  document.addEventListener('wheel', event => {
    window.wheels.push({ trusted:event.isTrusted, dx:event.deltaX, dy:event.deltaY,
      mode:event.deltaMode, ctrl:event.ctrlKey, shift:event.shiftKey,
      ids:event.composedPath().map(node=>node.id).filter(Boolean) });
    if (window.blockWheel) event.preventDefault();
  }, { capture:true, passive:false });`;

describe.skipIf(!process.env.BSK_TEST_CHROME)("real browser wheel", () => {
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
      const metrics = await h.send<{ cssVisualViewport: { zoom: number } }>(
        "Page.getLayoutMetrics",
        {},
        h.rootSession,
      );
      expect(metrics.cssVisualViewport.zoom).toBeCloseTo(zoom, 4);
      await h.evaluate(
        `document.body.innerHTML = '<div id="panel" style="margin:50px;width:400px;height:250px;overflow:auto"><div id="content" style="width:2000px;height:3000px"></div></div>'; ${LISTEN}`,
      );
      expect(await h.wheel({ selector: "#panel", delta_y: 120 })).not.toHaveProperty("code");
      await expect
        .poll(() => h.evaluate<number>("document.querySelector('#panel').scrollTop"))
        .toBeCloseTo(h.expectedDelta(120, zoom), 0);
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
      expect(event.dx).toBeCloseTo(h.expectedDelta(25, zoom), 3);
      expect(event.dy).toBeCloseTo(h.expectedDelta(-50, zoom), 3);
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
        expect(frames.some((frame) => frame.isOutOfProcess)).toBe(true);
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
          expect(event.dy).toBeCloseTo(h.expectedDelta(90, zoom), 3);
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
      expect(h.calls.map((c) => c.method)).toEqual(["Runtime.evaluate", "DOM.getDocument"]);
      expect(await h.evaluate("({y:scrollY,count:window.wheels.length})")).toEqual({
        y: 0,
        count: 0,
      });
    });
  });

  it("keeps wheel usable when an OOPIF visibility observer does not callback", async () => {
    const { createEvalServer } = await import(
      new URL("../../../../../evals/browser/lib/server.mjs", import.meta.url).href
    );
    const server = createEvalServer();
    const { baseUrl } = await server.start();
    try {
      await withBrowser(async (h) => {
        await h.send(
          "Page.navigate",
          { url: `${baseUrl}/wheel-visibility-timeout?run=wheel-visibility-timeout` },
          h.rootSession,
        );
        await expect
          .poll(() =>
            server
              .snapshot("wheel-visibility-timeout")
              .events.some((event: { type: string }) => event.type === "fixture.child-ready"),
          )
          .toBe(true);

        const frames = await h.loadFrames();
        const child = frames.find((frame) => Boolean(frame.target.sessionId));
        expect(child?.target.sessionId).toBeTruthy();
        const childSession = child!.target.sessionId!;
        const patched = await h.send<{ exceptionDetails?: unknown }>(
          "Runtime.evaluate",
          {
            expression: `(() => {
              window.__withheldObserverConstructions = 0;
              class WithheldIntersectionObserver {
                constructor() { window.__withheldObserverConstructions++; }
                observe() {}
                unobserve() {}
                disconnect() {}
                takeRecords() { return []; }
              }
              Object.defineProperty(window, "IntersectionObserver", {
                configurable: true,
                writable: true,
                value: WithheldIntersectionObserver,
              });
            })()`,
            returnByValue: true,
          },
          childSession,
        );
        expect(patched.exceptionDetails).toBeUndefined();
        await h.ref(child!, "#probe");

        const before = await h.evaluate<number>(
          "document.querySelector('#inner').scrollTop",
          child,
        );
        const result = await h.wheel({ ref: "e1", delta_y: 120, timeout_ms: 5_000 });
        expect(result).not.toHaveProperty("code");
        await expect
          .poll(() => h.evaluate<number>("document.querySelector('#inner').scrollTop", child), {
            timeout: 5_000,
          })
          .toBeGreaterThan(before);
        await expect
          .poll(async () => {
            const events = await h.send<{ result: { value: number } }>(
              "Runtime.evaluate",
              { expression: "window.wheels.length", returnByValue: true },
              childSession,
            );
            return events.result.value;
          })
          .toBe(1);
        const firstWheel = await h.send<{
          result: { value: { deltaY: number; trusted: boolean } };
        }>(
          "Runtime.evaluate",
          { expression: "window.wheels[0]", returnByValue: true },
          childSession,
        );
        expect(firstWheel.result.value.trusted).toBe(true);
        expect(firstWheel.result.value.deltaY).toBeGreaterThan(0);
        const observers = await h.send<{ result: { value: number } }>(
          "Runtime.evaluate",
          { expression: "window.__withheldObserverConstructions", returnByValue: true },
          childSession,
        );
        expect(observers.result.value).toBeGreaterThan(0);
      }, 1);
    } finally {
      await server.stop();
    }
  }, 30_000);
});
