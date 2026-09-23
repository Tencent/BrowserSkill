import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INPUT_PASSTHROUGH,
  INPUT_PASSTHROUGH_ATTR,
  type InputPassthroughMessage,
  isInputPassthroughMessage,
} from "@/lib/input-passthrough-bridge";
import { createInputPassthroughController } from "../input-passthrough";

describe("click input passthrough", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
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
});
