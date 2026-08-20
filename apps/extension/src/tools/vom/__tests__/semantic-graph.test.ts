import { isVomReferenceNode, renderVom } from "@browser-skill/vom";
import { describe, expect, it } from "vitest";
import type { CapturedNode } from "../capture";
import type { FrameDocument } from "../frame-document";
import { buildSemanticVomScene, type SemanticAxNode } from "../semantic-graph";

function dom(
  backendNodeId: number,
  parentBackendNodeId: number | null,
  tag: string,
  attrs: Record<string, string> = {},
  textContent?: string,
): CapturedNode {
  return {
    backendNodeId,
    parentBackendNodeId,
    tag,
    attrs,
    rect: { x: 0, y: 0, w: 100, h: 30 },
    paintOrder: backendNodeId,
    position: "static",
    pointerEvents: "auto",
    ...(textContent ? { textContent } : {}),
  };
}

function document(
  frameId: string,
  axNodes: SemanticAxNode[],
  domNodes: CapturedNode[],
  frame?: Pick<FrameDocument<SemanticAxNode>, "parentFrameId" | "ownerBackendNodeId">,
): FrameDocument<SemanticAxNode> {
  return {
    frameId,
    contextScopeId: frameId,
    target: { tabId: 1 },
    axNodes,
    domNodes,
    ...frame,
  };
}

describe("semantic VOM graph", () => {
  it("preserves backend-less AX structure without making it referenceable", () => {
    const scene = buildSemanticVomScene({
      viewport: { width: 800, height: 600 },
      rootFrameId: "main",
      documents: [
        document(
          "main",
          [
            {
              nodeId: "root",
              backendDOMNodeId: 1,
              role: { type: "role", value: "RootWebArea" },
              childIds: ["toolbar"],
            },
            {
              nodeId: "toolbar",
              parentId: "root",
              role: { type: "role", value: "toolbar" },
              name: { type: "computedString", value: "Formatting" },
              childIds: ["bold", "italic"],
            },
            {
              nodeId: "bold",
              parentId: "toolbar",
              backendDOMNodeId: 2,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Bold" },
            },
            {
              nodeId: "italic",
              parentId: "toolbar",
              backendDOMNodeId: 3,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Italic" },
            },
          ],
          [dom(1, null, "body"), dom(2, 1, "button"), dom(3, 1, "button")],
        ),
      ],
    });

    const toolbar = scene.nodes.find((node) => node.role === "toolbar");
    const buttons = scene.nodes.filter((node) => node.role === "button");
    expect(toolbar).toEqual(expect.objectContaining({ name: "Formatting", referenceable: false }));
    expect(buttons.map((node) => node.parentId)).toEqual([toolbar?.id, toolbar?.id]);
    expect(toolbar && isVomReferenceNode(toolbar)).toBe(false);
    expect(renderVom(scene).refs.map((ref) => ref.backendNodeId)).toEqual([2, 3]);
  });

  it("resolves missing AX names through one DOM naming pipeline", () => {
    const scene = buildSemanticVomScene({
      viewport: { width: 800, height: 600 },
      rootFrameId: "main",
      documents: [
        document(
          "main",
          [
            {
              nodeId: "root",
              backendDOMNodeId: 1,
              role: { type: "role", value: "RootWebArea" },
              childIds: ["labelled", "titled", "text"],
            },
            {
              nodeId: "labelled",
              parentId: "root",
              backendDOMNodeId: 2,
              role: { type: "role", value: "button" },
            },
            {
              nodeId: "titled",
              parentId: "root",
              backendDOMNodeId: 3,
              role: { type: "role", value: "button" },
            },
            {
              nodeId: "text",
              parentId: "root",
              backendDOMNodeId: 4,
              role: { type: "role", value: "button" },
            },
          ],
          [
            dom(1, null, "body"),
            dom(2, 1, "button", { "aria-label": "Add row" }),
            dom(3, 1, "button", { title: "Settings" }),
            dom(4, 1, "button"),
            dom(5, 4, "span", {}, "Save"),
          ],
        ),
      ],
    });

    expect(scene.nodes.filter((node) => node.role === "button").map((node) => node.name)).toEqual([
      "Add row",
      "Settings",
      "Save",
    ]);
  });

  it("isolates equal backend node ids in sibling frames", () => {
    const scene = buildSemanticVomScene({
      viewport: { width: 1000, height: 800 },
      rootFrameId: "main",
      documents: [
        document(
          "main",
          [
            {
              nodeId: "root",
              backendDOMNodeId: 1,
              role: { type: "role", value: "RootWebArea" },
              childIds: ["owner-a", "owner-b"],
            },
            {
              nodeId: "owner-a",
              parentId: "root",
              backendDOMNodeId: 10,
              role: { type: "role", value: "Iframe" },
            },
            {
              nodeId: "owner-b",
              parentId: "root",
              backendDOMNodeId: 20,
              role: { type: "role", value: "Iframe" },
            },
          ],
          [dom(1, null, "body"), dom(10, 1, "iframe"), dom(20, 1, "iframe")],
        ),
        document(
          "frame-a",
          [
            {
              nodeId: "button-a",
              backendDOMNodeId: 5,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Accept" },
            },
          ],
          [dom(5, null, "button")],
          { parentFrameId: "main", ownerBackendNodeId: 10 },
        ),
        document(
          "frame-b",
          [
            {
              nodeId: "button-b",
              backendDOMNodeId: 5,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Decline" },
            },
          ],
          [dom(5, null, "button")],
          { parentFrameId: "main", ownerBackendNodeId: 20 },
        ),
      ],
    });

    const frameButtons = scene.nodes.filter((node) => node.backendNodeId === 5);
    const owners = new Map(
      scene.nodes
        .filter((node) => node.backendNodeId === 10 || node.backendNodeId === 20)
        .map((node) => [node.backendNodeId, node.id]),
    );
    expect(frameButtons.map((node) => node.frameId)).toEqual(["frame-a", "frame-b"]);
    expect(frameButtons.map((node) => node.parentId)).toEqual([owners.get(10), owners.get(20)]);
    expect(renderVom(scene).refs.map((ref) => [ref.frameId, ref.backendNodeId])).toEqual([
      ["frame-a", 5],
      ["frame-b", 5],
    ]);
  });
});
