import { describe, expect, it, vi } from "vitest";
import type { CdpFrameGraph } from "@/browser-driver/frame-graph";
import { resolveNodeGeometry } from "../frame-geometry";
import { rectPolygon } from "../geometry";
import {
  projectSnapshotRect,
  screenshotPageRect,
  snapshotCoordinates,
  snapshotViewportRect,
} from "../geometry/coordinate-types";
import { GeometryContext, snapshotLayoutScale } from "../geometry/frame-context";
import type { CdpRunner } from "../shared";

const target = { tabId: 4 };
const graph: CdpFrameGraph = {
  rootFrameId: "main",
  frames: [
    { frameId: "main", target },
    { frameId: "child", parentFrameId: "main", ownerBackendNodeId: 10, target },
  ],
};

function driver() {
  const send = vi.fn(async (_tab: number, method: string): Promise<object> => {
    if (method === "Page.getLayoutMetrics")
      return {
        visualViewport: { clientWidth: 1000 },
        cssVisualViewport: { clientWidth: 1000 },
        cssLayoutViewport: { clientWidth: 1000, clientHeight: 1000 },
      };
    if (method === "DOM.getBoxModel")
      return { model: { content: [52.5, 612.5, 427.5, 612.5, 427.5, 862.5, 52.5, 862.5] } };
    if (method === "DOM.resolveNode") return { object: { objectId: "owner" } };
    if (method === "Runtime.callFunctionOn")
      return { result: { value: { width: 300, height: 200 } } };
    if (method === "Runtime.releaseObject") return {};
    throw new Error(method);
  });
  return { send: send as CdpRunner["send"], getFrameGraph: vi.fn(async () => graph), calls: send };
}

