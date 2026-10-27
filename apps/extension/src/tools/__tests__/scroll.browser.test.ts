// @vitest-environment node
// Opt in with BSK_SCROLL_CHROME=/path/to/chrome. Uses an isolated browser/profile.
import { describe, expect, it } from "vitest";
import type { CdpFrame, CdpFrameGraph, CdpTarget } from "@/browser-driver/frame-graph";
import { pointerTargetValidator } from "@/cooperation/pointer-target";
import { SessionManager } from "@/session-manager/manager";
import { resolveNodeGeometry } from "../frame-geometry";
import type { ViewportRect } from "../geometry";
import { handleScrollTo } from "../scroll";
import type { CdpRunner } from "../shared";
import { isRpcError } from "../shared";
import { pointBelongsToTarget } from "../target-hit";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Tree = { frame: { id: string; parentId?: string; name?: string }; childFrames?: Tree[] };

async function withBrowser(
  run: (h: Awaited<ReturnType<typeof harness>>) => Promise<void>,
  zoom = 1,
  deviceScale = 1,
) {
  const { withChrome } = await import(
    new URL(
      "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
      import.meta.url,
    ).href
  );
  await withChrome(
    { executable: process.env.BSK_SCROLL_CHROME, deviceScale, zoom },
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
      create: async () => ({ windowId: 100, initialTabIds: [] }),
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
            worldName: "scroll-oracle",
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
        worldName: "scroll-oracle",
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
    return node.backendNodeId;
  };
  const scroll = (target: { selector: string } | { ref: string }, signal?: AbortSignal) =>
    handleScrollTo(
      manager,
      { session_id: "aa11", ...target },
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
  return { cdp, send, rootSession, evaluate, ref, rememberRef, scroll, loadFrames, calls, after };
}

function intersection(a: ViewportRect, b: ViewportRect): ViewportRect | null {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width),
    bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function expectRect(actual: unknown, expected: ViewportRect) {
  expect(actual).not.toHaveProperty("code");
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs((actual as ViewportRect)[key] - expected[key]), key).toBeLessThan(2);
}

