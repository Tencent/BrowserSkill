import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePage } from "@/long-screenshot/capture";
import { ScreenshotExports } from "@/long-screenshot/exports";
import { exportPng } from "@/long-screenshot/png";
import { SessionManager } from "@/session-manager/manager";
import { handleFullPageScreenshot } from "../screenshot-full-page";
import type { CdpRunner } from "../shared";

vi.mock("@/long-screenshot/page-client", () => ({
  createPageClient: () => ({ documentId: "document-one", prepare: async () => {}, page: vi.fn() }),
}));
vi.mock("@/long-screenshot/capture", () => ({ capturePage: vi.fn(async () => {}) }));
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
  vi.mocked(capturePage).mockReset().mockResolvedValue({ width: 64, height: 256 });
});

async function setup() {
  const manager = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 100, initialTabIds: [] }),
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
  let onEvent: Parameters<NonNullable<CdpRunner["onEvent"]>>[0] | undefined;
  const disposeEvents = vi.fn(() => {
    onEvent = undefined;
  });
  const cdp = {
    onEvent: vi.fn((handler: NonNullable<typeof onEvent>) => {
      onEvent = handler;
      return { dispose: disposeEvents };
    }),
    getAttachmentId: vi.fn(() => "attachment-one" as string | undefined),
    send: vi.fn(async <T>(_id: number, method: string, _params?: object): Promise<T> => {
      if (method === "Page.startScreencast") {
        onEvent?.({ tabId: 7 }, "Page.screencastFrame", { sessionId: 1 });
        return {} as T;
      }
      if (method === "Page.stopScreencast" || method === "Page.screencastFrameAck") return {} as T;
      if (method === "Page.getFrameTree") return {} as T;
      if (method === "Page.captureScreenshot") return { data: "cG5n" } as T;
      throw new Error(`Unexpected CDP call: ${method}`);
    }),
  };
  const deps = {
    cdp: cdp as CdpRunner & typeof cdp,
    tabsApi: { get: vi.fn(async () => tab), query: vi.fn(async () => [tab]) },
    exports: new ScreenshotExports((id) => manager.has(id)),
  };
  return { manager, tab, deps, disposeEvents };
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
  it("requires an explicitly controlled tab in the Agent Window", async () => {
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
    webNavigation: {
      onBeforeNavigate: events[0],
      onCommitted: events[1],
      getFrame: vi.fn(async () => ({ documentId: "document-one" })),
    },
    tabs: { onRemoved: events[2], onAttached: events[3], onActivated: events[4], sendMessage },
    runtime: {
      id: "extension",
      onMessage: events[5],
      getPlatformInfo: vi.fn(async () => ({ os: "mac" })),
    },
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
    expect(events[4].addListener).not.toHaveBeenCalled();
    for (const event of events.filter((_, index) => index !== 4))
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

describe("full-page background capture", () => {
  it.each([
    false,
    true,
  ])("uses only target CDP when active=%s and tolerates other tab selection", async (active) => {
    const { manager, tab, deps, events } = await setupCapture();
    tab.active = active;
    const bitmap = { close: vi.fn() };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => bitmap),
    );
    vi.mocked(capturePage).mockImplementationOnce(async (options) => {
      expect(await options.screenshot()).toBe(bitmap);
      tab.active = false;
      for (const [listener] of events[4].addListener.mock.calls)
        listener({ tabId: 99, windowId: 100 });
      expect(await options.screenshot()).toBe(bitmap);
      return { width: 64, height: 256 };
    });
    expect(
      await handleFullPageScreenshot(manager, { session_id: "one", tab_id: 7 }, deps),
    ).toMatchObject({ width: 64, height: 256 });
    expect(
      deps.cdp.send.mock.calls.filter(([, method]) => method === "Page.captureScreenshot"),
    ).toEqual(
      Array.from({ length: 2 }, () => [
        7,
        "Page.captureScreenshot",
        {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
        },
      ]),
    );
    expect(events[4].addListener).not.toHaveBeenCalled();
    await deps.exports.dispose();
  });

  it.each([
    "attachment",
    "document",
    "control",
    "window",
    "navigation",
  ])("discards the job when %s changes between tiles", async (change) => {
    const { manager, tab, deps, events, sendMessage } = await setupCapture();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ close() {} })),
    );
    vi.mocked(capturePage).mockImplementationOnce(async (options) => {
      await options.screenshot();
      if (change === "attachment") deps.cdp.getAttachmentId.mockReturnValue("attachment-two");
      if (change === "document")
        vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({
          documentId: "document-two",
        } as never);
      if (change === "control") manager.get("one")!.agentCreatedTabs.clear();
      if (change === "window") tab.windowId = 200;
      if (change === "navigation") events[0].addListener.mock.calls[0][0]({ tabId: 7, frameId: 0 });
      await options.screenshot();
      return { width: 64, height: 256 };
    });
    expect(await handleFullPageScreenshot(manager, { session_id: "one" }, deps)).toMatchObject({
      code: "cdp_failed",
    });
    expect(
      deps.cdp.send.mock.calls.filter(([, method]) => method === "Page.captureScreenshot"),
    ).toHaveLength(1);
    expect(exportPng).not.toHaveBeenCalled();
    expect(deps.exports.discard).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenLastCalledWith(7, expect.objectContaining({ phase: "end" }), {
      documentId: "document-one",
    });
  });

  it.each([
    "attachment",
    "document",
    "control",
  ])("does not publish after %s changes while encoding", async (change) => {
    const { manager, deps } = await setupCapture();
    const put = vi.spyOn(deps.exports, "put");
    vi.mocked(exportPng).mockImplementationOnce(async () => {
      if (change === "attachment") deps.cdp.getAttachmentId.mockReturnValue(undefined);
      if (change === "document")
        vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue({
          documentId: "document-two",
        } as never);
      if (change === "control") manager.get("one")!.agentCreatedTabs.clear();
      return new File(["png"], "page.png");
    });
    expect(await handleFullPageScreenshot(manager, { session_id: "one" }, deps)).toMatchObject({
      code: "cdp_failed",
    });
    expect(put).not.toHaveBeenCalled();
    expect(deps.exports.discard).toHaveBeenCalledOnce();
  });

  it("rejects a screenshot whose attachment changes during the CDP reply", async () => {
    const { manager, deps } = await setupCapture();
    deps.cdp.send.mockImplementation(async <T>(_id: number, method: string): Promise<T> => {
      if (method === "Page.captureScreenshot") {
        deps.cdp.getAttachmentId.mockReturnValue("replacement");
        return { data: "cG5n" } as T;
      }
      return {} as T;
    });
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    vi.mocked(capturePage).mockImplementationOnce(async (options) => {
      await options.screenshot();
      return { width: 64, height: 256 };
    });
    expect(await handleFullPageScreenshot(manager, { session_id: "one" }, deps)).toMatchObject({
      code: "cdp_failed",
    });
    expect(decode).not.toHaveBeenCalled();
    expect(deps.exports.discard).toHaveBeenCalledOnce();
  });
});

