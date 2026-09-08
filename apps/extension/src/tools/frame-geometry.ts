import { type CdpTarget, cdpTargetKey } from "@/browser-driver/frame-graph";
import type { RpcError } from "@/transport/types";
import { nodeContentRegion, scrollNodeIntoView } from "./element-geometry";
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
import { type CdpRunner, cdpRunnerForTarget, isRpcError } from "./shared";

export interface NodeAddress {
  target: CdpTarget;
  backendNodeId: number;
  frameId?: string;
}

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
      cdpRunnerForTarget(cdp, parent.target),
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
  target: CdpTarget,
  backendNodeId: number,
  frameId: string | undefined,
  context: GeometryContext,
): Promise<RpcError | null> {
  if (frameId) {
    const frame = await context.frame(frameId);
    if (!frame || cdpTargetKey(frame.target) !== cdpTargetKey(target)) {
      return geometryError("node frame does not belong to its target");
    }
    const error = await scrollFrameOwners(cdp, tabId, context, frameId);
    if (error) return error;
  } else if (target.sessionId) {
    return geometryError("an OOPIF node address requires frameId");
  }
  return scrollNodeIntoView(cdpRunnerForTarget(cdp, target), tabId, backendNodeId);
}

export async function scrollElementAndFramesIntoView(
  cdp: CdpRunner,
  tabId: number,
  target: CdpTarget,
  backendNodeId: number,
  frameId?: string,
): Promise<RpcError | null> {
  if (target.tabId !== tabId) return geometryError("node target belongs to another tab");
  return scrollElementWithContext(
    cdp,
    tabId,
    target,
    backendNodeId,
    frameId,
    new GeometryContext(cdp, tabId),
  );
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
    if (address.target.sessionId && !address.frameId) {
      return geometryError("an OOPIF node address requires frameId");
    }
    if (address.target.tabId !== tabId) return geometryError("node target belongs to another tab");
    const context = new GeometryContext(cdp, tabId);
    const graph = address.frameId ? await context.graph() : null;
    if (address.frameId && graph) {
      const frame = await context.frame(address.frameId);
      if (!frame || cdpTargetKey(frame.target) !== cdpTargetKey(address.target)) {
        return geometryError("node frame does not belong to its target");
      }
    }
    if (address.frameId && !graph) {
      return geometryError(`could not resolve frame graph for ${address.frameId}`);
    }

    if (options.scrollIntoView) {
      const scrollError = await scrollElementWithContext(
        cdp,
        tabId,
        address.target,
        address.backendNodeId,
        address.frameId,
        context,
      );
      if (scrollError) return scrollError;
    }

    // Only topology was read above. Begin live measurements after scrolling.
    const localRegion = await nodeContentRegion(
      cdpRunnerForTarget(cdp, address.target),
      tabId,
      address.backendNodeId,
    );
    if (isRpcError(localRegion)) return localRegion;

    let topVisibleRegions: Region;
    let targetActionPoint: Point | null = null;
    if (address.frameId && graph) {
      const projection = await context.targetProjection(address.frameId);
      if (!projection)
        return geometryError(`could not resolve frame geometry for ${address.frameId}`);
      topVisibleRegions = projectRegionToViewport(localRegion, projection);
      if (address.target.sessionId) {
        const localViewport = projection.edges[0]?.sourceViewport ?? projection.topViewport;
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
      const viewport = await context.viewport(address.target);
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
    if (address.target.sessionId && !targetActionPoint) {
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
    return geometryError(error instanceof Error ? error.message : String(error));
  }
}
