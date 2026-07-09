import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import {
  handleClick,
  handleFill,
  handlePress,
  handleSelect,
  modifiersBitfield,
  parseKeySpec,
  resolveKeyDescriptor,
} from "../interaction";

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

function makeFakeCdp(handlers: Record<string, (params: unknown) => unknown>) {
  const sent: Array<{ tabId: number; method: string; params?: object }> = [];
  const sendImpl = async (tabId: number, method: string, params?: object) => {
    sent.push({ tabId, method, params });
    const h = handlers[method];
    if (!h) throw new Error(`unexpected CDP call ${method}`);
    return h(params);
  };
  const send = vi.fn(sendImpl);
  const cdp: CdpRunner = {
    send: send as unknown as <T = unknown>(
      tabId: number,
      method: string,
      params?: object,
    ) => Promise<T>,
    trackSessionTab: vi.fn(),
  };
  const tabsApi = {
    get: vi.fn(
      async (tabId: number) => ({ id: tabId, windowId: 100, active: true }) as chrome.tabs.Tab,
    ),
    query: vi.fn(async () => [{ id: 4, windowId: 100, active: true } as chrome.tabs.Tab]),
  };
  return { cdp, tabsApi, sent };
}

describe("modifiersBitfield", () => {
  it("matches CDP's expected bit layout", () => {
    expect(modifiersBitfield([])).toBe(0);
    expect(modifiersBitfield(["alt"])).toBe(1);
    expect(modifiersBitfield(["ctrl"])).toBe(2);
    expect(modifiersBitfield(["meta"])).toBe(4);
    expect(modifiersBitfield(["shift"])).toBe(8);
    expect(modifiersBitfield(["ctrl", "shift"])).toBe(2 | 8);
    expect(modifiersBitfield(["alt", "ctrl", "meta", "shift"])).toBe(15);
  });
  it("de-duplicates repeats", () => {
    expect(modifiersBitfield(["ctrl", "ctrl"])).toBe(2);
  });
});

