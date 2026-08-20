import {
  applyVomInteractionRecovery,
  isVomReferenceNode,
  type VomNode,
  type VomScene,
} from "@browser-skill/vom";
import type { ResolvedSemanticGraph, ResolvedSemanticNode, SemanticNodeId } from "./types";

const TRANSPARENT_ROLES = new Set(["", "generic", "none", "presentation", "inlinetextbox"]);

function connectedFrameIds(graph: ResolvedSemanticGraph): Set<string> {
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
      if (!owner || owner.excluded) continue;
      connected.add(frame.frameId);
      queue.push(frame.frameId);
    }
  }
  return connected;
}

function semanticParentId(
  graph: ResolvedSemanticGraph,
  node: ResolvedSemanticNode,
): SemanticNodeId | undefined {
  let localParent = node.axParentId ?? node.domParentId;
  if (node.axParentId && node.domParentId && node.axParentId !== node.domParentId) {
    const axParent = graph.nodes.get(node.axParentId);
    const axParentRole = axParent?.vom.role?.toLowerCase() ?? "";
    const axParentIsRoot = axParentRole === "rootwebarea" || axParentRole === "webarea";
    const axParentIsStructural =
      !TRANSPARENT_ROLES.has(axParentRole) ||
      Boolean(
        axParent?.vom.name ||
          axParent?.vom.text ||
          (axParent ? hasMeaningfulRelations(axParent) : false),
      );
    localParent = !axParentIsRoot && axParentIsStructural ? node.axParentId : node.domParentId;
  }
  if (localParent) return localParent;
  if (node.frameId === graph.rootFrameId) return undefined;
  return graph.frames.get(node.frameId)?.ownerNodeId;
}

function isChildDocumentRoot(graph: ResolvedSemanticGraph, node: ResolvedSemanticNode): boolean {
  if (node.frameId === graph.rootFrameId) return false;
  if (semanticParentId(graph, node) !== graph.frames.get(node.frameId)?.ownerNodeId) return false;
  const role = node.vom.role?.toLowerCase() ?? "";
  return role === "rootwebarea" || role === "webarea";
}

function hasMeaningfulRelations(node: ResolvedSemanticNode): boolean {
  const attrs = node.vom.attrs ?? {};
  return ["aria-controls", "aria-labelledby", "aria-owns", "aria-describedby"].some((name) =>
    attrs[name]?.trim(),
  );
}

function shouldKeepNode(
  graph: ResolvedSemanticGraph,
  node: ResolvedSemanticNode,
  recovered: VomNode,
): boolean {
  if (node.excluded || isChildDocumentRoot(graph, node)) return false;
  if (node.ax?.ignored) return false;
  const role = recovered.role?.toLowerCase() ?? "";
  if (!TRANSPARENT_ROLES.has(role)) return true;
  return Boolean(
    recovered.name ||
      recovered.text ||
      recovered.value ||
      recovered.placeholder ||
      hasMeaningfulRelations(node) ||
      (recovered.rect && ["fixed", "sticky"].includes(recovered.position)),
  );
}

function redundantSourceNodes(
  graph: ResolvedSemanticGraph,
  nodes: ResolvedSemanticNode[],
): Set<SemanticNodeId> {
  const byKey = new Map<string, ResolvedSemanticNode[]>();
  for (const node of nodes) {
    const name = node.vom.name?.trim().toLowerCase() ?? "";
    if (!name || !isVomReferenceNode({ ...node.vom, id: 0, parentId: null, referenceable: true })) {
      continue;
    }
    const key = `${node.frameId}\u0000${semanticParentId(graph, node) ?? ""}\u0000${node.vom.role?.toLowerCase() ?? ""}\u0000${name}\u0000${node.vom.sensitive === true}`;
    const matches = byKey.get(key) ?? [];
    matches.push(node);
    byKey.set(key, matches);
  }
  const duplicates = new Set<SemanticNodeId>();
  for (const matches of byKey.values()) {
    const axOnly = matches.filter((node) => node.ax && !node.dom);
    const domOnly = matches.filter((node) => node.dom && !node.ax);
    if (matches.length === 2 && axOnly.length === 1 && domOnly.length === 1) {
      duplicates.add(domOnly[0].id);
    }
  }
  return duplicates;
}

