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

  it("classifies a full-viewport blocker without modal signals or controls as a mask", () => {
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

  it("allows one CSS pixel of rounding at every viewport edge", () => {
    const layer = detectBlockingLayer(
      [
        node({
          id: 1,
          position: "fixed",
          rect: { x: 0.4, y: 0, w: 999.2, h: 799.7 },
        }),
      ],
      VP,
    );
    expect(layer?.kind).toBe("mask");
    expect(layer?.coverage).toBeLessThan(1);
  });

  it.each([
    { x: 1.1, y: 0, w: 998.9, h: 800 },
    { x: 0, y: 1.1, w: 1000, h: 798.9 },
    { x: 0, y: 0, w: 998.9, h: 800 },
    { x: 0, y: 0, w: 1000, h: 798.9 },
  ])("does not fold a page with an edge beyond the rounding tolerance: %j", (rect) => {
    expect(detectBlockingLayer([node({ id: 1, position: "fixed", rect })], VP)).toBeNull();
  });

  it("does not use an area ratio to forgive a sidebar's larger pixel gap", () => {
    expect(
      detectBlockingLayer(
        [node({ id: 1, position: "fixed", rect: { x: 2, y: 0, w: 1998, h: 800 } })],
        { width: 2000, height: 800 },
      ),
    ).toBeNull();
  });

  it("treats explicit modal nodes as modal without requiring a viewport cover", () => {
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

  it("classifies an explicit modal regardless of role or tag casing", () => {
    const layer = detectBlockingLayer(
      [
        node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
        node({
          id: 2,
          parentId: 1,
          tag: "DIV",
          role: "Dialog",
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

  it.each([
    "fixed",
    "absolute",
    "sticky",
  ])("does not treat a wide %s sidebar as a global blocker", (position) => {
    for (const fraction of [0.36, 0.64, 0.95, 0.99]) {
      for (const role of [undefined, "dialog", "alertdialog"]) {
        expect(
          detectBlockingLayer(
            [
              node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
              node({
                id: 2,
                parentId: 1,
                tag: role ? "dialog" : "aside",
                role,
                modal: false,
                position,
                paintOrder: 10,
                rect: { x: 1000 * (1 - fraction), y: 0, w: 1000 * fraction, h: 800 },
              }),
            ],
            VP,
          ),
        ).toBeNull();
      }
    }
  });

  it.each(["fixed", "absolute"])("recognizes a small explicit %s modal", (position) => {
    const layer = detectBlockingLayer(
      [
        node({ id: 1, tag: "body", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
        node({
          id: 2,
          parentId: 1,
          modal: true,
          position,
          paintOrder: 10,
          rect: { x: 400, y: 300, w: 100, h: 60 },
        }),
      ],
      VP,
    );
    expect(layer).toMatchObject({ rootId: 2, kind: "modal" });
  });

  it("keeps child-frame modality local and ignores offscreen modal nodes", () => {
    const modal = node({
      id: 2,
      frameId: "child",
      modal: true,
      position: "fixed",
      rect: { x: 0, y: 0, w: 1000, h: 800 },
    });
    expect(detectBlockingLayer([modal], VP, "root")).toBeNull();
    expect(
      detectBlockingLayer([{ ...modal, rect: { x: 1000, y: 0, w: 200, h: 100 } }], VP),
    ).toBeNull();
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
