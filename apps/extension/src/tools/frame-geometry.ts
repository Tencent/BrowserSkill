import {
  type CdpFrame,
  type CdpFrameGraph,
  type CdpTarget,
  cdpTargetKey,
} from "@/browser-driver/frame-graph";
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
  projectRectToViewport,
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

async function sameTargetFrameViewport(cdp: CdpRunner, frame: CdpFrame): Promise<Size | null> {
  const world = await sendToCdpTarget<{ executionContextId?: number }>(
    cdp,
    frame.target,
    "Page.createIsolatedWorld",
    {
      frameId: frame.frameId,
      worldName: "bsk-frame-geometry",
      grantUniveralAccess: false,
    },
  );
  if (world.executionContextId === undefined) return null;
  const result = await sendToCdpTarget<{ result?: { value?: unknown } }>(
    cdp,
    frame.target,
    "Runtime.evaluate",
    {
      expression: "({width:window.innerWidth,height:window.innerHeight})",
      contextId: world.executionContextId,
      returnByValue: true,
    },
  );
  const value = result.result?.value as { width?: unknown; height?: unknown } | undefined;
  const width = value?.width;
  const height = value?.height;
  return typeof width === "number" &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isFinite(height) &&
    height > 0
    ? { width, height }
    : null;
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

export interface FrameGeometryContext {
  resolveFrameProjection(frameId: string): Promise<GeometryProjection | null>;
  projectFrameLocalRect(
    frameId: string,
    rect: { x: number; y: number; w: number; h: number },
  ): Promise<ViewportRect | null>;
}

export function createFrameGeometryContext(
  cdp: CdpRunner,
  graph: CdpFrameGraph,
): FrameGeometryContext {
  const byId = frameMap(graph);
  const targetViewports = new Map<string, Promise<Size | null>>();
  const frameViewports = new Map<string, Promise<Size | null>>();
  const ownerQuads = new Map<string, Promise<Quad | null>>();
  const projections = new Map<string, Promise<GeometryProjection | null>>();
  const localProjections = new Map<string, Promise<GeometryProjection | null>>();

  const cachedTargetViewport = (target: CdpTarget): Promise<Size | null> => {
    const key = cdpTargetKey(target);
    let value = targetViewports.get(key);
    if (!value) {
      value = targetViewport(cdp, target);
      targetViewports.set(key, value);
    }
    return value;
  };
  const cachedFrameViewport = (frame: CdpFrame): Promise<Size | null> => {
    let value = frameViewports.get(frame.frameId);
    if (!value) {
      const root = targetRootFrame(byId, frame);
      value =
        root?.frameId === frame.frameId
          ? cachedTargetViewport(frame.target)
          : sameTargetFrameViewport(cdp, frame);
      frameViewports.set(frame.frameId, value);
    }
    return value;
  };
  const cachedOwnerQuad = (parent: CdpFrame, backendNodeId: number): Promise<Quad | null> => {
    const key = `${cdpTargetKey(parent.target)}:${backendNodeId}`;
    let value = ownerQuads.get(key);
    if (!value) {
      value = ownerContentQuad(cdp, parent, backendNodeId);
      ownerQuads.set(key, value);
    }
    return value;
  };
  const cachedSameTargetClips = async (
    frame: CdpFrame,
    root: CdpFrame,
  ): Promise<Polygon[] | null> => {
    const clips: Polygon[] = [];
    let current = frame;
    const seen = new Set<string>();
    while (current.frameId !== root.frameId) {
      if (seen.has(current.frameId) || !current.parentFrameId) return null;
      seen.add(current.frameId);
      const parent = byId.get(current.parentFrameId);
      if (!parent || current.ownerBackendNodeId === undefined) return null;
      const clip = await cachedOwnerQuad(parent, current.ownerBackendNodeId);
      if (!clip) return null;
      clips.push(clip);
      current = parent;
    }
    return clips;
  };

  const buildTargetProjection = async (frameId: string): Promise<GeometryProjection | null> => {
    const frame = byId.get(frameId);
    if (!frame) return null;
    let root = targetRootFrame(byId, frame);
    if (!root) return null;
    const sourceViewport = await cachedTargetViewport(root.target);
    if (!sourceViewport) return null;
    const sourceClips = await cachedSameTargetClips(frame, root);
    if (!sourceClips) return null;
    const edges: ProjectiveEdge[] = [];
    while (root.parentFrameId) {
      const parent = byId.get(root.parentFrameId);
      if (!parent || root.ownerBackendNodeId === undefined) return null;
      const destinationQuad = await cachedOwnerQuad(parent, root.ownerBackendNodeId);
      if (!destinationQuad) return null;
      const source = await cachedTargetViewport(root.target);
      if (!source) return null;
      const parentRoot = targetRootFrame(byId, parent);
      if (!parentRoot) return null;
      const destinationClips = await cachedSameTargetClips(parent, parentRoot);
      if (!destinationClips) return null;
      edges.push({ sourceViewport: source, destinationQuad, destinationClips });
      root = parentRoot;
    }
    const topViewport = await cachedTargetViewport(root.target);
    return topViewport ? { sourceClips, edges, topViewport } : null;
  };

  const resolveFrameProjectionCached = (frameId: string): Promise<GeometryProjection | null> => {
    let value = projections.get(frameId);
    if (!value) {
      value = buildTargetProjection(frameId);
      projections.set(frameId, value);
    }
    return value;
  };

  const buildLocalProjection = async (frameId: string): Promise<GeometryProjection | null> => {
    const frame = byId.get(frameId);
    if (!frame) return null;
    const root = targetRootFrame(byId, frame);
    if (!root) return null;
    const targetProjection = await resolveFrameProjectionCached(root.frameId);
    if (!targetProjection) return null;
    if (root.frameId === frame.frameId) return targetProjection;
    if (!frame.parentFrameId || frame.ownerBackendNodeId === undefined) return null;
    const parent = byId.get(frame.parentFrameId);
    if (!parent) return null;
    const sourceViewport = await cachedFrameViewport(frame);
    const destinationQuad = await cachedOwnerQuad(parent, frame.ownerBackendNodeId);
    const destinationClips = await cachedSameTargetClips(frame, root);
    if (!sourceViewport || !destinationQuad || !destinationClips) return null;
    return {
      sourceClips: [],
      edges: [{ sourceViewport, destinationQuad, destinationClips }, ...targetProjection.edges],
      topViewport: targetProjection.topViewport,
    };
  };

  const localProjection = (frameId: string): Promise<GeometryProjection | null> => {
    let value = localProjections.get(frameId);
    if (!value) {
      value = buildLocalProjection(frameId);
      localProjections.set(frameId, value);
    }
    return value;
  };

  return {
    resolveFrameProjection: resolveFrameProjectionCached,
    async projectFrameLocalRect(frameId, rect) {
      const projection = await localProjection(frameId);
      return projection ? projectRectToViewport(rect, projection) : null;
    },
  };
}

export async function resolveFrameProjection(
  cdp: CdpRunner,
  graph: CdpFrameGraph,
  frameId: string,
): Promise<GeometryProjection | null> {
  return createFrameGeometryContext(cdp, graph).resolveFrameProjection(frameId);
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
