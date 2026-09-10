import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachLongScreenshot } from "./background";
import { capturePage } from "./capture";
import { saveScreenshot } from "./storage";
import {
  type CaptureReply,
  type CaptureState,
  LONG_SCREENSHOT,
  LONG_SCREENSHOT_STATE,
} from "./types";

vi.mock("./capture", () => ({ capturePage: vi.fn() }));
vi.mock("./source", () => ({
  openScreenshotSource: vi.fn(async () => ({ capture: vi.fn(), close: vi.fn() })),
}));
vi.mock("./storage", () => ({ saveScreenshot: vi.fn(async () => {}) }));

function event() {
  return { addListener: vi.fn(), removeListener: vi.fn() };
}
function setup(saved: CaptureState | null = null, busy = false) {
  const api = {
    runtime: {
      id: "extension",
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
  vi.mocked(saveScreenshot).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("independent screenshot jobs", () => {
  it("reports inaccessible documents before starting the capture engine", async () => {
    const { api, call } = setup();
    api.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    await call("start");
    await vi.waitFor(async () =>
      expect(await call("status")).toMatchObject({
        state: { phase: "error", error: "unavailable" },
      }),
    );
    expect(capturePage).not.toHaveBeenCalled();
  });
  it("saves a completed result and opens the extension preview", async () => {
    const { api, call } = setup();
    expect(await call("start")).toMatchObject({
      ok: true,
      state: { phase: "preparing", tabId: 4 },
    });
    await vi.waitFor(() => expect(capturePage).toHaveBeenCalledOnce());
    resolveCapture({ width: 800, height: 2600, blob: new Blob(["png"]) });
    await vi.waitFor(() => expect(api.tabs.create).toHaveBeenCalledOnce());
    expect(saveScreenshot).toHaveBeenCalledOnce();
    expect(await call("status")).toMatchObject({
      ok: true,
      state: { phase: "complete", width: 800, height: 2600 },
    });
    expect(api.tabs.onActivated.removeListener).toHaveBeenCalled();
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
    expect(saveScreenshot).not.toHaveBeenCalled();
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
