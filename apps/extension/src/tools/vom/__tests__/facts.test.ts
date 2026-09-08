import { describe, expect, it } from "vitest";
import { OVERLAY_HOST_MARKER_ATTR } from "@/lib/overlay-bridge";
import { buildDocumentIndex, type DecodedNode } from "../facts";
import { decodeDocument, REQUESTED_STYLES } from "../snapshot";

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
      expect(index.ancestry.get(count - 1)).toEqual({ complete: true, overlay: false });
      expect(index.children.get(0)?.length).toBe(wide ? count - 1 : 1);
      expect(reads).toBeLessThanOrEqual(count * 8);
      expect(index.nodes.get(count - 1)).toBe(input[0]);
    }
  });

  it("marks cycles and orphans incomplete and propagates overlay through shadow roots", async () => {
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
    for (const id of [4, 5, 6, 7]) expect(index.ancestry.get(id)?.complete).toBe(false);
  });

  it("does not propagate a descendant overlay backwards into a cycle", async () => {
    const overlay = { ...node(3, 1), attrs: { [OVERLAY_HOST_MARKER_ATTR]: "" } };
    const index = await buildDocumentIndex([overlay, node(1, 2), node(2, 1)]);
    expect([...index.excludedBackendNodeIds]).toEqual([3]);
  });

  it("does not treat a missing snapshot parent as a complete root", async () => {
    const { nodes } = await decodeDocument(
      { nodes: { backendNodeId: [1], nodeName: [0], parentIndex: [99] } },
      ["div"],
    );
    const index = await buildDocumentIndex(nodes);
    expect(index.ancestry.get(1)?.complete).toBe(false);
  });

  it("retains raw box units and independent style/interaction evidence", async () => {
    const strings = [
      "html",
      "canvas",
      "aria-hidden",
      "true",
      "inert",
      "",
      "hidden",
      "visible",
      "0",
      "auto",
      "scroll",
      "matrix(2,0,0,2,0,0)",
    ];
    const styles = REQUESTED_STYLES.map((style) =>
      style === "visibility"
        ? 7
        : style === "opacity"
          ? 8
          : style === "overflow-x"
            ? 10
            : style === "transform"
              ? 11
              : 9,
    );
    const { nodes } = await decodeDocument(
      {
        nodes: {
          backendNodeId: [1, 2],
          parentIndex: [-1, 0],
          nodeName: [0, 1],
          attributes: [[2, 3, 4, 5], []],
        },
        layout: {
          nodeIndex: [0, 1],
          bounds: [
            [0, 0, 200, 100],
            [10, 20, 120, 40],
          ],
          clientRects: [
            [5, 5, 90, 40],
            [0, 0, 120, 40],
          ],
          styles: [styles, styles],
        },
      },
      strings,
    );
    expect(nodes[0].attrs).toEqual({ "aria-hidden": "true", inert: "" });
    expect(nodes[0].layout).toMatchObject({
      boundsSpace: "snapshot-document-css",
      clientSpace: "unscaled-client-offset-css",
      clientRect: [5, 5, 90, 40],
      styles: {
        visibility: "visible",
        opacity: "0",
        "overflow-x": "scroll",
        transform: "matrix(2,0,0,2,0,0)",
      },
    });
    expect(nodes[0]).not.toHaveProperty("rect");
    expect(nodes[0]).not.toHaveProperty("excluded");
  });

  it("yields during large inputs so cancellation interrupts indexing", async () => {
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