describe("handleClick", () => {
  it("rejects when neither ref nor selector is given", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({});
    const res = await handleClick(
      sm,
      { session_id: "aa11" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ code: "invalid_params" });
  });

  it("rejects when both ref AND selector are given", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({});
    const res = await handleClick(
      sm,
      { session_id: "aa11", ref: "@e1", selector: ".btn" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({
      code: "invalid_params",
      message: /both ref and selector/i,
    });
  });

  it("returns not_found when ref doesn't resolve in the session", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({});
    const res = await handleClick(
      sm,
      { session_id: "aa11", ref: "@e99" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ code: "not_found", data: { reason: "ref_not_found" } });
  });

  it("returns not_found when ref belongs to another tab", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e3", 1234, { tabId: 4 });
    const fake = makeFakeCdp({});
    const res = await handleClick(
      sm,
      { session_id: "aa11", ref: "@e3", tab_id: 5 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ code: "not_found", data: { reason: "ref_not_found" } });
    expect(fake.cdp.send).not.toHaveBeenCalled();
  });

  it("clicks by ref, computes the quad centre, dispatches three mouse events", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e3", 1234, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      // Quads are arrays of 8 doubles forming the four corners of the rect.
      "DOM.getContentQuads": () => ({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }),
      "Input.dispatchMouseEvent": () => ({}),
    });
    const res = await handleClick(
      sm,
      {
        session_id: "aa11",
        ref: "@e3",
        button: "left",
        click_count: 2,
        modifiers: ["ctrl", "shift"],
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.tab_id).toBe(4);
    expect(res.used_ref).toBe("e3");
    expect(res.used_selector).toBeUndefined();
    expect(res.x).toBeCloseTo(60); // (10 + 110) / 2
    expect(res.y).toBeCloseTo(40); // (20 + 60) / 2
    // 1 scroll + 1 quad query + 3 mouse events = 5 CDP calls.
    const mouse = fake.sent.filter((c) => c.method === "Input.dispatchMouseEvent");
    expect(mouse).toHaveLength(3);
    expect(mouse[0].params).toMatchObject({ type: "mouseMoved" });
    expect(mouse[1].params).toMatchObject({
      type: "mousePressed",
      button: "left",
      clickCount: 2,
      modifiers: 2 | 8,
    });
    expect(mouse[2].params).toMatchObject({
      type: "mouseReleased",
      button: "left",
      clickCount: 2,
    });
  });

  it("enables overlay bypass before mouse events when overlay blocks the click point", async () => {
    const order: string[] = [];
    const bypassOverlay = vi.fn(async (_tabId: number, enabled: boolean) => {
      order.push(enabled ? "bypass-on" : "bypass-off");
    });
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e3", 1234, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }),
      "Runtime.evaluate": (params: unknown) => {
        const expr = String((params as { expression?: string })?.expression ?? "");
        if (expr.includes("overlayHostPresent") && !expr.includes("hitIndex")) {
          return { result: { value: { overlayHostPresent: true, overlayHostConnected: true } } };
        }
        if (expr.includes("hitIndex")) {
          return {
            result: {
              value: { overlayHostPresent: true, overlayHostConnected: true, hitIndex: 0 },
            },
          };
        }
        throw new Error(`unexpected Runtime.evaluate: ${expr.slice(0, 80)}`);
      },
      "Input.dispatchMouseEvent": () => {
        order.push("mouse");
        return {};
      },
    });
    const res = await handleClick(
      sm,
      { session_id: "aa11", ref: "@e3" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, bypassOverlay },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(bypassOverlay).toHaveBeenCalledWith(4, true);
    expect(bypassOverlay).toHaveBeenCalledWith(4, false);
    expect(order.indexOf("bypass-on")).toBeLessThan(order.indexOf("mouse"));
    expect(order.lastIndexOf("bypass-off")).toBeGreaterThan(order.lastIndexOf("mouse"));
  });

  it("disables overlay bypass when mouse dispatch throws", async () => {
    const bypassOverlay = vi.fn().mockResolvedValue(undefined);
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e3", 1234, { tabId: 4 });
    let mouseCalls = 0;
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }),
      "Runtime.evaluate": (params: unknown) => {
        const expr = String((params as { expression?: string })?.expression ?? "");
        if (expr.includes("overlayHostPresent") && !expr.includes("hitIndex")) {
          return { result: { value: { overlayHostPresent: true, overlayHostConnected: true } } };
        }
        if (expr.includes("hitIndex")) {
          return {
            result: {
              value: { overlayHostPresent: true, overlayHostConnected: true, hitIndex: 0 },
            },
          };
        }
        throw new Error(`unexpected Runtime.evaluate: ${expr.slice(0, 80)}`);
      },
      "Input.dispatchMouseEvent": () => {
        mouseCalls += 1;
        if (mouseCalls === 2) throw new Error("mousePressed failed");
        return {};
      },
    });
    const res = await handleClick(
      sm,
      { session_id: "aa11", ref: "@e3" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, bypassOverlay },
    );
    expect(res).toMatchObject({ code: "cdp_failed" });
    expect(bypassOverlay).toHaveBeenCalledWith(4, true);
    expect(bypassOverlay).toHaveBeenCalledWith(4, false);
  });

  it("skips overlay bypass when overlay does not block the click point", async () => {
    const bypassOverlay = vi.fn().mockResolvedValue(undefined);
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e3", 1234, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }),
      "Runtime.evaluate": (params: unknown) => {
        const expr = String((params as { expression?: string })?.expression ?? "");
        if (expr.includes("overlayHostPresent") && !expr.includes("hitIndex")) {
          return { result: { value: { overlayHostPresent: false, overlayHostConnected: false } } };
        }
        throw new Error(`unexpected Runtime.evaluate: ${expr.slice(0, 80)}`);
      },
      "Input.dispatchMouseEvent": () => ({}),
    });
    await handleClick(
      sm,
      { session_id: "aa11", ref: "@e3" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, bypassOverlay },
    );
    expect(bypassOverlay).not.toHaveBeenCalled();
  });

  it("rejects click_count=0", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e3", 1234, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }),
    });

    const res = await handleClick(
      sm,
      { session_id: "aa11", ref: "@e3", click_count: 0 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    expect(res).toMatchObject({ code: "invalid_params" });
    expect(fake.sent.some((c) => c.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("falls back to DOM.getBoxModel when quads are missing", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [] }),
      "DOM.getBoxModel": () => ({ model: { content: [0, 0, 40, 0, 40, 20, 0, 20] } }),
      "Input.dispatchMouseEvent": () => ({}),
    });
    const res = await handleClick(
      sm,
      { session_id: "aa11", ref: "e1" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.x).toBeCloseTo(20);
    expect(res.y).toBeCloseTo(10);
  });

  it("returns permission_denied when the element has no visible box", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [] }),
      "DOM.getBoxModel": () => {
        throw new Error("Could not compute box model.");
      },
    });
    const res = await handleClick(
      sm,
      { session_id: "aa11", ref: "e1" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({
      code: "permission_denied",
      message: /not visible/i,
      data: { reason: "element_not_visible" },
    });
  });

  it("clicks by selector and reports used_selector in the result", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "DOM.querySelector": (p) => {
        expect(p).toMatchObject({ nodeId: 1, selector: ".btn-go" });
        return { nodeId: 99 };
      },
      "DOM.describeNode": () => ({ node: { backendNodeId: 7777 } }),
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[0, 0, 50, 0, 50, 50, 0, 50]] }),
      "Input.dispatchMouseEvent": () => ({}),
    });
    const res = await handleClick(
      sm,
      { session_id: "aa11", selector: ".btn-go" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.used_selector).toBe(".btn-go");
    expect(res.used_ref).toBeUndefined();
  });

  it("falls back to Element.scrollIntoView when DOM.scrollIntoViewIfNeeded fails", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 100, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => {
        throw new Error("method not found");
      },
      "DOM.resolveNode": () => ({ object: { objectId: "obj-1" } }),
      "Runtime.callFunctionOn": () => ({ result: { type: "undefined" } }),
      "DOM.getContentQuads": () => ({ quads: [[0, 0, 10, 0, 10, 10, 0, 10]] }),
      "Input.dispatchMouseEvent": () => ({}),
    });

    const res = await handleClick(
      sm,
      { session_id: "aa11", ref: "e1" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    const fallback = fake.sent.find((c) => c.method === "Runtime.callFunctionOn");
    expect(fallback?.params).toMatchObject({ objectId: "obj-1" });
  });

  it("returns not_found when DOM.querySelector returns nodeId=0", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "DOM.querySelector": () => ({ nodeId: 0 }),
    });
    const res = await handleClick(
      sm,
      { session_id: "aa11", selector: ".missing" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ code: "not_found", data: { reason: "selector_not_found" } });
  });

  it("respects the AbortSignal", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 100, { tabId: 4 });
    const abort = new AbortController();
    abort.abort();
    const fake = makeFakeCdp({});
    const res = await handleClick(
      sm,
      { session_id: "aa11", ref: "e1" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );
    expect(res).toMatchObject({ code: "cancelled" });
  });

  it("stops dispatching mouse events after a mid-click abort", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 100, { tabId: 4 });
    const abort = new AbortController();
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[0, 0, 10, 0, 10, 10, 0, 10]] }),
      "Input.dispatchMouseEvent": (p) => {
        if ((p as { type?: string }).type === "mouseMoved") abort.abort();
        return {};
      },
    });

    const res = await handleClick(
      sm,
      { session_id: "aa11", ref: "e1" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );

    expect(res).toMatchObject({ code: "cancelled" });
    expect(fake.sent.filter((c) => c.method === "Input.dispatchMouseEvent")).toHaveLength(1);
  });
});

