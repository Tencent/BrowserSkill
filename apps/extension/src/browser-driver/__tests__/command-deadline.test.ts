import { afterEach, expect, it, vi } from "vitest";
import { isAbortError, isCaptureTerminalError } from "@/tools/vom/capture-abort";
import { captureObservationFacts } from "@/tools/vom/capture-coordinator";
import {
  CAPTURE_READ_TIMEOUT_MS,
  CdpReadGate,
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
    "DOMSnapshot.captureSnapshot timed out after 20000ms (tab 4)",
  );
  await vi.advanceTimersByTimeAsync(CAPTURE_READ_TIMEOUT_MS);
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
  await vi.advanceTimersByTimeAsync(CAPTURE_READ_TIMEOUT_MS);
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
    await vi.advanceTimersByTimeAsync(CAPTURE_READ_TIMEOUT_MS);
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
  ).toEqual({
    data: {
      reason: RENDERER_READ_TIMEOUT,
      phase: "deadline",
      method: "DOMSnapshot.captureSnapshot",
      process: "renderer",
    },
  });
  expect(readTimeoutDetails(CdpReadTimeoutError.stillPending("Page.getLayoutMetrics", 4))).toEqual({
    data: { reason: RENDERER_READ_TIMEOUT, phase: "blocked", method: "Page.getLayoutMetrics" },
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
  await vi.advanceTimersByTimeAsync(CAPTURE_READ_TIMEOUT_MS);
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
    expect.objectContaining({
      elapsedMs: CAPTURE_READ_TIMEOUT_MS + 5000,
      outcome: "returned",
      late: true,
    }),
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

it.each([
  "returned",
  "failed",
])("gates new reads until the original command actually %s", async (outcome) => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  const gate = new CdpReadGate();
  let finish!: (value: object) => void;
  let fail!: (error: Error) => void;
  const work = gate.run(
    { tabId: 4 },
    "Page.getLayoutMetrics",
    () =>
      new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  const rejected = expect(work).rejects.toBeInstanceOf(CdpReadTimeoutError);
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
  await rejected;
  const send = vi.fn(async () => ({}));
  for (const method of ["DOMSnapshot.captureSnapshot", "Runtime.evaluate", "Page.getFrameTree"])
    await expect(gate.run({ tabId: 4, sessionId: "child" }, method, send)).rejects.toBeInstanceOf(
      CdpReadTimeoutError,
    );
  expect(send).not.toHaveBeenCalled();
  await gate.run({ tabId: 5 }, "Page.getLayoutMetrics", send);
  await gate.run({ tabId: 4 }, "Runtime.releaseObjectGroup", send);
  if (outcome === "returned") finish({});
  else fail(new Error("renderer closed"));
  await vi.advanceTimersByTimeAsync(0);
  await gate.run({ tabId: 4 }, "Page.getLayoutMetrics", send);
  expect(send).toHaveBeenCalledTimes(3);
});

it("isolates child gates and fences late completions across attachment replacement", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  const gate = new CdpReadGate();
  const child = { tabId: 4, sessionId: "child" };
  let oldFinish!: (value: object) => void;
  const old = gate.run(
    child,
    "Page.getLayoutMetrics",
    () =>
      new Promise((resolve) => {
        oldFinish = resolve;
      }),
  );
  const oldRejected = expect(old).rejects.toBeInstanceOf(CdpReadTimeoutError);
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
  await oldRejected;
  const send = vi.fn(async () => ({}));
  await gate.run({ tabId: 4 }, "Page.getLayoutMetrics", send);
  await gate.run({ tabId: 4, sessionId: "sibling" }, "Page.getLayoutMetrics", send);
  gate.reset(4);
  const next = gate.run(child, "Page.getLayoutMetrics", () => new Promise<never>(() => {}));
  const nextRejected = expect(next).rejects.toBeInstanceOf(CdpReadTimeoutError);
  await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
  await nextRejected;
  oldFinish({});
  await vi.advanceTimersByTimeAsync(0);
  await expect(gate.run(child, "Page.getLayoutMetrics", send)).rejects.toBeInstanceOf(
    CdpReadTimeoutError,
  );
  expect(send).toHaveBeenCalledTimes(2);
  gate.reset(4, "child");
  await gate.run(child, "Page.getLayoutMetrics", send);
});

it("distinguishes browser deadlines from refused reads and describes actual recovery", () => {
  const timeout = new CdpReadTimeoutError("Target.setAutoAttach", 4, READ_TIMEOUT_MS);
  expect(readTimeoutDetails(timeout)).toEqual({
    data: {
      reason: RENDERER_READ_TIMEOUT,
      phase: "deadline",
      method: "Target.setAutoAttach",
      process: "browser",
    },
  });
  expect(timeout.message).toContain("the browser is not answering");
  const blocked = CdpReadTimeoutError.stillPending("Runtime.evaluate", 4);
  expect(blocked.message).toContain("pending in Chrome");
  expect(blocked.message).not.toContain("running in the renderer");
  expect(blocked.message).toContain("Navigation alone does not clear the read gate");
  expect(blocked.message).toContain("command settles or its debugger session detaches");
});
