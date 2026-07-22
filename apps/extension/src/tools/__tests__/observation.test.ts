import { renderVom } from "@browser-skill/vom";
import { describe, expect, it, vi } from "vitest";
import { OVERLAY_HOST_MARKER_ATTR, OVERLAY_HOST_NAME } from "@/lib/overlay-bridge";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import {
  buildVomScene,
  type CdpAxNode,
  handleGetHtml,
  handleScreenshot,
  handleSnapshot,
  parsePngDimensions,
  type ScreenshotDeps,
  stripDataUrlPrefix,
} from "../observation";
import type { CapturedNode, CapturedViewModel } from "../vom/capture";

function fakeAgentWindow(ids: number[]) {
  let i = 0;
  return {
    create: vi.fn(async () => {
      const id = ids[i++];
      if (id === undefined) throw new Error("ran out of fake ids");
      return id;
    }),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => {}),
  };
}

// 1x1 transparent PNG, base64-encoded. Width 1, height 1.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";

function makeScreenshotDeps(
  opts: {
    cdp?: CdpRunner;
    get?: ScreenshotDeps["tabsApi"]["get"];
    query?: ScreenshotDeps["tabsApi"]["query"];
    captureVisibleTab?: ScreenshotDeps["captureApi"]["captureVisibleTab"];
  } = {},
): ScreenshotDeps {
  const get =
    opts.get ??
    vi.fn(async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab);
  const query =
    opts.query ?? vi.fn(async () => [{ id: 7, windowId: 100, active: true } as chrome.tabs.Tab]);
  const captureVisibleTab =
    opts.captureVisibleTab ?? vi.fn(async () => `data:image/png;base64,${TINY_PNG}`);
  const tabsApi = { get, query };
  return {
    cdp: opts.cdp,
    tabsApi,
    captureApi: { ...tabsApi, captureVisibleTab },
  };
}

