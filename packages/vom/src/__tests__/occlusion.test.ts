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

  it("retains product and video cards partially overlapped by sibling absolute badges or center icons", () => {
    const scene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        node(2, 1, {
          tag: "a",
          role: "link",
          name: "Wireless Headphones",
          rect: { x: 20, y: 20, w: 240, h: 280 },
        }),
        node(3, 2, {
          ...action,
          name: "Add to cart",
          rect: { x: 36, y: 240, w: 120, h: 32 },
        }),
        // Sibling absolute corner badge overlapping top-right corner of the product card
        node(4, 1, {
          tag: "span",
          text: "促销",
          position: "absolute",
          paintOrder: 10,
          rect: { x: 204, y: 28, w: 48, h: 20 },
        }),
        // Video card with sibling top-right HD badge, bottom-right duration, and center play button
        node(5, 1, {
          tag: "a",
          role: "link",
          name: "Product demo video",
          rect: { x: 300, y: 20, w: 320, h: 180 },
        }),
        node(6, 1, {
          tag: "span",
          text: "HD",
          position: "absolute",
          paintOrder: 10,
          rect: { x: 580, y: 28, w: 32, h: 20 },
        }),
        node(7, 1, {
          tag: "span",
          text: "12:34",
          position: "absolute",
          paintOrder: 10,
          rect: { x: 560, y: 172, w: 52, h: 20 },
        }),
        node(8, 1, {
          ...action,
          name: "Play preview",
          position: "absolute",
          paintOrder: 10,
          rect: { x: 440, y: 90, w: 40, h: 40 },
        }),
      ],
    };
    for (const result of rendered(scene)) {
      expect(result.text).toContain("L1 page");
      expect(result.ids).toEqual([2, 3, 5, 8]);
    }
  });

  it("retains elements grazed by a sticky header or fixed floating button while hiding fully covered ones", () => {
    const scene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        // Top sticky header
        node(2, 1, {
          tag: "header",
          role: "banner",
          position: "sticky",
          paintOrder: 10,
          rect: { x: 0, y: 0, w: 1000, h: 52 },
        }),
        // Button grazed at top by 12px (center y=62 is uncovered)
        node(3, 1, {
          ...action,
          name: "Sticky grazed action",
          rect: { x: 40, y: 40, w: 200, h: 44 },
        }),
        // Button fully tucked behind sticky header
        node(4, 1, {
          ...action,
          name: "Fully hidden under header",
          rect: { x: 280, y: 8, w: 140, h: 32 },
        }),
        // Card grazed at bottom-right corner by a 56x56 floating support ball
        node(5, 1, {
          tag: "a",
          role: "link",
          name: "Order summary card",
          rect: { x: 720, y: 640, w: 240, h: 120 },
        }),
        node(6, 1, {
          ...action,
          name: "Customer support",
          position: "fixed",
          paintOrder: 10,
          rect: { x: 912, y: 712, w: 56, h: 56 },
        }),
      ],
    };
    for (const result of rendered(scene)) {
      expect(result.text).toContain("L1 page");
      expect(result.ids).toEqual([3, 5, 6]);
    }
  });

  it("preserves uncovered child buttons inside partially or fully covered clickable containers without leaking passive text", () => {
    const scene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        node(2, 1, { tag: "main", role: "main", rect: { x: 0, y: 0, w: 1000, h: 800 } }),
        // Partially covered card with one uncovered child and one fully covered child
        node(3, 2, {
          tag: "a",
          role: "link",
          name: "Partial card",
          rect: { x: 400, y: 20, w: 300, h: 200 },
        }),
        node(4, 3, {
          ...action,
          name: "Uncovered card action",
          rect: { x: 420, y: 160, w: 100, h: 32 },
        }),
        node(5, 3, {
          ...action,
          name: "Covered corner action",
          rect: { x: 645, y: 165, w: 45, h: 45 },
        }),
        node(6, 1, {
          tag: "div",
          position: "fixed",
          paintOrder: 10,
          rect: { x: 635, y: 155, w: 70, h: 70 },
        }),
        // Fully covered clickable container with an overflowing child and an elevated child
        node(7, 2, {
          tag: "div",
          role: "button",
          name: "Covered container",
          rect: { x: 20, y: 20, w: 180, h: 100 },
        }),
        node(8, 7, {
          tag: "span",
          role: "StaticText",
          name: "Covered container passive text",
          rect: { x: 30, y: 30, w: 100, h: 20 },
        }),
        node(9, 7, {
          ...action,
          name: "Overflowing child action",
          rect: { x: 240, y: 40, w: 120, h: 32 },
        }),
        node(10, 7, {
          ...action,
          name: "Elevated child action",
          paintOrder: 20,
          rect: { x: 40, y: 60, w: 120, h: 32 },
        }),
        // Completely covered button with passive text (both must be dropped cleanly)
        node(11, 2, {
          ...action,
          name: "Covered leaf button",
          rect: { x: 30, y: 150, w: 140, h: 32 },
        }),
        node(12, 11, {
          tag: "span",
          role: "StaticText",
          name: "Covered leaf ghost text",
          rect: { x: 30, y: 150, w: 140, h: 32 },
        }),
        // Fixed overlay panel covering nodes 7 and 11 (and passive children 8 and 12)
        node(13, 1, {
          tag: "aside",
          role: "complementary",
          name: "Left drawer",
          position: "fixed",
          paintOrder: 10,
          rect: { x: 0, y: 0, w: 220, h: 300 },
        }),
      ],
    };
    for (const result of rendered(scene)) {
      expect(result.text).toContain("L1 page");
      expect(result.ids).toEqual([3, 4, 9, 10]);
      expect(result.text).not.toContain("Covered container passive text");
      expect(result.text).not.toContain("Covered leaf ghost text");
    }
  });

  it("ignores negative z-index / negative paintOrder decorative backgrounds and hides targets jointly covered by multiple foreground regions", () => {
    const scene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        // Decorative z-index:-1 background with higher Blink paintOrder (real Chrome behavior)
        node(2, 1, {
          tag: "div",
          position: "absolute",
          paintOrder: 10,
          zIndex: -1,
          rect: { x: 20, y: 20, w: 240, h: 120 },
        }),
        node(3, 1, {
          ...action,
          name: "Above negative zIndex",
          paintOrder: 1,
          rect: { x: 40, y: 40, w: 140, h: 36 },
        }),
        // Synthetic negative paintOrder background
        node(4, 1, {
          tag: "div",
          position: "fixed",
          paintOrder: -1,
          rect: { x: 300, y: 20, w: 240, h: 120 },
        }),
        node(5, 1, {
          ...action,
          name: "Above negative paintOrder",
          paintOrder: -2,
          rect: { x: 320, y: 40, w: 140, h: 36 },
        }),
        // Target jointly covered by a sticky top bar (y=200..260) and a fixed bottom sheet (y=260..400)
        node(6, 1, {
          ...action,
          name: "Jointly covered action",
          paintOrder: 1,
          rect: { x: 100, y: 240, w: 140, h: 40 },
        }),
        node(7, 1, {
          tag: "div",
          position: "sticky",
          paintOrder: 10,
          rect: { x: 0, y: 200, w: 600, h: 60 },
        }),
        node(8, 1, {
          tag: "div",
          position: "fixed",
          paintOrder: 10,
          rect: { x: 0, y: 260, w: 600, h: 140 },
        }),
      ],
    };
    for (const result of rendered(scene)) {
      expect(result.text).toContain("L1 page");
      expect(result.ids).toEqual([3, 5]);
    }
  });

  it("ignores positioned descendants inside a negative-z stacking wrapper while still allowing positioned <main> to hide behind-main drawers", () => {
    const nestedNegZScene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        node(2, 1, {
          tag: "div",
          position: "absolute",
          paintOrder: 10,
          zIndex: -1,
          rect: { x: 20, y: 20, w: 240, h: 120 },
        }),
        // Child img has z-index:auto (undefined) inside z-index:-1 stacking context
        node(3, 2, {
          tag: "img",
          role: "img",
          name: "Hero backdrop",
          position: "absolute",
          paintOrder: 11,
          rect: { x: 20, y: 20, w: 240, h: 120 },
        }),
        node(4, 1, {
          ...action,
          name: "Buy now",
          paintOrder: 1,
          rect: { x: 40, y: 40, w: 140, h: 36 },
        }),
      ],
    };
    for (const result of rendered(nestedNegZScene)) {
      expect(result.ids).toEqual([4]);
    }

    const positionedMainScene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { tag: "body", role: "RootWebArea" }),
        node(2, 1, {
          tag: "nav",
          role: "navigation",
          name: "Menu",
          position: "fixed",
          paintOrder: 2,
          rect: { x: 0, y: 60, w: 200, h: 360 },
        }),
        node(3, 2, {
          tag: "a",
          role: "link",
          name: "Orders",
          paintOrder: 2,
          rect: { x: 16, y: 80, w: 170, h: 50 },
        }),
        node(4, 1, {
          tag: "main",
          role: "main",
          position: "absolute",
          paintOrder: 5,
          zIndex: 2,
          rect: { x: 0, y: 60, w: 1000, h: 740 },
        }),
        node(5, 4, {
          ...action,
          name: "Main button",
          paintOrder: 5,
          rect: { x: 240, y: 120, w: 120, h: 36 },
        }),
      ],
    };
    for (const result of rendered(positionedMainScene)) {
      expect(result.ids).toEqual([5]);
    }
  });

  it("keeps a rescued Canvas under its surviving ancestor in prepareObservationRender", () => {
    const scene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        node(2, 1, {
          tag: "section",
          role: "region",
          name: "Gallery",
          rect: { x: 0, y: 0, w: 600, h: 300 },
        }),
        node(3, 2, {
          tag: "div",
          role: "button",
          name: "Covered card",
          rect: { x: 20, y: 20, w: 160, h: 100 },
        }),
        node(4, 3, {
          tag: "canvas",
          role: "canvas",
          name: "Chart",
          rect: { x: 260, y: 40, w: 180, h: 120 },
        }),
        node(5, 1, {
          tag: "aside",
          role: "complementary",
          position: "fixed",
          paintOrder: 10,
          rect: { x: 0, y: 0, w: 200, h: 300 },
        }),
      ],
      visuals: [
        {
          key: 0,
          parentId: 3,
          sourceId: 4,
          label: "Chart",
          frameId: "root",
          rect: { x: 260, y: 40, w: 180, h: 120 },
          paintOrder: 1,
        },
      ],
    };
    const prepared = prepareObservationRender(scene, { activeRegionPolicy: true });
    const rows = Array.from({ [Symbol.iterator]: () => prepared.rows });
    const text = [...prepared.headers, ...rows.map((row) => row.text)].join("\n");
    expect(text).toContain('region "Gallery"');
    expect(text).toContain('canvas "Chart" [visual:screenshot]');
    expect(text).not.toContain("Unplaced Canvas regions");
    expect(text).not.toContain("Covered card");
  });

  it("does not fold the page for fixed app shells wrapping <main>, scroll-locked html/body, or negative-z backgrounds", () => {
    const fullRect = { x: 0, y: 0, w: 1000, h: 800 };
    const appShellScene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { tag: "html", role: "RootWebArea", position: "fixed", rect: fullRect }),
        node(2, 1, { tag: "body", position: "fixed", paintOrder: 1, rect: fullRect }),
        node(3, 2, { position: "fixed", paintOrder: 15, zIndex: -1, rect: fullRect }),
        node(4, 2, {
          position: "fixed",
          paintOrder: 10,
          rect: fullRect,
        }),
        node(5, 4, {
          tag: "aside",
          role: "complementary",
          name: "Sidebar",
          paintOrder: 11,
          rect: { x: 0, y: 0, w: 200, h: 800 },
        }),
        node(6, 5, {
          ...action,
          name: "Publish nav",
          paintOrder: 11,
          rect: { x: 16, y: 40, w: 160, h: 32 },
        }),
        node(7, 4, {
          tag: "main",
          role: "main",
          paintOrder: 10,
          rect: { x: 200, y: 0, w: 800, h: 800 },
          domAncestorIds: [4, 2, 1],
        }),
        node(8, 7, {
          ...action,
          name: "Upload video",
          paintOrder: 10,
          rect: { x: 260, y: 120, w: 180, h: 48 },
          domAncestorIds: [7, 4, 2, 1],
        }),
        node(9, 7, {
          tag: "iframe",
          role: "Iframe",
          paintOrder: 10,
          rect: { x: 200, y: 200, w: 800, h: 600 },
          domAncestorIds: [7, 4, 2, 1],
        }),
        node(10, 9, {
          ...action,
          frameId: "child",
          name: "Iframe upload",
          paintOrder: 1,
          rect: { x: 240, y: 240, w: 140, h: 40 },
        }),
      ],
    };
    for (const result of rendered(appShellScene)) {
      expect(result.text).toContain("@layers 1 focus=L1");
      expect(result.text).toContain("L1 page");
      expect(result.text).not.toContain("occluded by L1");
      expect(result.ids).toEqual([6, 8, 10]);
    }

    // Negative z-index background with higher Blink paintOrder (real Chromium DOMSnapshot behavior),
    // including a full-viewport positioned child inside a negative-z stacking wrapper.
    const negZScene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        node(2, 1, { position: "fixed", paintOrder: 12, zIndex: -1, rect: fullRect }),
        node(3, 2, { position: "absolute", paintOrder: 13, rect: fullRect }),
        node(4, 1, {
          tag: "main",
          role: "main",
          position: "static",
          paintOrder: 0,
          rect: fullRect,
        }),
        node(5, 4, {
          ...action,
          name: "Upload",
          position: "static",
          paintOrder: 0,
          rect: { x: 100, y: 100, w: 120, h: 40 },
        }),
      ],
    };
    for (const result of rendered(negZScene)) {
      expect(result.text).toContain("@layers 1 focus=L1");
      expect(result.ids).toEqual([5]);
    }
  });

  it("keeps child-iframe <main> from disabling parent modal iframes, hides drawers behind fixed app shells, and preserves modal backdrops inside positive-z wrappers", () => {
    const fullRect = { x: 0, y: 0, w: 1000, h: 800 };

    // 1. Child iframe <main> must not mark a parent fullscreen checkout overlay as a non-blocking app shell.
    const checkoutModalScene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { role: "RootWebArea" }),
        node(2, 1, {
          ...action,
          name: "Background page action",
          paintOrder: 1,
          rect: { x: 40, y: 40, w: 160, h: 40 },
        }),
        node(3, 1, {
          tag: "div",
          position: "fixed",
          paintOrder: 10,
          zIndex: 1000,
          rect: fullRect,
        }),
        node(4, 3, {
          tag: "iframe",
          role: "Iframe",
          position: "fixed",
          paintOrder: 11,
          rect: fullRect,
        }),
        node(5, 4, {
          tag: "main",
          role: "main",
          frameId: "checkout",
          paintOrder: 1,
          rect: fullRect,
          domAncestorIds: [4, 3, 1],
        }),
        node(6, 5, {
          ...action,
          frameId: "checkout",
          name: "Pay now",
          paintOrder: 2,
          rect: { x: 300, y: 300, w: 140, h: 40 },
        }),
      ],
    };
    for (const result of rendered(checkoutModalScene)) {
      expect(result.text).toContain("@layers 2 focus=L1");
      expect(result.text).toContain("L1 modal cover=100%");
      expect(result.ids).toEqual([6]);
    }

    // 2. A fixed opaque #app shell wrapping <main> must not fold the page, yet must still
    // hide a closed drawer painted behind #app in activeRegionPolicy.
    const appShellOverDrawerScene: VomScene = {
      viewport,
      rootFrameId: "root",
      nodes: [
        node(1, null, { tag: "body", role: "RootWebArea" }),
        node(2, 1, {
          tag: "nav",
          role: "navigation",
          name: "Closed Drawer",
          position: "fixed",
          paintOrder: 2,
          zIndex: 1,
          rect: { x: 0, y: 0, w: 220, h: 800 },
        }),
        node(3, 2, {
          ...action,
          name: "Hidden drawer link",
          paintOrder: 2,
          rect: { x: 16, y: 60, w: 160, h: 36 },
        }),
        node(4, 1, {
          tag: "div",
          position: "fixed",
          paintOrder: 10,
          zIndex: 2,
          rect: fullRect,
        }),
        node(5, 4, {
          tag: "main",
          role: "main",
          paintOrder: 10,
          rect: fullRect,
          domAncestorIds: [4, 1],
        }),
        node(6, 5, {
          ...action,
          name: "Visible shell button",
          paintOrder: 10,
          rect: { x: 40, y: 60, w: 160, h: 36 },
          domAncestorIds: [5, 4, 1],
        }),
      ],
    };
    for (const result of rendered(appShellOverDrawerScene)) {
      expect(result.text).toContain("@layers 1 focus=L1");
      expect(result.ids).toEqual([6]);
    }

    // 3. A z-index:-1 backdrop inside a z-index:1000 modal wrapper paints at z=1000 above
    // the base page and must still fold <main> (both when wrapper is retained or flattened via rootZIndex).
    for (const flattenedWrapper of [false, true]) {
      const portalModalScene: VomScene = {
        viewport,
        rootFrameId: "root",
        nodes: [
          node(1, null, { role: "RootWebArea" }),
          node(2, 1, { tag: "main", role: "main", paintOrder: 1, rect: fullRect }),
          node(3, 2, {
            ...action,
            name: "Base page button",
            paintOrder: 1,
            rect: { x: 40, y: 40, w: 160, h: 36 },
          }),
          ...(flattenedWrapper
            ? []
            : [
                node(4, 1, {
                  tag: "div",
                  position: "fixed",
                  pointerEvents: "none",
                  paintOrder: 10,
                  zIndex: 1000,
                  rect: fullRect,
                }),
              ]),
          node(5, flattenedWrapper ? 1 : 4, {
            tag: "div",
            position: "fixed",
            paintOrder: 11,
            zIndex: -1,
            ...(flattenedWrapper ? { rootZIndex: 1000 } : {}),
            rect: fullRect,
          }),
          node(6, flattenedWrapper ? 1 : 4, {
            tag: "div",
            role: "dialog",
            position: "relative",
            paintOrder: 12,
            rect: { x: 300, y: 240, w: 400, h: 200 },
          }),
          node(7, 6, {
            ...action,
            name: "Confirm modal",
            paintOrder: 12,
            rect: { x: 340, y: 320, w: 120, h: 36 },
          }),
        ],
      };
      for (const result of rendered(portalModalScene)) {
        expect(result.text, `flattened=${flattenedWrapper}`).toContain("@layers 2 focus=L1");
        expect(result.ids, `flattened=${flattenedWrapper}`).toEqual([7]);
      }
    }
  });
});
