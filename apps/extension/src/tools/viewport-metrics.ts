import type { CdpRunner } from "./shared";

/** Estimate the raster/CSS ratio used by top-level Page.captureScreenshot. */
export async function topLevelScreenshotRasterScale(
  cdp: CdpRunner,
  tabId: number,
): Promise<number> {
  try {
    const reply = await cdp.send<{ result?: { value?: unknown } }>(tabId, "Runtime.evaluate", {
      expression: "window.devicePixelRatio",
      returnByValue: true,
    });
    const value = reply.result?.value;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}
