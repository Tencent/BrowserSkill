import { describe, expect, it } from "vitest";
import type { CdpFrameGraph, CdpTarget } from "@/browser-driver/frame-graph";
import { projectPolygon, type Quad, unprojectPoint } from "../geometry";
import type { CdpRunner } from "../shared";
import { pointReachesTarget } from "../target-hit";

describe("inverse input projection", () => {
  it.each<Quad>([
    [
      { x: 100, y: 50 },
      { x: 500, y: 50 },
      { x: 500, y: 350 },
      { x: 100, y: 350 },
    ],
    [
      { x: 120, y: 20 },
      { x: 500, y: 70 },
      { x: 420, y: 400 },
      { x: 50, y: 300 },
    ],
    [
      { x: 400, y: 20 },
      { x: 350, y: 300 },
      { x: 50, y: 250 },
      { x: 100, y: 0 },
    ],
  ])("round-trips an offset point through translated, rotated and perspective frames", (...quad) => {
    const edge = { sourceViewport: { width: 600, height: 400 }, destinationQuad: quad as Quad };
    const source = { x: 110, y: 280 };
    const actual = unprojectPoint(projectPolygon([source], edge)[0], edge);
    expect(actual?.x).toBeCloseTo(source.x, 8);
    expect(actual?.y).toBeCloseTo(source.y, 8);
  });

  it("rejects a singular frame projection", () => {
    expect(
      unprojectPoint(
        { x: 1, y: 1 },
        {
          sourceViewport: { width: 100, height: 100 },
          destinationQuad: Array.from({ length: 4 }, () => ({ x: 0, y: 0 })) as Quad,
        },
      ),
    ).toBeNull();
  });
});

function nestedFrames(blocked?: string) {
  const root = { tabId: 4 };
  const parent = { tabId: 4, sessionId: "parent" };
  const child = { tabId: 4, sessionId: "child" };
  const graph: CdpFrameGraph = {
    rootFrameId: "root-frame",
    frames: [
      { frameId: "root-frame", target: root },
      {
        frameId: "parent-frame",
        parentFrameId: "root-frame",
        target: parent,
        ownerBackendNodeId: 100,
      },
      {
        frameId: "child-frame",
        parentFrameId: "parent-frame",
        target: child,
        ownerBackendNodeId: 200,
      },
    ],
  };
  const hits: { target: string; x: number; y: number }[] = [];
  const released: string[] = [];
  const request = async (target: CdpTarget, method: string, params?: object): Promise<unknown> => {
    const key = target.sessionId ?? "root";
    const p = params as Record<string, unknown>;
    const sizes = { root: [1000, 800], parent: [400, 300], child: [200, 100] };
    const [width, height] = sizes[key as keyof typeof sizes];
    switch (method) {
      case "Page.getLayoutMetrics":
        return {
          cssLayoutViewport: { clientWidth: width, clientHeight: height, pageX: 0, pageY: 0 },
        };
      case "Runtime.evaluate":
        return { result: { value: { width, height } } };
      case "DOM.getBoxModel":
        return {
          model: {
            content:
              p.backendNodeId === 100
                ? [100, 50, 500, 50, 500, 350, 100, 350]
                : [20, 30, 220, 30, 220, 130, 20, 130],
          },
        };
      case "DOM.getNodeForLocation":
        hits.push({ target: key, x: p.x as number, y: p.y as number });
        return {
          backendNodeId: blocked === key ? 999 : { root: 100, parent: 200, child: 9 }[key],
          frameId: `${key}-frame`,
        };
      case "DOM.resolveNode":
        return { object: { objectId: `${key}:${p.backendNodeId}` } };
      case "Runtime.callFunctionOn":
        return {
          result: { value: p.objectId === (p.arguments as { objectId: string }[])[0].objectId },
        };
      case "Runtime.releaseObjectGroup":
        released.push(key);
        return {};
      default:
        throw new Error(`Unexpected method ${method}`);
    }
  };
  const cdp: CdpRunner = {
    send: ((_tab, method, params) => request(root, method, params)) as CdpRunner["send"],
    sendToTarget: request as CdpRunner["sendToTarget"],
    getFrameGraph: async () => graph,
  };
  return {
    cdp,
    hits,
    released,
    target: { tabId: 4, cdpTarget: child, backendNodeId: 9, frameId: "child-frame" },
  };
}

describe("pointer hit through frame ancestors", () => {
  it("checks every owner and the leaf at the inverse-projected root input point", async () => {
    const h = nestedFrames();
    expect(await pointReachesTarget(h.cdp, h.target, { x: 220, y: 130 })).toBe(true);
    expect(h.hits).toEqual([
      { target: "root", x: 220, y: 130 },
      { target: "parent", x: 120, y: 80 },
      { target: "child", x: 100, y: 50 },
    ]);
    expect(h.released).toEqual(["root", "parent", "child"]);
  });

  it.each([
    "root",
    "parent",
    "child",
  ])("rejects an overlay in %s and releases handles", async (blocked) => {
    const h = nestedFrames(blocked);
    expect(await pointReachesTarget(h.cdp, h.target, { x: 220, y: 130 })).toBe(false);
    expect(h.hits.at(-1)?.target).toBe(blocked);
    expect(h.released).toEqual(h.hits.map((hit) => hit.target));
  });

  it("fails closed when an out-of-process target has no frame identity", async () => {
    const h = nestedFrames();
    expect(
      await pointReachesTarget(h.cdp, { ...h.target, frameId: undefined }, { x: 220, y: 130 }),
    ).toBe(false);
    expect(h.hits).toEqual([]);
  });

  it("fails closed when the frame belongs to a replacement target", async () => {
    const h = nestedFrames();
    expect(
      await pointReachesTarget(
        h.cdp,
        { ...h.target, cdpTarget: { tabId: 4, sessionId: "retired-child" } },
        { x: 220, y: 130 },
      ),
    ).toBe(false);
    expect(h.hits).toEqual([]);
  });
});
