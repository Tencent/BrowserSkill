import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import { handleScrollTo } from "../scroll";

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
    const handler = handlers[method];
    if (!handler && method === "Page.getLayoutMetrics") {
      return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
    }
    if (!handler) throw new Error(`unexpected CDP call ${method}`);
    return handler(params);
  };
  const cdp: CdpRunner = {
    send: vi.fn(sendImpl) as unknown as CdpRunner["send"],
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

describe("handleScrollTo", () => {
  it("scrolls a ref into view and returns its visible top-viewport bounds", async () => {
    const manager = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await manager.start("aa11");
    ctx.refStore.set("e3", 1234, { tabId: 4 });
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] }),
    });

    const result = await handleScrollTo(
      manager,
      { session_id: "aa11", ref: "@e3" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    if ("code" in result) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({
      tab_id: 4,
      used_ref: "e3",
      x: 10,
      y: 20,
      width: 100,
      height: 40,
    });
    expect(fake.sent.map((call) => call.method)).toEqual([
      "DOM.scrollIntoViewIfNeeded",
      "DOM.getContentQuads",
      "Page.getLayoutMetrics",
    ]);
  });

  it("scrolls OOPIF refs through their parent frame and CDP session", async () => {
    const manager = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    const ctx = await manager.start("aa11");
    ctx.refStore.set("e3", 1234, {
      tabId: 4,
      frameId: "child-frame",
      cdpSessionId: "child-session",
    });
    const fake = makeFakeCdp({
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getBoxModel": () => ({
        model: { content: [204, 306, 604, 306, 604, 506, 204, 506] },
      }),
    });
    fake.cdp.getFrameGraph = vi.fn(async () => ({
      rootFrameId: "main",
      frames: [
        { frameId: "main", target: { tabId: 4 } },
        {
          frameId: "child-frame",
          parentFrameId: "main",
          ownerBackendNodeId: 99,
          target: { tabId: 4, sessionId: "child-session" },
        },
      ],
    }));
    const targetCalls: Array<{ sessionId?: string; method: string }> = [];
    fake.cdp.sendToTarget = vi.fn(async (target, method) => {
      targetCalls.push({ sessionId: target.sessionId, method });
      if (method === "DOM.scrollIntoViewIfNeeded") return {};
      if (method === "DOM.getContentQuads") {
        return { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] };
      }
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 200, clientHeight: 100 } };
      }
      throw new Error(`unexpected child CDP call ${method}`);
    }) as CdpRunner["sendToTarget"];

    const result = await handleScrollTo(
      manager,
      { session_id: "aa11", ref: "@e3" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi },
    );

    if ("code" in result) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ x: 224, y: 346, width: 200, height: 80 });
    expect(targetCalls).toEqual([
      { sessionId: "child-session", method: "DOM.scrollIntoViewIfNeeded" },
      { sessionId: "child-session", method: "DOM.getContentQuads" },
      { sessionId: "child-session", method: "Page.getLayoutMetrics" },
    ]);
  });

  it("does not issue CDP calls after an early cancellation", async () => {
    const manager = new SessionManager({ agentWindow: fakeAgentWindow([100]) });
    await manager.start("aa11");
    const abort = new AbortController();
    abort.abort();
    const fake = makeFakeCdp({});

    const result = await handleScrollTo(
      manager,
      { session_id: "aa11", selector: "#target" },
      { cdp: fake.cdp, tabsApi: fake.tabsApi, signal: abort.signal },
    );

    expect(result).toMatchObject({ code: "cancelled" });
    expect(fake.cdp.send).not.toHaveBeenCalled();
  });
});
