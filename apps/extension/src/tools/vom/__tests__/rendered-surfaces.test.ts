import type { VomScene } from "@browser-skill/vom";
import { describe, expect, it } from "vitest";
import type { CapturedNode } from "../capture";
import type { CapturedFrameDocument } from "../frame-capture";
import {
  clusterRenderedSurfaces,
  discoverRenderedSurfaces,
  projectRenderedSurfaces,
} from "../rendered-surfaces";
import type { SemanticAxNode } from "../semantic-graph";

function domNode(backendNodeId: number, overrides: Partial<CapturedNode> = {}): CapturedNode {
  return {
    backendNodeId,
    parentBackendNodeId: null,
    frameId: "main",
    ownerFrameBackendNodeId: null,
    tag: "canvas",
    attrs: {},
    rect: { x: 10, y: 20, w: 800, h: 500 },
    localRect: { x: 10, y: 20, w: 800, h: 500 },
    paintOrder: 1,
    position: "static",
    pointerEvents: "auto",
    rendered: true,
    ...overrides,
  };
}

function document(
  domNodes: CapturedNode[],
  axNodes: SemanticAxNode[] = [],
): CapturedFrameDocument<SemanticAxNode> {
  return {
    frameId: domNodes[0]?.frameId ?? "main",
    contextScopeId: domNodes[0]?.frameId ?? "main",
    target: { tabId: 4 },
    domNodes,
    axNodes,
  };
}

describe("rendered surface discovery", () => {
  it("finds prominent rendered canvases and excludes hidden descendants", () => {
    const visible = domNode(2, { parentBackendNodeId: 1 });
    const hidden = domNode(3, { parentBackendNodeId: 4 });
    const surfaces = discoverRenderedSurfaces(
      [
        document([
          domNode(1, { tag: "main", rect: null, localRect: null }),
          visible,
          domNode(4, { tag: "section", attrs: { "aria-hidden": "true" }, rect: null }),
          hidden,
        ]),
      ],
      { width: 1280, height: 720 },
    );

    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toMatchObject({ backendNodeId: 2, existenceConfidence: "high" });
  });

  it("keeps tiny canvases only as low-confidence discoveries", () => {
    const surfaces = discoverRenderedSurfaces(
      [document([domNode(2, { rect: { x: 1, y: 1, w: 8, h: 8 } })])],
      { width: 1280, height: 720 },
    );
    expect(surfaces[0]?.existenceConfidence).toBe("low");
  });

  it("suppresses a canvas with a verified native accessibility mirror", () => {
    const axNodes = [
      {
        nodeId: "canvas",
        backendDOMNodeId: 2,
        role: { type: "role", value: "presentation" },
        childIds: ["button"],
        frameId: "main",
      },
      {
        nodeId: "button",
        backendDOMNodeId: 3,
        role: { type: "role", value: "button" },
        frameId: "main",
      },
    ] as SemanticAxNode[];
    expect(
      discoverRenderedSurfaces([document([domNode(2)], axNodes)], { width: 1280, height: 720 }),
    ).toEqual([]);
  });
});

describe("rendered surface clustering and projection", () => {
  it("collapses overlapping canvas layers and attaches them to the nearest retained parent", () => {
    const body = domNode(1, { tag: "body", rect: null, localRect: null });
    const surfaces = discoverRenderedSurfaces(
      [
        document([
          body,
          domNode(2, { parentBackendNodeId: 1, paintOrder: 1 }),
          domNode(3, { parentBackendNodeId: 1, paintOrder: 2 }),
        ]),
      ],
      { width: 1280, height: 720 },
    );
    const groups = clusterRenderedSurfaces(surfaces);
    const scene: VomScene = {
      viewport: { width: 1280, height: 720 },
      nodes: [
        {
          id: 10,
          parentId: null,
          backendNodeId: 1,
          frameId: "main",
          tag: "body",
          role: "RootWebArea",
          rect: null,
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
        },
      ],
    };

    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(2);
    expect(
      projectRenderedSurfaces(
        scene,
        [document([body, ...surfaces.map((s) => domNode(s.backendNodeId))])],
        groups,
      ),
    ).toMatchObject({
      visualSurfaces: [expect.objectContaining({ parentId: 10, backendNodeId: 3, memberCount: 2 })],
    });
  });
});
