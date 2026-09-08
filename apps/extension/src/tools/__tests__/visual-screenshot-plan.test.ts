import { describe, expect, it } from "vitest";
import {
  correctedVisualScreenshotScale,
  planVisualScreenshot,
  screenshotFitsPixelBudget,
} from "../visual-screenshot-plan";

const budget = { maxEdge: 2_048, maxPixels: 4_000_000 };

describe("visual screenshot pixel planning", () => {
  it.each([1, 1.25, 1.5, 2, 3])("accounts for raster scale %s", (rasterScaleEstimate) => {
    const plan = planVisualScreenshot({
      cssRect: { width: 2_000, height: 1_000 },
      rasterScaleEstimate,
      budget,
    });
    const width = 2_000 * rasterScaleEstimate * plan.clipScale;
    const height = 1_000 * rasterScaleEstimate * plan.clipScale;

    expect(Math.max(width, height)).toBeLessThanOrEqual(budget.maxEdge);
    expect(width * height).toBeLessThanOrEqual(budget.maxPixels);
  });

  it("corrects a scale from actual PNG dimensions", () => {
    const corrected = correctedVisualScreenshotScale({
      previousClipScale: 1,
      actualWidth: 4_000,
      actualHeight: 2_000,
      budget,
    });

    expect(corrected).not.toBeNull();
    expect(corrected as number).toBeLessThan(2_048 / 4_000);
    expect(screenshotFitsPixelBudget({ width: 2_000, height: 1_000 }, budget)).toBe(true);
    expect(screenshotFitsPixelBudget({ width: 4_000, height: 2_000 }, budget)).toBe(false);
  });
});
