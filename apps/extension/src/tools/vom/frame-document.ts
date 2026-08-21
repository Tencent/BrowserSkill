import {
  type CdpFrame,
  type CdpFrameGraph,
  type CdpTarget,
  cdpTargetKey,
} from "@/browser-driver/frame-graph";
import type { CapturedNode, CapturedViewModel } from "./capture";

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
  captured: CapturedViewModel,
): CdpFrame[] {
  const frames = new Map<string, CdpFrame>();
  for (const frame of graph?.frames ?? []) frames.set(frame.frameId, frame);
  for (const batch of batches) {
    if (!frames.has(batch.frame.frameId)) frames.set(batch.frame.frameId, batch.frame);
  }
  for (const frameId of captured.frameNodes?.keys() ?? []) {
    if (!frames.has(frameId))
      frames.set(frameId, { frameId, target: { tabId: batches[0]?.frame.target.tabId ?? 0 } });
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

export function buildFrameDocuments<T extends FrameOwnedAxNode>(
  graph: CdpFrameGraph | null,
  batches: FrameAxBatch<T>[],
  captured: CapturedViewModel,
): FrameDocument<T>[] {
  const frames = frameList(graph, batches, captured);
  const frameById = new Map(frames.map((frame) => [frame.frameId, frame]));
  const rootFrameId = graph?.rootFrameId ?? captured.rootFrameId ?? frames[0]?.frameId;
  const domNodesForFrame = (frameId: string): CapturedNode[] =>
    captured.frameNodes?.get(frameId) ?? (frameId === rootFrameId ? captured.nodes : []);
  const backendOwner = new Map<string, string>();
  for (const frame of frames) {
    for (const node of domNodesForFrame(frame.frameId)) {
      backendOwner.set(targetBackendKey(frame.target, node.backendNodeId), frame.frameId);
    }
  }

  const candidates = new Map<string, OwnedCandidate<T>>();
  for (const batch of batches) {
    const nodeById = new Map(batch.nodes.map((node) => [node.nodeId, node]));
    const ownershipByNodeId = new Map<string, Ownership>();
    const resolving = new Set<string>();
    const resolveOwnership = (node: T): Ownership => {
      const cached = ownershipByNodeId.get(node.nodeId);
      if (cached) return cached;
      if (node.frameId && frameById.has(node.frameId)) {
        const ownership = { frameId: node.frameId, strength: 4 };
        ownershipByNodeId.set(node.nodeId, ownership);
        return ownership;
      }
      if (typeof node.backendDOMNodeId === "number") {
        const frameId = backendOwner.get(
          targetBackendKey(batch.frame.target, node.backendDOMNodeId),
        );
        if (frameId) {
          const ownership = { frameId, strength: 3 };
          ownershipByNodeId.set(node.nodeId, ownership);
          return ownership;
        }
      }
      if (node.parentId && !resolving.has(node.nodeId)) {
        const parent = nodeById.get(node.parentId);
        if (parent) {
          resolving.add(node.nodeId);
          const inherited = resolveOwnership(parent);
          resolving.delete(node.nodeId);
          const ownership = {
            frameId: inherited.frameId,
            strength: Math.min(2, inherited.strength),
          };
          ownershipByNodeId.set(node.nodeId, ownership);
          return ownership;
        }
      }
      const ownership = { frameId: batch.frame.frameId, strength: 1 };
      ownershipByNodeId.set(node.nodeId, ownership);
      return ownership;
    };

    for (const node of batch.nodes) {
      const ownership = resolveOwnership(node);
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
