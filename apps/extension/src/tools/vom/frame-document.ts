import type { CapturedNode, CapturedViewModel } from "./capture";

export interface FrameOwnedAxNode {
  nodeId: string;
  frameId?: string;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface FrameAxBatch<T extends FrameOwnedAxNode> {
  frameId: string;
  nodes: T[];
}

export interface FrameDocument<T extends FrameOwnedAxNode> {
  frameId: string;
  parentFrameId?: string;
  ownerBackendNodeId?: number;
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
  ownership: Ownership;
}

function frameIds<T extends FrameOwnedAxNode>(
  batches: FrameAxBatch<T>[],
  captured: CapturedViewModel,
): string[] {
  const ids = new Set<string>();
  if (captured.rootFrameId) ids.add(captured.rootFrameId);
  for (const frameId of captured.frameNodes?.keys() ?? []) ids.add(frameId);
  for (const batch of batches) ids.add(batch.frameId);
  return [...ids];
}

export function buildFrameDocuments<T extends FrameOwnedAxNode>(
  batches: FrameAxBatch<T>[],
  captured: CapturedViewModel,
): FrameDocument<T>[] {
  const frames = frameIds(batches, captured);
  const knownFrames = new Set(frames);
  const backendOwner = new Map<number, string>();
  for (const frameId of frames) {
    for (const node of captured.frameNodes?.get(frameId) ?? []) {
      backendOwner.set(node.backendNodeId, frameId);
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
      if (node.frameId && knownFrames.has(node.frameId)) {
        const ownership = { frameId: node.frameId, strength: 4 };
        ownershipByNodeId.set(node.nodeId, ownership);
        return ownership;
      }
      if (typeof node.backendDOMNodeId === "number") {
        const owner = backendOwner.get(node.backendDOMNodeId);
        if (owner) {
          const ownership = { frameId: owner, strength: 3 };
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
      const ownership = { frameId: batch.frameId, strength: 1 };
      ownershipByNodeId.set(node.nodeId, ownership);
      return ownership;
    };

    for (const node of batch.nodes) {
      const ownership = resolveOwnership(node);
      const existing = candidates.get(node.nodeId);
      if (!existing || ownership.strength > existing.ownership.strength) {
        candidates.set(node.nodeId, { node, ownership });
      }
    }
  }

  const ownershipByNodeId = new Map(
    [...candidates].map(([nodeId, candidate]) => [nodeId, candidate.ownership.frameId]),
  );
  const axNodesByFrame = new Map<string, T[]>();
  for (const { node, ownership } of candidates.values()) {
    const parentFrameId = node.parentId ? ownershipByNodeId.get(node.parentId) : undefined;
    const childIds = node.childIds?.filter(
      (childId) => ownershipByNodeId.get(childId) === ownership.frameId,
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

  return frames.map((frameId) => ({
    frameId,
    ...(captured.frameParentIds?.get(frameId)
      ? { parentFrameId: captured.frameParentIds.get(frameId) }
      : {}),
    ...(captured.frameOwnerBackendNodeIds?.get(frameId) !== undefined
      ? { ownerBackendNodeId: captured.frameOwnerBackendNodeIds.get(frameId) }
      : {}),
    contextScopeId: frameId,
    axNodes: axNodesByFrame.get(frameId) ?? [],
    domNodes: captured.frameNodes?.get(frameId) ?? [],
  }));
}