describe("handleFill", () => {
  it("returns not_found for unknown ref", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({});
    const res = await handleFill(
      sm,
      { session_id: "aa11", ref: "e99", value: "hello" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ code: "not_found", data: { reason: "ref_not_found" } });
    expect(fake.cdp.send).not.toHaveBeenCalled();
  });

  it("rejects non-fillable elements as invalid_params", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 100, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.describeNode": () => ({
        node: { backendNodeId: 100, nodeName: "DIV", attributes: [] },
      }),
    });
    const res = await handleFill(
      sm,
      { session_id: "aa11", ref: "e1", value: "hi" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({
      code: "invalid_params",
      message: /not fillable/i,
      data: { reason: "target_not_fillable" },
    });
  });

  it("fills an <input> via Runtime.callFunctionOn + Input.insertText", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.describeNode": () => ({
        node: { backendNodeId: 555, nodeName: "INPUT", attributes: ["type", "text"] },
      }),
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.focus": () => ({}),
      "DOM.resolveNode": () => ({ object: { objectId: "obj-1" } }),
      "Runtime.callFunctionOn": () => ({ result: { type: "undefined" } }),
      "Input.insertText": () => ({}),
    });
    const res = await handleFill(
      sm,
      { session_id: "aa11", ref: "e1", value: "hello" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.value_length).toBe(5);
    expect(res.tab_id).toBe(4);
    expect(res.used_ref).toBe("e1");
    const insert = fake.sent.find((c) => c.method === "Input.insertText");
    expect(insert?.params).toEqual({ text: "hello" });
    // clear_before defaults to true → callFunctionOn invoked once to
    // clear, once to fire input/change after typing.
    const callFns = fake.sent.filter((c) => c.method === "Runtime.callFunctionOn");
    expect(callFns.length).toBeGreaterThanOrEqual(2);
  });

  it("clear_before=false skips the wipe call", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 1, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.describeNode": () => ({
        node: { backendNodeId: 1, nodeName: "TEXTAREA", attributes: [] },
      }),
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.focus": () => ({}),
      "DOM.resolveNode": () => ({ object: { objectId: "obj-2" } }),
      "Runtime.callFunctionOn": (p) => {
        const fn = (p as { functionDeclaration?: string }).functionDeclaration ?? "";
        // No "this.value = ''" clearing on a no-clear path; only the
        // post-input dispatchEvent.
        expect(fn).not.toMatch(/this\.value\s*=\s*''/);
        return { result: { type: "undefined" } };
      },
      "Input.insertText": () => ({}),
    });
    const res = await handleFill(
      sm,
      { session_id: "aa11", ref: "e1", value: "x", clear_before: false },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.value_length).toBe(1);
  });

  it("treats contenteditable=true as fillable", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 7, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.describeNode": () => ({
        node: {
          backendNodeId: 7,
          nodeName: "DIV",
          attributes: ["contenteditable", "true"],
        },
      }),
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.focus": () => ({}),
      "DOM.resolveNode": () => ({ object: { objectId: "obj-3" } }),
      "Runtime.callFunctionOn": () => ({ result: { type: "undefined" } }),
      "Input.insertText": () => ({}),
    });
    const res = await handleFill(
      sm,
      { session_id: "aa11", ref: "e1", value: "rich" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect("code" in res).toBe(false);
  });

  it("stops before Input.insertText when abort fires after clearing", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const abort = new AbortController();
    const fake = makeFakeCdp({
      "DOM.describeNode": () => ({
        node: { backendNodeId: 555, nodeName: "INPUT", attributes: ["type", "text"] },
      }),
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.focus": () => ({}),
      "DOM.resolveNode": () => ({ object: { objectId: "obj-1" } }),
      "Runtime.callFunctionOn": () => {
        abort.abort();
        return { result: { type: "undefined" } };
      },
      "Input.insertText": () => ({}),
    });

    const res = await handleFill(
      sm,
      { session_id: "aa11", ref: "e1", value: "hello" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );

    expect(res).toMatchObject({ code: "cancelled" });
    expect(fake.sent.some((c) => c.method === "Input.insertText")).toBe(false);
  });

  it("stops before focus when abort fires after fill scroll", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const abort = new AbortController();
    const fake = makeFakeCdp({
      "DOM.describeNode": () => ({
        node: { backendNodeId: 555, nodeName: "INPUT", attributes: ["type", "text"] },
      }),
      "DOM.scrollIntoViewIfNeeded": () => {
        abort.abort();
        return {};
      },
      "DOM.focus": () => ({}),
    });

    const res = await handleFill(
      sm,
      { session_id: "aa11", ref: "e1", value: "hello" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );

    expect(res).toMatchObject({ code: "cancelled" });
    expect(fake.sent.some((c) => c.method === "DOM.focus")).toBe(false);
  });
});