function makeFakeCdp(handlers: Record<string, (params?: object) => unknown>) {
  const sent: Array<{ method: string; params?: object }> = [];
  const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
    sent.push({ method, params });
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected CDP call ${method}`);
    return handler(params);
  });
  return { cdp: { send, trackSessionTab: vi.fn() } as unknown as CdpRunner, sent };
}

describe("stripDataUrlPrefix", () => {
  it("strips well-formed image/* data URLs", () => {
    expect(stripDataUrlPrefix(`data:image/png;base64,${TINY_PNG}`)).toBe(TINY_PNG);
    expect(stripDataUrlPrefix(`data:image/jpeg;base64,abc`)).toBe("abc");
  });
  it("leaves plain base64 untouched", () => {
    expect(stripDataUrlPrefix(TINY_PNG)).toBe(TINY_PNG);
  });
});

describe("parsePngDimensions", () => {
  it("parses width/height from the IHDR chunk", () => {
    expect(parsePngDimensions(TINY_PNG)).toEqual({ width: 1, height: 1 });
  });
  it("returns null on non-PNG input", () => {
    expect(parsePngDimensions("not-a-png-payload-just-random-base64-text-zzzzzzzzz")).toBeNull();
  });
});

describe("handleScreenshot", () => {
  const emptyGet = vi.fn(async () => {
    throw new Error("tab not found");
  });

  it("captures the Agent Window's active tab when tab_id is omitted", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const capture = vi.fn(async (_w: number) => `data:image/png;base64,${TINY_PNG}`);
    const get = vi.fn();
    const query = vi.fn(async (_q: chrome.tabs.QueryInfo) => [
      { id: 7, windowId: 100, active: true } as chrome.tabs.Tab,
    ]);
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11" },
      makeScreenshotDeps({ captureVisibleTab: capture, get, query }),
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tab_id).toBe(7);
    expect(res.image_base64).toBe(TINY_PNG);
    expect(res.format).toBe("png");
    expect(res.width).toBe(1);
    expect(res.height).toBe(1);
    expect(capture).toHaveBeenCalledWith(100, { format: "png" });
    expect(get).not.toHaveBeenCalled();
  });

  it("returns not_found when Agent Window has no active tab", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11" },
      makeScreenshotDeps({
        captureVisibleTab: vi.fn(),
        get: emptyGet,
        query: vi.fn(async () => []),
      }),
    );
    expect(res).toMatchObject({ code: "not_found" });
  });

  it("captures an explicit active user tab in its real window", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const capture = vi.fn(async (_w: number) => `data:image/png;base64,${TINY_PNG}`);
    const get = vi.fn(async () => ({ id: 9, windowId: 200, active: true }) as chrome.tabs.Tab);
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11", tab_id: 9 },
      makeScreenshotDeps({ captureVisibleTab: capture, get, query: vi.fn() }),
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tab_id).toBe(9);
    expect(capture).toHaveBeenCalledWith(200, { format: "png" });
  });

  it("rejects screenshots for inactive explicit tabs", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const capture = vi.fn(async (_w: number) => `data:image/png;base64,${TINY_PNG}`);
    const get = vi.fn(async () => ({ id: 9, windowId: 100, active: false }) as chrome.tabs.Tab);
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11", tab_id: 9 },
      makeScreenshotDeps({ captureVisibleTab: capture, get, query: vi.fn() }),
    );
    expect(res).toMatchObject({
      code: "invalid_params",
      message: /not active/,
      data: { reason: "tab_not_active" },
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it("hides other sessions' Agent Window tabs", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100, 101]) });
    await sm.start("aa11");
    await sm.start("bb22");
    const capture = vi.fn(async (_w: number) => `data:image/png;base64,${TINY_PNG}`);
    const get = vi.fn(async () => ({ id: 9, windowId: 101, active: true }) as chrome.tabs.Tab);
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11", tab_id: 9 },
      makeScreenshotDeps({ captureVisibleTab: capture, get, query: vi.fn() }),
    );
    expect(res).toMatchObject({ code: "not_found" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("propagates capture errors as cdp_failed", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const capture = vi.fn(async () => {
      throw new Error("captureVisibleTab refused");
    });
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11", tab_id: 9 },
      makeScreenshotDeps({
        captureVisibleTab: capture,
        get: vi.fn(async () => ({ id: 9, windowId: 100, active: true }) as chrome.tabs.Tab),
        query: vi.fn(),
      }),
    );
    expect(res).toMatchObject({ code: "cdp_failed", message: /captureVisibleTab refused/ });
  });

  it("captures a clipped PNG when ref is given", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e5", 999, { tabId: 7 });
    const { cdp, sent } = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }),
      "Page.captureScreenshot": () => ({ data: TINY_PNG }),
    });
    const captureVisibleTab = vi.fn();
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11", ref: "@e5", tab_id: 7 },
      makeScreenshotDeps({
        cdp,
        get: vi.fn(async () => ({ id: 7, windowId: 100, active: false }) as chrome.tabs.Tab),
        query: vi.fn(),
        captureVisibleTab,
      }),
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tab_id).toBe(7);
    expect(res.image_base64).toBe(TINY_PNG);
    expect(res.width).toBe(1);
    expect(res.height).toBe(1);
    expect(captureVisibleTab).not.toHaveBeenCalled();
    const clip = (
      sent.find((c) => c.method === "Page.captureScreenshot")?.params as {
        clip?: { x: number; y: number; width: number; height: number };
      }
    )?.clip;
    expect(clip).toMatchObject({ x: 10, y: 20, width: 100, height: 40 });
  });

  it("returns not_found for unknown ref", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const { cdp } = makeFakeCdp({});
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11", ref: "@e99", tab_id: 7 },
      makeScreenshotDeps({
        cdp,
        get: vi.fn(async () => ({ id: 7, windowId: 100, active: true }) as chrome.tabs.Tab),
        query: vi.fn(),
        captureVisibleTab: vi.fn(),
      }),
    );
    expect(res).toMatchObject({ code: "not_found", data: { reason: "ref_not_found" } });
    expect(cdp.send).not.toHaveBeenCalled();
  });

  it("accepts bare eN ref form", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e5", 999, { tabId: 7 });
    const { cdp, sent } = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }),
      "Page.captureScreenshot": () => ({ data: TINY_PNG }),
    });
    const captureVisibleTab = vi.fn();
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11", ref: "e5", tab_id: 7 },
      makeScreenshotDeps({
        cdp,
        get: vi.fn(async () => ({ id: 7, windowId: 100, active: false }) as chrome.tabs.Tab),
        query: vi.fn(),
        captureVisibleTab,
      }),
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.image_base64).toBe(TINY_PNG);
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(sent.some((c) => c.method === "Page.captureScreenshot")).toBe(true);
  });

  it("returns not_found when ref belongs to another tab", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e7", 4242, { tabId: 4 });
    const { cdp } = makeFakeCdp({});
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11", tab_id: 5, ref: "@e7" },
      makeScreenshotDeps({
        cdp,
        get: vi.fn(async () => ({ id: 5, windowId: 100, active: true }) as chrome.tabs.Tab),
        query: vi.fn(),
        captureVisibleTab: vi.fn(),
      }),
    );
    expect(res).toMatchObject({ code: "not_found", data: { reason: "ref_not_found" } });
    expect(cdp.send).not.toHaveBeenCalled();
  });

  it("returns permission_denied when element has no visible box", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 7 });
    const { cdp } = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [] }),
      "DOM.getBoxModel": () => {
        throw new Error("no box");
      },
    });
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11", ref: "@e1", tab_id: 7 },
      makeScreenshotDeps({
        cdp,
        get: vi.fn(async () => ({ id: 7, windowId: 100, active: true }) as chrome.tabs.Tab),
        query: vi.fn(),
        captureVisibleTab: vi.fn(),
      }),
    );
    expect(res).toMatchObject({
      code: "permission_denied",
      message: /not visible/i,
      data: { reason: "element_not_visible" },
    });
  });

  it("propagates Page.captureScreenshot errors as cdp_failed", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e2", 888, { tabId: 7 });
    const { cdp } = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[0, 0, 50, 0, 50, 50, 0, 50]] }),
      "Page.captureScreenshot": () => {
        throw new Error("capture refused");
      },
    });
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11", ref: "@e2", tab_id: 7 },
      makeScreenshotDeps({
        cdp,
        get: vi.fn(async () => ({ id: 7, windowId: 100, active: true }) as chrome.tabs.Tab),
        query: vi.fn(),
        captureVisibleTab: vi.fn(),
      }),
    );
    expect(res).toMatchObject({ code: "cdp_failed", message: /capture refused/ });
  });
});

// ---------------------------------------------------------------------------
// buildVomScene
// ---------------------------------------------------------------------------

describe("buildVomScene", () => {
  it("joins AX semantics with captured geometry by backendDOMNodeId", () => {
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        name: { type: "computedString", value: "Example" },
        backendDOMNodeId: 100,
        childIds: ["2"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Submit" },
        backendDOMNodeId: 200,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
      nodes: [
        {
          backendNodeId: 100,
          parentBackendNodeId: null,
          tag: "body",
          attrs: {},
          rect: { x: 0, y: 0, w: 1000, h: 800 },
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
        },
        {
          backendNodeId: 200,
          parentBackendNodeId: 100,
          tag: "button",
          attrs: {},
          rect: { x: 20, y: 20, w: 120, h: 40 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
        },
      ],
    };

    expect(buildVomScene(axNodes, captured)).toEqual({
      viewport: { width: 1000, height: 800 },
      nodes: [
        {
          id: 100,
          parentId: null,
          role: "RootWebArea",
          name: "Example",
          tag: "body",
          rect: { x: 0, y: 0, w: 1000, h: 800 },
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
          modal: false,
          sensitive: false,
        },
        {
          id: 200,
          parentId: 100,
          role: "button",
          name: "Submit",
          tag: "button",
          rect: { x: 20, y: 20, w: 120, h: 40 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
          modal: false,
          sensitive: false,
        },
      ],
    });
  });

  it("uses the nearest backend AX ancestor as parentId", () => {
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 10,
        childIds: ["2"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "generic" },
        childIds: ["3"],
      },
      {
        nodeId: "3",
        parentId: "2",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Go" },
        backendDOMNodeId: 30,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 400, height: 300 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
      nodes: [
        {
          backendNodeId: 10,
          parentBackendNodeId: null,
          tag: "body",
          attrs: {},
          rect: { x: 0, y: 0, w: 400, h: 300 },
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
        },
        {
          backendNodeId: 30,
          parentBackendNodeId: null,
          tag: "button",
          attrs: {},
          rect: { x: 10, y: 10, w: 80, h: 30 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
        },
      ],
    };

    const scene = buildVomScene(axNodes, captured);

    expect(scene.nodes.map((node) => node.id)).toEqual([10, 30]);
    expect(scene.nodes.find((node) => node.id === 30)?.parentId).toBe(10);
  });

  it("maps iframe sub-document controls to VomNodes", () => {
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 10,
        childIds: ["2"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "Iframe" },
        backendDOMNodeId: 20,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 1000, height: 800 },
      nodes: [
        {
          backendNodeId: 10,
          parentBackendNodeId: null,
          tag: "body",
          attrs: {},
          rect: { x: 0, y: 0, w: 1000, h: 800 },
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
        },
        {
          backendNodeId: 20,
          parentBackendNodeId: 10,
          tag: "iframe",
          attrs: {},
          rect: { x: 100, y: 100, w: 400, h: 300 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
        },
      ],
      iframeNodes: new Map([
        [
          20,
          [
            {
              backendNodeId: 101,
              parentBackendNodeId: null,
              tag: "input",
              attrs: { type: "text", placeholder: "请输入手机号" },
              rect: { x: 0, y: 0, w: 300, h: 40 },
              paintOrder: 0,
              position: "static",
              pointerEvents: "auto",
            },
            {
              backendNodeId: 102,
              parentBackendNodeId: null,
              tag: "input",
              attrs: { type: "password", placeholder: "密码" },
              rect: { x: 0, y: 50, w: 300, h: 40 },
              paintOrder: 1,
              position: "static",
              pointerEvents: "auto",
            },
          ],
        ],
      ]),
      excludedBackendNodeIds: new Set(),
    };

    const iframeControls = buildVomScene(axNodes, captured).nodes.filter((node) =>
      [101, 102].includes(node.id),
    );

    expect(iframeControls).toEqual([
      expect.objectContaining({
        id: 101,
        parentId: 20,
        role: "textbox",
        name: "请输入手机号",
        sensitive: false,
      }),
      expect.objectContaining({
        id: 102,
        parentId: 20,
        role: "textbox",
        name: "密码",
        sensitive: true,
      }),
    ]);
  });

  it("keeps unnamed iframe controls but skips unnamed iframe links", () => {
    const scene = buildVomScene(
      [
        {
          nodeId: "1",
          role: { type: "role", value: "RootWebArea" },
          backendDOMNodeId: 10,
          childIds: ["2"],
        },
        {
          nodeId: "2",
          parentId: "1",
          role: { type: "role", value: "Iframe" },
          backendDOMNodeId: 20,
        },
      ],
      {
        viewport: { width: 1000, height: 800 },
        nodes: [
          {
            backendNodeId: 10,
            parentBackendNodeId: null,
            tag: "body",
            attrs: {},
            rect: { x: 0, y: 0, w: 1000, h: 800 },
            paintOrder: 0,
            position: "static",
            pointerEvents: "auto",
          },
          {
            backendNodeId: 20,
            parentBackendNodeId: 10,
            tag: "iframe",
            attrs: {},
            rect: { x: 100, y: 100, w: 400, h: 300 },
            paintOrder: 1,
            position: "static",
            pointerEvents: "auto",
          },
        ],
        iframeNodes: new Map([
          [
            20,
            [
              {
                backendNodeId: 201,
                parentBackendNodeId: null,
                tag: "button",
                attrs: {},
                rect: { x: 0, y: 0, w: 80, h: 30 },
                paintOrder: 0,
                position: "static",
                pointerEvents: "auto",
              },
              {
                backendNodeId: 202,
                parentBackendNodeId: null,
                tag: "a",
                attrs: {},
                rect: { x: 0, y: 40, w: 80, h: 30 },
                paintOrder: 1,
                position: "static",
                pointerEvents: "auto",
              },
            ],
          ],
        ]),
        excludedBackendNodeIds: new Set(),
      },
    );

    expect(scene.nodes.find((node) => node.id === 201)).toEqual(
      expect.objectContaining({
        id: 201,
        parentId: 20,
        role: "button",
      }),
    );
    expect(scene.nodes.find((node) => node.id === 201)).not.toHaveProperty("name");
    expect(scene.nodes.find((node) => node.id === 202)).toBeUndefined();
  });

  it("preserves captured-only iframe anchors for iframe sub-document controls", () => {
    const scene = buildVomScene(
      [
        {
          nodeId: "1",
          role: { type: "role", value: "RootWebArea" },
          name: { type: "computedString", value: "Checkout" },
          backendDOMNodeId: 10,
        },
      ],
      {
        viewport: { width: 1000, height: 800 },
        nodes: [
          {
            backendNodeId: 10,
            parentBackendNodeId: null,
            tag: "body",
            attrs: {},
            rect: { x: 0, y: 0, w: 1000, h: 800 },
            paintOrder: 0,
            position: "static",
            pointerEvents: "auto",
          },
          {
            backendNodeId: 20,
            parentBackendNodeId: 10,
            tag: "iframe",
            attrs: { title: "支付验证" },
            rect: { x: 100, y: 100, w: 400, h: 300 },
            paintOrder: 1,
            position: "static",
            pointerEvents: "auto",
          },
        ],
        iframeNodes: new Map<number, CapturedNode[]>([
          [
            20,
            [
              {
                backendNodeId: 201,
                parentBackendNodeId: null,
                tag: "button",
                attrs: { "aria-label": "继续" },
                rect: { x: 0, y: 0, w: 80, h: 30 },
                paintOrder: 0,
                position: "static",
                pointerEvents: "auto",
              },
              {
                backendNodeId: 202,
                parentBackendNodeId: null,
                tag: "input",
                attrs: { type: "text", placeholder: "验证码" },
                rect: { x: 0, y: 40, w: 160, h: 30 },
                paintOrder: 1,
                position: "static",
                pointerEvents: "auto",
              },
            ],
          ],
        ]),
        excludedBackendNodeIds: new Set(),
      },
    );

    expect(scene.nodes.find((node) => node.id === 20)).toEqual(
      expect.objectContaining({
        id: 20,
        parentId: 10,
        role: "Iframe",
        name: "支付验证",
      }),
    );

    const rendered = renderVom(scene).text;
    expect(rendered).toContain('    Iframe "支付验证"');
    expect(rendered).toContain('      @e1 button "继续"');
    expect(rendered).toContain('      @e2 textbox "验证码"');
  });

  it("does not mark non-password inputs sensitive from password-like labels", () => {
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Password recovery email" },
        backendDOMNodeId: 10,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 320, height: 240 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
      nodes: [
        {
          backendNodeId: 10,
          parentBackendNodeId: null,
          tag: "input",
          attrs: {
            type: "text",
            name: "password_hint",
            placeholder: "Enter password recovery email",
            autocomplete: "current-password",
          },
          rect: { x: 10, y: 10, w: 200, h: 30 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
        },
      ],
    };

    expect(buildVomScene(axNodes, captured).nodes[0]).toEqual(
      expect.objectContaining({
        id: 10,
        sensitive: false,
      }),
    );
  });

  it("prefers an empty field's placeholder over a label-polluted AX name", () => {
    // Mirrors xiaohongshu: the <input> is wrapped in a <label> that also holds
    // a "+86" prefix, so the AX accessible name becomes "+86" and the real
    // placeholder ("输入手机号") is lost. VOM models perceived state — the empty
    // field shows its placeholder — so the placeholder wins.
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "+86" },
        backendDOMNodeId: 10,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
      nodes: [
        {
          backendNodeId: 10,
          parentBackendNodeId: null,
          tag: "input",
          attrs: { type: "text", placeholder: "输入手机号" },
          rect: { x: 0, y: 0, w: 240, h: 48 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
          cursor: "text",
        },
      ],
    };

    expect(buildVomScene(axNodes, captured).nodes[0]).toEqual(
      expect.objectContaining({ id: 10, role: "textbox", name: "输入手机号" }),
    );
  });

  it("keeps the accessible name for a filled field and lets the value carry the input", () => {
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Email" },
        value: { value: "a@b.com" },
        backendDOMNodeId: 10,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
      nodes: [
        {
          backendNodeId: 10,
          parentBackendNodeId: null,
          tag: "input",
          attrs: { type: "text", placeholder: "you@example.com" },
          rect: { x: 0, y: 0, w: 240, h: 48 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
          cursor: "text",
        },
      ],
    };

    expect(buildVomScene(axNodes, captured).nodes[0]).toEqual(
      expect.objectContaining({ id: 10, role: "textbox", name: "Email", value: "a@b.com" }),
    );
  });

  it("promotes a cursor:pointer icon control to a button named from its <use> sprite", () => {
    // A close button built as <div class=close-button><svg><use href="#close"/></svg></div>
    // — the AX tree exposes it as `generic` with no name, so it would be dropped.
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 10,
        childIds: ["2"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "generic" },
        backendDOMNodeId: 20,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
      nodes: [
        {
          backendNodeId: 10,
          parentBackendNodeId: null,
          tag: "body",
          attrs: {},
          rect: { x: 0, y: 0, w: 1000, h: 800 },
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
          cursor: "auto",
        },
        {
          backendNodeId: 20,
          parentBackendNodeId: 10,
          tag: "div",
          attrs: { class: "close-button" },
          rect: { x: 940, y: 20, w: 40, h: 40 },
          paintOrder: 5,
          position: "absolute",
          pointerEvents: "auto",
          cursor: "pointer",
        },
        {
          backendNodeId: 21,
          parentBackendNodeId: 20,
          tag: "svg",
          attrs: {},
          rect: { x: 945, y: 25, w: 20, h: 20 },
          paintOrder: 6,
          position: "static",
          pointerEvents: "auto",
          cursor: "pointer",
        },
        {
          backendNodeId: 22,
          parentBackendNodeId: 21,
          tag: "use",
          attrs: { "xlink:href": "#close" },
          rect: null,
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
          cursor: "auto",
        },
      ],
    };

    const node = buildVomScene(axNodes, captured).nodes.find((n) => n.id === 20);
    expect(node).toEqual(expect.objectContaining({ id: 20, role: "button", name: "close" }));
  });

  it("does not promote a clickable container that wraps a real interactive control", () => {
    // A clickable card wrapping a real link — the card must stay a container so
    // the inner link keeps its own ref instead of being collapsed.
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 10,
        childIds: ["2"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "generic" },
        backendDOMNodeId: 20,
        childIds: ["3"],
      },
      {
        nodeId: "3",
        parentId: "2",
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "Open note" },
        backendDOMNodeId: 30,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
      nodes: [
        {
          backendNodeId: 10,
          parentBackendNodeId: null,
          tag: "body",
          attrs: {},
          rect: { x: 0, y: 0, w: 1000, h: 800 },
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
          cursor: "auto",
        },
        {
          backendNodeId: 20,
          parentBackendNodeId: 10,
          tag: "div",
          attrs: { class: "card" },
          rect: { x: 0, y: 0, w: 300, h: 200 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
          cursor: "pointer",
        },
        {
          backendNodeId: 30,
          parentBackendNodeId: 20,
          tag: "a",
          attrs: {},
          rect: { x: 0, y: 0, w: 300, h: 200 },
          paintOrder: 2,
          position: "static",
          pointerEvents: "auto",
          cursor: "pointer",
        },
      ],
    };

    const scene = buildVomScene(axNodes, captured);
    expect(scene.nodes.find((n) => n.id === 20)?.role).toBe("generic");
    expect(scene.nodes.find((n) => n.id === 30)?.role).toBe("link");
  });

  it("promotes only the outermost clickable in a nested pointer chain", () => {
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 10,
        childIds: ["2"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "generic" },
        backendDOMNodeId: 20,
        childIds: ["3"],
      },
      {
        nodeId: "3",
        parentId: "2",
        role: { type: "role", value: "generic" },
        backendDOMNodeId: 30,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
      nodes: [
        {
          backendNodeId: 10,
          parentBackendNodeId: null,
          tag: "body",
          attrs: {},
          rect: { x: 0, y: 0, w: 1000, h: 800 },
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
          cursor: "auto",
        },
        {
          backendNodeId: 20,
          parentBackendNodeId: 10,
          tag: "span",
          attrs: { "aria-label": "收藏" },
          rect: { x: 10, y: 10, w: 60, h: 30 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
          cursor: "pointer",
        },
        {
          backendNodeId: 30,
          parentBackendNodeId: 20,
          tag: "span",
          attrs: {},
          rect: { x: 12, y: 12, w: 24, h: 24 },
          paintOrder: 2,
          position: "static",
          pointerEvents: "auto",
          cursor: "pointer",
        },
      ],
    };

    const scene = buildVomScene(axNodes, captured);
    expect(scene.nodes.find((n) => n.id === 20)).toEqual(
      expect.objectContaining({ id: 20, role: "button", name: "收藏" }),
    );
    // Inner clickable must NOT also become a button.
    expect(scene.nodes.find((n) => n.id === 30)?.role).not.toBe("button");
  });

  it("marks captured dialog elements as modal without AX role or aria-modal", () => {
    const scene = buildVomScene([], {
      viewport: { width: 640, height: 480 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
      nodes: [
        {
          backendNodeId: 50,
          parentBackendNodeId: null,
          tag: "dialog",
          attrs: {},
          rect: { x: 100, y: 100, w: 300, h: 200 },
          paintOrder: 10,
          position: "fixed",
          pointerEvents: "auto",
        },
      ],
    });

    expect(scene.nodes[0]).toEqual(
      expect.objectContaining({
        id: 50,
        modal: true,
      }),
    );
  });

  it("filters AX overlay nodes listed in excludedBackendNodeIds", () => {
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 1,
        childIds: ["2", "3"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "x", value: "Real Button" },
        backendDOMNodeId: 2,
      },
      {
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "x", value: "中断" },
        backendDOMNodeId: 202,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set([200, 201, 202]),
      nodes: [
        {
          backendNodeId: 2,
          parentBackendNodeId: 1,
          tag: "button",
          attrs: {},
          rect: { x: 10, y: 10, w: 100, h: 40 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
        },
      ],
    };

    const scene = buildVomScene(axNodes, captured);
    expect(scene.nodes.find((n) => n.id === 202)).toBeUndefined();
    expect(scene.nodes.find((n) => n.id === 2)).toEqual(
      expect.objectContaining({ role: "button", name: "Real Button" }),
    );
  });

  it("filters AX overlay descendants when an ancestor backend id is excluded", () => {
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 1,
        childIds: ["2"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "generic" },
        backendDOMNodeId: 200,
        childIds: ["3"],
      },
      {
        nodeId: "3",
        parentId: "2",
        role: { type: "role", value: "button" },
        name: { type: "x", value: "中断" },
        backendDOMNodeId: 203,
      },
    ];
    const scene = buildVomScene(axNodes, {
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set([200]),
      nodes: [],
    });
    expect(scene.nodes.find((n) => n.id === 203)).toBeUndefined();
  });
});

describe("handleSnapshot", () => {
  function makeDeps(nodes: CdpAxNode[]) {
    const sendImpl = async (_tabId: number, method: string, _params?: object) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes };
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 } };
      }
      if (method === "DOMSnapshot.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") throw new Error("snapshot unsupported");
      throw new Error(`unexpected CDP method ${method}`);
    };
    const send = vi.fn(sendImpl);
    const trackSessionTab = vi.fn();
    const cdp = {
      send: send as unknown as <T = unknown>(
        tabId: number,
        method: string,
        params?: object,
      ) => Promise<T>,
      trackSessionTab,
    };
    return {
      cdp,
      tabsApi: {
        get: vi.fn(
          async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
        ),
        query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
      },
      send,
      trackSessionTab,
    };
  }

  it("populates the session's RefStore with backendNodeIds", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    const root: CdpAxNode = {
      nodeId: "1",
      role: { type: "role", value: "RootWebArea" },
      name: { type: "computedString", value: "Example" },
      backendDOMNodeId: 100,
      childIds: ["2"],
    };
    const button: CdpAxNode = {
      nodeId: "2",
      parentId: "1",
      role: { type: "role", value: "button" },
      name: { type: "computedString", value: "Click" },
      backendDOMNodeId: 200,
    };
    const deps = makeDeps([root, button]);
    const res = await handleSnapshot(sm, { session_id: "aa11" }, deps);
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.ref_count).toBe(1);
    expect(res.tab_id).toBe(4);
    expect(res.text).toContain("@vom 1");
    expect(res.text).toContain("@layers 1 focus=L1");
    expect(res.text).toContain("L1 page");
    expect(res.text).toContain('RootWebArea "Example"');
    expect(res.text).toContain('@e1 button "Click"');
    expect(deps.trackSessionTab).toHaveBeenCalledWith("aa11", 4);
    expect(ctx.refStore.resolve("e1")).toBe(200);
    expect(ctx.refStore.resolve("e1", { tabId: 4 })).toBe(200);
    expect(ctx.refStore.resolve("e1", { tabId: 5 })).toBeNull();
    expect(ctx.refStore.resolveEntry("e1")).toMatchObject({ backendNodeId: 200, tabId: 4 });
    expect(ctx.refStore.resolve("e2")).toBeNull();
  });

  it("resets the RefStore on every fresh snapshot", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e9", 9999); // stale entry from a previous snapshot
    const deps = makeDeps([
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        name: { type: "computedString", value: "Doc" },
        backendDOMNodeId: 1,
      },
    ]);
    await handleSnapshot(sm, { session_id: "aa11" }, deps);
    expect(ctx.refStore.resolve("e9")).toBeNull();
    expect(ctx.refStore.resolve("e1")).toBeNull();
  });

  it("surfaces CDP failures as cdp_failed", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const sendImpl = async () => {
      throw new Error("debugger detached");
    };
    const send = vi.fn(sendImpl);
    const deps = {
      cdp: {
        send: send as unknown as <T = unknown>(
          tabId: number,
          method: string,
          params?: object,
        ) => Promise<T>,
      },
      tabsApi: {
        get: vi.fn(
          async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
        ),
        query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
      },
    };
    const res = await handleSnapshot(sm, { session_id: "aa11" }, deps);
    expect(res).toMatchObject({ code: "cdp_failed", message: /debugger detached/ });
  });

  function makeOverlayDeps(axNodes: CdpAxNode[], snapshotReply: unknown, metrics: unknown) {
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes: axNodes };
      if (method === "DOMSnapshot.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") return snapshotReply;
      if (method === "Page.getLayoutMetrics") return metrics;
      throw new Error(`unexpected CDP method ${method}`);
    });
    return {
      cdp: {
        send: send as unknown as <T>(t: number, m: string, p?: object) => Promise<T>,
        trackSessionTab: vi.fn(),
      },
      tabsApi: {
        get: vi.fn(
          async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
        ),
        query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
      },
      send,
    };
  }

  // Reusable: html>body>div(fixed full-screen)>input[type=password]
  function loginSnapshotReply() {
    const S = [
      "html",
      "body",
      "div",
      "input",
      "position",
      "fixed",
      "static",
      "pointer-events",
      "auto",
      "type",
      "password",
    ];
    const i = (s: string) => S.indexOf(s);
    return {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1, 2],
            nodeName: [i("html"), i("body"), i("div"), i("input")],
            backendNodeId: [10, 11, 12, 13],
            attributes: [[], [], [], [i("type"), i("password")]],
          },
          layout: {
            nodeIndex: [1, 2, 3],
            styles: [
              [i("static"), i("auto")],
              [i("fixed"), i("auto")],
              [i("static"), i("auto")],
            ],
            bounds: [
              [0, 0, 1000, 4000],
              [0, 0, 1000, 800],
              [400, 300, 200, 40],
            ],
            paintOrders: [0, 50, 51],
          },
        },
      ],
    };
  }
  const VP_METRICS = {
    cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
  };

  it("renders a blocking login overlay as the focused top layer", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const ax: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        name: { type: "x", value: "JD" },
        backendDOMNodeId: 11,
        childIds: ["2", "3"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "dialog" },
        name: { type: "x", value: "登录" },
        backendDOMNodeId: 12,
        childIds: ["4"],
      },
      {
        nodeId: "4",
        parentId: "2",
        role: { type: "role", value: "textbox" },
        name: { type: "x", value: "密码" },
        backendDOMNodeId: 13,
      },
      {
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "x", value: "底层按钮" },
        backendDOMNodeId: 999,
      },
    ];
    const res = await handleSnapshot(
      sm,
      { session_id: "aa11" },
      makeOverlayDeps(ax, loginSnapshotReply(), VP_METRICS),
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.text).toContain("@vom 1");
    expect(res.text).toContain("L1 modal cover=100%");
    expect(res.text).toContain("occluded by L1");
    // The underlying page button (backendNodeId 999) must NOT be rendered.
    expect(res.text).not.toContain("底层按钮");
    expect(res.text).toContain('dialog "登录"');
    expect(res.text).toContain('@e1 textbox "密码"');
    // AX subtree is indented under the L1 layer line.
    expect(res.text).toMatch(/\n {2}dialog "登录"/);
    // ref-store only carries interactive overlay refs, not structural nodes or the occluded page.
    expect(res.ref_count).toBe(1);
  });

  it("renders cross-origin iframe login form in L1 when AX tree has no iframe children (JD-style)", async () => {
    // Mirrors JD.com: the main frame has a fixed wrapper that contains a
    // cross-origin <iframe>. The iframe's inputs only appear in DOMSnapshot
    // documents[1], NOT in the AX tree.
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");

    // AX tree: only the main-frame nodes. The iframe (nodeId=13) has no
    // children — Chrome excludes cross-origin frame content from getFullAXTree.
    const ax: CdpAxNode[] = [
      {
        nodeId: "11",
        role: { type: "role", value: "RootWebArea" },
        name: { type: "x", value: "JD" },
        backendDOMNodeId: 11,
        childIds: ["12"],
      },
      {
        nodeId: "12",
        parentId: "11",
        role: { type: "role", value: "generic" },
        backendDOMNodeId: 12,
        childIds: ["13"],
      },
      // The iframe AX node — no children (cross-origin)
      {
        nodeId: "13",
        parentId: "12",
        role: { type: "role", value: "Iframe" },
        backendDOMNodeId: 13,
      },
    ];

    // DOMSnapshot: main frame has the wrapper + iframe element; documents[1]
    // has the login form with phone and password inputs.
    const S = [
      "html",
      "body",
      "div",
      "iframe",
      "input",
      "position",
      "fixed",
      "static",
      "pointer-events",
      "auto",
      "type",
      "text",
      "password",
      "src",
      "https://passport.jd.com/login",
      "placeholder",
      "请输入手机号",
      "密码",
    ];
    const si = (s: string) => S.indexOf(s);
    const iframeSnapshot = {
      strings: S,
      documents: [
        {
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          nodes: {
            parentIndex: [-1, 0, 1, 2],
            nodeName: [si("html"), si("body"), si("div"), si("iframe")],
            backendNodeId: [10, 11, 12, 13],
            attributes: [[], [], [], [si("src"), si("https://passport.jd.com/login")]],
            contentDocumentIndex: { index: [3], value: [1] },
          },
          layout: {
            nodeIndex: [1, 2, 3],
            styles: [
              [si("static"), si("auto")],
              [si("fixed"), si("auto")],
              [si("static"), si("auto")],
            ],
            bounds: [
              [0, 0, 1000, 4000],
              [0, 0, 1000, 800],
              [100, 400, 800, 400],
            ],
            paintOrders: [0, 50, 51],
          },
        },
        // documents[1]: cross-origin login form
        {
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          nodes: {
            parentIndex: [-1, 0, 0],
            nodeName: [si("body"), si("input"), si("input")],
            backendNodeId: [100, 101, 102],
            attributes: [
              [],
              [si("type"), si("text"), si("placeholder"), si("请输入手机号")],
              [si("type"), si("password"), si("placeholder"), si("密码")],
            ],
          },
          layout: {
            nodeIndex: [1, 2],
            styles: [
              [si("static"), si("auto")],
              [si("static"), si("auto")],
            ],
            bounds: [
              [0, 0, 300, 40],
              [0, 50, 300, 40],
            ],
            paintOrders: [0, 1],
          },
        },
      ],
    };

    const deps = makeOverlayDeps(ax, iframeSnapshot, VP_METRICS);
    const res = await handleSnapshot(sm, { session_id: "aa11" }, deps);
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);

    // Layer should be classified as modal (iframe present), not mask
    expect(res.text).toContain("L1 modal cover=100%");
    // Iframe content must appear in L1 — both inputs rendered
    expect(res.text).toMatch(/textbox "请输入手机号"/);
    expect(res.text).toMatch(/textbox "密码" ="•••"/);
    // Ref-store must include the iframe's input backendNodeIds
    const ctx = sm["sessions"].get("aa11")!;
    const phoneRef = res.text.match(/@(e\d+) textbox "请输入手机号"/)?.[1];
    const pwdRef = res.text.match(/@(e\d+) textbox "密码"/)?.[1];
    expect(phoneRef).toBeDefined();
    expect(pwdRef).toBeDefined();
    expect(ctx.refStore.resolve(phoneRef!)).toBe(101);
    expect(ctx.refStore.resolve(pwdRef!)).toBe(102);
  });

  it("preserves viewport in single-layer VOM fallback when DOMSnapshot fails", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const ax: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        name: { type: "x", value: "Doc" },
        backendDOMNodeId: 1,
        childIds: ["2"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "x", value: "Click" },
        backendDOMNodeId: 2,
      },
    ];
    const send = vi.fn(async (_t: number, method: string) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes: ax };
      if (method === "Page.getLayoutMetrics") return VP_METRICS;
      if (method === "DOMSnapshot.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") throw new Error("snapshot unsupported");
      throw new Error(`unexpected ${method}`);
    });
    const deps = {
      cdp: {
        send: send as unknown as <T>(t: number, m: string, p?: object) => Promise<T>,
        trackSessionTab: vi.fn(),
      },
      tabsApi: {
        get: vi.fn(
          async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
        ),
        query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
      },
    };
    const res = await handleSnapshot(sm, { session_id: "aa11" }, deps);
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.text).toContain("@vom 1");
    expect(res.text).toContain("@view 1000x800");
    expect(res.text).toContain("@layers 1 focus=L1");
    expect(res.text).toContain('@e1 button "Click"');
  });

  it("masks password field values inside the overlay", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const ax: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        name: { type: "x", value: "JD" },
        backendDOMNodeId: 11,
        childIds: ["2"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "dialog" },
        name: { type: "x", value: "登录" },
        backendDOMNodeId: 12,
        childIds: ["4"],
      },
      {
        nodeId: "4",
        parentId: "2",
        role: { type: "role", value: "textbox" },
        name: { type: "x", value: "密码" },
        value: { value: "hunter2" },
        backendDOMNodeId: 13,
      },
    ];
    const res = await handleSnapshot(
      sm,
      { session_id: "aa11" },
      makeOverlayDeps(ax, loginSnapshotReply(), VP_METRICS),
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.text).not.toContain("hunter2");
    expect(res.text).toContain("•••");
  });

  it("ignores the agent's own overlay so it never occludes the real page", async () => {
    // Reproduces snapshot mistaking the injected control overlay for a blocking
    // mask: DOMSnapshot inlines the overlay open shadow root (a fixed
    // full-viewport blocker + the "中断" button). After excluding that host
    // subtree at capture time, the real page is the only layer.
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const ax: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        name: { type: "x", value: "Doc" },
        backendDOMNodeId: 1,
        childIds: ["2"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "x", value: "Real Button" },
        backendDOMNodeId: 2,
      },
    ];
    const S = [
      "html",
      "body",
      "button",
      OVERLAY_HOST_NAME,
      "div",
      OVERLAY_HOST_MARKER_ATTR,
      "position",
      "fixed",
      "static",
      "pointer-events",
      "auto",
      "cursor",
      "pointer",
      "中断",
      "#text",
    ];
    const si = (s: string) => S.indexOf(s);
    const overlaySnapshot = {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1, 0, 3, 4, 5],
            nodeName: [
              si("html"),
              si("body"),
              si("button"),
              si(OVERLAY_HOST_NAME),
              si("div"),
              si("button"),
              si("#text"),
            ],
            backendNodeId: [100, 1, 2, 200, 201, 202, 203],
            attributes: [[], [], [], [si(OVERLAY_HOST_MARKER_ATTR), -1], [], [], []],
            nodeValue: [-1, -1, -1, -1, -1, -1, si("中断")],
          },
          layout: {
            nodeIndex: [0, 1, 2, 3, 4, 5],
            styles: [
              [si("static"), si("auto"), si("auto")],
              [si("static"), si("auto"), si("auto")],
              [si("static"), si("auto"), si("auto")],
              [si("static"), si("auto"), si("auto")],
              [si("fixed"), si("auto"), si("auto")],
              [si("fixed"), si("auto"), si("pointer")],
            ],
            bounds: [
              [0, 0, 1000, 4000],
              [0, 0, 1000, 800],
              [10, 10, 100, 40],
              [0, 0, 0, 0],
              [0, 0, 1000, 800],
              [400, 750, 80, 40],
            ],
            paintOrders: [0, 1, 2, 3, 9, 10],
          },
        },
      ],
    };

    const res = await handleSnapshot(
      sm,
      { session_id: "aa11" },
      makeOverlayDeps(ax, overlaySnapshot, VP_METRICS),
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    // No blocking layer: the overlay mask was dropped, so it's a plain page.
    expect(res.text).toContain("@layers 1 focus=L1");
    expect(res.text).toContain("L1 page");
    expect(res.text).not.toContain("occluded");
    expect(res.text).not.toContain("mask");
    // The real page content is visible…
    expect(res.text).toContain('@e1 button "Real Button"');
    // …and the agent's own interrupt button never leaks in.
    expect(res.text).not.toContain("中断");
  });

  it("filters overlay AX nodes when DOMSnapshot fails but DOM.describeNode finds overlay host", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const ax: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        name: { type: "x", value: "Doc" },
        backendDOMNodeId: 1,
        childIds: ["2", "3"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "x", value: "Real Button" },
        backendDOMNodeId: 2,
      },
      {
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "x", value: "中断" },
        backendDOMNodeId: 202,
      },
    ];
    const send = vi.fn(async (_t: number, method: string, params?: object) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes: ax };
      if (method === "Page.getLayoutMetrics") return VP_METRICS;
      if (method === "DOMSnapshot.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") throw new Error("snapshot unsupported");
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") {
        expect((params as { selector?: string })?.selector).toContain("data-bsk-overlay");
        return { nodeId: 99 };
      }
      if (method === "DOM.describeNode") {
        return {
          node: {
            backendNodeId: 200,
            children: [{ backendNodeId: 201, children: [{ backendNodeId: 202, children: [] }] }],
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    });
    const deps = {
      cdp: {
        send: send as unknown as <T>(t: number, m: string, p?: object) => Promise<T>,
        trackSessionTab: vi.fn(),
      },
      tabsApi: {
        get: vi.fn(
          async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
        ),
        query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
      },
    };
    const res = await handleSnapshot(sm, { session_id: "aa11" }, deps);
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.text).toContain('@e1 button "Real Button"');
    expect(res.text).not.toContain("中断");
    expect(res.ref_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// handleGetHtml
// ---------------------------------------------------------------------------

describe("handleGetHtml", () => {
  function makeDeps(handlers: Record<string, (params: unknown) => unknown>) {
    const sendImpl = async (_tabId: number, method: string, params?: object) => {
      const h = handlers[method];
      if (!h) throw new Error(`unexpected CDP call ${method}`);
      return h(params);
    };
    const send = vi.fn(sendImpl);
    const trackSessionTab = vi.fn();
    // Cast to the generic CdpRunner.send signature for handleGetHtml.
    const cdp = {
      send: send as unknown as <T = unknown>(
        tabId: number,
        method: string,
        params?: object,
      ) => Promise<T>,
      trackSessionTab,
    };
    return {
      cdp,
      tabsApi: {
        get: vi.fn(
          async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
        ),
        query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
      },
      send,
      trackSessionTab,
    };
  }

  it("fetches the document HTML when no ref is given", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const html = "<html><body>hi</body></html>";
    const deps = makeDeps({
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "DOM.getOuterHTML": () => ({ outerHTML: html }),
    });
    const res = await handleGetHtml(sm, { session_id: "aa11" }, deps);
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.html).toBe(html);
    expect(res.truncated).toBe(false);
    expect(res.byte_size).toBe(html.length); // ASCII bytes = code-units
    expect(res.tab_id).toBe(4);
    expect(deps.trackSessionTab).toHaveBeenCalledWith("aa11", 4);
    expect(deps.send).toHaveBeenCalledWith(4, "DOM.getDocument", { depth: 0 });
  });

  it("scopes to a backendNodeId when given a ref", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e7", 4242, { tabId: 4 });
    const deps = makeDeps({
      "DOM.getOuterHTML": (params) => {
        expect(params).toEqual({ backendNodeId: 4242 });
        return { outerHTML: "<button>x</button>" };
      },
    });
    const res = await handleGetHtml(sm, { session_id: "aa11", ref: "@e7" }, deps);
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.html).toBe("<button>x</button>");
    // Never called DOM.getDocument when ref is provided.
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("returns not_found when a ref belongs to another tab", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e7", 4242, { tabId: 4 });
    const deps = makeDeps({});
    const res = await handleGetHtml(sm, { session_id: "aa11", tab_id: 5, ref: "@e7" }, deps);
    expect(res).toMatchObject({ code: "not_found", data: { reason: "ref_not_found" } });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("returns not_found when ref is unknown to the session", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const res = await handleGetHtml(sm, { session_id: "aa11", ref: "e99" }, makeDeps({}));
    expect(res).toMatchObject({ code: "not_found", data: { reason: "ref_not_found" } });
  });

  it("truncates oversized HTML and reports the original byte_size", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const big = "x".repeat(10_000);
    const deps = makeDeps({
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "DOM.getOuterHTML": () => ({ outerHTML: big }),
    });
    const res = await handleGetHtml(sm, { session_id: "aa11", max_bytes: 100 }, deps);
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.truncated).toBe(true);
    expect(res.byte_size).toBe(10_000);
    expect(res.html.length).toBe(100);
  });
});