describe.skipIf(!process.env.BSK_SCROLL_CHROME)("real browser scroll-to", () => {
  it("measures scroll visibility in a background task without activating it", async () => {
    await withBrowser(async (h) => {
      await h.evaluate(
        "document.body.innerHTML='<div style=height:2200px></div><button id=target>Target</button>'",
      );
      const { targetId } = await h.send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
      });
      await h.send("Target.activateTarget", { targetId });
      try {
        expect(await h.evaluate("document.visibilityState")).toBe("hidden");
        const result = await h.scroll({ selector: "#target" });
        expect(result).not.toHaveProperty("code");
        expect(await h.evaluate("document.visibilityState")).toBe("hidden");
        expect(await h.evaluate("window.scrollY")).toBeGreaterThan(0);
      } finally {
        await h.send("Target.closeTarget", { targetId });
      }
    });
  });

  it("scrolls ordinary elements and reports the clipped portion of nested scrollers", async () => {
    await withBrowser(async (h) => {
      for (const html of [
        '<div style="height:2200px"></div><div id="target" style="width:100px;height:40px"></div>',
        '<div style="height:200px"></div><div id="clip" style="height:80px;width:200px;overflow:auto"><div id="target" style="width:100px;height:400px"></div></div>',
        '<div style="height:200px"></div><div id="clip" style="height:80px;width:200px;overflow:auto;transform:scale(1.25);transform-origin:0 0"><div id="target" style="width:100px;height:400px"></div></div>',
      ]) {
        await h.evaluate(`document.body.innerHTML = ${JSON.stringify(html)}`);
        const result = await h.scroll({ selector: "#target" });
        const oracle = await h.evaluate<{ rect: ViewportRect; clip?: ViewportRect }>(`({
          rect: document.querySelector('#target').getBoundingClientRect().toJSON(),
          clip: document.querySelector('#clip')?.getBoundingClientRect().toJSON()
        })`);
        expectRect(result, oracle.clip ? intersection(oracle.rect, oracle.clip)! : oracle.rect);
      }
    });
  });

  it.each([
    "visibility:hidden",
    "opacity:0",
    "display:none",
    "content-visibility:hidden",
  ])("rejects %s targets", async (style) => {
    await withBrowser(async (h) => {
      await h.evaluate(
        `document.body.innerHTML = '<div style="${style}"><button id="target">Target</button></div>'`,
      );
      expect(await h.scroll({ selector: "#target" })).toMatchObject({
        code: "permission_denied",
        data: { reason: "element_not_visible" },
      });
    });
  });

  it("rejects targets fully outside an overflow:clip ancestor", async () => {
    await withBrowser(async (h) => {
      await h.evaluate(
        `document.body.innerHTML = '<div style="height:80px;overflow:clip"><div style="height:150px"></div><button id="target">Target</button></div>'`,
      );
      expect(await h.scroll({ selector: "#target" })).toMatchObject({ code: "permission_denied" });
    });
  });

  it.each(["open", "closed"])("clips %s shadow-root refs", async (mode) => {
    await withBrowser(async (h) => {
      await h.evaluate(`(() => {
        const host = document.createElement('div'); document.body.append(host);
        const root = host.attachShadow({mode:'${mode}'});
        root.innerHTML = '<div style="height:60px;overflow:auto"><button id="probe" style="height:200px;width:100px">Target</button></div>';
        window.probe = root.querySelector('#probe');
      })()`);
      const frames = await h.loadFrames();
      const { result } = await h.send<{ result: { objectId: string } }>(
        "Runtime.evaluate",
        { expression: "window.probe" },
        h.rootSession,
      );
      // Build the ref from the actual closed-root node, as an observation does.
      const { node } = await h.send<{ node: { backendNodeId: number } }>(
        "DOM.describeNode",
        { objectId: result.objectId },
        h.rootSession,
      );
      await h.send("Runtime.releaseObject", { objectId: result.objectId }, h.rootSession);
      h.rememberRef(frames[0], node.backendNodeId);
      expect(await h.scroll({ ref: "e1" })).toMatchObject({ height: 60 });
    });
  });

  it("cancels after scrolling and releases the measurement object without follow-up reads", async () => {
    await withBrowser(async (h) => {
      await h.evaluate("document.body.innerHTML = '<button id=target>Target</button>'");
      const abort = new AbortController();
      h.after.command = (method) => {
        if (method === "DOM.resolveNode") abort.abort();
      };
      expect(await h.scroll({ selector: "#target" }, abort.signal)).toMatchObject({
        code: "cancelled",
      });
      expect(h.calls.at(-1)!.method).toBe("Runtime.releaseObjectGroup");
      expect(h.calls.some((call) => call.method === "Runtime.callFunctionOn")).toBe(false);
    });
  });

  it.each([
    { fixture: "snapshot-coordinates", zoom: 1 },
    { fixture: "snapshot-coordinates", zoom: 1.25 },
    { fixture: "oopif-scrollbars", zoom: 1 },
    { fixture: "oopif-scrollbars", zoom: 0.8 },
  ])("scrolls nested frames: $fixture at zoom $zoom", async ({ fixture, zoom }) => {
    const { createEvalServer } = await import(
      new URL("../../../../../evals/browser/lib/server.mjs", import.meta.url).href
    );
    const server = createEvalServer();
    const { baseUrl } = await server.start();
    try {
      await withBrowser(async (h) => {
        await h.send("Page.navigate", { url: `${baseUrl}/${fixture}?run=scroll` }, h.rootSession);
        await expect
          .poll(
            () =>
              server
                .snapshot("scroll")
                .events.some(
                  (e: { type: string; data: { root?: boolean } }) =>
                    e.type === "geometry.ready" && e.data.root,
                ),
            { timeout: 10_000 },
          )
          .toBe(true);
        const frames = await h.loadFrames();
        expect(frames.length).toBe(fixture === "snapshot-coordinates" ? 5 : 3);
        for (const frame of frames) {
          const backendNodeId = await h.ref(frame);
          const result = await h.scroll({ ref: "e1" });
          const geometry = await resolveNodeGeometry(h.cdp, 4, {
            target: frame.target,
            backendNodeId,
            frameId: frame.frameId,
          });
          expect(isRpcError(geometry)).toBe(false);
          if (isRpcError(geometry)) throw new Error(geometry.message);
          await pointerTargetValidator(h.cdp)(
            { tabId: 4, cdpTarget: frame.target, backendNodeId, frameId: frame.frameId },
            geometry.actionPoint,
          );
          if (frame.target.sessionId) {
            await h.evaluate(
              "window.frameCover=document.createElement('div');frameCover.style='position:fixed;inset:0;z-index:99999;background:white';document.body.append(frameCover)",
            );
            await expect(
              pointerTargetValidator(h.cdp)(
                { tabId: 4, cdpTarget: frame.target, frameId: frame.frameId, backendNodeId },
                geometry.actionPoint,
              ),
            ).rejects.toThrow(/covered/);
            await h.evaluate("frameCover.remove()");
          }
          // Independent DOM oracle: CSS border boxes plus this fixture's known
          // axis-aligned iframe scales. Re-read after each scroll changes layout.
          let rect = await h.evaluate<ViewportRect>(
            "document.querySelector('#probe').getBoundingClientRect().toJSON()",
            frame,
          );
          let current = frame;
          while (true) {
            const viewport = await h.evaluate<ViewportRect>(
              "({ x:0, y:0, width:document.documentElement.clientWidth, height:document.documentElement.clientHeight })",
              current,
            );
            rect = intersection(rect, viewport)!;
            if (!current.parentFrameId) break;
            const parent = frames.find((f) => f.frameId === current.parentFrameId)!;
            const owner = await h.evaluate<{ x: number; y: number; scale: number }>(
              `(() => {
              const iframe = document.querySelector('iframe[name="${current.name}"]');
              const r = iframe.getBoundingClientRect(); const s = getComputedStyle(iframe);
              const scale = r.width / iframe.offsetWidth;
              return { x:r.x + (iframe.clientLeft + parseFloat(s.paddingLeft))*scale,
                y:r.y + (iframe.clientTop + parseFloat(s.paddingTop))*scale, scale };
            })()`,
              parent,
            );
            rect = {
              x: owner.x + rect.x * owner.scale,
              y: owner.y + rect.y * owner.scale,
              width: rect.width * owner.scale,
              height: rect.height * owner.scale,
            };
            current = parent;
          }
          expectRect(result, rect);
        }
        const child = frames.find((frame) => frame.parentFrameId === frames[0].frameId)!;
        await h.ref(child);
        await h.evaluate(
          `document.querySelector('iframe[name="${child.name}"]').style.opacity = '0'`,
        );
        expect(await h.scroll({ ref: "e1" })).toMatchObject({ code: "permission_denied" });
      }, zoom);
    } finally {
      await server.stop();
    }
  }, 30_000);
});

