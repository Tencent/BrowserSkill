import { describe, expect, it } from "vitest";
import { alignFrames, type FrameSignature } from "./manual";

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
});
