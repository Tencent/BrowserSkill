import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openScreenshotSource } from "./source";

const native = vi.fn();
const attach = vi.fn();
const detach = vi.fn();
const sendCommand = vi.fn();
beforeEach(() => {
  native.mockReset().mockResolvedValue("data:image/png;base64,native");
  attach.mockReset().mockResolvedValue(undefined);
  detach.mockReset().mockResolvedValue(undefined);
  sendCommand.mockReset().mockResolvedValue({ data: "renderer" });
  vi.stubGlobal("chrome", {
    tabs: { captureVisibleTab: native },
    debugger: { attach, detach, sendCommand },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("screenshot backends", () => {
  it("keeps a working window capture free of debugger attachments", async () => {
    vi.useFakeTimers();
    const source = await openScreenshotSource(4, 1, new AbortController().signal, async () => {});
    const shot = source.capture();
    await vi.advanceTimersByTimeAsync(600);
    expect(await shot).toContain("native");
    await source.close();
    expect(attach).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it("falls back before page measurement and releases its own attachment", async () => {
    native.mockRejectedValue(new Error("readback failed"));
    const source = await openScreenshotSource(4, 1, new AbortController().signal, async () => {});
    expect(await source.capture()).toBe("data:image/png;base64,renderer");
    expect(sendCommand).toHaveBeenCalledWith({ tabId: 4 }, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    await source.close();
    expect(detach).toHaveBeenCalledExactlyOnceWith({ tabId: 4 });
  });

  it("uses an Agent session's fallback without attaching or detaching its debugger", async () => {
    native.mockRejectedValue(new Error("readback failed"));
    const capture = vi.fn(async () => "data:image/png;base64,session");
    const fallback = vi.fn(async () => ({ capture, close: async () => {} }));
    const source = await openScreenshotSource(
      4,
      1,
      new AbortController().signal,
      async () => {},
      true,
      fallback,
    );
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await source.capture()).toContain("session");
    await source.close();
    expect(attach).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it("does not detach another debugger when attachment fails", async () => {
    native.mockRejectedValue(new Error("readback failed"));
    attach.mockRejectedValue(new Error("Another debugger is already attached"));
    await expect(
      openScreenshotSource(4, 1, new AbortController().signal, async () => {}),
    ).rejects.toThrow("busy");
    expect(detach).not.toHaveBeenCalled();
  });

  it("releases an attachment that succeeds after cancellation", async () => {
    native.mockRejectedValue(new Error("readback failed"));
    let complete: () => void = () => {};
    attach.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const source = openScreenshotSource(4, 1, controller.signal, async () => {});
    const assertion = expect(source).rejects.toBeDefined();
    await vi.waitFor(() => expect(attach).toHaveBeenCalled());
    controller.abort();
    await assertion;
    complete();
    await vi.waitFor(() => expect(detach).toHaveBeenCalledExactlyOnceWith({ tabId: 4 }));
  });
});
