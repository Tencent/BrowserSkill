import { isVomReferenceNode, prepareObservationRender, renderVom } from "@browser-skill/vom";
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
  it.each<Record<string, string>>([
    { hidden: "" },
    { inert: "" },
    { "aria-hidden": "true" },
  ])("does not recover clickable DOM fallbacks inside excluded subtrees: %j", (attrs) => {
    const scene = buildSemanticVomScene({
      viewport: { width: 800, height: 600 },
      rootFrameId: "main",
      documents: [
        document(
          "main",
          [],
          [
            { ...dom(3, 2, "div", {}, "Blocked action"), clickable: true },
            dom(2, 1, "div"),
            dom(1, null, "div", attrs),
            { ...dom(4, null, "div", {}, "Available action"), clickable: true },
          ],
        ),
      ],
    });
    expect(renderVom(scene).refs.map((ref) => ref.backendNodeId)).toEqual([4]);
  });

  it.each([
    { tag: "dialog", role: "dialog", axModal: true, expected: true },
    { tag: "dialog", role: "dialog", axModal: false, expected: false },
    { tag: "dialog", role: "dialog", expected: false },
    { tag: "div", role: "dialog", expected: false },
    { tag: "div", role: "alertdialog", expected: false },
    { tag: "div", role: "dialog", aria: "true", expected: false },
    { tag: "div", role: "dialog", aria: "false", expected: false },
    { tag: "div", role: "alertdialog", aria: "TRUE", axModal: true, expected: true },
    { tag: "div", role: "dialog", aria: "true", axModal: false, expected: false },
    { tag: "dialog", role: "dialog", aria: "false", axModal: true, expected: true },
    { tag: "dialog", role: "dialog", axModal: true, ignored: true, expected: false },
    { tag: "div", role: "dialog", aria: "true", ignored: true, expected: false },
    { tag: "div", role: "dialog", aria: "true", axModal: true, ignored: true, expected: false },
    { tag: "div", role: "dialog", aria: "true", missingAx: true, expected: true },
    { tag: "div", role: "alertdialog", aria: "TRUE", missingAx: true, expected: true },
    { tag: "dialog", role: "dialog", aria: "false", missingAx: true, expected: false },
    { tag: "dialog", role: "dialog", missingAx: true, expected: false },
  ])("uses AX modality when present, falling back to ARIA only without AX: %j", ({
    tag,
    role,
    axModal,
    aria,
    ignored,
    missingAx,
    expected,
  }) => {
    const scene = buildSemanticVomScene({
      viewport: { width: 800, height: 600 },
      rootFrameId: "main",
      documents: [
        document(
          "main",
          missingAx
            ? []
            : [
                {
                  nodeId: "dialog",
                  backendDOMNodeId: 2,
                  ignored,
                  role: { type: "role", value: role },
                  name: { type: "computedString", value: "Panel" },
                  ...(axModal !== undefined
                    ? { properties: [{ name: "modal", value: { value: axModal } }] }
                    : {}),
                },
              ],
          [dom(2, null, tag, { role, ...(aria ? { "aria-modal": aria } : {}) })],
        ),
      ],
    });
    expect(scene.nodes.find((node) => node.backendNodeId === 2)?.modal).toBe(expected);
  });

  it.each<{ ax: boolean; ignored: boolean; attrs: Record<string, string>; disabled: boolean }>([
    { ax: true, ignored: false, attrs: {}, disabled: true },
    { ax: false, ignored: false, attrs: {}, disabled: false },
    { ax: true, ignored: true, attrs: {}, disabled: false },
    { ax: false, ignored: true, attrs: { disabled: "" }, disabled: true },
    { ax: false, ignored: false, attrs: { "aria-disabled": "true" }, disabled: true },
  ])("observes inherited AX disabled state while retaining DOM fallbacks: %j", ({
    ax,
    ignored,
    attrs,
    disabled,
  }) => {
    const scene = buildSemanticVomScene({
      viewport: { width: 800, height: 600 },
      rootFrameId: "main",
      documents: [
        document(
          "main",
          [
            {
              nodeId: "button",
              backendDOMNodeId: 2,
              ignored,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Submit" },
              properties: [{ name: "disabled", value: { value: ax } }],
            },
          ],
          [dom(2, null, "button", attrs, "Submit")],
        ),
      ],
    });
    expect(scene.nodes.find((node) => node.backendNodeId === 2)?.disabled).toBe(disabled);
    expect(renderVom(scene).text.includes("[disabled]")).toBe(disabled);
  });

  it.each([
    { ax: "true", live: false, ignored: false, aria: "false", expected: true },
    { ax: "false", live: true, ignored: false, aria: "true", expected: false },
    { ax: "mixed", live: true, ignored: false, aria: "true", expected: "mixed" },
    { ax: "true", live: false, ignored: true, aria: "true", expected: false },
    { ax: undefined, live: false, ignored: false, aria: "true", expected: false },
    { ax: undefined, live: undefined, ignored: false, aria: "mixed", expected: "mixed" },
    { ax: undefined, live: undefined, ignored: false, aria: undefined, expected: undefined },
  ])("resolves checked state without confusing value/default attributes: %j", ({
    ax,
    live,
    ignored,
    aria,
    expected,
  }) => {
    const control = {
      ...dom(2, 1, live === undefined ? "div" : "input", {
        role: "checkbox",
        type: "checkbox",
        checked: "",
        "aria-label": "Subscribe",
        ...(aria !== undefined ? { "aria-checked": aria } : {}),
      }),
      formValue: "on",
      ...(live !== undefined ? { checked: live } : {}),
    };
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
              childIds: ["check"],
            },
            {
              nodeId: "check",
              parentId: "root",
              backendDOMNodeId: 2,
              ignored,
              role: { type: "role", value: "checkbox" },
              name: { type: "computedString", value: "Subscribe" },
              ...(ax !== undefined
                ? { properties: [{ name: "checked", value: { value: ax } }] }
                : {}),
            },
          ],
          [dom(1, null, "body"), control],
        ),
      ],
    });
    const resolved = scene.nodes.find((n) => n.backendNodeId === 2)!;
    expect(resolved.checked).toBe(expected);
    expect(resolved.value).toBe("on");
  });

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

  it("aggregates AX text at the semantic text frontier", () => {
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
              childIds: ["covered", "inline-only", "repeated", "labelled"],
            },
            {
              nodeId: "covered",
              parentId: "root",
              backendDOMNodeId: 2,
              role: { type: "role", value: "paragraph" },
              childIds: ["covered-static"],
            },
            {
              nodeId: "covered-static",
              parentId: "covered",
              role: { type: "role", value: "StaticText" },
              name: { type: "computedString", value: "Covered text" },
              childIds: ["covered-inline"],
            },
            {
              nodeId: "covered-inline",
              parentId: "covered-static",
              role: { type: "role", value: "InlineTextBox" },
              name: { type: "computedString", value: "Covered text" },
            },
            {
              nodeId: "inline-only",
              parentId: "root",
              backendDOMNodeId: 3,
              role: { type: "role", value: "paragraph" },
              childIds: ["inline-leaf"],
            },
            {
              nodeId: "inline-leaf",
              parentId: "inline-only",
              role: { type: "role", value: "InlineTextBox" },
              name: { type: "computedString", value: "Inline fallback" },
            },
            {
              nodeId: "repeated",
              parentId: "root",
              backendDOMNodeId: 4,
              role: { type: "role", value: "paragraph" },
              childIds: ["first-go", "second-go"],
            },
            {
              nodeId: "first-go",
              parentId: "repeated",
              role: { type: "role", value: "StaticText" },
              name: { type: "computedString", value: "Go" },
            },
            {
              nodeId: "second-go",
              parentId: "repeated",
              role: { type: "role", value: "StaticText" },
              name: { type: "computedString", value: "Go" },
            },
            {
              nodeId: "labelled",
              parentId: "root",
              backendDOMNodeId: 5,
              role: { type: "role", value: "button" },
              childIds: ["visible-label"],
            },
            {
              nodeId: "visible-label",
              parentId: "labelled",
              role: { type: "role", value: "StaticText" },
              name: { type: "computedString", value: "Visible text" },
            },
          ],
          [
            dom(1, null, "body"),
            dom(2, 1, "p"),
            dom(3, 1, "p"),
            dom(4, 1, "p"),
            dom(5, 1, "button", { "aria-label": "Explicit action" }),
          ],
        ),
      ],
    });

    expect(scene.nodes.find((node) => node.backendNodeId === 2)?.name).toBe("Covered text");
    expect(scene.nodes.find((node) => node.backendNodeId === 3)?.name).toBe("Inline fallback");
    expect(scene.nodes.find((node) => node.backendNodeId === 4)?.name).toBe("Go Go");
    expect(scene.nodes.find((node) => node.backendNodeId === 5)?.name).toBe("Explicit action");
    expect(renderVom(scene).text).not.toContain("Covered text Covered text");
  });

  it("uses stable identifiers only as a final name fallback", () => {
    const base = document(
      "main",
      [
        {
          nodeId: "root",
          backendDOMNodeId: 1,
          role: { type: "role", value: "RootWebArea" },
          childIds: ["fallback", "labelled", "container"],
        },
        {
          nodeId: "fallback",
          parentId: "root",
          backendDOMNodeId: 2,
          role: { type: "role", value: "button" },
        },
        {
          nodeId: "labelled",
          parentId: "root",
          backendDOMNodeId: 3,
          role: { type: "role", value: "button" },
          name: { type: "computedString", value: "Localized name" },
        },
        {
          nodeId: "container",
          parentId: "root",
          backendDOMNodeId: 4,
          role: { type: "role", value: "generic" },
        },
      ],
      [
        dom(1, null, "body"),
        dom(2, 1, "button", { "data-test-id": "toolInsertRecord" }),
        dom(3, 1, "button", { id: "toolIgnoredFallback" }),
        dom(4, 1, "div", { id: "toolbarContainer" }),
      ],
    );
    const staticScene = buildSemanticVomScene({
      viewport: { width: 800, height: 600 },
      rootFrameId: "main",
      documents: [base],
    });
    const enrichedScene = buildSemanticVomScene({
      viewport: { width: 800, height: 600 },
      rootFrameId: "main",
      documents: [base],
      supplementalNames: new Map([["main\u00002", "插入行"]]),
    });

    expect(staticScene.nodes.find((node) => node.backendNodeId === 2)?.name).toBe("Insert record");
    expect(staticScene.nodes.find((node) => node.backendNodeId === 3)?.name).toBe("Localized name");
    expect(staticScene.nodes.find((node) => node.backendNodeId === 4)?.name).toBeUndefined();
    expect(enrichedScene.nodes.find((node) => node.backendNodeId === 2)?.name).toBe("插入行");
    expect(enrichedScene.nodes.find((node) => node.backendNodeId === 3)?.name).toBe(
      "Localized name",
    );
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
              childIds: ["text-a"],
            },
            {
              nodeId: "text-a",
              parentId: "button-a",
              role: { type: "role", value: "StaticText" },
              name: { type: "computedString", value: "Accept" },
              childIds: ["inline-a"],
            },
            {
              nodeId: "inline-a",
              parentId: "text-a",
              role: { type: "role", value: "InlineTextBox" },
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
              childIds: ["text-b"],
            },
            {
              nodeId: "text-b",
              parentId: "button-b",
              role: { type: "role", value: "StaticText" },
              name: { type: "computedString", value: "Decline" },
              childIds: ["inline-b"],
            },
            {
              nodeId: "inline-b",
              parentId: "text-b",
              role: { type: "role", value: "InlineTextBox" },
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
    expect(frameButtons.map((node) => node.name)).toEqual(["Accept", "Decline"]);
    expect(frameButtons.map((node) => node.parentId)).toEqual([owners.get(10), owners.get(20)]);
    expect(renderVom(scene).refs.map((ref) => [ref.frameId, ref.backendNodeId])).toEqual([
      ["frame-a", 5],
      ["frame-b", 5],
    ]);
  });

  it("requires render evidence before promoting DOM fallback semantics", () => {
    const hiddenOwner = {
      ...dom(10, 1, "iframe", { hidden: "" }),
      rect: null,
      localRect: null,
      rendered: false,
    };
    const hiddenButton = {
      ...dom(2, 1, "button", { "aria-label": "Hidden action" }),
      rendered: false,
    };
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
            },
          ],
          [dom(1, null, "body"), hiddenButton, hiddenOwner],
        ),
        document("hidden-frame", [], [dom(20, null, "button", {}, "Frame action")], {
          parentFrameId: "main",
          ownerBackendNodeId: 10,
        }),
      ],
    });

    expect(scene.nodes.some((node) => node.backendNodeId === 2)).toBe(false);
    expect(scene.nodes.some((node) => node.backendNodeId === 10)).toBe(false);
    expect(scene.nodes.some((node) => node.frameId === "hidden-frame")).toBe(false);
    expect(renderVom(scene).refs).toEqual([]);
  });

  it("retains rendered DOM fallback controls when AX semantics are unavailable", () => {
    const scene = buildSemanticVomScene({
      viewport: { width: 800, height: 600 },
      rootFrameId: "main",
      documents: [
        document(
          "main",
          [],
          [dom(1, null, "body"), { ...dom(2, 1, "button", {}, "Save"), rendered: true }],
        ),
      ],
    });

    expect(renderVom(scene).refs).toEqual([
      expect.objectContaining({ backendNodeId: 2, role: "button", name: "Save" }),
    ]);
  });

  it("lets explicit DOM structure override ignored AX metadata", () => {
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
              backendDOMNodeId: 2,
              ignored: true,
              role: { type: "role", value: "generic" },
              childIds: ["wrapper"],
            },
            {
              nodeId: "wrapper",
              parentId: "toolbar",
              backendDOMNodeId: 5,
              role: { type: "role", value: "generic" },
              childIds: ["bold", "italic"],
            },
            {
              nodeId: "bold",
              parentId: "wrapper",
              backendDOMNodeId: 3,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Bold" },
            },
            {
              nodeId: "italic",
              parentId: "wrapper",
              backendDOMNodeId: 4,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Italic" },
            },
          ],
          [
            dom(1, null, "body"),
            dom(2, 1, "div", { role: "toolbar" }),
            dom(5, 2, "div"),
            dom(3, 5, "button"),
            dom(4, 5, "button"),
          ],
        ),
      ],
    });

    const toolbar = scene.nodes.find((node) => node.backendNodeId === 2);
    const buttons = scene.nodes.filter((node) => [3, 4].includes(node.backendNodeId ?? -1));
    expect(toolbar).toEqual(expect.objectContaining({ role: "toolbar" }));
    expect(toolbar && isVomReferenceNode(toolbar)).toBe(false);
    expect(scene.nodes.some((node) => node.role === "group")).toBe(false);
    expect(buttons.map((node) => node.parentId)).toEqual([toolbar?.id, toolbar?.id]);
  });

  it("infers an unnamed group only from independent interaction branches", () => {
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
              childIds: ["wrapper"],
            },
            {
              nodeId: "wrapper",
              parentId: "root",
              backendDOMNodeId: 2,
              role: { type: "role", value: "generic" },
              childIds: ["first", "second"],
            },
            {
              nodeId: "first",
              parentId: "wrapper",
              backendDOMNodeId: 3,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "First" },
            },
            {
              nodeId: "second",
              parentId: "wrapper",
              backendDOMNodeId: 4,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Second" },
            },
          ],
          [dom(1, null, "body"), dom(2, 1, "div"), dom(3, 2, "button"), dom(4, 2, "button")],
        ),
      ],
    });

    const group = scene.nodes.find((node) => node.backendNodeId === 2);
    const buttons = scene.nodes.filter((node) => [3, 4].includes(node.backendNodeId ?? -1));
    expect(group).toEqual(expect.objectContaining({ role: "group" }));
    expect(group?.name).toBeUndefined();
    expect(group && isVomReferenceNode(group)).toBe(false);
    expect(buttons.map((node) => node.parentId)).toEqual([group?.id, group?.id]);

    const rendered = renderVom(scene);
    const lines = rendered.text.split("\n");
    const groupLine = lines.findIndex((line) => line.trim() === "group");
    expect(groupLine).toBeGreaterThanOrEqual(0);
    for (const ref of rendered.refs) {
      expect(ref.line).toBeGreaterThan(groupLine);
      expect(lines[ref.line]).toMatch(/^\s+@e\d+ button/);
    }
  });

  it("never promotes a form value into its semantic name through supplemental evidence", () => {
    const secret = "user@example.com";
    const input = {
      ...dom(2, 1, "input", { type: "email" }),
      formValue: secret,
      formDefaultValue: "",
      formState: "filled" as const,
    };
    const scene = buildSemanticVomScene({
      viewport: { width: 800, height: 600 },
      rootFrameId: "main",
      supplementalNames: new Map([["main\u00002", secret]]),
      identifierFallback: false,
      documents: [
        document(
          "main",
          [
            {
              nodeId: "root",
              backendDOMNodeId: 1,
              role: { type: "role", value: "RootWebArea" },
              childIds: ["email"],
            },
            {
              nodeId: "email",
              parentId: "root",
              backendDOMNodeId: 2,
              role: { type: "role", value: "textbox" },
              value: { value: secret },
            },
          ],
          [dom(1, null, "body"), input],
        ),
      ],
    });

    const field = scene.nodes.find((node) => node.backendNodeId === 2);
    expect(field?.name).toBeUndefined();
    const rendered = renderVom(scene, { redactValues: true });
    expect(rendered.text).toContain("•••");
    expect(JSON.stringify(rendered)).not.toContain(secret);
  });

  it("keeps uncertain single-branch wrappers flat", () => {
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
              childIds: ["wrapper"],
            },
            {
              nodeId: "wrapper",
              parentId: "root",
              backendDOMNodeId: 2,
              role: { type: "role", value: "generic" },
              childIds: ["button"],
            },
            {
              nodeId: "button",
              parentId: "wrapper",
              backendDOMNodeId: 3,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Only action" },
            },
          ],
          [dom(1, null, "body"), dom(2, 1, "div"), dom(3, 2, "button")],
        ),
      ],
    });

    expect(scene.nodes.some((node) => node.role === "group")).toBe(false);
    expect(scene.nodes.find((node) => node.backendNodeId === 3)?.parentId).toBe(
      scene.nodes.find((node) => node.backendNodeId === 1)?.id,
    );
  });

  it("does not infer across mixed content boundaries", () => {
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
              childIds: ["wrapper"],
            },
            {
              nodeId: "wrapper",
              parentId: "root",
              backendDOMNodeId: 2,
              role: { type: "role", value: "generic" },
              childIds: ["first", "second", "paragraph"],
            },
            {
              nodeId: "first",
              parentId: "wrapper",
              backendDOMNodeId: 3,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "First" },
            },
            {
              nodeId: "second",
              parentId: "wrapper",
              backendDOMNodeId: 4,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Second" },
            },
            {
              nodeId: "paragraph",
              parentId: "wrapper",
              backendDOMNodeId: 5,
              role: { type: "role", value: "paragraph" },
            },
          ],
          [
            dom(1, null, "body"),
            dom(2, 1, "div"),
            dom(3, 2, "button"),
            dom(4, 2, "button"),
            dom(5, 2, "p", {}, "Description"),
          ],
        ),
      ],
    });

    expect(scene.nodes.some((node) => node.role === "group")).toBe(false);
  });

  it("keeps only the innermost reliable inferred group", () => {
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
              childIds: ["outer"],
            },
            {
              nodeId: "outer",
              parentId: "root",
              backendDOMNodeId: 2,
              role: { type: "role", value: "generic" },
              childIds: ["inner", "third"],
            },
            {
              nodeId: "inner",
              parentId: "outer",
              backendDOMNodeId: 3,
              role: { type: "role", value: "generic" },
              childIds: ["first", "second"],
            },
            {
              nodeId: "first",
              parentId: "inner",
              backendDOMNodeId: 4,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "First" },
            },
            {
              nodeId: "second",
              parentId: "inner",
              backendDOMNodeId: 5,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Second" },
            },
            {
              nodeId: "third",
              parentId: "outer",
              backendDOMNodeId: 6,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Third" },
            },
          ],
          [
            dom(1, null, "body"),
            dom(2, 1, "div"),
            dom(3, 2, "div"),
            dom(4, 3, "button"),
            dom(5, 3, "button"),
            dom(6, 2, "button"),
          ],
        ),
      ],
    });

    const groups = scene.nodes.filter((node) => node.role === "group");
    expect(groups.map((node) => node.backendNodeId)).toEqual([3]);
    expect(scene.nodes.find((node) => node.backendNodeId === 6)?.parentId).not.toBe(groups[0]?.id);
  });
});

