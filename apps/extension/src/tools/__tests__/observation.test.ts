import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import {
  type CdpAxNode,
  handleGetHtml,
  handleScreenshot,
  handleSnapshot,
  parsePngDimensions,
  renderAxTree,
  type ScreenshotDeps,
  shouldRender,
  stripDataUrlPrefix,
} from "../observation";

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
// shouldRender / renderAxTree
// ---------------------------------------------------------------------------

describe("shouldRender", () => {
  it("rejects ignored or generic nodes", () => {
    expect(
      shouldRender({ nodeId: "1", ignored: true, role: { type: "role", value: "button" } }),
    ).toBe(false);
    expect(shouldRender({ nodeId: "1", role: { type: "role", value: "generic" } })).toBe(false);
    expect(shouldRender({ nodeId: "1", role: { type: "role", value: "" } })).toBe(false);
  });
  it("accepts interactive roles even without a name", () => {
    expect(shouldRender({ nodeId: "1", role: { type: "role", value: "button" } })).toBe(true);
    expect(shouldRender({ nodeId: "1", role: { type: "role", value: "textbox" } })).toBe(true);
  });
  it("accepts named structural roles", () => {
    expect(
      shouldRender({
        nodeId: "1",
        role: { type: "role", value: "heading" },
        name: { type: "computedString", value: "Hello" },
      }),
    ).toBe(true);
  });
});

describe("renderAxTree", () => {
  const root: CdpAxNode = {
    nodeId: "1",
    role: { type: "role", value: "RootWebArea" },
    name: { type: "computedString", value: "Example" },
    backendDOMNodeId: 100,
    childIds: ["2", "3"],
  };
  const heading: CdpAxNode = {
    nodeId: "2",
    parentId: "1",
    role: { type: "role", value: "heading" },
    name: { type: "computedString", value: "Welcome" },
    backendDOMNodeId: 200,
  };
  const submit: CdpAxNode = {
    nodeId: "3",
    parentId: "1",
    role: { type: "role", value: "button" },
    name: { type: "computedString", value: "Submit" },
    backendDOMNodeId: 300,
  };

  it("renders an indented tree with sequential @eN refs", () => {
    const out = renderAxTree([root, heading, submit]);
    const lines = out.text.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^@e1 RootWebArea "Example"/);
    expect(lines[1]).toMatch(/^ {2}@e2 heading "Welcome"/);
    expect(lines[2]).toMatch(/^ {2}@e3 button "Submit"/);
    expect(out.refs.map((r) => r.ref)).toEqual(["e1", "e2", "e3"]);
    expect(out.refs.map((r) => r.backendNodeId)).toEqual([100, 200, 300]);
    expect(out.truncated).toBe(false);
  });

  it("skips ignored / generic nodes", () => {
    const ignored: CdpAxNode = {
      nodeId: "4",
      parentId: "1",
      role: { type: "role", value: "generic" },
      backendDOMNodeId: 400,
    };
    const out = renderAxTree([root, heading, ignored, submit]);
    expect(out.refs.map((r) => r.backendNodeId)).toEqual([100, 200, 300]);
    expect(out.text).not.toContain("generic");
  });

  it("truncates when max_tokens is exceeded", () => {
    const out = renderAxTree([root, heading, submit], { maxTokens: 10 });
    expect(out.truncated).toBe(true);
    const renderedRefs = new Set(Array.from(out.text.matchAll(/@(e\d+)/g), (m) => m[1]));
    expect(out.refs.every((r) => renderedRefs.has(r.ref))).toBe(true);
    expect(out.refs.length).toBeLessThan(3);
  });

  it("flags truncation when max_depth limits the walk", () => {
    const deepRoot: CdpAxNode = {
      nodeId: "1",
      role: { type: "role", value: "RootWebArea" },
      name: { type: "computedString", value: "Doc" },
      backendDOMNodeId: 100,
      childIds: ["2", "4"],
    };
    const middle: CdpAxNode = {
      nodeId: "2",
      parentId: "1",
      role: { type: "role", value: "section" },
      name: { type: "computedString", value: "Content" },
      backendDOMNodeId: 200,
      childIds: ["3"],
    };
    const deep: CdpAxNode = {
      nodeId: "3",
      parentId: "2",
      role: { type: "role", value: "button" },
      name: { type: "computedString", value: "Deep" },
      backendDOMNodeId: 300,
    };
    const sibling: CdpAxNode = {
      nodeId: "4",
      parentId: "1",
      role: { type: "role", value: "button" },
      name: { type: "computedString", value: "Sibling" },
      backendDOMNodeId: 400,
    };
    const out = renderAxTree([deepRoot, middle, deep, sibling], { maxDepth: 1 });
    expect(out.truncated).toBe(true);
    // Root + middle render; deep is past max_depth, but the root's
    // same-level sibling still renders.
    expect(out.refs.map((r) => r.backendNodeId)).toEqual([100, 200, 400]);
  });
});

describe("handleSnapshot", () => {
  function makeDeps(nodes: CdpAxNode[]) {
    const sendImpl = async (_tabId: number, method: string, _params?: object) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") return { nodes };
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
    expect(res.ref_count).toBe(2);
    expect(res.tab_id).toBe(4);
    expect(res.text).toContain("@e1");
    expect(res.text).toContain('@e2 button "Click"');
    expect(deps.trackSessionTab).toHaveBeenCalledWith("aa11", 4);
    expect(ctx.refStore.resolve("e1")).toBe(100);
    expect(ctx.refStore.resolve("e1", { tabId: 4 })).toBe(100);
    expect(ctx.refStore.resolve("e1", { tabId: 5 })).toBeNull();
    expect(ctx.refStore.resolveEntry("e1")).toMatchObject({ backendNodeId: 100, tabId: 4 });
    expect(ctx.refStore.resolve("e2")).toBe(200);
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
    expect(ctx.refStore.resolve("e1")).toBe(1);
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
