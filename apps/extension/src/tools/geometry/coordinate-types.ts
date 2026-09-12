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

/** A failed owner read is different from a successfully projected, clipped-out rect. */
export interface UnavailableFrameProjection {
  status: "unavailable";
  source: CoordinateOwner;
  ownerBackendNodeId: number;
}

export interface UnavailableSnapshotCoordinates {
  status: "unavailable";
  source: CoordinateOwner;
  reason: "snapshot-coordinates-unavailable";
}

export type SnapshotProjectionResult =
  | { status: "available"; projection: SnapshotProjection }
  | UnavailableFrameProjection;

/** Descendants inherit the failed boundary without attempting another owner read. */
export type FrameProjectionIssue =
  | UnavailableFrameProjection
  | UnavailableSnapshotCoordinates
  | {
      status: "blocked";
      source: CoordinateOwner;
      cause: UnavailableFrameProjection | UnavailableSnapshotCoordinates;
    };

export type FrameProjectionState = SnapshotProjectionResult | FrameProjectionIssue;

export interface SnapshotCoordinates {
  layoutUnitsPerCssPixel: number;
  scrollCss: { x: number; y: number };
}

/** Snapshot scroll offsets share the raw layout units of its bounds. Only a
 * target's root document may fall back to that target's CSS layout viewport. */
export function snapshotCoordinates(
  document: { scrollOffsetX?: number; scrollOffsetY?: number },
  layoutUnitsPerCssPixel: number | null,
  rootScrollCss?: { x?: number; y?: number },
): SnapshotCoordinates | null {
  if (
    layoutUnitsPerCssPixel === null ||
    !Number.isFinite(layoutUnitsPerCssPixel) ||
    layoutUnitsPerCssPixel <= 0
  )
    return null;
  const x =
    document.scrollOffsetX === undefined
      ? rootScrollCss?.x
      : document.scrollOffsetX / layoutUnitsPerCssPixel;
  const y =
    document.scrollOffsetY === undefined
      ? rootScrollCss?.y
      : document.scrollOffsetY / layoutUnitsPerCssPixel;
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { layoutUnitsPerCssPixel, scrollCss: { x, y } };
}

/** Convert raw document-relative Blink layout units exactly once, before any
 * CSS viewport clipping or frame projection. This scale is not screenshot zoom. */
export function snapshotViewportRect(
  bounds: number[],
  owner: CoordinateOwner,
  coordinates: SnapshotCoordinates | null,
): FrameViewportRect | null {
  if (!coordinates || bounds.length < 4 || !bounds.slice(0, 4).every(Number.isFinite)) return null;
  const { layoutUnitsPerCssPixel: scale, scrollCss: scroll } = coordinates;
  const [x, y, width, height] = bounds;
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(scroll.x) ||
    !Number.isFinite(scroll.y)
  ) {
    return null;
  }
  return {
    space: "frame-viewport-css",
    owner,
    rect: {
      x: x / scale - scroll.x,
      y: y / scale - scroll.y,
      width: width / scale,
      height: height / scale,
    },
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
