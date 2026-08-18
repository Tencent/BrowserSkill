import { describe, expect, it } from "vitest";
import { nodeContentRegion } from "../element-geometry";
import type { CdpRunner } from "../shared";

describe("nodeContentRegion", () => {
  it("rejects invalid content quads before using the box model fallback", async () => {
    const send = async (_tabId: number, method: string) => {
      if (method === "DOM.getContentQuads") return { quads: [[0, 0, 0, 0, 0, 0, 0, 0]] };
      if (method === "DOM.getBoxModel") {
        return { model: { content: [5, 10, 25, 10, 25, 30, 5, 30] } };
      }
      throw new Error(`unexpected CDP call ${method}`);
    };

    await expect(nodeContentRegion({ send: send as CdpRunner["send"] }, 7, 555)).resolves.toEqual([
      [
        { x: 5, y: 10 },
        { x: 25, y: 10 },
        { x: 25, y: 30 },
        { x: 5, y: 30 },
      ],
    ]);
  });

  it("preserves every visible content fragment", async () => {
    const send = async () => ({
      quads: [
        [10, 20, 60, 20, 60, 40, 10, 40],
        [15, 50, 90, 50, 90, 80, 15, 80],
      ],
    });
    const cdp: CdpRunner = {
      send: send as CdpRunner["send"],
    };

    await expect(nodeContentRegion(cdp, 7, 555)).resolves.toEqual([
      [
        { x: 10, y: 20 },
        { x: 60, y: 20 },
        { x: 60, y: 40 },
        { x: 10, y: 40 },
      ],
      [
        { x: 15, y: 50 },
        { x: 90, y: 50 },
        { x: 90, y: 80 },
        { x: 15, y: 80 },
      ],
    ]);
  });

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

    await expect(nodeContentRegion(cdp, 7, 555)).resolves.toEqual([
      [
        { x: 242, y: 468 },
        { x: 1011, y: 468 },
        { x: 1011, y: 648 },
        { x: 242, y: 648 },
      ],
    ]);
    expect(calls.map((c) => c.method)).toEqual([
      "DOM.getContentQuads",
      "DOM.getBoxModel",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
    ]);
  });
});
