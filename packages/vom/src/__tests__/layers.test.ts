import { describe, expect, it } from "vitest";
import { coverage, detectBlockingLayer } from "../layers";
import type { Viewport, VomNode } from "../types";

const VP: Viewport = { width: 1000, height: 800 };

function node(p: Partial<VomNode> & { id: number }): VomNode {
  const { id, parentId, tag, rect, paintOrder, position, pointerEvents, ...rest } = p;

  return {
    id,
    parentId: parentId ?? null,
    tag: tag ?? "div",
    rect: rect ?? null,
    paintOrder: paintOrder ?? 0,
    position: position ?? "static",
    pointerEvents: pointerEvents ?? "auto",
    ...rest,
  };
}

describe("coverage", () => {
  it("returns the clamped viewport-overlap fraction", () => {
    expect(coverage({ x: 0, y: 0, w: 1000, h: 800 }, VP)).toBeCloseTo(1);
    expect(coverage({ x: 0, y: 0, w: 500, h: 800 }, VP)).toBeCloseTo(0.5);
    expect(coverage({ x: -100, y: 0, w: 200, h: 800 }, VP)).toBeCloseTo(0.1);
  });

  it("returns 0 for null rect, invalid viewport, or off-viewport rect", () => {
    expect(coverage(null, VP)).toBe(0);
    expect(coverage({ x: 0, y: 0, w: 100, h: 100 }, { width: 0, height: 800 })).toBe(0);
    expect(coverage({ x: 2000, y: 0, w: 100, h: 100 }, VP)).toBe(0);
  });
});

describe("detectBlockingLayer", () => {
  it("detects a CSS blocker and includes the whole top paint-order band", () => {
    const layer = detectBlockingLayer(
      [
        node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 4000 }, paintOrder: 0 }),
        node({
          id: 2,
          parentId: 1,
          rect: { x: 0, y: 0, w: 1000, h: 800 },
          paintOrder: 30,
          position: "fixed",
        }),
        node({
          id: 3,
          parentId: 1,
          role: "dialog",
          name: "提示",
          tag: "dialog",
          rect: { x: 300, y: 250, w: 400, h: 300 },
          paintOrder: 40,
          position: "fixed",
        }),
        node({
          id: 4,
          parentId: 3,
          role: "button",
          name: "关闭",
          tag: "button",
          rect: { x: 640, y: 260, w: 40, h: 40 },
          paintOrder: 41,
        }),
      ],
      VP,
    );

    expect(layer).not.toBeNull();
    expect(layer?.rootId).toBe(2);
    expect(layer?.kind).toBe("modal");
    expect(layer?.coverage).toBeCloseTo(1);
    expect([...(layer?.members ?? [])].sort((a, b) => a - b)).toEqual([2, 3, 4]);
  });

  it("classifies a near-full blocker without modal signals or controls as a mask", () => {
    const layer = detectBlockingLayer(
      [
        node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
        node({
          id: 2,
          parentId: 1,
          rect: { x: 0, y: 0, w: 1000, h: 800 },
          paintOrder: 10,
          position: "fixed",
        }),
      ],
      VP,
    );

    expect(layer?.kind).toBe("mask");
  });

  it("treats explicit modal nodes as modal even below the generic coverage threshold", () => {
    const layer = detectBlockingLayer(
      [
        node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
        node({
          id: 2,
          parentId: 1,
          tag: "dialog",
          role: "dialog",
          modal: true,
          rect: { x: 300, y: 200, w: 400, h: 300 },
          paintOrder: 90,
          position: "fixed",
        }),
      ],
      VP,
    );

    expect(layer?.rootId).toBe(2);
    expect(layer?.kind).toBe("modal");
  });

  it("ignores small toasts and pointer-events:none covers", () => {
    expect(
      detectBlockingLayer(
        [
          node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
          node({
            id: 2,
            parentId: 1,
            rect: { x: 800, y: 720, w: 180, h: 60 },
            paintOrder: 99,
            position: "fixed",
          }),
        ],
        VP,
      ),
    ).toBeNull();

    expect(
      detectBlockingLayer(
        [
          node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
          node({
            id: 2,
            parentId: 1,
            rect: { x: 0, y: 0, w: 1000, h: 800 },
            paintOrder: 40,
            position: "fixed",
            pointerEvents: "none",
          }),
        ],
        VP,
      ),
    ).toBeNull();
  });
});
