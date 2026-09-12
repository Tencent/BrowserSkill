import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePage } from "@/long-screenshot/capture";
import { ScreenshotExports } from "@/long-screenshot/exports";
import { exportPng } from "@/long-screenshot/png";
import { SessionManager } from "@/session-manager/manager";
import { handleFullPageScreenshot } from "../screenshot-full-page";

vi.mock("@/long-screenshot/page-client", () => ({
  createPageClient: () => ({ documentId: "document-one", prepare: async () => {}, page: vi.fn() }),
}));
vi.mock("@/long-screenshot/capture", () => ({ capturePage: vi.fn(async () => {}) }));
vi.mock("@/long-screenshot/source", () => ({
  openScreenshotSource: async () => ({ capture: vi.fn(), close: async () => {} }),
}));
vi.mock("@/long-screenshot/tiles", () => ({
  TileWriter: class {
    shot = { width: 64, height: 256 };
    async finish() {}
  },
}));
vi.mock("@/long-screenshot/png", () => ({ exportPng: vi.fn(async () => new Blob(["png"])) }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

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

async function setupCapture() {
  const context = await setup();
  const events = Array.from({ length: 6 }, () => ({
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  const sendMessage = vi.fn(
    async (_tabId: number, _message: { phase: string }, _options: object) => ({}),
  );
  vi.stubGlobal("chrome", {
    webNavigation: { onBeforeNavigate: events[0], onCommitted: events[1] },
    tabs: { onRemoved: events[2], onAttached: events[3], onActivated: events[4], sendMessage },
    runtime: { id: "extension", onMessage: events[5] },
  });
  vi.spyOn(context.deps.exports, "prepare").mockResolvedValue();
  vi.spyOn(context.deps.exports, "discard").mockResolvedValue();
  return { ...context, events, sendMessage };
}

describe("full-page screenshot overlay cleanup", () => {
  it.each([
    { phase: "begin", cancel: true },
    { phase: "begin", cancel: false },
    { phase: "end", cancel: true },
    { phase: "end", cancel: false },
  ])("settles when $phase stalls (cancel=$cancel) and releases the job", async ({
    phase,
    cancel,
  }) => {
    vi.useFakeTimers();
    const { manager, deps, events, sendMessage } = await setupCapture();
    let lateReply!: () => void;
    const pending = new Promise<void>((resolve) => {
      lateReply = resolve;
    });
    sendMessage.mockImplementation(async (_id, message) => {
      if (message.phase === phase) await pending;
      return {};
    });
    const controller = new AbortController();
    const result = handleFullPageScreenshot(
      manager,
      { session_id: "one", timeout_ms: cancel ? 120_000 : 50 },
      deps,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    if (cancel) controller.abort();
    await vi.advanceTimersByTimeAsync(1100);
    expect(await result).toMatchObject({ code: cancel ? "cancelled" : "timeout" });
    expect(sendMessage.mock.calls.map(([, message]) => message.phase)).toEqual(["begin", "end"]);
    for (const [tabId, , options] of sendMessage.mock.calls) {
      expect(tabId).toBe(7);
      expect(options).toEqual({ documentId: "document-one" });
    }
    if (phase === "begin") expect(capturePage).not.toHaveBeenCalled();
    expect(exportPng).not.toHaveBeenCalled();
    expect(deps.exports.discard).toHaveBeenCalledOnce();
    for (const event of events)
      expect(event.removeListener).toHaveBeenCalledWith(event.addListener.mock.calls[0][0]);
    lateReply();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps successful captures and tolerates a missing overlay script", async () => {
    const { manager, deps, sendMessage } = await setupCapture();
    sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    const result = await handleFullPageScreenshot(manager, { session_id: "one" }, deps);
    expect(result).toMatchObject({ width: 64, height: 256, format: "png", byte_size: 3 });
    expect(capturePage).toHaveBeenCalledOnce();
    expect(deps.exports.discard).not.toHaveBeenCalled();
    await deps.exports.dispose();
  });
});
