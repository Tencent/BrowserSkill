import { type CdpTarget, cdpTargetKey } from "@/browser-driver/frame-graph";
import type { GeometryProjection, ViewportRect } from "../geometry";
import { projectRectToViewport } from "../geometry";

export interface CoordinateOwner {
  target: CdpTarget;
  frameId?: string;
}

export interface FrameViewportRect {
  space: "frame-viewport-css";
  owner: CoordinateOwner;
  rect: ViewportRect;
}

export interface SnapshotProjection {
  source: CoordinateOwner;
  geometry: GeometryProjection;
}

/** DOMSnapshot bounds are document-relative CSS pixels, independent of raster DPR. */
export function snapshotViewportRect(
  bounds: number[],
  owner: CoordinateOwner,
  scroll: { x: number; y: number },
): FrameViewportRect | null {
  if (bounds.length < 4 || !bounds.slice(0, 4).every(Number.isFinite)) return null;
  const [x, y, width, height] = bounds;
  if (width <= 0 || height <= 0 || !Number.isFinite(scroll.x) || !Number.isFinite(scroll.y)) {
    return null;
  }
  return {
    space: "frame-viewport-css",
    owner,
    rect: { x: x - scroll.x, y: y - scroll.y, width, height },
  };
}

export function projectSnapshotRect(
  input: FrameViewportRect,
  projection: SnapshotProjection,
): ViewportRect | null {
  if (
    input.owner.frameId !== projection.source.frameId ||
    cdpTargetKey(input.owner.target) !== cdpTargetKey(projection.source.target)
  ) {
    return null;
  }
  const { x, y, width: w, height: h } = input.rect;
  return projectRectToViewport({ x, y, w, h }, projection.geometry);
}

/** CSS viewport metadata; browser zoom is distinct from raster devicePixelRatio. */
export interface CssViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  cssToDip: number;
}

/** Page.captureScreenshot takes page-relative DIP, not viewport-relative CSS pixels. */
export function screenshotPageRect(
  rect: ViewportRect,
  viewport: CssViewport,
): { space: "page-dip"; rect: ViewportRect } | null {
  const { cssToDip, scrollX, scrollY } = viewport;
  if (
    ![rect.x, rect.y, rect.width, rect.height, cssToDip, scrollX, scrollY].every(Number.isFinite) ||
    cssToDip <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null;
  return {
    space: "page-dip",
    rect: {
      x: (rect.x + scrollX) * cssToDip,
      y: (rect.y + scrollY) * cssToDip,
      width: rect.width * cssToDip,
      height: rect.height * cssToDip,
    },
  };
}
