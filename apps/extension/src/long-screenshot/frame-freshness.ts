import type { FrameSignature } from "./manual";
import { ScreenshotError } from "./types";

export function frameSignature(bitmap: ImageBitmap): FrameSignature {
  const pixels = new Uint8ClampedArray(96 * bitmap.height * 4);
  const canvas = new OffscreenCanvas(96, Math.min(512, bitmap.height));
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new ScreenshotError("captureFailed");
    for (let y = 0; y < bitmap.height; y += canvas.height) {
      const height = Math.min(canvas.height, bitmap.height - y);
      ctx.drawImage(bitmap, 0, y, bitmap.width, height, 0, 0, 96, height);
      pixels.set(ctx.getImageData(0, 0, 96, height).data, y * 96 * 4);
    }
    return { width: bitmap.width, height: bitmap.height, pixels };
  } finally {
    canvas.width = canvas.height = 1;
  }
}

/** Reject positive evidence of a stale exposure, not ambiguous/blank content.
 * Compare the known document displacement against stationary textured patches.
 * Keep signatures only; no full-image buffers or offset search are needed. */
export function isStaleFrame(a: FrameSignature, b: FrameSignature, offset: number): boolean {
  if (a.width !== b.width || a.height !== b.height || offset < 4 || offset > a.height - 32)
    return false;
  let stale = 0;
  let scrolling = 0;
  const bands = new Set<number>();
  const error = (ay: number, by: number, x: number) => {
    let sum = 0;
    for (let dx = 0; dx < 8; dx++)
      for (let c = 0; c < 3; c++)
        sum += Math.abs(
          a.pixels[(ay * 96 + x + dx) * 4 + c] - b.pixels[(by * 96 + x + dx) * 4 + c],
        );
    return sum / 24;
  };
  for (let y = 8; y < a.height - offset - 8; y += 4) {
    // Ignore edge chrome and tolerate stationary sidebars/local animation.
    for (let x = 24; x <= 64; x += 8) {
      const stationary = error(y, y, x);
      const shifted = error(y + offset, y, x);
      if (shifted < 3 && stationary > 12) scrolling++;
      else if (stationary < 0.5 && shifted > 12) {
        stale++;
        bands.add(x);
      }
    }
  }
  return stale >= 24 && bands.size >= 2 && scrolling === 0;
}
