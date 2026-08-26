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
    expect(surfaces[0]).toMatchObject({ backendNodeId: 2 });
  });

  it("keeps tiny canvases as individually addressable exact discoveries", () => {
    const surfaces = discoverRenderedSurfaces(
      [document([domNode(2, { rect: { x: 1, y: 1, w: 8, h: 8 } })])],
      { width: 1280, height: 720 },
    );
    expect(surfaces).toEqual([expect.objectContaining({ backendNodeId: 2 })]);
  });

  it("keeps a surface when the canvas only has partial native accessibility content", () => {
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
    ).toEqual([expect.objectContaining({ backendNodeId: 2 })]);
  });

  it("discovers unnamed canvases without guessing labels from engineering attributes", () => {
    const canvas = domNode(2, {
      attrs: {
        id: "must-not-be-a-label",
        class: "must-not-be-a-label",
        "data-testid": "must-not-be-a-label",
      },
    });

    expect(discoverRenderedSurfaces([document([canvas])], { width: 1280, height: 720 })).toEqual([
      expect.not.objectContaining({
        label: expect.anything(),
      }),
    ]);
  });

  it("treats blank explicit Canvas names as unnamed", () => {
    expect(
      discoverRenderedSurfaces(
        [document([domNode(2, { attrs: { "aria-label": "   ", title: "\n\t" } })])],
        { width: 1280, height: 720 },
      ),
    ).toEqual([expect.not.objectContaining({ label: expect.anything() })]);
  });

  it("excludes canvases inside BrowserSkill-owned DOM subtrees", () => {
    const owner = domNode(1, { tag: "div", rect: null, localRect: null });
    const canvas = domNode(2, { parentBackendNodeId: 1 });

    expect(
      discoverRenderedSurfaces(
        [document([owner, canvas])],
        { width: 1280, height: 720 },
        new Set([1]),
      ),
    ).toEqual([]);
  });

  it("excludes canvases suppressed by a fully transparent ancestor", () => {
    const owner = domNode(1, {
      tag: "div",
      rect: { x: 0, y: 0, w: 900, h: 600 },
      visuallySuppressed: true,
    });
    const canvas = domNode(2, { parentBackendNodeId: 1 });

    expect(
      discoverRenderedSurfaces([document([owner, canvas])], { width: 1280, height: 720 }),
    ).toEqual([]);
  });

  it("clips canvases to overflow ancestors and drops fully clipped canvases", () => {
    const owner = domNode(1, {
      tag: "div",
      rect: { x: 10, y: 20, w: 100, h: 70 },
      overflowX: "hidden",
      overflowY: "hidden",
    });
    const partial = domNode(2, {
      parentBackendNodeId: 1,
      rect: { x: 55, y: 30, w: 140, h: 60 },
    });
    const fullyClipped = domNode(3, {
      parentBackendNodeId: 1,
      rect: { x: 140, y: 30, w: 80, h: 50 },
    });

    expect(
      discoverRenderedSurfaces([document([owner, partial, fullyClipped])], {
        width: 1280,
        height: 720,
      }),
    ).toEqual([
      expect.objectContaining({
        backendNodeId: 2,
        visibleRect: { x: 55, y: 30, w: 55, h: 60 },
      }),
    ]);
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
    expect(groups[0]?.label).toBeUndefined();
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

  it("does not merge a contained canvas with a larger independent canvas", () => {
    const groups = clusterRenderedSurfaces([
      ...discoverRenderedSurfaces(
        [
          document([
            domNode(1, { tag: "main", rect: null, localRect: null }),
            domNode(2, { parentBackendNodeId: 1 }),
            domNode(3, {
              parentBackendNodeId: 1,
              rect: { x: 30, y: 40, w: 200, h: 100 },
            }),
          ]),
        ],
        { width: 1280, height: 720 },
      ),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("does not merge coincident canvases owned by different containers", () => {
    const groups = clusterRenderedSurfaces(
      discoverRenderedSurfaces(
        [
          document([
            domNode(1, { tag: "section", rect: null, localRect: null }),
            domNode(2, { tag: "section", rect: null, localRect: null }),
            domNode(3, { parentBackendNodeId: 1 }),
            domNode(4, { parentBackendNodeId: 2 }),
          ]),
        ],
        { width: 1280, height: 720 },
      ),
    );

    expect(groups).toHaveLength(2);
  });
});
