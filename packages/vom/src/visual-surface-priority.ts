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

function siftWorstUp<T extends VisualSurfacePriorityInput>(heap: T[], start: number): void {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareVisualSurfacePriority(heap[index], heap[parent]) <= 0) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function siftWorstDown<T extends VisualSurfacePriorityInput>(heap: T[], start: number): void {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worst = left;
    if (right < heap.length && compareVisualSurfacePriority(heap[right], heap[left]) > 0) {
      worst = right;
    }
    if (compareVisualSurfacePriority(heap[worst], heap[index]) <= 0) return;
    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

/** Selects the best `limit` surfaces and returns them in priority order. */
export function selectHighestPriorityVisualSurfaces<T extends VisualSurfacePriorityInput>(
  surfaces: Iterable<T>,
  limit: number,
): T[] {
  if (!Number.isFinite(limit)) return [...surfaces].sort(compareVisualSurfacePriority);
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0) return [];
  if (Array.isArray(surfaces) && surfaces.length <= normalizedLimit) {
    return [...surfaces].sort(compareVisualSurfacePriority);
  }

  const heap: T[] = [];
  for (const surface of surfaces) {
    if (heap.length < normalizedLimit) {
      heap.push(surface);
      siftWorstUp(heap, heap.length - 1);
    } else if (compareVisualSurfacePriority(surface, heap[0]) < 0) {
      heap[0] = surface;
      siftWorstDown(heap, 0);
    }
  }
  return heap.sort(compareVisualSurfacePriority);
}
