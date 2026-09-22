import { afterEach, expect, it, vi } from "vitest";
import { isAbortError, isCaptureTerminalError } from "@/tools/vom/capture-abort";
import { captureObservationFacts } from "@/tools/vom/capture-coordinator";
import {
  CdpReadTimeoutError,
  READ_TIMEOUT_MS,
  RENDERER_READ_TIMEOUT,
  readTimeoutDetails,
  runCdpCommand,
} from "../command-deadline";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("times out stuck snapshots with the actual method and stops fallback reads", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  const send = vi.fn(async (_tab: number, method: string) =>
    runCdpCommand({ tabId: 4 }, method, () =>
      method === "DOMSnapshot.captureSnapshot" ? new Promise<never>(() => {}) : Promise.resolve({}),
    ),
  );
  const work = captureObservationFacts({ send: send as never }, 4);
  const checked = expect(work).rejects.toThrow(
    "DOMSnapshot.captureSnapshot timed out after 10000ms (tab 4)",
  );
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
  await checked;
  expect(send.mock.calls.map((call) => call[1])).toEqual([
    "DOMSnapshot.enable",
    "DOMSnapshot.captureSnapshot",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start a snapshot after the frame graph read timed out", async () => {
  const send = vi.fn(async () => ({}));
  const getFrameGraph = vi.fn(async () => {
    throw new CdpReadTimeoutError("DOM.getFrameOwner", 4, READ_TIMEOUT_MS);
  });
  await expect(captureObservationFacts({ send, getFrameGraph } as never, 4)).rejects.toThrow(
    "DOM.getFrameOwner timed out",
  );
  expect(send).not.toHaveBeenCalled();
});

it("ignores the late reply of a timed-out read", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  let finish!: (value: object) => void;
  const work = runCdpCommand(
    { tabId: 4 },
    "Accessibility.getFullAXTree",
    () =>
      new Promise<object>((resolve) => {
        finish = resolve;
      }),
  );
  const checked = expect(work).rejects.toBeInstanceOf(CdpReadTimeoutError);
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
  await checked;
  finish({ nodes: [] });
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});

it("handles a late rejection of a timed-out read without an unhandled rejection", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    let fail!: (error: Error) => void;
    const work = runCdpCommand(
      { tabId: 4 },
      "DOMSnapshot.captureSnapshot",
      () =>
        new Promise<object>((_, reject) => {
          fail = reject;
        }),
    );
    const checked = expect(work).rejects.toBeInstanceOf(CdpReadTimeoutError);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await checked;
    fail(new Error("Detached while handling command"));
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    // Node reports unhandled rejections after the microtask queue drains.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});

it("reports a renderer read timeout with a gateway-readable reason", () => {
  expect(
    readTimeoutDetails(new CdpReadTimeoutError("DOMSnapshot.captureSnapshot", 4, READ_TIMEOUT_MS)),
  ).toEqual({ data: { reason: RENDERER_READ_TIMEOUT } });
  expect(readTimeoutDetails(CdpReadTimeoutError.stillPending("Page.getLayoutMetrics", 4))).toEqual({
    data: { reason: RENDERER_READ_TIMEOUT },
  });
  expect(readTimeoutDetails(new Error("boom"))).toEqual({});
});

it("does not bound mutations, screenshots or evaluation", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "debug").mockImplementation(() => {});
  const settled = vi.fn();
  for (const method of ["Page.captureScreenshot", "Runtime.evaluate", "Input.dispatchMouseEvent"]) {
    void runCdpCommand({ tabId: 4 }, method, () => new Promise<never>(() => {})).then(
      settled,
      settled,
    );
  }
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 2);
  expect(settled).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("distinguishes caller timeout from a late Chrome completion", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  let finish!: (value: object) => void;
  const work = runCdpCommand(
    { tabId: 4 },
    "DOMSnapshot.captureSnapshot",
    () =>
      new Promise<object>((resolve) => {
        finish = resolve;
      }),
  );
  const checked = expect(work).rejects.toBeInstanceOf(CdpReadTimeoutError);
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
  await checked;
  expect(warning).toHaveBeenCalledWith(
    "[bsk cdp] read timed out",
    expect.objectContaining({ method: "DOMSnapshot.captureSnapshot", tabId: 4 }),
  );
  expect(warning.mock.calls.filter((c) => c[0] === "[bsk cdp] slow command settled")).toHaveLength(
    0,
  );
  await vi.advanceTimersByTimeAsync(5000);
  finish({});
  await vi.advanceTimersByTimeAsync(0);
  expect(warning).toHaveBeenCalledWith(
    "[bsk cdp] slow command settled",
    expect.objectContaining({ elapsedMs: READ_TIMEOUT_MS + 5000, outcome: "returned", late: true }),
  );
});

it("is terminal for capture fallback but is not a caller abort", () => {
  const error = new CdpReadTimeoutError("DOMSnapshot.captureSnapshot", 4, READ_TIMEOUT_MS);
  expect(isCaptureTerminalError(error)).toBe(true);
  expect(isAbortError(error)).toBe(false);
  const abort = new Error("observation aborted");
  abort.name = "AbortError";
  expect(isCaptureTerminalError(abort)).toBe(true);
  expect(isAbortError(abort)).toBe(true);
});
