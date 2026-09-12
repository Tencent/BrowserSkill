import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import { screenshotPageRect } from "./geometry/coordinate-types";
import { parsePngDimensions } from "./png";
import type { CdpRunner } from "./shared";
import {
  resolveVisualRegionNow,
  sameVisualMapping,
  type VisualTargetState,
  verifyCapturedTarget,
} from "./visual-target";
import { isAbortError, throwIfAborted } from "./vom/capture-abort";
import type { VisualCandidate } from "./vom/visual-discovery";

function stale(message: string): RpcError {
  return rpcError(
    "not_found",
    "visual_target_changed",
    `${message}; observe again before requesting a screenshot`,
  );
}
/** Scale affects raster size only, never the selected CSS region. */
export function visualScreenshotScale(width: number, height: number, pixelsPerCss: number): number {
  if (![width, height, pixelsPerCss].every((n) => Number.isFinite(n) && n > 0))
    throw new Error("invalid screenshot pixel dimensions");
  return Math.min(
    1,
    2048 / (Math.max(width, height) * pixelsPerCss),
    Math.sqrt(4_000_000 / (width * height * pixelsPerCss * pixelsPerCss)),
  );
}

/** One target only. No frame discovery, scrolling, AX, or snapshot recapture. */
export async function captureVisualScreenshot(
  cdp: CdpRunner,
  candidate: VisualCandidate,
  signal?: AbortSignal,
): Promise<
  | {
      image_base64: string;
      width: number;
      height: number;
      mapping?: VisualTargetState;
      capture_unavailable?: string;
    }
  | RpcError
> {
  try {
    let region = await resolveVisualRegionNow(cdp, candidate, signal);
    if ("code" in region) return region;
    let scale = visualScreenshotScale(region.crop.width, region.crop.height, region.dpr);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        // A new raster attempt needs fresh geometry, not the previous crop/cache.
        region = await resolveVisualRegionNow(cdp, candidate, signal);
        if ("code" in region) return region;
        scale = Math.min(
          scale,
          visualScreenshotScale(region.crop.width, region.crop.height, region.dpr),
        );
      }
      const clip = screenshotPageRect(region.crop, region.viewport);
      if (!clip) return stale("invalid screenshot coordinates");
      throwIfAborted(signal);
      if (
        cdp.getAttachmentId?.(candidate.document.target.tabId) !== candidate.document.attachmentId
      )
        return stale("visual attachment changed");
      const shot = await cdp.send<{ data?: string }>(
        candidate.document.target.tabId,
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false, clip: { ...clip.rect, scale } },
      );
      throwIfAborted(signal);
      if (
        cdp.getAttachmentId?.(candidate.document.target.tabId) !== candidate.document.attachmentId
      )
        return stale("visual attachment changed");
      let after: VisualTargetState | RpcError;
      try {
        after = await resolveVisualRegionNow(cdp, candidate, signal, true);
      } catch (error) {
        throwIfAborted(signal);
        if (isAbortError(error)) throw error;
        after = stale("post-capture mapping unavailable");
      }
      if ("code" in after) {
        // Preserve PR7 viewing behavior when geometry became unsupported, but never
        // return an image whose identity could not be confirmed.
        const identityError = await verifyCapturedTarget(cdp, candidate, signal);
        if (identityError) return identityError;
      }
      const mapping = !("code" in after) && sameVisualMapping(region, after) ? region : undefined;
      const dims = shot.data ? parsePngDimensions(shot.data) : null;
      if (!dims)
        return rpcError(
          "cdp_failed",
          "screenshot_capture_failed",
          "visual screenshot returned invalid PNG dimensions",
        );
      const correction = visualScreenshotScale(dims.width, dims.height, 1);
      if (correction === 1)
        return {
          image_base64: shot.data!,
          ...dims,
          ...(mapping
            ? { mapping }
            : {
                capture_unavailable:
                  "visual mapping changed during capture; observe and screenshot again",
              }),
        };
      scale *= correction * 0.99;
    }
    return rpcError(
      "cdp_failed",
      "visual_pixel_budget_exceeded",
      "visual screenshot exceeds the pixel budget",
    );
  } catch (error) {
    if (isAbortError(error) || signal?.aborted)
      return { code: "cancelled", message: "visual screenshot aborted" };
    return rpcError(
      "cdp_failed",
      "screenshot_capture_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
