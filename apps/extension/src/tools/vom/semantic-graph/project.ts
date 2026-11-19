import type { VomNode, VomScene } from "@browser-skill/vom";
import type { SemanticNodeId, StructuredSemanticGraph, StructuredSemanticNode } from "./types";

function retained(node: StructuredSemanticNode): boolean {
  return node.structure.kind === "keep" || node.structure.kind === "inferred-group";
}

function connectedFrameIds(graph: StructuredSemanticGraph): Set<string> {
  const connected = new Set<string>([graph.rootFrameId]);
  const childrenByParent = new Map<string, string[]>();
  for (const frame of graph.frames.values()) {
    if (!frame.parentFrameId) continue;
    const children = childrenByParent.get(frame.parentFrameId) ?? [];
    children.push(frame.frameId);
    childrenByParent.set(frame.parentFrameId, children);
  }
  const queue = [graph.rootFrameId];
  for (let index = 0; index < queue.length; index += 1) {
    for (const frameId of childrenByParent.get(queue[index]) ?? []) {
      if (connected.has(frameId)) continue;
      const frame = graph.frames.get(frameId);
      if (!frame?.ownerNodeId) continue;
      const owner = graph.nodes.get(frame.ownerNodeId);
      if (!owner || !retained(owner)) continue;
      connected.add(frame.frameId);
      queue.push(frame.frameId);
    }
  }
  return connected;
}

function domAncestors(
  graph: StructuredSemanticGraph,
  node: StructuredSemanticNode,
  numericId: ReadonlyMap<SemanticNodeId, number>,
): number[] {
  const ancestors: number[] = [];
  let seen: Set<SemanticNodeId> | undefined;
  let current = node.domParentId;
  let steps = 0;
  while (current) {
    if (steps >= 64) {
      if (!seen) {
        seen = new Set<SemanticNodeId>();
        let cursor = node.domParentId;
        for (let i = 0; i < steps && cursor; i++) {
          seen.add(cursor);
          cursor = graph.nodes.get(cursor)?.domParentId;
        }
      }
      if (seen.has(current)) break;
      seen.add(current);
    }
    const id = numericId.get(current);
    if (id !== undefined) ancestors.push(id);
    current = graph.nodes.get(current)?.domParentId;
    steps += 1;
  }
  return ancestors;
}

export function projectSemanticGraph(graph: StructuredSemanticGraph): VomScene {
  const connectedFrames = connectedFrameIds(graph);
  const orderedNodes = [...graph.frames.values()]
    .filter((frame) => connectedFrames.has(frame.frameId))
    .sort((a, b) => a.order - b.order)
    .flatMap((frame) =>
      (graph.nodeIdsByFrame.get(frame.frameId) ?? [])
        .map((id) => graph.nodes.get(id))
        .filter((node): node is StructuredSemanticNode => node !== undefined && retained(node))
        .sort((a, b) => a.sourceOrder - b.sourceOrder),
    );

  const numericId = new Map<SemanticNodeId, number>();
  orderedNodes.forEach((node, index) => numericId.set(node.id, index + 1));
  // Flattening presentation-only wrappers must not erase DOM containment.
  // These IDs are internal ancestry facts; the wrappers stay out of the VOM.
  for (const id of graph.nodes.keys()) {
    if (!numericId.has(id)) numericId.set(id, numericId.size + 1);
  }
  const nodes: VomNode[] = orderedNodes.map((node) => ({
    ...node.vom,
    id: numericId.get(node.id) as number,
    parentId: node.semanticParentId ? (numericId.get(node.semanticParentId) ?? null) : null,
    ...(node.backendNodeId !== undefined ? { backendNodeId: node.backendNodeId } : {}),
    frameId: node.frameId,
    contextScopeId: graph.frames.get(node.frameId)?.contextScopeId ?? node.frameId,
    referenceable: node.referenceable,
    ...(node.dom
      ? {
          domParentId:
            node.domParentId === undefined ? null : (numericId.get(node.domParentId) ?? null),
          domAncestorIds: domAncestors(graph, node, numericId),
        }
      : {}),
  }));

  return {
    viewport: graph.viewport,
    nodes,
    rootFrameId: graph.rootFrameId,
  };
}
