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

  it("extracts up to 10 native <select> options penetrating <optgroup> and omits them on sensitive selects", () => {
    const optionNodes: CapturedNode[] = Array.from({ length: 11 }, (_, idx) => ({
      ...dom(10 + idx, "option", `大区 ${idx + 1}`),
      parentBackendNodeId: idx < 5 ? 3 : 4,
      attrs: { value: `reg_${idx + 1}` },
      ...(idx === 1 ? { checked: true } : { checked: false }),
    }));
    const resolved = resolveSemanticGraph(
      graph([
        dom(1, "form"),
        { ...dom(2, "select"), parentBackendNodeId: 1, formValue: "reg_2" },
        { ...dom(3, "optgroup"), parentBackendNodeId: 2, attrs: { label: "南方" } },
        { ...dom(4, "optgroup"), parentBackendNodeId: 2, attrs: { label: "北方" } },
        ...optionNodes,
        {
          ...dom(30, "select"),
          parentBackendNodeId: 1,
          attrs: { autocomplete: "cc-exp-month" },
        },
        { ...dom(31, "option", "01"), parentBackendNodeId: 30, attrs: { value: "01" } },
      ]),
    );
    const selectVom = byBackend(resolved, 2);
    expect(selectVom?.selectOptions).toHaveLength(10);
    expect(selectVom?.selectOptionsTruncated).toBe(true);
    expect(selectVom?.selectOptions?.[1]).toEqual({
      value: "reg_2",
      label: "大区 2",
      selected: true,
    });
    expect(byBackend(resolved, 30)?.selectOptions).toBeUndefined();
  });

  it("computes distinguishing rowAnchor for table rows and virtual-row pools while ignoring timers and form rows", () => {
    const vrows: CapturedNode[] = [];
    for (let slot = 0; slot < 6; slot++) {
      const rowId = 100 + slot * 10;
      vrows.push(
        { ...dom(rowId, "div"), parentBackendNodeId: 50, attrs: { class: "vrow" } },
        {
          ...dom(rowId + 1, "span", `TK-100${slot} | P1 | 网关续期`),
          parentBackendNodeId: rowId,
        },
        { ...dom(rowId + 2, "button", "批准发布"), parentBackendNodeId: rowId },
      );
    }
    const resolved = resolveSemanticGraph(
      graph([
        dom(1, "main"),
        { ...dom(10, "table"), parentBackendNodeId: 1 },
        { ...dom(11, "tr"), parentBackendNodeId: 10 },
        { ...dom(12, "td", "00:15"), parentBackendNodeId: 11 },
        { ...dom(13, "td", "ORD-8841"), parentBackendNodeId: 11 },
        { ...dom(14, "td"), parentBackendNodeId: 11 },
        { ...dom(15, "button", "退款"), parentBackendNodeId: 14 },
        { ...dom(50, "div"), parentBackendNodeId: 1, attrs: { id: "pool" } },
        ...vrows,
      ]),
    );
    expect(byBackend(resolved, 15)?.rowAnchor).toBe("ORD-8841");
    expect(byBackend(resolved, 102)?.rowAnchor).toBe("TK-1000 | P1 | 网关续期");
  });
});
