import { describe, expect, it } from "vitest";
import type { CdpFrameGraph } from "@/browser-driver/frame-graph";
import type { CapturedNode, CapturedViewModel } from "../capture";
import { buildFrameDocuments, type FrameAxBatch, type FrameOwnedAxNode } from "../frame-document";

function domNode(frameId: string, backendNodeId: number): CapturedNode {
  return {
    backendNodeId,
    parentBackendNodeId: null,
    frameId,
    tag: "div",
    attrs: {},
    rect: { x: 0, y: 0, w: 20, h: 20 },
    paintOrder: 0,
    position: "static",
    pointerEvents: "auto",
  };
}

function captured(frameNodes: Map<string, CapturedNode[]>): CapturedViewModel {
  return {
    nodes: frameNodes.get("main") ?? [],
    viewport: { width: 800, height: 600 },
    iframeNodes: new Map(),
    frameNodes,
    rootFrameId: "main",
    excludedBackendNodeIds: new Set(),
  };
}

describe("buildFrameDocuments", () => {
  it("partitions mixed AX results by node ownership and cuts cross-frame parent edges", () => {
    const graph: CdpFrameGraph = {
      rootFrameId: "main",
      frames: [
        { frameId: "main", target: { tabId: 4 } },
        { frameId: "child", parentFrameId: "main", target: { tabId: 4 } },
      ],
    };
    const batches: FrameAxBatch<FrameOwnedAxNode>[] = [
      {
        frame: graph.frames[0],
        nodes: [
          { nodeId: "root", frameId: "main", backendDOMNodeId: 1, childIds: ["h"] },
          {
            nodeId: "h",
            frameId: "child",
            parentId: "root",
            backendDOMNodeId: 100,
            childIds: ["virtual"],
          },
          { nodeId: "virtual", parentId: "h" },
        ],
      },
    ];

    const documents = buildFrameDocuments(
      graph,
      batches,
      captured(
        new Map([
          ["main", [domNode("main", 1)]],
          ["child", [domNode("child", 100)]],
        ]),
      ),
    );

    expect(documents.find((document) => document.frameId === "main")?.axNodes).toHaveLength(1);
    const childNodes = documents.find((document) => document.frameId === "child")?.axNodes ?? [];
    expect(childNodes.map((node) => node.nodeId)).toEqual(["h", "virtual"]);
    expect(childNodes.find((node) => node.nodeId === "h")?.parentId).toBeUndefined();
    expect(childNodes.find((node) => node.nodeId === "virtual")?.frameId).toBe("child");
  });

  it("deduplicates overlapping same-target AX results using the strongest ownership", () => {
    const graph: CdpFrameGraph = {
      rootFrameId: "main",
      frames: [
        { frameId: "main", target: { tabId: 4 } },
        { frameId: "child", parentFrameId: "main", target: { tabId: 4 } },
      ],
    };
    const childNode = { nodeId: "shared", backendDOMNodeId: 100 };
    const batches: FrameAxBatch<FrameOwnedAxNode>[] = [
      {
        frame: graph.frames[0],
        nodes: [{ ...childNode, frameId: "child" }],
      },
      {
        frame: graph.frames[1],
        nodes: [childNode],
      },
    ];

    const documents = buildFrameDocuments(
      graph,
      batches,
      captured(
        new Map([
          ["main", [domNode("main", 1)]],
          ["child", [domNode("child", 100)]],
        ]),
      ),
    );

    expect(documents.find((document) => document.frameId === "main")?.axNodes).toEqual([]);
    expect(documents.find((document) => document.frameId === "child")?.axNodes).toHaveLength(1);
  });

  it("uses target-scoped backend ownership when OOPIF backend ids collide", () => {
    const graph: CdpFrameGraph = {
      rootFrameId: "main",
      frames: [
        { frameId: "main", target: { tabId: 4 } },
        {
          frameId: "left",
          parentFrameId: "main",
          target: { tabId: 4, sessionId: "left-session" },
        },
        {
          frameId: "right",
          parentFrameId: "main",
          target: { tabId: 4, sessionId: "right-session" },
        },
      ],
    };
    const batches: FrameAxBatch<FrameOwnedAxNode>[] = graph.frames.slice(1).map((frame) => ({
      frame,
      nodes: [{ nodeId: `${frame.frameId}-node`, backendDOMNodeId: 7 }],
    }));

    const documents = buildFrameDocuments(
      graph,
      batches,
      captured(
        new Map([
          ["main", []],
          ["left", [domNode("left", 7)]],
          ["right", [domNode("right", 7)]],
        ]),
      ),
    );

    expect(documents.find((document) => document.frameId === "left")?.axNodes[0]?.nodeId).toBe(
      "left-node",
    );
    expect(documents.find((document) => document.frameId === "right")?.axNodes[0]?.nodeId).toBe(
      "right-node",
    );
  });

  it("uses captured frame parent identity instead of guessing from backend ids", () => {
    const frameNodes = new Map([
      ["main", [domNode("main", 1)]],
      ["left", [domNode("left", 7)]],
      ["right", [domNode("right", 7)]],
      ["child", [domNode("child", 9)]],
    ]);
    const capture = captured(frameNodes);
    capture.frameOwnerBackendNodeIds = new Map([["child", 7]]);
    capture.frameParentIds = new Map([["child", "left"]]);
    const frames = ["main", "left", "right", "child"].map((frameId) => ({
      frame: { frameId, target: { tabId: 4 } },
      nodes: [],
    }));

    const documents = buildFrameDocuments(null, frames, capture);

    expect(documents.find((document) => document.frameId === "child")).toMatchObject({
      parentFrameId: "left",
      ownerBackendNodeId: 7,
    });
  });
});
