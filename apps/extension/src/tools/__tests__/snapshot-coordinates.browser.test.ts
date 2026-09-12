// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CdpFrame, CdpFrameGraph, CdpTarget } from "@/browser-driver/frame-graph";
import { resolveNodeGeometry } from "../frame-geometry";
import type { CdpRunner } from "../shared";
import { captureObservationFacts } from "../vom/capture-coordinator";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;
type Tree = { frame: { id: string; parentId?: string; name?: string }; childFrames?: Tree[] };
type Rect = { x: number; y: number; w: number; h: number };
type Oracle = {
  probes: Record<string, Rect>;
  viewport: { width: number; height: number };
  owners: Record<string, { x: number; y: number; scale: number }>;
};

function clip(rect: Rect, viewport: Oracle["viewport"]): Rect | null {
  const x = Math.max(0, rect.x),
    y = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.w);
  const bottom = Math.min(viewport.height, rect.y + rect.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

// The independent oracle uses DOM border boxes and this fixture's axis-aligned
// iframe transforms. No production snapshot conversion/projection builds expectations.
const oracleExpression = `(() => {
  const probes = {};
  for (const node of document.querySelectorAll('[data-geometry-probe]')) {
    const box = node.getBoundingClientRect();
    probes[node.id] = { x: box.x, y: box.y, w: box.width, h: box.height };
  }
  const owners = {};
  for (const frame of document.querySelectorAll('iframe')) {
    const rect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const scale = rect.width / frame.offsetWidth;
    owners[frame.name] = {
      x: rect.x + (frame.clientLeft + parseFloat(style.paddingLeft)) * scale,
      y: rect.y + (frame.clientTop + parseFloat(style.paddingTop)) * scale,
      scale,
    };
  }
  return { probes, viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }, owners };
})()`;

describe.skipIf(!process.env.BSK_GEOMETRY_CHROME)("real DOMSnapshot coordinate contract", () => {
  it.each(
    [
      { deviceScale: 1, zoom: 1 },
      { deviceScale: 0.8, zoom: 1 },
      { deviceScale: 1, zoom: 1.25 },
      { deviceScale: 2, zoom: 1 },
      { deviceScale: 2, zoom: 0.8 },
    ]
      .flatMap((configuration) => [
        { ...configuration, fixture: "snapshot-coordinates", scrollbars: "none" },
        { ...configuration, fixture: "oopif-scrollbars", scrollbars: "both" },
      ])
      .concat(
        ["vertical", "horizontal", "none"].map((scrollbars) => ({
          deviceScale: 1,
          zoom: 1,
          fixture: "oopif-scrollbars",
          scrollbars,
        })),
      ),
  )("$fixture: device scale $deviceScale, zoom $zoom, scrollbars $scrollbars", async (configuration) => {
    const evalRoot = new URL("../../../../../evals/browser/", import.meta.url);
    const { createEvalServer } = await import(new URL("lib/server.mjs", evalRoot).href);
    const { withChrome } = await import(
      new URL("cases/regression/snapshot-coordinates/chrome.mjs", evalRoot).href
    );
    const server = createEvalServer();
    const { baseUrl } = await server.start();
    try {
      await withChrome(
        { executable: process.env.BSK_GEOMETRY_CHROME, ...configuration },
        async (send: Send) => {
          const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
            url: "about:blank",
          });
          const { sessionId: rootSession } = await send<{ sessionId: string }>(
            "Target.attachToTarget",
            { targetId, flatten: true },
          );
          await send(
            "Page.navigate",
            {
              url: `${baseUrl}/${configuration.fixture}?run=coordinates&scrollbars=${configuration.scrollbars}`,
            },
            rootSession,
          );
          await expect
            .poll(
              () =>
                server
                  .snapshot("coordinates")
                  .events.some(
                    (event: { type: string; data: { root?: boolean } }) =>
                      event.type === "geometry.ready" && event.data.root,
                  ),
              { timeout: 10_000 },
            )
            .toBe(true);

          const targets = await send<{ targetInfos: { targetId: string; type: string }[] }>(
            "Target.getTargets",
          );
          const sessions = [rootSession];
          for (const target of targets.targetInfos.filter((target) => target.type === "iframe")) {
            const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId: target.targetId,
              flatten: true,
            });
            sessions.push(sessionId);
          }
          expect(sessions.length).toBe(configuration.fixture === "oopif-scrollbars" ? 3 : 2);
          const frames: CdpFrame[] = [];
          const names = new Map<string, string>();
          const sessionFor = (target: CdpTarget) => target.sessionId ?? rootSession;
          for (const sessionId of sessions) {
            const { frameTree } = await send<{ frameTree: Tree }>(
              "Page.getFrameTree",
              {},
              sessionId,
            );
            const target: CdpTarget = {
              tabId: 1,
              ...(sessionId === rootSession ? {} : { sessionId }),
            };
            const visit = (tree: Tree, parentFrameId = tree.frame.parentId) => {
              frames.push({ frameId: tree.frame.id, parentFrameId, target });
              names.set(tree.frame.id, tree.frame.name ?? "");
              for (const child of tree.childFrames ?? []) visit(child, tree.frame.id);
            };
            visit(frameTree);
          }
          expect(frames).toHaveLength(configuration.fixture === "oopif-scrollbars" ? 3 : 5);
          for (const frame of frames) {
            if (!frame.parentFrameId) continue;
            const parent = frames.find((item) => item.frameId === frame.parentFrameId)!;
            const owner = await send<{ backendNodeId: number }>(
              "DOM.getFrameOwner",
              { frameId: frame.frameId },
              sessionFor(parent.target),
            );
            frame.ownerBackendNodeId = owner.backendNodeId;
          }
          const graph: CdpFrameGraph = { rootFrameId: frames[0].frameId, frames };
          const calls: string[] = [];
          const cdp: CdpRunner = {
            send: (tabId, method, params) => {
              calls.push(`${tabId}:${method}`);
              return send(method, params, rootSession);
            },
            sendToTarget: (target, method, params) => {
              calls.push(`${target.sessionId ?? target.tabId}:${method}`);
              if (
                method === "Runtime.evaluate" &&
                (params as { expression?: string })?.expression?.includes("window.innerWidth")
              )
                calls.push(`${target.sessionId ?? target.tabId}:viewport-size`);
              return send(method, params, sessionFor(target));
            },
            getFrameGraph: async () => graph,
            getAttachmentId: () => rootSession,
          };
          const oracles = new Map<string, Oracle>();
          for (const frame of frames) {
            const session = sessionFor(frame.target);
            const { executionContextId } = await send<{ executionContextId: number }>(
              "Page.createIsolatedWorld",
              { frameId: frame.frameId, worldName: "coordinate-oracle" },
              session,
            );
            await expect
              .poll(
                async () => {
                  const ready = await send<{ result: { value: boolean } }>(
                    "Runtime.evaluate",
                    {
                      expression: 'document.documentElement.dataset.geometryReady === "true"',
                      contextId: executionContextId,
                      returnByValue: true,
                    },
                    session,
                  );
                  return ready.result.value;
                },
                { timeout: 5_000 },
              )
              .toBe(true);
            // Establish scroll after cross-process target creation/layout settles.
            const scroll = frame.parentFrameId
              ? names.get(frame.frameId) === "nested"
                ? [10, 20]
                : [40, 100]
              : [80, 240];
            await send(
              "Runtime.evaluate",
              {
                expression: `(async () => { scrollTo(${scroll.join(",")}); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()`,
                contextId: executionContextId,
                awaitPromise: true,
              },
              session,
            );
            const reply = await send<{ result: { value: Oracle } }>(
              "Runtime.evaluate",
              { expression: oracleExpression, contextId: executionContextId, returnByValue: true },
              session,
            );
            oracles.set(frame.frameId, reply.result.value);
          }
          const childViewport = await send<{
            result: {
              value: { width: number; height: number; clientWidth: number; clientHeight: number };
            };
          }>(
            "Runtime.evaluate",
            {
              expression:
                "({ width: innerWidth, height: innerHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight })",
              returnByValue: true,
            },
            sessions[1],
          );
          for (const dimension of ["Width", "Height"] as const) {
            const occupied =
              childViewport.result.value[dimension === "Width" ? "width" : "height"] -
              childViewport.result.value[`client${dimension}`];
            if (
              configuration.scrollbars === "both" ||
              configuration.scrollbars === (dimension === "Width" ? "vertical" : "horizontal")
            )
              expect(occupied).toBeGreaterThan(0);
            else expect(occupied).toBe(0);
          }
          const facts = await captureObservationFacts(cdp, 1);
          expect(facts.issues).toEqual([]);
          expect(calls.filter((call) => call.endsWith(":Page.getLayoutMetrics"))).toHaveLength(
            sessions.length,
          );
          // Identity verification also uses Runtime.evaluate; count the full viewport reads separately.
          const viewportReadsBeforeLive = calls.filter((call) => call.endsWith(":viewport-size"));
          expect(new Set(viewportReadsBeforeLive).size).toBe(viewportReadsBeforeLive.length);
          expect(viewportReadsBeforeLive.length).toBeLessThanOrEqual(sessions.length - 1);
          for (const frame of frames) {
            for (const [id, local] of Object.entries(oracles.get(frame.frameId)!.probes)) {
              const node = facts.documents
                .find((doc) => doc.frame.frameId === frame.frameId)
                ?.domNodes.find((node) => node.attrs.id === id);
              expect(node, `missing ${id} in ${names.get(frame.frameId) || "root"}`).toBeDefined();
              let top = clip(local, oracles.get(frame.frameId)!.viewport);
              let current = frame;
              while (top && current.parentFrameId) {
                const parentOracle = oracles.get(current.parentFrameId)!;
                const owner = parentOracle.owners[names.get(current.frameId)!];
                top = clip(
                  {
                    x: owner.x + top.x * owner.scale,
                    y: owner.y + top.y * owner.scale,
                    w: top.w * owner.scale,
                    h: top.h * owner.scale,
                  },
                  parentOracle.viewport,
                );
                current = frames.find((item) => item.frameId === current.parentFrameId)!;
              }
              for (const key of ["x", "y", "w", "h"] as const)
                expect(
                  Math.abs(node!.localRect![key] - local[key]),
                  `${names.get(frame.frameId)} ${id} local ${key}`,
                ).toBeLessThan(2);
              if (!top) {
                expect(node!.rect, `${id} must be clipped out`).toBeNull();
                if (configuration.fixture === "oopif-scrollbars")
                  expect(
                    await resolveNodeGeometry(cdp, 1, {
                      target: frame.target,
                      frameId: frame.frameId,
                      backendNodeId: node!.backendNodeId,
                    }),
                  ).toMatchObject({ code: "permission_denied" });
                continue;
              }
              expect(node!.rect).not.toBeNull();
              for (const key of ["x", "y", "w", "h"] as const)
                expect(
                  Math.abs(node!.rect![key] - top[key]),
                  `${names.get(frame.frameId)} ${id} top ${key}`,
                ).toBeLessThan(2);
              if (configuration.fixture !== "oopif-scrollbars") continue;
              const live = await resolveNodeGeometry(cdp, 1, {
                target: frame.target,
                frameId: frame.frameId,
                backendNodeId: node!.backendNodeId,
              });
              if ("code" in live) throw new Error(live.message);
              for (const [key, liveKey] of [
                ["x", "x"],
                ["y", "y"],
                ["w", "width"],
                ["h", "height"],
              ] as const)
                expect(
                  Math.abs(live.topBounds[liveKey] - top[key]),
                  `${id} live ${key}`,
                ).toBeLessThan(2);
              const before = server.snapshot("coordinates").events.length;
              for (const type of ["mousePressed", "mouseReleased"])
                await send(
                  "Input.dispatchMouseEvent",
                  { type, ...live.actionPoint, button: "left", clickCount: 1 },
                  rootSession,
                );
              await expect
                .poll(
                  () =>
                    server
                      .snapshot("coordinates")
                      .events.slice(before)
                      .some(
                        (event: { type: string; path: string; data: { probe?: string } }) =>
                          event.type === "geometry.clicked" &&
                          event.data.probe === id &&
                          event.path ===
                            (frame.parentFrameId
                              ? names.get(frame.frameId) === "nested"
                                ? "/oopif-scrollbars/nested"
                                : "/oopif-scrollbars/frame"
                              : "/oopif-scrollbars"),
                      ),
                  { timeout: 3000 },
                )
                .toBe(true);
            }
          }
          const metrics = await send<{
            cssVisualViewport: { zoom: number };
            visualViewport: { clientWidth: number };
          }>("Page.getLayoutMetrics", {}, rootSession);
          expect(metrics.cssVisualViewport.zoom).toBeCloseTo(configuration.zoom, 4);
        },
      );
    } finally {
      await server.stop();
    }
  }, 30_000);
});
