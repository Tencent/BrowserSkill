import type { RenderedRef } from "@browser-skill/vom";
import type { CapturedNode } from "@/tools/vom/capture";
import type { CaptureGeometry, TargetDescriptor } from "@/transport/types";
import type { CaptureTargetDescriptor } from "./describe-target";
import { GEOM_MATCH_TOLERANCE_PX } from "./record-constants";

export interface MatchTargetInput {
  geometry: CaptureGeometry;
  captured: CapturedNode[];
  refs: RenderedRef[];
  fallback?: CaptureTargetDescriptor;
}

function withinTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= GEOM_MATCH_TOLERANCE_PX;
}

function rectsMatch(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    withinTolerance(a.x, b.x) &&
    withinTolerance(a.y, b.y) &&
    withinTolerance(a.w, b.w) &&
    withinTolerance(a.h, b.h)
  );
}

function nodeViewportRect(
  node: CapturedNode,
): { x: number; y: number; w: number; h: number } | null {
  return node.localRect ?? node.rect;
}

function matchingRects(
  geometry: CaptureGeometry,
  node: CapturedNode,
): {
  target: { x: number; y: number; w: number; h: number };
  node: { x: number; y: number; w: number; h: number } | null;
} {
  const topFrame = (geometry.ownerFrameBackendNodeId ?? null) === null;
  const viewportPosition = geometry.position === "fixed" || geometry.position === "sticky";
  if (!topFrame || viewportPosition || !node.documentRect) {
    return { target: geometry.rect, node: nodeViewportRect(node) };
  }
  return {
    target: {
      x: geometry.rect.x + geometry.scrollX,
      y: geometry.rect.y + geometry.scrollY,
      w: geometry.rect.w,
      h: geometry.rect.h,
    },
    node: node.documentRect,
  };
}

function tagMatches(geometryTag: string, nodeTag: string): boolean {
  return geometryTag.toLowerCase() === nodeTag.toLowerCase();
}

/** Best description available when the element cannot be located in the VOM. */
export function fallbackDescriptor(fallback?: CaptureTargetDescriptor): TargetDescriptor {
  if (!fallback) {
    return { unmatched: true };
  }
  return {
    ...(fallback.role ? { role: fallback.role } : {}),
    ...(fallback.name ? { name: fallback.name } : {}),
    unmatched: true,
  };
}

/** Locate the interacted element in the last settled observation by geometry. */
export function matchTarget(input: MatchTargetInput): TargetDescriptor {
  const ownerFrame = input.geometry.ownerFrameBackendNodeId ?? null;

  const candidates = input.captured.filter((node) => {
    if (ownerFrame !== (node.ownerFrameBackendNodeId ?? null)) return false;
    if (!tagMatches(input.geometry.tag, node.tag)) return false;
    const rects = matchingRects(input.geometry, node);
    if (!rects.node) return false;
    return rectsMatch(rects.target, rects.node);
  });

  if (candidates.length !== 1) {
    return fallbackDescriptor(input.fallback);
  }

  const backendNodeId = candidates[0]!.backendNodeId;
  const refEntry = input.refs.find((r) => r.backendNodeId === backendNodeId);
  if (!refEntry) {
    return fallbackDescriptor(input.fallback);
  }

  return {
    ref: refEntry.ref,
    ...(refEntry.role ? { role: refEntry.role } : {}),
    ...(refEntry.name ? { name: refEntry.name } : {}),
    ...(refEntry.ctx ? { ctx: refEntry.ctx } : {}),
  };
}