describe("parseKeySpec", () => {
  it("splits compound expressions into modifiers + base key", () => {
    expect(parseKeySpec("Ctrl+A")).toEqual({ key: "A", modifiers: ["ctrl"] });
    expect(parseKeySpec("Meta+Shift+P")).toEqual({
      key: "P",
      modifiers: ["meta", "shift"],
    });
  });
  it("treats single keys as no-modifier presses", () => {
    expect(parseKeySpec("Enter")).toEqual({ key: "Enter", modifiers: [] });
    expect(parseKeySpec("a")).toEqual({ key: "a", modifiers: [] });
  });
  it("normalises modifier casing", () => {
    expect(parseKeySpec("CONTROL+SHIFT+P")).toEqual({
      key: "P",
      modifiers: ["ctrl", "shift"],
    });
  });
});

describe("resolveKeyDescriptor", () => {
  it("maps Enter to key/code/text", () => {
    expect(resolveKeyDescriptor("Enter")).toEqual({
      key: "Enter",
      code: "Enter",
      text: "\r",
      windowsVirtualKeyCode: 13,
    });
  });
  it("maps single lowercase letters", () => {
    expect(resolveKeyDescriptor("a")).toMatchObject({ key: "a", code: "KeyA", text: "a" });
  });
  it("maps single uppercase letters with the right CDP code", () => {
    expect(resolveKeyDescriptor("A")).toMatchObject({ key: "A", code: "KeyA", text: "A" });
  });
  it("maps digits", () => {
    expect(resolveKeyDescriptor("3")).toMatchObject({ key: "3", code: "Digit3", text: "3" });
  });
  it("recognises arrow keys", () => {
    expect(resolveKeyDescriptor("ArrowLeft")).toMatchObject({ code: "ArrowLeft" });
  });
  it("returns null for unknown keys", () => {
    expect(resolveKeyDescriptor("UnknownKey")).toBeNull();
  });
});

