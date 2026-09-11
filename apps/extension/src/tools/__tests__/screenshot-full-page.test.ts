import { describe, expect, it, vi } from "vitest";
import { ScreenshotExports } from "@/long-screenshot/exports";
import { SessionManager } from "@/session-manager/manager";
import { handleFullPageScreenshot } from "../screenshot-full-page";

async function setup() {
  const manager = new SessionManager({
    agentWindow: {
      create: async () => 100,
      remove: async () => {},
      ensureActiveTab: async () => 7,
    },
  });
  await manager.start("one");
  const tab = {
    id: 7,
    windowId: 100,
    active: true,
    url: "https://example.test/",
  } as chrome.tabs.Tab;
  const cdp = {
    send: vi.fn(async () => {
      throw new Error("Unexpected CDP call");
    }),
  };
  const deps = {
    cdp,
    tabsApi: { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]) },
    exports: new ScreenshotExports((id) => manager.has(id)),
  };
  return { manager, tab, deps };
}

describe("full-page screenshot target policy", () => {
  it("rejects cancellation and invalid deadlines before browser work", async () => {
    const { manager, deps } = await setup();
    const controller = new AbortController();
    controller.abort();
    expect(
      await handleFullPageScreenshot(manager, { session_id: "one" }, deps, controller.signal),
    ).toMatchObject({ code: "cancelled" });
    for (const timeout_ms of [0, -1, 0.5, 0x100000000, NaN])
      expect(
        await handleFullPageScreenshot(manager, { session_id: "one", timeout_ms }, deps),
      ).toMatchObject({ code: "invalid_params" });
    expect(deps.tabsApi.query).not.toHaveBeenCalled();
    expect(deps.cdp.send).not.toHaveBeenCalled();
  });
  it("requires a selected, explicitly controlled tab in the Agent Window", async () => {
    const { manager, tab, deps } = await setup();
    tab.windowId = 200;
    expect(
      await handleFullPageScreenshot(manager, { session_id: "one", tab_id: 7 }, deps),
    ).toMatchObject({ code: "permission_denied" });
    tab.windowId = 100;
    manager.get("one")!.agentCreatedTabs.clear();
    expect(await handleFullPageScreenshot(manager, { session_id: "one" }, deps)).toMatchObject({
      code: "permission_denied",
    });
    manager.get("one")!.agentCreatedTabs.add(7);
    tab.active = false;
    expect(await handleFullPageScreenshot(manager, { session_id: "one" }, deps)).toMatchObject({
      code: "invalid_params",
      data: { reason: "tab_not_active" },
    });
    expect(deps.cdp.send).not.toHaveBeenCalled();
  });
  it("does not attempt automatic scrolling on browser-internal or non-web pages", async () => {
    const { manager, tab, deps } = await setup();
    tab.url = "chrome://settings";
    expect(await handleFullPageScreenshot(manager, { session_id: "one" }, deps)).toMatchObject({
      code: "permission_denied",
    });
    tab.url = "about:blank";
    expect(await handleFullPageScreenshot(manager, { session_id: "one" }, deps)).toMatchObject({
      code: "unsupported",
    });
    expect(deps.cdp.send).not.toHaveBeenCalled();
  });
});
