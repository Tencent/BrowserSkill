import { ScreenshotError } from "./types";

export interface FrameSignature {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}
export function signature(bitmap: ImageBitmap): FrameSignature {
  // Preserve vertical pixels for exact offsets; only downsample horizontally.
  const canvas = new OffscreenCanvas(96, bitmap.height);
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new ScreenshotError("captureFailed");
    ctx.drawImage(bitmap, 0, 0, 96, bitmap.height);
    return {
      width: bitmap.width,
      height: bitmap.height,
      pixels: ctx.getImageData(0, 0, 96, bitmap.height).data,
    };
  } finally {
    canvas.width = canvas.height = 1;
  }
}

/** Conservative image-only alignment for pages that forbid script injection.
 * Ambiguous/repeated/blank overlaps are rejected, never guessed into the image. */
export function alignFrames(
  a: FrameSignature,
  b: FrameSignature,
): { offset: number; footer: number } | null {
  if (a.width !== b.width || a.height !== b.height) throw new ScreenshotError("changed");
  const h = a.height;
  const difference = (ay: number, by: number) => {
    let total = 0;
    for (let x = 6; x < 90; x += 3) {
      const at = (ay * 96 + x) * 4,
        bt = (by * 96 + x) * 4;
      for (let c = 0; c < 3; c++) total += Math.abs(a.pixels[at + c] - b.pixels[bt + c]);
    }
    return total / 84;
  };
  let stationary = 0;
  for (let y = 0; y < h; y += 8) stationary += difference(y, y);
  if (stationary / Math.ceil(h / 8) < 0.15) return { offset: 0, footer: 0 };
  let top = 0,
    footer = 0;
  while (top < h * 0.35 && difference(top, top) < 0.5) top++;
  while (footer < h * 0.35 && difference(h - footer - 1, h - footer - 1) < 0.5) footer++;
  const scores: { offset: number; error: number }[] = [];
  const end = h - footer;
  const maximum = Math.floor((end - top) * 0.85);
  for (let offset = 1; offset <= maximum; offset++) {
    let sum = 0,
      count = 0;
    const stride = Math.max(1, Math.floor((end - top - offset) / 64));
    for (let y = top; y < end - offset; y += stride) {
      sum += difference(y + offset, y);
      count++;
    }
    if (count) scores.push({ offset, error: sum / count });
  }
  scores.sort((x, y) => x.error - y.error);
  const best = scores[0];
  const alternative = scores.find((candidate) => Math.abs(candidate.offset - best.offset) > 3);
  if (!best || best.error > 5 || !alternative || alternative.error <= best.error * 1.25 + 0.2)
    return null;
  // Replace the entire reliable overlap, not just newly exposed rows. This
  // removes old floating footers even when they occupy only part of the width.
  return { offset: best.offset, footer: h - Math.max(top, Math.floor(h * 0.1)) - best.offset };
}

export async function captureManual(deps: {
  screenshot(): Promise<ImageBitmap>;
  write(
    bitmap: ImageBitmap,
    width: number,
    sourceY: number,
    targetY: number,
    height: number,
  ): Promise<void>;
  checkpoint(): Promise<void>;
  finished(): boolean;
  signal: AbortSignal;
  visible: boolean;
  progress(frames: number, notice?: "alignment"): void;
}) {
  let previous: FrameSignature | undefined;
  let height = 0,
    width = 0,
    frames = 0;
  do {
    await deps.checkpoint();
    deps.signal.throwIfAborted();
    if (height && deps.finished()) break;
    const bitmap = await deps.screenshot();
    try {
      deps.signal.throwIfAborted();
      const current = signature(bitmap);
      if (!previous) {
        width = bitmap.width;
        await deps.write(bitmap, width, 0, 0, bitmap.height);
        height = bitmap.height;
      } else {
        const match = alignFrames(previous, current);
        if (!match) {
          deps.progress(frames, "alignment");
          continue;
        }
        if (!match.offset) {
          deps.progress(frames);
          continue;
        }
        await deps.write(
          bitmap,
          width,
          bitmap.height - match.footer - match.offset,
          height - match.footer,
          match.offset + match.footer,
        );
        height += match.offset;
      }
      previous = current;
      deps.progress(++frames);
    } finally {
      bitmap.close();
    }
    // The screenshot source also enforces Chrome's capture rate limit.
  } while (!deps.visible);
  return { width, height };
}
