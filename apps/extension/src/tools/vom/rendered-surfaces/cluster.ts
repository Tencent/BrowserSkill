import { compareVisualSurfacePriority, type Rect } from "@browser-skill/vom";
import type { ClusteredRenderedSurfaces, RenderedSurface, RenderedSurfaceGroup } from "./types";

const STACK_IOU_RATIO = 0.9;
const STACK_SIZE_RATIO = 0.9;
const SIZE_BAND_BASE = 1 / STACK_SIZE_RATIO;
const POSITION_CELL_RATIO = 0.1;
const MAX_CLUSTER_COMPARISONS = 1_000_000;
const MAX_CLUSTER_SURFACES = 50_000;

export interface ClusterRenderedSurfaceOptions {
  maxComparisons?: number;
  maxSurfaces?: number;
}

interface IndexedGroup extends RenderedSurfaceGroup {
  creationIndex: number;
  indexKey: string;
}

function area(rect: Rect): number {
  return Math.max(0, rect.w) * Math.max(0, rect.h);
}

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return width * height;
}

function stackScore(a: RenderedSurface, b: RenderedSurface): number | null {
  const aArea = area(a.visibleRect);
  const bArea = area(b.visibleRect);
  const intersection = intersectionArea(a.visibleRect, b.visibleRect);
  const union = aArea + bArea - intersection;
  const widthRatio =
    Math.min(a.visibleRect.w, b.visibleRect.w) / Math.max(a.visibleRect.w, b.visibleRect.w);
  const heightRatio =
    Math.min(a.visibleRect.h, b.visibleRect.h) / Math.max(a.visibleRect.h, b.visibleRect.h);
  const iou = union > 0 ? intersection / union : 0;
  return iou >= STACK_IOU_RATIO && widthRatio >= STACK_SIZE_RATIO && heightRatio >= STACK_SIZE_RATIO
    ? iou
    : null;
}

function sizeBand(value: number): number {
  return Math.floor(Math.log(Math.max(Number.EPSILON, value)) / Math.log(SIZE_BAND_BASE));
}

function bandSize(band: number): number {
  return SIZE_BAND_BASE ** band;
}

function spatialKey(rect: Rect): string {
  const widthBand = sizeBand(rect.w);
  const heightBand = sizeBand(rect.h);
  const cellWidth = bandSize(widthBand) * POSITION_CELL_RATIO;
  const cellHeight = bandSize(heightBand) * POSITION_CELL_RATIO;
  const centerX = rect.x + rect.w / 2;
  const centerY = rect.y + rect.h / 2;
  return `${widthBand}:${heightBand}:${Math.floor(centerX / cellWidth)}:${Math.floor(centerY / cellHeight)}`;
}

function candidateKeys(rect: Rect): string[] {
  const keys: string[] = [];
  const centerX = rect.x + rect.w / 2;
  const centerY = rect.y + rect.h / 2;
  const widthBand = sizeBand(rect.w);
  const heightBand = sizeBand(rect.h);
  // A >=0.9 size ratio crosses at most one logarithmic band. IoU >=0.9
  // likewise keeps centers within one 10%-of-size position cell.
  for (let dw = -1; dw <= 1; dw += 1) {
    for (let dh = -1; dh <= 1; dh += 1) {
      const candidateWidthBand = widthBand + dw;
      const candidateHeightBand = heightBand + dh;
      const cellWidth = bandSize(candidateWidthBand) * POSITION_CELL_RATIO;
      const cellHeight = bandSize(candidateHeightBand) * POSITION_CELL_RATIO;
      const cellX = Math.floor(centerX / cellWidth);
      const cellY = Math.floor(centerY / cellHeight);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          keys.push(`${candidateWidthBand}:${candidateHeightBand}:${cellX + dx}:${cellY + dy}`);
        }
      }
    }
  }
  return keys;
}

function preferredRepresentative(a: RenderedSurface, b: RenderedSurface): RenderedSurface {
  const aArea = area(a.visibleRect);
  const bArea = area(b.visibleRect);
  return bArea > aArea || (bArea === aArea && b.paintOrder > a.paintOrder) ? b : a;
}

function partitionKey(surface: RenderedSurface): string {
  return `${surface.frameId}\u0000${surface.parentBackendNodeId ?? "root"}`;
}

