export interface ScreenshotPixelBudget {
  maxEdge: number;
  maxPixels: number;
}

export interface VisualScreenshotPlan {
  clipScale: number;
}

export function planVisualScreenshot(input: {
  cssRect: { width: number; height: number };
  rasterScaleEstimate: number;
  budget: ScreenshotPixelBudget;
}): VisualScreenshotPlan {
  const rasterScale =
    Number.isFinite(input.rasterScaleEstimate) && input.rasterScaleEstimate > 0
      ? input.rasterScaleEstimate
      : 1;
  const { width, height } = input.cssRect;
  const scale = Math.min(
    1,
    input.budget.maxEdge / (width * rasterScale),
    input.budget.maxEdge / (height * rasterScale),
    Math.sqrt(input.budget.maxPixels / (width * height * rasterScale * rasterScale)),
  );
  return { clipScale: Math.max(Number.EPSILON, scale) };
}

export function correctedVisualScreenshotScale(input: {
  previousClipScale: number;
  actualWidth: number;
  actualHeight: number;
  budget: ScreenshotPixelBudget;
}): number | null {
  const correction = Math.min(
    input.budget.maxEdge / input.actualWidth,
    input.budget.maxEdge / input.actualHeight,
    Math.sqrt(input.budget.maxPixels / (input.actualWidth * input.actualHeight)),
  );
  if (!Number.isFinite(correction) || correction >= 1 || correction <= 0) return null;
  return Math.max(Number.EPSILON, input.previousClipScale * correction * 0.999);
}

export function screenshotFitsPixelBudget(
  dimensions: { width: number; height: number },
  budget: ScreenshotPixelBudget,
): boolean {
  return (
    Math.max(dimensions.width, dimensions.height) <= budget.maxEdge &&
    dimensions.width * dimensions.height <= budget.maxPixels
  );
}
