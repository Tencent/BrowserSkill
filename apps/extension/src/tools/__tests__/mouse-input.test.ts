import { describe, expect, it, vi } from "vitest";
import { dispatchMouseClick } from "../mouse-input";
import type { CdpRunner } from "../shared";

function fakeCdp(onSend?: (method: string, params: Record<string, unknown>) => void): {
  cdp: CdpRunner;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    cdp: {
      send: vi.fn(async (_tabId, method, params) => {
        const event = params as Record<string, unknown>;
        events.push(event);
        onSend?.(method, event);
        return {} as never;
      }),
    },
  };
}

describe("dispatchMouseClick", () => {
  it("emits one move, press, and release sequence", async () => {
    const { cdp, events } = fakeCdp();

    expect(
      await dispatchMouseClick(
        cdp,
        4,
        { x: 12, y: 34 },
        {
          button: "left",
          clickCount: 1,
          modifiers: 0,
          moveSettleMs: 0,
        },
      ),
    ).toBe("completed");

    expect(events).toEqual([
      {
        type: "mouseMoved",
        x: 12,
        y: 34,
        modifiers: 0,
      },
      {
        type: "mousePressed",
        x: 12,
        y: 34,
        button: "left",
        clickCount: 1,
        modifiers: 0,
      },
      {
        type: "mouseReleased",
        x: 12,
        y: 34,
        button: "left",
        clickCount: 1,
        modifiers: 0,
      },
    ]);
  });

  it("releases a pressed button when cancellation arrives", async () => {
    const controller = new AbortController();
    const { cdp, events } = fakeCdp((_method, event) => {
      if (event.type === "mousePressed") controller.abort();
    });

    expect(
      await dispatchMouseClick(
        cdp,
        4,
        { x: 1, y: 2 },
        {
          button: "left",
          clickCount: 1,
          modifiers: 0,
          signal: controller.signal,
          moveSettleMs: 0,
        },
      ),
    ).toBe("cancelled");
    expect(events.at(-1)).toMatchObject({ type: "mouseReleased" });
  });

  it("settles pointer-move hit testing before pressing", async () => {
    vi.useFakeTimers();
    try {
      const { cdp, events } = fakeCdp();
      const click = dispatchMouseClick(
        cdp,
        4,
        { x: 1, y: 2 },
        {
          button: "left",
          clickCount: 1,
          modifiers: 0,
          moveSettleMs: 32,
        },
      );

      await vi.advanceTimersByTimeAsync(31);
      expect(events.map((event) => event.type)).toEqual(["mouseMoved"]);
      await vi.advanceTimersByTimeAsync(1);
      await click;
      expect(events.map((event) => event.type)).toEqual([
        "mouseMoved",
        "mousePressed",
        "mouseReleased",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
