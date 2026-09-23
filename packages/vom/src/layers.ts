import type { BlockingLayer, Rect, Viewport, VomNode } from "./types";

/** CSS pixels of layout rounding allowed at each viewport edge. */
const VIEWPORT_EDGE_TOLERANCE = 1;

const POSITIONED = new Set(["fixed", "absolute", "sticky"]);
const FORM_TAGS = new Set(["input", "textarea", "select"]);

function normalizedRole(node: VomNode): string {
  return node.role?.toLowerCase() ?? "";
}

function normalizedTag(node: VomNode): string {
  return node.tag.toLowerCase();
}

export function coverage(rect: Rect | null, vp: Viewport): number {
  if (!rect || vp.width <= 0 || vp.height <= 0) return 0;
  const ix = Math.max(0, Math.min(rect.x + rect.w, vp.width) - Math.max(rect.x, 0));
  const iy = Math.max(0, Math.min(rect.y + rect.h, vp.height) - Math.max(rect.y, 0));
  const overlap = ix * iy;
  if (overlap <= 0) return 0;
  return Math.min(1, overlap / (vp.width * vp.height));
}

export function spansViewport(rect: Rect | null, vp: Viewport): boolean {
  if (!rect || vp.width <= 0 || vp.height <= 0) return false;
  const t = VIEWPORT_EDGE_TOLERANCE;
  return (
    rect.x <= t &&
    rect.y <= t &&
    rect.x + rect.w >= vp.width - t &&
    rect.y + rect.h >= vp.height - t
  );
}

function isBlockingCandidate(node: VomNode): boolean {
  if (node.pointerEvents === "none") return false;
  return POSITIONED.has(node.position);
}

/** Naming only: dialog roles/tags do not determine whether a layer blocks. */
function looksLikeDialog(node: VomNode): boolean {
  const role = normalizedRole(node);
  const tag = normalizedTag(node);
  return node.modal === true || tag === "dialog" || role === "dialog" || role === "alertdialog";
}

function classifyLayer(nodes: VomNode[], members: Set<number>): BlockingLayer["kind"] {
  for (const node of nodes) {
    if (!members.has(node.id)) continue;
    if (looksLikeDialog(node)) return "modal";
    const tag = normalizedTag(node);
    if (FORM_TAGS.has(tag) || tag === "iframe") return "modal";
  }
  return "mask";
}

export function detectBlockingLayer(
  nodes: VomNode[],
  vp: Viewport,
  rootFrameId?: string,
): BlockingLayer | null {
  let blocker: { node: VomNode; coverage: number } | null = null;

  for (const node of nodes) {
    // A document's paint order is local to its iframe stacking context. Only
    // the root document can establish a page-level blocking layer; child
    // documents are constrained by their iframe owner in the parent document.
    if (rootFrameId !== undefined && node.frameId !== rootFrameId) continue;
    if (!isBlockingCandidate(node)) continue;
    const cov = coverage(node.rect, vp);
    // A large sidebar can leave usable page content beside it. Only actual
    // modality or a cover spanning the whole viewport can fold the base page.
    const qualifies = spansViewport(node.rect, vp) || (node.modal === true && cov > 0);
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
    if (node.frameId === blocker.node.frameId && node.paintOrder >= threshold) {
      members.add(node.id);
    }
  }

  return {
    rootId: blocker.node.id,
    kind: classifyLayer(nodes, members),
    coverage: blocker.coverage,
    members,
  };
}
