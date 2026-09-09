import type { Viewport } from "@browser-skill/vom";
import { type CdpFrame, type CdpTarget, cdpTargetKey } from "@/browser-driver/frame-graph";
import { type GeometryProjection, projectRectToViewport } from "../geometry";
import {
  type FrameProjectionState,
  projectSnapshotRect,
  type SnapshotCoordinates,
  snapshotCoordinates,
  snapshotViewportRect,
} from "../geometry/coordinate-types";
import {
  GeometryContext,
  type LayoutMetrics,
  snapshotLayoutScale,
} from "../geometry/frame-context";
import {
  createCaptureCheckpoint,
  isAbortError as isCaptureAbort,
  throwIfAborted as throwCaptureAborted,
} from "./capture-abort";
import {
  buildDocumentIndex,
  type CaptureIssue,
  type DocumentGeometry,
  type DocumentIndex,
  type NodeFacts,
} from "./facts";
import {
  decodeDocument,
  type SnapshotDocument,
  type SnapshotReply,
  snapshotFrameId,
} from "./snapshot";

export interface FrameContext {
  frameId?: string;
  ownerFrameBackendNodeId: number | null;
  projection: FrameProjectionState | null;
  targetProjection?: GeometryProjection | null;
  target: CdpTarget;
  coordinates: SnapshotCoordinates | null;
  pageScale?: number;
}

export interface NormalizedDocument {
  geometry?: DocumentGeometry;
  nodes: NodeFacts[];
  index: DocumentIndex;
  documentElementBackendNodeId?: number;
}

