import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_SUPPRESS, type CaptureSuppressAck } from "@/lib/capture-suppress-bridge";
import { CAPTURE_HIDDEN_ATTR, createCaptureSuppressController } from "../capture-suppress";

/**
 * rAF is stubbed with a manual queue so tests can drive the compositor
 * frame-by-frame and assert the ack only lands after the second frame.
 */
describe("capture-suppress controller", () => {
  let rafQueue: FrameRequestCallback[];
  let host: HTMLElement;

  beforeEach(() => {
    rafQueue = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.append(host);
  });

  /** Run every queued rAF callback, draining microtasks between rounds. */
  async function flushFrames(rounds = 4): Promise<void> {
    for (let round = 0; round < rounds && rafQueue.length > 0; round += 1) {
      const callbacks = rafQueue.splice(0);
      for (const cb of callbacks) cb(0);
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  it("begin hides the host immediately but only acks after two frames", async () => {
    const controller = createCaptureSuppressController(() => host);
    const sendResponse = vi.fn();

    const needsAsync = controller.handleMessage(
      { type: CAPTURE_SUPPRESS, phase: "begin" },
      sendResponse,
    );

    expect(needsAsync).toBe(true);
    expect(controller.pendingCount).toBe(1);
    expect(host.hasAttribute(CAPTURE_HIDDEN_ATTR)).toBe(true);
    expect(sendResponse).not.toHaveBeenCalled();

    // First frame commits the style change; the ack must still be pending.
    await flushFrames(1);
    expect(sendResponse).not.toHaveBeenCalled();

    // Second frame: the compositor has produced an overlay-free frame.
    await flushFrames();
    const expected: CaptureSuppressAck = { type: CAPTURE_SUPPRESS, ok: true };
    expect(sendResponse).toHaveBeenCalledWith(expected);
  });

  it("end removes the attribute once the count returns to zero", async () => {
    const controller = createCaptureSuppressController(() => host);
    controller.handleMessage({ type: CAPTURE_SUPPRESS, phase: "begin" }, vi.fn());
    await flushFrames();
    expect(host.hasAttribute(CAPTURE_HIDDEN_ATTR)).toBe(true);

    const sendResponse = vi.fn();
    const needsAsync = controller.handleMessage(
      { type: CAPTURE_SUPPRESS, phase: "end" },
      sendResponse,
    );

    expect(needsAsync).toBe(false);
    expect(controller.pendingCount).toBe(0);
    expect(host.hasAttribute(CAPTURE_HIDDEN_ATTR)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ type: CAPTURE_SUPPRESS, ok: true });
  });

  it("reference-counts concurrent begins so one end does not unhide early", async () => {
    const controller = createCaptureSuppressController(() => host);
    controller.handleMessage({ type: CAPTURE_SUPPRESS, phase: "begin" }, vi.fn());
    controller.handleMessage({ type: CAPTURE_SUPPRESS, phase: "begin" }, vi.fn());
    await flushFrames();
    expect(controller.pendingCount).toBe(2);

    controller.handleMessage({ type: CAPTURE_SUPPRESS, phase: "end" }, vi.fn());
    expect(controller.pendingCount).toBe(1);
    expect(host.hasAttribute(CAPTURE_HIDDEN_ATTR)).toBe(true);

    controller.handleMessage({ type: CAPTURE_SUPPRESS, phase: "end" }, vi.fn());
    expect(controller.pendingCount).toBe(0);
    expect(host.hasAttribute(CAPTURE_HIDDEN_ATTR)).toBe(false);
  });

  it("treats a stray end as a no-op", () => {
    const controller = createCaptureSuppressController(() => host);
    const sendResponse = vi.fn();

    controller.handleMessage({ type: CAPTURE_SUPPRESS, phase: "end" }, sendResponse);

    expect(controller.pendingCount).toBe(0);
    expect(host.hasAttribute(CAPTURE_HIDDEN_ATTR)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ type: CAPTURE_SUPPRESS, ok: true });
  });

  it("re-applies the attribute when the host is remounted mid-capture", () => {
    let currentHost: HTMLElement | null = host;
    const controller = createCaptureSuppressController(() => currentHost);
    controller.handleMessage({ type: CAPTURE_SUPPRESS, phase: "begin" }, vi.fn());

    // Host lost and rebuilt before `end` arrives.
    currentHost = null;
    const rebuilt = document.createElement("div");
    controller.onHostMounted(rebuilt);

    expect(rebuilt.hasAttribute(CAPTURE_HIDDEN_ATTR)).toBe(true);
  });

  it("leaves a remounted host visible once suppression has ended", () => {
    const controller = createCaptureSuppressController(() => host);
    const rebuilt = document.createElement("div");

    controller.onHostMounted(rebuilt);

    expect(rebuilt.hasAttribute(CAPTURE_HIDDEN_ATTR)).toBe(false);
  });
});
