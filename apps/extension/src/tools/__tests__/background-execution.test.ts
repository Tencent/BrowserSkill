import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { RequestFrame } from "@/transport/types";
import { prepareBackgroundExecution } from "../background-execution";

async function fixture() {
  const manager = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [] }),
      remove: async () => {},
      ensureActiveTab: async () => 1,
    },
  });
  const ctx = await manager.start("agent");
  const tabs = {
    get: vi.fn(
      async (id: number) =>
        ({ id, windowId: 100, url: "https://fixture.test", active: false }) as chrome.tabs.Tab,
    ),
    query: vi.fn(
      async () =>
        [{ id: 1, windowId: 100, url: "https://fixture.test", active: true }] as chrome.tabs.Tab[],
    ),
  };
  const cdp = {
    send: vi.fn(),
    acquireBackgroundExecution: vi.fn(async () => {}),
    releaseSessionTab: vi.fn(async () => {}),
  };
  return { manager, ctx, tabs, cdp };
}

describe("background execution request boundary", () => {
  it.each([
    "tool.snapshot",
    "tool.observe",
    "tool.click",
    "tool.wait_for_navigation",
  ])("prepares an explicit inactive controlled target before %s", async (method) => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.add(7);
    const req: RequestFrame = { id: "r", method, params: { session_id: "agent", tab_id: 7 } };
    expect(
      await prepareBackgroundExecution(f.manager, req, f.cdp, f.tabs, new AbortController().signal),
    ).toBeUndefined();
    expect(f.cdp.acquireBackgroundExecution).toHaveBeenCalledWith("agent", 7);
    expect(f.tabs.query).not.toHaveBeenCalled();
  });

  it.each([
    "tool.navigate",
    "tool.reload",
    "tool.navigate_back",
    "tool.navigate_forward",
  ])("pins %s but delegates preparation to the navigation handler", async (method) => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.add(7);
    f.cdp.acquireBackgroundExecution.mockRejectedValue(new Error("access denied"));
    const request = { id: "r", method, params: { session_id: "agent", tab_id: 7 } };
    expect(
      await prepareBackgroundExecution(
        f.manager,
        request,
        f.cdp,
        f.tabs,
        new AbortController().signal,
      ),
    ).toBeUndefined();
    expect(request.params.tab_id).toBe(7);
    expect(f.cdp.acquireBackgroundExecution).not.toHaveBeenCalled();
  });

  it("does not infer control from same-window passive access", async () => {
    const f = await fixture();
    await prepareBackgroundExecution(
      f.manager,
      { id: "r", method: "tool.snapshot", params: { session_id: "agent", tab_id: 7 } },
      f.cdp,
      f.tabs,
      new AbortController().signal,
    );
    expect(f.cdp.acquireBackgroundExecution).not.toHaveBeenCalled();
  });

  it("releases a target returned while setup was pending", async () => {
    const f = await fixture();
    f.ctx.borrowedTabs.set(7, { tabId: 7, originalWindowId: 200, originalIndex: 1 });
    f.cdp.acquireBackgroundExecution.mockImplementation(async () => {
      f.ctx.borrowedTabs.delete(7);
    });
    expect(
      await prepareBackgroundExecution(
        f.manager,
        { id: "r", method: "tool.observe", params: { session_id: "agent", tab_id: 7 } },
        f.cdp,
        f.tabs,
        new AbortController().signal,
      ),
    ).toMatchObject({ code: "cancelled" });
    expect(f.cdp.releaseSessionTab).toHaveBeenCalledWith("agent", 7);
  });

  it("pins default targeting and reports setup failure instead of waiting for readiness", async () => {
    const f = await fixture();
    f.ctx.agentCreatedTabs.add(1);
    f.cdp.acquireBackgroundExecution.mockRejectedValue(new Error("unsupported"));
    const req: RequestFrame = { id: "r", method: "tool.observe", params: { session_id: "agent" } };
    expect(
      await prepareBackgroundExecution(f.manager, req, f.cdp, f.tabs, new AbortController().signal),
    ).toMatchObject({ code: "cdp_failed", message: expect.stringContaining("unsupported") });
    expect(req.params).toMatchObject({ tab_id: 1 });
  });
});
