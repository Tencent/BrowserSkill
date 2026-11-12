import { describe, expect, it, vi } from "vitest";
import {
  type NativeClockSample,
  NativeInputClock,
  NativeInputClockError,
} from "../native-input-clock";

function buildBatch(options: {
  offsetMs: number;
  fractions: number[];
  sampleSpanMs?: number;
}): NativeClockSample[] {
  const { offsetMs, fractions, sampleSpanMs = 0.05 } = options;
  return fractions.map((fraction, idx) => {
    const wall = 1_700_000_000_000 + idx * 2;
    const trueWall = wall + fraction;
    const before = 100 + idx * 2;
    const after = before + sampleSpanMs;
    const timestamp = wall + 100_000;
    const eventTimestamp = timestamp + before - trueWall + offsetMs;
    return { timestamp, eventTimestamp, before, wall, after };
  });
}

describe("NativeInputClock", () => {
  it("calibrates cleanly when all 7 probes share a narrow fractional-millisecond phase", async () => {
    const sample = vi.fn(async () =>
      buildBatch({
        offsetMs: 42,
        fractions: [0.3, 0.31, 0.32, 0.33, 0.34, 0.35, 0.36],
      }),
    );
    const clock = new NativeInputClock(sample);
    const prepared = await clock.prepare();
    expect(sample).toHaveBeenCalledTimes(1);
    const estimatedOffset = prepared.timestamp - prepared.nativeTimestamp * 1000;
    expect(Math.abs(estimatedOffset - 42)).toBeLessThanOrEqual(1);
    expect(() => prepared.assertValid()).not.toThrow();
  });

  it("retries transient probe jitter once and succeeds on the next batch", async () => {
    let calls = 0;
    const sample = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        // Simulate a hypervisor preemption spike between two samples (`latest < earliest`).
        const noisy = buildBatch({
          offsetMs: 15,
          fractions: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
        });
        noisy[3] = { ...noisy[3], eventTimestamp: noisy[3].eventTimestamp + 5 };
        return noisy;
      }
      return buildBatch({
        offsetMs: 15,
        fractions: [0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25],
      });
    });
    const clock = new NativeInputClock(sample);
    const prepared = await clock.prepare();
    expect(sample).toHaveBeenCalledTimes(2);
    const estimatedOffset = prepared.timestamp - prepared.nativeTimestamp * 1000;
    expect(Math.abs(estimatedOffset - 15)).toBeLessThanOrEqual(1);
  });

  it("rejects persistent clock instability after bounded retries without retrying probe timeouts", async () => {
    const unstable = vi.fn(async () => {
      const batch = buildBatch({
        offsetMs: 0,
        fractions: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
      });
      batch[6] = { ...batch[6], eventTimestamp: batch[6].eventTimestamp + 10 };
      return batch;
    });
    const clock = new NativeInputClock(unstable);
    await expect(clock.prepare()).rejects.toThrow("The browser's native input clock is not stable");
    expect(unstable).toHaveBeenCalledTimes(3);

    const timedOut = vi.fn(async () => {
      throw new NativeInputClockError("Native input clock calibration timed out");
    });
    const timeoutClock = new NativeInputClock(timedOut);
    await expect(timeoutClock.prepare()).rejects.toThrow(
      "Native input clock calibration timed out",
    );
    expect(timedOut).toHaveBeenCalledTimes(1);
  });
});
