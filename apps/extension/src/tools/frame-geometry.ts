import {
  type FrameNodeHandle,
  isStaleFrameHandleError,
  rootProcessBoundary,
  StaleFrameHandleError,
} from "@/browser-driver/frame-handles";
import type { RpcError } from "@/transport/types";
import { nodeContentRegion, scrollNodeIntoView } from "./element-geometry";
import { rpcError } from "./errors";
import {
  clipPolygon,
  type GeometryProjection,
  type Point,
  type Polygon,
  polygonArea,
  polygonCentroid,
  projectRegionToViewport,
  type Region,
  rectPolygon,
  regionBounds,
  unprojectPoint,
  type ViewportRect,
} from "./geometry";
import type { CssViewport } from "./geometry/coordinate-types";
import { cssViewport, GeometryContext } from "./geometry/frame-context";
import { type CdpRunner, cdpRunnerForFrame, isRpcError } from "./shared";

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
      cdpRunnerForFrame(cdp, parent.handle),
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
  return scrollNodeIntoView(cdpRunnerForFrame(cdp, handle), tabId, handle.backendNodeId);
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

function cleanProjectedCoord(value: number): number {
  const snapped = Math.round(value * 1e6) / 1e6;
  return Math.abs(value - snapped) < 1e-9 ? snapped : value;
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
      cdpRunnerForFrame(cdp, address),
      tabId,
      address.backendNodeId,
    );
    if (isRpcError(localRegion)) return localRegion;

    const isOopifTarget = Boolean(frame?.isOutOfProcess);
    let topVisibleRegions: Region;
    let projection: GeometryProjection | null = null;
    if (address.frameId && graph && frame) {
      projection = await context.targetProjection(address.frameId);
      if (!projection)
        return geometryError(`could not resolve frame geometry for ${address.frameId}`);
      topVisibleRegions = projectRegionToViewport(localRegion, projection);
    } else {
      const viewport = await context.viewport(rootProcessBoundary(tabId));
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
      return rpcError("permission_denied", "element_not_visible", "element not visible");
    }
    // Derive the OOPIF-local point by unprojecting the already top/ancestor-clipped
    // actionPoint back through every target boundary, so parent viewport clips and
    // nested iframe clips are preserved consistently with pointReachesTarget.
    let targetActionPoint: Point = actionPoint;
    if (isOopifTarget) {
      let local: Point | null = projection ? actionPoint : null;
      if (projection) {
        for (let index = projection.edges.length - 1; index >= 0 && local; index--) {
          local = unprojectPoint(local, projection.edges[index]);
        }
      }
      if (!local) {
        return rpcError(
          "permission_denied",
          "element_not_visible",
          "element not visible in its target",
        );
      }
      targetActionPoint = {
        x: cleanProjectedCoord(local.x),
        y: cleanProjectedCoord(local.y),
      };
    }
    return {
      topVisibleRegions,
      topBounds,
      actionPoint,
      targetActionPoint,
      topViewport: cssViewport(await context.topLayoutMetrics(rootProcessBoundary(tabId))),
    };
  } catch (error) {
    if (isStaleFrameHandleError(error)) {
      return rpcError("not_found", "ref_not_found", error.message);
    }
    return geometryError(error instanceof Error ? error.message : String(error));
  }
}
