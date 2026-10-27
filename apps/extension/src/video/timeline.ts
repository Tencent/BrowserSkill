/** Keeps real elapsed time when compositor frames are sparse or arrive in bursts. */
export class VideoTimeline {
  private end = 0;
  private lastKey = -Infinity;

  constructor(
    readonly fps: number,
    readonly limitMs: number,
  ) {}

  advance(elapsedMs: number, final = false) {
    const next = Math.min(this.limitMs, Math.max(0, elapsedMs));
    if (!Number.isFinite(next) || next <= this.end) return null;
    if (!final && next - this.end < 1000 / this.fps) return null;
    const start = this.end;
    this.end = next;
    const keyFrame = start - this.lastKey >= 1000;
    if (keyFrame) this.lastKey = start;
    return {
      timestamp: Math.round(start * 1000),
      duration: Math.max(1, Math.round((next - start) * 1000)),
      keyFrame,
    };
  }

  get durationMs() {
    return this.end;
  }
}

export function videoDimensions(width: number, height: number, maximum: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
    throw new Error("The page returned invalid video dimensions");
  const scale = Math.min(1, maximum / Math.max(width, height));
  return {
    width: Math.max(2, Math.floor((width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((height * scale) / 2) * 2),
  };
}

/** CDP uses an epoch timestamp; normalize it once and reject clock discontinuities. */
export class FrameClock {
  private origin?: number;
  private last = 0;

  elapsed(timestamp: number | undefined, monotonicElapsed: number): number {
    const source = timestamp === undefined ? NaN : timestamp * 1000;
    if (this.origin === undefined && Number.isFinite(source))
      this.origin = source - monotonicElapsed;
    const candidate = this.origin === undefined ? NaN : source - this.origin;
    const elapsed =
      Number.isFinite(candidate) && Math.abs(candidate - monotonicElapsed) < 1000
        ? candidate
        : monotonicElapsed;
    this.last = Math.max(this.last, elapsed, 0);
    return this.last;
  }
}
