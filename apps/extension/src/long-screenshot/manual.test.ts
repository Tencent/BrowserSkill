import { afterEach, describe, expect, it, vi } from "vitest";
import { alignFrames, captureManual, type FrameSignature } from "./manual";

afterEach(() => vi.unstubAllGlobals());

function frame(offset: number, fixed = true, periodic = false): FrameSignature {
  const height = 500,
    pixels = new Uint8ClampedArray(height * 96 * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < 96; x++) {
      let row = y + offset;
      if (fixed && (y < 40 || y >= height - 35)) row = y;
      if (periodic) row %= 32;
      let hash = Math.imul(row + 1, 0x45d9f3b) ^ Math.imul(x + 1, 0x119de1f3);
      hash ^= hash >>> 16;
      const at = (y * 96 + x) * 4;
      pixels[at] = hash & 255;
      pixels[at + 1] = (hash >>> 8) & 255;
      pixels[at + 2] = (hash >>> 16) & 255;
      pixels[at + 3] = 255;
    }
  return { width: 800, height, pixels };
}
describe("manual scrolling alignment", () => {
  it.each([
    1, 27, 137, 320,
  ])("finds an exact %s-pixel offset while excluding fixed headers and footers", (offset) => {
    expect(alignFrames(frame(0), frame(offset))).toEqual({ offset, footer: 450 - offset });
  });
  it("does not duplicate an unchanged screen", () =>
    expect(alignFrames(frame(0), frame(0))?.offset).toBe(0));
  it("rejects repeated-content ambiguities and non-overlapping scroll jumps", () => {
    expect(alignFrames(frame(0, false, true), frame(12, false, true))).toBeNull();
    expect(alignFrames(frame(0), frame(700))).toBeNull();
  });
  it("rejects resizing instead of mixing coordinate systems", () => {
    expect(() => alignFrames(frame(0), { ...frame(2), width: 1000 })).toThrow("changed");
  });
  it("aligns the scrolling content despite an animated region and stationary sidebars", () => {
    const before = frame(0),
      after = frame(137),
      animation = frame(900);
    for (let y = 0; y < after.height; y++)
      for (let x = 0; x < 96; x++) {
        const at = (y * 96 + x) * 4;
        if (x < 18 || x >= 78) after.pixels.set(before.pixels.subarray(at, at + 4), at);
        else if (x >= 54 && y >= 150 && y < 270)
          after.pixels.set(animation.pixels.subarray(at, at + 4), at);
      }
    expect(alignFrames(before, after)?.offset).toBe(137);
  });
  it("does not append an animation on an otherwise stationary page", () => {
    const before = frame(0),
      after = frame(0),
      animation = frame(900);
    for (let y = 120; y < 300; y++)
      for (let x = 60; x < 90; x++) {
        const at = (y * 96 + x) * 4;
        after.pixels.set(animation.pixels.subarray(at, at + 4), at);
      }
    expect(alignFrames(before, after)?.offset).toBe(0);
  });
  it("accepts a short but distinctive overlap instead of requiring 15 percent", () => {
    expect(alignFrames(frame(0), frame(370))?.offset).toBe(370);
    const match = alignFrames(frame(0, false), frame(440, false));
    expect(match?.offset).toBe(440);
    expect(match!.footer).toBeGreaterThan(0);
    expect(alignFrames(frame(0, false), frame(470, false))).toBeNull();
  });
  it("does not mistake text-heavy fixed sidebars for the scrolling document", () => {
    const before = frame(0, false),
      after = frame(137, false);
    for (const [image, offset] of [
      [before, 0],
      [after, 137],
    ] as const)
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < 96; x++) {
          const at = (y * 96 + x) * 4;
          if (x < 18 || x >= 78) image.pixels.set(before.pixels.subarray(at, at + 4), at);
          else if ((y + offset) % 60 >= 18) image.pixels.set([255, 255, 255, 255], at);
        }
    expect(alignFrames(before, after)?.offset).toBe(137);
  });
  it("retries transient misses, retains the accepted anchor and closes rejected bitmaps", async () => {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width = 96;
        height = 500;
        getContext() {
          let pixels: Uint8ClampedArray;
          return {
            drawImage: (bitmap: FrameSignature) => {
              pixels = bitmap.pixels;
            },
            getImageData: () => ({ data: pixels }),
          };
        }
      },
    );
    const images = [0, 700, 700, 137].map((offset) => ({ ...frame(offset), close: vi.fn() }));
    let next = 0;
    const write = vi.fn(),
      progress = vi.fn();
    await captureManual({
      screenshot: async () => images[next++] as unknown as ImageBitmap,
      write,
      progress,
      checkpoint: async () => {},
      finished: () => next === images.length,
      signal: new AbortController().signal,
      visible: false,
    });
    expect(write).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls).toEqual([[1], [1, undefined], [1, "alignment"], [2]]);
    expect(images.every((image) => image.close.mock.calls.length === 1)).toBe(true);
  });
});
