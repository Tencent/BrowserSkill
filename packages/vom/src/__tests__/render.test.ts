import { describe, expect, it } from "vitest";
import { applyVomInteractionRecovery, prepareObservationRender, renderVom } from "../render";
import type { VomNode, VomScene } from "../types";

function node(p: Partial<VomNode> & { id: number }): VomNode {
  const { id, parentId, tag, rect, paintOrder, position, pointerEvents, ...rest } = p;

  return {
    id,
    parentId: parentId ?? null,
    tag: tag ?? "div",
    rect: rect ?? null,
    paintOrder: paintOrder ?? 0,
    position: position ?? "static",
    pointerEvents: pointerEvents ?? "auto",
    ...rest,
  };
}

function scene(nodes: VomNode[]): VomScene {
  return {
    viewport: { width: 1280, height: 720 },
    nodes,
  };
}

function coreRefs(refs: ReturnType<typeof renderVom>["refs"]) {
  return refs.map(({ ref, backendNodeId }) => ({ ref, backendNodeId }));
}

it("allocates displayed references before rendering without rewriting literal page text", () => {
  const input = scene([
    node({
      id: 1,
      backendNodeId: 19,
      tag: "button",
      role: "button",
      name: "Keep @e1 in this label",
    }),
    node({ id: 2, backendNodeId: 20, tag: "button", role: "button", name: "Save" }),
  ]);
  const options = { allocateRef: (n: VomNode) => `e${100 + n.backendNodeId!}` };
  const full = renderVom(input, options);
  expect(full.text).toContain('@e119 button "Keep @e1 in this label"');
  expect(full.refs.map((ref) => ref.ref)).toEqual(["e119", "e120"]);
  const prepared = prepareObservationRender(input, options);
  const rows = Array.from({ [Symbol.iterator]: () => prepared.rows });
  expect(rows.filter((row) => row.ref).map((row) => row.ref!.ref)).toEqual(["e119", "e120"]);
  expect(rows.map((row) => row.text).join("\n")).toContain('"Keep @e1 in this label"');
});

it("measures allocated reference names within the token budget", () => {
  const input = scene(
    Array.from({ length: 12 }, (_, i) =>
      node({ id: i + 1, tag: "button", role: "button", name: `Save ${i}` }),
    ),
  );
  const full = renderVom(input, { allocateRef: (n) => `e${100000000 + n.id}` });
  const bounded = renderVom(input, {
    allocateRef: (n) => `e${100000000 + n.id}`,
    maxTokens: 65,
  });
  expect(bounded.truncated).toBe(true);
  expect(bounded.refs.length).toBeGreaterThan(0);
  expect(bounded.refs.length).toBeLessThan(full.refs.length);
  expect(full.text.startsWith(bounded.text)).toBe(true);
});