describe.skipIf(!process.env.BSK_SCROLL_CHROME)("native target hit testing", () => {
  it.each([
    { zoom: 1, dpr: 1 },
    { zoom: 1.25, dpr: 2 },
  ])("maps hover pseudo-elements to their owner without accepting an unrelated cover at $zoom zoom, DPR $dpr", async ({
    zoom,
    dpr,
  }) => {
    await withBrowser(
      async (h) => {
        for (const child of [false, true]) {
          const pseudo = child ? "after" : "before";
          const owner = child ? "#probe span" : "#probe";
          await h.evaluate(`document.body.innerHTML = ${JSON.stringify(`
          <style>
            body { width: 2400px; height: 2400px }
            #probe { position: absolute; left: 900px; top: 1200px; width: 180px; height: 60px }
            #probe span { position: absolute; inset: 0 }
            #probe:hover${child ? " span" : ""}::${pseudo} { content: ""; position: absolute; inset: 0; z-index: 1 }
            #cover { position: fixed; inset: 0; z-index: 999; pointer-events: none }
            #cover::before { content: ""; position: absolute; inset: 0; pointer-events: auto }
          </style><button id="probe"><span>Continue</span></button>`)};
          window.hits=0; document.querySelector('#probe').onclick=()=>window.hits++;
          scrollTo(600,900)`);
          const [frame] = await h.loadFrames();
          const backendNodeId = await h.ref(frame);
          const target = {
            tabId: 4,
            cdpTarget: frame.target,
            frameId: frame.frameId,
            backendNodeId,
          };
          const verify = pointerTargetValidator(h.cdp);
          const point = await h.evaluate<{ x: number; y: number }>(
            "(()=>{const r=document.querySelector('#probe').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
          );
          await h.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, h.rootSession);
          expect(
            await h.evaluate(
              `getComputedStyle(document.querySelector(${JSON.stringify(owner)}), '::${pseudo}').content`,
            ),
          ).toBe('""');
          const scroll = await h.evaluate<{ x: number; y: number }>("({x:scrollX,y:scrollY})");
          const hit = await h.send<{ backendNodeId: number }>(
            "DOM.getNodeForLocation",
            {
              x: Math.round(point.x + scroll.x),
              y: Math.round(point.y + scroll.y),
              includeUserAgentShadowDOM: false,
            },
            h.rootSession,
          );
          const { node } = await h.send<{ node: { pseudoType?: string } }>(
            "DOM.describeNode",
            {
              backendNodeId: hit.backendNodeId,
            },
            h.rootSession,
          );
          expect(node.pseudoType).toBe(pseudo);
          expect(await pointBelongsToTarget(h.cdp, target, point.x, point.y, "hit-oracle")).toBe(
            true,
          );
          await verify(target, point);
          for (const type of ["mousePressed", "mouseReleased"])
            await h.send(
              "Input.dispatchMouseEvent",
              { type, ...point, button: "left", clickCount: 1 },
              h.rootSession,
            );
          expect(await h.evaluate("window.hits")).toBe(1);
          await h.evaluate("document.body.insertAdjacentHTML('beforeend','<div id=cover></div>')");
          expect(await pointBelongsToTarget(h.cdp, target, point.x, point.y, "hit-oracle")).toBe(
            false,
          );
          await expect(verify(target, point)).rejects.toThrow(/no longer hits/);
          expect(await h.evaluate("window.hits")).toBe(1);
        }
      },
      zoom,
      dpr,
    );
  }, 30000);

  it.each([
    { zoom: 1, dpr: 1 },
    { zoom: 1, dpr: 2 },
    { zoom: 1.25, dpr: 2 },
    { zoom: 0.8, dpr: 2 },
  ])("hits the same node after scrolling in foreground/background at $zoom zoom, DPR $dpr", async ({
    zoom,
    dpr,
  }) => {
    await withBrowser(
      async (h) => {
        await h.evaluate(
          `document.body.innerHTML = '<style>body{width:3200px;height:3200px}#probe{position:absolute;left:900px;top:1200px;width:160px;height:60px}</style><button id="probe">Target<span> child</span></button>'; window.hits=0; document.querySelector('#probe').onclick=()=>window.hits++`,
        );
        const [frame] = await h.loadFrames();
        const backendNodeId = await h.ref(frame);
        const target = { tabId: 4, cdpTarget: frame.target, frameId: frame.frameId, backendNodeId };
        const verify = pointerTargetValidator(h.cdp);
        await h.evaluate("scrollTo(600,900)");
        const point = await h.evaluate<{ x: number; y: number }>(
          "(()=>{const r=document.querySelector('#probe').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
        );
        for (const background of [false, true]) {
          let other: string | undefined;
          if (background) {
            other = (
              await h.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })
            ).targetId;
            await h.send("Target.activateTarget", { targetId: other });
          }
          try {
            expect(await pointBelongsToTarget(h.cdp, target, point.x, point.y, "hit-oracle")).toBe(
              true,
            );
            await verify(target, point);
            for (const type of ["mousePressed", "mouseReleased"])
              await h.send(
                "Input.dispatchMouseEvent",
                { type, ...point, button: "left", clickCount: 1 },
                h.rootSession,
              );
            expect(await h.evaluate("window.hits")).toBe(background ? 2 : 1);
            if (background) expect(await h.evaluate("document.visibilityState")).toBe("hidden");
            await h.evaluate(
              `window.cover=document.createElement('div'); cover.style='position:fixed;inset:0;background:white;z-index:99999';document.body.append(cover)`,
            );
            expect(await pointBelongsToTarget(h.cdp, target, point.x, point.y, "hit-oracle")).toBe(
              false,
            );
            await expect(verify(target, point)).rejects.toThrow(/covered|no longer hits/);
            expect(await h.evaluate("window.hits")).toBe(background ? 2 : 1);
            await h.evaluate("cover.remove()");
          } finally {
            if (other) await h.send("Target.closeTarget", { targetId: other });
          }
        }
        await h.evaluate("document.querySelector('#probe').style.left='950px'");
        await expect(verify(target, point)).rejects.toThrow(/moved/);
        expect(await h.evaluate("window.hits")).toBe(2);
      },
      zoom,
      dpr,
    );
  }, 30000);
});
