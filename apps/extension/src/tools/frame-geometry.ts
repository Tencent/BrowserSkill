import {
  type CdpFrame,
  type FrameDocumentHandle,
  type FrameNodeHandle,
  isStaleFrameHandleError,
  StaleFrameHandleError,
  toFrameDocumentHandle,
} from "@/browser-driver/frame-graph";
import type { RpcError } from "@/transport/types";
import { nodeContentRegion, scrollNodeIntoView } from "./element-geometry";
import { rpcError } from "./errors";
import {
  clipPolygon,
  type Point,
  type Polygon,
  polygonArea,
  polygonCentroid,
  projectRegionToViewport,
  type Region,
  rectPolygon,
  regionBounds,
  type ViewportRect,
} from "./geometry";
import type { CssViewport } from "./geometry/coordinate-types";
import { cssViewport, GeometryContext } from "./geometry/frame-context";
import { type CdpRunner, cdpRunnerForFrame, cdpRunnerForTarget, isRpcError } from "./shared";

export type NodeAddress = FrameNodeHandle;

export interface ResolvedNodeGeometry {
  /** The same top-level measurement used by projection, for screenshot coordinate adaptation. */
  topViewport: CssViewport;
  topVisibleRegions: Region;
  topBounds: ViewportRect;
  /** Point in the top-level tab viewport, used by root-target input events. */
  actionPoint: Point;
  /** Point in the addressed CDP target's viewport, used by OOPIF-local input events. */
  targetActionPoint: Point;
}

function geometryError(message: string): RpcError {
  return { code: "cdp_failed", message };
}

function frameRunner(
  cdp: CdpRunner,
  handle: FrameDocumentHandle | FrameNodeHandle,
  resolvedFrame?: CdpFrame,
): CdpRunner {
  if (cdp.sendToFrame || !resolvedFrame) return cdpRunnerForFrame(cdp, handle);
  return cdpRunnerForTarget(cdp, resolvedFrame.target);
}

async function scrollFrameOwners(
  cdp: CdpRunner,
  tabId: number,
  context: GeometryContext,
  frameId: string,
): Promise<RpcError | null> {
  const ancestry = await context.ancestry(frameId);
  if (!ancestry) return geometryError(`could not resolve frame ancestry for ${frameId}`);
  for (const child of [...ancestry].reverse()) {
    const parent = child.parentFrameId ? await context.frame(child.parentFrameId) : undefined;
    if (!parent || child.ownerBackendNodeId === undefined) {
      return geometryError(`could not resolve frame owner for ${child.frameId}`);
    }
    const error = await scrollNodeIntoView(
      frameRunner(cdp, toFrameDocumentHandle(tabId, parent), parent),
      tabId,
      child.ownerBackendNodeId,
    );
    if (error) return error;
  }
  return null;
}

async function scrollElementWithContext(
  cdp: CdpRunner,
  tabId: number,
  handle: FrameNodeHandle,
  context: GeometryContext,
): Promise<RpcError | null> {
  const frame = handle.frameId ? await context.frame(handle.frameId) : undefined;
  if (handle.frameId) {
    if (!frame) {
      throw new StaleFrameHandleError(handle, `frame ${handle.frameId} is no longer attached`);
    }
    if (handle.loaderId && frame.loaderId && frame.loaderId !== handle.loaderId) {
      throw new StaleFrameHandleError(
        handle,
        `frame ${handle.frameId} navigated (${handle.loaderId} -> ${frame.loaderId})`,
      );
    }
    const error = await scrollFrameOwners(cdp, tabId, context, handle.frameId);
    if (error) return error;
  }
  return scrollNodeIntoView(frameRunner(cdp, handle, frame), tabId, handle.backendNodeId);
}

export async function scrollElementAndFramesIntoView(
  cdp: CdpRunner,
  tabId: number,
  handle: FrameNodeHandle,
): Promise<RpcError | null> {
  if (handle.tabId !== tabId) return geometryError("node target belongs to another tab");
  try {
    return await scrollElementWithContext(cdp, tabId, handle, new GeometryContext(cdp, tabId));
  } catch (error) {
    if (isStaleFrameHandleError(error)) {
      return rpcError("not_found", "ref_not_found", error.message);
    }
    return geometryError(error instanceof Error ? error.message : String(error));
  }
}

