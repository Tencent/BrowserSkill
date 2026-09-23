import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INPUT_PASSTHROUGH,
  INPUT_PASSTHROUGH_ATTR,
  INPUT_PASSTHROUGH_TTL_MS,
  type InputPassthroughMessage,
  isInputPassthroughMessage,
} from "@/lib/input-passthrough-bridge";
import { createInputPassthroughController } from "../input-passthrough";

describe("click input passthrough", () => {
  let host: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  const message = (phase: "begin" | "end", id = "click-1"): InputPassthroughMessage => ({
    type: INPUT_PASSTHROUGH,
    phase,
    id,
  });

  it("applies and acknowledges synchronously without hiding the host or scheduling frames", () => {
    const controller = createInputPassthroughController(() => host);
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const ack = vi.fn(() => expect(host.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(true));
    expect(controller.handleMessage(message("begin"), ack)).toBe(false);
    expect(ack).toHaveBeenCalledWith({ type: INPUT_PASSTHROUGH, ok: true });
    expect(raf).not.toHaveBeenCalled();
    expect(host.hasAttribute("data-bsk-capture-hidden")).toBe(false);
    raf.mockRestore();
  });

  it("counts independent clicks and ignores duplicate or unmatched messages", () => {
    const controller = createInputPassthroughController(() => host);
    for (const id of ["one", "one", "two"]) controller.handleMessage(message("begin", id), vi.fn());
    expect(controller.pendingCount).toBe(2);
    for (const id of ["missing", "one", "one"])
      controller.handleMessage(message("end", id), vi.fn());
    expect(controller.pendingCount).toBe(1);
    expect(host.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(true);
    controller.handleMessage(message("end", "two"), vi.fn());
    expect(controller.pendingCount).toBe(0);
    expect(host.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(false);
  });

  it("reapplies pending clicks after host replacement and leaves screenshot state alone", () => {
    let current: HTMLElement | null = null;
    const controller = createInputPassthroughController(() => current);
    controller.handleMessage(message("begin"), vi.fn());
    current = host;
    host.setAttribute("data-bsk-capture-hidden", "");
    controller.onHostMounted(host);
    expect(host.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(true);
    controller.handleMessage(message("end"), vi.fn());
    expect(host.hasAttribute("data-bsk-capture-hidden")).toBe(true);
    current = document.createElement("div");
    controller.onHostMounted(current);
    expect(current.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(false);
  });

  it("accepts only paired click messages with an operation id", () => {
    expect(isInputPassthroughMessage(message("begin"))).toBe(true);
    expect(isInputPassthroughMessage(message("end"))).toBe(true);
    for (const invalid of [
      null,
      {},
      { ...message("begin"), id: "" },
      { ...message("begin"), phase: "reset" },
      { ...message("begin"), type: "bsk/capture-suppress" },
    ])
      expect(isInputPassthroughMessage(invalid)).toBe(false);
  });

  it("expires a lost end without extending the lease on duplicate begin", () => {
    const controller = createInputPassthroughController(() => host);
    controller.handleMessage(message("begin"), vi.fn());
    vi.advanceTimersByTime(INPUT_PASSTHROUGH_TTL_MS - 1);
    controller.handleMessage(message("begin"), vi.fn());
    expect(host.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(controller.pendingCount).toBe(0);
    expect(host.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires only the old click and ignores its late end while another click is active", () => {
    const controller = createInputPassthroughController(() => host);
    controller.handleMessage(message("begin", "old"), vi.fn());
    vi.advanceTimersByTime(1000);
    controller.handleMessage(message("begin", "new"), vi.fn());
    vi.advanceTimersByTime(INPUT_PASSTHROUGH_TTL_MS - 1000);
    expect(controller.pendingCount).toBe(1);
    controller.handleMessage(message("end", "old"), vi.fn());
    expect(host.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(host.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(false);
  });

  it("cancels timers on end and reset, and does not restore old leases on remount", () => {
    let current = host;
    const controller = createInputPassthroughController(() => current);
    controller.handleMessage(message("begin", "one"), vi.fn());
    controller.handleMessage(message("begin", "two"), vi.fn());
    controller.handleMessage(message("end", "one"), vi.fn());
    expect(vi.getTimerCount()).toBe(1);
    controller.reset();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(false);
    current = document.createElement("div");
    controller.onHostMounted(current);
    expect(current.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(false);
    controller.handleMessage(message("begin", "new-session"), vi.fn());
    controller.handleMessage(message("end", "two"), vi.fn());
    expect(current.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(true);
  });

  it("does not revive an expired lease when a frozen page remounts before timers run", () => {
    const controller = createInputPassthroughController(() => host);
    controller.handleMessage(message("begin"), vi.fn());
    vi.setSystemTime(Date.now() + INPUT_PASSTHROUGH_TTL_MS);
    const replacement = document.createElement("div");
    controller.onHostMounted(replacement);
    expect(controller.pendingCount).toBe(0);
    expect(replacement.hasAttribute(INPUT_PASSTHROUGH_ATTR)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
