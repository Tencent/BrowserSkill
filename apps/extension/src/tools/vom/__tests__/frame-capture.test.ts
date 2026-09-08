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
  it("does not request frame geometry for a root-only page", async () => {
    const root = { ...ownerNode(1, 0), tag: "body" };
    const captured: CapturedViewModel = {
      nodes: [root],
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      frameNodes: new Map([["main", [root]]]),
      rootFrameId: "main",
      excludedBackendNodeIds: new Set(),
    };
    const send = vi.fn(async (_tabId, method) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes: [] };
      throw new Error(`unexpected ${method}`);
    });
    const cdp: CdpRunner = {
      send: send as CdpRunner["send"],
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [{ frameId: "main", target: { tabId: 4 } }],
      })),
    };

    await captureFrameData(cdp, 4, captured);

    expect(send.mock.calls.some(([, method]) => method === "Page.createIsolatedWorld")).toBe(false);
    expect(send.mock.calls.some(([, method]) => method === "DOM.getBoxModel")).toBe(false);
    expect(send.mock.calls.some(([, method]) => method === "Page.getLayoutMetrics")).toBe(false);
  });

  it("projects same-origin frame-local rects through the iframe content box", async () => {
    const owner = ownerNode(10, 50);
    const canvas: CapturedNode = {
      backendNodeId: 101,
      parentBackendNodeId: 100,
      frameId: "child",
      ownerFrameBackendNodeId: 10,
      tag: "canvas",
      attrs: {},
      rect: null,
      localRect: { x: 12, y: 12, w: 224, h: 94 },
      paintOrder: 1,
      position: "static",
      pointerEvents: "auto",
    };
    const captured: CapturedViewModel = {
      nodes: [owner],
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map([[10, [canvas]]]),
      frameNodes: new Map([
        ["main", [owner]],
        ["child", [canvas]],
      ]),
      frameOwnerBackendNodeIds: new Map([["child", 10]]),
      frameParentIds: new Map([["child", "main"]]),
      rootFrameId: "main",
      excludedBackendNodeIds: new Set(),
    };
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method) => {
        if (method === "Accessibility.enable") return {};
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
        }
        if (method === "DOM.getBoxModel") {
          return { model: { content: [52, 102, 352, 102, 352, 302, 52, 302] } };
        }
        if (method === "Page.createIsolatedWorld") return { executionContextId: 91 };
        if (method === "Runtime.evaluate") {
          return { result: { value: { width: 300, height: 200 } } };
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

    await captureFrameData(cdp, 4, captured);

    expect(captured.frameNodes?.get("child")?.[0]?.rect).toEqual({
      x: 64,
      y: 114,
      w: 224,
      h: 94,
    });
    expect(captured.iframeNodes.get(10)?.[0]?.rect).toEqual({ x: 64, y: 114, w: 224, h: 94 });
  });

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

  it("bounds concurrent same-target frame geometry resolution", async () => {
    const owners = Array.from({ length: 8 }, (_, index) => ownerNode(10 + index, index * 40));
    const childFrames = owners.map((owner, index) => {
      const frameId = `child-${index}`;
      const node: CapturedNode = {
        backendNodeId: 100 + index,
        parentBackendNodeId: null,
        frameId,
        ownerFrameBackendNodeId: owner.backendNodeId,
        tag: "canvas",
        attrs: {},
        rect: null,
        localRect: { x: 1, y: 2, w: 20, h: 10 },
        paintOrder: 1,
        position: "static",
        pointerEvents: "auto",
      };
      return { frameId, owner, node };
    });
    const captured: CapturedViewModel = {
      nodes: owners,
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(childFrames.map(({ owner, node }) => [owner.backendNodeId, [node]])),
      frameNodes: new Map([
        ["main", owners],
        ...childFrames.map(({ frameId, node }): [string, CapturedNode[]] => [frameId, [node]]),
      ]),
      frameOwnerBackendNodeIds: new Map(
        childFrames.map(({ frameId, owner }) => [frameId, owner.backendNodeId]),
      ),
      rootFrameId: "main",
      excludedBackendNodeIds: new Set(),
    };
    let activeWorlds = 0;
    let maxActiveWorlds = 0;
    const cdp: CdpRunner = {
      send: vi.fn(async (_tabId, method, params) => {
        if (method === "Page.getLayoutMetrics") {
          return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
        }
        if (method === "DOM.getBoxModel") {
          const backendNodeId = (params as { backendNodeId?: number }).backendNodeId ?? 10;
          const x = (backendNodeId - 10) * 40;
          return { model: { content: [x, 100, x + 30, 100, x + 30, 120, x, 120] } };
        }
        if (method === "Page.createIsolatedWorld") {
          activeWorlds += 1;
          maxActiveWorlds = Math.max(maxActiveWorlds, activeWorlds);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeWorlds -= 1;
          return { executionContextId: 90 };
        }
        if (method === "Runtime.evaluate") {
          return { result: { value: { width: 30, height: 20 } } };
        }
        if (method === "Accessibility.enable") return {};
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        throw new Error(`unexpected ${method}`);
      }) as CdpRunner["send"],
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          ...childFrames.map(({ frameId, owner }) => ({
            frameId,
            parentFrameId: "main",
            ownerBackendNodeId: owner.backendNodeId,
            target: { tabId: 4 },
          })),
        ],
      })),
    };

    await captureFrameData(cdp, 4, captured);

    expect(maxActiveWorlds).toBe(4);
    expect(childFrames.every(({ frameId }) => captured.frameNodes?.get(frameId)?.[0]?.rect)).toBe(
      true,
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
