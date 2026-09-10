import { cdpTargetKey } from "@/browser-driver/frame-graph";
import type { NodeAddress } from "./frame-geometry";
import {
  clipPolygon,
  projectRegionToViewport,
  type Region,
  rectPolygon,
  regionBounds,
  type ViewportRect,
} from "./geometry";
import { GeometryContext } from "./geometry/frame-context";
import { type CdpRunner, sendToCdpTarget } from "./shared";

// Ask the renderer to apply containing-block clips (including shadow DOM),
// instead of treating layout quads as visible pixels. Each document is measured
// locally; the existing frame projections supply the top-viewport coordinates.
// IntersectionObserver reports a bounding rectangle, not an occlusion/hit test.
const VISIBLE_RECT = `function(timeoutMs) {
  const element = this;
  const visible = () => element.isConnected && element.checkVisibility({
    checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true
  });
  if (typeof element.checkVisibility !== 'function' || !visible()) return null;
  return new Promise((resolve, reject) => {
    const observer = new IntersectionObserver(([entry]) => {
      clearTimeout(timer);
      observer.disconnect();
      const rect = entry.intersectionRect;
      resolve(visible() && entry.isIntersecting && rect.width > 0 && rect.height > 0
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null);
    }, { root: element.ownerDocument });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error('scroll-to visibility measurement timed out'));
    }, timeoutMs);
    observer.observe(element);
  });
}`;

async function visibleRect(
  cdp: CdpRunner,
  address: NodeAddress,
  deadline: number,
): Promise<ViewportRect | null> {
  const resolved = await sendToCdpTarget<{ object?: { objectId?: string } }>(
    cdp,
    address.target,
    "DOM.resolveNode",
    { backendNodeId: address.backendNodeId },
  );
  if (!resolved.object?.objectId) throw new Error("scroll-to could not resolve the target element");
  const reply = await sendToCdpTarget<{
    result?: { value?: ViewportRect | null };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  }>(cdp, address.target, "Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration: VISIBLE_RECT,
    // Bound this read even if a background document stops rendering. Its
    // observer always disconnects; cancellation cannot leave a live observer.
    arguments: [{ value: Math.max(1, Math.min(1_000, deadline - Date.now())) }],
    awaitPromise: true,
    returnByValue: true,
  });
  if (reply.exceptionDetails) {
    const details = reply.exceptionDetails;
    throw new Error(details.exception?.description ?? details.text ?? "visibility script failed");
  }
  const rect = reply.result?.value;
  if (rect === null) return null;
  if (
    !rect ||
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new Error("scroll-to visibility measurement returned invalid bounds");
  }
  return rect;
}

async function projectRect(
  context: GeometryContext,
  address: NodeAddress,
  rect: ViewportRect,
): Promise<Region> {
  let region: Region = [rectPolygon({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })];
  if (!address.frameId) return region;
  const frame = await context.frame(address.frameId);
  if (!frame || cdpTargetKey(frame.target) !== cdpTargetKey(address.target)) {
    throw new Error("scroll-to frame no longer belongs to its target");
  }
  const parent = frame.parentFrameId ? await context.frame(frame.parentFrameId) : undefined;
  if (parent && cdpTargetKey(parent.target) === cdpTargetKey(frame.target)) {
    // DOM rectangles are document-local. Same-target iframe quads are already
    // target-local, so cross this one boundary before the target projection.
    const viewport = await context.viewport(frame.target);
    if (frame.ownerBackendNodeId === undefined || !viewport) {
      throw new Error("scroll-to could not resolve the frame viewport");
    }
    const local = await context.snapshotProjection(address, frame.ownerBackendNodeId, [], viewport);
    if (local.status !== "available") throw new Error("scroll-to could not project the frame");
    region = projectRegionToViewport(region, local.projection.geometry);
  }
  const projection = await context.targetProjection(frame.frameId);
  if (!projection) throw new Error("scroll-to could not project the target viewport");
  return projectRegionToViewport(region, projection);
}

/** Renderer-clipped bounds for scroll-to and wheel; shared interaction geometry is unchanged. */
export async function scrollVisibleBounds(
  cdp: CdpRunner,
  tabId: number,
  address: NodeAddress,
  deadline: number,
): Promise<ViewportRect | null> {
  const context = new GeometryContext(cdp, tabId);
  const rect = await visibleRect(cdp, address, deadline);
  if (!rect) return null;
  let region = await projectRect(context, address, rect);
  if (address.frameId) {
    const ancestry = await context.ancestry(address.frameId);
    if (!ancestry) throw new Error("scroll-to could not resolve the frame ancestry");
    for (const child of ancestry) {
      const parent = child.parentFrameId ? await context.frame(child.parentFrameId) : undefined;
      if (!parent || child.ownerBackendNodeId === undefined) {
        throw new Error("scroll-to could not resolve the frame owner");
      }
      const owner = {
        target: parent.target,
        frameId: parent.frameId,
        backendNodeId: child.ownerBackendNodeId,
      };
      // A visible child document can still have a hidden or clipped iframe.
      const ownerRect = await visibleRect(cdp, owner, deadline);
      if (!ownerRect) return null;
      const clips = await projectRect(context, owner, ownerRect);
      region = region.flatMap((polygon) => clips.map((clip) => clipPolygon(polygon, clip)));
    }
  }
  return regionBounds(region);
}