describe("measurement geometry context", () => {
  it.each([0.8, 1, 1.25, 2])("normalizes snapshot layout units at scale %s", (scale) => {
    const measured = snapshotLayoutScale({
      visualViewport: { clientWidth: 997.25, zoom: 1.1 },
      cssVisualViewport: { clientWidth: 997.25 / scale, zoom: 1.1 },
      // Rounded layout dimensions must not supply the scale.
      layoutViewport: { clientWidth: 997 },
      cssLayoutViewport: { clientWidth: Math.floor(997.25 / scale) },
    });
    expect(measured).toBeCloseTo(scale, 12);
    const coordinates = snapshotCoordinates(
      { scrollOffsetX: 80 * scale, scrollOffsetY: 200 * scale },
      measured,
      { x: 999, y: 999 },
    );
    expect(
      snapshotViewportRect(
        [160 * scale, 320 * scale, 120 * scale, 40 * scale],
        { target },
        coordinates,
      )?.rect,
    ).toEqual({ x: 80, y: 120, width: 120, height: 40 });
  });

  it("uses CSS root scroll only for missing snapshot offsets, without scaling it twice", () => {
    const coordinates = snapshotCoordinates({ scrollOffsetX: 80 }, 2, { x: 999, y: 100 });
    expect(snapshotViewportRect([200, 800, 240, 80], { target }, coordinates)?.rect).toEqual({
      x: 60,
      y: 300,
      width: 120,
      height: 40,
    });
    expect(snapshotCoordinates({ scrollOffsetX: 0 }, 2)).toBeNull();
    expect(
      snapshotCoordinates({ scrollOffsetX: NaN, scrollOffsetY: 0 }, 2, { x: 0, y: 0 }),
    ).toBeNull();
  });

  it("does not infer snapshot units from missing, invalid, or CSS-only metrics", () => {
    expect(snapshotLayoutScale({ cssLayoutViewport: { clientWidth: 800 } })).toBeNull();
    for (const raw of [0, -1, NaN, Infinity]) {
      expect(
        snapshotLayoutScale({
          visualViewport: { clientWidth: raw },
          cssVisualViewport: { clientWidth: 800 },
        }),
      ).toBeNull();
    }
    expect(
      snapshotLayoutScale({
        visualViewport: { clientWidth: 0, clientHeight: 600 },
        cssVisualViewport: { clientWidth: 0, clientHeight: 300 },
      }),
    ).toBe(2);
    expect(snapshotCoordinates({ scrollOffsetX: 0, scrollOffsetY: 0 }, null)).toBeNull();
    expect(snapshotViewportRect([10, 20, 120, 40], { target }, null)).toBeNull();
  });

  it("shares in-flight frame measurements, but never shares them with the next context", async () => {
    const cdp = driver();
    const context = new GeometryContext(cdp, 4);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => context.targetProjection("child")),
    );
    expect(results.every((value) => value === results[0])).toBe(true);
    expect(cdp.getFrameGraph).toHaveBeenCalledTimes(1);
    expect(cdp.calls.mock.calls.map(([, method]) => method)).toEqual([
      "Page.getLayoutMetrics",
      "DOM.getBoxModel",
    ]);
    await new GeometryContext(cdp, 4).targetProjection("child");
    expect(cdp.getFrameGraph).toHaveBeenCalledTimes(2);
    expect(cdp.calls.mock.calls).toHaveLength(4);
  });

  it("projects frame-local snapshot CSS bounds through the scaled owner content quad", async () => {
    const cdp = driver();
    const context = new GeometryContext(cdp, 4);
    const source = { target, frameId: "child" };
    const projection = await context.snapshotProjection(source, 10, [], {
      width: 1000,
      height: 1000,
    });
    if (projection.status !== "available") throw new Error("expected available projection");
    const input = snapshotViewportRect([17, 23, 120, 40], source, {
      layoutUnitsPerCssPixel: 1,
      scrollCss: { x: 0, y: 0 },
    });
    expect(projectSnapshotRect(input!, projection.projection)).toEqual({
      x: 73.75,
      y: 641.25,
      width: 150,
      height: 50,
    });
    const scrolled = snapshotViewportRect([17, 23, 120, 40], source, {
      layoutUnitsPerCssPixel: 1,
      scrollCss: { x: 0, y: 10 },
    });
    expect(projectSnapshotRect(scrolled!, projection.projection)?.y).toBe(628.75);
    await context.snapshotProjection(source, 10, [], { width: 1000, height: 1000 });
    expect(cdp.calls.mock.calls.filter(([, method]) => method === "DOM.resolveNode")).toHaveLength(
      1,
    );
    expect(
      cdp.calls.mock.calls.filter(([, method]) => method === "Runtime.releaseObject"),
    ).toHaveLength(1);
  });

  it("falls back only for missing or invalid batch entries and does not reuse sizes across contexts", async () => {
    const cdp = driver();
    const original = cdp.send;
    const calls: string[] = [];
    cdp.send = async (tabId, method, params) => {
      calls.push(method);
      if (method === "Runtime.evaluate")
        return {
          result: {
            deepSerializedValue: {
              type: "array",
              value: [
                {
                  type: "array",
                  value: [
                    { type: "node", value: { backendNodeId: 10 } },
                    { type: "string", value: '{"width":300,"height":200}' },
                  ],
                },
                {
                  type: "array",
                  value: [
                    { type: "node", value: { backendNodeId: 11 } },
                    { type: "string", value: '{"width":0,"height":200}' },
                  ],
                },
              ],
            },
          },
        } as never;
      if (method === "Runtime.releaseObjectGroup") return {} as never;
      return original(tabId, method, params);
    };
    const context = new GeometryContext(cdp, 4);
    context.registerSnapshotOwners(target, new Set([10, 11]));
    const values = await Promise.all(
      [10, 11].map((id) =>
        context.snapshotProjection({ target, frameId: String(id) }, id, [], {
          width: 1000,
          height: 1000,
        }),
      ),
    );
    expect(values.every((value) => value.status === "available")).toBe(true);
    expect(calls.filter((method) => method === "DOM.resolveNode")).toHaveLength(1);
    expect(calls.filter((method) => method === "Runtime.evaluate")).toHaveLength(1);
    await new GeometryContext(cdp, 4).snapshotProjection({ target, frameId: "child" }, 10, [], {
      width: 1000,
      height: 1000,
    });
    expect(calls.filter((method) => method === "DOM.resolveNode")).toHaveLength(2);
  });

  it("waits for batch object cleanup and propagates cancellation", async () => {
    const cdp = driver();
    const original = cdp.send;
    const controller = new AbortController();
    let release!: () => void;
    let cleanup!: () => void;
    const started = new Promise<void>((resolve) => {
      cleanup = resolve;
    });
    cdp.send = async (tabId, method, params) => {
      if (method === "Runtime.evaluate") return {} as never;
      if (method === "Runtime.releaseObjectGroup") {
        cleanup();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {} as never;
      }
      return original(tabId, method, params);
    };
    const context = new GeometryContext(cdp, 4, undefined, controller.signal);
    context.registerSnapshotOwners(target, new Set([10, 11]));
    let settled = false;
    const operation = context
      .snapshotProjection({ target, frameId: "child" }, 10, [], { width: 1000, height: 1000 })
      .finally(() => {
        settled = true;
      });
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await started;
    controller.abort();
    expect(settled).toBe(false);
    release();
    await rejected;
    expect(cdp.calls.mock.calls.some(([, method]) => method === "DOM.resolveNode")).toBe(false);
  });

  it("rejects owner mismatches and invalid numeric bounds", () => {
    const input = snapshotViewportRect(
      [30, 50, 120, 40],
      { target, frameId: "main" },
      { layoutUnitsPerCssPixel: 1, scrollCss: { x: 10, y: 20 } },
    )!;
    const projection = {
      source: { target, frameId: "main" },
      geometry: { sourceClips: [], edges: [], topViewport: { width: 800, height: 600 } },
    };
    expect(projectSnapshotRect(input, projection)).toEqual({
      x: 20,
      y: 30,
      width: 120,
      height: 40,
    });
    expect(
      projectSnapshotRect(input, { ...projection, source: { target, frameId: "other" } }),
    ).toBeNull();
    expect(
      projectSnapshotRect(input, {
        ...projection,
        source: { target: { tabId: 5 }, frameId: "main" },
      }),
    ).toBeNull();
    expect(
      snapshotViewportRect(
        [0, 0, NaN, 40],
        { target },
        { layoutUnitsPerCssPixel: 1, scrollCss: { x: 0, y: 0 } },
      ),
    ).toBeNull();
    expect(
      snapshotViewportRect(
        [0, 0, 10, 40],
        { target },
        { layoutUnitsPerCssPixel: 1, scrollCss: { x: Infinity, y: 0 } },
      ),
    ).toBeNull();
  });

  it("does not turn a border quad or a failed owner read into a content projection", async () => {
    const cdp: CdpRunner = {
      send: vi.fn(async () => ({
        model: { border: [0, 0, 100, 0, 100, 100, 0, 100] },
      })) as CdpRunner["send"],
    };
    expect(
      await new GeometryContext(cdp, 4).snapshotProjection({ target, frameId: "child" }, 10, [], {
        width: 100,
        height: 100,
      }),
    ).toEqual({
      status: "unavailable",
      source: { target, frameId: "child" },
      ownerBackendNodeId: 10,
    });
  });

  it("keeps ancestor clips in target coordinates instead of applying nested offsets twice", async () => {
    const cdp = driver();
    const projection = await new GeometryContext(cdp, 4).snapshotProjection(
      { target, frameId: "nested" },
      10,
      [rectPolygon({ x: 60, y: 620, w: 100, h: 100 })],
      { width: 1000, height: 1000 },
    );
    if (projection.status !== "available") throw new Error("expected available projection");
    const input = snapshotViewportRect(
      [0, 0, 300, 200],
      { target, frameId: "nested" },
      { layoutUnitsPerCssPixel: 1, scrollCss: { x: 0, y: 0 } },
    );
    expect(projectSnapshotRect(input!, projection.projection)).toEqual({
      x: 60,
      y: 620,
      width: 100,
      height: 100,
    });
  });

  it("rejects malformed frame ancestry without looping", async () => {
    const cdp = driver();
    const cycle: CdpFrameGraph = {
      rootFrameId: "a",
      frames: [
        { frameId: "a", parentFrameId: "b", target },
        { frameId: "b", parentFrameId: "a", target },
      ],
    };
    expect(await new GeometryContext(cdp, 4, cycle).targetProjection("a")).toBeNull();
    expect(cdp.calls).not.toHaveBeenCalled();
    const orphan: CdpFrameGraph = {
      rootFrameId: "a",
      frames: [{ frameId: "a", parentFrameId: "missing", target }],
    };
    expect(await new GeometryContext(cdp, 4, orphan).targetProjection("a")).toBeNull();
  });

  it("rejects a live node whose frame belongs to another target before any DOM input", async () => {
    const cdp = driver();
    expect(
      await resolveNodeGeometry(
        cdp,
        4,
        { target: { tabId: 4, sessionId: "wrong" }, frameId: "child", backendNodeId: 20 },
        { scrollIntoView: true },
      ),
    ).toMatchObject({ code: "cdp_failed" });
    expect(cdp.calls).not.toHaveBeenCalled();
  });

  it("bounds concurrent measurements and does not dispatch queued reads after cancellation", async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const send = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active--;
      return {
        visualViewport: { clientWidth: 1000 },
        cssVisualViewport: { clientWidth: 1000 },
        cssLayoutViewport: { clientWidth: 100, clientHeight: 100 },
      };
    });
    const controller = new AbortController();
    const context = new GeometryContext(
      { send: send as CdpRunner["send"] },
      4,
      undefined,
      controller.signal,
    );
    const tasks = Array.from({ length: 8 }, (_, index) =>
      context.viewport({ tabId: 4, sessionId: String(index) }),
    );
    const settled = Promise.allSettled(tasks);
    expect(send).toHaveBeenCalledTimes(4);
    controller.abort();
    for (const done of release) done();
    const results = await settled;
    expect(peak).toBe(4);
    expect(send).toHaveBeenCalledTimes(4);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(4);
  });

  it("releases an owner object even when cancellation arrives before its viewport read", async () => {
    const controller = new AbortController();
    const cdp = driver();
    const original = cdp.calls.getMockImplementation()!;
    cdp.calls.mockImplementation(async (tab, method) => {
      const result = await original(tab, method);
      if (method === "DOM.resolveNode") controller.abort();
      return result;
    });
    const context = new GeometryContext(cdp, 4, undefined, controller.signal);
    await expect(
      context.snapshotProjection({ target, frameId: "child" }, 10, [], {
        width: 1000,
        height: 1000,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cdp.calls.mock.calls.map(([, method]) => method)).toEqual([
      "DOM.getBoxModel",
      "DOM.resolveNode",
      "Runtime.releaseObject",
    ]);
  });

  it("reads live owner geometry only after scrolling", async () => {
    const cdp = driver();
    const original = cdp.calls.getMockImplementation()!;
    let scrolled = false;
    cdp.calls.mockImplementation(async (tab, method) => {
      if (method === "DOM.scrollIntoViewIfNeeded") {
        scrolled = true;
        return {};
      }
      if (method === "DOM.getContentQuads") {
        expect(scrolled).toBe(true);
        return { quads: [[60, 620, 100, 620, 100, 640, 60, 640]] };
      }
      if (method === "DOM.getBoxModel") expect(scrolled).toBe(true);
      return original(tab, method);
    });
    expect(
      await resolveNodeGeometry(
        cdp,
        4,
        { target, frameId: "child", backendNodeId: 20 },
        { scrollIntoView: true },
      ),
    ).toMatchObject({ topBounds: { x: 60, y: 620, width: 40, height: 20 } });
    expect(cdp.getFrameGraph).toHaveBeenCalledTimes(1);
    expect(cdp.calls.mock.calls.filter(([, method]) => method === "DOM.getBoxModel")).toHaveLength(
      1,
    );
  });

  it("adapts viewport CSS bounds to page DIP with scroll and browser zoom, never raster DPR", () => {
    const viewport = { width: 1600, height: 1000, scrollX: 10, scrollY: 100, cssToDip: 0.9 };
    const clip = screenshotPageRect({ x: 20, y: 30, width: 120, height: 40 }, viewport);
    expect(clip).toEqual({ space: "page-dip", rect: { x: 27, y: 117, width: 108, height: 36 } });
    expect(
      screenshotPageRect({ x: 20, y: 30, width: 120, height: 40 }, { ...viewport, cssToDip: NaN }),
    ).toBeNull();
    expect(
      screenshotPageRect({ x: 20, y: 30, width: 120, height: 40 }, { ...viewport, cssToDip: 0 }),
    ).toBeNull();
  });

  it("retries a rejected measurement only in a new operation", async () => {
    const cdp = driver();
    cdp.calls.mockRejectedValueOnce(new Error("unavailable"));
    const context = new GeometryContext(cdp, 4);
    await expect(context.viewport(target)).rejects.toThrow("unavailable");
    await expect(context.viewport(target)).rejects.toThrow("unavailable");
    expect(cdp.calls).toHaveBeenCalledTimes(1);
    expect(await new GeometryContext(cdp, 4).viewport(target)).toEqual({
      width: 1000,
      height: 1000,
    });
  });
});
