import type { BlockingLayer, Rect, Viewport, VomNode } from "./types";

/** Default fraction of the viewport an overlay must cover to block. */
export const BLOCK_COVERAGE_THRESHOLD = 0.6;
/** At/above this coverage with no inputs we call it an opaque mask. */
export const MASK_COVERAGE_THRESHOLD = 0.9;

const POSITIONED = new Set(["fixed", "absolute", "sticky"]);
const FORM_TAGS = new Set(["input", "textarea", "select"]);

export function coverage(rect: Rect | null, vp: Viewport): number {
  if (!rect || vp.width <= 0 || vp.height <= 0) return 0;
  const ix = Math.max(0, Math.min(rect.x + rect.w, vp.width) - Math.max(rect.x, 0));
  const iy = Math.max(0, Math.min(rect.y + rect.h, vp.height) - Math.max(rect.y, 0));
  const overlap = ix * iy;
  if (overlap <= 0) return 0;
  return Math.min(1, overlap / (vp.width * vp.height));
}

function isBlockingCandidate(node: VomNode): boolean {
  if (node.pointerEvents === "none") return false;
  return POSITIONED.has(node.position);
}

function hasModalFeature(node: VomNode): boolean {
  return (
    node.modal === true ||
    node.tag === "dialog" ||
    node.role === "dialog" ||
    node.role === "alertdialog"
  );
}

function classifyLayer(
  nodes: VomNode[],
  members: Set<number>,
  blockerCoverage: number,
): BlockingLayer["kind"] {
  for (const node of nodes) {
    if (!members.has(node.id)) continue;
    if (hasModalFeature(node)) return "modal";
    if (FORM_TAGS.has(node.tag)) return "modal";
    if (node.tag === "iframe") return "modal";
  }
  return blockerCoverage >= MASK_COVERAGE_THRESHOLD ? "mask" : "modal";
}

export function detectBlockingLayer(nodes: VomNode[], vp: Viewport): BlockingLayer | null {
  let blocker: { node: VomNode; coverage: number } | null = null;

  for (const node of nodes) {
    if (!isBlockingCandidate(node)) continue;
    const cov = coverage(node.rect, vp);
    const qualifies = cov >= BLOCK_COVERAGE_THRESHOLD || (hasModalFeature(node) && cov >= 0.15);
    if (!qualifies) continue;
    if (
      blocker === null ||
      cov > blocker.coverage ||
      (cov === blocker.coverage && node.paintOrder > blocker.node.paintOrder)
    ) {
      blocker = { node, coverage: cov };
    }
  }

  if (!blocker) return null;

  const threshold = blocker.node.paintOrder;
  const members = new Set<number>();
  for (const node of nodes) {
    if (node.paintOrder >= threshold) members.add(node.id);
  }

  return {
    rootId: blocker.node.id,
    kind: classifyLayer(nodes, members, blocker.coverage),
    coverage: blocker.coverage,
    members,
  };
}
