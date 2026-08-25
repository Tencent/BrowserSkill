import type { Rect, Viewport } from "@browser-skill/vom";
import type { CapturedNode } from "../capture";
import type { CapturedFrameDocument } from "../frame-capture";
import type { SemanticAxNode } from "../semantic-graph";
import type { RenderedSurface } from "./types";

const MIN_PROMINENT_EDGE = 32;
const MIN_PROMINENT_AREA = 4_096;
const NON_CONTENT_ROLES = new Set(["", "generic", "none", "presentation"]);

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

function hiddenByDomPolicy(node: CapturedNode, nodesByBackend: Map<number, CapturedNode>): boolean {
  let current: CapturedNode | undefined = node;
  let guard = 0;
  while (current && guard <= nodesByBackend.size) {
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

function hasVerifiedNativeMirror(canvas: CapturedNode, axNodes: SemanticAxNode[]): boolean {
  const owner = axNodes.find(
    (node) => node.backendDOMNodeId === canvas.backendNodeId && node.ignored !== true,
  );
  if (!owner?.childIds?.length) return false;
  const byId = new Map(axNodes.map((node) => [node.nodeId, node]));
  const queue = [...owner.childIds];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node || node.ignored === true) continue;
    const role = String(node.role?.value ?? "").toLowerCase();
    if (!NON_CONTENT_ROLES.has(role)) return true;
    queue.push(...(node.childIds ?? []));
  }
  return false;
}

function isProminent(node: CapturedNode, visibleRect: Rect, label: string | undefined): boolean {
  const tabindex = Number.parseInt(node.attrs.tabindex ?? "", 10);
  const interactionSignal =
    node.cursor === "pointer" || (Number.isFinite(tabindex) && tabindex >= 0);
  return (
    label !== undefined ||
    interactionSignal ||
    (visibleRect.w >= MIN_PROMINENT_EDGE &&
      visibleRect.h >= MIN_PROMINENT_EDGE &&
      visibleRect.w * visibleRect.h >= MIN_PROMINENT_AREA)
  );
}

export function discoverRenderedSurfaces(
  documents: CapturedFrameDocument<SemanticAxNode>[],
  viewport: Viewport,
): RenderedSurface[] {
  const surfaces: RenderedSurface[] = [];
  for (const document of documents) {
    const nodesByBackend = new Map(document.domNodes.map((node) => [node.backendNodeId, node]));
    for (const node of document.domNodes) {
      if (node.tag.toLowerCase() !== "canvas" || node.rendered !== true || !node.rect) continue;
      if (hiddenByDomPolicy(node, nodesByBackend)) continue;
      if (hasVerifiedNativeMirror(node, document.axNodes)) continue;
      const visibleRect = intersectViewport(node.rect, viewport);
      if (!visibleRect) continue;
      const label = clean(node.attrs["aria-label"] ?? node.attrs.title);
      surfaces.push({
        renderingKind: "canvas",
        frameId: document.frameId,
        backendNodeId: node.backendNodeId,
        parentBackendNodeId: node.parentBackendNodeId,
        rect: node.rect,
        ...(node.localRect ? { localRect: node.localRect } : {}),
        visibleRect,
        paintOrder: node.paintOrder,
        ...(label ? { label } : {}),
        existenceConfidence: isProminent(node, visibleRect, label) ? "high" : "low",
      });
    }
  }
  return surfaces;
}
