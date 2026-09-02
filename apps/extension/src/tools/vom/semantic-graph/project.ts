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
  const seen = new Set<SemanticNodeId>();
  let current = node.domParentId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const id = numericId.get(current);
    if (id !== undefined) ancestors.push(id);
    current = graph.nodes.get(current)?.domParentId;
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
