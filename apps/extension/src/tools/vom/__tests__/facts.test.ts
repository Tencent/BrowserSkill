import { describe, expect, it, vi } from "vitest";
import { OVERLAY_HOST_MARKER_ATTR } from "@/lib/overlay-bridge";
import { createCaptureCheckpoint } from "../capture-abort";
import { buildDocumentIndex, type DecodedNode } from "../facts";
import { decodeDocument, REQUESTED_STYLES, VISUAL_SNAPSHOT } from "../snapshot";

function node(id: number, parent: number | null): DecodedNode {
  return {
    backendNodeId: id,
    parentBackendNodeId: parent,
    tag: "div",
    attrs: {},
    paintOrder: 0,
    position: "static",
    pointerEvents: "auto",
  };
}

describe("document facts", () => {
  it.each([
    1_000, 10_000, 100_000,
  ])("indexes deep and wide inputs of %i without copying ancestors", async (count) => {
    for (const wide of [false, true]) {
      let reads = 0;
      const input = Array.from({ length: count }, (_, i) => {
        const item = node(i, i ? (wide ? 0 : i - 1) : null);
        if (i === 0) item.attrs[OVERLAY_HOST_MARKER_ATTR] = "";
        Object.defineProperty(item, "parentBackendNodeId", {
          get: () => {
            reads++;
            return i ? (wide ? 0 : i - 1) : null;
          },
        });
        return item;
      }).reverse(); // parent need not precede child
      const index = await buildDocumentIndex(input);
      expect(index.nodes.size).toBe(count);
      expect(index.excludedBackendNodeIds.size).toBe(count);
      expect(reads).toBeLessThanOrEqual(count * 8);
      expect(index.nodes.get(count - 1)).toBe(input[0]);
    }
  });

  it("handles cycles and orphans and propagates overlay through shadow roots", async () => {
    const host = { ...node(1, null), attrs: { [OVERLAY_HOST_MARKER_ATTR]: "" } };
    const input = [
      node(3, 2),
      { ...node(2, 1), tag: "#document-fragment" },
      host,
      node(4, 99),
      node(5, 6),
      node(6, 5),
      node(7, 6),
    ];
    const index = await buildDocumentIndex(input);
    expect([...index.excludedBackendNodeIds].sort()).toEqual([1, 2, 3]);
    expect(index.nodes.size).toBe(input.length);
  });

  it("does not propagate a descendant overlay backwards into a cycle", async () => {
    const overlay = { ...node(3, 1), attrs: { [OVERLAY_HOST_MARKER_ATTR]: "" } };
    const index = await buildDocumentIndex([overlay, node(1, 2), node(2, 1)]);
    expect([...index.excludedBackendNodeIds]).toEqual([3]);
  });

  it("decodes current observation bounds, styles and attributes without projecting coordinates", async () => {
    const strings = [
      "div",
      "aria-hidden",
      "true",
      "inert",
      "",
      "visible",
      "0",
      "static",
      "auto",
      "16px",
      "rgb(0, 0, 0)",
      "rgba(0, 0, 0, 0)",
    ];
    const styles = REQUESTED_STYLES.map((style) =>
      style === "visibility"
        ? 5
        : style === "opacity"
          ? 6
          : style === "position"
            ? 7
            : style === "font-size"
              ? 9
              : style === "color"
                ? 10
                : style === "background-color"
                  ? 11
                  : 8,
    );
    const { nodes } = await decodeDocument(
      {
        nodes: { backendNodeId: [1], parentIndex: [-1], nodeName: [0], attributes: [[1, 2, 3, 4]] },
        layout: { nodeIndex: [0], bounds: [[10, 20, 120, 40]], styles: [styles] },
      },
      strings,
    );
    expect(nodes[0].attrs).toEqual({ "aria-hidden": "true", inert: "" });
    expect(nodes[0].layout).toEqual({
      boundsSpace: "snapshot-document-layout",
      bounds: [10, 20, 120, 40],
      styles: {
        position: "static",
        "pointer-events": "auto",
        cursor: "auto",
        visibility: "visible",
        opacity: "0",
        "font-size": "16px",
        color: "rgb(0, 0, 0)",
        "background-color": "rgba(0, 0, 0, 0)",
      },
    });
    expect(nodes[0]).not.toHaveProperty("rect");
    expect(nodes[0]).not.toHaveProperty("excluded");
  });

  it.each([
    undefined,
    { index: [1] },
  ])("decodes sparse clickability by node index: %j", async (isClickable) => {
    const { nodes } = await decodeDocument(
      {
        nodes: {
          backendNodeId: [41, 72, 103],
          parentIndex: [-1, 0, 0],
          nodeName: [0, 1, 1],
          isClickable,
        },
      },
      ["ul", "li"],
    );
    expect(nodes.filter((node) => node.clickable).map((node) => node.backendNodeId)).toEqual(
      isClickable ? [72] : [],
    );
  });

  it("keeps short blocks synchronous and checks cancellation after yielding", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const controller = new AbortController();
      const checkpoint = createCaptureCheckpoint(controller.signal);
      for (let i = 0; i < 20; i++) expect(checkpoint()).toBeUndefined();
      clock.mockReturnValue(9);
      const pending = checkpoint();
      expect(pending).toBeInstanceOf(Promise);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clock.mockRestore();
    }
  });

  it("checks cancellation at bounded indexing blocks", async () => {
    const controller = new AbortController();
    const input = Array.from({ length: 100_000 }, (_, i) => node(i, i ? i - 1 : null));
    let reads = 0;
    for (const item of input)
      Object.defineProperty(item, "attrs", {
        get: () => {
          reads++;
          if (reads === 100) controller.abort();
          return {};
        },
      });
    await expect(buildDocumentIndex(input, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(reads).toBeLessThanOrEqual(356);
  });
});

