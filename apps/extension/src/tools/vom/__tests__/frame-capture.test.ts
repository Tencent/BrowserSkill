import { describe, expect, it, vi } from "vitest";
import type { CdpRunner } from "../../shared";
import type { CapturedNode, CapturedViewModel } from "../capture";
import { captureFrameData } from "../frame-capture";

function node(frameId: string, backendNodeId: number): CapturedNode {
  return {
    backendNodeId,
    parentBackendNodeId: null,
    frameId,
    tag: "div",
    attrs: {},
    rect: null,
    localRect: { x: 0, y: 0, w: 20, h: 20 },
    paintOrder: 0,
    position: "static",
    pointerEvents: "auto",
  };
}

describe("captureFrameData", () => {
  it("captures AX trees for every same-target frame found in the DOM snapshot", async () => {
    const captured: CapturedViewModel = {
      nodes: [node("main", 1)],
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map([[10, [node("child", 101)]]]),
      frameNodes: new Map([
        ["main", [node("main", 1)]],
        ["child", [node("child", 101)]],
      ]),
      frameOwnerBackendNodeIds: new Map([["child", 10]]),
      frameParentIds: new Map([["child", "main"]]),
      rootFrameId: "main",
      excludedBackendNodeIds: new Set(),
    };
    const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") {
        const frameId = (params as { frameId?: string })?.frameId ?? "main";
        return {
          nodes: [
            {
              nodeId: `${frameId}-root`,
              frameId,
              backendDOMNodeId: frameId === "main" ? 1 : 101,
            },
          ],
        };
      }
      throw new Error(`unexpected ${method}`);
    });

    const documents = await captureFrameData({ send } as CdpRunner, 4, captured);

    expect(send).toHaveBeenCalledWith(4, "Accessibility.enable", {});
    expect(documents.map((document) => document.frameId)).toEqual(["main", "child"]);
    expect(documents.find((document) => document.frameId === "child")).toMatchObject({
      parentFrameId: "main",
      ownerBackendNodeId: 10,
      axNodes: [{ nodeId: "child-root", frameId: "child", backendDOMNodeId: 101 }],
    });
  });
});