function nearestKeptParent(
  graph: ResolvedSemanticGraph,
  nodeId: SemanticNodeId,
  kept: ReadonlySet<SemanticNodeId>,
  memo: Map<SemanticNodeId, SemanticNodeId | undefined>,
): SemanticNodeId | undefined {
  if (memo.has(nodeId)) return memo.get(nodeId);
  let current = semanticParentId(graph, graph.nodes.get(nodeId) as ResolvedSemanticNode);
  const seen = new Set<SemanticNodeId>();
  const path: SemanticNodeId[] = [];
  let result: SemanticNodeId | undefined;
  while (current && !seen.has(current)) {
    if (kept.has(current)) {
      result = current;
      break;
    }
    if (memo.has(current)) {
      result = memo.get(current);
      break;
    }
    seen.add(current);
    path.push(current);
    const parent = graph.nodes.get(current);
    current = parent ? semanticParentId(graph, parent) : undefined;
  }
  memo.set(nodeId, result);
  for (const id of path) memo.set(id, result);
  return result;
}

function domAncestors(
  graph: ResolvedSemanticGraph,
  node: ResolvedSemanticNode,
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

export function projectSemanticGraph(graph: ResolvedSemanticGraph): VomScene {
  const frameOwnerIds = new Set(
    [...graph.frames.values()].flatMap((frame) => frame.ownerNodeId ?? []),
  );
  const connectedFrames = connectedFrameIds(graph);
  const orderedNodes = [...graph.frames.values()]
    .filter((frame) => connectedFrames.has(frame.frameId))
    .sort((a, b) => a.order - b.order)
    .flatMap((frame) =>
      (graph.nodeIdsByFrame.get(frame.frameId) ?? [])
        .map((id) => graph.nodes.get(id))
        .filter((node): node is ResolvedSemanticNode => node !== undefined)
        .sort((a, b) => a.sourceOrder - b.sourceOrder),
    );

  const provisionalNumericId = new Map<SemanticNodeId, number>();
  orderedNodes.forEach((node, index) => provisionalNumericId.set(node.id, index + 1));
  const provisionalNodes: VomNode[] = orderedNodes.map((node) => ({
    ...node.vom,
    id: provisionalNumericId.get(node.id) as number,
    parentId: (() => {
      const parent = semanticParentId(graph, node);
      return parent ? (provisionalNumericId.get(parent) ?? null) : null;
    })(),
    ...(node.backendNodeId !== undefined ? { backendNodeId: node.backendNodeId } : {}),
    frameId: node.frameId,
    contextScopeId: graph.frames.get(node.frameId)?.contextScopeId ?? node.frameId,
    referenceable: node.referenceable,
  }));
  const recoveredById = new Map(
    applyVomInteractionRecovery(provisionalNodes).map((node) => [node.id, node]),
  );
  const duplicates = redundantSourceNodes(graph, orderedNodes);
  const kept = new Set<SemanticNodeId>();
  for (const node of orderedNodes) {
    if (duplicates.has(node.id)) continue;
    const id = provisionalNumericId.get(node.id) as number;
    const recovered = recoveredById.get(id) as VomNode;
    if ((!node.excluded && frameOwnerIds.has(node.id)) || shouldKeepNode(graph, node, recovered)) {
      kept.add(node.id);
    }
  }

  const numericId = new Map<SemanticNodeId, number>();
  let nextId = 1;
  for (const node of orderedNodes) {
    if (!kept.has(node.id)) continue;
    numericId.set(node.id, nextId);
    nextId += 1;
  }

  const nodes: VomNode[] = [];
  const keptParentMemo = new Map<SemanticNodeId, SemanticNodeId | undefined>();
  for (const node of orderedNodes) {
    const id = numericId.get(node.id);
    if (id === undefined) continue;
    const provisional = recoveredById.get(provisionalNumericId.get(node.id) as number) as VomNode;
    const parent = nearestKeptParent(graph, node.id, kept, keptParentMemo);
    const domParent = node.domParentId ? numericId.get(node.domParentId) : undefined;
    nodes.push({
      ...provisional,
      id,
      parentId: parent ? (numericId.get(parent) ?? null) : null,
      ...(node.backendNodeId !== undefined ? { backendNodeId: node.backendNodeId } : {}),
      ...(node.dom
        ? {
            domParentId: node.domParentId === undefined ? null : (domParent ?? null),
            domAncestorIds: domAncestors(graph, node, numericId),
          }
        : {}),
    });
  }

  return {
    viewport: graph.viewport,
    nodes,
    rootFrameId: graph.rootFrameId,
  };
}
