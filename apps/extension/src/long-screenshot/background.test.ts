import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachLongScreenshot } from "./background";
import { capturePage } from "./capture";
import { captureManual } from "./manual";
import { removeTiledScreenshot, TileWriter } from "./tiles";
import {
  type CaptureReply,
  type CaptureState,
  LONG_SCREENSHOT,
  LONG_SCREENSHOT_STATE,
  ScreenshotError,
} from "./types";

vi.mock("./capture", () => ({ capturePage: vi.fn() }));
vi.mock("./source", () => ({
  openScreenshotSource: vi.fn(async () => ({ capture: vi.fn(), close: vi.fn() })),
}));
vi.mock("./manual", () => ({ captureManual: vi.fn() }));
vi.mock("./tiles", () => ({
  TileWriter: vi.fn(
    class {
      shot = { width: 0, height: 0, title: "Example" };
      finish = vi.fn(async () => {});
      write = vi.fn(
        async (
          _bitmap: unknown,
          width: number,
          _source: number,
          target: number,
          height: number,
        ) => {
          this.shot.width = width;
          this.shot.height = target + height;
        },
      );
    },
  ),
  readTiledScreenshot: vi.fn(async () => undefined),
  removeTiledScreenshot: vi.fn(async () => {}),
}));

function event() {
  const listeners = new Set<(...args: unknown[]) => void>();
  return {
    addListener: vi.fn((listener: (...args: unknown[]) => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: (...args: unknown[]) => void) => listeners.delete(listener)),
    emit: (...args: unknown[]) => {
      for (const listener of listeners) listener(...args);
    },
  };
}
function setup(saved: CaptureState | null = null, busy = false) {
  const api = {
    runtime: {
      id: "extension",
      getPlatformInfo: vi.fn(async () => ({})),
      getURL: (p: string) => `chrome-extension://extension${p}`,
      onMessage: event(),
    },
    tabs: {
      sendMessage: vi.fn(async () => ({ ok: true, metrics: {} })),
      get: vi.fn(async () => ({
        id: 4,
        windowId: 1,
        active: true,
        url: "https://example.com/",
        status: "complete",
      })),
      query: vi.fn(async () => [
        { id: 4, windowId: 1, active: true, url: "https://example.com/", title: "Example" },
      ]),
      create: vi.fn(async () => ({})),
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onAttached: event(),
    },
    webNavigation: {
      getFrame: vi.fn(async () => ({ documentId: "document" })),
      onBeforeNavigate: event(),
      onCommitted: event(),
    },
    scripting: { executeScript: vi.fn(async (_options: unknown) => []) },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: event() },
    storage: {
      session: {
        get: vi.fn(async () => ({ [LONG_SCREENSHOT_STATE]: saved })),
        set: vi.fn(async (_value: unknown) => {}),
      },
    },
  };
  vi.stubGlobal("chrome", api);
  attachLongScreenshot({ isTabBusy: () => busy });
  const listener = api.runtime.onMessage.addListener.mock.calls[0][0];
  const call = (
    action: string,
    extra: object = {},
    sender: object = { id: "extension", url: "chrome-extension://extension/popup.html" },
  ) =>
    new Promise<CaptureReply>((resolve) =>
      listener({ type: LONG_SCREENSHOT, action, ...extra }, sender, resolve),
    );
  return { api, call };
}

let resolveCapture: (result: { width: number; height: number; blob: Blob }) => void;
beforeEach(() => {
  vi.mocked(capturePage)
    .mockReset()
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
  vi.mocked(TileWriter).mockClear();
  vi.mocked(removeTiledScreenshot).mockClear();
  vi.mocked(captureManual)
    .mockReset()
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
});
afterEach(() => vi.unstubAllGlobals());

