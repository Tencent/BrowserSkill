import type { Rect } from "@browser-skill/vom";
import type { Point, Region, ViewportRect } from "./geometry";

const RECT_EPSILON = 0.01;

export function surfaceVisibleRect(
  liveRect: ViewportRect,
  observedRect: Rect | undefined,
): Rect | null {
  const observed = observedRect ?? {
    x: liveRect.x,
    y: liveRect.y,
    w: liveRect.width,
    h: liveRect.height,
  };
  const x = Math.max(liveRect.x, observed.x);
  const y = Math.max(liveRect.y, observed.y);
  const right = Math.min(liveRect.x + liveRect.width, observed.x + observed.w);
  const bottom = Math.min(liveRect.y + liveRect.height, observed.y + observed.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

export function sameRect(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= RECT_EPSILON &&
    Math.abs(a.y - b.y) <= RECT_EPSILON &&
    Math.abs(a.w - b.w) <= RECT_EPSILON &&
    Math.abs(a.h - b.h) <= RECT_EPSILON
  );
}

export function mapImagePointToViewport(
  rect: Rect,
  imageWidth: number,
  imageHeight: number,
  imageX: number,
  imageY: number,
): Point | null {
  if (
    !Number.isFinite(imageX) ||
    !Number.isFinite(imageY) ||
    !Number.isSafeInteger(imageWidth) ||
    !Number.isSafeInteger(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    imageX < 0 ||
    imageY < 0 ||
    imageX >= imageWidth ||
    imageY >= imageHeight ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.w) ||
    !Number.isFinite(rect.h) ||
    rect.w <= 0 ||
    rect.h <= 0
  ) {
    return null;
  }
  return {
    x: rect.x + (imageX / imageWidth) * rect.w,
    y: rect.y + (imageY / imageHeight) * rect.h,
  };
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
    const withinX = point.x >= Math.min(a.x, b.x) - 1e-9 && point.x <= Math.max(a.x, b.x) + 1e-9;
    const withinY = point.y >= Math.min(a.y, b.y) - 1e-9 && point.y <= Math.max(a.y, b.y) + 1e-9;
    if (Math.abs(cross) <= 1e-9 && withinX && withinY) return true;
  }
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInRegion(point: Point, region: Region): boolean {
  return region.some((polygon) => polygon.length >= 3 && pointInPolygon(point, polygon));
}
