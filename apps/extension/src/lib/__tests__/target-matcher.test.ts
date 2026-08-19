import type { RenderedRef } from "@browser-skill/vom";
import { describe, expect, it } from "vitest";
import type { CapturedNode } from "@/tools/vom/capture";
import { ObservationNodeIndex, type RegisteredObservation } from "../recording/observation-capture";
import { matchObservationTarget } from "../recording/target-matcher";

function node(backendNodeId: number, frameId: string, x = 10): CapturedNode {
  return {
    backendNodeId,
    parentBackendNodeId: null,
    frameId,
    tag: "button",
    attrs: {},
    rect: { x, y: 20, w: 100, h: 30 },
    paintOrder: 1,
    position: "static",
    pointerEvents: "auto",
  };
}

function observation(
  documents: Array<{ frameId: string; domNodes: CapturedNode[] }>,
  refs: RenderedRef[],
): RegisteredObservation {
  return {
    stateId: "s1",
    rootFrameId: "root",
    index: new ObservationNodeIndex({ rootFrameId: "root", frameDocuments: documents, refs }),
    url: "https://example.com",
  };
}

describe("matchObservationTarget", () => {
  it("matches a unique node using canonical top-level viewport geometry", () => {
    const target = matchObservationTarget({
      observation: observation(
        [{ frameId: "root", domNodes: [node(42, "root")] }],
        [{ ref: "e1", backendNodeId: 42, role: "button", name: "发布", line: 1 }],
      ),
      hint: { geometry: { rect: { x: 10, y: 20, w: 100, h: 30 }, tag: "button" } },
    });
    expect(target).toEqual({ ref: "e1", role: "button", name: "发布" });
  });

  it("uses frame id with backend node id so sibling frames cannot collide", () => {
    const target = matchObservationTarget({
      observation: observation(
        [
          { frameId: "left", domNodes: [node(42, "left")] },
          { frameId: "right", domNodes: [node(42, "right")] },
        ],
        [
          { ref: "e1", backendNodeId: 42, frameId: "left", line: 1 },
          { ref: "e2", backendNodeId: 42, frameId: "right", line: 2 },
        ],
      ),
      hint: {
        frameId: "right",
        geometry: { rect: { x: 10, y: 20, w: 100, h: 30 }, tag: "button" },
      },
    });
    expect(target.ref).toBe("e2");
  });

  it("restricts a missing frame hint to the root frame", () => {
    const target = matchObservationTarget({
      observation: observation(
        [
          { frameId: "root", domNodes: [] },
          { frameId: "child", domNodes: [node(42, "child")] },
        ],
        [{ ref: "e1", backendNodeId: 42, frameId: "child", line: 1 }],
      ),
      hint: { geometry: { rect: { x: 10, y: 20, w: 100, h: 30 }, tag: "button" } },
      fallback: { tag: "button", name: "发布" },
    });
    expect(target).toEqual({ name: "发布", unmatched: true });
  });

  it("returns unmatched for ambiguous geometry", () => {
    const target = matchObservationTarget({
      observation: observation(
        [{ frameId: "root", domNodes: [node(42, "root"), node(43, "root")] }],
        [
          { ref: "e1", backendNodeId: 42, line: 1 },
          { ref: "e2", backendNodeId: 43, line: 2 },
        ],
      ),
      hint: { geometry: { rect: { x: 10, y: 20, w: 100, h: 30 }, tag: "button" } },
    });
    expect(target.unmatched).toBe(true);
  });

  it("uses semantics when geometry is unavailable without crossing frame boundaries", () => {
    const target = matchObservationTarget({
      observation: observation(
        [
          { frameId: "root", domNodes: [node(41, "root")] },
          { frameId: "child", domNodes: [node(42, "child")] },
        ],
        [
          { ref: "e1", backendNodeId: 41, role: "button", name: "保存", line: 1 },
          { ref: "e2", backendNodeId: 42, frameId: "child", role: "button", name: "保存", line: 2 },
        ],
      ),
      hint: { frameId: "child" },
      fallback: { tag: "button", role: "button", name: "保存" },
    });
    expect(target.ref).toBe("e2");
  });

  it("uses semantics to disambiguate equal geometry in one frame", () => {
    const target = matchObservationTarget({
      observation: observation(
        [{ frameId: "root", domNodes: [node(42, "root"), node(43, "root")] }],
        [
          { ref: "e1", backendNodeId: 42, role: "button", name: "保存", line: 1 },
          { ref: "e2", backendNodeId: 43, role: "button", name: "取消", line: 2 },
        ],
      ),
      hint: { geometry: { rect: { x: 10, y: 20, w: 100, h: 30 }, tag: "button" } },
      fallback: { tag: "button", role: "button", name: "取消" },
    });
    expect(target.ref).toBe("e2");
  });
});