describe("independent screenshot jobs", () => {
  const completed: CaptureState = {
    id: "previous",
    tabId: 4,
    pageUrl: "https://example.com/",
    title: "Example",
    mode: "auto",
    phase: "complete",
    progress: 100,
    frames: 3,
    width: 800,
    height: 2600,
  };

  it("retains the result when the popup reopens on its source page or its own preview", async () => {
    const { api, call } = setup(completed);
    expect(await call("status")).toMatchObject({ state: completed });
    const [tab] = await api.tabs.query();
    api.tabs.query.mockResolvedValue([
      { ...tab, id: 8, url: "chrome-extension://extension/long-screenshot.html?id=previous" },
    ]);
    api.tabs.onActivated.emit({ tabId: 8, windowId: 1 });
    expect(await call("status")).toMatchObject({ state: completed });
    expect(removeTiledScreenshot).not.toHaveBeenCalled();
  });

  it("retains a result while its newly activated preview URL is still pending", async () => {
    const { api, call } = setup(completed);
    await call("status");
    const [tab] = await api.tabs.query();
    const pending = {
      ...tab,
      id: 8,
      url: "",
      pendingUrl: "chrome-extension://extension/long-screenshot.html?id=previous",
    };
    api.tabs.query.mockResolvedValue([pending]);
    api.tabs.onActivated.emit({ tabId: 8, windowId: 1 });
    expect(await call("status")).toMatchObject({ state: completed });
  });

  it("does not clear a result during the initial blank phase of opening its preview", async () => {
    const { api, call } = setup(completed);
    await call("status");
    let created!: () => void;
    api.tabs.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          created = () => resolve({});
        }),
    );
    const opening = call("preview", { id: completed.id });
    await vi.waitFor(() => expect(created).toBeTypeOf("function"));
    const [tab] = await api.tabs.query();
    api.tabs.query.mockResolvedValue([{ ...tab, id: 8, url: "about:blank" }]);
    api.tabs.onActivated.emit({ tabId: 8, windowId: 1 });
    expect(await call("status")).toMatchObject({ state: completed });
    api.tabs.query.mockResolvedValue([
      { ...tab, id: 8, url: "chrome-extension://extension/long-screenshot.html?id=previous" },
    ]);
    created();
    expect(await opening).toMatchObject({ state: completed });
  });

  it.each([
    "tab",
    "window",
    "status",
    "previewNavigation",
  ])("discards a result on another page through %s", async (change) => {
    const { api, call } = setup(completed);
    await call("status");
    const [tab] = await api.tabs.query();
    api.tabs.query.mockResolvedValue([{ ...tab, id: 9, url: "https://other.example/" }]);
    if (change === "tab") api.tabs.onActivated.emit({ tabId: 9, windowId: 1 });
    if (change === "window") api.windows.onFocusChanged.emit(2);
    if (change === "previewNavigation")
      api.webNavigation.onCommitted.emit({ tabId: 9, frameId: 0 });
    if (change !== "status")
      await vi.waitFor(() =>
        expect(api.storage.session.set).toHaveBeenCalledWith({ [LONG_SCREENSHOT_STATE]: null }),
      );
    expect(await call("status")).toEqual({ ok: true, state: null });
    api.tabs.query.mockResolvedValue([tab]);
    expect(await call("status")).toEqual({ ok: true, state: null });
    expect(await call("preview", { id: completed.id })).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it.each([
    "navigation",
    "route",
    "close",
  ])("clears the result when its source page changes through %s", async (change) => {
    const { api, call } = setup(completed);
    await call("status");
    if (change === "navigation") api.webNavigation.onCommitted.emit({ tabId: 4, frameId: 0 });
    if (change === "route") api.tabs.onUpdated.emit(4, { url: "https://example.com/next" });
    if (change === "close") api.tabs.onRemoved.emit(4);
    await vi.waitFor(() =>
      expect(api.storage.session.set).toHaveBeenCalledWith({ [LONG_SCREENSHOT_STATE]: null }),
    );
    expect(await call("status")).toEqual({ ok: true, state: null });
  });

  it("does not discard a result for background tabs, subframes or an unfocused browser", async () => {
    const { api, call } = setup(completed);
    await call("status");
    api.webNavigation.onCommitted.emit({ tabId: 4, frameId: 2 });
    api.webNavigation.onCommitted.emit({ tabId: 9, frameId: 0 });
    api.tabs.onUpdated.emit(4, { status: "loading" });
    api.tabs.onUpdated.emit(9, { url: "https://other.example/" });
    api.tabs.onRemoved.emit(9);
    api.windows.onFocusChanged.emit(-1);
    expect(await call("status")).toMatchObject({ state: completed });
  });

  it("checks the current URL after restoring a completed state", async () => {
    const { api, call } = setup(completed);
    const [tab] = await api.tabs.query();
    api.tabs.query.mockResolvedValue([{ ...tab, url: "https://example.com/next" }]);
    expect(await call("status")).toEqual({ ok: true, state: null });
  });

  it("does not let a delayed page check clear a new capture", async () => {
    const { api, call } = setup(completed);
    await call("status");
    const [tab] = await api.tabs.query();
    let answer!: (tabs: (typeof tab)[]) => void;
    api.tabs.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    api.tabs.onActivated.emit({ tabId: 9, windowId: 1 });
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    const started = await call("start");
    await vi.waitFor(() => expect(capturePage).toHaveBeenCalledOnce());
    answer([{ ...tab, id: 9, url: "https://other.example/" }]);
    expect(await call("status")).toMatchObject({ state: { phase: "preparing", pageUrl: tab.url } });
    if (started.ok && started.state) await call("cancel", { id: started.state.id });
    resolveCapture({ width: 0, height: 0, blob: new Blob() });
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({ state: { phase: "cancelled" } }),
    );
  });

  it.each([
    new Error("Receiving end does not exist"),
    undefined,
  ])("reconnects an existing document without silently switching to manual (%s)", async (missing) => {
    const { api, call } = setup();
    if (missing) api.tabs.sendMessage.mockRejectedValueOnce(missing);
    else api.tabs.sendMessage.mockResolvedValueOnce(undefined as never);
    await call("start");
    await vi.waitFor(() => expect(capturePage).toHaveBeenCalledOnce());
    expect(api.scripting.executeScript).toHaveBeenCalledExactlyOnceWith({
      target: { tabId: 4, documentIds: ["document"] },
      files: ["content-scripts/long-screenshot-page.js"],
    });
    expect(await call("status")).toMatchObject({ state: { mode: "auto" } });
    expect(captureManual).not.toHaveBeenCalled();
    const status = await call("status");
    if (status.ok && status.state) await call("cancel", { id: status.state.id });
    resolveCapture({ width: 0, height: 0, blob: new Blob() });
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({ state: { phase: "cancelled" } }),
    );
  });

  it("explains denied script access and waits for an explicit manual request", async () => {
    const { api, call } = setup();
    api.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    api.scripting.executeScript.mockRejectedValue(new Error("Cannot access contents of url"));
    await call("start");
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({
        state: { mode: "auto", phase: "error", error: "autoUnavailable" },
      }),
    );
    expect(capturePage).not.toHaveBeenCalled();
    expect(captureManual).not.toHaveBeenCalled();
    await call("start", { mode: "manual" });
    await vi.waitFor(() => expect(captureManual).toHaveBeenCalled());
    expect(api.scripting.executeScript).toHaveBeenCalledOnce();
    const status = await call("status");
    if (status.ok && status.state) await call("cancel", { id: status.state.id });
    resolveCapture({ width: 0, height: 0, blob: new Blob() });
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({ state: { phase: "cancelled" } }),
    );
  });

  it("does not repeatedly inject when the repaired document still cannot reply", async () => {
    const { api, call } = setup();
    api.tabs.sendMessage.mockResolvedValue(undefined as never);
    await call("start");
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({
        state: { mode: "auto", phase: "error", error: "autoUnavailable" },
      }),
    );
    expect(api.scripting.executeScript).toHaveBeenCalledOnce();
    expect(capturePage).not.toHaveBeenCalled();
    expect(captureManual).not.toHaveBeenCalled();
  });

  it.each([
    "timeout",
    "changed",
    "busy",
  ] as const)("preserves %s instead of retrying or starting a manual capture", async (code) => {
    const { api, call } = setup();
    api.tabs.sendMessage.mockRejectedValueOnce(new ScreenshotError(code));
    await call("start");
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({
        state: { mode: "auto", phase: "error", error: code },
      }),
    );
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    expect(capturePage).not.toHaveBeenCalled();
    expect(captureManual).not.toHaveBeenCalled();
  });

  it("cancels while reconnecting and ignores late injection completion", async () => {
    const { api, call } = setup();
    api.tabs.sendMessage.mockRejectedValueOnce(new Error("Receiving end does not exist"));
    let injected!: () => void;
    api.scripting.executeScript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          injected = () => resolve([]);
        }),
    );
    const reply = await call("start");
    if (!reply.ok || !reply.state) throw new Error("missing job");
    await vi.waitFor(() => expect(api.scripting.executeScript).toHaveBeenCalledOnce());
    await call("cancel", { id: reply.state.id });
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({ state: { phase: "cancelled" } }),
    );
    injected();
    expect(capturePage).not.toHaveBeenCalled();
    expect(captureManual).not.toHaveBeenCalled();
    expect(api.tabs.sendMessage).toHaveBeenCalledOnce();
  });
  it("saves a completed result and opens the extension preview", async () => {
    const { api, call } = setup();
    expect(await call("start")).toMatchObject({
      ok: true,
      state: { phase: "preparing", tabId: 4 },
    });
    await vi.waitFor(() => expect(capturePage).toHaveBeenCalledOnce());
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    await vi.mocked(capturePage).mock.calls[0][0].write({} as ImageBitmap, 800, 0, 0, 2600);
    resolveCapture({ width: 800, height: 2600, blob: new Blob(["png"]) });
    await vi.waitFor(() => expect(api.tabs.create).toHaveBeenCalledOnce());
    expect(TileWriter).toHaveBeenCalledOnce();
    expect(await call("status")).toMatchObject({
      ok: true,
      state: { phase: "complete", width: 800, height: 2600 },
    });
    expect(api.tabs.onActivated.removeListener).toHaveBeenCalled();
    expect(api.webNavigation.onBeforeNavigate.removeListener).toHaveBeenCalled();
    expect(api.webNavigation.onCommitted.removeListener).toHaveBeenCalled();
  });

  it("continues while an embedded frame makes the tab report loading", async () => {
    const { api, call } = setup();
    await call("start");
    await vi.waitFor(() => expect(capturePage).toHaveBeenCalledOnce());
    api.webNavigation.onBeforeNavigate.emit({ tabId: 4, frameId: 12 });
    api.webNavigation.onCommitted.emit({ tabId: 4, frameId: 12 });
    api.tabs.onUpdated.emit(4, { status: "loading" });
    const tab = await api.tabs.get();
    api.tabs.get.mockResolvedValue({ ...tab, status: "loading" });
    const deps = vi.mocked(capturePage).mock.calls[0][0];
    await expect(deps.page({ action: "inspect" })).resolves.toEqual({});
    expect(deps.signal.aborted).toBe(false);
    await deps.write({} as ImageBitmap, 800, 0, 0, 512);
    resolveCapture({ width: 800, height: 512, blob: new Blob() });
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({ state: { phase: "complete", height: 512 } }),
    );
  });

  it.each([
    "onBeforeNavigate",
    "onCommitted",
  ] as const)("stops on top-level navigation via %s, including same-URL reloads", async (event) => {
    const { api, call } = setup();
    await call("start");
    await vi.waitFor(() => expect(capturePage).toHaveBeenCalledOnce());
    api.webNavigation[event].emit({ tabId: 4, frameId: 0 });
    expect(vi.mocked(capturePage).mock.calls[0][0].signal.aborted).toBe(true);
    resolveCapture({ width: 0, height: 0, blob: new Blob() });
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({ state: { phase: "error", error: "changed" } }),
    );
  });

  it("keeps durable rows and labels the preview when a later exposure fails", async () => {
    vi.mocked(capturePage).mockImplementationOnce(async (deps) => {
      await deps.write({} as ImageBitmap, 800, 0, 0, 512);
      throw new ScreenshotError("changed");
    });
    const { call, api } = setup();
    await call("start");
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({
        state: { phase: "complete", partial: true, notice: "changed", height: 512 },
      }),
    );
    expect(removeTiledScreenshot).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(api.tabs.create).toHaveBeenCalledWith({
        url: expect.stringContaining("&notice=changed"),
      }),
    );
  });
  it("cleans up an uncommitted capture when its first exposure fails", async () => {
    vi.mocked(capturePage).mockRejectedValueOnce(new ScreenshotError("captureFailed"));
    const { call, api } = setup();
    await call("start");
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({
        state: { phase: "error", error: "captureFailed" },
      }),
    );
    expect(removeTiledScreenshot).toHaveBeenCalledOnce();
    expect(api.tabs.create).not.toHaveBeenCalled();
  });

  it("rejects concurrent jobs and does not save a cancelled result", async () => {
    const { api, call } = setup();
    const reply = await call("start");
    if (!reply.ok || !reply.state) throw new Error("missing job");
    await vi.waitFor(() => expect(capturePage).toHaveBeenCalledOnce());
    expect(await call("start")).toEqual({ ok: false, error: "busy" });
    await call("cancel", { id: reply.state.id });
    resolveCapture({ width: 800, height: 2600, blob: new Blob(["png"]) });
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({ state: { phase: "cancelled" } }),
    );
    expect(removeTiledScreenshot).toHaveBeenCalledOnce();
    expect(api.tabs.create).not.toHaveBeenCalled();
  });

  it("does not accept page-origin start requests or touch an Agent-controlled tab", async () => {
    const { call } = setup(null, true);
    expect(
      await call(
        "start",
        {},
        { id: "extension", url: "https://example.com/", tab: { id: 4 }, frameId: 0 },
      ),
    ).toEqual({ ok: false, error: "unsupported" });
    expect(await call("start")).toEqual({ ok: false, error: "busy" });
    expect(capturePage).not.toHaveBeenCalled();
  });

  it("marks an in-memory job interrupted after a worker restart", async () => {
    const { call } = setup({
      id: "old",
      tabId: 4,
      title: "Old",
      phase: "capturing",
      progress: 50,
      frames: 3,
    });
    expect(await call("status")).toMatchObject({ state: { phase: "error", error: "interrupted" } });
  });
});