function largestRegion(regions: Region): Polygon | null {
  let largest: { polygon: Polygon; area: number } | null = null;
  for (const polygon of regions) {
    const area = polygonArea(polygon);
    if (area <= 0) continue;
    if (!largest || area > largest.area) largest = { polygon, area };
  }
  return largest?.polygon ?? null;
}

export async function resolveNodeGeometry(
  cdp: CdpRunner,
  tabId: number,
  address: NodeAddress,
  options: { scrollIntoView?: boolean } = {},
): Promise<ResolvedNodeGeometry | RpcError> {
  try {
    if (address.tabId !== tabId) return geometryError("node target belongs to another tab");
    const context = new GeometryContext(cdp, tabId);
    const graph = address.frameId ? await context.graph() : null;
    const frame = address.frameId && graph ? await context.frame(address.frameId) : undefined;
    if (address.frameId && !graph) {
      return geometryError(`could not resolve frame graph for ${address.frameId}`);
    }
    if (address.frameId && !frame) {
      return rpcError(
        "not_found",
        "ref_not_found",
        `Stale frame handle for frame ${address.frameId}: frame is no longer attached`,
      );
    }
    if (
      address.frameId &&
      frame &&
      address.loaderId &&
      frame.loaderId &&
      frame.loaderId !== address.loaderId
    ) {
      return rpcError(
        "not_found",
        "ref_not_found",
        `Stale frame handle for frame ${address.frameId}: frame navigated (${address.loaderId} -> ${frame.loaderId})`,
      );
    }

    if (options.scrollIntoView) {
      const scrollError = await scrollElementWithContext(cdp, tabId, address, context);
      if (scrollError) return scrollError;
    }

    // Only topology was read above. Begin live measurements after scrolling.
    const localRegion = await nodeContentRegion(
      frameRunner(cdp, address, frame),
      tabId,
      address.backendNodeId,
    );
    if (isRpcError(localRegion)) return localRegion;

    const isOopifTarget = Boolean(frame?.target.sessionId);
    let topVisibleRegions: Region;
    let targetActionPoint: Point | null = null;
    if (address.frameId && graph && frame) {
      const projection = await context.targetProjection(address.frameId);
      if (!projection)
        return geometryError(`could not resolve frame geometry for ${address.frameId}`);
      topVisibleRegions = projectRegionToViewport(localRegion, projection);
      if (isOopifTarget) {
        const localViewport = await context.viewport(frame.target);
        if (!localViewport) return geometryError("could not resolve target viewport geometry");
        const localVisibleRegions = localRegion
          .map((polygon) =>
            clipPolygon(
              polygon,
              rectPolygon({
                x: 0,
                y: 0,
                w: localViewport.width,
                h: localViewport.height,
              }),
            ),
          )
          .filter((polygon) => polygon.length >= 3);
        const localActionRegion = largestRegion(localVisibleRegions);
        targetActionPoint = localActionRegion ? polygonCentroid(localActionRegion) : null;
      }
    } else {
      const viewport = await context.viewport({ tabId });
      if (!viewport) return geometryError("could not resolve top viewport geometry");
      topVisibleRegions = localRegion
        .map((polygon) =>
          clipPolygon(polygon, rectPolygon({ x: 0, y: 0, w: viewport.width, h: viewport.height })),
        )
        .filter((polygon) => polygon.length >= 3);
    }

    const topBounds = regionBounds(topVisibleRegions);
    const actionRegion = largestRegion(topVisibleRegions);
    const actionPoint = actionRegion ? polygonCentroid(actionRegion) : null;
    if (!topBounds || !actionPoint) {
      return { code: "permission_denied", message: "element not visible" };
    }
    if (isOopifTarget && !targetActionPoint) {
      return { code: "permission_denied", message: "element not visible in its target" };
    }
    targetActionPoint ??= actionPoint;
    return {
      topVisibleRegions,
      topBounds,
      actionPoint,
      targetActionPoint,
      topViewport: cssViewport(await context.layoutMetrics({ tabId })),
    };
  } catch (error) {
    if (isStaleFrameHandleError(error)) {
      return rpcError("not_found", "ref_not_found", error.message);
    }
    return geometryError(error instanceof Error ? error.message : String(error));
  }
}
