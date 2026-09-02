import { afterEach, describe, expect, it, vi } from "vitest";
import { ProbeBudget, resetOverlayBypassDepth, withOverlayBypass } from "../hover-perception";

afterEach(() => {
  resetOverlayBypassDepth();
});

describe("ProbeBudget", () => {
  it("refuses a candidate that cannot finish inside the budget", () => {
    const budget = new ProbeBudget(500);

    expect(budget.canAfford(400)).toBe(true);
    expect(budget.canAfford(600)).toBe(false);
  });

  it("stops admitting candidates once the remaining budget is smaller than one", async () => {
    const budget = new ProbeBudget(60);
    await new Promise((resolve) => setTimeout(resolve, 40));

    // A top-of-loop `elapsed > total` check would still admit this candidate
    // and then overshoot by its full cost.
    expect(budget.canAfford(50)).toBe(false);
  });
});

describe("withOverlayBypass", () => {
  it("toggles the overlay once around nested probe phases", async () => {
    const bypass = vi.fn(async () => {});

    await withOverlayBypass(bypass, 4, async () => {
      await withOverlayBypass(bypass, 4, async () => {
        expect(bypass).toHaveBeenCalledTimes(1);
      });
      expect(bypass).toHaveBeenCalledTimes(1);
    });

    expect(bypass.mock.calls).toEqual([
      [4, true],
      [4, false],
    ]);
  });

  it("restores the overlay when the probe throws", async () => {
    const bypass = vi.fn(async () => {});

    await expect(
      withOverlayBypass(bypass, 4, async () => {
        throw new Error("probe exploded");
      }),
    ).rejects.toThrow("probe exploded");

    expect(bypass).toHaveBeenLastCalledWith(4, false);
  });

  it("reports a failed restore instead of swallowing it", async () => {
    const onRestoreFailure = vi.fn();
    const bypass = vi.fn(async (_tabId: number, enabled: boolean) => {
      if (!enabled) throw new Error("tab is gone");
    });

    await withOverlayBypass(bypass, 4, async () => undefined, { onRestoreFailure });

    expect(onRestoreFailure).toHaveBeenCalledTimes(1);
  });

  it("does not pin the overlay off for the tab when a restore fails", async () => {
    const failing = vi.fn(async (_tabId: number, enabled: boolean) => {
      if (!enabled) throw new Error("tab is gone");
    });
    await withOverlayBypass(failing, 4, async () => undefined, { onRestoreFailure: () => {} });

    const bypass = vi.fn(async () => {});
    await withOverlayBypass(bypass, 4, async () => undefined);

    expect(bypass.mock.calls).toEqual([
      [4, true],
      [4, false],
    ]);
  });

  it("runs the probe untouched when no bypass is wired up", async () => {
    await expect(withOverlayBypass(undefined, 4, async () => "done")).resolves.toBe("done");
  });
});
