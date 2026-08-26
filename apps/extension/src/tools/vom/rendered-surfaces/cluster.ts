import type { Rect } from "@browser-skill/vom";
import type { RenderedSurface, RenderedSurfaceGroup } from "./types";

const STACK_IOU_RATIO = 0.9;
const STACK_SIZE_RATIO = 0.9;

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
  if (a.parentBackendNodeId !== b.parentBackendNodeId) return false;
  const aArea = area(a.visibleRect);
  const bArea = area(b.visibleRect);
  const intersection = intersectionArea(a.visibleRect, b.visibleRect);
  const union = aArea + bArea - intersection;
  const widthRatio =
    Math.min(a.visibleRect.w, b.visibleRect.w) / Math.max(a.visibleRect.w, b.visibleRect.w);
  const heightRatio =
    Math.min(a.visibleRect.h, b.visibleRect.h) / Math.max(a.visibleRect.h, b.visibleRect.h);
  return (
    union > 0 &&
    intersection / union >= STACK_IOU_RATIO &&
    widthRatio >= STACK_SIZE_RATIO &&
    heightRatio >= STACK_SIZE_RATIO
  );
}

function toGroup(members: RenderedSurface[]): RenderedSurfaceGroup {
  const representative = [...members].sort(
    (a, b) => area(b.visibleRect) - area(a.visibleRect) || b.paintOrder - a.paintOrder,
  )[0];
  return {
    frameId: representative.frameId,
    members,
    representative,
    label: members.map((surface) => surface.label).find((label) => label !== undefined),
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
        a.representative.visibleRect.y - b.representative.visibleRect.y ||
        a.representative.visibleRect.x - b.representative.visibleRect.x,
    );
}