// PressResult also has a `code` field (the CDP keyboard code), so
// `"code" in res` is not enough to distinguish from an RpcError. The
// helper below narrows by checking for `key`/`tab_id` and asserts
// success without dropping the structural type information.
import type { PressResult, RpcError } from "@/transport/types";

function expectPressOk(res: PressResult | RpcError): asserts res is PressResult {
  if (!("tab_id" in res) || "message" in res) {
    throw new Error(`unexpected press response: ${JSON.stringify(res)}`);
  }
}

describe("handlePress", () => {
  it("returns not_found for unknown ref", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({});
    const res = await handlePress(
      sm,
      { session_id: "aa11", ref: "@e99", key: "Enter" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ code: "not_found", data: { reason: "ref_not_found" } });
    expect(fake.cdp.send).not.toHaveBeenCalled();
  });

  it("dispatches rawKeyDown + char + keyUp for a printable letter", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({
      "Input.dispatchKeyEvent": () => ({}),
    });
    const res = await handlePress(
      sm,
      { session_id: "aa11", key: "a" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expectPressOk(res);
    expect(res.key).toBe("a");
    expect(res.code).toBe("KeyA");
    expect(res.modifiers).toEqual([]);
    const calls = fake.sent.filter((c) => c.method === "Input.dispatchKeyEvent");
    expect(calls.map((c) => (c.params as { type?: string }).type)).toEqual([
      "rawKeyDown",
      "char",
      "keyUp",
    ]);
    expect(calls[0].params).not.toHaveProperty("text");
    expect(calls[1].params).toMatchObject({ text: "a" });
  });

  it("handles compound expressions and folds modifiers", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({ "Input.dispatchKeyEvent": () => ({}) });
    const res = await handlePress(
      sm,
      { session_id: "aa11", key: "Ctrl+A" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expectPressOk(res);
    expect(res.modifiers).toEqual(["ctrl"]);
    expect(res.code).toBe("KeyA");
    const keyDown = fake.sent.find(
      (c) =>
        c.method === "Input.dispatchKeyEvent" &&
        (c.params as { type?: string }).type === "rawKeyDown",
    );
    expect(keyDown?.params).toMatchObject({ modifiers: 2, key: "A", code: "KeyA" });
    expect(keyDown?.params).not.toHaveProperty("text");
  });

  it("focuses an optional target before dispatch", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.focus": () => ({}),
      "Input.dispatchKeyEvent": () => ({}),
    });
    const res = await handlePress(
      sm,
      { session_id: "aa11", key: "Enter", ref: "@e1" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expectPressOk(res);
    const focus = fake.sent.find((c) => c.method === "DOM.focus");
    expect(focus?.params).toEqual({ backendNodeId: 555 });
    expect(res.key).toBe("Enter");
  });

  it("stops before focus when abort fires after press scroll", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const abort = new AbortController();
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => {
        abort.abort();
        return {};
      },
      "DOM.focus": () => ({}),
    });

    const res = await handlePress(
      sm,
      { session_id: "aa11", key: "Enter", ref: "@e1" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );

    expect(res).toMatchObject({ code: "cancelled" });
    expect(fake.sent.some((c) => c.method === "DOM.focus")).toBe(false);
  });

  it("returns invalid_params for an unknown key", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({});
    const res = await handlePress(
      sm,
      { session_id: "aa11", key: "TotallyMadeUpKey" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({ code: "invalid_params" });
  });

  it("holds the key for hold_ms between keyDown and keyUp", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const fake = makeFakeCdp({ "Input.dispatchKeyEvent": () => ({}) });
    const start = Date.now();
    const res = await handlePress(
      sm,
      { session_id: "aa11", key: "Enter", hold_ms: 50 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    const elapsed = Date.now() - start;
    expectPressOk(res);
    expect(elapsed).toBeGreaterThanOrEqual(40); // generous lower bound
  });

  it("returns cancelled after hold_ms abort while still sending keyUp", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await sm.start("aa11");
    const abort = new AbortController();
    const fake = makeFakeCdp({ "Input.dispatchKeyEvent": () => ({}) });
    const pressP = handlePress(
      sm,
      { session_id: "aa11", key: "Escape", hold_ms: 50 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );

    setTimeout(() => abort.abort(), 5);
    const res = await pressP;
    expect(res).toMatchObject({ code: "cancelled" });
    expect(
      fake.sent
        .filter((c) => c.method === "Input.dispatchKeyEvent")
        .map((c) => (c.params as { type?: string }).type),
    ).toEqual(["rawKeyDown", "keyUp"]);
  });
});

