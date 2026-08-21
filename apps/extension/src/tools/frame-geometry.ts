import { type CdpFrame, type CdpFrameGraph, type CdpTarget } from "@/browser-driver/frame-graph";
import type { RpcError } from "@/transport/types";
import { nodeContentRegion, scrollNodeIntoView } from "./element-geometry";
import {
  clipPolygon,
  type GeometryProjection,
  type Point,
  type Polygon,
  type ProjectiveEdge,
  parseCdpQuad,
  polygonArea,
  polygonCentroid,
  projectRegionToViewport,
  type Quad,
  type Region,
  rectPolygon,
  regionBounds,
  type Size,
  type ViewportRect,
} from "./geometry";
import { type CdpRunner, cdpRunnerForTarget, isRpcError, sendToCdpTarget } from "./shared";

export interface NodeAddress {
  target: CdpTarget;
  backendNodeId: number;
  frameId?: string;
}

export interface ResolvedNodeGeometry {
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

function frameMap(graph: CdpFrameGraph): Map<string, CdpFrame> {
  return new Map(graph.frames.map((frame) => [frame.frameId, frame]));
}

function targetRootFrame(byId: Map<string, CdpFrame>, frame: CdpFrame): CdpFrame | null {
  const seen = new Set<string>();
  let current = frame;
  while (current.parentFrameId) {
    if (seen.has(current.frameId)) return null;
    seen.add(current.frameId);
    const parent = byId.get(current.parentFrameId);
    if (!parent || parent.target.sessionId !== current.target.sessionId) break;
    current = parent;
  }
  return current;
}

function frameAncestry(graph: CdpFrameGraph, frameId: string): CdpFrame[] | null {
  const byId = frameMap(graph);
  const path: CdpFrame[] = [];
  const seen = new Set<string>();
  let current = byId.get(frameId);
  if (!current) return null;
  while (current.parentFrameId) {
    if (seen.has(current.frameId)) return null;
    seen.add(current.frameId);
    path.push(current);
    const parent = byId.get(current.parentFrameId);
    if (!parent) return null;
    current = parent;
  }
  return path;
}

async function targetViewport(cdp: CdpRunner, target: CdpTarget): Promise<Size | null> {
  const metrics = await sendToCdpTarget<{
    cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    layoutViewport?: { clientWidth?: number; clientHeight?: number };
  }>(cdp, target, "Page.getLayoutMetrics", {});
  const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
  const width = viewport.clientWidth ?? 0;
  const height = viewport.clientHeight ?? 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

async function ownerContentQuad(
  cdp: CdpRunner,
  parent: CdpFrame,
  ownerBackendNodeId: number,
): Promise<Quad | null> {
  const result = await sendToCdpTarget<{ model?: { content?: number[] } }>(
    cdp,
    parent.target,
    "DOM.getBoxModel",
    { backendNodeId: ownerBackendNodeId },
  );
  return parseCdpQuad(result.model?.content);
}

async function sameTargetFrameClips(
  cdp: CdpRunner,
  byId: Map<string, CdpFrame>,
  frame: CdpFrame,
  targetRoot: CdpFrame,
): Promise<Polygon[] | null> {
  const clips: Polygon[] = [];
  let current = frame;
  const seen = new Set<string>();
  while (current.frameId !== targetRoot.frameId) {
    if (seen.has(current.frameId) || !current.parentFrameId) return null;
    seen.add(current.frameId);
    const parent = byId.get(current.parentFrameId);
    if (!parent || current.ownerBackendNodeId === undefined) return null;
    const clip = await ownerContentQuad(cdp, parent, current.ownerBackendNodeId);
    if (!clip) return null;
    clips.push(clip);
    current = parent;
  }
  return clips;
}

export async function resolveFrameProjection(
  cdp: CdpRunner,
  graph: CdpFrameGraph,
  frameId: string,
): Promise<GeometryProjection | null> {
  const byId = frameMap(graph);
  const frame = byId.get(frameId);
  if (!frame) return null;
  let targetRoot = targetRootFrame(byId, frame);
  if (!targetRoot) return null;
  const sourceViewport = await targetViewport(cdp, targetRoot.target);
  if (!sourceViewport) return null;
  const sourceClips = await sameTargetFrameClips(cdp, byId, frame, targetRoot);
  if (!sourceClips) return null;

  const edges: ProjectiveEdge[] = [];
  while (targetRoot.parentFrameId) {
    const parent = byId.get(targetRoot.parentFrameId);
    if (!parent || targetRoot.ownerBackendNodeId === undefined) return null;
    const destinationQuad = await ownerContentQuad(cdp, parent, targetRoot.ownerBackendNodeId);
    if (!destinationQuad) return null;
    const source =
      edges.length === 0 ? sourceViewport : await targetViewport(cdp, targetRoot.target);
    if (!source) return null;
    const parentTargetRoot = targetRootFrame(byId, parent);
    if (!parentTargetRoot) return null;
    const destinationClips = await sameTargetFrameClips(cdp, byId, parent, parentTargetRoot);
    if (!destinationClips) return null;
    edges.push({ sourceViewport: source, destinationQuad, destinationClips });
    targetRoot = parentTargetRoot;
  }

  const topViewport =
    edges.length === 0 ? sourceViewport : await targetViewport(cdp, targetRoot.target);
  return topViewport ? { sourceClips, edges, topViewport } : null;
}

async function loadFrameGraph(cdp: CdpRunner, tabId: number): Promise<CdpFrameGraph | null> {
  if (!cdp.getFrameGraph) return null;
  try {
    return await cdp.getFrameGraph(tabId);
  } catch (error) {
    console.debug("[bsk frame-geometry] frame graph resolution failed", error);
    return null;
  }
}

async function scrollFrameOwners(
  cdp: CdpRunner,
  tabId: number,
  graph: CdpFrameGraph,
  frameId: string,
): Promise<RpcError | null> {
  const byId = frameMap(graph);
  const ancestry = frameAncestry(graph, frameId);
  if (!ancestry) return geometryError(`could not resolve frame ancestry for ${frameId}`);
  for (const child of [...ancestry].reverse()) {
    const parent = child.parentFrameId ? byId.get(child.parentFrameId) : undefined;
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

async function scrollElementWithFrameGraph(
  cdp: CdpRunner,
  tabId: number,
  target: CdpTarget,
  backendNodeId: number,
  frameId: string | undefined,
  graph: CdpFrameGraph | null,
): Promise<RpcError | null> {
  if (frameId) {
    if (!graph) return geometryError(`could not resolve frame graph for ${frameId}`);
    const error = await scrollFrameOwners(cdp, tabId, graph, frameId);
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
  const graph = frameId ? await loadFrameGraph(cdp, tabId) : null;
  return scrollElementWithFrameGraph(cdp, tabId, target, backendNodeId, frameId, graph);
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
    const graph = address.frameId ? await loadFrameGraph(cdp, tabId) : null;
    if (address.frameId && !graph) {
      return geometryError(`could not resolve frame graph for ${address.frameId}`);
    }

    if (options.scrollIntoView) {
      const scrollError = await scrollElementWithFrameGraph(
        cdp,
        tabId,
        address.target,
        address.backendNodeId,
        address.frameId,
        graph,
      );
      if (scrollError) return scrollError;
    }

    const localRegion = await nodeContentRegion(
      cdpRunnerForTarget(cdp, address.target),
      tabId,
      address.backendNodeId,
    );
    if (isRpcError(localRegion)) return localRegion;

    let topVisibleRegions: Region;
    let targetActionPoint: Point | null = null;
    if (address.frameId && graph) {
      const projection = await resolveFrameProjection(cdp, graph, address.frameId);
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
      const viewport = await targetViewport(cdp, address.target);
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
    return { topVisibleRegions, topBounds, actionPoint, targetActionPoint };
  } catch (error) {
    return geometryError(error instanceof Error ? error.message : String(error));
  }
}
