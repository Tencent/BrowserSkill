export interface VisualSurfacePriorityInput {
  label?: string;
  visibleRect: { x: number; y: number; w: number; h: number };
  frameId: string;
  backendNodeId: number;
}

function hasLabel(label: string | undefined): boolean {
  return (label?.trim().length ?? 0) > 0;
}

function area(surface: VisualSurfacePriorityInput): number {
  return Math.max(0, surface.visibleRect.w) * Math.max(0, surface.visibleRect.h);
}

/** Negative means `a` should be emitted before `b`. */
export function compareVisualSurfacePriority(
  a: VisualSurfacePriorityInput,
  b: VisualSurfacePriorityInput,
): number {
  return (
    Number(hasLabel(b.label)) - Number(hasLabel(a.label)) ||
    area(b) - area(a) ||
    a.frameId.localeCompare(b.frameId) ||
    a.visibleRect.y - b.visibleRect.y ||
    a.visibleRect.x - b.visibleRect.x ||
    a.backendNodeId - b.backendNodeId
  );
}