describe("renderVom single-layer page", () => {
  it.each([
    ["date", "Date"],
    ["DATE", "Date"],
    ["time", "InputTime"],
    ["datetime-local", "DateTime"],
    ["month", "DateTime"],
    ["week", "DateTime"],
  ] as const)("exposes an unnamed %s input as a reference", (type, role) => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          backendNodeId: 42,
          tag: "input",
          role,
          attrs: { type },
          rect: { x: 0, y: 0, w: 200, h: 40 },
        }),
      ]),
    );
    expect(out.text).toContain(`@e1 ${role}`);
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 42 }]);
  });

  it("does not promote passive or unaddressable date-like nodes to references", () => {
    const out = renderVom(
      scene([
        node({ id: 1, tag: "div", role: "Date", name: "Today", attrs: { type: "date" } }),
        node({ id: 2, tag: "input", role: "presentation", attrs: { type: "date" } }),
        node({ id: 3, tag: "input", role: "Date", attrs: { type: "date" }, referenceable: false }),
      ]),
    );
    expect(out.refs).toEqual([]);
  });

  it.each([
    "",
    "true",
    "plaintext-only",
  ])("exposes a contenteditable=%s root as a textbox ref", (contenteditable) => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          backendNodeId: 42,
          tag: "div",
          name: "Message editor",
          attrs: { contenteditable },
          rect: { x: 0, y: 0, w: 200, h: 80 },
        }),
      ]),
    );
    expect(out.text).toContain('@e1 textbox "Message editor"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 42 }]);
  });
  it.each([
    { checked: true, marker: " [checked]" },
    { checked: false, marker: " [unchecked]" },
    { checked: "mixed" as const, marker: " [mixed]" },
    { checked: undefined, marker: "" },
  ])("renders checkbox state separately from its value: %j", ({ checked, marker }) => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          backendNodeId: 1,
          tag: "input",
          role: "checkbox",
          name: "Subscribe",
          checked,
          value: "on",
          rect: { x: 0, y: 0, w: 20, h: 20 },
        }),
      ]),
    );
    expect(out.text).toContain('@e1 checkbox "Subscribe"' + marker + ' ="on"');
    expect(out.refs).toHaveLength(1);
  });
  it.each([100, 600, 2000])("bounds sibling-context reads for %i repeated actions", (count) => {
    let nameReads = 0;
    const nodes = [node({ id: 1, role: "RootWebArea" })];
    for (let i = 0; i < count; i++) {
      const label = node({ id: 2 + i * 2, parentId: 1, role: "StaticText" });
      Object.defineProperty(label, "name", {
        enumerable: true,
        get() {
          nameReads++;
          return `Record ${i}`;
        },
      });
      nodes.push(
        label,
        node({ id: 3 + i * 2, parentId: 1, tag: "button", role: "button", name: "Open" }),
      );
    }
    const out = renderVom(scene(nodes));
    expect(out.refs).toHaveLength(count);
    expect(out.refs.map((ref) => ref.ctx)).toEqual(
      Array.from({ length: count }, (_, index) => `Record ${Math.max(0, index - 2)}`),
    );
    // Count semantic reads rather than asserting a machine-dependent duration.
    expect(nameReads).toBeLessThan(count * 10);
  });

  it("does not derive handle context across frame scopes", () => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          role: "RootWebArea",
          frameId: "main",
          contextScopeId: "main",
        }),
        node({
          id: 2,
          parentId: 1,
          role: "StaticText",
          name: "创建于",
          frameId: "main",
          contextScopeId: "main",
        }),
        node({
          id: 3,
          parentId: 1,
          role: "Iframe",
          frameId: "main",
          contextScopeId: "main",
        }),
        node({
          id: 4,
          parentId: 3,
          role: "button",
          name: "表格视图",
          frameId: "child",
          contextScopeId: "child",
        }),
        node({
          id: 5,
          parentId: 1,
          role: "button",
          name: "表格视图",
          frameId: "main",
          contextScopeId: "main",
        }),
      ]),
    );

    expect(out.text).toContain('@e1 button "表格视图"');
    expect(out.text).not.toContain('@e1 button "表格视图" [ctx: 创建于]');
  });

  it("preserves handle context within a frame scope", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", contextScopeId: "main" }),
        node({ id: 2, parentId: 1, role: "Iframe", contextScopeId: "main" }),
        node({
          id: 3,
          parentId: 2,
          role: "StaticText",
          name: "工具栏",
          contextScopeId: "child",
        }),
        node({
          id: 4,
          parentId: 2,
          role: "button",
          name: "更多",
          contextScopeId: "child",
        }),
        node({
          id: 5,
          parentId: 1,
          role: "button",
          name: "更多",
          contextScopeId: "main",
        }),
      ]),
    );

    expect(out.text).toContain('@e1 button "更多" [ctx: 工具栏]');
  });

  it("always emits a complete @vom single-layer document when there is no blocker", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Shop" }),
        node({ id: 2, parentId: 1, role: "navigation", name: "主菜单" }),
        node({ id: 3, parentId: 2, role: "link", name: "首页", tag: "a" }),
        node({ id: 4, parentId: 1, role: "main" }),
        node({ id: 5, parentId: 4, role: "heading", name: "今日推荐" }),
        node({ id: 6, parentId: 4, role: "button", name: "加入购物车", tag: "button" }),
      ]),
    );

    expect(out.text).toBe(
      [
        "@vom 1",
        "@view 1280x720",
        "@layers 1 focus=L1",
        "L1 page",
        '  RootWebArea "Shop"',
        '    navigation "主菜单"',
        '      @e1 link "首页"',
        "    main",
        '      heading "今日推荐"',
        '      @e2 button "加入购物车"',
      ].join("\n"),
    );
    expect(coreRefs(out.refs)).toEqual([
      { ref: "e1", backendNodeId: 3 },
      { ref: "e2", backendNodeId: 6 },
    ]);
    expect(out.truncated).toBe(false);
  });

  it("does not assign refs to structural or display-only nodes", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, role: "heading", name: "Title" }),
        node({ id: 3, parentId: 1, role: "img", name: "Logo" }),
        node({ id: 4, parentId: 1, role: "button", name: "Continue", tag: "button" }),
      ]),
    );

    expect(out.text).toContain('  RootWebArea "Doc"');
    expect(out.text).toContain('    heading "Title"');
    expect(out.text).toContain('    img "Logo"');
    expect(out.text).toContain('    @e1 button "Continue"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 4 }]);
  });

  it("assigns refs to listbox controls", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, role: "listbox", name: "Choices" }),
      ]),
    );

    expect(out.text).toContain('    @e1 listbox "Choices"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);
  });

  it("annotates external links regardless of role casing", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "Link",
          name: "Docs",
          href: "docs.example.org",
          tag: "a",
        }),
      ]),
    );

    expect(out.text).toContain('@e1 Link "Docs" [→ docs.example.org]');
  });

  it("renders additional structural roles without assigning refs", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "WebArea" }),
        node({ id: 2, parentId: 1, role: "Iframe" }),
        node({ id: 3, parentId: 1, role: "alertdialog" }),
        node({ id: 4, parentId: 3, role: "section" }),
        node({ id: 5, parentId: 4, role: "button", name: "Close", tag: "button" }),
      ]),
    );

    expect(out.text).toContain("  WebArea");
    expect(out.text).toContain("    Iframe");
    expect(out.text).toContain("    alertdialog");
    expect(out.text).toContain("      section");
    expect(out.text).toContain('        @e1 button "Close"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 5 }]);
  });

  it("skips generic nodes without adding an extra indentation level", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, role: "generic" }),
        node({ id: 3, parentId: 2, role: "button", name: "OK", tag: "button" }),
      ]),
    );

    expect(out.text).not.toContain("generic");
    expect(out.text).toContain('    @e1 button "OK"');
  });

  it("masks sensitive values and never emits the clear text value", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Login" }),
        node({
          id: 2,
          parentId: 1,
          role: "textbox",
          name: "密码",
          value: "hunter2",
          tag: "input",
          sensitive: true,
        }),
      ]),
    );

    expect(out.text).toContain('@e1 textbox "密码" [filled] ="•••"');
    expect(out.text).not.toContain("hunter2");
  });

  it("renders a sensitive filled state without retaining its clear text value", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Login" }),
        node({
          id: 2,
          parentId: 1,
          role: "textbox",
          name: "密码",
          tag: "input",
          sensitive: true,
          inputState: "filled",
        }),
      ]),
    );

    expect(out.text).toContain('@e1 textbox "密码" [filled] ="•••"');
  });

  it("does not imply an empty sensitive textbox has a value", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Login" }),
        node({
          id: 2,
          parentId: 1,
          role: "textbox",
          name: "密码",
          tag: "input",
          sensitive: true,
          inputState: "empty",
        }),
      ]),
    );

    expect(out.text).toContain('@e1 textbox "密码" [empty]');
    expect(out.text).not.toContain('="•••"');
  });

  it("continues rendering later siblings after a branch exceeds maxDepth", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, role: "section" }),
        node({ id: 3, parentId: 2, role: "heading", name: "Too deep" }),
        node({ id: 4, parentId: 1, role: "button", name: "Later", tag: "button" }),
      ]),
      { maxDepth: 2 },
    );

    expect(out.truncated).toBe(true);
    expect(out.text).toContain('  RootWebArea "Doc"');
    expect(out.text).toContain("    section");
    expect(out.text).not.toContain("Too deep");
    expect(out.text).toContain('    @e1 button "Later"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 4 }]);
  });

  it("renders through deeply nested transparent wrappers without exhausting the call stack", () => {
    const wrapperCount = 10_000;
    const nodes = [node({ id: 1, role: "RootWebArea", name: "Doc" })];
    for (let index = 0; index < wrapperCount; index += 1) {
      nodes.push(
        node({
          id: index + 2,
          parentId: index + 1,
          role: "generic",
        }),
      );
    }
    nodes.push(
      node({
        id: wrapperCount + 2,
        parentId: wrapperCount + 1,
        role: "button",
        name: "Deep action",
        tag: "button",
      }),
    );

    const out = renderVom(scene(nodes));

    expect(out.text).toContain('@e1 button "Deep action"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: wrapperCount + 2 }]);
  });

  it("truncates when maxTokens is exceeded while keeping refs in sync with rendered text", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, role: "button", name: "First", tag: "button" }),
        node({ id: 3, parentId: 1, role: "button", name: "Second", tag: "button" }),
      ]),
      { maxTokens: 22 },
    );

    expect(out.truncated).toBe(true);
    const renderedRefs = new Set(Array.from(out.text.matchAll(/@(e\d+)/g), (m) => m[1]));
    expect(out.refs.every((r) => renderedRefs.has(r.ref))).toBe(true);
  });

  it("recovers custom clickable controls from DOM-only signals", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "generic",
          text: "Open settings",
          cursor: "pointer",
          attrs: { onclick: "handleOpen()" },
          rect: { x: 20, y: 20, w: 160, h: 40 },
        }),
      ]),
    );

    expect(out.text).toContain('@e1 button "Open settings"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);
  });

  it.each([
    { tag: "div", role: "generic" },
    { tag: "span", role: "generic" },
    { tag: "li", role: "listitem" },
  ])("recovers browser-reported clickable $tag nodes without HTML handlers", ({ tag, role }) => {
    const out = renderVom(
      scene([node({ id: 1, tag, role, text: "Open settings", clickable: true })]),
    );
    expect(out.text).toContain('@e1 button "Open settings"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 1 }]);
  });

  it.each<Partial<VomNode>>([
    { disabled: true },
    { inert: true },
    { pointerEvents: "none" },
    { insideNative: true },
    { hasNativeDescendant: true },
    { rect: { x: 0, y: 0, w: 1000, h: 800 } },
    { tag: "svg" },
    { text: undefined },
  ])("keeps recovery guards for browser-reported clickability: %j", (guard) => {
    const out = renderVom(
      scene([node({ id: 1, role: "generic", text: "Open settings", clickable: true, ...guard })]),
    );
    expect(out.refs).toEqual([]);
  });

  it("does not infer clickable list items from a pointer cursor alone", () => {
    const out = renderVom(
      scene([
        node({ id: 1, tag: "li", role: "listitem", text: "Section label", cursor: "pointer" }),
      ]),
    );
    expect(out.refs).toEqual([]);
  });

  it("propagates refs to rows of a delegated list container", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          tag: "ul",
          role: "list",
          clickable: true,
          rect: { x: 0, y: 0, w: 200, h: 120 },
        }),
        node({
          id: 3,
          parentId: 2,
          tag: "li",
          role: "listitem",
          name: "甲一",
          rect: { x: 0, y: 0, w: 200, h: 40 },
        }),
        node({
          id: 4,
          parentId: 2,
          tag: "li",
          role: "listitem",
          name: "甲二",
          rect: { x: 0, y: 40, w: 200, h: 40 },
        }),
        node({
          id: 5,
          parentId: 2,
          tag: "li",
          role: "listitem",
          name: "甲三",
          rect: { x: 0, y: 80, w: 200, h: 40 },
        }),
      ]),
    );
    expect(out.refs).toHaveLength(3);
    expect(out.text).toContain('button "甲一"');
    expect(out.text).not.toContain('button "甲一 甲二 甲三"');
  });

  it("keeps plain lists without delegated clickability ref-free", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, tag: "ul", role: "list" }),
        node({ id: 3, parentId: 2, tag: "li", role: "listitem", name: "行一" }),
        node({ id: 4, parentId: 2, tag: "li", role: "listitem", name: "行二" }),
        node({ id: 5, parentId: 2, tag: "li", role: "listitem", name: "行三" }),
      ]),
    );
    expect(out.refs).toEqual([]);
  });

  it("propagates refs to homogeneous repeated rows under a delegated div", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          tag: "div",
          role: "generic",
          clickable: true,
          rect: { x: 0, y: 0, w: 300, h: 120 },
        }),
        node({
          id: 3,
          parentId: 2,
          tag: "div",
          role: "generic",
          text: "甲一",
          rect: { x: 0, y: 0, w: 300, h: 40 },
        }),
        node({
          id: 4,
          parentId: 2,
          tag: "div",
          role: "generic",
          text: "甲二",
          rect: { x: 0, y: 40, w: 300, h: 40 },
        }),
        node({
          id: 5,
          parentId: 2,
          tag: "div",
          role: "generic",
          text: "甲三",
          rect: { x: 0, y: 80, w: 300, h: 40 },
        }),
      ]),
    );
    expect(out.refs).toHaveLength(3);
    expect(out.text).toContain('button "甲一"');
  });

  it("keeps a two-line compound button as a single ref", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          tag: "div",
          role: "generic",
          clickable: true,
          name: "标题 副标题",
          rect: { x: 0, y: 0, w: 300, h: 80 },
        }),
        node({
          id: 3,
          parentId: 2,
          tag: "div",
          role: "generic",
          name: "标题",
          rect: { x: 0, y: 0, w: 300, h: 40 },
        }),
        node({
          id: 4,
          parentId: 2,
          tag: "div",
          role: "generic",
          name: "副标题",
          rect: { x: 0, y: 40, w: 300, h: 40 },
        }),
      ]),
    );
    expect(out.refs).toHaveLength(1);
    expect(out.text).toContain('button "标题 副标题"');
  });

  it("is idempotent across multiple applyVomInteractionRecovery passes and inherited pointer cursors", () => {
    const rawNodes: VomNode[] = [
      node({ id: 1, role: "RootWebArea", name: "Doc" }),
      node({
        id: 2,
        parentId: 1,
        tag: "ul",
        role: "list",
        name: "SHA 上海 PEK 北京 CAN 广州",
        clickable: true,
        cursor: "pointer",
        rect: { x: 0, y: 0, w: 240, h: 120 },
      }),
      node({
        id: 3,
        parentId: 2,
        tag: "li",
        role: "listitem",
        name: "SHA 上海",
        cursor: "pointer",
        rect: { x: 0, y: 0, w: 240, h: 40 },
      }),
      node({ id: 31, parentId: 3, tag: "span", role: "generic", name: "SHA", cursor: "pointer" }),
      node({ id: 32, parentId: 3, tag: "span", role: "generic", name: "上海", cursor: "pointer" }),
      node({
        id: 4,
        parentId: 2,
        tag: "li",
        role: "listitem",
        name: "PEK 北京",
        cursor: "pointer",
        rect: { x: 0, y: 40, w: 240, h: 40 },
      }),
      node({
        id: 5,
        parentId: 2,
        tag: "li",
        role: "listitem",
        name: "CAN 广州",
        cursor: "pointer",
        rect: { x: 0, y: 80, w: 240, h: 40 },
      }),
      node({
        id: 6,
        parentId: 1,
        tag: "div",
        role: "generic",
        name: "甲一 甲二 甲三",
        clickable: true,
        rect: { x: 0, y: 140, w: 300, h: 120 },
      }),
      node({
        id: 7,
        parentId: 6,
        tag: "div",
        role: "generic",
        name: "甲一",
        rect: { x: 0, y: 140, w: 300, h: 40 },
      }),
      node({
        id: 8,
        parentId: 6,
        tag: "div",
        role: "generic",
        name: "甲二",
        rect: { x: 0, y: 180, w: 300, h: 40 },
      }),
      node({
        id: 9,
        parentId: 6,
        tag: "div",
        role: "generic",
        name: "甲三",
        rect: { x: 0, y: 220, w: 300, h: 40 },
      }),
    ];

    const pass1 = applyVomInteractionRecovery(rawNodes);
    const pass2 = applyVomInteractionRecovery(pass1);
    expect(pass2).toEqual(pass1);

    const out = renderVom(scene(pass2));
    expect(coreRefs(out.refs)).toEqual([
      { ref: "e1", backendNodeId: 3 },
      { ref: "e2", backendNodeId: 4 },
      { ref: "e3", backendNodeId: 5 },
      { ref: "e4", backendNodeId: 7 },
      { ref: "e5", backendNodeId: 8 },
      { ref: "e6", backendNodeId: 9 },
    ]);
    expect(out.text).not.toContain('button "SHA 上海 PEK 北京 CAN 广州"');
    expect(out.text).not.toContain('button "甲一 甲二 甲三"');

    const prepared = prepareObservationRender(scene(pass1));
    const preparedRefs = Array.from({ [Symbol.iterator]: () => prepared.rows })
      .filter((row) => row.ref)
      .map((row) => row.ref!.backendNodeId);
    expect(preparedRefs).toEqual([3, 4, 5, 7, 8, 9]);
  });

  it("recovers an accessible icon/hamburger ul when none of its child bars carry row text", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          tag: "ul",
          role: "list",
          clickable: true,
          attrs: { "aria-label": "打开菜单" },
          rect: { x: 0, y: 0, w: 36, h: 36 },
        }),
        node({
          id: 3,
          parentId: 2,
          tag: "li",
          role: "listitem",
          rect: { x: 6, y: 8, w: 24, h: 3 },
        }),
        node({
          id: 4,
          parentId: 2,
          tag: "li",
          role: "listitem",
          rect: { x: 6, y: 16, w: 24, h: 3 },
        }),
        node({
          id: 5,
          parentId: 2,
          tag: "li",
          role: "listitem",
          rect: { x: 6, y: 24, w: 24, h: 3 },
        }),
      ]),
    );
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);
    expect(out.text).toContain('@e1 button "打开菜单"');
  });

  it("ignores sibling nearbyText, separators, list markers, and non-referenceable AX text inside delegated lists", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          tag: "ul",
          role: "list",
          clickable: true,
          rect: { x: 0, y: 0, w: 200, h: 100 },
        }),
        node({
          id: 3,
          parentId: 2,
          tag: "",
          role: "StaticText",
          name: "Loose AX text",
          referenceable: false,
        }),
        node({
          id: 4,
          parentId: 2,
          tag: "li",
          role: "listitem",
          name: "甲一",
          rect: { x: 0, y: 0, w: 200, h: 36 },
        }),
        node({
          id: 5,
          parentId: 2,
          tag: "li",
          role: "listitem",
          nearbyText: "甲一",
          rect: { x: 0, y: 36, w: 200, h: 2 },
        }),
        node({ id: 51, parentId: 5, tag: "", role: "ListMarker", name: "•", referenceable: false }),
        node({
          id: 6,
          parentId: 2,
          tag: "li",
          role: "separator",
          name: "---",
          rect: { x: 0, y: 38, w: 200, h: 2 },
        }),
        node({
          id: 7,
          parentId: 2,
          tag: "li",
          role: "listitem",
          name: "甲二",
          rect: { x: 0, y: 40, w: 200, h: 36 },
        }),
      ]),
    );
    expect(coreRefs(out.refs)).toEqual([
      { ref: "e1", backendNodeId: 4 },
      { ref: "e2", backendNodeId: 7 },
    ]);
  });

  it("does not split atomic links, explicit button roles, disabled lists, multi-slot cards, or horizontal pill rows", () => {
    const linkCard = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          tag: "a",
          role: "link",
          name: "Line 1 Line 2 Line 3",
          clickable: true,
          rect: { x: 0, y: 0, w: 240, h: 120 },
        }),
        node({
          id: 3,
          parentId: 2,
          tag: "div",
          text: "Line 1",
          rect: { x: 0, y: 0, w: 240, h: 40 },
        }),
        node({
          id: 4,
          parentId: 2,
          tag: "div",
          text: "Line 2",
          rect: { x: 0, y: 40, w: 240, h: 40 },
        }),
        node({
          id: 5,
          parentId: 2,
          tag: "div",
          text: "Line 3",
          rect: { x: 0, y: 80, w: 240, h: 40 },
        }),
      ]),
    );
    expect(coreRefs(linkCard.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);
    expect(linkCard.text).toContain('@e1 link "Line 1 Line 2 Line 3"');

    const explicitButton = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          tag: "div",
          role: "generic",
          attrs: { role: "button" },
          name: "总收入 ¥128,400 +12%",
          clickable: true,
          rect: { x: 0, y: 0, w: 240, h: 120 },
        }),
        node({
          id: 3,
          parentId: 2,
          tag: "div",
          text: "总收入",
          rect: { x: 0, y: 0, w: 240, h: 40 },
        }),
        node({
          id: 4,
          parentId: 2,
          tag: "div",
          text: "¥128,400",
          rect: { x: 0, y: 40, w: 240, h: 40 },
        }),
        node({
          id: 5,
          parentId: 2,
          tag: "div",
          text: "+12%",
          rect: { x: 0, y: 80, w: 240, h: 40 },
        }),
      ]),
    );
    expect(coreRefs(explicitButton.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);

    const slotCard = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          tag: "div",
          role: "generic",
          name: "总收入 ¥128,400 +12%",
          clickable: true,
          rect: { x: 0, y: 0, w: 240, h: 120 },
        }),
        node({
          id: 3,
          parentId: 2,
          tag: "div",
          attrs: { class: "card-title" },
          text: "总收入",
          rect: { x: 0, y: 0, w: 240, h: 40 },
        }),
        node({
          id: 4,
          parentId: 2,
          tag: "div",
          attrs: { class: "card-value" },
          text: "¥128,400",
          rect: { x: 0, y: 40, w: 240, h: 40 },
        }),
        node({
          id: 5,
          parentId: 2,
          tag: "div",
          attrs: { class: "card-trend" },
          text: "+12%",
          rect: { x: 0, y: 80, w: 240, h: 40 },
        }),
      ]),
    );
    expect(coreRefs(slotCard.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);

    const horizontalRow = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          tag: "div",
          role: "generic",
          name: "月付 季付 年付",
          clickable: true,
          rect: { x: 0, y: 10, w: 300, h: 36 },
        }),
        node({ id: 3, parentId: 2, tag: "div", text: "月付", rect: { x: 0, y: 10, w: 96, h: 32 } }),
        node({
          id: 4,
          parentId: 2,
          tag: "div",
          text: "季付",
          rect: { x: 100, y: 11, w: 96, h: 32 },
        }),
        node({
          id: 5,
          parentId: 2,
          tag: "div",
          text: "年付",
          rect: { x: 200, y: 12, w: 96, h: 32 },
        }),
      ]),
    );
    expect(coreRefs(horizontalRow.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);

    const disabledList = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, tag: "ul", role: "list", clickable: true, disabled: true }),
        node({ id: 3, parentId: 2, tag: "li", role: "listitem", name: "甲一" }),
        node({ id: 4, parentId: 2, tag: "li", role: "listitem", name: "甲二" }),
      ]),
    );
    expect(disabledList.refs).toEqual([]);
  });

  it("unwraps single-child dropdown wrappers, tolerates wrapped row heights, and handles nested/mixed lists", () => {
    const wrappedDropdown = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          tag: "div",
          role: "generic",
          name: "甲一 甲二 较长的换行建议项文本 甲三 清空历史",
          clickable: true,
          rect: { x: 0, y: 0, w: 260, h: 180 },
        }),
        node({
          id: 3,
          parentId: 2,
          tag: "ul",
          role: "list",
          rect: { x: 0, y: 0, w: 260, h: 180 },
        }),
        node({ id: 4, parentId: 3, tag: "li", role: "listitem", name: "甲一" }),
        node({
          id: 5,
          parentId: 3,
          tag: "li",
          role: "listitem",
          name: "甲二 较长的换行建议项文本",
        }),
        node({ id: 6, parentId: 3, tag: "li", role: "listitem", name: "甲三" }),
        node({ id: 7, parentId: 3, tag: "li", role: "listitem", hasNativeDescendant: true }),
        node({ id: 8, parentId: 7, tag: "button", role: "button", name: "清空历史" }),
      ]),
    );
    expect(coreRefs(wrappedDropdown.refs)).toEqual([
      { ref: "e1", backendNodeId: 4 },
      { ref: "e2", backendNodeId: 5 },
      { ref: "e3", backendNodeId: 6 },
      { ref: "e4", backendNodeId: 8 },
    ]);

    const wrappedHeightDivs = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          tag: "div",
          role: "generic",
          clickable: true,
          rect: { x: 0, y: 0, w: 260, h: 144 },
        }),
        node({
          id: 3,
          parentId: 2,
          tag: "div",
          text: "短项一",
          rect: { x: 0, y: 0, w: 260, h: 36 },
        }),
        node({
          id: 4,
          parentId: 2,
          tag: "div",
          text: "两行换行的较长搜索建议二",
          rect: { x: 0, y: 36, w: 260, h: 72 },
        }),
        node({
          id: 5,
          parentId: 2,
          tag: "div",
          text: "短项三",
          rect: { x: 0, y: 108, w: 260, h: 36 },
        }),
      ]),
    );
    expect(coreRefs(wrappedHeightDivs.refs)).toEqual([
      { ref: "e1", backendNodeId: 3 },
      { ref: "e2", backendNodeId: 4 },
      { ref: "e3", backendNodeId: 5 },
    ]);

    const groupedTree = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, tag: "ul", role: "tree", clickable: true }),
        node({ id: 3, parentId: 2, tag: "li", role: "listitem", name: "第一章" }),
        node({ id: 4, parentId: 3, tag: "ul", role: "group" }),
        node({ id: 5, parentId: 4, tag: "li", role: "listitem", name: "1.1 节" }),
        node({ id: 6, parentId: 4, tag: "li", role: "listitem", name: "1.2 节" }),
      ]),
    );
    expect(coreRefs(groupedTree.refs)).toEqual([
      { ref: "e1", backendNodeId: 5 },
      { ref: "e2", backendNodeId: 6 },
    ]);
    expect(groupedTree.text).not.toContain('button "第一章');

    const navList = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, tag: "ul", role: "list", clickable: true }),
        node({ id: 3, parentId: 2, tag: "li", role: "listitem" }),
        node({ id: 4, parentId: 3, tag: "a", role: "link", name: "首页" }),
        node({ id: 5, parentId: 2, tag: "li", role: "listitem" }),
        node({ id: 6, parentId: 5, tag: "a", role: "link", name: "文档" }),
        node({ id: 7, parentId: 2, tag: "li", role: "listitem", name: "© 2026" }),
      ]),
    );
    expect(coreRefs(navList.refs)).toEqual([
      { ref: "e1", backendNodeId: 4 },
      { ref: "e2", backendNodeId: 6 },
    ]);
  });

  it("does not treat implementation CSS classes as control names", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "generic",
          cursor: "pointer",
          attrs: { onclick: "handleClick()" },
          rect: { x: 20, y: 20, w: 40, h: 40 },
        }),
        node({
          id: 3,
          parentId: 2,
          role: "img",
          tag: "svg",
          attrs: { class: "kocomz" },
        }),
      ]),
    );

    expect(out.text).not.toContain("kocomz");
    expect(out.refs).toEqual([]);
  });

  it("recovers icon controls only from explicit semantic icon evidence", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "generic",
          cursor: "pointer",
          attrs: { onclick: "handleFilter()" },
          rect: { x: 20, y: 20, w: 40, h: 40 },
        }),
        node({
          id: 3,
          parentId: 2,
          role: "img",
          tag: "svg",
          attrs: { "aria-label": "Filter rows", class: "kocomz" },
        }),
      ]),
    );

    expect(out.text).toContain('@e1 button "Filter rows"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);
  });

  it("keeps a semantic image as evidence for its clickable wrapper", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "generic",
          cursor: "pointer",
          rect: { x: 20, y: 20, w: 40, h: 40 },
        }),
        node({
          id: 3,
          parentId: 2,
          role: "img",
          name: "Account",
          cursor: "pointer",
          tag: "div",
        }),
      ]),
    );

    expect(out.text).toContain('@e1 button "Account"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);
  });

  it("keeps the deepest custom control when wrapper and child both look clickable", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "generic",
          text: "Card",
          cursor: "pointer",
          attrs: { onclick: "handleCard()" },
          rect: { x: 20, y: 20, w: 280, h: 120 },
        }),
        node({
          id: 3,
          parentId: 2,
          role: "generic",
          text: "Details",
          cursor: "pointer",
          attrs: { onclick: "handleDetails()" },
          rect: { x: 40, y: 70, w: 90, h: 32 },
        }),
      ]),
    );

    expect(out.text).not.toContain('@e1 button "Card"');
    expect(out.text).toContain('@e1 button "Details"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 3 }]);
  });

  it("does not recover clickable wrappers around native controls", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "generic",
          text: "Checkout",
          cursor: "pointer",
          attrs: { onclick: "handleCheckout()" },
          hasNativeDescendant: true,
          rect: { x: 20, y: 20, w: 280, h: 120 },
        }),
        node({ id: 3, parentId: 2, role: "button", name: "Pay", tag: "button" }),
      ]),
    );

    expect(out.text).not.toContain('@e1 button "Checkout"');
    expect(out.text).toContain('@e1 button "Pay"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 3 }]);
  });

  it("adds context to duplicate weak action labels", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Admin" }),
        node({ id: 2, parentId: 1, role: "section", name: "Project Alpha" }),
        node({ id: 3, parentId: 2, role: "button", name: "View", tag: "button" }),
        node({ id: 4, parentId: 1, role: "section", name: "Project Beta" }),
        node({ id: 5, parentId: 4, role: "button", name: "View", tag: "button" }),
      ]),
    );

    expect(out.text).toContain('@e1 button "View" [ctx: Project Alpha]');
    expect(out.text).toContain('@e2 button "View" [ctx: Project Beta]');
  });

  it("filters noisy template/layout text from weak label context", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "section",
          name: "top 开始 top 结束 bigpic、登录 开始 <![endif]",
        }),
        node({ id: 3, parentId: 2, role: "button", name: "更多", tag: "button" }),
      ]),
    );

    expect(out.text).toContain('@e1 button "更多"');
    expect(out.text).not.toContain("[ctx:");
  });

  it("keeps active-region filtering disabled by default", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "button",
          name: "Background",
          tag: "button",
          rect: { x: 120, y: 120, w: 120, h: 40 },
          paintOrder: 1,
        }),
        node({
          id: 3,
          parentId: 1,
          role: "generic",
          tag: "div",
          rect: { x: 100, y: 100, w: 180, h: 120 },
          paintOrder: 10,
          position: "fixed",
        }),
      ]),
    );

    expect(out.text).toContain("@layers 1 focus=L1");
    expect(out.text).toContain('@e1 button "Background"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);
  });

  it("can filter refs blocked by active positioned regions without changing layer output", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "button",
          name: "Background",
          tag: "button",
          rect: { x: 120, y: 120, w: 120, h: 40 },
          paintOrder: 1,
        }),
        node({
          id: 3,
          parentId: 1,
          role: "generic",
          tag: "div",
          rect: { x: 100, y: 100, w: 180, h: 120 },
          paintOrder: 10,
          position: "fixed",
        }),
        node({
          id: 4,
          parentId: 1,
          role: "button",
          name: "Foreground",
          tag: "button",
          rect: { x: 320, y: 120, w: 120, h: 40 },
          paintOrder: 11,
        }),
      ]),
      { activeRegionPolicy: true },
    );

    expect(out.text).toContain("@layers 1 focus=L1");
    expect(out.text).toContain("L1 page");
    expect(out.text).not.toContain("active-region");
    expect(out.text).not.toContain("Background");
    expect(out.text).toContain('@e1 button "Foreground"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 4 }]);
  });

  it("keeps paint-order comparisons inside their frame document", () => {
    const out = renderVom(
      {
        ...scene([
          node({ id: 1, role: "RootWebArea", frameId: "main" }),
          node({
            id: 2,
            parentId: 1,
            role: "button",
            name: "Top-level action",
            tag: "button",
            rect: { x: 120, y: 120, w: 120, h: 40 },
            paintOrder: 2,
            frameId: "main",
          }),
          node({
            id: 3,
            parentId: 1,
            role: "Iframe",
            tag: "iframe",
            rect: { x: 0, y: 0, w: 1000, h: 700 },
            paintOrder: 1,
            frameId: "main",
          }),
          node({
            id: 4,
            parentId: 3,
            role: "generic",
            rect: { x: 0, y: 0, w: 1000, h: 700 },
            paintOrder: 100,
            position: "fixed",
            frameId: "child",
          }),
          node({
            id: 5,
            parentId: 4,
            role: "button",
            name: "Child action",
            tag: "button",
            rect: { x: 120, y: 120, w: 120, h: 40 },
            paintOrder: 101,
            frameId: "child",
          }),
        ]),
        rootFrameId: "main",
      },
      { activeRegionPolicy: true },
    );

    expect(out.text).toContain("@layers 1 focus=L1");
    expect(out.text).toContain('button "Top-level action"');
    expect(out.text).toContain('button "Child action"');
  });

  it("uses the iframe owner when a parent-frame region covers child content", () => {
    const out = renderVom(
      {
        ...scene([
          node({ id: 1, role: "RootWebArea", frameId: "main" }),
          node({
            id: 2,
            parentId: 1,
            role: "Iframe",
            tag: "iframe",
            rect: { x: 100, y: 100, w: 400, h: 300 },
            paintOrder: 1,
            frameId: "main",
          }),
          node({
            id: 3,
            parentId: 2,
            role: "button",
            name: "Covered child action",
            tag: "button",
            rect: { x: 150, y: 150, w: 120, h: 40 },
            paintOrder: 100,
            frameId: "child",
          }),
          node({
            id: 4,
            parentId: 1,
            role: "generic",
            rect: { x: 120, y: 120, w: 200, h: 120 },
            paintOrder: 2,
            position: "fixed",
            frameId: "main",
          }),
        ]),
        rootFrameId: "main",
      },
      { activeRegionPolicy: true },
    );

    expect(out.text).not.toContain("Covered child action");
  });

  it("renders conditional surface items inline on the trigger", () => {
    const out = renderVom({
      ...scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, role: "button", name: "Products", tag: "button" }),
      ]),
      surfaces: [
        {
          triggerId: 2,
          triggerAction: "hover",
          subItems: ["Shoes", "Bags", "Accessories"],
        },
      ],
    });

    expect(out.text).toContain('@e1 button "Products" [hover first: Shoes | Bags | Accessories]');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);
  });

  it("injects active scope blocks immediately after their trigger without refs", () => {
    const out = renderVom({
      ...scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, role: "tab", name: "Reviews (12)", tag: "button" }),
      ]),
      activeScopeBlocks: [
        {
          triggerId: 2,
          label: "Reviews (12)",
          lines: ["Jane - ear cups are small", "Bob - great sound"],
        },
      ],
    });

    expect(out.text).toContain(
      [
        '    @e1 tab "Reviews (12)"',
        "      [§ active: Reviews (12)]",
        "        Jane - ear cups are small",
        "        Bob - great sound",
      ].join("\n"),
    );
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);
  });

  it("does not render redundant children inside named ref controls", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, role: "button", name: "Save", tag: "button" }),
        node({ id: 3, parentId: 2, role: "img", name: "disk icon", tag: "svg" }),
      ]),
    );

    expect(out.text).toContain('@e1 button "Save"');
    expect(out.text).not.toContain("disk icon");
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 2 }]);
  });

  it("does not render redundant children inside native text inputs", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "textbox",
          name: "手机号",
          value: "13311030827",
          tag: "input",
        }),
        node({ id: 3, parentId: 2, role: "StaticText", name: "13311030827" }),
      ]),
    );

    expect(out.text).toContain('@e1 textbox "手机号" [filled] ="13311030827"');
    expect(out.text).not.toContain('StaticText "13311030827"');
  });

  it("renders placeholder separately from input value and state", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 2,
          parentId: 1,
          role: "textbox",
          name: "手机号",
          value: "没有手机号的用编码代替",
          placeholder: "手机号",
          inputState: "default",
          tag: "input",
        }),
      ]),
    );

    expect(out.text).toContain(
      '@e1 textbox "手机号" [default] placeholder="手机号" ="没有手机号的用编码代替"',
    );
  });

  it("keeps only local context for duplicate labels", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "北京市小客车指标调控管理信息系统" }),
        node({ id: 2, parentId: 1, role: "section" }),
        node({ id: 3, parentId: 2, role: "StaticText", name: "账号" }),
        node({ id: 4, parentId: 2, role: "link", name: "操作说明", tag: "a" }),
        node({ id: 5, parentId: 1, role: "section" }),
        node({ id: 6, parentId: 5, role: "StaticText", name: "配置指标" }),
        node({ id: 7, parentId: 5, role: "link", name: "操作说明", tag: "a" }),
      ]),
    );

    expect(out.text).toContain('@e1 link "操作说明" [ctx: 账号]');
    expect(out.text).toContain('@e2 link "操作说明" [ctx: 配置指标]');
    expect(out.text).not.toContain("北京市小客车指标调控管理信息系统]");
  });

  it("derives duplicate-label context from indexed DOM ancestry without semantic proximity", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc", contextScopeId: "root" }),
        node({
          id: 3,
          parentId: 1,
          role: "button",
          name: "View",
          tag: "button",
          domParentId: 2,
          domAncestorIds: [2, 1],
          contextScopeId: "root",
        }),
        node({
          id: 5,
          parentId: 1,
          role: "button",
          name: "View",
          tag: "button",
          domParentId: 4,
          domAncestorIds: [4, 1],
          contextScopeId: "root",
        }),
        node({
          id: 2,
          parentId: 1,
          role: "group",
          name: "Project Alpha",
          domParentId: 1,
          domAncestorIds: [1],
          contextScopeId: "root",
        }),
        node({
          id: 4,
          parentId: 1,
          role: "group",
          name: "Project Beta",
          domParentId: 1,
          domAncestorIds: [1],
          contextScopeId: "root",
        }),
      ]),
    );

    expect(out.text).toContain('@e1 button "View" [ctx: Project Alpha]');
    expect(out.text).toContain('@e2 button "View" [ctx: Project Beta]');
  });

  it.each([
    false,
    true,
  ])("uses DOM card text even after both CTAs in AX order (reversed=%s)", (reversed) => {
    const cards = [
      node({
        id: 2,
        parentId: 1,
        tag: "button",
        role: "button",
        name: "Continue",
        contextScopeId: "root",
        domParentId: 100,
        domAncestorIds: [100, 1],
      }),
      node({
        id: 3,
        parentId: 1,
        tag: "button",
        role: "button",
        name: "Continue",
        contextScopeId: "root",
        domParentId: 101,
        domAncestorIds: [101, 1],
      }),
      node({
        id: 4,
        parentId: 1,
        role: "StaticText",
        name: "Candidate A",
        contextScopeId: "root",
        domParentId: 100,
        domAncestorIds: [100, 1],
      }),
      node({
        id: 5,
        parentId: 1,
        role: "StaticText",
        name: "Candidate B",
        contextScopeId: "root",
        domParentId: 101,
        domAncestorIds: [101, 1],
      }),
    ];
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", contextScopeId: "root" }),
        node({
          id: 6,
          parentId: 1,
          role: "StaticText",
          name: "Record 99",
          contextScopeId: "root",
          domParentId: 1,
          domAncestorIds: [1],
        }),
        ...(reversed ? cards.reverse() : cards),
      ]),
    );
    // References remain attached to the concrete card, independent of output order.
    expect(out.text).not.toContain("[ctx: Record 99]");
    expect(out.refs.map((ref) => ref.ctx).sort()).toEqual(["Candidate A", "Candidate B"]);
  });

  it("does not infer duplicate-action context from other cards or frame scopes", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", contextScopeId: "root" }),
        node({
          id: 2,
          parentId: 1,
          role: "StaticText",
          name: "Other record",
          contextScopeId: "root",
          domParentId: 100,
          domAncestorIds: [100, 1],
        }),
        node({
          id: 3,
          parentId: 1,
          tag: "button",
          role: "button",
          name: "Continue",
          contextScopeId: "root",
          domParentId: 101,
          domAncestorIds: [101, 1],
        }),
        node({
          id: 4,
          parentId: 1,
          tag: "button",
          role: "button",
          name: "Continue",
          contextScopeId: "root",
          domParentId: 102,
          domAncestorIds: [102, 1],
        }),
        node({
          id: 5,
          parentId: 1,
          role: "StaticText",
          name: "Other frame",
          contextScopeId: "child",
          domParentId: 101,
          domAncestorIds: [101, 1],
        }),
      ]),
    );
    expect(out.refs.map((ref) => ref.ctx)).toEqual([undefined, undefined]);
  });

  it("does not add low-value root context to duplicated brand links", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "北京市小客车指标调控管理信息系统" }),
        node({ id: 2, parentId: 1, role: "link", name: "北京市交通委员会", tag: "a" }),
        node({ id: 3, parentId: 1, role: "link", name: "北京市交通委员会", tag: "a" }),
      ]),
    );

    expect(out.text).toContain('@e1 link "北京市交通委员会"');
    expect(out.text).toContain('@e2 link "北京市交通委员会"');
    expect(out.text).not.toContain("[ctx:");
  });

  it("does not render redundant table cell descendants when the cell name covers them", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, role: "table" }),
        node({ id: 3, parentId: 2, role: "row" }),
        node({ id: 4, parentId: 3, role: "cell", name: "申请人姓名：刘珺瑶" }),
        node({ id: 5, parentId: 4, role: "StaticText", name: "申请人姓名：" }),
        node({ id: 6, parentId: 4, role: "StaticText", name: "刘珺瑶" }),
      ]),
    );

    expect(out.text).toContain('cell "申请人姓名：刘珺瑶"');
    expect(out.text).not.toContain('StaticText "申请人姓名："');
    expect(out.text).not.toContain('StaticText "刘珺瑶"');
  });

  it("keeps interactive descendants inside table cells", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, role: "table" }),
        node({ id: 3, parentId: 2, role: "row" }),
        node({ id: 4, parentId: 3, role: "cell", name: "操作：下载" }),
        node({ id: 5, parentId: 4, role: "link", name: "下载", tag: "a" }),
      ]),
    );

    expect(out.text).toContain('cell "操作：下载"');
    expect(out.text).toContain('@e1 link "下载"');
  });
});

