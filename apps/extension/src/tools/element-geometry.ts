// Shared CDP helpers for scrolling nodes into view and computing
// viewport-space bounding rectangles. Used by interaction tools (click
// centre) and observation tools (element screenshot clip).

import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import { type CdpRunner, isRpcError } from "./shared";

const ELEMENT_NOT_VISIBLE_MESSAGE =
  "element not visible (no content quads, box model, or visible descendant bounds)";

function elementNotVisibleError(): RpcError {
  return rpcError("permission_denied", "element_not_visible", ELEMENT_NOT_VISIBLE_MESSAGE);
}

/** Viewport-space axis-aligned bounding box for CDP `Page.captureScreenshot` clip. */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Compute the axis-aligned bounding box of an 8-double CDP content
 * quad / box-model polygon. Exported for unit tests.
 */
export function quadBoundingRect(quad: number[]): ViewportRect | null {
  if (quad.length !== 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) return null;
  return { x: minX, y: minY, width, height };
}

function rectToQuad(rect: ViewportRect): number[] {
  return [
    rect.x,
    rect.y,
    rect.x + rect.width,
    rect.y,
    rect.x + rect.width,
    rect.y + rect.height,
    rect.x,
    rect.y + rect.height,
  ];
}

/**
 * Resolve `backendNodeId` → CDP `objectId` so we can invoke
 * `Runtime.callFunctionOn` against the live JS object.
 */
export async function backendNodeToObject(
  cdp: CdpRunner,
  tabId: number,
  backendNodeId: number,
): Promise<string | RpcError> {
  try {
    const resolved = await cdp.send<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", {
      backendNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (typeof objectId !== "string") {
      return {
        code: "cdp_failed",
        message: "DOM.resolveNode returned no objectId",
      };
    }
    return objectId;
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function scrollNodeIntoView(
  cdp: CdpRunner,
  tabId: number,
  backendNodeId: number,
): Promise<RpcError | null> {
  try {
    await cdp.send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    return null;
  } catch (err) {
    console.debug("[bsk element-geometry] scrollIntoViewIfNeeded failed", err);
  }

  const objectIdOrErr = await backendNodeToObject(cdp, tabId, backendNodeId);
  if (isRpcError(objectIdOrErr)) return objectIdOrErr;
  try {
    await cdp.send(tabId, "Runtime.callFunctionOn", {
      objectId: objectIdOrErr,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', inline: 'center' });
      }`,
      returnByValue: true,
    });
    return null;
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Viewport-space bounding box for `backendNodeId`. Prefers
 * `DOM.getContentQuads`, then `DOM.getBoxModel`, then the union of
 * visible descendant client rects for zero-size overflow containers.
 */
export async function nodeBoundingRect(
  cdp: CdpRunner,
  tabId: number,
  backendNodeId: number,
): Promise<ViewportRect | RpcError> {
  const polygon = await visibleContentPolygon(cdp, tabId, backendNodeId);
  if (isRpcError(polygon)) return polygon;
  // visibleContentPolygon only returns quads with positive area.
  return quadBoundingRect(polygon)!;
}

/**
 * Compute the centroid of a CDP content quad. Quads are reported as
 * 8 doubles in clockwise order: (x1, y1, x2, y2, x3, y3, x4, y4).
 */
export function quadCentre(quad: number[]): { x: number; y: number } {
  const x = (quad[0] + quad[4]) / 2;
  const y = (quad[1] + quad[5]) / 2;
  return { x, y };
}

/** Centre of a `DOM.getBoxModel` `content` polygon (also 8 doubles). */
export function boxCentre(box: number[]): { x: number; y: number } {
  return quadCentre(box);
}

async function visibleContentPolygon(
  cdp: CdpRunner,
  tabId: number,
  backendNodeId: number,
): Promise<number[] | RpcError> {
  try {
    const quads = await cdp.send<{ quads?: number[][] }>(tabId, "DOM.getContentQuads", {
      backendNodeId,
    });
    const quad = quads.quads?.find((q) => q.length === 8 && quadBoundingRect(q) !== null);
    if (quad) return quad;
  } catch (err) {
    console.debug("[bsk element-geometry] getContentQuads failed", err);
  }
  try {
    const box = await cdp.send<{ model?: { content?: number[] } }>(tabId, "DOM.getBoxModel", {
      backendNodeId,
    });
    const content = box.model?.content;
    if (content && content.length === 8 && quadBoundingRect(content)) return content;
  } catch (err) {
    console.debug("[bsk element-geometry] getBoxModel failed", err);
  }
  const descendantRect = await descendantBoundingRect(cdp, tabId, backendNodeId);
  if (descendantRect) return rectToQuad(descendantRect);
  return elementNotVisibleError();
}

async function descendantBoundingRect(
  cdp: CdpRunner,
  tabId: number,
  backendNodeId: number,
): Promise<ViewportRect | null> {
  const objectIdOrErr = await backendNodeToObject(cdp, tabId, backendNodeId);
  if (isRpcError(objectIdOrErr)) {
    console.debug("[bsk element-geometry] resolveNode for descendant bounds failed", objectIdOrErr);
    return null;
  }
  try {
    const evaluated = await cdp.send<{
      result?: { value?: ViewportRect | null };
    }>(tabId, "Runtime.callFunctionOn", {
      objectId: objectIdOrErr,
      functionDeclaration: `function() {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const rects = [];
        const pushRect = (rect) => {
          if (!rect || rect.width <= 0 || rect.height <= 0) return;
          const left = Math.max(0, rect.left);
          const top = Math.max(0, rect.top);
          const right = Math.min(viewportWidth, rect.right);
          const bottom = Math.min(viewportHeight, rect.bottom);
          if (right <= left || bottom <= top) return;
          rects.push({ left, top, right, bottom });
        };
        const pushElement = (el) => {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return;
          }
          for (const rect of el.getClientRects()) pushRect(rect);
        };
        if (this instanceof Element) pushElement(this);
        if (typeof this.querySelectorAll === 'function') {
          for (const el of this.querySelectorAll('*')) pushElement(el);
        }
        if (rects.length === 0) return null;
        const left = Math.min(...rects.map((r) => r.left));
        const top = Math.min(...rects.map((r) => r.top));
        const right = Math.max(...rects.map((r) => r.right));
        const bottom = Math.max(...rects.map((r) => r.bottom));
        return { x: left, y: top, width: right - left, height: bottom - top };
      }`,
      returnByValue: true,
    });
    return parseViewportRect(evaluated.result?.value);
  } catch (err) {
    console.debug("[bsk element-geometry] descendant bounds failed", err);
    return null;
  }
}

function parseViewportRect(value: unknown): ViewportRect | null {
  if (typeof value !== "object" || value === null) return null;
  const rect = value as Partial<ViewportRect>;
  const { x, y, width, height } = rect;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Get the click point for `backendNodeId`. Prefers
 * `DOM.getContentQuads` (richer for rotated / transformed elements);
 * falls back to `DOM.getBoxModel`, then visible descendant bounds.
 * Returns `permission_denied` with "element not visible" when every
 * geometry path comes back empty / fails.
 */
export async function nodeCentre(
  cdp: CdpRunner,
  tabId: number,
  backendNodeId: number,
): Promise<{ x: number; y: number } | RpcError> {
  const polygon = await visibleContentPolygon(cdp, tabId, backendNodeId);
  if (isRpcError(polygon)) return polygon;
  return quadCentre(polygon);
}