describe("full-page capture interruption", () => {
  it("honors cancellation from the original document only", async () => {
    const { manager, deps, events } = await setupCapture();
    vi.mocked(capturePage).mockImplementationOnce(async (options) => {
      const listener = events[5].addListener.mock.calls[0][0];
      const jobId = "agent-test";
      listener(
        { type: "bsk/long-screenshot", action: "cancel", id: jobId },
        {
          id: "extension",
          tab: { id: 7 },
          frameId: 0,
          documentId: "other-document",
        },
      );
      expect(options.signal.aborted).toBe(false);
      listener(
        { type: "bsk/long-screenshot", action: "cancel", id: jobId },
        {
          id: "extension",
          tab: { id: 7 },
          frameId: 0,
          documentId: "document-one",
        },
      );
      options.signal.throwIfAborted();
      return { width: 64, height: 256 };
    });
    vi.spyOn(crypto, "randomUUID").mockReturnValue("test" as ReturnType<typeof crypto.randomUUID>);
    expect(await handleFullPageScreenshot(manager, { session_id: "one" }, deps)).toMatchObject({
      code: "cancelled",
    });
    expect(exportPng).not.toHaveBeenCalled();
    expect(deps.exports.discard).toHaveBeenCalledOnce();
  });

  it("bounds a stalled CDP capture and restores the overlay", async () => {
    vi.useFakeTimers();
    const { manager, deps, sendMessage } = await setupCapture();
    deps.cdp.send.mockImplementation(async <T>(_id: number, method: string): Promise<T> => {
      if (method === "Page.captureScreenshot") return new Promise<T>(() => {});
      return {} as T;
    });
    vi.mocked(capturePage).mockImplementationOnce(async (options) => {
      await options.screenshot();
      return { width: 64, height: 256 };
    });
    const pending = handleFullPageScreenshot(manager, { session_id: "one", timeout_ms: 50 }, deps);
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toMatchObject({ code: "timeout" });
    expect(sendMessage).toHaveBeenLastCalledWith(7, expect.objectContaining({ phase: "end" }), {
      documentId: "document-one",
    });
    expect(deps.exports.discard).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

async function setupWindowsCapture() {
  const context = await setupCapture();
  context.tab.active = false;
  vi.mocked(chrome.runtime.getPlatformInfo).mockResolvedValue({
    os: "win",
  } as chrome.runtime.PlatformInfo);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ close() {} })),
  );
  return context;
}