function siftWorstUp(heap: RenderedSurface[], start: number): void {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareVisualSurfacePriority(heap[index], heap[parent]) <= 0) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function siftWorstDown(heap: RenderedSurface[], start: number): void {
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

function highestPrioritySurfaces(
  surfaces: readonly RenderedSurface[],
  limit: number,
): RenderedSurface[] {
  if (limit <= 0) return [];
  if (surfaces.length <= limit) return [...surfaces].sort(compareVisualSurfacePriority);
  const heap: RenderedSurface[] = [];
  for (const surface of surfaces) {
    if (heap.length < limit) {
      heap.push(surface);
      siftWorstUp(heap, heap.length - 1);
    } else if (compareVisualSurfacePriority(surface, heap[0]) < 0) {
      heap[0] = surface;
      siftWorstDown(heap, 0);
    }
  }
  return heap.sort(compareVisualSurfacePriority);
}

function normalizedLimit(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  return Number.isFinite(resolved) ? Math.max(0, Math.floor(resolved)) : fallback;
}

export function clusterRenderedSurfaces(
  surfaces: RenderedSurface[],
  options: ClusterRenderedSurfaceOptions = {},
): ClusteredRenderedSurfaces {
  const maxComparisons = normalizedLimit(options.maxComparisons, MAX_CLUSTER_COMPARISONS);
  const maxSurfaces = normalizedLimit(options.maxSurfaces, MAX_CLUSTER_SURFACES);
  const prioritized = highestPrioritySurfaces(surfaces, maxSurfaces);
  const partitions = new Map<string, Map<string, Set<IndexedGroup>>>();
  const groups: IndexedGroup[] = [];
  let comparisons = 0;
  let processed = 0;
  let truncated = prioritized.length < surfaces.length;
  let comparisonLimitReached = false;

  for (const surface of prioritized) {
    if (comparisons >= maxComparisons) {
      truncated = true;
      break;
    }
    const key = partitionKey(surface);
    let index = partitions.get(key);
    if (!index) {
      index = new Map();
      partitions.set(key, index);
    }
    const candidates = new Set<IndexedGroup>();
    for (const candidateKey of candidateKeys(surface.visibleRect)) {
      for (const candidate of index.get(candidateKey) ?? []) candidates.add(candidate);
    }

    let best: { group: IndexedGroup; score: number; areaDelta: number } | null = null;
    for (const group of candidates) {
      if (comparisons >= maxComparisons) {
        truncated = true;
        comparisonLimitReached = true;
        break;
      }
      comparisons += 1;
      const score = stackScore(group.representative, surface);
      if (score === null) continue;
      const areaDelta = Math.abs(
        area(group.representative.visibleRect) - area(surface.visibleRect),
      );
      if (
        !best ||
        score > best.score ||
        (score === best.score && areaDelta < best.areaDelta) ||
        (score === best.score &&
          areaDelta === best.areaDelta &&
          group.creationIndex < best.group.creationIndex)
      ) {
        best = { group, score, areaDelta };
      }
    }
    if (comparisonLimitReached) break;

    if (best) {
      const group = best.group;
      const representative = preferredRepresentative(group.representative, surface);
      group.memberCount += 1;
      group.label ??= surface.label;
      if (representative !== group.representative) {
        index.get(group.indexKey)?.delete(group);
        group.representative = representative;
        group.indexKey = spatialKey(representative.visibleRect);
        const indexed = index.get(group.indexKey) ?? new Set<IndexedGroup>();
        indexed.add(group);
        index.set(group.indexKey, indexed);
      }
      processed += 1;
      continue;
    }

    const indexKey = spatialKey(surface.visibleRect);
    const group: IndexedGroup = {
      frameId: surface.frameId,
      parentBackendNodeId: surface.parentBackendNodeId,
      representative: surface,
      ...(surface.label ? { label: surface.label } : {}),
      memberCount: 1,
      creationIndex: groups.length,
      indexKey,
    };
    groups.push(group);
    const indexed = index.get(indexKey) ?? new Set<IndexedGroup>();
    indexed.add(group);
    index.set(indexKey, indexed);
    processed += 1;
  }

  return {
    groups: groups
      .map(({ creationIndex: _creationIndex, indexKey: _indexKey, ...group }) => group)
      .sort(
        (a, b) =>
          a.frameId.localeCompare(b.frameId) ||
          a.representative.visibleRect.y - b.representative.visibleRect.y ||
          a.representative.visibleRect.x - b.representative.visibleRect.x,
      ),
    truncated,
    ...(truncated ? { omittedCount: surfaces.length - processed } : {}),
  };
}
