import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import { handleWheel } from "../wheel";

function fakeAgentWindow(ids: number[]) {
  let index = 0;
  return {
    create: vi.fn(async () => {
      const id = ids[index++];
      if (id === undefined) throw new Error("ran out of fake ids");
      return id;
    }),
    remove: vi.fn(async () => {}),
    ensureActiveTab: vi.fn(async () => {}),
  };
}

function makeFakeCdp(handlers: Record<string, (params: unknown) => unknown> = {}) {
  const sent: Array<{ tabId: number; method: string; params?: object }> = [];
  const cdp: CdpRunner = {
    send: vi.fn(async (tabId: number, method: string, params?: object) => {
      sent.push({ tabId, method, params });
      const handler = handlers[method];
      if (handler) return handler(params);
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 } };
      }
      if (method === "Input.dispatchMouseEvent") return {};
      throw new Error(`unexpected CDP call ${method}`);
    }) as unknown as CdpRunner["send"],
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

describe("handleWheel", () => {
  it("dispatches a native mouseWheel event at the viewport centre", async () => {
    const manager = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await manager.start("aa11");
    const fake = makeFakeCdp();
    const bypassOverlay = vi.fn(async () => {});

    const result = await handleWheel(
      manager,
      {
        session_id: "aa11",
        delta_y: 600,
        delta_x: -20,
        modifiers: ["ctrl", "shift"],
      },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, bypassOverlay },
    );

    if ("code" in result) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({
      tab_id: 4,
      x: 500,
      y: 400,
      delta_x: -20,
      delta_y: 600,
    });
    expect(fake.sent).toEqual([
      { tabId: 4, method: "Page.getLayoutMetrics", params: {} },
      {
        tabId: 4,
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: 500, y: 400, modifiers: 10 },
      },
      {
        tabId: 4,
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseWheel",
          x: 500,
          y: 400,
          deltaX: -20,
          deltaY: 600,
          modifiers: 10,
        },
      },
    ]);
    expect(bypassOverlay.mock.calls).toEqual([
      [4, true],
      [4, false],
    ]);
  });

  it("uses an element's visible action point for targeted wheel input", async () => {
    const manager = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await manager.start("aa11");
    ctx.refStore.set("e3", 1234, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }),
    });

    const result = await handleWheel(
      manager,
      { session_id: "aa11", ref: "@e3", delta_y: 120 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    if ("code" in result) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ used_ref: "e3", x: 60, y: 40, delta_y: 120 });
    expect(fake.sent.at(-1)).toMatchObject({
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseWheel", x: 60, y: 40, deltaY: 120 },
    });
  });

  it("rejects a zero-distance wheel without issuing CDP calls", async () => {
    const manager = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await manager.start("aa11");
    const fake = makeFakeCdp();

    const result = await handleWheel(
      manager,
      { session_id: "aa11", delta_x: 0, delta_y: 0 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    expect(result).toMatchObject({ code: "invalid_params" });
    expect(fake.cdp.send).not.toHaveBeenCalled();
  });

  it("does not issue CDP calls after an early cancellation", async () => {
    const manager = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await manager.start("aa11");
    const fake = makeFakeCdp();
    const abort = new AbortController();
    abort.abort();

    const result = await handleWheel(
      manager,
      { session_id: "aa11", delta_y: 120 },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );

    expect(result).toMatchObject({ code: "cancelled" });
    expect(fake.cdp.send).not.toHaveBeenCalled();
  });
});