it("retains browser focus on semantic nodes without trusting a DOM focused attribute", () => {
  const scene = buildSemanticVomScene({
    viewport: { width: 800, height: 600 },
    rootFrameId: "main",
    documents: [
      document(
        "main",
        [
          {
            nodeId: "buy",
            backendDOMNodeId: 2,
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: "Buy" },
            properties: [{ name: "focused", value: { value: true } }],
          },
          {
            nodeId: "pause",
            backendDOMNodeId: 3,
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: "Pause" },
            properties: [{ name: "focused", value: { value: false } }],
          },
        ],
        [dom(2, null, "button"), dom(3, null, "button", { focused: "true" })],
      ),
    ],
  });
  expect(scene.nodes.find((node) => node.backendNodeId === 2)?.focused).toBe(true);
  expect(scene.nodes.find((node) => node.backendNodeId === 3)?.focused).toBeUndefined();
});

it.each([
  "none",
  "presentation",
])("retains native form membership when the %s form is omitted", (role) => {
  const scene = buildSemanticVomScene({
    viewport: { width: 800, height: 600 },
    rootFrameId: "main",
    documents: [
      document(
        "main",
        [],
        [
          dom(1, null, "main"),
          dom(2, 1, "form", { role }),
          {
            ...dom(3, 2, "input", { type: "range", "aria-label": "Playback progress" }),
            formValue: "0",
            inForm: true,
          },
        ],
      ),
    ],
  });
  expect(scene.nodes.some((n) => n.tag === "form")).toBe(false);
  expect(scene.nodes.find((n) => n.backendNodeId === 3)?.inForm).toBe(true);
});

