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
  return { addListener: vi.fn(), removeListener: vi.fn() };
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
    webNavigation: { getFrame: vi.fn(async () => ({ documentId: "document" })) },
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
  it("offers manual capture for documents without script access", async () => {
    const { api, call } = setup();
    api.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    await call("start");
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({
        state: { mode: "manual" },
      }),
    );
    expect(capturePage).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(captureManual).toHaveBeenCalled());
    const status = await call("status");
    if (status.ok && status.state) await call("cancel", { id: status.state.id });
    resolveCapture({ width: 0, height: 0, blob: new Blob() });
  });
  it("saves a completed result and opens the extension preview", async () => {
    const { api, call } = setup();
    expect(await call("start")).toMatchObject({
      ok: true,
      state: { phase: "preparing", tabId: 4 },
    });
    await vi.waitFor(() => expect(capturePage).toHaveBeenCalledOnce());
    await vi.mocked(capturePage).mock.calls[0][0].write({} as ImageBitmap, 800, 0, 0, 2600);
    resolveCapture({ width: 800, height: 2600, blob: new Blob(["png"]) });
    await vi.waitFor(() => expect(api.tabs.create).toHaveBeenCalledOnce());
    expect(TileWriter).toHaveBeenCalledOnce();
    expect(await call("status")).toMatchObject({
      ok: true,
      state: { phase: "complete", width: 800, height: 2600 },
    });
    expect(api.tabs.onActivated.removeListener).toHaveBeenCalled();
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
