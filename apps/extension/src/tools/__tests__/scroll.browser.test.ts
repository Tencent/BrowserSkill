// @vitest-environment node
// Opt in with BSK_SCROLL_CHROME=/path/to/chrome. Uses an isolated browser/profile.
import { describe, expect, it } from "vitest";
import type { CdpFrame, CdpFrameGraph, CdpTarget } from "@/browser-driver/frame-graph";
import { SessionManager } from "@/session-manager/manager";
import type { ViewportRect } from "../geometry";
import { handleScrollTo } from "../scroll";
import type { CdpRunner } from "../shared";

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
    { executable: process.env.BSK_SCROLL_CHROME, deviceScale: 1, zoom },
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
  return { send, rootSession, evaluate, ref, rememberRef, scroll, loadFrames, calls, after };
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
          await h.ref(frame);
          const result = await h.scroll({ ref: "e1" });
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
