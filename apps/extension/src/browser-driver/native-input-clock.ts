import type { RpcError, TransferEffectState } from "@/transport/types";

/** A trusted probe in an extension-owned document, never in a task page. */
export interface NativeClockSample {
  timestamp: number;
  eventTimestamp: number;
  before: number;
  wall: number;
  after: number;
}

export interface NativeInputTimestamp {
  /** Logical action time used by each frame's existing input expectation. */
  timestamp: number;
  /** Epoch seconds compensated for the browser's actual native conversion. */
  nativeTimestamp: number;
  /** Synchronous fence immediately before the native command is sent. */
  assertValid(): void;
}

export class NativeInputClockError extends Error {
  constructor(message = "The browser's native input clock could not be calibrated") {
    super(message);
    this.name = "NativeInputClockError";
  }

  toRpcError(effect: TransferEffectState = "none"): RpcError {
    return {
      code: "cdp_failed",
      message: this.message,
      data: {
        reason: "input_clock_unavailable",
        phase: "precondition",
        effect_state: effect,
        recovery:
          "Inspect the application result and synchronize before deciding again. The refused native event was not sent; never replay an uncertain submission.",
      },
    };
  }
}

interface Reading {
  wall: number;
  ticks: number;
  earliest: number;
  latest: number;
}

interface Calibration {
  offset: number;
  reference: Reading;
}

const MAX_AGE_MS = 60_000;
const CLOCK_CHANGE_PRECISION_MS = 0.25;
const PROBE_PRECISION_MS = 0.25;
// Each sample enforces `after - before <= 0.5`, so its truncated `Date.now()` interval has width
// `1 + 2 * PROBE_PRECISION_MS + (after - before) <= 2.0ms`. Any non-empty intersection (`earliest <= latest`)
// is a subset of each sample's interval, keeping midpoint error `<= 1.0ms` (`< INPUT_CLOCK_PRECISION_MS = 1.5ms`).
const MAX_SAMPLE_SPAN_MS = 0.5;
const MAX_CALIBRATION_ATTEMPTS = 3;

function reading(): Reading {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = performance.now();
    const wall = Date.now();
    const after = performance.now();
    if ([before, wall, after].every(Number.isFinite) && after >= before && after - before <= 0.5)
      return { wall, ticks: after, earliest: wall - after, latest: wall + 1 - before };
  }
  throw new NativeInputClockError("The browser's input clock sample was interrupted");
}

function sameClock(reference: Reading, current: Reading): boolean {
  return (
    current.ticks >= reference.ticks &&
    current.ticks - reference.ticks < MAX_AGE_MS &&
    current.earliest <= reference.latest + CLOCK_CHANGE_PRECISION_MS &&
    current.latest >= reference.earliest - CLOCK_CHANGE_PRECISION_MS
  );
}

/** Keep the collector's narrow attribution window; correct the dispatched epoch instead.
 * Older Chromium caches epoch->TimeTicks across sleep/clock changes. Newer builds
 * sample both clocks per dispatch. Measuring the conversion supports either one. */
export class NativeInputClock {
  private calibration?: Calibration;
  private pending?: Promise<void>;
  private revision = 0;

  constructor(private readonly sample: () => Promise<NativeClockSample[]>) {}

  invalidate(): void {
    this.revision++;
    this.calibration = undefined;
  }

  private async calibrate(): Promise<void> {
    const revision = this.revision;
    let lastError: NativeInputClockError | undefined;
    for (let attempt = 0; attempt < MAX_CALIBRATION_ATTEMPTS; attempt++) {
      if (attempt > 0) await Promise.resolve();
      if (this.revision !== revision) {
        throw new NativeInputClockError("The browser's native input clock is not stable");
      }
      let reference: Reading;
      try {
        reference = reading();
      } catch (error) {
        if (error instanceof NativeInputClockError) {
          lastError = error;
          continue;
        }
        throw error;
      }
      const samples = await this.sample();
      if (samples.length < 3) {
        throw new NativeInputClockError("Native clock probes were incomplete");
      }
      try {
        let earliest = -Infinity;
        let latest = Infinity;
        for (const sample of samples) {
          if (
            ![
              sample.timestamp,
              sample.eventTimestamp,
              sample.before,
              sample.wall,
              sample.after,
            ].every(Number.isFinite) ||
            sample.eventTimestamp <= 0 ||
            sample.after < sample.before ||
            sample.after - sample.before > MAX_SAMPLE_SPAN_MS
          ) {
            throw new NativeInputClockError("The browser returned an invalid native clock sample");
          }
          // Date.now truncates; the true wall sample is in [wall, wall+1).
          earliest = Math.max(
            earliest,
            sample.eventTimestamp -
              sample.after -
              sample.timestamp +
              sample.wall -
              PROBE_PRECISION_MS,
          );
          latest = Math.min(
            latest,
            sample.eventTimestamp -
              sample.before -
              sample.timestamp +
              sample.wall +
              1 +
              PROBE_PRECISION_MS,
          );
        }
        if (this.revision !== revision || latest < earliest || !sameClock(reference, reading())) {
          throw new NativeInputClockError("The browser's native input clock is not stable");
        }
        this.calibration = { offset: (earliest + latest) / 2, reference };
        return;
      } catch (error) {
        if (!(error instanceof NativeInputClockError) || this.revision !== revision) {
          throw error;
        }
        lastError = error;
      }
    }
    throw lastError ?? new NativeInputClockError("The browser's native input clock is not stable");
  }

  async prepare(): Promise<NativeInputTimestamp> {
    if (this.calibration && !sameClock(this.calibration.reference, reading())) this.invalidate();
    if (!this.calibration) {
      if (!this.pending) {
        const pending = this.calibrate().finally(() => {
          if (this.pending === pending) this.pending = undefined;
        });
        this.pending = pending;
      }
      await this.pending;
    }
    const calibration = this.calibration;
    const current = reading();
    if (!calibration || !sameClock(calibration.reference, current)) {
      this.invalidate();
      throw new NativeInputClockError("The browser's input clock changed during calibration");
    }
    return {
      timestamp: current.wall,
      nativeTimestamp: (current.wall - calibration.offset) / 1000,
      assertValid: () => {
        if (this.calibration !== calibration || !sameClock(calibration.reference, reading())) {
          if (this.calibration === calibration) this.invalidate();
          throw new NativeInputClockError(
            "The browser's input clock changed before native dispatch",
          );
        }
      },
    };
  }
}
