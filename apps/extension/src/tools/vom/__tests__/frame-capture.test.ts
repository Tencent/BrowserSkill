import { describe, expect, it, vi } from "vitest";
import type { CdpRunner } from "../../shared";
import type { CapturedNode, CapturedViewModel } from "../capture";
import { captureFrameData } from "../frame-capture";

function ownerNode(backendNodeId: number, x: number): CapturedNode {
  return {
    backendNodeId,
    parentBackendNodeId: 1,
    frameId: "main",
    ownerFrameBackendNodeId: null,
    tag: "iframe",
    attrs: {},
    rect: { x, y: 100, w: 300, h: 200 },
    localRect: { x, y: 100, w: 300, h: 200 },
    paintOrder: 1,
    position: "static",
    pointerEvents: "auto",
  };
}

function childSnapshot(frameId: string, backendNodeId: number) {
  const strings = [frameId, "body", "button", "static", "auto", "pointer"];
  return {
    strings,
    documents: [
      {
        frameId,
        nodes: {
          parentIndex: [-1, 0],
          nodeName: [1, 2],
          backendNodeId: [backendNodeId - 1, backendNodeId],
          attributes: [[], []],
        },
        layout: {
          nodeIndex: [0, 1],
          styles: [
            [3, 4, 4],
            [3, 4, 5],
          ],
          bounds: [
            [0, 0, 300, 200],
            [10, 20, 100, 40],
          ],
          paintOrders: [0, 1],
        },
      },
    ],
  };
}

describe("captureFrameData", () => {
  it("captures and positions multiple OOPIF documents missing from the root snapshot", async () => {
    const leftOwner = ownerNode(10, 50);
    const rightOwner = ownerNode(20, 500);
    const captured: CapturedViewModel = {
      nodes: [leftOwner, rightOwner],
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      frameNodes: new Map([["main", [leftOwner, rightOwner]]]),
      frameOwnerBackendNodeIds: new Map(),
      rootFrameId: "main",
      excludedBackendNodeIds: new Set(),
    };
    const sendToTarget = vi.fn(async (target, method) => {
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 300, clientHeight: 200, pageX: 0, pageY: 0 } };
      }
      if (method === "DOMSnapshot.enable" || method === "Accessibility.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") {
        return target.sessionId === "left-session"
          ? childSnapshot("left", 101)
          : childSnapshot("right", 201);
      }
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      throw new Error(`unexpected ${method}`);
    });
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method, params) => {
        if (method === "Accessibility.enable") return {};
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "DOM.getBoxModel") {
          const backendNodeId = (params as { backendNodeId?: number })?.backendNodeId;
          const x = backendNodeId === 10 ? 50 : 500;
          return { model: { content: [x, 100, x + 300, 100, x + 300, 300, x, 300] } };
        }
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
        }
        throw new Error(`unexpected root ${method}`);
      }) as CdpRunner["send"],
      sendToTarget: sendToTarget as unknown as NonNullable<CdpRunner["sendToTarget"]>,
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          {
            frameId: "left",
            parentFrameId: "main",
            ownerBackendNodeId: 10,
            target: { tabId: 4, sessionId: "left-session" },
          },
          {
            frameId: "right",
            parentFrameId: "main",
            ownerBackendNodeId: 20,
            target: { tabId: 4, sessionId: "right-session" },
          },
        ],
      })),
    };

    const trees = await captureFrameData(cdp, 4, captured);

    expect(trees.map((tree) => tree.frameId)).toEqual(["main", "left", "right"]);
    expect(
      captured.frameNodes?.get("left")?.find((node) => node.backendNodeId === 101)?.rect,
    ).toEqual({ x: 60, y: 120, w: 100, h: 40 });
    expect(
      captured.frameNodes?.get("right")?.find((node) => node.backendNodeId === 201)?.rect,
    ).toEqual({ x: 510, y: 120, w: 100, h: 40 });
    expect(captured.frameOwnerBackendNodeIds).toEqual(
      new Map([
        ["left", 10],
        ["right", 20],
      ]),
    );
    expect(captured.frameParentIds).toEqual(
      new Map([
        ["left", "main"],
        ["right", "main"],
      ]),
    );
  });

  it("keeps OOPIF semantics when viewport projection is unavailable", async () => {
    const owner = { ...ownerNode(10, 50), rect: null, localRect: null };
    const captured: CapturedViewModel = {
      nodes: [owner],
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      frameNodes: new Map([["main", [owner]]]),
      rootFrameId: "main",
      excludedBackendNodeIds: new Set(),
    };
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method) => {
        if (method === "Accessibility.enable") return {};
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "DOM.getBoxModel") throw new Error("owner geometry unavailable");
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
        }
        throw new Error(`unexpected root ${method}`);
      }) as CdpRunner["send"],
      sendToTarget: vi.fn(async (_target, method) => {
        if (method === "Page.getLayoutMetrics") throw new Error("viewport unavailable");
        if (method === "DOMSnapshot.enable" || method === "Accessibility.enable") return {};
        if (method === "DOMSnapshot.captureSnapshot") return childSnapshot("child", 101);
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              {
                nodeId: "button",
                backendDOMNodeId: 101,
                role: { type: "role", value: "button" },
                name: { type: "computedString", value: "Continue" },
              },
            ],
          };
        }
        throw new Error(`unexpected ${method}`);
      }) as unknown as NonNullable<CdpRunner["sendToTarget"]>,
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

    const documents = await captureFrameData(cdp, 4, captured);
    const childDocument = documents.find((document) => document.frameId === "child");

    expect(childDocument?.axNodes).toEqual([
      expect.objectContaining({ backendDOMNodeId: 101, frameId: "child" }),
    ]);
    expect(childDocument?.domNodes.find((node) => node.backendNodeId === 101)).toEqual(
      expect.objectContaining({ rect: null, localRect: { x: 10, y: 20, w: 100, h: 40 } }),
    );
  });
});