/** Interpret one document using a supplied projection. No live reads or frame scheduling. */
export async function normalizeDocument(
  doc: SnapshotDocument,
  strings: string[],
  context: FrameContext,
  signal?: AbortSignal,
): Promise<NormalizedDocument> {
  const decoded = await decodeDocument(doc, strings, signal);
  const checkpoint = createCaptureCheckpoint(signal);
  const nodes: NodeFacts[] = [];
  for (let i = 0; i < decoded.nodes.length; i++) {
    if (i % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    const node = decoded.nodes[i];
    const bounds = node.layout?.bounds ?? [];
    const input = snapshotViewportRect(
      bounds,
      { target: context.target, frameId: context.frameId },
      context.coordinates,
    );
    const local = input?.rect;
    let rect =
      input && context.projection?.status === "available"
        ? projectSnapshotRect(input, context.projection.projection)
        : null;
    if (rect && context.targetProjection !== undefined)
      rect = context.targetProjection
        ? projectRectToViewport(
            { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            context.targetProjection,
          )
        : null;
    const visibility = node.layout?.styles.visibility || "visible";
    const opacity = node.layout?.styles.opacity || "1";
    nodes.push({
      ...node,
      ...(context.frameId ? { frameId: context.frameId } : {}),
      ownerFrameBackendNodeId: context.ownerFrameBackendNodeId,
      localRect: local ? { x: local.x, y: local.y, w: local.width, h: local.height } : null,
      rect: rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null,
      rendered:
        bounds.length >= 4 &&
        bounds.slice(0, 4).every(Number.isFinite) &&
        bounds[2] > 0 &&
        bounds[3] > 0 &&
        visibility !== "hidden" &&
        visibility !== "collapse" &&
        (Number.parseFloat(opacity) || 0) > 0,
    });
  }
  const index = await buildDocumentIndex(nodes, signal);
  return {
    nodes: nodes.filter(
      (node) => !node.tag.startsWith("#") && !index.excludedBackendNodeIds.has(node.backendNodeId),
    ),
    index,
    ...(context.coordinates &&
    context.projection?.status === "available" &&
    context.targetProjection !== null
      ? {
          geometry: {
            projections: [
              context.projection.projection.geometry,
              ...(context.targetProjection ? [context.targetProjection] : []),
            ],
            coordinates: context.coordinates,
            pageScale: context.pageScale,
          },
        }
      : {}),
    documentElementBackendNodeId: nodes.find(
      (node) =>
        node.nodeType === 1 &&
        node.parentBackendNodeId !== null &&
        index.nodes.get(node.parentBackendNodeId)?.nodeType === 9,
    )?.backendNodeId,
  };
}

export interface NormalizedFrameDocument extends NormalizedDocument {
  frame: CdpFrame;
}

/** One target's snapshot. Source ownership is checked before interpreting any
 * coordinates. Snapshot and live quad coordinates are deliberately not conflated. */
export async function normalizeSnapshot(
  snapshot: SnapshotReply,
  target: CdpTarget,
  frames: readonly CdpFrame[],
  geometry: GeometryContext,
  issues: CaptureIssue[],
  signal?: AbortSignal,
  rootFrameId?: string,
): Promise<NormalizedFrameDocument[]> {
  const strings = snapshot.strings ?? [];
  const raw = snapshot.documents ?? [];
  const ownerIds = new Set<number>();
  for (const document of raw) {
    for (const index of document.nodes?.contentDocumentIndex?.index ?? []) {
      const id = document.nodes?.backendNodeId?.[index];
      if (id !== undefined) ownerIds.add(id);
    }
  }
  geometry.registerSnapshotOwners(target, ownerIds);
  const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
  const sources = new Map<string, SnapshotDocument>();
  for (const doc of raw) {
    const id = snapshotFrameId(doc, strings);
    if (!id || !frameById.has(id) || sources.has(id)) {
      issues.push({
        target,
        frameId: id,
        stage: "ownership",
        reason: "frame-ownership-unresolved",
      });
      continue;
    }
    sources.set(id, doc);
  }
  let metrics: LayoutMetrics = {};
  try {
    metrics = await geometry.layoutMetrics(target);
  } catch (error) {
    if (isCaptureAbort(error)) throw error;
  }
  const viewport: Viewport = {
    width: metrics.cssLayoutViewport?.clientWidth ?? 0,
    height: metrics.cssLayoutViewport?.clientHeight ?? 0,
  };
  const layoutUnitsPerCssPixel = snapshotLayoutScale(metrics);
  const viewportAvailable = [viewport.width, viewport.height].every(
    (size) => Number.isFinite(size) && size > 0,
  );

  const children = new Map<string, CdpFrame[]>();
  const pending: CdpFrame[] = [];
  for (const frame of frames) {
    if (!frame.parentFrameId || !frameById.has(frame.parentFrameId)) pending.push(frame);
    else {
      const siblings = children.get(frame.parentFrameId);
      if (siblings) siblings.push(frame);
      else children.set(frame.parentFrameId, [frame]);
    }
  }
  const projections = new Map<string, FrameProjectionState | null>();
  const result: NormalizedFrameDocument[] = [];
  let targetProjection: GeometryProjection | null = null;
  const targetRoot = rootFrameId ? frameById.get(rootFrameId) : undefined;
  if (target.sessionId && targetRoot) {
    try {
      const known = await geometry.frame(targetRoot.frameId);
      if (known && cdpTargetKey(known.target) === cdpTargetKey(target))
        targetProjection = await geometry.targetProjection(targetRoot.frameId);
    } catch (error) {
      if (isCaptureAbort(error)) throw error;
    }
  }
  const checkpoint = createCaptureCheckpoint(signal);
  const visited = new Set<string>();
  const remaining = frames[Symbol.iterator]();
  for (let cursor = 0; visited.size < frames.length; cursor++) {
    if (cursor >= pending.length) {
      let next = remaining.next();
      while (!next.done && visited.has(next.value.frameId)) next = remaining.next();
      if (next.done) break;
      pending.push(next.value);
    }
    if (cursor % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    const frame = pending[cursor];
    if (visited.has(frame.frameId)) continue;
    visited.add(frame.frameId);
    for (const child of children.get(frame.frameId) ?? []) pending.push(child);
    const doc = sources.get(frame.frameId);
    if (!doc) continue;
    const source = { target, frameId: frame.frameId };
    const coordinates = snapshotCoordinates(
      doc,
      layoutUnitsPerCssPixel,
      frame.frameId === rootFrameId
        ? { x: metrics.cssLayoutViewport?.pageX, y: metrics.cssLayoutViewport?.pageY }
        : undefined,
    );
    let state: FrameProjectionState | null =
      frame.frameId === rootFrameId
        ? viewportAvailable && coordinates
          ? {
              status: "available",
              projection: {
                source,
                geometry: { sourceClips: [], edges: [], topViewport: viewport },
              },
            }
          : { status: "unavailable", source, reason: "snapshot-coordinates-unavailable" }
        : (projections.get(frame.frameId) ?? null);
    if (!state && frame.frameId !== rootFrameId)
      issues.push({
        target,
        frameId: frame.frameId,
        stage: "ownership",
        reason: "frame-ownership-unresolved",
      });
    if (!coordinates && (!state || state.status === "available"))
      state = { status: "unavailable", source, reason: "snapshot-coordinates-unavailable" };
    projections.set(frame.frameId, state);
    const projection = state?.status === "available" ? state.projection : null;
    if (!projection || (target.sessionId && !targetProjection))
      issues.push({
        target,
        frameId: frame.frameId,
        stage: "geometry",
        reason: "geometry-unavailable",
        ...(state && state.status !== "available" ? { projectionIssue: state } : {}),
      });

    // Only direct siblings share this pool. Keep normalization in its existing
    // breadth-first order, independent of owner read completion order.
    const siblings = (children.get(frame.frameId) ?? []).filter((child) =>
      sources.has(child.frameId),
    );
    const edge = projection?.geometry.edges[0];
    const clips = edge
      ? [edge.destinationQuad, ...(edge.destinationClips ?? [])]
      : (projection?.geometry.sourceClips ?? []);
    let next = 0;
    let failure: unknown;
    await Promise.all(
      Array.from({ length: Math.min(4, siblings.length) }, async () => {
        while (next < siblings.length && !signal?.aborted && !failure) {
          const child = siblings[next++];
          const childSource = { target, frameId: child.frameId };
          if (!projection) {
            projections.set(
              child.frameId,
              state && state.status !== "available"
                ? {
                    status: "blocked",
                    source: childSource,
                    cause: state.status === "blocked" ? state.cause : state,
                  }
                : null,
            );
            continue;
          }
          if (child.ownerBackendNodeId === undefined) {
            projections.set(child.frameId, null);
            continue;
          }
          if (!snapshotCoordinates(sources.get(child.frameId)!, layoutUnitsPerCssPixel)) {
            projections.set(child.frameId, {
              status: "unavailable",
              source: childSource,
              reason: "snapshot-coordinates-unavailable",
            });
            continue;
          }
          try {
            projections.set(
              child.frameId,
              await geometry.snapshotProjection(
                childSource,
                child.ownerBackendNodeId,
                clips,
                viewport,
              ),
            );
          } catch (error) {
            failure ??= error;
          }
        }
      }),
    );
    // Join active reads and their cleanup before returning cancellation.
    if (failure) throw failure;
    throwCaptureAborted(signal);
    const normalized = await normalizeDocument(
      doc,
      strings,
      {
        frameId: frame.frameId,
        ownerFrameBackendNodeId: frame.ownerBackendNodeId ?? null,
        projection: state,
        pageScale: metrics.cssVisualViewport?.scale ?? metrics.visualViewport?.scale,
        target,
        ...(target.sessionId ? { targetProjection } : {}),
        coordinates,
      },
      signal,
    );
    result.push({ ...normalized, frame });
  }
  return result;
}
