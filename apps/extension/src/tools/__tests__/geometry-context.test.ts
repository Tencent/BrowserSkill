import { describe, expect, it, vi } from "vitest";
import type { CdpFrameGraph } from "@/browser-driver/frame-graph";
import { resolveNodeGeometry } from "../frame-geometry";
import { rectPolygon } from "../geometry";
import {
  projectSnapshotRect,
  screenshotPageRect,
  snapshotViewportRect,
} from "../geometry/coordinate-types";
import { GeometryContext } from "../geometry/frame-context";
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
      return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 1000 } };
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
    const input = snapshotViewportRect([17, 23, 120, 40], source, { x: 0, y: 0 });
    expect(projectSnapshotRect(input!, projection!)).toEqual({
      x: 73.75,
      y: 641.25,
      width: 150,
      height: 50,
    });
    const scrolled = snapshotViewportRect([17, 23, 120, 40], source, { x: 0, y: 10 });
    expect(projectSnapshotRect(scrolled!, projection!)?.y).toBe(628.75);
    await context.snapshotProjection(source, 10, [], { width: 1000, height: 1000 });
    expect(cdp.calls.mock.calls.filter(([, method]) => method === "DOM.resolveNode")).toHaveLength(
      1,
    );
    expect(
      cdp.calls.mock.calls.filter(([, method]) => method === "Runtime.releaseObject"),
    ).toHaveLength(1);
  });

  it("rejects owner mismatches and invalid numeric bounds", () => {
    const input = snapshotViewportRect(
      [30, 50, 120, 40],
      { target, frameId: "main" },
      { x: 10, y: 20 },
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
    expect(snapshotViewportRect([0, 0, NaN, 40], { target }, { x: 0, y: 0 })).toBeNull();
    expect(snapshotViewportRect([0, 0, 10, 40], { target }, { x: Infinity, y: 0 })).toBeNull();
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
    ).toBeNull();
  });

  it("keeps ancestor clips in target coordinates instead of applying nested offsets twice", async () => {
    const cdp = driver();
    const projection = await new GeometryContext(cdp, 4).snapshotProjection(
      { target, frameId: "nested" },
      10,
      [rectPolygon({ x: 60, y: 620, w: 100, h: 100 })],
      { width: 1000, height: 1000 },
    );
    const input = snapshotViewportRect(
      [0, 0, 300, 200],
      { target, frameId: "nested" },
      { x: 0, y: 0 },
    );
    expect(projectSnapshotRect(input!, projection!)).toEqual({
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
      return { cssLayoutViewport: { clientWidth: 100, clientHeight: 100 } };
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