describe("renderVom double-layer page", () => {
  it("collects blocking-layer descendants even when children precede parents in source order", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({
          id: 3,
          parentId: 2,
          role: "button",
          name: "Close",
          tag: "button",
          paintOrder: 0,
        }),
        node({
          id: 2,
          parentId: 1,
          role: "dialog",
          name: "Modal",
          rect: { x: 0, y: 0, w: 1280, h: 720 },
          paintOrder: 10,
          position: "fixed",
        }),
      ]),
    );

    expect(out.text).toContain('@e1 button "Close"');
    expect(coreRefs(out.refs)).toEqual([{ ref: "e1", backendNodeId: 3 }]);
  });

  it("renders a blocking modal first and folds the base page into an occluded summary", () => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          role: "RootWebArea",
          name: "Shop",
          tag: "body",
          rect: { x: 0, y: 0, w: 1000, h: 3000 },
        }),
        node({ id: 10, parentId: 1, role: "button", name: "底层按钮", tag: "button" }),
        node({
          id: 2,
          parentId: 1,
          tag: "div",
          rect: { x: 0, y: 0, w: 1280, h: 720 },
          paintOrder: 50,
          position: "fixed",
          pointerEvents: "auto",
        }),
        node({
          id: 3,
          parentId: 1,
          role: "dialog",
          name: "提示",
          modal: true,
          rect: { x: 400, y: 200, w: 480, h: 320 },
          paintOrder: 60,
          position: "fixed",
        }),
        node({
          id: 4,
          parentId: 3,
          role: "textbox",
          name: "密码",
          value: "secret",
          tag: "input",
          sensitive: true,
        }),
        node({ id: 5, parentId: 3, role: "button", name: "确认", tag: "button" }),
      ]),
    );

    expect(out.text).toBe(
      [
        "@vom 1",
        "@view 1280x720",
        "@layers 2 focus=L1",
        "L1 modal cover=100%",
        '  dialog "提示"',
        '    @e1 textbox "密码" [filled] ="•••"',
        '    @e2 button "确认"',
        "L2 page … occluded by L1 (~2 nodes, not actionable)",
      ].join("\n"),
    );
    expect(out.text).not.toContain("底层按钮");
    expect(coreRefs(out.refs)).toEqual([
      { ref: "e1", backendNodeId: 4 },
      { ref: "e2", backendNodeId: 5 },
    ]);
  });

  it("renders iframe descendants inside the top layer through parentId without iframe-specific renderer code", () => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          role: "RootWebArea",
          name: "JD",
          tag: "body",
          rect: { x: 0, y: 0, w: 1000, h: 3000 },
        }),
        node({
          id: 2,
          parentId: 1,
          tag: "div",
          rect: { x: 0, y: 0, w: 1280, h: 720 },
          paintOrder: 50,
          position: "fixed",
        }),
        node({
          id: 3,
          parentId: 2,
          role: "Iframe",
          name: "登录框",
          tag: "iframe",
          rect: { x: 100, y: 240, w: 800, h: 400 },
          paintOrder: 51,
        }),
        node({ id: 101, parentId: 3, role: "textbox", name: "请输入手机号", tag: "input" }),
        node({
          id: 102,
          parentId: 3,
          role: "textbox",
          name: "密码",
          value: "secret",
          tag: "input",
          sensitive: true,
        }),
      ]),
    );

    expect(out.text).toContain("L1 modal cover=100%");
    expect(out.text).toContain('  Iframe "登录框"');
    expect(out.text).toContain('    @e1 textbox "请输入手机号" [empty]');
    expect(out.text).toContain('    @e2 textbox "密码" [filled] ="•••"');
    expect(out.refs.map((r) => r.backendNodeId)).toEqual([101, 102]);
  });

  it("redacts form values and returns semantic metadata for rendered refs", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Form" }),
        node({
          id: 2,
          backendNodeId: 42,
          frameId: "child-frame",
          parentId: 1,
          role: "textbox",
          name: "Email",
          value: "user@example.com",
          inputState: "filled",
          tag: "input",
        }),
      ]),
      { redactValues: true },
    );

    expect(out.text).toContain('[filled] ="•••"');
    expect(out.text).not.toContain("user@example.com");
    expect(out.refs[0]).toMatchObject({
      ref: "e1",
      backendNodeId: 42,
      frameId: "child-frame",
      role: "textbox",
      name: "Email",
      line: expect.any(Number),
    });
    expect(out.text.split("\n")[out.refs[0]?.line ?? -1]).toContain('@e1 textbox "Email"');
  });
});