describe("visual ancestry facts", () => {
  it("distinguishes document roots, malformed roots, missing parents and cycles", async () => {
    const input = [
      { ...node(0, null), nodeType: 9 },
      { ...node(1, 0), nodeType: 1 },
      { ...node(2, 1), nodeType: 11 },
      node(3, 2),
      node(4, 99),
      node(5, 6),
      node(6, 5),
      node(7, 5),
      { ...node(8, null), nodeType: 1 },
      { ...node(9, null), nodeType: 9, parentMissing: true },
    ];
    const index = await buildDocumentIndex(input.reverse(), undefined, true);
    for (const id of [0, 1, 2, 3]) expect(index.ancestryComplete!.get(id)).toBe(true);
    for (const id of [4, 5, 6, 7, 8, 9]) expect(index.ancestryComplete!.get(id)).toBe(false);
  });

  it("retains client offsets in their source units and does not disguise missing parent indices", async () => {
    const decoded = await decodeDocument(
      {
        nodes: { backendNodeId: [1, 2], nodeType: [1, 1], nodeName: [0, 0], parentIndex: [99] },
        layout: {
          nodeIndex: [0],
          bounds: [[745, 455.625, 97, 59.5]],
          clientRects: [[5, 5, 68, 38]],
        },
      },
      ["div"],
      undefined,
      VISUAL_SNAPSHOT,
    );
    expect(decoded.nodes[0].layout?.clientRect).toEqual([5, 5, 68, 38]);
    expect(decoded.nodes[0].layout?.bounds).toEqual([745, 455.625, 97, 59.5]);
    expect(decoded.nodes.every((node) => node.parentMissing)).toBe(true);
    const index = await buildDocumentIndex(decoded.nodes, undefined, true);
    expect([...index.ancestryComplete!.values()]).toEqual([false, false]);
  });
});

