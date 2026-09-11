import { type CapturePhase, type PageCommand, type PageMetrics, ScreenshotError } from "./types";

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
  write(
    bitmap: ImageBitmap,
    width: number,
    sourceY: number,
    targetY: number,
    height: number,
  ): Promise<void>;
  signal: AbortSignal;
  progress(phase: CapturePhase, progress: number, frames: number): void;
  checkpoint?(): Promise<void>;
  prepared?(): void;
  finished?(): boolean;
  label: string;
  cancelLabel: string;
}

/** Capture one viewport at a time. Height may grow as lazy content is appended;
 * only viewport geometry and each individual exposure must remain stable. */
export async function capturePage(deps: CaptureDeps) {
  const { signal, page, progress } = deps;
  let covered = 0;
  let width = 0;
  let scale = 1;
  let frames = 0;
  let baseline: PageMetrics | undefined;
  const checkpoint = async () => {
    signal.throwIfAborted();
    await deps.checkpoint?.();
    signal.throwIfAborted();
  };
  try {
    await checkpoint();
    let metrics = await page({ action: "begin", label: deps.label, cancelLabel: deps.cancelLabel });
    deps.prepared?.();
    let y = 0;
    let failures = 0;
    let final = false;
    while (true) {
      await checkpoint();
      if (covered && deps.finished?.()) break;
      metrics = await page({ action: "move", y, capture: true, final });
      if (baseline && !sameLayout({ ...baseline, height: metrics.height }, metrics, false))
        throw new ScreenshotError("changed");
      if (metrics.height < covered - 0.5) throw new ScreenshotError("changed");
      baseline ??= metrics;
      const bitmap = await deps.screenshot();
      try {
        signal.throwIfAborted();
        const after = await page({ action: "inspect" });
        if (!sameLayout(metrics, after)) {
          if (++failures >= 3) throw new ScreenshotError("changed");
          continue;
        }
        failures = 0;
        if (!frames) {
          scale = bitmap.width / metrics.innerWidth;
          width = Math.round(metrics.viewportWidth * scale);
        }
        if (
          Math.abs(bitmap.width - metrics.innerWidth * scale) > 1 ||
          Math.abs(bitmap.height - metrics.innerHeight * scale) > 1
        )
          throw new ScreenshotError("changed");
        const slice = sliceForFrame(metrics, covered, scale);
        if (slice.sourceY < 0 || slice.sourceY + slice.height > bitmap.height || slice.height < 0)
          throw new ScreenshotError("changed");
        if (slice.height) {
          await deps.write(bitmap, width, slice.sourceY, slice.targetY, slice.height);
          covered = slice.end;
          frames++;
        }
        progress("capturing", Math.min(99, Math.round((covered / metrics.height) * 100)), frames);
      } finally {
        bitmap.close();
      }
      if (covered >= metrics.height - 0.5) {
        // A second stable bottom exposure catches appended content and includes
        // the fixed footer exactly once. Disk tiles allow rewriting that overlap.
        if (final) break;
        final = true;
        y = metrics.y;
      } else {
        final = false;
        y = Math.max(0, covered - Math.floor(metrics.viewportHeight * 0.15));
        if (y <= metrics.y && covered < metrics.height) throw new ScreenshotError("unsupported");
      }
    }
    return { width, height: Math.round(covered * scale) };
  } finally {
    await page({ action: "finish" }).catch(() => {});
  }
}
