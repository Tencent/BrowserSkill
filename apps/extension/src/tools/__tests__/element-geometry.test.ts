import { describe, expect, it } from "vitest";
import { nodeBoundingRect, quadBoundingRect } from "../element-geometry";
import type { CdpRunner } from "../shared";

describe("quadBoundingRect", () => {
  it("computes axis-aligned bounds from an 8-double quad", () => {
    expect(quadBoundingRect([10, 20, 110, 20, 110, 60, 10, 60])).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 40,
    });
  });

  it("returns null for degenerate quads", () => {
    expect(quadBoundingRect([0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(quadBoundingRect([1, 2, 3])).toBeNull();
  });
});

describe("nodeBoundingRect", () => {
  it("falls back to visible descendant bounds for zero-size containers", async () => {
    const calls: Array<{ method: string; params?: object }> = [];
    const send = async (_tabId: number, method: string, params?: object) => {
      calls.push({ method, params });
      switch (method) {
        case "DOM.getContentQuads":
          return { quads: [[245, 468, 1005, 468, 1005, 468, 245, 468]] };
        case "DOM.getBoxModel":
          return { model: { content: [245, 468, 1005, 468, 1005, 468, 245, 468] } };
        case "DOM.resolveNode":
          return { object: { objectId: "node-1" } };
        case "Runtime.callFunctionOn":
          return { result: { value: { x: 242, y: 468, width: 769, height: 180 } } };
        default:
          throw new Error(`unexpected CDP call ${method}`);
      }
    };
    const cdp = { send: send as CdpRunner["send"] };

    await expect(nodeBoundingRect(cdp, 7, 555)).resolves.toEqual({
      x: 242,
      y: 468,
      width: 769,
      height: 180,
    });
    expect(calls.map((c) => c.method)).toEqual([
      "DOM.getContentQuads",
      "DOM.getBoxModel",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
    ]);
  });
});
