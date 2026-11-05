import { describe, expect, it, vi } from "vitest";
import type { CaptureSuppressMessage } from "@/lib/capture-suppress-bridge";
import type { CdpRunner } from "../shared";
import { captureControlledViewport } from "../viewport-screenshot";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==";
function fixture() {
  const state = { attachment: "a", root: 42, controlled: true, png: PNG };
  const hook = { command: async (_method: string) => {}, bridge: async (_phase: string) => {} };
  const send = vi.fn(async (_tabId: number, method: string) => {
    await hook.command(method);
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.evaluate")
      return {
        result: { deepSerializedValue: { type: "node", value: { backendNodeId: state.root } } },
      };
    if (method === "Page.captureScreenshot") return { data: state.png };
    return {};
  });
  const cdp: CdpRunner = {
    send: send as CdpRunner["send"],
    getAttachmentId: () => state.attachment,
  };
  const bridge = vi.fn(async (_tabId: number, message: CaptureSuppressMessage) => {
    await hook.bridge(message.phase);
  });
  const check = vi.fn(async () => state.controlled);
  const run = (signal?: AbortSignal) => captureControlledViewport(cdp, 7, check, signal, bridge);
  return { state, hook, send, cdp, bridge, check, run };
}

describe("controlled viewport capture", () => {
  it("captures a valid viewport and restores the overlay without owning execution policy", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ image_base64: PNG, width: 1, height: 1 });
    expect(f.send).toHaveBeenCalledWith(7, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    expect(f.bridge.mock.calls.map((call) => call[1].phase)).toEqual(["begin", "end"]);
    const methods = f.send.mock.calls.map((call) => call[1]);
    expect(methods).not.toContain("Emulation.setFocusEmulationEnabled");
    expect(methods).not.toContain("Page.bringToFront");
  });

  it.each([
    "document",
    "attachment",
    "control",
  ])("discards a screenshot after %s changes during capture", async (kind) => {
    const f = fixture();
    f.hook.command = async (method) => {
      if (method !== "Page.captureScreenshot") return;
      if (kind === "document") f.state.root++; // Same tab and URL can contain a new document.
      if (kind === "attachment") f.state.attachment = "b";
      if (kind === "control") f.state.controlled = false;
    };
    expect(await f.run()).toMatchObject({
      code: "not_found",
      data: { reason: "visual_target_changed" },
    });
    expect(f.bridge.mock.calls.at(-1)?.[1].phase).toBe("end");
  });

  it("does not capture a document replaced while waiting for overlay suppression", async () => {
    const f = fixture();
    f.hook.bridge = async (phase) => {
      if (phase === "begin") f.state.root++;
    };
    expect(await f.run()).toMatchObject({ code: "not_found" });
    expect(f.send.mock.calls.some((call) => call[1] === "Page.captureScreenshot")).toBe(false);
    expect(f.bridge.mock.calls.at(-1)?.[1].phase).toBe("end");
  });

  it("checks control again after restoring the overlay", async () => {
    const f = fixture();
    f.hook.bridge = async (phase) => {
      if (phase === "end") f.state.controlled = false;
    };
    expect(await f.run()).toMatchObject({ code: "not_found" });
  });

  it("restores suppression and discards a cancelled capture", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.hook.command = async (method) => {
      if (method === "Page.captureScreenshot") abort.abort();
    };
    expect(await f.run(abort.signal)).toMatchObject({ code: "cancelled" });
    expect(f.bridge.mock.calls.at(-1)?.[1].phase).toBe("end");
  });

  it.each([
    "Page.getFrameTree",
    "Page.createIsolatedWorld",
    "Runtime.evaluate",
    "Page.captureScreenshot",
  ])("cancels a pending %s without waiting for Chrome's reply", async (method) => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.hook.command = async (name) => {
      if (name === method) await pending;
    };
    const abort = new AbortController();
    const result = f.run(abort.signal);
    await vi.waitFor(() =>
      expect(f.send.mock.calls.some(([, name]) => name === method)).toBe(true),
    );
    abort.abort();
    try {
      await expect(result).resolves.toMatchObject({ code: "cancelled" });
      const commands = f.send.mock.calls.length;
      release();
      await Promise.resolve();
      expect(f.send.mock.calls).toHaveLength(commands);
      if (method === "Page.captureScreenshot")
        expect(f.bridge.mock.calls.at(-1)?.[1].phase).toBe("end");
      f.hook.command = async () => {};
      expect(await f.run()).toMatchObject({ image_base64: PNG });
    } finally {
      release();
    }
  });
  it.each([
    "screenshot",
    "before-capture identity",
    "after-capture identity",
  ])("times out hung %s and bounds overlay restoration", async (stage) => {
    vi.useFakeTimers();
    const f = fixture();
    let identities = 0;
    f.hook.command = async (method) => {
      if (method === "Runtime.evaluate") identities++;
      if (
        (stage === "screenshot" && method === "Page.captureScreenshot") ||
        (method === "Runtime.evaluate" &&
          identities ===
            (stage === "before-capture identity" ? 2 : stage === "after-capture identity" ? 3 : 0))
      )
        await new Promise(() => {});
    };
    f.hook.bridge = async (phase) => {
      if (phase === "end") await new Promise(() => {});
    };
    try {
      const result = f.run();
      const assertion = expect(result).resolves.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(11_000);
      await assertion;
      expect(f.bridge.mock.calls.at(-1)?.[1].phase).toBe("end");
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancels a pending overlay begin and restores it without capturing", async () => {
    const f = fixture();
    f.hook.bridge = async (phase) => {
      if (phase === "begin") await new Promise(() => {});
    };
    const abort = new AbortController();
    const result = f.run(abort.signal);
    await vi.waitFor(() => expect(f.bridge).toHaveBeenCalled());
    abort.abort();
    await expect(result).resolves.toMatchObject({ code: "cancelled" });
    expect(f.bridge.mock.calls.map(([, message]) => message.phase)).toEqual(["begin", "end"]);
    expect(f.send.mock.calls.some(([, method]) => method === "Page.captureScreenshot")).toBe(false);
  });
  it("reports capture failure without retrying another target or backend", async () => {
    const f = fixture();
    f.hook.command = async (method) => {
      if (method === "Page.captureScreenshot") throw new Error("readback failed");
    };
    expect(await f.run()).toMatchObject({
      code: "cdp_failed",
      data: { reason: "screenshot_capture_failed" },
      message: "readback failed",
    });
    expect(f.send.mock.calls.filter((call) => call[1] === "Page.captureScreenshot")).toHaveLength(
      1,
    );
    expect(f.bridge.mock.calls.at(-1)?.[1].phase).toBe("end");
  });

  it.each([
    "",
    "not-png",
    PNG.slice(0, 20),
  ])("rejects missing or malformed image metadata", async (png) => {
    const f = fixture();
    f.state.png = png;
    expect(await f.run()).toMatchObject({
      code: "cdp_failed",
      data: { reason: "screenshot_capture_failed" },
    });
  });

  it("fails closed when the document cannot be identified", async () => {
    const f = fixture();
    f.state.attachment = "";
    expect(await f.run()).toMatchObject({ code: "not_found" });
    expect(f.bridge).not.toHaveBeenCalled();
  });
});

it("does not send identity cleanup into a replacement attachment", async () => {
  const f = fixture();
  f.hook.command = async (method) => {
    if (method === "Runtime.evaluate") f.state.attachment = "replacement";
  };
  expect(await f.run()).toMatchObject({ code: "not_found" });
  expect(f.send.mock.calls.some((call) => call[1] === "Runtime.releaseObjectGroup")).toBe(false);
  expect(f.send.mock.calls.some((call) => call[1] === "Page.captureScreenshot")).toBe(false);
});
