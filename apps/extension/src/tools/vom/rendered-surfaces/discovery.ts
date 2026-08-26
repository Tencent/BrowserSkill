import type { Rect, Viewport } from "@browser-skill/vom";
import type { CapturedNode } from "../capture";
import type { CapturedFrameDocument } from "../frame-capture";
import type { SemanticAxNode } from "../semantic-graph";
import type { RenderedSurface } from "./types";

function clean(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function intersectViewport(rect: Rect, viewport: Viewport): Rect | null {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.w);
  const bottom = Math.min(viewport.height, rect.y + rect.h);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

function excludedByDomPolicy(
  node: CapturedNode,
  nodesByBackend: Map<number, CapturedNode>,
  excludedBackendNodeIds: ReadonlySet<number>,
): boolean {
  let current: CapturedNode | undefined = node;
  let guard = 0;
  while (current && guard <= nodesByBackend.size) {
    if (excludedBackendNodeIds.has(current.backendNodeId)) return true;
    const attrs = current.attrs;
    if (
      Object.prototype.hasOwnProperty.call(attrs, "hidden") ||
      Object.prototype.hasOwnProperty.call(attrs, "inert") ||
      (attrs["aria-hidden"] ?? "").toLowerCase() === "true"
    ) {
      return true;
    }
    current =
      current.parentBackendNodeId === null
        ? undefined
        : nodesByBackend.get(current.parentBackendNodeId);
    guard += 1;
  }
  return false;
}

export function discoverRenderedSurfaces(
  documents: CapturedFrameDocument<SemanticAxNode>[],
  viewport: Viewport,
  excludedBackendNodeIds: ReadonlySet<number> = new Set(),
): RenderedSurface[] {
  const surfaces: RenderedSurface[] = [];
  for (const document of documents) {
    const nodesByBackend = new Map(document.domNodes.map((node) => [node.backendNodeId, node]));
    for (const node of document.domNodes) {
      if (node.tag.toLowerCase() !== "canvas" || node.rendered !== true || !node.rect) continue;
      if (excludedByDomPolicy(node, nodesByBackend, excludedBackendNodeIds)) continue;
      const visibleRect = intersectViewport(node.rect, viewport);
      if (!visibleRect) continue;
      const label = clean(node.attrs["aria-label"] ?? node.attrs.title);
      surfaces.push({
        renderingKind: "canvas",
        frameId: document.frameId,
        backendNodeId: node.backendNodeId,
        parentBackendNodeId: node.parentBackendNodeId,
        visibleRect,
        paintOrder: node.paintOrder,
        ...(label ? { label } : {}),
      });
    }
  }
  return surfaces;
}
