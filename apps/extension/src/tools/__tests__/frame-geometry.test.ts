import { describe, expect, it, vi } from "vitest";
import { resolveFrameProjection, resolveNodeGeometry } from "../frame-geometry";
import {
  clipPolygon,
  polygonArea,
  polygonBounds,
  projectAndClipRegion,
  projectUnitPoint,
  type Quad,
  rectPolygon,
  regionBounds,
} from "../geometry";
import type { CdpRunner } from "../shared";

describe("frame geometry projection", () => {
  it("keeps region bounds separate from polygon area", () => {
    const region = [
      rectPolygon({ x: 0, y: 0, w: 10, h: 10 }),
      rectPolygon({ x: 20, y: 5, w: 5, h: 5 }),
    ];
    expect(regionBounds(region)).toEqual({ x: 0, y: 0, width: 25, height: 10 });
    expect(polygonArea(region[0])).toBe(100);
  });

  it("maps through the iframe content box instead of its border box", () => {
    const contentQuad: Quad = [
      { x: 204, y: 306 },
      { x: 604, y: 306 },
      { x: 604, y: 506 },
      { x: 204, y: 506 },
    ];
    const projected = projectAndClipRegion(
      [rectPolygon({ x: 10, y: 20, w: 100, h: 40 })],
      [{ sourceViewport: { width: 200, height: 100 }, destinationQuad: contentQuad }],
      { width: 1000, height: 800 },
    );
    expect(polygonBounds(projected.flat())).toEqual({ x: 224, y: 346, width: 200, height: 80 });
  });

  it("uses a projective mapping for perspective-transformed iframe quads", () => {
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: 200, y: 20 },
      { x: 180, y: 140 },
      { x: 20, y: 100 },
    ];
    expect(projectUnitPoint({ x: 0, y: 0 }, quad)).toEqual(quad[0]);
    expect(projectUnitPoint({ x: 1, y: 0 }, quad)).toEqual(quad[1]);
    expect(projectUnitPoint({ x: 1, y: 1 }, quad)).toEqual(quad[2]);
    expect(projectUnitPoint({ x: 0, y: 1 }, quad)).toEqual(quad[3]);
  });

  it("clips against the iframe polygon rather than its bounding box", () => {
    const frameQuad: Quad = [
      { x: 50, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 50 },
    ];
    expect(clipPolygon(rectPolygon({ x: 0, y: 0, w: 10, h: 10 }), frameQuad)).toEqual([]);
  });

  it("does not reapply same-target frame transforms around an OOPIF", async () => {
    const send = vi.fn(async (_tabId, method, params) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      if (method === "DOM.getBoxModel") {
        const backendNodeId = (params as { backendNodeId?: number }).backendNodeId;
        return backendNodeId === 20
          ? { model: { content: [110, 70, 310, 70, 310, 170, 110, 170] } }
          : { model: { content: [100, 50, 400, 50, 400, 250, 100, 250] } };
      }
      throw new Error(`unexpected root command ${method}`);
    });
    const cdp: CdpRunner = {
      send: send as CdpRunner["send"],
      sendToTarget: vi.fn(async (_target, method) => {
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 200, clientHeight: 100 } };
        }
        throw new Error(`unexpected child command ${method}`);
      }) as CdpRunner["sendToTarget"],
    };
    const projection = await resolveFrameProjection(
      cdp,
      {
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          {
            frameId: "same-process-parent",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            target: { tabId: 4 },
          },
          {
            frameId: "oopif",
            parentFrameId: "same-process-parent",
            ownerBackendNodeId: 20,
            target: { tabId: 4, sessionId: "oopif-session" },
          },
        ],
      },
      "oopif",
    );

    expect(projection?.edges).toEqual([
      {
        sourceViewport: { width: 200, height: 100 },
        destinationQuad: [
          { x: 110, y: 70 },
          { x: 310, y: 70 },
          { x: 310, y: 170 },
          { x: 110, y: 170 },
        ],
        destinationClips: [
          [
            { x: 100, y: 50 },
            { x: 400, y: 50 },
            { x: 400, y: 250 },
            { x: 100, y: 250 },
          ],
        ],
      },
    ]);
  });

  it("clips live OOPIF geometry at every frame boundary", async () => {
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method) => {
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
        }
        if (method === "DOM.getBoxModel") {
          return { model: { content: [100, 100, 300, 100, 300, 200, 100, 200] } };
        }
        throw new Error(`unexpected root command ${method}`);
      }) as CdpRunner["send"],
      sendToTarget: vi.fn(async (_target, method) => {
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 200, clientHeight: 100 } };
        }
        if (method === "DOM.getContentQuads") {
          return { quads: [[-50, -20, 250, -20, 250, 120, -50, 120]] };
        }
        throw new Error(`unexpected child command ${method}`);
      }) as CdpRunner["sendToTarget"],
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          {
            frameId: "child",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            target: { tabId: 4, sessionId: "child-session" },
          },
        ],
      })),
    };

    const geometry = await resolveNodeGeometry(cdp, 4, {
      target: { tabId: 4, sessionId: "child-session" },
      frameId: "child",
      backendNodeId: 101,
    });

    expect(geometry).toMatchObject({
      topBounds: { x: 100, y: 100, width: 200, height: 100 },
      actionPoint: { x: 200, y: 150 },
      targetActionPoint: { x: 100, y: 50 },
    });
  });

  it("reuses one frame graph while scrolling and projecting live geometry", async () => {
    const getFrameGraph = vi.fn(async () => ({
      rootFrameId: "main",
      frames: [
        { frameId: "main", target: { tabId: 4 } },
        {
          frameId: "child",
          parentFrameId: "main",
          ownerBackendNodeId: 10,
          target: { tabId: 4, sessionId: "child-session" },
        },
      ],
    }));
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method) => {
        if (method === "DOM.scrollIntoViewIfNeeded") return {};
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
        }
        if (method === "DOM.getBoxModel") {
          return { model: { content: [100, 100, 300, 100, 300, 200, 100, 200] } };
        }
        throw new Error(`unexpected root command ${method}`);
      }) as CdpRunner["send"],
      sendToTarget: vi.fn(async (_target, method) => {
        if (method === "DOM.scrollIntoViewIfNeeded") return {};
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 200, clientHeight: 100 } };
        }
        if (method === "DOM.getContentQuads") {
          return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
        }
        throw new Error(`unexpected child command ${method}`);
      }) as CdpRunner["sendToTarget"],
      getFrameGraph,
    };

    await expect(
      resolveNodeGeometry(
        cdp,
        4,
        {
          target: { tabId: 4, sessionId: "child-session" },
          frameId: "child",
          backendNodeId: 101,
        },
        { scrollIntoView: true },
      ),
    ).resolves.not.toMatchObject({ code: expect.any(String) });
    expect(getFrameGraph).toHaveBeenCalledOnce();
  });

  it("clips live geometry to same-target iframe ancestors", async () => {
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method) => {
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
        }
        if (method === "DOM.getBoxModel") {
          return { model: { content: [100, 100, 300, 100, 300, 200, 100, 200] } };
        }
        if (method === "DOM.getContentQuads") {
          return { quads: [[50, 50, 350, 50, 350, 250, 50, 250]] };
        }
        throw new Error(`unexpected ${method}`);
      }) as CdpRunner["send"],
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          {
            frameId: "child",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            target: { tabId: 4 },
          },
        ],
      })),
    };

    const geometry = await resolveNodeGeometry(cdp, 4, {
      target: { tabId: 4 },
      frameId: "child",
      backendNodeId: 101,
    });

    expect(geometry).toMatchObject({
      topBounds: { x: 100, y: 100, width: 200, height: 100 },
      actionPoint: { x: 200, y: 150 },
      targetActionPoint: { x: 200, y: 150 },
    });
  });

  it("fails closed when an OOPIF frame graph is unavailable", async () => {
    const cdp: CdpRunner = {
      send: vi.fn(),
      sendToTarget: vi.fn(async (_target, method) => {
        if (method === "DOM.getContentQuads") {
          return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
        }
        throw new Error(`unexpected ${method}`);
      }) as CdpRunner["sendToTarget"],
    };

    await expect(
      resolveNodeGeometry(cdp, 4, {
        target: { tabId: 4, sessionId: "child-session" },
        frameId: "child",
        backendNodeId: 101,
      }),
    ).resolves.toMatchObject({ code: "cdp_failed" });
  });
});
