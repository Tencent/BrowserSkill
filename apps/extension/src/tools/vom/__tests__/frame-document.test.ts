import { describe, expect, it, vi } from "vitest";
import type { CdpFrameGraph } from "@/browser-driver/frame-graph";
import type { CapturedNode } from "../capture";
import {
  buildFrameDocuments,
  type FrameAxBatch,
  type FrameDomInput,
  type FrameOwnedAxNode,
} from "../frame-document";

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

function captured(frameNodes: Map<string, CapturedNode[]>): FrameDomInput {
  return {
    nodes: frameNodes.get("main") ?? [],
    frameNodes,
    rootFrameId: "main",
  };
}

describe("buildFrameDocuments", () => {
  it("partitions mixed AX results by node ownership and cuts cross-frame parent edges", async () => {
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

    const documents = await buildFrameDocuments(
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

  it("deduplicates overlapping same-target AX results using the strongest ownership", async () => {
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

    const documents = await buildFrameDocuments(
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

  it("uses target-scoped backend ownership when OOPIF backend ids collide", async () => {
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

    const documents = await buildFrameDocuments(
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

  it("uses captured frame parent identity instead of guessing from backend ids", async () => {
    const frameNodes = new Map([
      ["main", [domNode("main", 1)]],
      ["left", [domNode("left", 7)]],
      ["right", [domNode("right", 7)]],
      ["child", [domNode("child", 9)]],
    ]);
    const capture = captured(frameNodes);
    const frames = ["main", "left", "right", "child"].map((frameId) => ({
      frame: {
        frameId,
        target: { tabId: 4 },
        ...(frameId === "child" ? { parentFrameId: "left", ownerBackendNodeId: 7 } : {}),
      },
      nodes: [],
    }));

    const documents = await buildFrameDocuments(null, frames, capture);

    expect(documents.find((document) => document.frameId === "child")).toMatchObject({
      parentFrameId: "left",
      ownerBackendNodeId: 7,
    });
  });
  it("rejects explicit AX frame ownership in a different target", async () => {
    const frames = [
      { frameId: "main", target: { tabId: 4 } },
      { frameId: "remote", target: { tabId: 4, sessionId: "remote" } },
    ];
    const unresolved = vi.fn();
    const documents = await buildFrameDocuments(
      { rootFrameId: "main", frames },
      [{ frame: frames[0], nodes: [{ nodeId: "wrong", frameId: "remote" }] }],
      captured(new Map()),
      undefined,
      unresolved,
    );
    expect(documents.every((doc) => doc.axNodes.length === 0)).toBe(true);
    expect(unresolved).toHaveBeenCalledOnce();
  });

  it("resolves a reverse-ordered deep AX parent chain without recursion", async () => {
    const frame = { frameId: "main", target: { tabId: 4 } };
    const nodes: FrameOwnedAxNode[] = Array.from({ length: 10000 }, (_, i) => ({
      nodeId: String(i),
      ...(i ? { parentId: String(i - 1) } : { frameId: "main" }),
    })).reverse();
    const documents = await buildFrameDocuments(
      { rootFrameId: "main", frames: [frame] },
      [{ frame, nodes }],
      captured(new Map()),
    );
    expect(documents[0].axNodes).toHaveLength(10000);
    expect(documents[0].axNodes[0].frameId).toBe("main");
  });
});
