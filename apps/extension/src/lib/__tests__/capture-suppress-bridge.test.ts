import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_SUPPRESS,
  type CaptureSuppressMessage,
  withExtensionOverlayHidden,
} from "../capture-suppress-bridge";

function recordingSendToTab(events: string[]) {
  return vi.fn(async (_tabId: number, message: CaptureSuppressMessage) => {
    events.push(message.phase);
    return { type: CAPTURE_SUPPRESS, ok: true };
  });
}

describe("withExtensionOverlayHidden", () => {
  it("sends begin → fn → end and returns fn's result", async () => {
    const events: string[] = [];
    const sendToTab = recordingSendToTab(events);

    const result = await withExtensionOverlayHidden(
      7,
      async () => {
        events.push("capture");
        return "shot";
      },
      sendToTab,
    );

    expect(result).toBe("shot");
    expect(events).toEqual(["begin", "capture", "end"]);
    expect(sendToTab).toHaveBeenCalledWith(7, { type: CAPTURE_SUPPRESS, phase: "begin" });
    expect(sendToTab).toHaveBeenCalledWith(7, { type: CAPTURE_SUPPRESS, phase: "end" });
  });

  it("still sends end when fn throws, then rethrows", async () => {
    const events: string[] = [];
    const sendToTab = recordingSendToTab(events);

    await expect(
      withExtensionOverlayHidden(
        7,
        async () => {
          events.push("capture");
          throw new Error("capture exploded");
        },
        sendToTab,
      ),
    ).rejects.toThrow("capture exploded");
    expect(events).toEqual(["begin", "capture", "end"]);
  });

  it("captures directly when the tab has no content script", async () => {
    const sendToTab = vi.fn(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    const fn = vi.fn(async () => "shot");

    const result = await withExtensionOverlayHidden(7, fn, sendToTab);

    expect(result).toBe("shot");
    expect(fn).toHaveBeenCalledTimes(1);
    // begin failed → no matching end may be sent.
    expect(sendToTab).toHaveBeenCalledTimes(1);
  });

  it("swallows end failures so the capture result stands", async () => {
    const sendToTab = vi.fn(async (_tabId: number, message: CaptureSuppressMessage) => {
      if (message.phase === "end") throw new Error("tab navigated away");
      return { type: CAPTURE_SUPPRESS, ok: true };
    });

    const result = await withExtensionOverlayHidden(7, async () => "shot", sendToTab);

    expect(result).toBe("shot");
    expect(sendToTab).toHaveBeenCalledTimes(2);
  });
});
