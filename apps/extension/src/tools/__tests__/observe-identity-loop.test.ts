// Issue #465 §1 / #454: pages with anti-debugging protection reload
// themselves whenever the debugger attaches, so repeated reads keep
// failing with the same identity error. The streak rule must name the
// condition only after demonstrated repetition — and only on the same
// page: maintainer review added that navigating the same tab to three
// sites (one transient failure each) must not falsely diagnose the
// third site.

import { describe, expect, it } from "vitest";
import {
  nextObserveIdentityStreak,
  OBSERVE_IDENTITY_LOOP_FAILURES,
  observeIdentityReloadLoopError,
} from "../observation";
import { OBSERVE_IDENTITY_CHANGED } from "../vom/capture-coordinator";

const SITE_A = "https://site-a.example/search";
const SITE_B = "https://site-b.example/search";
const SITE_C = "https://site-c.example/search";

describe("observe identity reload-loop streak", () => {
  it("does not flag an isolated failure", () => {
    const first = nextObserveIdentityStreak(undefined, SITE_A, 1_000, 120_000);
    expect(first.isReloadLoop).toBe(false);
    expect(first.streak).toEqual({
      url: SITE_A,
      count: 1,
      firstAt: 1_000,
      lastAt: 1_000,
    });
  });

  it("needs consecutive same-page failures inside the window before naming anti-debugging", () => {
    const first = nextObserveIdentityStreak(undefined, SITE_A, 0, 120_000);
    const second = nextObserveIdentityStreak(first.streak, SITE_A, 3_000, 120_000);
    expect(second.isReloadLoop).toBe(false);
    expect(second.streak).toEqual({
      url: SITE_A,
      count: 2,
      firstAt: 0,
      lastAt: 3_000,
    });
    const third = nextObserveIdentityStreak(second.streak, SITE_A, 6_000, 120_000);
    expect(third.isReloadLoop).toBe(true);
    expect(third.streak.count).toBe(OBSERVE_IDENTITY_LOOP_FAILURES);
  });

  it("a navigation to another site restarts the streak (regression: one transient failure on each of three sites must never diagnose site three)", () => {
    let next = nextObserveIdentityStreak(undefined, SITE_A, 0, 120_000);
    expect(next.isReloadLoop).toBe(false);
    next = nextObserveIdentityStreak(next.streak, SITE_B, 1_000, 120_000);
    expect(next.isReloadLoop).toBe(false);
    const third = nextObserveIdentityStreak(next.streak, SITE_C, 2_000, 120_000);
    // The third site has failed only once; the diagnosis must never carry
    // across navigations.
    expect(third.isReloadLoop).toBe(false);
    expect(third.streak).toEqual({
      url: SITE_C,
      count: 1,
      firstAt: 2_000,
      lastAt: 2_000,
    });
  });

  it("failures spread wider than the window restart the streak", () => {
    const first = nextObserveIdentityStreak(undefined, SITE_A, 0, 120_000);
    const next = nextObserveIdentityStreak(first.streak, SITE_A, 120_001, 120_000);
    expect(next.isReloadLoop).toBe(false);
    expect(next.streak.count).toBe(1);
    // And a later failure still counts alone, so slow pages never trigger it.
    const again = nextObserveIdentityStreak(next.streak, SITE_A, 130_000, 120_000);
    expect(again.isReloadLoop).toBe(false);
    expect(again.streak.count).toBe(2);
  });

  it("repeated reloads of the same page keep being detected after site switches", () => {
    // The streak carries per page: two failures on site A are forgotten
    // on navigation, then a genuine loop on the new site is diagnosed
    // once three failures accumulate on *it*.
    let next = nextObserveIdentityStreak(undefined, SITE_A, 0, 120_000);
    next = nextObserveIdentityStreak(next.streak, SITE_A, 1_000, 120_000);
    next = nextObserveIdentityStreak(next.streak, SITE_B, 2_000, 120_000); // navigate away
    expect(next.isReloadLoop).toBe(false); // previous site's failures are not carried
    next = nextObserveIdentityStreak(next.streak, SITE_B, 3_000, 120_000);
    expect(next.isReloadLoop).toBe(false);
    next = nextObserveIdentityStreak(next.streak, SITE_B, 4_000, 120_000);
    expect(next.isReloadLoop).toBe(true);
    expect(next.streak.url).toBe(SITE_B);
  });

  it("defaults the streak window to the published constant", () => {
    const first = nextObserveIdentityStreak(undefined, SITE_A, 0);
    expect(first.streak.count).toBe(1);
  });

  it("keeps the stable anti-debugging marker importable for detection", () => {
    expect(OBSERVE_IDENTITY_CHANGED).toContain("observation document identity changed");
  });
});

// Handler-level plumbing (maintainer review, P1): `ResolvedTargetTab.url`
// is optional, and a failure on a tab whose URL is unavailable must not
// count toward a page-specific streak — the original error is preserved.
describe("observe identity reload-loop error plumbing", () => {
  const ctxOf = (sessionId: string) =>
    ({ sessionId }) as unknown as Parameters<typeof observeIdentityReloadLoopError>[0];
  const identityFailure = () => new Error(OBSERVE_IDENTITY_CHANGED);

  it("never counts failures with an unavailable URL toward a streak", () => {
    const ctx = ctxOf("sess-nourl");
    // If these were counted anywhere shared, the third failure would flip
    // to the anti-debugging error; each must instead round-trip to the
    // plain identity-changed cdp_failed path.
    for (const url of [undefined, "", undefined]) {
      expect(observeIdentityReloadLoopError(ctx, 7, url, identityFailure())).toBeNull();
    }
  });

  it("still names the loop once a URL is known, with the page-scoped reason", () => {
    const ctx = ctxOf("sess-withurl");
    expect(observeIdentityReloadLoopError(ctx, 11, SITE_A, identityFailure())).toBeNull();
    expect(observeIdentityReloadLoopError(ctx, 11, SITE_A, identityFailure())).toBeNull();
    const third = observeIdentityReloadLoopError(ctx, 11, SITE_A, identityFailure());
    expect(third).not.toBeNull();
    expect(third?.code).toBe("cdp_failed");
    expect(third?.data?.reason).toBe("observe_identity_reload_loop");
    expect(third?.message).toContain(OBSERVE_IDENTITY_CHANGED);
  });

  it("an unavailable URL does not seed a later same-tab streak", () => {
    const ctx = ctxOf("sess-seed");
    expect(observeIdentityReloadLoopError(ctx, 5, undefined, identityFailure())).toBeNull();
    // The tab resolves to a URL afterwards: only its own failures count.
    expect(observeIdentityReloadLoopError(ctx, 5, SITE_B, identityFailure())).toBeNull();
  });

  it("keeps unrelated errors untouched", () => {
    const ctx = ctxOf("sess-other");
    expect(observeIdentityReloadLoopError(ctx, 3, SITE_C, new Error("boom"))).toBeNull();
  });
});
