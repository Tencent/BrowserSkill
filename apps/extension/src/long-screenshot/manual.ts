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

/** Image-only alignment. Textured patches vote on one vertical displacement;
 * an animated ad or stationary sidebar cannot spoil the other patches' votes.
 * A competing displacement still rejects the frame instead of guessing. */
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
  const end = h - footer;
  const bands = 7;
  const texture = (frame: FrameSignature) => {
    const result = new Uint8Array(h * bands);
    for (let y = 0; y < h; y++)
      for (let band = 0; band < bands; band++) {
        const x = 6 + band * 12;
        const reference = (Math.max(0, y - 2) * 96 + x) * 4;
        for (let dx = 0; dx < 12; dx += 3)
          for (let c = 0; c < 3; c++) {
            if (
              Math.abs(frame.pixels[(y * 96 + x + dx) * 4 + c] - frame.pixels[reference + c]) >= 2
            )
              result[y * bands + band] = 1;
          }
      }
    return result;
  };
  const texturedA = texture(a),
    texturedB = texture(b);
  const patchError = (ay: number, by: number, band: number) => {
    let error = 0;
    for (let x = 6 + band * 12; x < 18 + band * 12; x += 3) {
      const at = (ay * 96 + x) * 4,
        bt = (by * 96 + x) * 4;
      for (let c = 0; c < 3; c++) error += Math.abs(a.pixels[at + c] - b.pixels[bt + c]);
    }
    return error / 12;
  };
  // Full-height fixed sidebars can contain more text than a sparse article.
  // Exclude columns whose textured patches stay in exactly the same place.
  const stationaryBands = new Set<number>();
  for (let band = 0; band < bands; band++) {
    let count = 0,
      unchanged = 0;
    for (let y = top; y < end; y += 4) {
      if (!texturedA[y * bands + band] && !texturedB[y * bands + band]) continue;
      count++;
      if (patchError(y, y, band) < 0.5) unchanged++;
    }
    if (count >= 8 && unchanged / count >= 0.9) stationaryBands.add(band);
  }
  if (stationaryBands.size === bands) return { offset: 0, footer: 0 };
  const scores: { offset: number; quality: number }[] = [];
  const seam = Math.max(top, Math.floor(h * 0.1));
  const minimumOverlap = Math.max(48, seam - top + 8);
  const maximum = end - top - minimumOverlap;
  for (let offset = 0; offset <= maximum; offset++) {
    let quality = 0,
      matches = 0,
      rows = 0;
    const votes = new Uint8Array(bands);
    const stride = Math.max(1, Math.ceil((end - top - offset) / 64));
    for (let y = top; y < end - offset; y += stride) {
      rows++;
      for (let band = 0; band < bands; band++) {
        if (stationaryBands.has(band)) continue;
        if (!texturedA[(y + offset) * bands + band] || !texturedB[y * bands + band]) continue;
        const error = patchError(y + offset, y, band);
        if (error > 8) continue;
        matches++;
        votes[band]++;
        quality += 1 / (1 + error / 2);
      }
    }
    if (matches >= 16 && votes.filter((count) => count >= 4).length >= 2)
      scores.push({ offset, quality: quality / (rows * (bands - stationaryBands.size)) });
  }
  scores.sort((x, y) => y.quality - x.quality);
  const best = scores[0];
  if (!best || best.quality < 0.08) return null;
  const alternative = scores.find((candidate) => Math.abs(candidate.offset - best.offset) > 3);
  if (alternative && best.quality <= alternative.quality * 1.15 + 0.01) return null;
  if (!best.offset) return { offset: 0, footer: 0 };
  // Replace the entire reliable overlap, not just newly exposed rows. This
  // removes old floating footers even when they occupy only part of the width.
  return { offset: best.offset, footer: h - seam - best.offset };
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
  let misses = 0;
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
          // Smooth scrolling or an image decoding mid-frame may settle on the
          // next exposure. Warn only after consecutive misses; keep the last
          // accepted frame as the anchor so a bad frame never enters the PNG.
          deps.progress(frames, ++misses >= 2 ? "alignment" : undefined);
          continue;
        }
        misses = 0;
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
