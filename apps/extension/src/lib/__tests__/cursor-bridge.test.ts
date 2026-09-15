import { describe, expect, it, vi } from "vitest";
import {
  CURSOR_MSG,
  type CursorMessage,
  createCursorVisualizer,
  cursorMoveDuration,
  isCursorMessage,
} from "../cursor-bridge";

describe("isCursorMessage", () => {
  it("accepts the three cursor actions", () => {
    expect(isCursorMessage({ type: CURSOR_MSG, action: "hide" })).toBe(true);
    expect(isCursorMessage({ type: CURSOR_MSG, action: "move", x: 1, y: 2, durationMs: 0 })).toBe(
      true,
    );
    expect(isCursorMessage({ type: CURSOR_MSG, action: "click", x: 1, y: 2 })).toBe(true);
    expect(
      isCursorMessage({ type: CURSOR_MSG, action: "click", x: 1, y: 2, button: "middle" }),
    ).toBe(true);
  });

  it("rejects malformed messages", () => {
    expect(isCursorMessage(null)).toBe(false);
    expect(isCursorMessage("bsk/cursor")).toBe(false);
    expect(isCursorMessage({ type: "other", action: "hide" })).toBe(false);
    expect(isCursorMessage({ type: CURSOR_MSG, action: "move", x: 1, y: 2 })).toBe(false);
    expect(isCursorMessage({ type: CURSOR_MSG, action: "click", x: 1, y: "2" })).toBe(false);
    expect(isCursorMessage({ type: CURSOR_MSG, action: "click", button: "left" })).toBe(false);
    expect(isCursorMessage({ type: CURSOR_MSG, action: "warp", x: 1, y: 2 })).toBe(false);
  });
});

describe("cursorMoveDuration", () => {
  it("is instant without a previous position", () => {
    expect(cursorMoveDuration(null, { x: 10, y: 10 })).toBe(0);
    expect(cursorMoveDuration(undefined, { x: 10, y: 10 })).toBe(0);
  });

  it("scales with distance inside the 120–500ms clamp", () => {
    // 1000px * 0.6 = 600ms → clamped to 500.
    expect(cursorMoveDuration({ x: 0, y: 0 }, { x: 1000, y: 0 })).toBe(500);
    // 10px * 0.6 = 6ms → clamped up to 120.
    expect(cursorMoveDuration({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(120);
    // 400px * 0.6 = 240ms, unclamped.
    expect(cursorMoveDuration({ x: 0, y: 0 }, { x: 400, y: 0 })).toBe(240);
    // Distance is euclidean: 3-4-5 triangle → 500px * 0.6 = 300ms.
    expect(cursorMoveDuration({ x: 0, y: 0 }, { x: 300, y: 400 })).toBe(300);
  });
});

describe("createCursorVisualizer", () => {
  it("sends a move and waits for the animation before resolving", async () => {
    const seen: CursorMessage[] = [];
    const sendToTab = vi.fn(async (_tabId: number, message: CursorMessage) => {
      seen.push(message);
      return { type: CURSOR_MSG, ok: true };
    });
    const cursor = createCursorVisualizer(sendToTab);
    const started = performance.now();
    await cursor.move(7, { x: 12, y: 34 }, { durationMs: 120, label: "e3" });
    const elapsed = performance.now() - started;

    expect(seen).toEqual([
      { type: CURSOR_MSG, action: "move", x: 12, y: 34, durationMs: 120, label: "e3" },
    ]);
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it("clamps the wait to the animation ceiling", async () => {
    const sendToTab = vi.fn(async (_tabId: number, _message: CursorMessage) => ({
      type: CURSOR_MSG,
      ok: true,
    }));
    const cursor = createCursorVisualizer(sendToTab);
    const started = performance.now();
    await cursor.move(7, { x: 0, y: 0 }, { durationMs: 5000 });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(sendToTab.mock.calls[0]?.[1]).toMatchObject({ durationMs: 800 });
  });

  it("resolves immediately when the tab has no content script", async () => {
    const sendToTab = vi.fn(async (_tabId: number, _message: CursorMessage) => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    });
    const cursor = createCursorVisualizer(sendToTab);
    const started = performance.now();
    await cursor.move(7, { x: 1, y: 2 }, { durationMs: 500 });
    await cursor.click(7, { x: 1, y: 2 }, { button: "left" });
    await cursor.hide(7);
    expect(performance.now() - started).toBeLessThan(200);
    expect(sendToTab).toHaveBeenCalledTimes(3);
  });

  it("sends click and hide messages verbatim", async () => {
    const sendToTab = vi.fn(async (_tabId: number, _message: CursorMessage) => ({
      type: CURSOR_MSG,
      ok: true,
    }));
    const cursor = createCursorVisualizer(sendToTab);

    await cursor.click(3, { x: 5, y: 6 }, { button: "right" });
    await cursor.click(3, { x: 5, y: 6 });
    await cursor.hide(3);

    expect(sendToTab.mock.calls.map((call) => call[1])).toEqual([
      { type: CURSOR_MSG, action: "click", x: 5, y: 6, button: "right" },
      { type: CURSOR_MSG, action: "click", x: 5, y: 6 },
      { type: CURSOR_MSG, action: "hide" },
    ]);
  });
});