describe("computed-style stealth prompt-injection stripper", () => {
  function styledNode(
    id: number,
    parent: number | null,
    tag: string,
    options: {
      attrs?: Record<string, string>;
      bounds?: number[];
      styles?: Partial<Record<string, string>>;
      textContent?: string;
      clickable?: boolean;
    } = {},
  ): DecodedNode {
    return {
      backendNodeId: id,
      parentBackendNodeId: parent,
      nodeType: tag.startsWith("#") ? 3 : 1,
      tag,
      attrs: options.attrs ?? {},
      ...(options.textContent !== undefined ? { textContent: options.textContent } : {}),
      ...(options.clickable ? { clickable: true } : {}),
      paintOrder: id,
      position: options.styles?.position ?? "static",
      pointerEvents: options.styles?.["pointer-events"] ?? "auto",
      ...(tag.startsWith("#")
        ? {}
        : {
            layout: {
              boundsSpace: "snapshot-document-layout",
              bounds: options.bounds ?? [10, 20, 200, 30],
              styles: {
                position: "static",
                "pointer-events": "auto",
                cursor: "auto",
                visibility: "visible",
                opacity: "1",
                "font-size": "16px",
                color: "rgb(17, 17, 17)",
                "background-color": "rgba(0, 0, 0, 0)",
                ...options.styles,
              },
            },
          }),
    };
  }

  it("strips inline and stylesheet-computed opacity<0.05, font-size<=1.5px, zero-contrast, offscreen and 1px-clipped subtrees including #text children", async () => {
    const nodes: DecodedNode[] = [
      styledNode(1, null, "html", { bounds: [0, 0, 1000, 800] }),
      styledNode(2, 1, "body", {
        bounds: [0, 0, 1000, 800],
        styles: { "background-color": "rgb(255, 255, 255)" },
      }),
      styledNode(3, 2, "p", { textContent: "正常业务摘要" }),
      // 1) CSS class opacity: 0.001 (no inline style)
      styledNode(10, 2, "span", {
        attrs: { class: "ghost-op" },
        styles: { opacity: "0.001" },
        textContent: "INJ_OPACITY",
      }),
      styledNode(11, 10, "#text", { textContent: "INJ_OPACITY" }),
      // 2) CSS class font-size: 1px (no inline style)
      styledNode(20, 2, "div", {
        attrs: { class: "micro-font" },
        styles: { "font-size": "1px" },
        textContent: "INJ_FONTSIZE",
      }),
      styledNode(21, 20, "#text", { textContent: "INJ_FONTSIZE" }),
      // 3) Zero-contrast color === ancestor background-color
      styledNode(30, 2, "span", {
        attrs: { class: "same-color" },
        styles: { color: "rgb(255, 255, 255)" },
        textContent: "INJ_ZEROCONTRAST",
      }),
      styledNode(31, 30, "#text", { textContent: "INJ_ZEROCONTRAST" }),
      // 4) Offscreen left: -9999px
      styledNode(40, 2, "div", {
        bounds: [-9999, -9999, 200, 20],
        textContent: "INJ_OFFSCREEN",
      }),
      styledNode(41, 40, "#text", { textContent: "INJ_OFFSCREEN" }),
      // 5) 1px x 1px clipped block
      styledNode(50, 2, "div", {
        attrs: { class: "clip-box" },
        bounds: [10, 10, 1, 1],
        styles: { "overflow-x": "hidden", "overflow-y": "hidden" },
        textContent: "INJ_CLIPPED",
      }),
      styledNode(51, 50, "#text", { textContent: "INJ_CLIPPED" }),
    ];

    const index = await buildDocumentIndex(nodes);
    expect(index.excludedBackendNodeIds.has(3)).toBe(false);
    for (const stealthId of [10, 11, 20, 21, 30, 31, 40, 41, 50, 51]) {
      expect(index.excludedBackendNodeIds.has(stealthId)).toBe(true);
    }
  });

  it("exempts interactive controls, .sr-only button accessible labels, <label for> and aria-labelledby/describedby targets", async () => {
    const nodes: DecodedNode[] = [
      styledNode(1, null, "body", { bounds: [0, 0, 1000, 800] }),
      // Icon button with 1px x 1px .sr-only label inside
      styledNode(10, 1, "button", { bounds: [20, 20, 36, 36] }),
      styledNode(11, 10, "span", {
        attrs: { class: "sr-only" },
        bounds: [20, 20, 1, 1],
        styles: { "overflow-x": "hidden", "overflow-y": "hidden" },
        textContent: "关闭弹窗",
      }),
      styledNode(12, 11, "#text", { textContent: "关闭弹窗" }),
      // Hidden aria-labelledby target outside the control
      styledNode(20, 1, "span", {
        attrs: { id: "combo-lbl", class: "sr-only" },
        bounds: [-2000, 0, 1, 1],
        textContent: "结算账期",
      }),
      styledNode(21, 20, "#text", { textContent: "结算账期" }),
      styledNode(22, 1, "div", {
        attrs: { role: "combobox", "aria-labelledby": "combo-lbl" },
        bounds: [20, 80, 180, 32],
      }),
      // .sr-only <label for="...">
      styledNode(30, 1, "label", {
        attrs: { for: "search-q", class: "sr-only" },
        bounds: [0, -1000, 1, 1],
        textContent: "站内搜索",
      }),
      styledNode(31, 1, "input", {
        attrs: { id: "search-q", type: "search" },
        bounds: [20, 130, 200, 32],
      }),
      // Opacity-0 file input itself must never be stripped
      styledNode(40, 1, "input", {
        attrs: { type: "file" },
        bounds: [20, 180, 1, 1],
        styles: { opacity: "0" },
      }),
    ];

    const index = await buildDocumentIndex(nodes);
    expect([...index.excludedBackendNodeIds]).toEqual([]);
  });

  it("preserves text-free modal backdrops, empty layout spacers and white text on dark translucent scrims", async () => {
    const nodes: DecodedNode[] = [
      styledNode(1, null, "body", {
        bounds: [0, 0, 1000, 800],
        styles: { "background-color": "rgb(255, 255, 255)" },
      }),
      // Semi-transparent modal backdrop (#0008 -> rgba(0, 0, 0, 0.533)) with default black UA color
      styledNode(10, 1, "div", {
        attrs: { id: "backdrop" },
        bounds: [0, 0, 1000, 800],
        styles: {
          position: "fixed",
          color: "rgb(0, 0, 0)",
          "background-color": "rgba(0, 0, 0, 0.533)",
        },
      }),
      // Opaque black empty backdrop / spacer (no text content)
      styledNode(11, 1, "div", {
        bounds: [0, 0, 1000, 800],
        styles: {
          position: "fixed",
          color: "rgb(0, 0, 0)",
          "background-color": "rgb(0, 0, 0)",
        },
      }),
      // Empty opacity:0 non-rendered div (used by layout / visibility checks)
      styledNode(12, 1, "div", {
        bounds: [10, 90, 100, 30],
        styles: { opacity: "0" },
      }),
      // Dark translucent banner over white body with readable white heading text
      styledNode(20, 1, "div", {
        bounds: [0, 0, 1000, 200],
        styles: { "background-color": "rgba(0, 0, 0, 0.6)" },
      }),
      styledNode(21, 20, "h2", {
        styles: { color: "rgb(255, 255, 255)" },
        textContent: "账单核对中心",
      }),
      styledNode(22, 21, "#text", { textContent: "账单核对中心" }),
    ];

    const index = await buildDocumentIndex(nodes);
    expect([...index.excludedBackendNodeIds]).toEqual([]);
  });
});
