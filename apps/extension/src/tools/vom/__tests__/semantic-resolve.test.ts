import { describe, expect, it, vi } from "vitest";
import type { CapturedNode } from "../capture";
import { buildSemanticGraph, resolveSemanticGraph, type SemanticAxNode } from "../semantic-graph";

function dom(id: number, tag: string, textContent?: string): CapturedNode {
  return {
    backendNodeId: id,
    parentBackendNodeId: id === 1 ? null : 1,
    tag,
    attrs: {},
    textContent,
    rect: { x: 0, y: 0, w: 100, h: 20 },
    paintOrder: id,
    position: "static",
    pointerEvents: "auto",
  };
}

function graph(domNodes: CapturedNode[], axNodes: SemanticAxNode[] = []) {
  return buildSemanticGraph({
    viewport: { width: 800, height: 600 },
    rootFrameId: "main",
    documents: [
      { frameId: "main", contextScopeId: "main", target: { tabId: 1 }, domNodes, axNodes },
    ],
  });
}

function byBackend(resolved: ReturnType<typeof resolveSemanticGraph>, id: number) {
  return [...resolved.nodes.values()].find((node) => node.backendNodeId === id)?.vom;
}

describe("semantic sibling context", () => {
  it.each(
    [512, 2048].flatMap((count) => [false, true].map((ax) => ({ count, ax }))),
  )("bounds sibling searches linearly for $count nodes (AX: $ax)", ({ count, ax }) => {
    const domNodes = [
      dom(1, "section"),
      ...Array.from({ length: count }, (_, i) =>
        dom(i + 2, i % 4 === 3 ? "input" : "div", i % 4 === 3 ? undefined : `Row ${i}`),
      ),
    ];
    const axNodes: SemanticAxNode[] = ax
      ? [
          {
            nodeId: "root",
            backendDOMNodeId: 1,
            childIds: domNodes
              .slice(1)
              .map((node) => String(node.backendNodeId))
              .reverse(),
          },
          ...domNodes.slice(1).map((node) => ({
            nodeId: String(node.backendNodeId),
            parentId: "root",
            backendDOMNodeId: node.backendNodeId,
            role: { type: "role", value: node.tag === "input" ? "textbox" : "StaticText" },
            ...(node.textContent
              ? { name: { type: "computedString", value: node.textContent } }
              : {}),
          })),
        ]
      : [];
    const input = graph(domNodes, axNodes);
    const original = Array.prototype.indexOf;
    let searchedSlots = 0;
    const search = vi.spyOn(Array.prototype, "indexOf").mockImplementation(function (
      this: unknown[],
      value: unknown,
      fromIndex?: number,
    ) {
      searchedSlots += this.length;
      return original.call(this, value, fromIndex);
    });
    let resolved: ReturnType<typeof resolveSemanticGraph>;
    try {
      resolved = resolveSemanticGraph(input);
    } finally {
      search.mockRestore();
    }
    expect(searchedSlots).toBeLessThanOrEqual(count * 16);
    expect(resolved.nodes.size).toBe(count + 1);
    expect(byBackend(resolved, 5)?.name).toBe(ax ? "Row 4" : "Row 2");
    expect(byBackend(resolved, 2)?.nearbyText).toBe("Row 1 Row 2");
  });

  it("uses AX child order for preceding labels and DOM order for nearby text", () => {
    const resolved = resolveSemanticGraph(
      graph(
        [dom(1, "section"), dom(2, "div", "DOM first"), dom(3, "input"), dom(4, "div", "DOM last")],
        [
          { nodeId: "root", backendDOMNodeId: 1, childIds: ["label", "field", "tail"] },
          {
            nodeId: "field",
            parentId: "root",
            backendDOMNodeId: 3,
            role: { type: "role", value: "textbox" },
          },
          {
            nodeId: "tail",
            parentId: "root",
            backendDOMNodeId: 2,
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: "AX tail" },
          },
          {
            nodeId: "label",
            parentId: "root",
            backendDOMNodeId: 4,
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: "AX label" },
          },
        ],
      ),
    );
    expect(byBackend(resolved, 3)).toMatchObject({
      name: "AX label",
      nearbyText: "DOM first DOM last",
    });
  });
});