describe("disabled form state", () => {
  it("exposes disabled state independently of checkbox state and submitted value", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Form" }),
        node({ id: 2, parentId: 1, role: "button", name: "Save", disabled: true }),
        node({
          id: 3,
          parentId: 1,
          role: "checkbox",
          name: "Terms",
          disabled: true,
          checked: false,
          value: "payload",
        }),
        node({ id: 4, parentId: 1, role: "button", name: "Cancel" }),
      ]),
    );
    expect(out.text).toContain('button "Save" [disabled]');
    expect(out.text).toContain('checkbox "Terms" [disabled] [unchecked] ="payload"');
    expect(out.text).not.toContain('button "Cancel" [disabled]');
  });
});

describe("drag affordances", () => {
  it.each([
    "",
    "true",
    "plaintext-only",
  ])("preserves contenteditable=%s semantics on draggable cards", (contenteditable) => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          backendNodeId: 42,
          role: "group",
          attrs: { contenteditable, draggable: "true", "aria-label": "Message editor" },
          value: "Draft message",
          rect: { x: 0, y: 0, w: 200, h: 80 },
        }),
      ]),
    );
    expect(out.text).toContain(
      '@e1 textbox [draggable] "Message editor" [filled] ="Draft message"',
    );
    expect(out.refs).toEqual([
      expect.objectContaining({ backendNodeId: 42, role: "textbox", name: "Message editor" }),
    ]);
  });
  it.each<Partial<VomNode> & { hint: string }>([
    { attrs: { draggable: "true" }, hint: "draggable" },
    { attrs: { ondrop: "accept(event)" }, hint: "drop-target" },
    { cursor: "grab", hint: "drag-handle" },
  ])("recovers clickable semantics alongside $hint", ({ hint, attrs, ...props }) => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          role: "group",
          text: "Open settings",
          attrs: { onclick: "handleOpen()", ...attrs },
          ...props,
        }),
      ]),
    );
    expect(out.text).toContain(`@e1 button [${hint}] "Open settings"`);
    expect(out.refs).toEqual([
      expect.objectContaining({ backendNodeId: 1, role: "button", name: "Open settings" }),
    ]);
  });
  it("preserves native roles and state when adding a drag hint", () => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          tag: "input",
          role: "checkbox",
          name: "Select card",
          checked: true,
          value: "card-1",
          attrs: { draggable: "true", onclick: "selectCard()" },
        }),
      ]),
    );
    expect(out.text).toContain('@e1 checkbox [draggable] "Select card" [checked] ="card-1"');
    expect(out.refs[0].role).toBe("checkbox");
  });
  it.each(["combobox", "switch"])("recovers an explicit %s role on a draggable card", (role) => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          role: "group",
          attrs: { draggable: "true", role, tabindex: "0", "aria-label": "Card setting" },
        }),
      ]),
    );
    expect(out.text).toContain(`@e1 ${role} [draggable] "Card setting"`);
    expect(out.refs[0].role).toBe(role);
  });
  it("keeps clickable children when their inherited drag hint is suppressed", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "generic", name: "Card", cursor: "grab" }),
        node({
          id: 2,
          parentId: 1,
          role: "generic",
          text: "Edit card",
          clickable: true,
          cursor: "grab",
        }),
      ]),
    );
    expect(out.text).toContain('@e1 generic [drag-handle] "Card"');
    expect(out.text).toContain('@e2 button "Edit card"');
    expect(coreRefs(out.refs)).toEqual([
      { ref: "e1", backendNodeId: 1 },
      { ref: "e2", backendNodeId: 2 },
    ]);
  });
  it.each<Partial<VomNode> & { hint: string }>([
    { attrs: { draggable: "true" }, hint: "draggable" },
    { cursor: "grab", hint: "drag-handle" },
    { cursor: "col-resize", hint: "drag-handle" },
    { attrs: { ondrop: "accept(event)" }, hint: "drop-target" },
  ])("keeps an addressable drag candidate without inventing a button: %j", ({ hint, ...props }) => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          backendNodeId: 42,
          role: "generic",
          name: "Item",
          rect: { x: 0, y: 0, w: 100, h: 50 },
          ...props,
        }),
      ]),
    );
    expect(out.refs).toHaveLength(1);
    expect(out.text).toContain(`[${hint}]`);
    expect(out.text).not.toContain("button");
  });
  it.each([
    { attrs: { draggable: "false" } },
    { cursor: "default" },
    { cursor: "grab", inert: true },
    { cursor: "grab", pointerEvents: "none" },
  ])("does not manufacture drag refs from %j", (props) => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          backendNodeId: 42,
          role: "generic",
          rect: { x: 0, y: 0, w: 100, h: 50 },
          ...props,
        }),
      ]),
    );
    expect(out.refs).toHaveLength(0);
  });
});

