import type { Rect } from "@browser-skill/vom";
import type { RenderedSurface, RenderedSurfaceGroup } from "./types";

const STACK_OVERLAP_RATIO = 0.9;

function area(rect: Rect): number {
  return Math.max(0, rect.w) * Math.max(0, rect.h);
}

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return width * height;
}

function sameVisualStack(a: RenderedSurface, b: RenderedSurface): boolean {
  if (a.frameId !== b.frameId) return false;
  const smallerArea = Math.min(area(a.visibleRect), area(b.visibleRect));
  return (
    smallerArea > 0 &&
    intersectionArea(a.visibleRect, b.visibleRect) / smallerArea >= STACK_OVERLAP_RATIO
  );
}

function unionRect(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x, y, w: right - x, h: bottom - y };
}

function toGroup(members: RenderedSurface[]): RenderedSurfaceGroup {
  const representative = [...members].sort(
    (a, b) => area(b.visibleRect) - area(a.visibleRect) || b.paintOrder - a.paintOrder,
  )[0];
  return {
    frameId: representative.frameId,
    members,
    representative,
    rect: unionRect(members.map((surface) => surface.rect)),
    visibleRect: unionRect(members.map((surface) => surface.visibleRect)),
    label: members.map((surface) => surface.label).find((label) => label !== undefined),
    existenceConfidence: members.some((surface) => surface.existenceConfidence === "high")
      ? "high"
      : "low",
  };
}

export function clusterRenderedSurfaces(surfaces: RenderedSurface[]): RenderedSurfaceGroup[] {
  const groups: RenderedSurface[][] = [];
  for (const surface of surfaces) {
    const matching = groups.find((group) =>
      group.some((member) => sameVisualStack(member, surface)),
    );
    if (matching) matching.push(surface);
    else groups.push([surface]);
  }
  return groups
    .map(toGroup)
    .sort(
      (a, b) =>
        a.frameId.localeCompare(b.frameId) ||
        a.visibleRect.y - b.visibleRect.y ||
        a.visibleRect.x - b.visibleRect.x,
    );
}
