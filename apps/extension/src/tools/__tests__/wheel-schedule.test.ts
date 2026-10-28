import { describe, expect, it } from "vitest";
import { waitWithinInterval, wheelSchedule } from "../wheel-schedule";

const sum = (steps: ReturnType<typeof wheelSchedule>, axis: 0 | 1) =>
  steps.reduce((total, step) => total + step[axis], 0);

describe("wheelSchedule", () => {
  it("keeps the exact delta for a single event", () => {
    expect(wheelSchedule(0, 600, 1, "linear")).toEqual([[0, 600]]);
    expect(wheelSchedule(12.5, -3, 1, "ease_out")).toEqual([[12.5, -3]]);
  });

  it.each([2, 7, 15, 40])("sums to the requested total across %i events", (events) => {
    for (const easing of ["linear", "ease_out"] as const) {
      const steps = wheelSchedule(0, 900, events, easing);
      expect(steps).toHaveLength(events);
      expect(sum(steps, 1)).toBeCloseTo(900, 9);
    }
  });

  it("splits evenly for linear and front-loads for ease_out", () => {
    const linear = wheelSchedule(0, 120, 4, "linear");
    for (const [, deltaY] of linear) expect(deltaY).toBeCloseTo(30, 9);

    const eased = wheelSchedule(0, 120, 6, "ease_out");
    for (let index = 1; index < eased.length; index += 1) {
      expect(eased[index - 1][1]).toBeGreaterThanOrEqual(eased[index][1]);
    }
    expect(eased[0][1]).toBeGreaterThan(120 / 6);
    expect(sum(eased, 1)).toBeCloseTo(120, 9);
  });

  it("applies one profile to both axes", () => {
    const steps = wheelSchedule(45, -90, 5, "ease_out");
    expect(sum(steps, 0)).toBeCloseTo(45, 9);
    expect(sum(steps, 1)).toBeCloseTo(-90, 9);
    for (const [deltaX, deltaY] of steps) {
      expect(deltaY / -90).toBeCloseTo(deltaX / 45, 9);
    }
  });
});

describe("waitWithinInterval", () => {
  it("waits the interval when the deadline allows it", async () => {
    const started = Date.now();
    await expect(waitWithinInterval(20, Date.now() + 5_000)).resolves.toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("returns false once the deadline has already passed", async () => {
    await expect(waitWithinInterval(50, Date.now() - 1)).resolves.toBe(false);
  });

  it("clamps the wait to the deadline and reports the overrun", async () => {
    const started = Date.now();
    await expect(waitWithinInterval(5_000, Date.now() + 30)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("stops waiting when the caller aborts", async () => {
    const controller = new AbortController();
    const wait = waitWithinInterval(5_000, Date.now() + 5_000, controller.signal);
    controller.abort();
    await expect(wait).resolves.toBe(false);
  });
});
