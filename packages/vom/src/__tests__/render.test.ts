import { describe, expect, it } from "vitest";
import { renderVom } from "../render";
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

describe("renderVom single-layer page", () => {
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
    expect(out.refs).toEqual([
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
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 4 }]);
  });

  it("assigns refs to listbox controls", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Doc" }),
        node({ id: 2, parentId: 1, role: "listbox", name: "Choices" }),
      ]),
    );

    expect(out.text).toContain('    @e1 listbox "Choices"');
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 2 }]);
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
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 5 }]);
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

  it("does not imply a sensitive textbox has a value when the value is missing", () => {
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
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 4 }]);
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
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 2 }]);
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
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 3 }]);
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
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 3 }]);
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
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 2 }]);
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
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 4 }]);
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

    expect(out.text).toContain('@e1 button "Products" [→ Shoes | Bags | Accessories]');
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 2 }]);
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
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 2 }]);
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
    expect(out.refs).toEqual([{ ref: "e1", backendNodeId: 2 }]);
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

  it("adds semantic collection summaries for repeated item containers", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "Forum" }),
        node({ id: 2, parentId: 1, role: "main", name: "Posts" }),
        node({ id: 3, parentId: 2, role: "searchbox", name: "Search posts", tag: "input" }),
        node({ id: 10, parentId: 2, role: "article" }),
        node({ id: 11, parentId: 10, role: "heading", name: "First post" }),
        node({ id: 12, parentId: 10, role: "link", name: "First post", tag: "a" }),
        node({ id: 13, parentId: 10, role: "button", name: "Upvote", tag: "button" }),
        node({ id: 20, parentId: 2, role: "article" }),
        node({ id: 21, parentId: 20, role: "heading", name: "Second post" }),
        node({ id: 22, parentId: 20, role: "link", name: "Second post", tag: "a" }),
        node({ id: 23, parentId: 20, role: "button", name: "Upvote", tag: "button" }),
      ]),
      { semanticCollections: true },
    );

    expect(out.text).toContain("@collections");
    expect(out.text).toContain(
      'collection c1 role=main item_role=article label="First post" items=2',
    );
    expect(out.text).toContain('controls: search=@e1 "Search posts"');
    expect(out.text).toContain('title="First post" title_handle=@e2');
    expect(out.text).toContain('actions=[@e3 "Upvote"]');
  });

  it("does not summarize login forms as semantic collections", () => {
    const out = renderVom(
      scene([
        node({ id: 1, role: "RootWebArea", name: "北京市小客车指标调控管理信息系统" }),
        node({ id: 2, parentId: 1, role: "list" }),
        node({ id: 3, parentId: 2, role: "listitem", name: "用户登录" }),
        node({ id: 4, parentId: 2, role: "listitem", name: "手机号：" }),
        node({
          id: 5,
          parentId: 4,
          role: "textbox",
          value: "13311030827",
          tag: "input",
        }),
        node({ id: 6, parentId: 2, role: "listitem", name: "密 码：" }),
        node({
          id: 7,
          parentId: 6,
          role: "textbox",
          value: "secret",
          tag: "input",
          sensitive: true,
        }),
        node({ id: 8, parentId: 2, role: "listitem", name: "验证码：" }),
        node({ id: 9, parentId: 8, role: "textbox", value: "h8Mh", tag: "input" }),
        node({ id: 10, parentId: 2, role: "listitem" }),
        node({ id: 11, parentId: 10, role: "button", name: "登录", tag: "button" }),
      ]),
    );

    expect(out.text).not.toContain("@collections");
    expect(out.text).toContain('@e2 textbox [filled] ="•••"');
  });
});

describe("renderVom double-layer page", () => {
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
    expect(out.refs).toEqual([
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
});
