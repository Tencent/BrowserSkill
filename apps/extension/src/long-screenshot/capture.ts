import { type CapturePhase, type PageCommand, type PageMetrics, ScreenshotError } from "./types";

// Bound both the canvas dimension and its RGBA allocation. Never silently truncate.
export const MAX_DIMENSION = 32_760;
export const MAX_PIXELS = 48_000_000;
export const MAX_STEPS = 120;

export function checkSize(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new ScreenshotError("tooLarge");
  }
}

/** Round document boundaries once, so fractional zoom cannot accumulate seams. */
export function sliceForFrame(metrics: PageMetrics, covered: number, scale: number) {
  if (metrics.y > covered + 0.5) throw new ScreenshotError("changed");
  const end = Math.min(metrics.y + metrics.viewportHeight, metrics.height);
  // A tiny final scroll must still include the whole fixed footer. Redraw its
  // overlap rather than chopping it down to the last few uncovered rows.
  const footerStart =
    metrics.height - Math.min(metrics.viewportHeight, metrics.bottomOverlayHeight ?? 0);
  const start =
    end === metrics.height ? Math.min(covered, Math.max(metrics.y, footerStart)) : covered;
  const topPx = Math.round(start * scale);
  const bottomPx = Math.round(end * scale);
  return {
    sourceY: topPx - Math.round(metrics.y * scale),
    targetY: topPx,
    height: bottomPx - topPx,
    end,
  };
}

export function sameLayout(a: PageMetrics, b: PageMetrics, includePosition = true) {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.viewportWidth === b.viewportWidth &&
    a.viewportHeight === b.viewportHeight &&
    a.innerWidth === b.innerWidth &&
    a.innerHeight === b.innerHeight &&
    a.dpr === b.dpr &&
    (!includePosition || (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5))
  );
}

export interface CaptureDeps {
  page(command: PageCommand): Promise<PageMetrics>;
  screenshot(): Promise<ImageBitmap>;
  signal: AbortSignal;
  progress(phase: CapturePhase, progress: number, frames: number): void;
  label: string;
  cancelLabel: string;
}

export async function capturePage(deps: CaptureDeps) {
  const { signal, page, progress } = deps;
  let canvas: OffscreenCanvas | undefined;
  const started = Date.now();
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() - started > 180_000) throw new ScreenshotError("timeout");
  };
  try {
    check();
    let metrics = await page({ action: "begin", label: deps.label, cancelLabel: deps.cancelLabel });
    // Warm up lazy content before allocating the image; otherwise earlier slices
    // could be laid out against a different document height than later slices.
    let y = 0;
    let stableBottom = 0;
    for (let step = 0; ; step++) {
      check();
      if (step >= MAX_STEPS) throw new ScreenshotError("tooLarge");
      const previous = metrics;
      metrics = await page({ action: "move", y, capture: false });
      checkSize(metrics.viewportWidth * metrics.dpr, metrics.height * metrics.dpr);
      progress(
        "preparing",
        Math.min(99, Math.round(((metrics.y + metrics.viewportHeight) / metrics.height) * 100)),
        0,
      );
      if (metrics.y + metrics.viewportHeight >= metrics.height - 0.5) {
        stableBottom = metrics.height === previous.height ? stableBottom + 1 : 0;
        if (stableBottom >= 2) break;
        y = metrics.height;
      } else {
        stableBottom = 0;
        y = metrics.y + Math.max(1, Math.floor(metrics.viewportHeight * 0.85));
        if (step > 0 && metrics.y <= previous.y && y < metrics.height) {
          throw new ScreenshotError("unsupported");
        }
      }
    }

    let covered = 0;
    let frames = 0;
    progress("capturing", 0, 0);
    let scale = 1;
    let baseline: PageMetrics | undefined;
    while (covered < metrics.height - 0.5) {
      check();
      if (frames >= MAX_STEPS) throw new ScreenshotError("tooLarge");
      metrics = await page({
        action: "move",
        y: frames === 0 ? 0 : Math.max(0, covered - Math.floor(metrics.viewportHeight * 0.15)),
        capture: true,
      });
      if (baseline && !sameLayout(baseline, metrics, false)) throw new ScreenshotError("changed");
      baseline ??= metrics;
      check();
      const bitmap = await deps.screenshot();
      try {
        check();
        const after = await page({ action: "inspect" });
        if (!sameLayout(metrics, after)) throw new ScreenshotError("changed");
        if (!canvas) {
          scale = bitmap.width / metrics.innerWidth;
          const width = Math.round(metrics.viewportWidth * scale);
          const height = Math.round(metrics.height * scale);
          checkSize(width, height);
          canvas = new OffscreenCanvas(width, height);
        }
        if (
          Math.abs(bitmap.width - metrics.innerWidth * scale) > 1 ||
          Math.abs(bitmap.height - metrics.innerHeight * scale) > 1
        )
          throw new ScreenshotError("changed");
        const slice = sliceForFrame(metrics, covered, scale);
        if (
          slice.height <= 0 ||
          slice.sourceY < 0 ||
          slice.sourceY + slice.height > bitmap.height
        ) {
          throw new ScreenshotError("changed");
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new ScreenshotError("tooLarge");
        ctx.drawImage(
          bitmap,
          0,
          slice.sourceY,
          canvas.width,
          slice.height,
          0,
          slice.targetY,
          canvas.width,
          slice.height,
        );
        covered = slice.end;
        frames++;
        progress("capturing", Math.min(100, Math.round((covered / metrics.height) * 100)), frames);
      } finally {
        bitmap.close();
      }
    }
    check();
    if (!canvas) throw new ScreenshotError("captureFailed");
    progress("saving", 100, frames);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    check();
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    // Also run after a lost begin response: the content side may have already
    // changed styles. Its independent watchdog handles an unreachable page.
    await page({ action: "finish" }).catch(() => {});
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}
