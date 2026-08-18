// Resolve and scroll nodes inside one CDP target. Cross-frame projection
// belongs to frame-geometry.ts.

import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import {
  parseCdpQuad,
  polygonBounds,
  type Region,
  rectPolygon,
  type ViewportRect,
} from "./geometry";
import { type CdpRunner, isRpcError } from "./shared";

const ELEMENT_NOT_VISIBLE_MESSAGE =
  "element not visible (no content quads, box model, or visible descendant bounds)";

function elementNotVisibleError(): RpcError {
  return rpcError("permission_denied", "element_not_visible", ELEMENT_NOT_VISIBLE_MESSAGE);
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

function validCdpRegion(quads: number[][] | undefined): Region {
  return (quads ?? []).flatMap((raw) => {
    const polygon = parseCdpQuad(raw);
    return polygon && polygonBounds(polygon) ? [polygon] : [];
  });
}

async function resolveVisibleContentRegion(
  cdp: CdpRunner,
  tabId: number,
  backendNodeId: number,
): Promise<Region | RpcError> {
  try {
    const quads = await cdp.send<{ quads?: number[][] }>(tabId, "DOM.getContentQuads", {
      backendNodeId,
    });
    const visible = validCdpRegion(quads.quads);
    if (visible.length > 0) return visible;
  } catch (err) {
    console.debug("[bsk element-geometry] getContentQuads failed", err);
  }
  try {
    const box = await cdp.send<{ model?: { content?: number[] } }>(tabId, "DOM.getBoxModel", {
      backendNodeId,
    });
    const content = box.model?.content;
    const fallback = validCdpRegion(content ? [content] : undefined);
    if (fallback.length > 0) return fallback;
  } catch (err) {
    console.debug("[bsk element-geometry] getBoxModel failed", err);
  }
  const descendantRect = await descendantBoundingRect(cdp, tabId, backendNodeId);
  if (descendantRect) {
    return [
      rectPolygon({
        x: descendantRect.x,
        y: descendantRect.y,
        w: descendantRect.width,
        h: descendantRect.height,
      }),
    ];
  }
  return elementNotVisibleError();
}

/** Resolve every visible content region in the node's target-local viewport. */
export async function nodeContentRegion(
  cdp: CdpRunner,
  tabId: number,
  backendNodeId: number,
): Promise<Region | RpcError> {
  return resolveVisibleContentRegion(cdp, tabId, backendNodeId);
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
