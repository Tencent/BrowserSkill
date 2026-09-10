import { describe, expect, it, vi } from "vitest";
import { OVERLAY_HOST_MARKER_ATTR } from "@/lib/overlay-bridge";
import { createCaptureCheckpoint } from "../capture-abort";
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
    const strings = ["div", "aria-hidden", "true", "inert", "", "visible", "0", "static", "auto"];
    const styles = REQUESTED_STYLES.map((style) =>
      style === "visibility" ? 5 : style === "opacity" ? 6 : style === "position" ? 7 : 8,
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
      },
    });
    expect(nodes[0]).not.toHaveProperty("rect");
    expect(nodes[0]).not.toHaveProperty("excluded");
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
