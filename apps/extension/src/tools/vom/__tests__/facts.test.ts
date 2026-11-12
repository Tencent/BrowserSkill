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
      "none",
      "border-box",
      "120px",
      "40px",
    ];
    const styles = REQUESTED_STYLES.map((style) =>
      style === "visibility" || style === "overflow-x" || style === "overflow-y"
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
                  : style === "background-image"
                    ? 12
                    : style === "background-clip" || style === "-webkit-background-clip"
                      ? 13
                      : style === "width"
                        ? 14
                        : style === "height"
                          ? 15
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
        "background-image": "none",
        "background-clip": "border-box",
        "-webkit-background-clip": "border-box",
        "overflow-x": "visible",
        "overflow-y": "visible",
        width: "120px",
        height: "40px",
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

  it("ignores HTML comment nodeValue in decodeDocument and preserves non-link white text over background-image or <img> media", async () => {
    // 1) Comment node (`nodeType === 8`, e.g. Vue `<!--v-if-->`) must never leak into element textContent
    const commentDecoded = await decodeDocument(
      {
        nodes: {
          backendNodeId: [1, 2, 3, 4],
          parentIndex: [-1, 0, 0, 0],
          nodeType: [1, 1, 8, 3],
          nodeName: [0, 1, 2, 3],
          nodeValue: [-1, -1, 4, 5],
        },
      },
      ["label", "span", "#comment", "#text", "v-if", "全选"],
    );
    expect(commentDecoded.nodes[0].textContent).toBe("全选");

    // 2) Non-link white headings/captions over CSS background-image or sibling <img> are preserved,
    // while explicit solid white-on-white injection on top of media is still stripped.
    const nodes: DecodedNode[] = [
      styledNode(1, null, "body", {
        bounds: [0, 0, 1000, 800],
        styles: { "background-color": "rgb(255, 255, 255)" },
      }),
      // Ancestor with CSS background-image (even with fallback white background-color)
      styledNode(10, 1, "section", {
        bounds: [0, 0, 1000, 260],
        styles: {
          "background-color": "rgb(255, 255, 255)",
          "background-image": 'url("https://cdn.example/banner.jpg")',
        },
      }),
      styledNode(11, 10, "h1", {
        bounds: [40, 80, 400, 48],
        styles: { color: "rgb(255, 255, 255)" },
        textContent: "年度精选纪录片",
      }),
      styledNode(12, 11, "#text", { textContent: "年度精选纪录片" }),
      // Card with sibling <img> cover and overlaid non-link white duration/caption
      styledNode(20, 1, "div", { bounds: [0, 300, 320, 180] }),
      styledNode(21, 20, "img", { bounds: [0, 300, 320, 180] }),
      styledNode(22, 20, "span", {
        bounds: [250, 450, 60, 22],
        styles: { position: "absolute", color: "rgb(255, 255, 255)" },
        textContent: "12.4万播放",
      }),
      styledNode(23, 22, "#text", { textContent: "12.4万播放" }),
      // Explicit opaque white-on-white injection placed over the same card IS still stripped
      styledNode(30, 20, "span", {
        bounds: [10, 310, 180, 20],
        styles: {
          color: "rgb(255, 255, 255)",
          "background-color": "rgb(255, 255, 255)",
        },
        textContent: "INJ_SOLID_ON_CARD",
      }),
      styledNode(31, 30, "#text", { textContent: "INJ_SOLID_ON_CARD" }),
    ];

    const index = await buildDocumentIndex(nodes);
    expect([...index.excludedBackendNodeIds].sort((a, b) => a - b)).toEqual([30, 31]);
  });

  it("clears pre-concatenated textContent on retained textstyle containers with visible or empty child elements", async () => {
    const nodes: DecodedNode[] = [
      styledNode(1, null, "body", {
        bounds: [0, 0, 1000, 800],
        styles: { "background-color": "rgb(255, 255, 255)" },
      }),
      // 1) font-size: 0px container with direct hidden #text AND visible child <span>
      styledNode(10, 1, "div", {
        styles: { "font-size": "0px" },
        textContent: "INJ_DIRECT_TEXT",
      }),
      styledNode(11, 10, "#text", { textContent: "INJ_DIRECT_TEXT" }),
      styledNode(12, 10, "span", {
        styles: { "font-size": "16px" },
        textContent: "Visible child text",
      }),
      styledNode(13, 12, "#text", { textContent: "Visible child text" }),
      // 2) zero-contrast container with direct hidden #cdata-section AND an empty visible <span>
      styledNode(20, 1, "p", {
        styles: { color: "rgb(255, 255, 255)" },
        textContent: "INJ_WITH_EMPTY_SPAN",
      }),
      styledNode(21, 20, "#cdata-section", { textContent: "INJ_WITH_EMPTY_SPAN" }),
      styledNode(22, 20, "span", { styles: { color: "rgb(0, 0, 0)" } }),
      // 3) stealth textstyle wrapper whose ONLY child is hidden (display:none / visibility:hidden / opacity:0) IS fully excluded
      styledNode(30, 1, "div", {
        attrs: { "aria-label": "INJ_HIDDEN_CHILD_ARIA" },
        styles: { "font-size": "0px" },
      }),
      styledNode(31, 30, "span", { styles: { visibility: "hidden" } }),
      styledNode(32, 30, "span", { styles: { opacity: "0" } }),
    ];

    const index = await buildDocumentIndex(nodes);
    expect([...index.excludedBackendNodeIds].sort((a, b) => a - b)).toEqual([11, 21, 30, 31, 32]);
    expect(index.nodes.get(10)?.textContent).toBeUndefined();
    expect(index.nodes.get(20)?.textContent).toBeUndefined();
    expect(index.nodes.get(12)?.textContent).toBe("Visible child text");
  });

  it("handles Tailwind v4 / CSS Color 4 opaque barriers, alpha channels, and oklch-on-oklch zero-contrast stealth", async () => {
    const nodes: DecodedNode[] = [
      styledNode(1, null, "body", {
        bounds: [0, 0, 1000, 800],
        styles: { "background-color": "rgb(255, 255, 255)" },
      }),
      // 1) Opaque Tailwind v4 dark bg-slate-900 (`oklch(...)`) stops white body inheritance
      styledNode(10, 1, "div", {
        styles: { "background-color": "oklch(0.208 0.042 265.755)" },
      }),
      styledNode(11, 10, "p", {
        styles: { color: "rgb(255, 255, 255)" },
        textContent: "Readable white text on slate-900",
      }),
      styledNode(12, 11, "#text", { textContent: "Readable white text on slate-900" }),
      // 2) Translucent CSS Color 4 scrim (`0.15 <= alpha < 0.9`, both decimal and %) acts as barrier
      styledNode(20, 1, "div", {
        styles: { "background-color": "oklch(0.208 0.042 265.755 / 50%)" },
      }),
      styledNode(21, 20, "span", {
        styles: { color: "rgb(255, 255, 255)" },
        textContent: "Readable white text on 50% oklch scrim",
      }),
      styledNode(22, 21, "#text", { textContent: "Readable white text on 50% oklch scrim" }),
      // 3) Nearly-transparent CSS Color 4 wrapper (`alpha < 0.15`) does NOT block white body inheritance
      styledNode(30, 1, "div", {
        styles: { "background-color": "oklch(0.208 0.042 265.755 / 5%)" },
      }),
      styledNode(31, 30, "span", {
        styles: { color: "rgb(255, 255, 255)" },
        textContent: "INJ_WHITE_THROUGH_FAINT_OKLCH",
      }),
      styledNode(32, 31, "#text", { textContent: "INJ_WHITE_THROUGH_FAINT_OKLCH" }),
      // 4) oklch-on-oklch inherited zero-contrast injection inside dark slate-900 container
      styledNode(40, 10, "span", {
        styles: { color: "oklch(0.208 0.042 265.755)" },
        textContent: "INJ_OKLCH_ON_OKLCH",
      }),
      styledNode(41, 40, "#text", { textContent: "INJ_OKLCH_ON_OKLCH" }),
      // 5) CSS Color 4 transparent foreground (`oklch(... / 0)`) and zero-alpha `color-mix()` without `transparent` keyword
      styledNode(50, 10, "span", {
        styles: { color: "oklch(0.9 0.05 200 / 0)" },
        textContent: "INJ_OKLCH_TRANSPARENT_FG",
      }),
      styledNode(51, 50, "#text", { textContent: "INJ_OKLCH_TRANSPARENT_FG" }),
      styledNode(52, 10, "span", {
        styles: { color: "color-mix(in oklab, currentColor 0%, rgba(0, 0, 0, 0))" },
        textContent: "INJ_COLOR_MIX_ZERO_ALPHA",
      }),
      styledNode(53, 52, "#text", { textContent: "INJ_COLOR_MIX_ZERO_ALPHA" }),
      // 6) Cross-space zero contrast: `oklch(1 0 0)` foreground on `rgb(255, 255, 255)` body
      styledNode(54, 1, "span", {
        styles: { color: "oklch(1 0 0)" },
        textContent: "INJ_OKLCH_WHITE_ON_RGB_WHITE",
      }),
      styledNode(55, 54, "#text", { textContent: "INJ_OKLCH_WHITE_ON_RGB_WHITE" }),
    ];

    const index = await buildDocumentIndex(nodes);
    expect([...index.excludedBackendNodeIds].sort((a, b) => a - b)).toEqual([
      31, 32, 40, 41, 50, 51, 52, 53, 54, 55,
    ]);
  });

  it("exempts gradient text using background-clip: text or -webkit-background-clip: text while stripping clip-text without background-image", async () => {
    const nodes: DecodedNode[] = [
      styledNode(1, null, "body", {
        bounds: [0, 0, 1000, 800],
        styles: { "background-color": "rgb(255, 255, 255)" },
      }),
      // 1) Computed background-clip: text + linear-gradient + transparent color (plus nested <strong> inheriting transparent color)
      styledNode(10, 1, "h1", {
        styles: {
          color: "rgba(0, 0, 0, 0)",
          "background-image": "linear-gradient(to right, rgb(59, 130, 246), rgb(147, 51, 234))",
          "background-clip": "text",
        },
        textContent: "Next-Gen",
      }),
      styledNode(11, 10, "#text", { textContent: "Next-Gen" }),
      styledNode(12, 10, "strong", {
        styles: {
          color: "rgba(0, 0, 0, 0)",
          "background-image": "none",
          "background-clip": "border-box",
        },
        textContent: "AI Browser",
      }),
      styledNode(13, 12, "#text", { textContent: "AI Browser" }),
      // 2) -webkit-background-clip: text with oklch(... / 0) transparent foreground
      styledNode(20, 1, "span", {
        styles: {
          color: "oklch(0 0 0 / 0)",
          "background-image": "radial-gradient(circle, red, blue)",
          "-webkit-background-clip": "text",
        },
        textContent: "Gradient Badge",
      }),
      styledNode(21, 20, "#text", { textContent: "Gradient Badge" }),
      // 3) Inline style fallback with -webkit-background-clip: text and background gradient
      styledNode(25, 1, "span", {
        attrs: {
          style:
            "background: linear-gradient(90deg, #ff0080, #7928ca); -webkit-background-clip: text; color: transparent",
        },
        styles: { color: "rgba(0, 0, 0, 0)", "background-image": "none" },
        textContent: "Inline Gradient",
      }),
      styledNode(26, 25, "#text", { textContent: "Inline Gradient" }),
      // 4) Attacker sets background-clip: text with background-image: none, transparent stops, same-color stops, or 0-span stop -> MUST be stripped
      styledNode(30, 1, "span", {
        styles: {
          color: "rgba(0, 0, 0, 0)",
          "background-image": "none",
          "background-clip": "text",
          "-webkit-background-clip": "text",
        },
        textContent: "INJ_FAKE_CLIP_TEXT",
      }),
      styledNode(31, 30, "#text", { textContent: "INJ_FAKE_CLIP_TEXT" }),
      styledNode(32, 1, "span", {
        styles: {
          color: "rgba(0, 0, 0, 0)",
          "background-image": "linear-gradient(rgba(0, 0, 0, 0), transparent)",
          "background-clip": "text",
          "-webkit-background-clip": "text",
        },
        textContent: "INJ_TRANSPARENT_GRAD",
      }),
      styledNode(33, 32, "#text", { textContent: "INJ_TRANSPARENT_GRAD" }),
      styledNode(34, 1, "span", {
        styles: {
          color: "rgba(0, 0, 0, 0)",
          "background-image": "linear-gradient(rgb(255, 255, 255), rgb(254, 254, 254))",
          "background-clip": "text",
          "-webkit-background-clip": "text",
        },
        textContent: "INJ_WHITE_GRAD_ON_WHITE",
      }),
      styledNode(35, 34, "#text", { textContent: "INJ_WHITE_GRAD_ON_WHITE" }),
      styledNode(36, 1, "span", {
        styles: {
          color: "rgba(0, 0, 0, 0)",
          "background-image": "linear-gradient(rgb(0, 0, 0) 0%, transparent 0%, transparent 100%)",
          "background-clip": "text",
          "-webkit-background-clip": "text",
        },
        textContent: "INJ_ZERO_SPAN_GRAD",
      }),
      styledNode(37, 36, "#text", { textContent: "INJ_ZERO_SPAN_GRAD" }),
    ];

    const index = await buildDocumentIndex(nodes);
    expect([...index.excludedBackendNodeIds].sort((a, b) => a - b)).toEqual([
      30, 31, 32, 33, 34, 35, 36, 37,
    ]);
  });

  it("strips 1px microboxes on 2x HiDPI/Retina layouts and when overflow-x/y are computed as visible", async () => {
    // A) Auto-inferred 2x Retina scale from <html> (width: 1280px, bounds width: 2560)
    const retinaNodes: DecodedNode[] = [
      styledNode(1, null, "html", {
        bounds: [0, 0, 2560, 1600],
        styles: { width: "1280px", height: "800px" },
      }),
      styledNode(2, 1, "body", {
        bounds: [0, 0, 2560, 1600],
        styles: { width: "1280px", height: "800px" },
      }),
      // 1px x 1px clipped stealth box -> [20, 20, 2, 2] on 2x Retina
      styledNode(10, 2, "div", {
        bounds: [20, 20, 2, 2],
        styles: {
          width: "1px",
          height: "1px",
          "overflow-x": "hidden",
          "overflow-y": "hidden",
        },
        textContent: "INJ_RETINA_CLIPPED",
      }),
      styledNode(11, 10, "#text", { textContent: "INJ_RETINA_CLIPPED" }),
      // 1px x 1px unclipped microbox (`overflow-x/y: visible`) without overflowing child -> stripped!
      styledNode(20, 2, "div", {
        bounds: [40, 20, 2, 2],
        styles: {
          width: "1px",
          height: "1px",
          "overflow-x": "visible",
          "overflow-y": "visible",
        },
        textContent: "INJ_RETINA_MICROBOX_VISIBLE_OVERFLOW",
      }),
      styledNode(21, 20, "#text", { textContent: "INJ_RETINA_MICROBOX_VISIBLE_OVERFLOW" }),
      // 1px x 1px unclipped anchor with a genuinely visible overflowing child ([80, 40] >= 4 layout px) -> preserved!
      styledNode(30, 2, "div", {
        bounds: [60, 20, 2, 2],
        styles: {
          width: "1px",
          height: "1px",
          "overflow-x": "visible",
          "overflow-y": "visible",
        },
      }),
      styledNode(31, 30, "span", {
        bounds: [60, 20, 80, 40],
        styles: { width: "40px", height: "20px" },
        textContent: "Visible Popover",
      }),
      styledNode(32, 31, "#text", { textContent: "Visible Popover" }),
      // width: 1px; height: 1px; padding: 20px -> border-box is 41px CSS ([82, 82] layout px) -> preserved!
      styledNode(40, 2, "div", {
        bounds: [100, 100, 82, 82],
        styles: {
          width: "1px",
          height: "1px",
          "overflow-x": "hidden",
          "overflow-y": "hidden",
        },
        textContent: "Padded Pill",
      }),
      styledNode(41, 40, "#text", { textContent: "Padded Pill" }),
    ];

    const autoIndex = await buildDocumentIndex(retinaNodes);
    expect([...autoIndex.excludedBackendNodeIds].sort((a, b) => a - b)).toEqual([10, 11, 20, 21]);

    // B) Explicit layoutScale = 2 on synthetic nodes without CSS width/height
    const syntheticNodes: DecodedNode[] = [
      styledNode(1, null, "body", { bounds: [0, 0, 2000, 1600] }),
      styledNode(10, 1, "span", {
        bounds: [10, 10, 2, 2],
        styles: { "overflow-x": "visible", "overflow-y": "visible" },
        textContent: "INJ_EXPLICIT_SCALE_2",
      }),
      styledNode(11, 10, "#text", { textContent: "INJ_EXPLICIT_SCALE_2" }),
      styledNode(20, 1, "span", {
        bounds: [10, 10, 4, 4],
        styles: { "overflow-x": "hidden", "overflow-y": "hidden" },
        textContent: "2px CSS box at 2x scale",
      }),
    ];
    const explicitIndex = await buildDocumentIndex(syntheticNodes, undefined, false, 2);
    expect([...explicitIndex.excludedBackendNodeIds].sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it("preserves scrolled content with negative coordinates inside overflow:auto/scroll containers while stripping offscreen injections", async () => {
    const nodes: DecodedNode[] = [
      styledNode(1, null, "html", {
        bounds: [0, 0, 2560, 1600],
        styles: { width: "1280px", height: "800px" },
      }),
      // Viewport-propagated `body { overflow-y: scroll }` must NOT disable offscreen stripping
      styledNode(2, 1, "body", {
        bounds: [0, 0, 2560, 1600],
        styles: {
          width: "1280px",
          height: "800px",
          "overflow-x": "visible",
          "overflow-y": "scroll",
        },
      }),
      // Inner scrollable modal (`overflow-y: auto`) with items scrolled 700 CSS px (-1400 layout px) above viewport
      styledNode(10, 2, "div", {
        bounds: [200, 100, 800, 600],
        styles: { "overflow-x": "hidden", "overflow-y": "auto" },
      }),
      styledNode(11, 10, "div", {
        bounds: [200, -1400, 760, 64],
        textContent: "Scrolled modal row #1",
      }),
      styledNode(12, 11, "#text", { textContent: "Scrolled modal row #1" }),
      // Extreme `position: absolute; left: -9999px` AND `position: relative; left: -99999px` OR `position: absolute; left: -2000px` inside scroll container ARE stripped
      styledNode(15, 10, "span", {
        bounds: [-19998, 100, 200, 30],
        styles: { position: "absolute" },
        textContent: "INJ_EXTREME_INSIDE_MODAL",
      }),
      styledNode(16, 15, "#text", { textContent: "INJ_EXTREME_INSIDE_MODAL" }),
      styledNode(17, 10, "span", {
        bounds: [-199998, 100, 200, 30],
        styles: { position: "relative" },
        textContent: "INJ_REL_INSIDE_MODAL",
      }),
      styledNode(18, 17, "#text", { textContent: "INJ_REL_INSIDE_MODAL" }),
      styledNode(19, 10, "span", {
        bounds: [-4000, 100, 200, 30],
        styles: { position: "absolute" },
        textContent: "INJ_ABS_2000_INSIDE_MODAL",
      }),
      // Horizontal scroll table (`overflow-x: scroll`) scrolled right so first column is at x = -1200
      styledNode(20, 2, "div", {
        bounds: [40, 200, 1200, 400],
        styles: { "overflow-x": "scroll", "overflow-y": "hidden" },
      }),
      styledNode(21, 20, "td", {
        bounds: [-1200, 220, 200, 48],
        textContent: "Order ID #8891",
      }),
      styledNode(22, 21, "#text", { textContent: "Order ID #8891" }),
      // Outside scroll container on 2x Retina: -300 CSS px (-600 layout px > -1000 threshold) is preserved
      styledNode(30, 2, "div", {
        bounds: [40, -640, 400, 80],
        textContent: "Near-top banner (-280 CSS px)",
      }),
      // Outside scroll container: top: -600px CSS (-1200 layout px < -1000 threshold) IS stripped
      styledNode(40, 2, "div", {
        bounds: [40, -1200, 400, 40],
        styles: { position: "absolute" },
        textContent: "INJ_OFFSCREEN_TOP",
      }),
      styledNode(41, 40, "#text", { textContent: "INJ_OFFSCREEN_TOP" }),
    ];

    const index = await buildDocumentIndex(nodes);
    expect([...index.excludedBackendNodeIds].sort((a, b) => a - b)).toEqual([
      15, 16, 17, 18, 19, 40, 41,
    ]);
  });
});