describe("Windows full-page rendering lifetime", () => {
  it("starts rendering once if the target becomes inactive between tiles", async () => {
    const { manager, tab, deps, disposeEvents } = await setupWindowsCapture();
    tab.active = true;
    vi.mocked(capturePage).mockImplementationOnce(async (options) => {
      await options.screenshot();
      expect(deps.cdp.onEvent).not.toHaveBeenCalled();
      tab.active = false;
      await options.screenshot();
      await options.screenshot();
      return { width: 64, height: 256 };
    });
    expect(await handleFullPageScreenshot(manager, { session_id: "one" }, deps)).toMatchObject({
      format: "png",
    });
    expect(
      deps.cdp.send.mock.calls.filter(([, method]) => method === "Page.startScreencast"),
    ).toHaveLength(1);
    expect(disposeEvents).toHaveBeenCalledOnce();
    await deps.exports.dispose();
  });

  it("acknowledges only frames from the original target and attachment", async () => {
    const { manager, deps, disposeEvents } = await setupWindowsCapture();
    vi.mocked(capturePage).mockImplementationOnce(async (options) => {
      await options.screenshot();
      const frame = deps.cdp.onEvent.mock.calls[0][0];
      frame({ tabId: 99 }, "Page.screencastFrame", { sessionId: 2 });
      frame({ tabId: 7, sessionId: "child" }, "Page.screencastFrame", { sessionId: 3 });
      frame({ tabId: 7 }, "Page.screencastVisibilityChanged", {});
      frame({ tabId: 7 }, "Page.screencastFrame", { sessionId: 4 });
      deps.cdp.getAttachmentId.mockReturnValue("replacement");
      frame({ tabId: 7 }, "Page.screencastFrame", { sessionId: 5 });
      return { width: 64, height: 256 };
    });
    expect(await handleFullPageScreenshot(manager, { session_id: "one" }, deps)).toMatchObject({
      code: "cdp_failed",
    });
    expect(
      deps.cdp.send.mock.calls
        .filter(([, method]) => method === "Page.screencastFrameAck")
        .map(([, , params]) => params),
    ).toEqual([{ sessionId: 1 }, { sessionId: 4 }]);
    expect(disposeEvents).toHaveBeenCalledOnce();
    expect(deps.exports.discard).toHaveBeenCalledOnce();
  });

  it.each([
    "success",
    "failure",
    "cancel",
    "attachment",
  ])("releases rendering on %s without touching replacement attachments", async (outcome) => {
    const { manager, deps, disposeEvents } = await setupWindowsCapture();
    const controller = new AbortController();
    vi.mocked(capturePage).mockImplementationOnce(async (options) => {
      await options.screenshot();
      expect(deps.cdp.send).toHaveBeenCalledWith(7, "Page.startScreencast", {
        format: "png",
        maxWidth: 32,
        maxHeight: 32,
      });
      expect(deps.cdp.send.mock.calls.some(([, method]) => method === "Page.stopScreencast")).toBe(
        false,
      );
      if (outcome === "failure") throw new Error("capture failed");
      if (outcome === "cancel") controller.abort();
      if (outcome === "attachment") deps.cdp.getAttachmentId.mockReturnValue("replacement");
      return { width: 64, height: 256 };
    });
    const result = await handleFullPageScreenshot(
      manager,
      { session_id: "one" },
      deps,
      controller.signal,
    );
    expect(result).toMatchObject(
      outcome === "success"
        ? { format: "png" }
        : { code: outcome === "cancel" ? "cancelled" : "cdp_failed" },
    );
    expect(
      deps.cdp.send.mock.calls.filter(([, method]) => method === "Page.stopScreencast"),
    ).toHaveLength(outcome === "attachment" ? 0 : 1);
    expect(disposeEvents).toHaveBeenCalledOnce();
    if (outcome !== "success") expect(deps.exports.discard).toHaveBeenCalledOnce();
    await deps.exports.dispose();
  });

  it.each([
    "Page.startScreencast",
    "Page.stopScreencast",
    "Page.captureScreenshot",
  ])("bounds %s and still sends rendering cleanup", async (stalled) => {
    vi.useFakeTimers();
    const { manager, deps } = await setupWindowsCapture();
    const send = deps.cdp.send.getMockImplementation()!;
    deps.cdp.send.mockImplementation(
      async <T>(id: number, method: string, params?: object): Promise<T> => {
        if (method === stalled) return new Promise<T>(() => {});
        return send(id, method, params) as Promise<T>;
      },
    );
    vi.mocked(capturePage).mockImplementationOnce(async (options) => {
      await options.screenshot();
      return { width: 64, height: 256 };
    });
    const result = handleFullPageScreenshot(manager, { session_id: "one", timeout_ms: 50 }, deps);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await result).toMatchObject({ code: "timeout" });
    expect(
      deps.cdp.send.mock.calls.filter(([, method]) => method === "Page.stopScreencast"),
    ).toHaveLength(1);
    expect(deps.exports.discard).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("full-page scope and diagnostics", () => {
  it.each([
    "win",
    "mac",
    "linux",
  ])("acknowledges the selected range and preserves freshness policy on %s", async (os) => {
    const { manager, deps } = await setupCapture();
    vi.mocked(chrome.runtime.getPlatformInfo).mockResolvedValue({
      os,
    } as chrome.runtime.PlatformInfo);
    expect(
      await handleFullPageScreenshot(manager, { session_id: "one", scope: "current" }, deps),
    ).toMatchObject({ scope: "current" });
    expect(vi.mocked(capturePage).mock.calls.at(-1)?.[0]).toMatchObject({
      scope: "current",
      loadingTimeoutMs: 30000,
      checkFreshness: os === "win",
    });
    const renderingCalls = deps.cdp.send.mock.calls
      .filter(([, method]) => method.endsWith("Screencast"))
      .map(([, method]) => method);
    expect(renderingCalls).toEqual([]);
    await deps.exports.dispose();
  });
  it.each([
    "page_hidden",
    "watchdog_timeout",
    "stale_frame",
    "loading_stalled",
  ] as const)("preserves %s and partial progress without exporting", async (reason) => {
    const { manager, deps } = await setupCapture();
    const { ScreenshotError } = await import("@/long-screenshot/types");
    vi.mocked(capturePage).mockImplementationOnce(async (d) => {
      d.progress("capturing", 50, 3);
      throw new ScreenshotError("interrupted", reason);
    });
    expect(await handleFullPageScreenshot(manager, { session_id: "one" }, deps)).toMatchObject({
      data: { reason, frames: 3, progress: 50 },
    });
    expect(exportPng).not.toHaveBeenCalled();
    expect(deps.exports.discard).toHaveBeenCalledOnce();
  });
});
