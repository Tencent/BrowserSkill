import { renderVom } from "@browser-skill/vom";
import { describe, expect, it, vi } from "vitest";
import { CAPTURE_SUPPRESS, type CaptureSuppressMessage } from "@/lib/capture-suppress-bridge";
import { OVERLAY_HOST_MARKER_ATTR, OVERLAY_HOST_NAME } from "@/lib/overlay-bridge";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import {
  buildFrameVomScene,
  buildVomScene,
  type CdpAxNode,
  captureVomObservation,
  handleGetHtml,
  handleObserve,
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
    if (!handler && method === "Page.getLayoutMetrics") {
      return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
    }
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

  it("falls back to CDP Page.captureScreenshot when captureVisibleTab fails", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const capture = vi.fn(async () => {
      throw new Error("Failed to capture tab: image readback failed");
    });
    const { cdp, sent } = makeFakeCdp({
      "Page.captureScreenshot": () => ({ data: TINY_PNG }),
    });
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11" },
      makeScreenshotDeps({ cdp, captureVisibleTab: capture }),
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tab_id).toBe(7);
    expect(res.image_base64).toBe(TINY_PNG);
    expect(res.format).toBe("png");
    expect(capture).toHaveBeenCalledTimes(1);
    const fallbackCall = sent.find((c) => c.method === "Page.captureScreenshot");
    expect(fallbackCall?.params).toEqual({ format: "png", fromSurface: true });
  });

  it("reports screenshot_capture_failed when both capture paths fail", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const capture = vi.fn(async () => {
      throw new Error("Failed to capture tab: image readback failed");
    });
    const { cdp } = makeFakeCdp({
      "Page.captureScreenshot": () => {
        throw new Error("debugger detached");
      },
    });
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11" },
      makeScreenshotDeps({ cdp, captureVisibleTab: capture }),
    );
    expect(res).toMatchObject({
      code: "cdp_failed",
      data: { reason: "screenshot_capture_failed" },
    });
    const message = (res as { message?: string }).message ?? "";
    expect(message).toContain("image readback failed");
    expect(message).toContain("debugger detached");
  });

  it("falls back to CDP when captureVisibleTab returns and CDP yields data", async () => {
    // Sanity: a successful primary path never touches CDP even when a
    // runner is available.
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const capture = vi.fn(async () => `data:image/png;base64,${TINY_PNG}`);
    const { cdp, sent } = makeFakeCdp({});
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11" },
      makeScreenshotDeps({ cdp, captureVisibleTab: capture }),
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.image_base64).toBe(TINY_PNG);
    expect(sent.find((c) => c.method === "Page.captureScreenshot")).toBeUndefined();
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

describe("handleScreenshot overlay suppression", () => {
  /**
   * Fake background→content bridge that mirrors the content script's
   * contract: `begin` hides the overlay, `end` restores it. Records the
   * phase order so tests can assert begin → capture → end.
   */
  function fakeSuppressBridge(events: string[]) {
    let overlayHidden = false;
    const sendToTab = vi.fn(async (_tabId: number, message: CaptureSuppressMessage) => {
      events.push(message.phase);
      overlayHidden = message.phase === "begin";
      return { type: CAPTURE_SUPPRESS, ok: true };
    });
    return { sendToTab, isHidden: () => overlayHidden };
  }

  it("hides the overlay around a visible-tab capture", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const events: string[] = [];
    const bridge = fakeSuppressBridge(events);
    const capture = vi.fn(async (_w: number) => {
      events.push("capture");
      // The overlay must already be hidden when the capture runs.
      expect(bridge.isHidden()).toBe(true);
      return `data:image/png;base64,${TINY_PNG}`;
    });
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11" },
      { ...makeScreenshotDeps({ captureVisibleTab: capture }), sendToTab: bridge.sendToTab },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.image_base64).toBe(TINY_PNG);
    expect(events).toEqual(["begin", "capture", "end"]);
    expect(bridge.isHidden()).toBe(false);
  });

  it("hides the overlay around a CDP element capture", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e5", 999, { tabId: 7 });
    const events: string[] = [];
    const bridge = fakeSuppressBridge(events);
    const { cdp } = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }),
      "Page.captureScreenshot": () => {
        events.push("capture");
        expect(bridge.isHidden()).toBe(true);
        return { data: TINY_PNG };
      },
    });
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11", ref: "@e5", tab_id: 7 },
      {
        ...makeScreenshotDeps({
          cdp,
          get: vi.fn(async () => ({ id: 7, windowId: 100, active: false }) as chrome.tabs.Tab),
          query: vi.fn(),
          captureVisibleTab: vi.fn(),
        }),
        sendToTab: bridge.sendToTab,
      },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.image_base64).toBe(TINY_PNG);
    expect(events).toEqual(["begin", "capture", "end"]);
    expect(bridge.isHidden()).toBe(false);
  });

  it("still captures when the tab has no content script to ack", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const sendToTab = vi.fn(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    const capture = vi.fn(async (_w: number) => `data:image/png;base64,${TINY_PNG}`);
    const res = await handleScreenshot(
      sm,
      { session_id: "aa11" },
      { ...makeScreenshotDeps({ captureVisibleTab: capture }), sendToTab },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.image_base64).toBe(TINY_PNG);
    expect(capture).toHaveBeenCalledTimes(1);
    // The failed begin must not be followed by an end.
    expect(sendToTab).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// buildVomScene
// ---------------------------------------------------------------------------

describe("buildVomScene", () => {
  it("merges multiple sibling and nested frames without mixing their targets", () => {
    const node = (
      backendNodeId: number,
      parentBackendNodeId: number | null,
      frameId: string,
      tag: string,
      attrs: Record<string, string> = {},
    ): CapturedNode => ({
      backendNodeId,
      parentBackendNodeId,
      frameId,
      tag,
      attrs,
      rect: { x: 0, y: 0, w: 100, h: 30 },
      localRect: { x: 0, y: 0, w: 100, h: 30 },
      paintOrder: 1,
      position: "static",
      pointerEvents: "auto",
    });
    const mainNodes = [
      node(1, null, "main", "body"),
      node(10, 1, "main", "iframe", { title: "First" }),
      node(20, 1, "main", "iframe", { title: "Second" }),
    ];
    const firstNodes = [
      node(100, null, "first", "body"),
      node(101, 100, "first", "button", { "aria-label": "First action" }),
    ];
    const secondNodes = [
      node(200, null, "second", "body"),
      node(201, 200, "second", "h2"),
      node(210, 200, "second", "iframe", { title: "Nested" }),
    ];
    const nestedNodes = [
      node(300, null, "nested", "body"),
      node(301, 300, "nested", "input", { placeholder: "Nested field" }),
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 1200, height: 800 },
      nodes: mainNodes,
      iframeNodes: new Map([
        [10, firstNodes],
        [20, secondNodes],
        [210, nestedNodes],
      ]),
      frameNodes: new Map([
        ["main", mainNodes],
        ["first", firstNodes],
        ["second", secondNodes],
        ["nested", nestedNodes],
      ]),
      frameOwnerBackendNodeIds: new Map([
        ["first", 10],
        ["second", 20],
        ["nested", 210],
      ]),
      rootFrameId: "main",
      excludedBackendNodeIds: new Set(),
    };
    const axNode = (
      nodeId: string,
      backendDOMNodeId: number,
      role: string,
      parentId?: string,
      name?: string,
    ): CdpAxNode => ({
      nodeId,
      backendDOMNodeId,
      role: { type: "role", value: role },
      ...(parentId ? { parentId } : {}),
      ...(name ? { name: { type: "computedString", value: name } } : {}),
    });
    const result = buildFrameVomScene(
      [
        {
          frameId: "main",
          contextScopeId: "main",
          target: { tabId: 7 },
          domNodes: mainNodes,
          axNodes: [
            axNode("root", 1, "RootWebArea"),
            axNode("frame-1", 10, "Iframe", "root", "First"),
            axNode("frame-2", 20, "Iframe", "root", "Second"),
          ],
        },
        {
          frameId: "first",
          contextScopeId: "first",
          parentFrameId: "main",
          ownerBackendNodeId: 10,
          target: { tabId: 7, sessionId: "session-first" },
          domNodes: firstNodes,
          axNodes: [
            axNode("root", 100, "RootWebArea"),
            axNode("button", 101, "button", "root", "First action"),
          ],
        },
        {
          frameId: "second",
          contextScopeId: "second",
          parentFrameId: "main",
          ownerBackendNodeId: 20,
          target: { tabId: 7, sessionId: "session-second" },
          domNodes: secondNodes,
          axNodes: [
            axNode("root", 200, "RootWebArea"),
            axNode("heading", 201, "heading", "root", "Second heading"),
            axNode("nested-frame", 210, "Iframe", "root", "Nested"),
          ],
        },
        {
          frameId: "nested",
          contextScopeId: "nested",
          parentFrameId: "second",
          ownerBackendNodeId: 210,
          target: { tabId: 7, sessionId: "session-nested" },
          domNodes: nestedNodes,
          axNodes: [
            axNode("root", 300, "RootWebArea"),
            axNode("input", 301, "textbox", "root", "Nested field"),
          ],
        },
      ],
      captured,
    );

    const rendered = renderVom(result);
    expect(rendered.text).toContain('Iframe "First"');
    expect(rendered.text).toContain('@e1 button "First action"');
    expect(rendered.text).toContain('heading "Second heading"');
    expect(rendered.text).toContain('Iframe "Nested"');
    expect(rendered.text).toContain('textbox "Nested field"');
    expect(rendered.refs.find((ref) => ref.backendNodeId === 101)?.frameId).toBe("first");
    expect(rendered.refs.find((ref) => ref.backendNodeId === 301)?.frameId).toBe("nested");

    const firstAction = result.nodes.find((item) => item.backendNodeId === 101);
    const nestedInput = result.nodes.find((item) => item.backendNodeId === 301);
    expect(firstAction).toMatchObject({ frameId: "first", contextScopeId: "first" });
    expect(nestedInput).toMatchObject({ frameId: "nested", contextScopeId: "nested" });
    expect(nestedInput?.parentId).toBe(result.nodes.find((item) => item.backendNodeId === 210)?.id);
  });

  it("does not place a child document at the page root when its frame boundary is unresolved", () => {
    const childNode: CapturedNode = {
      backendNodeId: 101,
      parentBackendNodeId: null,
      frameId: "child",
      tag: "button",
      attrs: {},
      rect: { x: 0, y: 0, w: 100, h: 30 },
      paintOrder: 1,
      position: "static",
      pointerEvents: "auto",
    };
    const captured: CapturedViewModel = {
      viewport: { width: 800, height: 600 },
      nodes: [],
      iframeNodes: new Map(),
      frameNodes: new Map([["child", [childNode]]]),
      rootFrameId: "main",
      excludedBackendNodeIds: new Set(),
    };

    const result = buildFrameVomScene(
      [
        {
          frameId: "main",
          contextScopeId: "main",
          target: { tabId: 7 },
          domNodes: [],
          axNodes: [],
        },
        {
          frameId: "child",
          contextScopeId: "child",
          parentFrameId: "main",
          target: { tabId: 7 },
          domNodes: [childNode],
          axNodes: [
            {
              nodeId: "button",
              frameId: "child",
              backendDOMNodeId: 101,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Child action" },
            },
          ],
        },
      ],
      captured,
    );

    expect(result.nodes).toEqual([]);
  });

  it("keeps AX-only frame content attached to its iframe boundary", () => {
    const mainNodes: CapturedNode[] = [
      {
        backendNodeId: 1,
        parentBackendNodeId: null,
        frameId: "main",
        tag: "body",
        attrs: {},
        rect: { x: 0, y: 0, w: 800, h: 600 },
        paintOrder: 0,
        position: "static",
        pointerEvents: "auto",
      },
      {
        backendNodeId: 10,
        parentBackendNodeId: 1,
        frameId: "main",
        tag: "iframe",
        attrs: { title: "Remote" },
        rect: { x: 100, y: 100, w: 400, h: 300 },
        paintOrder: 1,
        position: "static",
        pointerEvents: "auto",
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 800, height: 600 },
      nodes: mainNodes,
      iframeNodes: new Map(),
      frameNodes: new Map([
        ["main", mainNodes],
        ["child", []],
      ]),
      rootFrameId: "main",
      excludedBackendNodeIds: new Set(),
    };

    const result = buildFrameVomScene(
      [
        {
          frameId: "main",
          contextScopeId: "main",
          target: { tabId: 7 },
          domNodes: mainNodes,
          axNodes: [
            {
              nodeId: "main-root",
              backendDOMNodeId: 1,
              role: { type: "role", value: "RootWebArea" },
            },
            {
              nodeId: "frame-owner",
              parentId: "main-root",
              backendDOMNodeId: 10,
              role: { type: "role", value: "Iframe" },
              name: { type: "computedString", value: "Remote" },
            },
          ],
        },
        {
          frameId: "child",
          contextScopeId: "child",
          parentFrameId: "main",
          ownerBackendNodeId: 10,
          target: { tabId: 7, sessionId: "child-session" },
          domNodes: [],
          axNodes: [
            {
              nodeId: "child-root",
              backendDOMNodeId: 100,
              role: { type: "role", value: "RootWebArea" },
            },
            {
              nodeId: "child-button",
              parentId: "child-root",
              backendDOMNodeId: 101,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "AX fallback action" },
            },
          ],
        },
      ],
      captured,
    );

    const childButton = result.nodes.find((node) => node.backendNodeId === 101);
    expect(childButton).toMatchObject({ frameId: "child", contextScopeId: "child" });
    expect(childButton?.parentId).toBe(result.nodes.find((node) => node.backendNodeId === 10)?.id);
    expect(renderVom(result).text).toContain('@e1 button "AX fallback action"');
  });

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

    const scene = buildVomScene(axNodes, captured);
    expect(scene.viewport).toEqual({ width: 1000, height: 800 });
    expect(scene.nodes[0]).toEqual(
      expect.objectContaining({
        id: 100,
        parentId: null,
        role: "RootWebArea",
        name: "Example",
        tag: "body",
        rect: { x: 0, y: 0, w: 1000, h: 800 },
        domParentId: null,
        domAncestorIds: [],
      }),
    );
    expect(scene.nodes[1]).toEqual(
      expect.objectContaining({
        id: 200,
        parentId: 100,
        role: "button",
        name: "Submit",
        tag: "button",
        rect: { x: 20, y: 20, w: 120, h: 40 },
        domParentId: 100,
        domAncestorIds: [100],
        attrs: {},
      }),
    );
  });

  it("annotates external links from the explicit page URL without reading window.location", () => {
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 100,
        childIds: ["2", "3"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "Link" },
        name: { type: "computedString", value: "Docs" },
        backendDOMNodeId: 200,
      },
      {
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "Local" },
        backendDOMNodeId: 300,
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
          tag: "a",
          attrs: { href: "https://docs.example.org/start" },
          rect: { x: 10, y: 10, w: 60, h: 20 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
        },
        {
          backendNodeId: 300,
          parentBackendNodeId: 100,
          tag: "a",
          attrs: { href: "/local" },
          rect: { x: 80, y: 10, w: 60, h: 20 },
          paintOrder: 2,
          position: "static",
          pointerEvents: "auto",
        },
      ],
    };

    const scene = buildVomScene(axNodes, captured, { pageUrl: "https://app.example.test/home" });

    expect(scene.nodes.find((node) => node.id === 200)?.href).toBe("docs.example.org");
    expect(scene.nodes.find((node) => node.id === 300)?.href).toBeUndefined();
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

  it("dedupes iframe fallback controls already exposed through AX", () => {
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
        childIds: ["3"],
      },
      {
        nodeId: "3",
        parentId: "2",
        role: { type: "role", value: "textbox" },
        name: { type: "x", value: "输入密码" },
        value: { value: "iframe-secret" },
        backendDOMNodeId: 202,
        properties: [{ name: "inputType", value: { value: "password" } }],
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
              backendNodeId: 102,
              parentBackendNodeId: null,
              tag: "input",
              attrs: { type: "password", placeholder: "输入密码" },
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

    const passwordNodes = buildVomScene(axNodes, captured).nodes.filter(
      (node) => node.role === "textbox" && node.name === "输入密码",
    );

    expect(passwordNodes).toHaveLength(1);
    expect(passwordNodes[0]).toEqual(expect.objectContaining({ id: 202, sensitive: true }));
    expect(passwordNodes[0].value).toBeUndefined();
    const rendered = renderVom(buildVomScene(axNodes, captured)).text;
    expect(rendered).toContain('textbox "输入密码" [filled] ="•••"');
    expect(rendered).not.toContain("iframe-secret");
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

  it("marks current-password autocomplete as sensitive even for text inputs", () => {
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
        sensitive: true,
      }),
    );
  });

  it("keeps placeholder separate from the accessible name", () => {
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
      expect.objectContaining({
        id: 10,
        role: "textbox",
        name: "+86",
        placeholder: "输入手机号",
      }),
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

  it("uses nearby preceding text as a form control label", () => {
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
        role: { type: "role", value: "textbox" },
        backendDOMNodeId: 20,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
      nodes: [
        {
          backendNodeId: 1,
          parentBackendNodeId: null,
          tag: "div",
          attrs: {},
          rect: { x: 0, y: 0, w: 500, h: 80 },
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
        },
        {
          backendNodeId: 10,
          parentBackendNodeId: 1,
          tag: "span",
          attrs: {},
          textContent: "验证码:",
          rect: { x: 0, y: 0, w: 80, h: 30 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
        },
        {
          backendNodeId: 20,
          parentBackendNodeId: 1,
          tag: "input",
          attrs: { type: "text" },
          rect: { x: 90, y: 0, w: 120, h: 30 },
          paintOrder: 2,
          position: "static",
          pointerEvents: "auto",
          cursor: "text",
        },
      ],
    };

    expect(buildVomScene(axNodes, captured).nodes.find((node) => node.id === 20)).toEqual(
      expect.objectContaining({ role: "textbox", name: "验证码" }),
    );
  });

  it("uses preceding AX static text as a form control label", () => {
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
        role: { type: "role", value: "StaticText" },
        name: { type: "computedString", value: "验证码:" },
      },
      {
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "textbox" },
        backendDOMNodeId: 20,
      },
    ];
    const captured: CapturedViewModel = {
      viewport: { width: 1000, height: 800 },
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
      nodes: [
        {
          backendNodeId: 20,
          parentBackendNodeId: null,
          tag: "input",
          attrs: { type: "text" },
          rect: { x: 90, y: 0, w: 120, h: 30 },
          paintOrder: 2,
          position: "static",
          pointerEvents: "auto",
          cursor: "text",
        },
      ],
    };

    expect(buildVomScene(axNodes, captured).nodes.find((node) => node.id === 20)).toEqual(
      expect.objectContaining({ role: "textbox", name: "验证码", inputState: "empty" }),
    );
  });

  it("marks runtime default input values without treating them as ordinary filled input", () => {
    const scene = buildVomScene(
      [
        {
          nodeId: "1",
          role: { type: "role", value: "textbox" },
          backendDOMNodeId: 10,
        },
      ],
      {
        viewport: { width: 1000, height: 800 },
        iframeNodes: new Map(),
        excludedBackendNodeIds: new Set(),
        nodes: [
          {
            backendNodeId: 10,
            parentBackendNodeId: null,
            tag: "input",
            attrs: { type: "text" },
            formValue: "没有手机号的用编码代替",
            formDefaultValue: "没有手机号的用编码代替",
            rect: { x: 0, y: 0, w: 240, h: 48 },
            paintOrder: 1,
            position: "static",
            pointerEvents: "auto",
          },
        ],
      },
    );

    expect(scene.nodes[0]).toEqual(
      expect.objectContaining({
        inputState: "default",
        value: "没有手机号的用编码代替",
      }),
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

    const scene = buildVomScene(axNodes, captured);
    expect(scene.nodes.find((n) => n.id === 20)).toEqual(
      expect.objectContaining({ id: 20, role: "button", name: "close", cursor: "pointer" }),
    );
    const rendered = renderVom(scene);
    expect(rendered.text).toContain('@e1 button "close"');
    expect(rendered.refs.map(({ ref, backendNodeId }) => ({ ref, backendNodeId }))).toEqual([
      { ref: "e1", backendNodeId: 20 },
    ]);
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
    expect(scene.nodes.find((n) => n.id === 20)).toBeUndefined();
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
      expect.objectContaining({ id: 20, role: "button", attrs: { "aria-label": "收藏" } }),
    );
    expect(scene.nodes.find((n) => n.id === 30)).toBeUndefined();
    const rendered = renderVom(scene);
    expect(rendered.text).toContain('@e1 button "收藏"');
    expect(rendered.refs.map(({ ref, backendNodeId }) => ({ ref, backendNodeId }))).toEqual([
      { ref: "e1", backendNodeId: 20 },
    ]);
  });

  it("builds active scope blocks from active aria-controls relationships", () => {
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
        role: { type: "role", value: "tab" },
        name: { type: "computedString", value: "Reviews (12)" },
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
        },
        {
          backendNodeId: 20,
          parentBackendNodeId: 10,
          tag: "button",
          attrs: { role: "tab", "aria-selected": "true", "aria-controls": "reviews-panel" },
          rect: { x: 20, y: 20, w: 120, h: 40 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
        },
        {
          backendNodeId: 30,
          parentBackendNodeId: 10,
          tag: "div",
          attrs: { id: "reviews-panel" },
          rect: null,
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
          textContent: "Jane - ear cups are small",
        },
        {
          backendNodeId: 31,
          parentBackendNodeId: 30,
          tag: "p",
          attrs: {},
          rect: null,
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
          textContent: "Bob - great sound",
        },
      ],
    };

    const scene = buildVomScene(axNodes, captured);
    expect(scene.activeScopeBlocks).toEqual([
      {
        triggerId: 20,
        label: "Reviews (12)",
        lines: ["Jane - ear cups are small", "Bob - great sound"],
      },
    ]);
    expect(renderVom(scene).text).toContain("[§ active: Reviews (12)]");
  });

  it("maps hover surface probes to matching backend node ids", () => {
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
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Products" },
        backendDOMNodeId: 20,
      },
    ];
    const scene = buildVomScene(
      axNodes,
      {
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
          },
          {
            backendNodeId: 20,
            parentBackendNodeId: 10,
            tag: "button",
            attrs: {},
            rect: { x: 20, y: 20, w: 120, h: 40 },
            paintOrder: 1,
            position: "static",
            pointerEvents: "auto",
          },
        ],
      },
      {
        surfaceProbes: [
          { triggerBackendNodeId: 20, triggerAction: "hover", subItems: ["Shoes", "Bags"] },
        ],
      },
    );

    expect(scene.surfaces).toEqual([
      { triggerId: 20, triggerAction: "hover", subItems: ["Shoes", "Bags"] },
    ]);
    expect(renderVom(scene).text).toContain('@e1 button "Products" [hover first: Shoes | Bags]');
  });

  it("maps hover surface probes to rendered descendants in the same trigger subtree", () => {
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
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "image" },
        backendDOMNodeId: 21,
      },
    ];
    const scene = buildVomScene(
      axNodes,
      {
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
          },
          {
            backendNodeId: 20,
            parentBackendNodeId: 10,
            tag: "div",
            attrs: { class: "tg-avatar" },
            rect: { x: 900, y: 10, w: 30, h: 30 },
            paintOrder: 1,
            position: "static",
            pointerEvents: "auto",
          },
          {
            backendNodeId: 21,
            parentBackendNodeId: 20,
            tag: "div",
            attrs: { class: "tg-avatar__inner" },
            rect: { x: 902, y: 12, w: 26, h: 26 },
            paintOrder: 2,
            position: "static",
            pointerEvents: "auto",
          },
        ],
      },
      {
        surfaceProbes: [
          { triggerBackendNodeId: 20, triggerAction: "hover", subItems: ["My profile"] },
        ],
      },
    );

    expect(renderVom(scene).text).toContain('@e1 button "image" [hover first: My profile]');
  });

  it("deduplicates hover surface probes by original trigger backend id", () => {
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
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "image" },
        backendDOMNodeId: 21,
      },
    ];
    const scene = buildVomScene(
      axNodes,
      {
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
          },
          {
            backendNodeId: 20,
            parentBackendNodeId: 10,
            tag: "div",
            attrs: { class: "tg-avatar" },
            rect: { x: 900, y: 10, w: 30, h: 30 },
            paintOrder: 1,
            position: "static",
            pointerEvents: "auto",
          },
          {
            backendNodeId: 21,
            parentBackendNodeId: 20,
            tag: "div",
            attrs: { class: "tg-avatar__inner" },
            rect: { x: 902, y: 12, w: 26, h: 26 },
            paintOrder: 2,
            position: "static",
            pointerEvents: "auto",
          },
        ],
      },
      {
        surfaceProbes: [
          { triggerBackendNodeId: 20, triggerAction: "hover", subItems: ["My profile"] },
          { triggerBackendNodeId: 20, triggerAction: "hover", subItems: ["Sign out"] },
          { triggerBackendNodeId: 21, triggerAction: "hover", subItems: ["Settings"] },
        ],
      },
    );

    expect(scene.surfaces).toEqual([
      { triggerId: 21, triggerAction: "hover", subItems: ["My profile"] },
    ]);
  });

  it("maps hover surface probes to DOM-recovered custom controls", () => {
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
        role: { type: "role", value: "img" },
        name: { type: "computedString", value: "image" },
        backendDOMNodeId: 21,
      },
    ];
    const scene = buildVomScene(
      axNodes,
      {
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
            attrs: { class: "tg-avatar" },
            rect: { x: 900, y: 10, w: 30, h: 30 },
            paintOrder: 1,
            position: "static",
            pointerEvents: "auto",
            cursor: "pointer",
          },
          {
            backendNodeId: 21,
            parentBackendNodeId: 20,
            tag: "div",
            attrs: { class: "tg-avatar__inner" },
            rect: { x: 902, y: 12, w: 26, h: 26 },
            paintOrder: 2,
            position: "static",
            pointerEvents: "auto",
            cursor: "pointer",
          },
        ],
      },
      {
        surfaceProbes: [
          {
            triggerBackendNodeId: 20,
            triggerPoint: { x: 915, y: 25 },
            triggerAction: "hover",
            subItems: ["My profile", "Sign out"],
          },
        ],
      },
    );

    expect(scene.surfaces).toEqual([
      { triggerId: 20, triggerAction: "hover", subItems: ["My profile", "Sign out"] },
    ]);
    expect(renderVom(scene).text).toContain(
      '@e1 button "image" [hover first: My profile | Sign out]',
    );
  });

  it("does not attach hover probes to distant geometry matches", () => {
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
        role: { type: "role", value: "link" },
        name: { type: "computedString", value: "0" },
        backendDOMNodeId: 42,
      },
    ];
    const scene = buildVomScene(
      axNodes,
      {
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
          },
          {
            backendNodeId: 42,
            parentBackendNodeId: 10,
            tag: "a",
            attrs: {},
            rect: { x: 860, y: 120, w: 40, h: 30 },
            paintOrder: 1,
            position: "static",
            pointerEvents: "auto",
          },
        ],
      },
      {
        surfaceProbes: [
          {
            triggerBackendNodeId: 999,
            triggerPoint: { x: 900, y: 20 },
            triggerAction: "hover",
            subItems: ["My profile"],
          },
        ],
      },
    );

    expect(scene.surfaces).toBeUndefined();
    expect(renderVom(scene).text).not.toContain("[hover first:");
  });

  it("enriches names and active scope signals from AX properties", () => {
    const axNodes: CdpAxNode[] = [
      {
        nodeId: "1",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 10,
        childIds: ["2", "3"],
      },
      {
        nodeId: "2",
        parentId: "1",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Products" },
        backendDOMNodeId: 20,
        properties: [
          { name: "hasPopup", value: { value: "menu" } },
          { name: "expanded", value: { value: "true" } },
          { name: "controls", value: { value: "products-panel" } },
        ],
      },
      {
        nodeId: "3",
        parentId: "1",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Card number" },
        backendDOMNodeId: 30,
        properties: [{ name: "inputType", value: { value: "credit-card" } }],
      },
    ];
    const scene = buildVomScene(axNodes, {
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
        },
        {
          backendNodeId: 20,
          parentBackendNodeId: 10,
          tag: "button",
          attrs: {},
          rect: { x: 20, y: 20, w: 120, h: 40 },
          paintOrder: 1,
          position: "static",
          pointerEvents: "auto",
        },
        {
          backendNodeId: 25,
          parentBackendNodeId: 10,
          tag: "div",
          attrs: { id: "products-panel" },
          rect: null,
          paintOrder: 0,
          position: "static",
          pointerEvents: "auto",
          textContent: "Shoes Bags",
        },
        {
          backendNodeId: 30,
          parentBackendNodeId: 10,
          tag: "input",
          attrs: {},
          rect: { x: 20, y: 80, w: 200, h: 40 },
          paintOrder: 2,
          position: "static",
          pointerEvents: "auto",
        },
      ],
    });

    expect(scene.nodes.find((node) => node.id === 20)).toEqual(
      expect.objectContaining({
        name: "Products [expanded]",
        attrs: expect.objectContaining({
          "aria-expanded": "true",
          "aria-controls": "products-panel",
        }),
      }),
    );
    expect(scene.activeScopeBlocks).toEqual([
      { triggerId: 20, label: "Products [expanded]", lines: ["Shoes Bags"] },
    ]);
    expect(scene.nodes.find((node) => node.id === 30)?.sensitive).toBe(true);
  });

  it("aggregates AX virtual text into unnamed structural nodes", () => {
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
          role: { type: "role", value: "paragraph" },
          backendDOMNodeId: 20,
          childIds: ["3"],
        },
        {
          nodeId: "3",
          parentId: "2",
          role: { type: "role", value: "InlineTextBox" },
          name: { type: "computedString", value: "Inline only text" },
        },
      ],
      {
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
          },
          {
            backendNodeId: 20,
            parentBackendNodeId: 10,
            tag: "p",
            attrs: {},
            rect: { x: 20, y: 20, w: 400, h: 40 },
            paintOrder: 1,
            position: "static",
            pointerEvents: "auto",
          },
        ],
      },
    );

    expect(scene.nodes.find((node) => node.id === 20)?.name).toBe("Inline only text");
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

  it("keeps snapshots static without conditional surface probing", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
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
      name: { type: "computedString", value: "Products" },
      backendDOMNodeId: 200,
    };
    const strings = ["body", "button", "position", "static", "pointer-events", "auto", "cursor"];
    const i = (s: string) => strings.indexOf(s);
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes: [root, button] };
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 } };
      }
      if (method === "DOMSnapshot.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") {
        return {
          strings,
          documents: [
            {
              nodes: {
                parentIndex: [-1, 0],
                nodeName: [i("body"), i("button")],
                backendNodeId: [100, 200],
                attributes: [[], []],
              },
              layout: {
                nodeIndex: [0, 1],
                styles: [
                  [i("static"), i("auto"), i("auto")],
                  [i("static"), i("auto"), i("auto")],
                ],
                bounds: [
                  [0, 0, 1000, 800],
                  [20, 20, 120, 40],
                ],
                paintOrders: [0, 1],
              },
            },
          ],
        };
      }
      if (method === "Runtime.evaluate") return { result: { value: [] } };
      throw new Error(`unexpected CDP method ${method}`);
    });
    const res = await handleSnapshot(
      sm,
      { session_id: "aa11" },
      {
        cdp: {
          send: send as unknown as <T = unknown>(
            tabId: number,
            method: string,
            params?: object,
          ) => Promise<T>,
          trackSessionTab: vi.fn(),
        },
        tabsApi: {
          get: vi.fn(
            async (tabId: number) =>
              ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
          ),
          query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
        },
      },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(send).not.toHaveBeenCalledWith(
      4,
      "Runtime.evaluate",
      expect.objectContaining({ returnByValue: true }),
    );
  });

  it("hovers the page only after the accessibility tree has been captured", async () => {
    // Hovering can open menus and reflow the page. Probing between the DOM and
    // AX captures would leave the two halves of one observation describing the
    // page on either side of that change.
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
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
      name: { type: "computedString", value: "Products" },
      backendDOMNodeId: 200,
    };
    const strings = ["body", "button", "position", "static", "pointer-events", "auto", "cursor"];
    const i = (s: string) => strings.indexOf(s);
    const methodOrder: string[] = [];
    const send = vi.fn(async (_tabId: number, method: string, params?: object) => {
      methodOrder.push(method);
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes: [root, button] };
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 } };
      }
      if (method === "DOMSnapshot.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") {
        return {
          strings,
          documents: [
            {
              nodes: {
                parentIndex: [-1, 0],
                nodeName: [i("body"), i("button")],
                backendNodeId: [100, 200],
                attributes: [[], []],
              },
              layout: {
                nodeIndex: [0, 1],
                styles: [
                  [i("static"), i("auto"), i("auto")],
                  [i("static"), i("auto"), i("auto")],
                ],
                bounds: [
                  [0, 0, 1000, 800],
                  [20, 20, 120, 40],
                ],
                paintOrders: [0, 1],
              },
            },
          ],
        };
      }
      if (method === "Input.dispatchMouseEvent") return {};
      if (method === "Runtime.evaluate") {
        const expression = (params as { expression?: string } | undefined)?.expression ?? "";
        // Report the button as a `:hover` rule target so a real hover fires.
        if (expression.includes("document.styleSheets")) {
          return { result: { value: [{ x: 80, y: 40 }] } };
        }
        return { result: { value: [] } };
      }
      throw new Error(`unexpected CDP method ${method}`);
    });

    const res = await handleObserve(
      sm,
      { session_id: "aa11", probe_hover: true },
      {
        cdp: {
          send: send as unknown as <T = unknown>(
            tabId: number,
            method: string,
            params?: object,
          ) => Promise<T>,
          trackSessionTab: vi.fn(),
        },
        tabsApi: {
          get: vi.fn(
            async (tabId: number) =>
              ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
          ),
          query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
        },
      },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    const firstHover = methodOrder.indexOf("Input.dispatchMouseEvent");
    expect(firstHover).toBeGreaterThan(-1);
    expect(methodOrder.lastIndexOf("DOMSnapshot.captureSnapshot")).toBeLessThan(firstHover);
    expect(methodOrder.lastIndexOf("Accessibility.getFullAXTree")).toBeLessThan(firstHover);
  });

  it("runs conditional surface probing only when observe opts in", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
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
      name: { type: "computedString", value: "Products" },
      backendDOMNodeId: 200,
    };
    const strings = ["body", "button", "position", "static", "pointer-events", "auto", "cursor"];
    const i = (s: string) => strings.indexOf(s);
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes: [root, button] };
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 } };
      }
      if (method === "DOMSnapshot.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") {
        return {
          strings,
          documents: [
            {
              nodes: {
                parentIndex: [-1, 0],
                nodeName: [i("body"), i("button")],
                backendNodeId: [100, 200],
                attributes: [[], []],
              },
              layout: {
                nodeIndex: [0, 1],
                styles: [
                  [i("static"), i("auto"), i("auto")],
                  [i("static"), i("auto"), i("auto")],
                ],
                bounds: [
                  [0, 0, 1000, 800],
                  [20, 20, 120, 40],
                ],
                paintOrders: [0, 1],
              },
            },
          ],
        };
      }
      if (method === "Runtime.evaluate") return { result: { value: [] } };
      throw new Error(`unexpected CDP method ${method}`);
    });
    const deps = {
      cdp: {
        send: send as unknown as <T = unknown>(
          tabId: number,
          method: string,
          params?: object,
        ) => Promise<T>,
        trackSessionTab: vi.fn(),
      },
      tabsApi: {
        get: vi.fn(
          async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
        ),
        query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
      },
    };

    const withoutProbe = await handleObserve(
      sm,
      { session_id: "aa11", debug_surfaces: true },
      deps,
    );
    if ("code" in withoutProbe) {
      throw new Error(`unexpected error: ${JSON.stringify(withoutProbe)}`);
    }
    expect(withoutProbe.hover_probe).toBeUndefined();
    expect(send).not.toHaveBeenCalledWith(
      4,
      "Runtime.evaluate",
      expect.objectContaining({ returnByValue: true }),
    );

    const withProbe = await handleObserve(
      sm,
      { session_id: "aa11", debug_surfaces: true, probe_hover: true },
      deps,
    );
    if ("code" in withProbe) throw new Error(`unexpected error: ${JSON.stringify(withProbe)}`);
    expect(withProbe.debug).toEqual({ surface_probes: [] });
    expect(withProbe.hover_probe).toEqual({ performed: true, revealed_content: false });
    expect(send).toHaveBeenCalledWith(
      4,
      "Runtime.evaluate",
      expect.objectContaining({ returnByValue: true }),
    );
  });

  it("allows passive snapshots of explicit user-window tabs", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const root: CdpAxNode = {
      nodeId: "1",
      role: { type: "role", value: "RootWebArea" },
      name: { type: "computedString", value: "User tab" },
      backendDOMNodeId: 100,
      childIds: ["2"],
    };
    const button: CdpAxNode = {
      nodeId: "2",
      parentId: "1",
      role: { type: "role", value: "button" },
      name: { type: "computedString", value: "Read" },
      backendDOMNodeId: 200,
    };
    const deps = makeDeps([root, button]);
    deps.tabsApi.get = vi.fn(
      async (tabId: number) => ({ id: tabId, windowId: 200, active: true }) as chrome.tabs.Tab,
    );

    const res = await handleSnapshot(sm, { session_id: "aa11", tab_id: 9 }, deps);

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tab_id).toBe(9);
    expect(res.text).toContain('@e1 button "Read"');
    expect(deps.send).toHaveBeenCalledWith(9, "Accessibility.enable", {});
  });

  it("rejects semantic observe on explicit user-window tabs before CDP probing", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const deps = makeDeps([]);
    deps.tabsApi.get = vi.fn(
      async (tabId: number) => ({ id: tabId, windowId: 200, active: true }) as chrome.tabs.Tab,
    );

    const res = await handleObserve(sm, { session_id: "aa11", tab_id: 9 }, deps);

    expect(res).toMatchObject({
      code: "permission_denied",
      data: { reason: "agent_window_scope" },
    });
    expect(deps.send).not.toHaveBeenCalled();
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

  it("keeps the previous RefStore when cancellation lands during DOM capture", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 999, { tabId: 4 });
    const controller = new AbortController();
    let resolveCapture: (value: unknown) => void = () => {};
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              nodeId: "new",
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "New" },
              backendDOMNodeId: 123,
            },
          ],
        };
      }
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
      }
      if (method === "DOMSnapshot.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") {
        return new Promise((resolve) => {
          resolveCapture = resolve;
        });
      }
      throw new Error(`unexpected CDP method ${method}`);
    });
    const deps = {
      cdp: {
        send: send as unknown as <T = unknown>(
          tabId: number,
          method: string,
          params?: object,
        ) => Promise<T>,
        trackSessionTab: vi.fn(),
      },
      tabsApi: {
        get: vi.fn(),
        query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
      },
    };

    const pending = handleSnapshot(sm, { session_id: "aa11" }, deps, controller.signal);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(4, "DOMSnapshot.captureSnapshot", expect.any(Object)),
    );
    controller.abort();
    resolveCapture({ strings: [], documents: [] });

    await expect(pending).resolves.toMatchObject({ code: "cancelled" });
    expect(ctx.refStore.resolve("e1", { tabId: 4 })).toBe(999);
    expect(ctx.refStore.resolve("e2")).toBeNull();
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

  function secretsSnapshotReply(secrets: {
    email: string;
    password: string;
    otp: string;
    card: string;
  }) {
    const S = [
      "html",
      "body",
      "input",
      "position",
      "static",
      "pointer-events",
      "auto",
      "type",
      "text",
      "password",
      "autocomplete",
      "one-time-code",
      "cc-number",
      "value",
      secrets.email,
      secrets.password,
      secrets.otp,
      secrets.card,
    ];
    const i = (s: string) => S.indexOf(s);
    const style = [i("static"), i("auto"), i("auto")];
    return {
      strings: S,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1, 1, 1, 1],
            nodeName: [i("html"), i("body"), i("input"), i("input"), i("input"), i("input")],
            backendNodeId: [10, 11, 12, 13, 14, 15],
            attributes: [
              [],
              [],
              [i("type"), i("text"), i("value"), i(secrets.email)],
              [i("type"), i("password"), i("value"), i(secrets.password)],
              [
                i("type"),
                i("text"),
                i("autocomplete"),
                i("one-time-code"),
                i("value"),
                i(secrets.otp),
              ],
              [
                i("type"),
                i("text"),
                i("autocomplete"),
                i("cc-number"),
                i("value"),
                i(secrets.card),
              ],
            ],
            inputValue: {
              index: [2, 3, 4, 5],
              value: [i(secrets.email), i(secrets.password), i(secrets.otp), i(secrets.card)],
            },
          },
          layout: {
            nodeIndex: [1, 2, 3, 4, 5],
            styles: [style, style, style, style, style],
            bounds: [
              [0, 0, 1000, 800],
              [10, 10, 200, 32],
              [10, 50, 200, 32],
              [10, 90, 200, 32],
              [10, 130, 200, 32],
            ],
            paintOrders: [0, 1, 2, 3, 4],
          },
        },
      ],
    };
  }

  const VP_METRICS = {
    cssLayoutViewport: { clientWidth: 1000, clientHeight: 800, pageX: 0, pageY: 0 },
  };

  function makeFrameAwareDeps() {
    const strings = ["html", "body", "iframe", "button", "title", "Remote", "static", "auto"];
    const i = (value: string) => strings.indexOf(value);
    const styles = [i("static"), i("auto"), i("auto")];
    const snapshot = {
      strings,
      documents: [
        {
          frameId: "main",
          nodes: {
            parentIndex: [-1, 0, 1],
            nodeName: [i("html"), i("body"), i("iframe")],
            backendNodeId: [10, 11, 12],
            attributes: [[], [], [i("title"), i("Remote")]],
            contentDocumentIndex: { index: [2], value: [1] },
          },
          layout: {
            nodeIndex: [0, 1, 2],
            styles: [styles, styles, styles],
            bounds: [
              [0, 0, 1000, 800],
              [0, 0, 1000, 800],
              [100, 100, 400, 300],
            ],
            paintOrders: [0, 0, 1],
          },
        },
        {
          frameId: "child",
          nodes: {
            parentIndex: [-1, 0, 1],
            nodeName: [i("html"), i("body"), i("button")],
            backendNodeId: [20, 21, 22],
            attributes: [[], [], []],
          },
          layout: {
            nodeIndex: [0, 1, 2],
            styles: [styles, styles, styles],
            bounds: [
              [0, 0, 400, 300],
              [0, 0, 400, 300],
              [20, 30, 120, 40],
            ],
            paintOrders: [0, 0, 1],
          },
        },
      ],
    };
    const mainAx: CdpAxNode[] = [
      {
        nodeId: "main-root",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 11,
        childIds: ["frame-owner"],
      },
      {
        nodeId: "frame-owner",
        parentId: "main-root",
        role: { type: "role", value: "Iframe" },
        name: { type: "computedString", value: "Remote" },
        backendDOMNodeId: 12,
      },
    ];
    const childAx: CdpAxNode[] = [
      {
        nodeId: "child-root",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 21,
        childIds: ["child-button"],
      },
      {
        nodeId: "child-button",
        parentId: "child-root",
        role: { type: "role", value: "button" },
        name: { type: "computedString", value: "Frame action" },
        backendDOMNodeId: 22,
      },
    ];
    const send = vi.fn(async (_tabId: number, method: string) => {
      if (method === "Page.getLayoutMetrics") return VP_METRICS;
      if (method === "DOMSnapshot.enable" || method === "Accessibility.enable") return {};
      if (method === "DOMSnapshot.captureSnapshot") return snapshot;
      if (method === "Accessibility.getFullAXTree") return { nodes: mainAx };
      throw new Error(`unexpected root CDP method ${method}`);
    });
    const sendToTarget = vi.fn(async (_target, method: string) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes: childAx };
      throw new Error(`unexpected child CDP method ${method}`);
    });
    const cdp = {
      send: send as unknown as CdpRunner["send"],
      sendToTarget: sendToTarget as unknown as NonNullable<CdpRunner["sendToTarget"]>,
      getFrameGraph: vi.fn(async () => ({
        rootFrameId: "main",
        frames: [
          { frameId: "main", target: { tabId: 4 } },
          {
            frameId: "child",
            parentFrameId: "main",
            ownerBackendNodeId: 12,
            target: { tabId: 4, sessionId: "child-session" },
          },
        ],
      })),
      trackSessionTab: vi.fn(),
    } satisfies CdpRunner;
    return {
      cdp,
      tabsApi: {
        get: vi.fn(
          async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
        ),
        query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
      },
    };
  }

  it("exposes the frame-aware observation result for recording", async () => {
    const ax: CdpAxNode[] = [
      {
        nodeId: "root",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 11,
        childIds: ["password"],
      },
      {
        nodeId: "password",
        parentId: "root",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Password" },
        value: { value: "hunter2" },
        backendDOMNodeId: 13,
      },
    ];
    const deps = makeOverlayDeps(ax, loginSnapshotReply(), VP_METRICS);

    const result = await captureVomObservation(deps.cdp, 4, "https://example.com", {
      redactValues: true,
    });

    expect(result.text).not.toContain("hunter2");
    expect(result.text).toContain("•••");
    expect(result.refs[0]).toMatchObject({
      backendNodeId: 13,
      role: "textbox",
      name: "Password",
      line: expect.any(Number),
    });
    expect(result.rootFrameId).toBe("root");
    expect(result).not.toHaveProperty("frameDocuments");
    expect(result.frames).toEqual([{ frameId: "root", target: { tabId: 4 } }]);
    expect(result.matchNodes.find((node) => node.backendNodeId === 13)).toMatchObject({
      frameId: "root",
      backendNodeId: 13,
      tag: "input",
      rect: { x: 400, y: 300, w: 200, h: 40 },
      localRect: { x: 400, y: 300, w: 200, h: 40 },
    });
  });

  it("decorates live observations with active controlled content", async () => {
    const strings = [
      "html",
      "body",
      "button",
      "div",
      "#text",
      "role",
      "tab",
      "aria-selected",
      "true",
      "aria-controls",
      "reviews-panel",
      "id",
      "static",
      "auto",
      "visible",
      "1",
      "A detailed review",
    ];
    const index = (value: string) => strings.indexOf(value);
    const style = [index("static"), index("auto"), index("auto"), index("visible"), index("1")];
    const snapshot = {
      strings,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1, 1, 3],
            nodeName: [index("html"), index("body"), index("button"), index("div"), index("#text")],
            backendNodeId: [10, 11, 12, 13, 14],
            attributes: [
              [],
              [],
              [
                index("role"),
                index("tab"),
                index("aria-selected"),
                index("true"),
                index("aria-controls"),
                index("reviews-panel"),
              ],
              [index("id"), index("reviews-panel")],
              [],
            ],
            nodeValue: [-1, -1, -1, -1, index("A detailed review")],
          },
          layout: {
            nodeIndex: [0, 1, 2, 3, 4],
            styles: [style, style, style, style, style],
            bounds: [
              [0, 0, 1000, 800],
              [0, 0, 1000, 800],
              [20, 20, 120, 40],
              [20, 80, 500, 200],
              [20, 80, 200, 20],
            ],
            paintOrders: [0, 0, 1, 1, 1],
          },
        },
      ],
    };
    const ax: CdpAxNode[] = [
      {
        nodeId: "root",
        backendDOMNodeId: 11,
        role: { type: "role", value: "RootWebArea" },
        childIds: ["reviews"],
      },
      {
        nodeId: "reviews",
        parentId: "root",
        backendDOMNodeId: 12,
        role: { type: "role", value: "tab" },
        name: { type: "computedString", value: "Reviews" },
        properties: [
          { name: "selected", value: { value: true } },
          { name: "controls", value: { value: "reviews-panel" } },
        ],
      },
    ];

    const result = await captureVomObservation(
      makeOverlayDeps(ax, snapshot, VP_METRICS).cdp,
      4,
      "https://example.com",
    );

    expect(result.text).toContain('@e1 tab "Reviews"');
    expect(result.text).toContain("[§ active: Reviews]");
    expect(result.text).toContain("A detailed review");
  });

  it("does not leak form secrets through the record-safe observation payload", async () => {
    const secrets = {
      email: "user@example.com",
      password: "hunter2",
      otp: "847291",
      card: "4111111111111111",
    };
    const ax: CdpAxNode[] = [
      {
        nodeId: "root",
        role: { type: "role", value: "RootWebArea" },
        backendDOMNodeId: 11,
        childIds: ["email", "password", "otp", "card"],
      },
      {
        nodeId: "email",
        parentId: "root",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Email" },
        value: { value: secrets.email },
        backendDOMNodeId: 12,
      },
      {
        nodeId: "password",
        parentId: "root",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Password" },
        value: { value: secrets.password },
        backendDOMNodeId: 13,
      },
      {
        nodeId: "otp",
        parentId: "root",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Code" },
        value: { value: secrets.otp },
        backendDOMNodeId: 14,
      },
      {
        nodeId: "card",
        parentId: "root",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Card" },
        value: { value: secrets.card },
        backendDOMNodeId: 15,
      },
    ];
    const deps = makeOverlayDeps(ax, secretsSnapshotReply(secrets), VP_METRICS);

    const result = await captureVomObservation(deps.cdp, 4, "https://example.com", {
      redactValues: true,
    });
    const dumped = JSON.stringify(result);

    expect(result).not.toHaveProperty("frameDocuments");
    expect(dumped).not.toContain(secrets.email);
    expect(dumped).not.toContain(secrets.password);
    expect(dumped).not.toContain(secrets.otp);
    expect(dumped).not.toContain(secrets.card);
    expect(dumped).not.toContain("formValue");
    expect(dumped).not.toContain("formDefaultValue");
    expect(dumped).not.toContain("axNodes");
    expect(dumped).not.toContain("domNodes");
    expect(dumped).not.toContain("attrs");
    expect(result.text).toContain("•••");
  });

  it("keeps frames and rendered refs on the same frame identity", async () => {
    const deps = makeFrameAwareDeps();

    const result = await captureVomObservation(deps.cdp, 4, "https://example.com");

    expect(result.rootFrameId).toBe("main");
    expect(result.frames).toHaveLength(2);
    expect(result.frames.find((frame) => frame.frameId === "child")).toEqual({
      frameId: "child",
      parentFrameId: "main",
      ownerBackendNodeId: 12,
      target: { tabId: 4, sessionId: "child-session" },
    });
    expect(result.matchNodes.find((node) => node.backendNodeId === 22)).toMatchObject({
      frameId: "child",
      tag: "button",
      localRect: { x: 20, y: 30, w: 120, h: 40 },
    });
    expect(result.refs.find((ref) => ref.backendNodeId === 22)).toMatchObject({
      frameId: "child",
      name: "Frame action",
    });
  });

  it("stores iframe refs with their owning CDP session", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    const deps = makeFrameAwareDeps();

    const result = await handleSnapshot(sm, { session_id: "aa11" }, deps);

    if ("code" in result) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    expect(result.text).toContain('@e1 button "Frame action"');
    const frameRef = [...ctx.refStore.entries()].find(([, entry]) => entry.backendNodeId === 22);
    expect(frameRef?.[1]).toMatchObject({
      tabId: 4,
      frameId: "child",
      cdpSessionId: "child-session",
    });
  });

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
    expect(res.text).toMatch(/textbox "密码"/);
    expect(res.text).not.toMatch(/textbox "密码" ="•••"/);
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

  it("reads a frame ref through its child CDP session", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e7", 4242, {
      tabId: 4,
      frameId: "child-frame",
      cdpSessionId: "child-session",
    });
    const deps = makeDeps({});
    const sendToTarget = vi.fn(async (target, method, params) => {
      expect(target).toEqual({ tabId: 4, sessionId: "child-session" });
      expect(method).toBe("DOM.getOuterHTML");
      expect(params).toEqual({ backendNodeId: 4242 });
      return { outerHTML: "<button>frame</button>" };
    });
    (deps.cdp as CdpRunner).sendToTarget = sendToTarget as unknown as NonNullable<
      CdpRunner["sendToTarget"]
    >;

    const res = await handleGetHtml(sm, { session_id: "aa11", ref: "@e7" }, deps);

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.html).toBe("<button>frame</button>");
    expect(deps.send).not.toHaveBeenCalled();
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
