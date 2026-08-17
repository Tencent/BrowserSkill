import type { RenderedRef } from "@browser-skill/vom";
import { describe, expect, it } from "vitest";
import type { CapturedNode } from "@/tools/vom/capture";
import { matchTarget } from "../match-target";

function node(backendNodeId: number, overrides: Partial<CapturedNode> = {}): CapturedNode {
  return {
    backendNodeId,
    parentBackendNodeId: null,
    tag: "button",
    attrs: {},
    rect: { x: 10, y: 20, w: 100, h: 30 },
    paintOrder: 1,
    position: "static",
    pointerEvents: "auto",
    ...overrides,
  };
}

describe("matchTarget", () => {
  const refs: RenderedRef[] = [
    { ref: "e1", backendNodeId: 42, role: "button", name: "发布", line: 3 },
  ];

  it("matches a unique node by viewport coordinates", () => {
    const target = matchTarget({
      geometry: {
        rect: { x: 10, y: 20, w: 100, h: 30 },
        scrollX: 0,
        scrollY: 0,
        position: "static",
        tag: "button",
      },
      captured: [node(42)],
      refs,
      fallback: { tag: "button", name: "发布" },
    });
    expect(target).toEqual({ ref: "e1", role: "button", name: "发布" });
  });

  it("matches a non-fixed node after the top frame scrolls", () => {
    const target = matchTarget({
      geometry: {
        rect: { x: 10, y: 20, w: 100, h: 30 },
        scrollX: 40,
        scrollY: 300,
        position: "static",
        tag: "button",
      },
      captured: [
        node(42, {
          documentRect: { x: 50, y: 320, w: 100, h: 30 },
          localRect: { x: 10, y: 20, w: 100, h: 30 },
          rect: { x: 10, y: 20, w: 100, h: 30 },
        }),
      ],
      refs,
      fallback: { tag: "button", name: "发布" },
    });

    expect(target).toEqual({ ref: "e1", role: "button", name: "发布" });
  });

  it("matches a static node by document coordinates when scroll changed after observation", () => {
    const target = matchTarget({
      geometry: {
        rect: { x: 10, y: 50, w: 100, h: 30 },
        scrollX: 0,
        scrollY: 250,
        position: "static",
        tag: "button",
      },
      captured: [
        node(42, {
          documentRect: { x: 10, y: 300, w: 100, h: 30 },
          localRect: { x: 10, y: 200, w: 100, h: 30 },
          rect: { x: 10, y: 200, w: 100, h: 30 },
        }),
      ],
      refs,
      fallback: { tag: "button", name: "发布" },
    });

    expect(target).toEqual({ ref: "e1", role: "button", name: "发布" });
  });

  it("returns unmatched when multiple candidates match", () => {
    const target = matchTarget({
      geometry: {
        rect: { x: 10, y: 20, w: 100, h: 30 },
        scrollX: 0,
        scrollY: 0,
        position: "static",
        tag: "button",
      },
      captured: [node(42), node(43)],
      refs,
    });
    expect(target.unmatched).toBe(true);
  });

  it("uses viewport coordinates for fixed elements", () => {
    const target = matchTarget({
      geometry: {
        rect: { x: 5, y: 5, w: 80, h: 24 },
        scrollX: 100,
        scrollY: 200,
        position: "fixed",
        tag: "button",
      },
      captured: [node(42, { position: "fixed", rect: { x: 5, y: 5, w: 80, h: 24 } })],
      refs,
    });
    expect(target.ref).toBe("e1");
  });

  it("isolates geometry matching to the owner iframe backend node", () => {
    const sharedRect = { x: 10, y: 20, w: 100, h: 30 };
    const iframeRefs: RenderedRef[] = [
      { ref: "e1", backendNodeId: 42, role: "button", name: "Top", line: 1 },
      { ref: "e2", backendNodeId: 99, role: "button", name: "Iframe", line: 2 },
    ];
    const target = matchTarget({
      geometry: {
        rect: sharedRect,
        scrollX: 0,
        scrollY: 0,
        position: "static",
        tag: "button",
        ownerFrameBackendNodeId: 13,
      },
      captured: [
        node(42, { rect: sharedRect, documentRect: sharedRect }),
        node(99, {
          rect: sharedRect,
          documentRect: sharedRect,
          ownerFrameBackendNodeId: 13,
        }),
      ],
      refs: iframeRefs,
      fallback: { tag: "button", name: "Iframe" },
    });
    expect(target).toEqual({ ref: "e2", role: "button", name: "Iframe" });
  });

  it("matches iframe static elements using frame scroll and document coordinates", () => {
    const iframeRefs: RenderedRef[] = [
      { ref: "e2", backendNodeId: 99, role: "button", name: "Iframe", line: 2 },
    ];
    const target = matchTarget({
      geometry: {
        rect: { x: 10, y: 50, w: 100, h: 30 },
        scrollX: 0,
        scrollY: 120,
        position: "static",
        tag: "button",
        ownerFrameBackendNodeId: 13,
      },
      captured: [
        node(99, {
          ownerFrameBackendNodeId: 13,
          documentRect: { x: 10, y: 170, w: 100, h: 30 },
          localRect: { x: 10, y: 50, w: 100, h: 30 },
          rect: { x: 10, y: 50, w: 100, h: 30 },
        }),
      ],
      refs: iframeRefs,
      fallback: { tag: "button", name: "Iframe" },
    });
    expect(target).toEqual({ ref: "e2", role: "button", name: "Iframe" });
  });
});
