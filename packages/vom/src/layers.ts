import type { BlockingLayer, Rect, Viewport, VomNode } from "./types";

/** CSS pixels of layout rounding allowed at each viewport edge. */
const VIEWPORT_EDGE_TOLERANCE = 1;

const POSITIONED = new Set(["fixed", "absolute", "sticky"]);
const FORM_TAGS = new Set(["input", "textarea", "select"]);
const ROOT_DOCUMENT_TAGS = new Set(["html", "body"]);
const ROOT_DOCUMENT_ROLES = new Set(["rootwebarea", "webarea"]);

function normalizedRole(node: VomNode): string {
  return node.role?.toLowerCase() ?? "";
}

function normalizedTag(node: VomNode): string {
  return node.tag.toLowerCase();
}

export function isRootDocumentShell(node: VomNode): boolean {
  return (
    ROOT_DOCUMENT_TAGS.has(normalizedTag(node)) || ROOT_DOCUMENT_ROLES.has(normalizedRole(node))
  );
}

/** Root documents and `<main>` landmarks form the base page, never a full-page overlay. */
export function isNonBlockingPageStructure(node: VomNode): boolean {
  return (
    isRootDocumentShell(node) || normalizedTag(node) === "main" || normalizedRole(node) === "main"
  );
}

/** Ancestors (DOM or semantic) in the same frame that wrap a `<main>` landmark act as app layout shells. */
export function collectMainShellAncestorIds(nodes: VomNode[], rootFrameId?: string): Set<number> {
  const mainNodes = nodes.filter(
    (node) =>
      (rootFrameId === undefined || node.frameId === rootFrameId) &&
      (normalizedTag(node) === "main" || normalizedRole(node) === "main"),
  );
  const shellIds = new Set<number>();
  if (mainNodes.length === 0) return shellIds;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of mainNodes) {
    for (const ancestorId of node.domAncestorIds ?? []) {
      const anc = byId.get(ancestorId);
      if (!anc || anc.frameId !== node.frameId) continue;
      shellIds.add(ancestorId);
    }
    let currentId = node.parentId;
    let guard = 0;
    while (currentId !== null && guard <= nodes.length) {
      const anc = byId.get(currentId);
      if (!anc || anc.frameId !== node.frameId) break;
      if (shellIds.has(currentId)) break;
      shellIds.add(currentId);
      currentId = anc.parentId;
      guard += 1;
    }
  }
  return shellIds;
}

/** True when a non-modal node lives behind normal flow in its stacking context. */
export function isBehindNormalFlow(
  node: VomNode,
  nodesById: ReadonlyMap<number, VomNode>,
): boolean {
  if (node.modal === true) return false;
  let cur: VomNode | undefined = node;
  let guard = 0;
  while (cur && cur.frameId === node.frameId && guard <= nodesById.size) {
    if (cur.paintOrder < 0) return true;
    if (cur.position !== "static" && cur.zIndex !== undefined && cur.zIndex < 0) return true;
    const parentId: number | null = cur.parentId;
    cur = parentId === null ? undefined : nodesById.get(parentId);
    guard += 1;
  }
  for (const ancestorId of node.domAncestorIds ?? []) {
    const anc = nodesById.get(ancestorId);
    if (!anc || anc.frameId !== node.frameId) continue;
    if (anc.paintOrder < 0) return true;
    if (anc.position !== "static" && anc.zIndex !== undefined && anc.zIndex < 0) return true;
  }
  return false;
}

/**
 * True when a non-modal node paints behind the document's root normal flow.
 * A `z-index: -1` backdrop nested inside a `z-index: 1000` modal wrapper paints
 * at the wrapper's stacking level (above the base page), not behind root flow.
 */
export function isBehindPageNormalFlow(
  node: VomNode,
  nodesById: ReadonlyMap<number, VomNode>,
): boolean {
  if (node.modal === true) return false;
  if (node.rootZIndex !== undefined) return node.rootZIndex < 0;

  let outermostZ: number | undefined =
    node.position !== "static" && node.zIndex !== undefined ? node.zIndex : undefined;
  let negativePaintOrder = node.paintOrder < 0;

  // domAncestorIds is ordered nearest-to-furthest; later entries are closer to root.
  for (const ancestorId of node.domAncestorIds ?? []) {
    const anc = nodesById.get(ancestorId);
    if (!anc || anc.frameId !== node.frameId) continue;
    if (anc.rootZIndex !== undefined) return anc.rootZIndex < 0;
    if (anc.position !== "static" && anc.zIndex !== undefined) outermostZ = anc.zIndex;
    if (anc.paintOrder < 0) negativePaintOrder = true;
  }
  if (!node.domAncestorIds?.length) {
    let cur: VomNode | undefined =
      node.parentId === null ? undefined : nodesById.get(node.parentId);
    let guard = 0;
    while (cur && cur.frameId === node.frameId && guard <= nodesById.size) {
      if (cur.rootZIndex !== undefined) return cur.rootZIndex < 0;
      if (cur.position !== "static" && cur.zIndex !== undefined) outermostZ = cur.zIndex;
      if (cur.paintOrder < 0) negativePaintOrder = true;
      cur = cur.parentId === null ? undefined : nodesById.get(cur.parentId);
      guard += 1;
    }
  }
  if (outermostZ !== undefined) return outermostZ < 0;
  return negativePaintOrder;
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
  if (isNonBlockingPageStructure(node)) return false;
  return POSITIONED.has(node.position);
}

/** Naming only: dialog roles/tags do not determine whether a layer blocks. */
export function looksLikeDialog(node: VomNode): boolean {
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
  const mainShellAncestors = collectMainShellAncestorIds(nodes, rootFrameId);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  let blocker: { node: VomNode; coverage: number } | null = null;

  for (const node of nodes) {
    // A document's paint order is local to its iframe stacking context. Only
    // the root document can establish a page-level blocking layer; child
    // documents are constrained by their iframe owner in the parent document.
    if (rootFrameId !== undefined && node.frameId !== rootFrameId) continue;
    if (!isBlockingCandidate(node)) continue;
    if (!looksLikeDialog(node)) {
      if (mainShellAncestors.has(node.id)) continue;
      // Decorative negative-z-index backgrounds paint behind root normal flow even
      // when Chromium's DOMSnapshot assigns their PaintLayer a positive paintOrder.
      if (isBehindPageNormalFlow(node, nodesById)) continue;
    }
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
