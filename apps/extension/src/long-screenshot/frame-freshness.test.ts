import { describe, expect, it } from "vitest";
import { isStaleFrame } from "./frame-freshness";
import type { FrameSignature } from "./manual";

function frame(offset = 0, blank = false): FrameSignature {
  const width = 96,
    height = 600,
    pixels = new Uint8ClampedArray(width * height * 4);
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
    const a = frame(),
      b = frame(450);
    for (let y = 0; y < 600; y++)
      for (let x = 0; x < 96; x++)
        if (x < 32 || x > 63)
          b.pixels.set(a.pixels.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 4), (y * 96 + x) * 4);
    expect(isStaleFrame(a, b, 450)).toBe(false);
  });
});
