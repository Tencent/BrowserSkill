import {
  type CdpFrame,
  type CdpFrameGraph,
  type CdpTarget,
  cdpTargetKey,
} from "@/browser-driver/frame-graph";
import type { CapturedNode } from "./facts";
import { captureCheckpoint } from "./facts";

export interface FrameOwnedAxNode {
  nodeId: string;
  frameId?: string;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface FrameAxBatch<T extends FrameOwnedAxNode> {
  frame: CdpFrame;
  nodes: T[];
}

export interface FrameDocument<T extends FrameOwnedAxNode> extends CdpFrame {
  contextScopeId: string;
  axNodes: T[];
  domNodes: CapturedNode[];
  excludedBackendNodeIds?: ReadonlySet<number>;
}

/** Explicit snapshot document data used to join DOM and AX ownership. */
export interface FrameDomInput {
  nodes: CapturedNode[];
  rootFrameId?: string;
  frameNodes?: ReadonlyMap<string, CapturedNode[]>;
  frameOwnerBackendNodeIds?: ReadonlyMap<string, number>;
  frameParentIds?: ReadonlyMap<string, string>;
}

interface Ownership {
  frameId: string;
  strength: number;
}

interface OwnedCandidate<T> {
  node: T;
  target: CdpTarget;
  ownership: Ownership;
}

function targetNodeKey(target: CdpTarget, nodeId: string): string {
  return `${cdpTargetKey(target)}:${nodeId}`;
}

function targetBackendKey(target: CdpTarget, backendNodeId: number): string {
  return `${cdpTargetKey(target)}:${backendNodeId}`;
}

function frameList<T extends FrameOwnedAxNode>(
  graph: CdpFrameGraph | null,
  batches: FrameAxBatch<T>[],
  captured: FrameDomInput,
): CdpFrame[] {
  const frames = new Map<string, CdpFrame>();
  for (const frame of graph?.frames ?? []) frames.set(frame.frameId, frame);
  for (const batch of batches) {
    if (!frames.has(batch.frame.frameId)) frames.set(batch.frame.frameId, batch.frame);
  }
  return [...frames.values()].map((frame) => {
    const ownerBackendNodeId =
      frame.ownerBackendNodeId ?? captured.frameOwnerBackendNodeIds?.get(frame.frameId);
    const parentFrameId = frame.parentFrameId ?? captured.frameParentIds?.get(frame.frameId);
    return {
      ...frame,
      ...(ownerBackendNodeId !== undefined ? { ownerBackendNodeId } : {}),
      ...(parentFrameId ? { parentFrameId } : {}),
    };
  });
}

export async function buildFrameDocuments<T extends FrameOwnedAxNode>(
  graph: CdpFrameGraph | null,
  batches: FrameAxBatch<T>[],
  captured: FrameDomInput,
  signal?: AbortSignal,
  unresolved?: (frame: CdpFrame) => void,
): Promise<FrameDocument<T>[]> {
  let work = 0;
  const frames = frameList(graph, batches, captured);
  const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
  const rootFrameId = graph?.rootFrameId ?? captured.rootFrameId ?? frames[0]?.frameId;
  const domNodesForFrame = (frameId: string): CapturedNode[] =>
    captured.frameNodes?.get(frameId) ?? (frameId === rootFrameId ? captured.nodes : []);
  const backendOwner = new Map<string, string>();
  for (const frame of frames) {
    for (const node of domNodesForFrame(frame.frameId)) {
      if (work++ % 256 === 0) await captureCheckpoint(signal);
      backendOwner.set(targetBackendKey(frame.target, node.backendNodeId), frame.frameId);
    }
  }

  const candidates = new Map<string, OwnedCandidate<T>>();
  for (const batch of batches) {
    const nodeById = new Map<string, T>();
    for (const node of batch.nodes) {
      if (work++ % 256 === 0) await captureCheckpoint(signal);
      nodeById.set(node.nodeId, node);
    }
    let reported = false;
    const ownershipByNodeId = new Map<string, Ownership>();
    const resolveOwnership = async (node: T): Promise<Ownership> => {
      const path: T[] = [];
      const visiting = new Set<string>();
      let current: T | undefined = node;
      let ownership: Ownership = { frameId: batch.frame.frameId, strength: 1 };
      while (current) {
        if (work++ % 256 === 0) await captureCheckpoint(signal);
        const cached = ownershipByNodeId.get(current.nodeId);
        if (cached) {
          ownership = cached;
          break;
        }
        if (visiting.has(current.nodeId)) break;
        visiting.add(current.nodeId);
        if (current.frameId) {
          const frame = frameById.get(current.frameId);
          // An explicit contradiction must not fall through to a guessed owner.
          if (!frame || cdpTargetKey(frame.target) !== cdpTargetKey(batch.frame.target)) {
            if (!reported) {
              unresolved?.(batch.frame);
              reported = true;
            }
            ownership = { frameId: "", strength: 0 };
            break;
          }
          ownership = { frameId: frame.frameId, strength: 4 };
          ownershipByNodeId.set(current.nodeId, ownership);
          break;
        }
        const frameId =
          typeof current.backendDOMNodeId === "number"
            ? backendOwner.get(targetBackendKey(batch.frame.target, current.backendDOMNodeId))
            : undefined;
        if (frameId) {
          ownership = { frameId, strength: 3 };
          ownershipByNodeId.set(current.nodeId, ownership);
          break;
        }
        path.push(current);
        current = current.parentId ? nodeById.get(current.parentId) : undefined;
      }
      for (let i = path.length - 1; i >= 0; i--) {
        if (work++ % 256 === 0) await captureCheckpoint(signal);
        ownership = { frameId: ownership.frameId, strength: Math.min(2, ownership.strength) };
        ownershipByNodeId.set(path[i].nodeId, ownership);
      }
      if (!ownershipByNodeId.has(node.nodeId)) ownershipByNodeId.set(node.nodeId, ownership);
      return ownership;
    };

    for (const node of batch.nodes) {
      if (work++ % 256 === 0) await captureCheckpoint(signal);
      const ownership = await resolveOwnership(node);
      if (!ownership.frameId) continue;
      const key = targetNodeKey(batch.frame.target, node.nodeId);
      const existing = candidates.get(key);
      if (!existing || ownership.strength > existing.ownership.strength) {
        candidates.set(key, { node, target: batch.frame.target, ownership });
      }
    }
  }

  const ownershipByTargetNode = new Map(
    [...candidates].map(([key, candidate]) => [key, candidate.ownership.frameId]),
  );
  const axNodesByFrame = new Map<string, T[]>();
  for (const candidate of candidates.values()) {
    if (work++ % 256 === 0) await captureCheckpoint(signal);
    const { node, target, ownership } = candidate;
    const parentFrameId = node.parentId
      ? ownershipByTargetNode.get(targetNodeKey(target, node.parentId))
      : undefined;
    const childIds = node.childIds?.filter(
      (childId) => ownershipByTargetNode.get(targetNodeKey(target, childId)) === ownership.frameId,
    );
    const ownedNode = {
      ...node,
      frameId: ownership.frameId,
      ...(parentFrameId === ownership.frameId
        ? { parentId: node.parentId }
        : { parentId: undefined }),
      ...(childIds ? { childIds } : {}),
    };
    const nodes = axNodesByFrame.get(ownership.frameId) ?? [];
    nodes.push(ownedNode);
    axNodesByFrame.set(ownership.frameId, nodes);
  }

  return frames.map((frame) => ({
    ...frame,
    contextScopeId: frame.frameId,
    axNodes: axNodesByFrame.get(frame.frameId) ?? [],
    domNodes: domNodesForFrame(frame.frameId),
  }));
}
