import type { RenderedRef } from "@browser-skill/vom";
import type { TargetDescriptorV3 } from "@/transport/types";
import type { CaptureTargetDescriptor } from "../describe-target";
import type { IndexedObservationNode, RegisteredObservation } from "./observation-capture";
import type { TargetGeometry, TargetMatchHint } from "./types";

const MATCH_TOLERANCE_PX = 2;

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= MATCH_TOLERANCE_PX;
}

function rectMatches(a: TargetGeometry["rect"], b: TargetGeometry["rect"]): boolean {
  return close(a.x, b.x) && close(a.y, b.y) && close(a.w, b.w) && close(a.h, b.h);
}

function candidateMatches(candidate: IndexedObservationNode, geometry: TargetGeometry): boolean {
  return candidate.node.rect !== null && rectMatches(geometry.rect, candidate.node.rect);
}

export function unmatchedTarget(fallback?: CaptureTargetDescriptor): TargetDescriptorV3 {
  return {
    ...(fallback?.role ? { role: fallback.role } : {}),
    ...(fallback?.name ? { name: fallback.name } : {}),
    unmatched: true,
  };
}

function normalized(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
}

function matchesSemantics(ref: RenderedRef, fallback?: CaptureTargetDescriptor): boolean {
  const role = normalized(fallback?.role);
  const name = normalized(fallback?.name);
  if (!role && !name) return false;
  if (role && normalized(ref.role) !== role) return false;
  if (name && normalized(ref.name) !== name) return false;
  return true;
}

function descriptor(ref: RenderedRef): TargetDescriptorV3 {
  return {
    ref: ref.ref,
    ...(ref.role ? { role: ref.role } : {}),
    ...(ref.name ? { name: ref.name } : {}),
    ...(ref.ctx ? { ctx: ref.ctx } : {}),
  };
}

export function matchObservationTarget(input: {
  observation: RegisteredObservation;
  hint?: TargetMatchHint;
  fallback?: CaptureTargetDescriptor;
}): TargetDescriptorV3 {
  const frameId = input.hint?.frameId ?? input.observation.rootFrameId;
  const geometry = input.hint?.geometry;
  if (geometry) {
    const matches = input.observation.index
      .candidates(frameId, geometry.tag)
      .filter((candidate) => candidate.ref && candidateMatches(candidate, geometry));
    if (matches.length === 1) return descriptor(matches[0]!.ref!);
    const semanticMatches = matches.filter(
      (candidate) => candidate.ref && matchesSemantics(candidate.ref, input.fallback),
    );
    if (semanticMatches.length === 1) return descriptor(semanticMatches[0]!.ref!);
    return unmatchedTarget(input.fallback);
  }

  const semanticMatches = input.observation.index
    .refs(frameId)
    .filter((ref) => matchesSemantics(ref, input.fallback));
  return semanticMatches.length === 1
    ? descriptor(semanticMatches[0]!)
    : unmatchedTarget(input.fallback);
}