it("does not turn inherited drag cursors into duplicate handles", () => {
  const out = renderVom(
    scene([
      node({
        id: 1,
        backendNodeId: 10,
        role: "generic",
        name: "Card",
        cursor: "grab",
        rect: { x: 0, y: 0, w: 100, h: 80 },
      }),
      node({
        id: 2,
        parentId: 1,
        backendNodeId: 20,
        role: "generic",
        name: "Title",
        cursor: "grab",
        rect: { x: 0, y: 0, w: 100, h: 20 },
      }),
      node({
        id: 3,
        parentId: 1,
        backendNodeId: 30,
        role: "generic",
        name: "Resize",
        cursor: "ew-resize",
        rect: { x: 90, y: 20, w: 10, h: 60 },
      }),
    ]),
  );
  expect(out.refs.map((ref) => ref.backendNodeId)).toEqual([10, 30]);
  expect(out.text).not.toContain('[drag-handle] "Title"');
});

describe("selection evidence", () => {
  it.each([
    [{ "aria-selected": "true" }, "selected"],
    [{ "aria-selected": "false", class: "selected" }, "unselected"],
    [{ "data-selected": "true" }, "selected:data"],
    [{ "data-state": "selected" }, "selected:data"],
    [{ "data-selected": "false", class: "selected" }, "unselected:data"],
    [{ class: "grid-item selected" }, "selected:class"],
    [{ class: "is-selected" }, "selected:class"],
  ])("exposes %j without conflating styling and semantic state", (attrs, marker) => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          backendNodeId: 1,
          role: "button",
          name: "16:00",
          attrs: attrs as Record<string, string>,
          rect: { x: 10, y: 10, w: 50, h: 30 },
        }),
      ]),
    );
    expect(out.text).toContain(`[${marker}]`);
  });
  it.each([
    "active",
    "unselected",
    "selected-item",
    "not-selected",
  ])("does not guess selection from %s", (value) => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          backendNodeId: 1,
          role: "button",
          name: "Cell",
          attrs: { class: value },
          rect: { x: 10, y: 10, w: 50, h: 30 },
        }),
      ]),
    );
    expect(out.text).not.toContain("[selected");
  });
  it("recovers unnamed indexed clickable cells and preserves their selected styling", () => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          backendNodeId: 1,
          clickable: true,
          attrs: { "data-index": "14", class: "grid-item selected" },
          rect: { x: 10, y: 10, w: 23, h: 30 },
        }),
      ]),
    );
    expect(out.text).toContain('@e1 button "item 14" [selected:class]');
  });
  it("does not create actions or selection hints for decorative indexed wrappers", () => {
    const out = renderVom(
      scene([
        node({
          id: 1,
          backendNodeId: 1,
          role: "group",
          name: "Decoration",
          attrs: { "data-index": "14", class: "selected" },
          rect: { x: 10, y: 10, w: 23, h: 30 },
        }),
      ]),
    );
    expect(out.refs).toHaveLength(0);
    expect(out.text).not.toContain("[selected");
  });

  describe("Wave 1 Affordance-Typed VOM v2 & CJK-safe compaction", () => {
    it("binds preceding static sibling captions to bare inputs as [field: ...] without duplicating consumed captions", () => {
      const out = renderVom(
        scene([
          node({
            id: 1,
            role: "form",
            name: "准入表单",
            rect: { x: 0, y: 0, w: 600, h: 300 },
          }),
          node({
            id: 2,
            parentId: 1,
            role: "statictext",
            name: "企业全称",
            rect: { x: 10, y: 10, w: 120, h: 24 },
          }),
          node({
            id: 3,
            parentId: 1,
            backendNodeId: 103,
            tag: "input",
            role: "textbox",
            inputState: "empty",
            rect: { x: 140, y: 10, w: 240, h: 24 },
          }),
          node({
            id: 4,
            parentId: 1,
            role: "statictext",
            name: "未关联的独立说明文字必须保留",
            rect: { x: 10, y: 50, w: 280, h: 24 },
          }),
          node({
            id: 5,
            parentId: 1,
            backendNodeId: 105,
            tag: "input",
            role: "searchbox",
            nearbyText: "邻近回退标签",
            inputState: "empty",
            rect: { x: 10, y: 90, w: 240, h: 24 },
          }),
        ]),
      );
      expect(out.text).toContain('@e1 textbox [field: "企业全称"] [empty]');
      expect(out.text.match(/企业全称/g)).toHaveLength(1);
      expect(out.text).toContain("未关联的独立说明文字必须保留");
      // Preceding unclaimed sibling id=4 is bound to id=5; test nearbyText fallback on an isolated input too:
      const isolated = renderVom(
        scene([
          node({
            id: 10,
            backendNodeId: 110,
            tag: "input",
            role: "spinbutton",
            nearbyText: "重试次数上限",
            inputState: "empty",
            rect: { x: 10, y: 10, w: 120, h: 24 },
          }),
        ]),
      );
      expect(isolated.text).toContain('@e1 spinbutton [field: "重试次数上限"]');
    });

    it("folds exact parent-child statictext echoes while preserving CJK prefix/substring child text", () => {
      const out = renderVom(
        scene([
          node({
            id: 1,
            role: "region",
            name: "星云数据看板",
            rect: { x: 0, y: 0, w: 600, h: 200 },
          }),
          node({
            id: 2,
            parentId: 1,
            role: "statictext",
            name: "星云数据看板",
            rect: { x: 10, y: 10, w: 200, h: 24 },
          }),
          node({
            id: 3,
            parentId: 1,
            role: "statictext",
            name: "星云数据看板筛选器",
            rect: { x: 10, y: 40, w: 260, h: 24 },
          }),
        ]),
      );
      expect(out.text).toContain('region "星云数据看板"');
      expect(out.text).toContain("星云数据看板筛选器");
      const lines = out.text.split("\n");
      expect(lines.filter((line) => line.trim() === 'text "星云数据看板"')).toHaveLength(0);
    });

    it("inlines up to 10 native <select> options with selected marker and suppresses them when sensitive or redacted", () => {
      const options = Array.from({ length: 10 }, (_, idx) => ({
        value: idx === 1 ? "华南大区" : `r_${idx + 1}`,
        label: idx === 1 ? "华南大区" : `大区${idx + 1}`,
        ...(idx === 0 ? { selected: true } : {}),
      }));
      const normal = renderVom(
        scene([
          node({
            id: 1,
            backendNodeId: 201,
            tag: "select",
            role: "combobox",
            name: "经营大区",
            value: "r_1",
            selectOptions: options,
            selectOptionsTruncated: true,
            rect: { x: 10, y: 10, w: 180, h: 28 },
          }),
        ]),
      );
      expect(normal.text).toContain(
        '[options: r_1="大区1"* | "华南大区" | r_3="大区3" | r_4="大区4" | r_5="大区5" | r_6="大区6" | r_7="大区7" | r_8="大区8" | r_9="大区9" | r_10="大区10" | …]',
      );
      expect(normal.text).not.toContain("[custom-dropdown:");

      const redacted = renderVom(
        scene([
          node({
            id: 1,
            backendNodeId: 201,
            tag: "select",
            role: "combobox",
            name: "经营大区",
            value: "r_1",
            selectOptions: options,
            rect: { x: 10, y: 10, w: 180, h: 28 },
          }),
        ]),
        { redactValues: true },
      );
      expect(redacted.text).not.toContain("[options:");

      const sensitiveSelect = renderVom(
        scene([
          node({
            id: 1,
            backendNodeId: 202,
            tag: "select",
            role: "combobox",
            name: "安全密保问题",
            sensitive: true,
            selectOptions: options,
            rect: { x: 10, y: 10, w: 180, h: 28 },
          }),
        ]),
      );
      expect(sensitiveSelect.text).not.toContain("[options:");
    });

    it("annotates non-editable non-<select> ARIA comboboxes with [custom-dropdown: ...] while skipping editable search/autocomplete inputs", () => {
      const out = renderVom(
        scene([
          node({
            id: 1,
            backendNodeId: 301,
            tag: "div",
            role: "combobox",
            name: "结算账期方案",
            attrs: { "aria-expanded": "false" },
            rect: { x: 10, y: 10, w: 180, h: 28 },
          }),
          node({
            id: 2,
            backendNodeId: 302,
            tag: "div",
            role: "combobox",
            name: "开票类型",
            attrs: { "aria-expanded": "true" },
            rect: { x: 10, y: 50, w: 180, h: 28 },
          }),
          // YouTube-style editable search input with role="combobox"
          node({
            id: 3,
            backendNodeId: 303,
            tag: "input",
            role: "combobox",
            name: "Search",
            attrs: { type: "text", name: "search_query" },
            rect: { x: 10, y: 90, w: 240, h: 28 },
          }),
          // Non-input combobox with aria-autocomplete="list"
          node({
            id: 4,
            backendNodeId: 304,
            tag: "div",
            role: "combobox",
            name: "命令面板",
            attrs: { "aria-autocomplete": "list" },
            rect: { x: 10, y: 130, w: 240, h: 28 },
          }),
          // Element Plus readonly <input role="combobox"> select trigger
          node({
            id: 5,
            backendNodeId: 305,
            tag: "input",
            role: "combobox",
            name: "币种",
            attrs: { type: "text", readonly: "" },
            rect: { x: 10, y: 170, w: 160, h: 28 },
          }),
        ]),
      );
      expect(out.text).toContain('@e1 combobox "结算账期方案" [custom-dropdown: click to open]');
      expect(out.text).toContain('@e2 combobox "开票类型" [custom-dropdown: expanded]');
      expect(out.text).toContain('@e3 combobox "Search"');
      expect(out.text).not.toContain('@e3 combobox "Search" [custom-dropdown:');
      expect(out.text).not.toContain('@e4 combobox "命令面板" [custom-dropdown:');
      expect(out.text).toContain('@e5 combobox "币种" [custom-dropdown: click to open]');
    });

    it("does not misbind inline units ([input] 'kg' [input2]) or validation errors ([input] '邮箱格式不正确' [input2]) as [field: ...], and caps overlong option labels", () => {
      const unitAndErrorForm = renderVom(
        scene([
          node({ id: 1, role: "form", rect: { x: 0, y: 0, w: 600, h: 200 } }),
          node({
            id: 2,
            parentId: 1,
            backendNodeId: 502,
            tag: "input",
            role: "textbox",
            inputState: "empty",
            rect: { x: 10, y: 10, w: 80, h: 28 },
          }),
          node({
            id: 3,
            parentId: 1,
            role: "statictext",
            name: "kg",
            rect: { x: 96, y: 14, w: 24, h: 20 },
          }),
          node({
            id: 4,
            parentId: 1,
            backendNodeId: 504,
            tag: "input",
            role: "textbox",
            inputState: "empty",
            rect: { x: 130, y: 10, w: 80, h: 28 },
          }),
          node({
            id: 5,
            parentId: 1,
            backendNodeId: 505,
            tag: "input",
            role: "textbox",
            name: "联系邮箱",
            inputState: "filled",
            value: "bad@",
            rect: { x: 10, y: 50, w: 200, h: 28 },
          }),
          node({
            id: 6,
            parentId: 1,
            role: "statictext",
            name: "邮箱格式不正确",
            rect: { x: 220, y: 54, w: 120, h: 20 },
          }),
          node({
            id: 7,
            parentId: 1,
            backendNodeId: 507,
            tag: "input",
            role: "textbox",
            inputState: "empty",
            rect: { x: 10, y: 95, w: 200, h: 28 },
          }),
          node({
            id: 8,
            parentId: 1,
            backendNodeId: 508,
            tag: "select",
            role: "combobox",
            name: "条款",
            selectOptions: [{ value: "clause_1", label: "甲".repeat(70), selected: true }],
            rect: { x: 10, y: 140, w: 260, h: 28 },
          }),
        ]),
      );
      expect(unitAndErrorForm.text).not.toContain('[field: "kg"]');
      expect(unitAndErrorForm.text).toContain("kg");
      expect(unitAndErrorForm.text).not.toContain('[field: "邮箱格式不正确"]');
      expect(unitAndErrorForm.text).toContain("邮箱格式不正确");
      expect(unitAndErrorForm.text).toContain(`[options: clause_1="${"甲".repeat(48)}…"*]`);
    });

    it("keeps 1-2 row tables and interactive rows expanded, and folds >= 3 consecutive pure read-only rows", () => {
      const shortTable = renderVom(
        scene([
          node({ id: 1, role: "table", rect: { x: 0, y: 0, w: 400, h: 100 } }),
          node({ id: 2, parentId: 1, role: "row", rect: { x: 0, y: 0, w: 400, h: 30 } }),
          node({
            id: 3,
            parentId: 2,
            role: "columnheader",
            name: "键",
            rect: { x: 0, y: 0, w: 200, h: 30 },
          }),
          node({
            id: 4,
            parentId: 2,
            role: "columnheader",
            name: "值",
            rect: { x: 200, y: 0, w: 200, h: 30 },
          }),
          node({ id: 5, parentId: 1, role: "row", rect: { x: 0, y: 30, w: 400, h: 30 } }),
          node({
            id: 6,
            parentId: 5,
            role: "cell",
            name: "状态",
            rect: { x: 0, y: 30, w: 200, h: 30 },
          }),
          node({
            id: 7,
            parentId: 5,
            role: "cell",
            name: "正常",
            rect: { x: 200, y: 30, w: 200, h: 30 },
          }),
        ]),
      );
      expect(shortTable.text).toContain('columnheader "键"');
      expect(shortTable.text).not.toContain('row "键 | 值"');

      const longMixedTable = renderVom(
        scene([
          node({ id: 1, role: "table", rect: { x: 0, y: 0, w: 500, h: 200 } }),
          node({ id: 2, parentId: 1, role: "rowgroup", rect: { x: 0, y: 0, w: 500, h: 40 } }),
          node({ id: 3, parentId: 2, role: "row", rect: { x: 0, y: 0, w: 500, h: 40 } }),
          node({
            id: 4,
            parentId: 3,
            role: "columnheader",
            name: "编号",
            rect: { x: 0, y: 0, w: 200, h: 40 },
          }),
          node({
            id: 5,
            parentId: 3,
            role: "columnheader",
            name: "等级",
            rect: { x: 200, y: 0, w: 300, h: 40 },
          }),
          node({ id: 6, parentId: 1, role: "rowgroup", rect: { x: 0, y: 40, w: 500, h: 160 } }),
          node({ id: 7, parentId: 6, role: "row", rect: { x: 0, y: 40, w: 500, h: 40 } }),
          node({
            id: 8,
            parentId: 7,
            role: "cell",
            name: "CHK-01",
            rect: { x: 0, y: 40, w: 200, h: 40 },
          }),
          node({
            id: 9,
            parentId: 7,
            role: "cell",
            name: "常规",
            rect: { x: 200, y: 40, w: 300, h: 40 },
          }),
          node({ id: 10, parentId: 6, role: "row", rect: { x: 0, y: 80, w: 500, h: 40 } }),
          node({
            id: 11,
            parentId: 10,
            role: "cell",
            name: "CHK-02",
            rect: { x: 0, y: 80, w: 200, h: 40 },
          }),
          node({
            id: 12,
            parentId: 10,
            role: "cell",
            name: "提示",
            rect: { x: 200, y: 80, w: 300, h: 40 },
          }),
          node({ id: 13, parentId: 6, role: "row", rect: { x: 0, y: 120, w: 500, h: 40 } }),
          node({
            id: 14,
            parentId: 13,
            role: "cell",
            name: "CHK-03",
            rect: { x: 0, y: 120, w: 200, h: 40 },
          }),
          node({ id: 15, parentId: 13, role: "cell", rect: { x: 200, y: 120, w: 300, h: 40 } }),
          node({
            id: 16,
            parentId: 15,
            backendNodeId: 416,
            tag: "button",
            role: "button",
            name: "复核",
            rowAnchor: "CHK-03",
            rect: { x: 210, y: 125, w: 80, h: 28 },
          }),
        ]),
      );
      expect(longMixedTable.text).toContain('row "编号 | 等级"');
      expect(longMixedTable.text).toContain('row "CHK-01 | 常规"');
      expect(longMixedTable.text).toContain('row "CHK-02 | 提示"');
      expect(longMixedTable.text).toContain('@e1 button "复核"');
      expect(longMixedTable.refs[0]).toMatchObject({
        ref: "e1",
        backendNodeId: 416,
        rowAnchor: "CHK-03",
      });
    });

    it("folds >= 3 pure read-only rows when rowgroups carry descendant-derived names while preserving explicit aria-labels", () => {
      const chromeAxTable = renderVom(
        scene([
          node({ id: 1, parentId: null, role: "RootWebArea", name: "Page" }),
          node({
            id: 2,
            parentId: 1,
            tag: "table",
            role: "table",
            name: "检查项编号 审计等级 CHK-101 常规 CHK-102 提示",
            rect: { x: 0, y: 0, w: 500, h: 120 },
          }),
          node({
            id: 3,
            parentId: 2,
            tag: "thead",
            role: "rowgroup",
            name: "检查项编号 审计等级",
            rect: { x: 0, y: 0, w: 500, h: 40 },
          }),
          node({ id: 4, parentId: 3, role: "row", rect: { x: 0, y: 0, w: 500, h: 40 } }),
          node({
            id: 5,
            parentId: 4,
            role: "columnheader",
            name: "检查项编号",
            rect: { x: 0, y: 0, w: 200, h: 40 },
          }),
          node({
            id: 6,
            parentId: 4,
            role: "columnheader",
            name: "审计等级",
            rect: { x: 200, y: 0, w: 300, h: 40 },
          }),
          node({
            id: 7,
            parentId: 2,
            tag: "tbody",
            role: "rowgroup",
            name: "CHK-101 常规 CHK-102 提示",
            rect: { x: 0, y: 40, w: 500, h: 80 },
          }),
          node({ id: 8, parentId: 7, role: "row", rect: { x: 0, y: 40, w: 500, h: 40 } }),
          node({
            id: 9,
            parentId: 8,
            role: "cell",
            name: "CHK-101",
            rect: { x: 0, y: 40, w: 200, h: 40 },
          }),
          node({
            id: 10,
            parentId: 8,
            role: "cell",
            name: "常规",
            rect: { x: 200, y: 40, w: 300, h: 40 },
          }),
          node({ id: 11, parentId: 7, role: "row", rect: { x: 0, y: 80, w: 500, h: 40 } }),
          node({
            id: 12,
            parentId: 11,
            role: "cell",
            name: "CHK-102",
            rect: { x: 0, y: 80, w: 200, h: 40 },
          }),
          node({
            id: 13,
            parentId: 11,
            role: "cell",
            name: "提示",
            rect: { x: 200, y: 80, w: 300, h: 40 },
          }),
        ]),
      );
      expect(chromeAxTable.text).toContain("    table\n");
      expect(chromeAxTable.text).not.toContain("rowgroup");
      expect(chromeAxTable.text).toContain('      row "检查项编号 | 审计等级"');
      expect(chromeAxTable.text).toContain('      row "CHK-101 | 常规"');
      expect(chromeAxTable.text).toContain('      row "CHK-102 | 提示"');
    });
  });
});