describe("handleSelect", () => {
  const selectHandlers = (mutation: {
    ok: boolean;
    reason?: string;
    missing?: string;
    multiple?: boolean;
    selected_values?: string[];
    selected_labels?: string[];
  }) => ({
    "DOM.describeNode": () => ({
      node: {
        backendNodeId: 555,
        nodeName: "SELECT",
        attributes: mutation.multiple ? ["multiple", ""] : [],
      },
    }),
    "DOM.scrollIntoViewIfNeeded": () => ({}),
    "DOM.focus": () => ({}),
    "DOM.resolveNode": () => ({ object: { objectId: "obj-sel" } }),
    "Runtime.callFunctionOn": () => ({ result: { value: mutation } }),
  });

  it("rejects non-select elements as target_not_select", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 100, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.describeNode": () => ({
        node: { backendNodeId: 100, nodeName: "DIV", attributes: [] },
      }),
    });
    const res = await handleSelect(
      sm,
      { session_id: "aa11", ref: "e1", values: ["a"] },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({
      code: "invalid_params",
      data: { reason: "target_not_select" },
    });
  });

  it("sets multiple values on a <select multiple>", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const fake = makeFakeCdp(
      selectHandlers({
        ok: true,
        multiple: true,
        selected_values: ["us", "ca"],
        selected_labels: ["United States", "Canada"],
      }),
    );
    const res = await handleSelect(
      sm,
      { session_id: "aa11", ref: "e1", values: ["us", "ca"] },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.multiple).toBe(true);
    expect(res.selected_values).toEqual(["us", "ca"]);
    expect(res.selected_labels).toEqual(["United States", "Canada"]);
    const callFn = fake.sent.find((c) => c.method === "Runtime.callFunctionOn");
    expect(callFn?.params).toMatchObject({
      arguments: [{ value: ["us", "ca"] }],
    });
  });

  it("sets a single value on a single-select <select>", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const fake = makeFakeCdp(
      selectHandlers({
        ok: true,
        multiple: false,
        selected_values: ["us"],
        selected_labels: ["United States"],
      }),
    );
    const res = await handleSelect(
      sm,
      { session_id: "aa11", ref: "e1", values: ["us"] },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    if ("code" in res) throw new Error(`unexpected error: ${JSON.stringify(res)}`);
    expect(res.multiple).toBe(false);
    expect(res.selected_values).toEqual(["us"]);
  });

  it("returns option_not_found when a value is missing", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const fake = makeFakeCdp(
      selectHandlers({
        ok: false,
        reason: "option_not_found",
        missing: "zz",
      }),
    );
    const res = await handleSelect(
      sm,
      { session_id: "aa11", ref: "e1", values: ["zz"] },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({
      code: "invalid_params",
      data: { reason: "option_not_found" },
    });
  });

  it("rejects multiple values on a single-select <select>", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.describeNode": () => ({
        node: { backendNodeId: 555, nodeName: "SELECT", attributes: [] },
      }),
    });
    const res = await handleSelect(
      sm,
      { session_id: "aa11", ref: "e1", values: ["a", "b"] },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );
    expect(res).toMatchObject({
      code: "invalid_params",
      data: { reason: "single_select_value_count" },
    });
    expect(fake.sent.some((c) => c.method === "Runtime.callFunctionOn")).toBe(false);
  });

  it("stops before mutation when abort fires after focus", async () => {
    const sm = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await sm.start("aa11");
    ctx.refStore.set("e1", 555, { tabId: 4 });
    const abort = new AbortController();
    const fake = makeFakeCdp({
      "DOM.describeNode": () => ({
        node: { backendNodeId: 555, nodeName: "SELECT", attributes: [] },
      }),
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.focus": () => {
        abort.abort();
        return {};
      },
      "DOM.resolveNode": () => ({ object: { objectId: "obj-sel" } }),
      "Runtime.callFunctionOn": () => ({ result: { value: { ok: true } } }),
    });
    const res = await handleSelect(
      sm,
      { session_id: "aa11", ref: "e1", values: ["a"] },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );
    expect(res).toMatchObject({ code: "cancelled" });
    expect(fake.sent.some((c) => c.method === "Runtime.callFunctionOn")).toBe(false);
  });
});
