import type { CdpFrame, CdpFrameGraph } from "@/browser-driver/frame-graph";
import { resolveFrameProjection } from "../frame-geometry";
import { type GeometryProjection, projectRectToViewport } from "../geometry";
import { type CdpRunner, cdpRunnerForTarget, sendToCdpTarget } from "../shared";
import { type CapturedNode, type CapturedViewModel, captureViewModel } from "./capture";
import {
  buildFrameDocuments,
  type FrameAxBatch,
  type FrameDocument,
  type FrameOwnedAxNode,
} from "./frame-document";

export type FrameAxNode = FrameOwnedAxNode;
export type CapturedFrameDocument<T extends FrameAxNode> = FrameDocument<T>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("observation aborted", "AbortError");
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

async function discoverFrameGraph(cdp: CdpRunner, tabId: number): Promise<CdpFrameGraph | null> {
  if (!cdp.getFrameGraph) return null;
  try {
    return await cdp.getFrameGraph(tabId);
  } catch (err) {
    console.debug("[bsk observation] frame graph capture failed", err);
    return null;
  }
}

function transformFrameNodes(
  nodes: CapturedNode[],
  projection: GeometryProjection | null,
): CapturedNode[] {
  return nodes.map((node) => ({
    ...node,
    rect: projection
      ? (() => {
          const bounds = projectRectToViewport(node.rect, projection);
          return bounds ? { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height } : null;
        })()
      : null,
  }));
}

async function captureMissingFrameDocuments(
  cdp: CdpRunner,
  tabId: number,
  graph: CdpFrameGraph,
  captured: CapturedViewModel,
  signal?: AbortSignal,
): Promise<void> {
  if (!captured.frameNodes) captured.frameNodes = new Map();
  if (!captured.frameOwnerBackendNodeIds) captured.frameOwnerBackendNodeIds = new Map();
  if (!captured.frameParentIds) captured.frameParentIds = new Map();

  for (const frame of graph.frames) {
    if (!frame.target.sessionId || captured.frameNodes.has(frame.frameId)) continue;
    try {
      const child = await captureViewModel(cdpRunnerForTarget(cdp, frame.target), tabId, {
        signal,
      });
      let projection: GeometryProjection | null = null;
      try {
        projection = await resolveFrameProjection(cdp, graph, frame.frameId);
      } catch (err) {
        if (isAbortError(err)) throw err;
        console.debug("[bsk observation] child frame geometry projection failed", {
          frameId: frame.frameId,
          err,
        });
      }
      const rootFrameId = child.rootFrameId ?? frame.frameId;
      const childFrames = child.frameNodes ?? new Map<string, CapturedNode[]>();
      if (!childFrames.has(rootFrameId)) childFrames.set(rootFrameId, child.nodes);
      if (rootFrameId !== frame.frameId && !childFrames.has(frame.frameId)) {
        childFrames.set(
          frame.frameId,
          child.nodes.map((node) => ({ ...node, frameId: frame.frameId })),
        );
      }
      for (const [childFrameId, nodes] of childFrames) {
        captured.frameNodes.set(childFrameId, transformFrameNodes(nodes, projection));
      }
      if (frame.ownerBackendNodeId !== undefined) {
        captured.iframeNodes.set(
          frame.ownerBackendNodeId,
          captured.frameNodes.get(frame.frameId) ?? [],
        );
        captured.frameOwnerBackendNodeIds.set(frame.frameId, frame.ownerBackendNodeId);
      }
      if (frame.parentFrameId) captured.frameParentIds.set(frame.frameId, frame.parentFrameId);
      for (const [childFrameId, ownerBackendNodeId] of child.frameOwnerBackendNodeIds ?? []) {
        captured.frameOwnerBackendNodeIds.set(childFrameId, ownerBackendNodeId);
      }
      for (const [childFrameId, parentFrameId] of child.frameParentIds ?? []) {
        captured.frameParentIds.set(childFrameId, parentFrameId);
      }
    } catch (err) {
      if (isAbortError(err)) throw err;
      console.debug("[bsk observation] child frame DOM capture failed", {
        frameId: frame.frameId,
        err,
      });
    }
  }
}

async function captureAxTrees<T extends FrameAxNode>(
  cdp: CdpRunner,
  tabId: number,
  discoveredFrames: CdpFrame[],
  captured: CapturedViewModel,
  signal?: AbortSignal,
): Promise<FrameAxBatch<T>[]> {
  let frames = [...discoveredFrames];
  const capturedFrameIds = [...(captured.frameNodes?.keys() ?? [])];
  if (frames.length === 0) {
    const rootFrameId = captured.rootFrameId ?? capturedFrameIds[0] ?? "root";
    frames = [{ frameId: rootFrameId, target: { tabId } }];
  }
  for (const frameId of capturedFrameIds) {
    if (!frames.some((frame) => frame.frameId === frameId)) {
      frames.push({ frameId, target: { tabId } });
    }
  }

  let firstFailure: unknown;
  const trees = await Promise.all(
    frames.map(async (frame): Promise<FrameAxBatch<T>> => {
      try {
        throwIfAborted(signal);
        await sendToCdpTarget(cdp, frame.target, "Accessibility.enable", {});
        const result = await sendToCdpTarget<{ nodes?: T[] }>(
          cdp,
          frame.target,
          "Accessibility.getFullAXTree",
          frame.frameId === "root" ? {} : { frameId: frame.frameId },
        );
        throwIfAborted(signal);
        return {
          frame,
          nodes: result.nodes ?? [],
        };
      } catch (err) {
        if (isAbortError(err)) throw err;
        firstFailure ??= err;
        console.debug("[bsk observation] frame AX capture failed", {
          frameId: frame.frameId,
          err,
        });
        return { frame, nodes: [] };
      }
    }),
  );
  const capturedNodeCount = [...captured.iframeNodes.values()].reduce(
    (count, nodes) => count + nodes.length,
    captured.nodes.length,
  );
  if (firstFailure && capturedNodeCount === 0 && trees.every((tree) => tree.nodes.length === 0)) {
    throw firstFailure;
  }
  return trees;
}

export async function captureFrameData<T extends FrameAxNode>(
  cdp: CdpRunner,
  tabId: number,
  captured: CapturedViewModel,
  signal?: AbortSignal,
): Promise<CapturedFrameDocument<T>[]> {
  const graph = await discoverFrameGraph(cdp, tabId);
  const frames = graph?.frames ?? [];
  if (graph) await captureMissingFrameDocuments(cdp, tabId, graph, captured, signal);
  throwIfAborted(signal);
  const batches = await captureAxTrees<T>(cdp, tabId, frames, captured, signal);
  return buildFrameDocuments(graph, batches, captured);
}
