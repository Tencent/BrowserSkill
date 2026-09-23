import { describe, expect, it } from "vitest";
import { prepareObservationRender, renderVom } from "../render";
import type { VomNode, VomScene } from "../types";

function node(id: number, parentId: number | null, props: Partial<VomNode> = {}): VomNode {
  return {
    id,
    backendNodeId: id,
    parentId,
    frameId: "root",
    tag: "div",
    rect: null,
    paintOrder: 1,
    position: "static",
    pointerEvents: "auto",
    ...props,
  };
}

function rendered(scene: VomScene) {
  const legacy = renderVom(scene, { activeRegionPolicy: true });
  const prepared = prepareObservationRender(scene, { activeRegionPolicy: true });
  const rows = Array.from({ [Symbol.iterator]: () => prepared.rows });
  return [
    { text: legacy.text, ids: legacy.refs.map((ref) => ref.backendNodeId) },
    {
      text: [...prepared.headers, ...rows.map((row) => row.text)].join("\n"),
      ids: rows.flatMap((row) => (row.ref ? [row.ref.backendNodeId] : [])),
    },
  ];
}

const viewport = { width: 1000, height: 800 };
const action = { tag: "button", role: "button" };

describe("page and region occlusion", () => {
  it.each([
    0.36, 0.64, 0.95, 0.99,
  ])("retains uncovered refs beside a %s-width sidebar in both renderers", (fraction) => {
    const edge = viewport.width * (1 - fraction);
    for (const position of ["fixed", "absolute", "sticky"]) {
      const scene: VomScene = {
        viewport,
        rootFrameId: "root",
        nodes: [
          node(1, null, { role: "RootWebArea" }),
          node(2, 1, {
            ...action,
            name: "Main action",
            rect: { x: edge / 4, y: 20, w: edge / 2, h: 30 },
          }),
          node(3, 1, {
            ...action,
            name: "Covered action",
            rect: { x: edge + 10, y: 100, w: 100, h: 30 },
          }),
          node(4, 1, {
            tag: "aside",
            role: "complementary",
            name: "Sidebar",
            position,
            paintOrder: 10,
            rect: { x: edge, y: 0, w: viewport.width * fraction, h: viewport.height },
          }),
          node(5, 4, {
            ...action,
            name: "Sidebar action",
            paintOrder: 10,
            rect: { x: edge + 10, y: 150, w: 100, h: 30 },
          }),
          node(6, 1, {
            ...action,
            name: "Foreground action",
            paintOrder: 11,
            rect: { x: edge + 10, y: 200, w: 100, h: 30 },
          }),
        ],
      };
      for (const result of rendered(scene)) {
        expect(result.text).toContain("L1 page");
        expect(result.text).not.toContain("occluded by L1");
        expect(result.ids).toEqual([2, 5, 6]);
      }
    }
  });

  it("keeps actions outside a near-full child-frame region", () => {
    const scene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        node(2, 1, { tag: "iframe", role: "Iframe", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
        node(3, 2, {
          ...action,
          frameId: "child",
          name: "Uncovered child",
          paintOrder: 1,
          rect: { x: 5, y: 20, w: 30, h: 30 },
        }),
        node(4, 2, {
          frameId: "child",
          position: "fixed",
          paintOrder: 10,
          rect: { x: 50, y: 0, w: 950, h: 800 },
        }),
        node(5, 2, {
          ...action,
          frameId: "child",
          name: "Covered child",
          paintOrder: 1,
          rect: { x: 100, y: 20, w: 100, h: 30 },
        }),
        node(6, 1, {
          ...action,
          name: "Parent foreground",
          paintOrder: 2,
          rect: { x: 100, y: 20, w: 100, h: 30 },
        }),
      ],
    };
    for (const result of rendered(scene)) expect(result.ids).toEqual([3, 6]);
  });

  it.each([false, true])("only folds the whole page for an explicit modal (modal=%s)", (modal) => {
    const scene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        node(2, 1, { ...action, name: "Background", rect: { x: 10, y: 10, w: 100, h: 30 } }),
        node(3, 1, {
          tag: "dialog",
          role: "dialog",
          name: "Dialog",
          modal,
          position: "fixed",
          paintOrder: 10,
          rect: { x: 400, y: 300, w: 200, h: 100 },
        }),
        node(4, 3, {
          ...action,
          name: "Dialog action",
          paintOrder: 10,
          rect: { x: 450, y: 320, w: 100, h: 30 },
        }),
      ],
    };
    for (const result of rendered(scene)) {
      expect(result.ids).toEqual(modal ? [4] : [2, 4]);
      expect(result.text.includes("L1 modal")).toBe(modal);
    }
  });

  it("applies viewport rounding to child-frame region occlusion without folding the parent", () => {
    const scene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        node(2, 1, { tag: "iframe", role: "Iframe", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
        node(3, 2, {
          ...action,
          frameId: "child",
          name: "Covered child",
          rect: { x: 100, y: 20, w: 100, h: 30 },
        }),
        node(4, 2, {
          frameId: "child",
          position: "fixed",
          rect: { x: 0.4, y: 0, w: 999.2, h: 799.7 },
        }),
        node(5, 1, {
          ...action,
          name: "Parent foreground",
          paintOrder: 2,
          rect: { x: 100, y: 20, w: 100, h: 30 },
        }),
      ],
    };
    for (const result of rendered(scene)) {
      expect(result.text).toContain("L1 page");
      expect(result.ids).toEqual([5]);
    }
  });

  it.each([
    false,
    true,
  ])("requires explicit modality for an offscreen region (modal=%s)", (modal) => {
    const scene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        node(2, 1, { ...action, name: "Offscreen", rect: { x: 10, y: 1200, w: 100, h: 30 } }),
        node(3, 1, {
          tag: "dialog",
          role: "dialog",
          modal,
          position: "absolute",
          paintOrder: 10,
          rect: { x: 0, y: 1100, w: 500, h: 200 },
        }),
      ],
    };
    for (const result of rendered(scene)) {
      expect(result.text).toContain("L1 page");
      expect(result.ids).toEqual(modal ? [] : [2]);
    }
  });

  it.each([
    { x: 0, y: 0, w: 1000, h: 800 },
    { x: 0.4, y: 0, w: 999.2, h: 799.7 },
  ])("folds viewport and offscreen background refs under a CSS mask: %j", (rect) => {
    const scene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        node(2, 1, { ...action, name: "Background", rect: { x: 10, y: 10, w: 100, h: 30 } }),
        node(3, 1, { position: "fixed", paintOrder: 10, rect }),
        node(4, 1, { ...action, name: "Offscreen", rect: { x: 10, y: 1200, w: 100, h: 30 } }),
      ],
    };
    for (const result of rendered(scene)) {
      expect(result.text).toContain("L1 mask cover=100%");
      expect(result.ids).toEqual([]);
    }
  });
});