it.each([true, false])("retains AX selected=%s over styling hints", (selected) => {
  const scene = buildSemanticVomScene({
    viewport: { width: 800, height: 600 },
    rootFrameId: "main",
    documents: [
      document(
        "main",
        [
          {
            nodeId: "1",
            backendDOMNodeId: 1,
            role: { type: "role", value: "option" },
            name: { type: "computedString", value: "Choice" },
            properties: [{ name: "selected", value: { value: selected } }],
          },
        ],
        [dom(1, null, "div", { class: "selected" })],
      ),
    ],
  });
  expect(renderVom(scene).text).toContain(selected ? "[selected]" : "[unselected]");
});

it("exposes individual row refs for delegated list and homogeneous div containers across semantic structure and render passes (#695)", () => {
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
            childIds: ["main"],
          },
          {
            nodeId: "main",
            parentId: "root",
            backendDOMNodeId: 2,
            role: { type: "role", value: "main" },
            childIds: ["divA", "ulB", "ulC", "cardD", "wrapE"],
          },
          {
            nodeId: "divA",
            parentId: "main",
            backendDOMNodeId: 10,
            role: { type: "role", value: "generic" },
            childIds: ["a1", "a2", "a3"],
          },
          {
            nodeId: "a1",
            parentId: "divA",
            backendDOMNodeId: 11,
            role: { type: "role", value: "generic" },
            childIds: ["a1t"],
          },
          {
            nodeId: "a1t",
            parentId: "a1",
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: "甲一" },
          },
          {
            nodeId: "a2",
            parentId: "divA",
            backendDOMNodeId: 12,
            role: { type: "role", value: "generic" },
            childIds: ["a2t"],
          },
          {
            nodeId: "a2t",
            parentId: "a2",
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: "甲二" },
          },
          {
            nodeId: "a3",
            parentId: "divA",
            backendDOMNodeId: 13,
            role: { type: "role", value: "generic" },
            childIds: ["a3t"],
          },
          {
            nodeId: "a3t",
            parentId: "a3",
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: "甲三" },
          },
          {
            nodeId: "ulB",
            parentId: "main",
            backendDOMNodeId: 20,
            role: { type: "role", value: "list" },
            childIds: ["b1", "bDiv", "b2", "b3"],
          },
          {
            nodeId: "b1",
            parentId: "ulB",
            backendDOMNodeId: 21,
            role: { type: "role", value: "listitem" },
            childIds: ["b1t"],
          },
          {
            nodeId: "b1t",
            parentId: "b1",
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: "乙一" },
          },
          {
            nodeId: "bDiv",
            parentId: "ulB",
            backendDOMNodeId: 24,
            role: { type: "role", value: "listitem" },
          },
          {
            nodeId: "b2",
            parentId: "ulB",
            backendDOMNodeId: 22,
            role: { type: "role", value: "listitem" },
            childIds: ["b2t"],
          },
          {
            nodeId: "b2t",
            parentId: "b2",
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: "乙二" },
          },
          {
            nodeId: "b3",
            parentId: "ulB",
            backendDOMNodeId: 23,
            role: { type: "role", value: "listitem" },
            childIds: ["b3t"],
          },
          {
            nodeId: "b3t",
            parentId: "b3",
            role: { type: "role", value: "StaticText" },
            name: { type: "computedString", value: "乙三" },
          },
          {
            nodeId: "ulC",
            parentId: "main",
            backendDOMNodeId: 30,
            role: { type: "role", value: "list" },
            childIds: ["c1", "c2", "c3"],
          },
          {
            nodeId: "c1",
            parentId: "ulC",
            backendDOMNodeId: 31,
            role: { type: "role", value: "listitem" },
            name: { type: "computedString", value: "丙一" },
          },
          {
            nodeId: "c2",
            parentId: "ulC",
            backendDOMNodeId: 32,
            role: { type: "role", value: "listitem" },
            name: { type: "computedString", value: "丙二" },
          },
          {
            nodeId: "c3",
            parentId: "ulC",
            backendDOMNodeId: 33,
            role: { type: "role", value: "listitem" },
            name: { type: "computedString", value: "丙三" },
          },
          {
            nodeId: "cardD",
            parentId: "main",
            backendDOMNodeId: 40,
            role: { type: "role", value: "generic" },
            childIds: ["d1", "d2"],
          },
          {
            nodeId: "d1",
            parentId: "cardD",
            backendDOMNodeId: 41,
            role: { type: "role", value: "generic" },
            name: { type: "computedString", value: "标题" },
          },
          {
            nodeId: "d2",
            parentId: "cardD",
            backendDOMNodeId: 42,
            role: { type: "role", value: "generic" },
            name: { type: "computedString", value: "副标题" },
          },
          {
            nodeId: "wrapE",
            parentId: "main",
            backendDOMNodeId: 50,
            role: { type: "role", value: "generic" },
            childIds: ["ulE"],
          },
          {
            nodeId: "ulE",
            parentId: "wrapE",
            backendDOMNodeId: 51,
            role: { type: "role", value: "list" },
            childIds: ["e1", "e2", "eFooter"],
          },
          {
            nodeId: "e1",
            parentId: "ulE",
            backendDOMNodeId: 52,
            role: { type: "role", value: "listitem" },
            name: { type: "computedString", value: "历史一" },
          },
          {
            nodeId: "e2",
            parentId: "ulE",
            backendDOMNodeId: 53,
            role: { type: "role", value: "listitem" },
            name: { type: "computedString", value: "历史二" },
          },
          {
            nodeId: "eFooter",
            parentId: "ulE",
            backendDOMNodeId: 54,
            role: { type: "role", value: "listitem" },
            childIds: ["eClear"],
          },
          {
            nodeId: "eClear",
            parentId: "eFooter",
            backendDOMNodeId: 55,
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: "清空历史" },
          },
        ],
        [
          dom(1, null, "body"),
          dom(2, 1, "main"),
          {
            ...dom(10, 2, "div", { id: "a" }),
            clickable: true,
            rect: { x: 0, y: 0, w: 240, h: 108 },
          },
          { ...dom(11, 10, "div", {}, "甲一"), rect: { x: 0, y: 0, w: 240, h: 36 } },
          { ...dom(12, 10, "div", {}, "甲二"), rect: { x: 0, y: 36, w: 240, h: 36 } },
          { ...dom(13, 10, "div", {}, "甲三"), rect: { x: 0, y: 72, w: 240, h: 36 } },
          {
            ...dom(20, 2, "ul", { id: "b" }),
            clickable: true,
            rect: { x: 0, y: 120, w: 240, h: 112 },
          },
          { ...dom(21, 20, "li", {}, "乙一"), rect: { x: 0, y: 120, w: 240, h: 36 } },
          { ...dom(24, 20, "li", { class: "divider" }), rect: { x: 0, y: 156, w: 240, h: 4 } },
          { ...dom(22, 20, "li", {}, "乙二"), rect: { x: 0, y: 160, w: 240, h: 36 } },
          { ...dom(23, 20, "li", {}, "乙三"), rect: { x: 0, y: 196, w: 240, h: 36 } },
          dom(30, 2, "ul", { id: "c" }),
          dom(31, 30, "li", {}, "丙一"),
          dom(32, 30, "li", {}, "丙二"),
          dom(33, 30, "li", {}, "丙三"),
          {
            ...dom(40, 2, "div", { id: "d" }),
            clickable: true,
            rect: { x: 0, y: 260, w: 240, h: 72 },
          },
          { ...dom(41, 40, "div", {}, "标题"), rect: { x: 0, y: 260, w: 240, h: 36 } },
          { ...dom(42, 40, "div", {}, "副标题"), rect: { x: 0, y: 296, w: 240, h: 36 } },
          {
            ...dom(50, 2, "div", { id: "e" }),
            clickable: true,
            rect: { x: 0, y: 340, w: 240, h: 120 },
          },
          { ...dom(51, 50, "ul"), rect: { x: 0, y: 340, w: 240, h: 120 } },
          { ...dom(52, 51, "li", {}, "历史一"), rect: { x: 0, y: 340, w: 240, h: 36 } },
          { ...dom(53, 51, "li", {}, "历史二"), rect: { x: 0, y: 376, w: 240, h: 36 } },
          { ...dom(54, 51, "li"), rect: { x: 0, y: 412, w: 240, h: 36 } },
          { ...dom(55, 54, "button", {}, "清空历史"), rect: { x: 0, y: 412, w: 120, h: 32 } },
        ],
      ),
    ],
  });

  const rendered = renderVom(scene);
  expect(
    rendered.refs.map((ref) => ({ backendNodeId: ref.backendNodeId, name: ref.name })),
  ).toEqual([
    { backendNodeId: 11, name: "甲一" },
    { backendNodeId: 12, name: "甲二" },
    { backendNodeId: 13, name: "甲三" },
    { backendNodeId: 21, name: "乙一" },
    { backendNodeId: 22, name: "乙二" },
    { backendNodeId: 23, name: "乙三" },
    { backendNodeId: 40, name: "标题 副标题" },
    { backendNodeId: 52, name: "历史一" },
    { backendNodeId: 53, name: "历史二" },
    { backendNodeId: 55, name: "清空历史" },
  ]);
  expect(rendered.text).not.toContain('button "甲一 甲二 甲三"');
  expect(rendered.text).not.toContain('button "乙一 乙二 乙三"');

  const prepared = prepareObservationRender(scene);
  const preparedBackendIds = Array.from({ [Symbol.iterator]: () => prepared.rows })
    .filter((row) => row.ref)
    .map((row) => row.ref!.backendNodeId);
  expect(preparedBackendIds).toEqual([11, 12, 13, 21, 22, 23, 40, 52, 53, 55]);
});
