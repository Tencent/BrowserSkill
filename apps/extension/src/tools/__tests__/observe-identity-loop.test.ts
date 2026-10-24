// Issue #465 §1 / #454: pages with anti-debugging protection reload
// themselves whenever the debugger attaches, so repeated reads keep
// failing with the same identity error. The streak rule must name the
// condition only after demonstrated repetition, and with a stable reason.

import { describe, expect, it } from "vitest";
import { nextObserveIdentityStreak, OBSERVE_IDENTITY_LOOP_FAILURES } from "../observation";

describe("observe identity reload-loop streak", () => {
  it("does not flag an isolated failure", () => {
    const first = nextObserveIdentityStreak(undefined, 1_000, 120_000);
    expect(first.isReloadLoop).toBe(false);
    expect(first.streak).toEqual({ count: 1, firstAt: 1_000, lastAt: 1_000 });
  });

  it("needs consecutive failures inside the window before naming anti-debugging", () => {
    const first = nextObserveIdentityStreak(undefined, 0, 120_000);
    const second = nextObserveIdentityStreak(first.streak, 3_000, 120_000);
    expect(second.isReloadLoop).toBe(false);
    expect(second.streak).toEqual({ count: 2, firstAt: 0, lastAt: 3_000 });
    const third = nextObserveIdentityStreak(second.streak, 6_000, 120_000);
    expect(third.isReloadLoop).toBe(true);
    expect(third.streak.count).toBe(OBSERVE_IDENTITY_LOOP_FAILURES);
  });

  it("failures spread wider than the window restart the streak", () => {
    const first = nextObserveIdentityStreak(undefined, 0, 120_000);
    const next = nextObserveIdentityStreak(first.streak, 120_001, 120_000);
    expect(next.isReloadLoop).toBe(false);
    expect(next.streak.count).toBe(1);
    // And repeated restarts never accumulate into the list arbitrarily:
    // three *far* apart failures stay three separate isolated failures.
    const again = nextObserveIdentityStreak(next.streak, 130_000, 120_000);
    expect(again.isReloadLoop).toBe(false);
    expect(again.streak.count).toBe(2);
  });

  it("defaults the streak window to the published constant", () => {
    const first = nextObserveIdentityStreak(undefined, 0);
    expect(first.streak.count).toBe(1);
  });
});
