import { afterEach, describe, expect, it, vi } from "vitest";
import { isStaleFrame } from "./frame-freshness";
import type { FrameSignature } from "./manual";
import { waitForReply } from "./wait";

describe("bounded browser API calls", () => {
  afterEach(() => vi.useRealTimers());

  it("times out an API that never calls back", async () => {
    vi.useFakeTimers();
    const promise = waitForReply(new Promise(() => {}), undefined, 100);
    const assertion = expect(promise).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it("cancels immediately and consumes a later API rejection", async () => {
    const controller = new AbortController();
    let rejectApi: (error: Error) => void = () => {};
    const promise = waitForReply(
      new Promise((_, reject) => {
        rejectApi = reject;
      }),
      controller.signal,
    );
    const assertion = expect(promise).rejects.toBeDefined();
    controller.abort();
    await assertion;
    rejectApi(new Error("late browser failure"));
    await Promise.resolve();
  });
});

function frame(offset = 0, blank = false): FrameSignature {
  const width = 96;
  const height = 600;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++)
        pixels[(y * width + x) * 4 + c] = blank ? 240 : ((y + offset) * 31 + x * 17 + c * 57) % 251;
  return { width, height, pixels };
}

describe("automatic frame freshness", () => {
  it("rejects an unchanged textured image at a different document offset", () => {
    expect(isStaleFrame(frame(), frame(), 450)).toBe(true);
  });

  it("accepts pixels that moved by the measured displacement", () => {
    expect(isStaleFrame(frame(), frame(450), 450)).toBe(false);
  });

  it("does not reject blank, repeated, same-position or rewound exposures", () => {
    expect(isStaleFrame(frame(0, true), frame(0, true), 450)).toBe(false);
    expect(isStaleFrame(frame(), frame(), 251)).toBe(false);
    expect(isStaleFrame(frame(), frame(), 0)).toBe(false);
    expect(isStaleFrame(frame(), frame(), -450)).toBe(false);
  });

  it("tolerates stationary sidebars when article content scrolls", () => {
    const a = frame();
    const b = frame(450);
    for (let y = 0; y < 600; y++)
      for (let x = 0; x < 96; x++)
        if (x < 32 || x > 63)
          b.pixels.set(a.pixels.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 4), (y * 96 + x) * 4);
    expect(isStaleFrame(a, b, 450)).toBe(false);
  });
});
