import {
  applyVomInteractionRecovery,
  isVomReferenceNode,
  isVomStructuralRole,
  type VomNode,
} from "@browser-skill/vom";
import type {
  ResolvedSemanticGraph,
  ResolvedSemanticNode,
  SemanticNodeId,
  StructureDecision,
  StructuredSemanticGraph,
  StructuredSemanticNode,
} from "./types";

const TRANSPARENT_ROLES = new Set(["", "generic", "none", "presentation", "inlinetextbox"]);
const ROOT_ROLES = new Set(["rootwebarea", "webarea"]);
const CONTENT_BOUNDARY_ROLES = new Set([
  "article",
  "dialog",
  "document",
  "feed",
  "form",
  "grid",
  "heading",
  "iframe",
  "list",
  "main",
  "navigation",
  "paragraph",
  "region",
  "section",
  "table",
  "tree",
]);

function hasMeaningfulRelations(node: ResolvedSemanticNode): boolean {
  const attrs = node.vom.attrs ?? {};
  return ["aria-controls", "aria-labelledby", "aria-owns", "aria-describedby"].some((name) =>
    attrs[name]?.trim(),
  );
}

function explicitStructural(node: ResolvedSemanticNode): boolean {
  return (
    isVomStructuralRole(node.vom.role) &&
    node.roleSource !== "none" &&
    node.roleSource !== "ax-ignored"
  );
}

function hasUsableAxSemantics(node: ResolvedSemanticNode): boolean {
  return node.ax !== undefined && node.ax.ignored !== true;
}

function isRenderedDomFallback(node: ResolvedSemanticNode): boolean {
  if (!node.dom) return false;
  const attrs = node.dom.attrs;
  if (
    Object.prototype.hasOwnProperty.call(attrs, "hidden") ||
    Object.prototype.hasOwnProperty.call(attrs, "inert") ||
    (attrs["aria-hidden"] ?? "").toLowerCase() === "true"
  ) {
    return false;
  }
  return node.dom.rendered ?? (node.dom.localRect != null || node.dom.rect != null);
}

function initialParentId(
  graph: ResolvedSemanticGraph,
  node: ResolvedSemanticNode,
): SemanticNodeId | undefined {
  let parentId = node.axParentId ?? node.domParentId;
  if (node.axParentId && node.domParentId && node.axParentId !== node.domParentId) {
    const axParent = graph.nodes.get(node.axParentId);
    const axRole = axParent?.vom.role?.toLowerCase() ?? "";
    const meaningfulAxParent =
      axParent !== undefined &&
      !ROOT_ROLES.has(axRole) &&
      (explicitStructural(axParent) ||
        !TRANSPARENT_ROLES.has(axRole) ||
        Boolean(axParent.vom.name || axParent.vom.text || hasMeaningfulRelations(axParent)));
    parentId = meaningfulAxParent ? node.axParentId : node.domParentId;
  }
  if (parentId) return parentId;
  if (node.frameId === graph.rootFrameId) return undefined;
  return graph.frames.get(node.frameId)?.ownerNodeId;
}

function orderedNodes(graph: ResolvedSemanticGraph): ResolvedSemanticNode[] {
  return [...graph.frames.values()]
    .sort((a, b) => a.order - b.order)
    .flatMap((frame) =>
      (graph.nodeIdsByFrame.get(frame.frameId) ?? [])
        .map((id) => graph.nodes.get(id))
        .filter((node): node is ResolvedSemanticNode => node !== undefined)
        .sort((a, b) => a.sourceOrder - b.sourceOrder),
    );
}

function recoveredNodes(
  graph: ResolvedSemanticGraph,
  nodes: ResolvedSemanticNode[],
): Map<SemanticNodeId, VomNode> {
  const numericId = new Map(nodes.map((node, index) => [node.id, index + 1]));
  const semanticId = new Map([...numericId].map(([id, numeric]) => [numeric, id]));
  const provisional = nodes.map((node) => ({
    ...node.vom,
    id: numericId.get(node.id) as number,
    parentId: (() => {
      const parent = initialParentId(graph, node);
      return parent ? (numericId.get(parent) ?? null) : null;
    })(),
    ...(node.backendNodeId !== undefined ? { backendNodeId: node.backendNodeId } : {}),
    frameId: node.frameId,
    contextScopeId: graph.frames.get(node.frameId)?.contextScopeId ?? node.frameId,
    referenceable: node.referenceable,
  }));
  return new Map(
    applyVomInteractionRecovery(provisional).flatMap((node) => {
      const id = semanticId.get(node.id);
      return id ? [[id, node] as const] : [];
    }),
  );
}

function redundantSourceNodes(
  graph: ResolvedSemanticGraph,
  nodes: ResolvedSemanticNode[],
  recovered: ReadonlyMap<SemanticNodeId, VomNode>,
): Set<SemanticNodeId> {
  const byKey = new Map<string, ResolvedSemanticNode[]>();
  for (const node of nodes) {
    const output = recovered.get(node.id) as VomNode;
    const name = output.name?.trim().toLowerCase() ?? "";
    if (!name || !isVomReferenceNode({ ...output, referenceable: true })) continue;
    const key = `${node.frameId}\u0000${initialParentId(graph, node) ?? ""}\u0000${output.role?.toLowerCase() ?? ""}\u0000${name}\u0000${output.sensitive === true}`;
    const matches = byKey.get(key) ?? [];
    matches.push(node);
    byKey.set(key, matches);
  }
  const redundant = new Set<SemanticNodeId>();
  for (const matches of byKey.values()) {
    const axOnly = matches.filter((node) => node.ax && !node.dom);
    const domOnly = matches.filter((node) => node.dom && !node.ax);
    if (matches.length === 2 && axOnly.length === 1 && domOnly.length === 1) {
      redundant.add(domOnly[0].id);
    }
  }
  return redundant;
}

function baseDecision(
  graph: ResolvedSemanticGraph,
  node: ResolvedSemanticNode,
  output: VomNode,
  frameOwnerIds: ReadonlySet<SemanticNodeId>,
  redundant: ReadonlySet<SemanticNodeId>,
): StructureDecision {
  if (node.excluded) return { kind: "excluded", reason: "excluded" };
  if (redundant.has(node.id)) return { kind: "excluded", reason: "redundant-source" };
  if (!hasUsableAxSemantics(node) && !isRenderedDomFallback(node)) {
    return { kind: "excluded", reason: "non-rendered-dom-fallback" };
  }
  if (frameOwnerIds.has(node.id)) return { kind: "keep", reason: "frame-owner" };
  if (node.frameId !== graph.rootFrameId && ROOT_ROLES.has(output.role?.toLowerCase() ?? "")) {
    return { kind: "transparent", reason: "child-document-root" };
  }
  if (node.ax?.ignored === true && !node.dom) {
    return { kind: "transparent", reason: "ax-ignored" };
  }
  const role = output.role?.toLowerCase() ?? "";
  if (!TRANSPARENT_ROLES.has(role)) return { kind: "keep", reason: "semantic" };
  if (
    output.name ||
    output.text ||
    output.value ||
    output.placeholder ||
    hasMeaningfulRelations(node) ||
    (output.rect && ["fixed", "sticky"].includes(output.position))
  ) {
    return { kind: "keep", reason: "semantic" };
  }
  return { kind: "transparent", reason: "wrapper" };
}

function buildChildren(
  nodes: ResolvedSemanticNode[],
  relation: "axParentId" | "domParentId",
): Map<SemanticNodeId, SemanticNodeId[]> {
  const children = new Map<SemanticNodeId, SemanticNodeId[]>();
  for (const node of nodes) {
    const parentId = node[relation];
    if (!parentId) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(node.id);
    children.set(parentId, siblings);
  }
  return children;
}

function explicitDomAncestors(
  graph: ResolvedSemanticGraph,
  nodes: ResolvedSemanticNode[],
  domChildren: ReadonlyMap<SemanticNodeId, SemanticNodeId[]>,
): Set<SemanticNodeId> {
  const inside = new Set<SemanticNodeId>();
  const roots = nodes.filter((node) => !node.domParentId);
  const queue = roots.map((node) => node.id);
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index];
    const parent = graph.nodes.get(parentId);
    const parentIsBoundary =
      parent !== undefined &&
      explicitStructural(parent) &&
      !ROOT_ROLES.has(parent.vom.role?.toLowerCase() ?? "");
    for (const childId of domChildren.get(parentId) ?? []) {
      if (inside.has(parentId) || parentIsBoundary) inside.add(childId);
      queue.push(childId);
    }
  }
  return inside;
}

function reliableGroupCandidates(
  graph: ResolvedSemanticGraph,
  nodes: ResolvedSemanticNode[],
  recovered: ReadonlyMap<SemanticNodeId, VomNode>,
  decisions: ReadonlyMap<SemanticNodeId, StructureDecision>,
  domChildren: ReadonlyMap<SemanticNodeId, SemanticNodeId[]>,
): Set<SemanticNodeId> {
  const insideExplicitStructure = explicitDomAncestors(graph, nodes, domChildren);
  const remainingChildren = new Map(
    nodes.map((node) => [node.id, domChildren.get(node.id)?.length ?? 0]),
  );
  const summaries = new Map<SemanticNodeId, { blocked: boolean; interactions: number }>();
  const queue = nodes
    .filter((node) => (remainingChildren.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    const node = graph.nodes.get(nodeId);
    const output = recovered.get(nodeId);
    if (!node || !output) continue;
    const role = output.role?.toLowerCase() ?? "";
    const excluded = decisions.get(nodeId)?.kind === "excluded";
    const blocked = excluded || explicitStructural(node) || CONTENT_BOUNDARY_ROLES.has(role);
    const summary = excluded
      ? { blocked: true, interactions: 0 }
      : isVomReferenceNode(output)
        ? { blocked: false, interactions: 1 }
        : blocked
          ? { blocked: true, interactions: 0 }
          : (domChildren.get(nodeId) ?? []).reduce(
              (combined, childId) => {
                const child = summaries.get(childId);
                return {
                  blocked: combined.blocked || !child || child.blocked,
                  interactions: Math.min(2, combined.interactions + (child?.interactions ?? 0)),
                };
              },
              { blocked: false, interactions: 0 },
            );
    summaries.set(nodeId, summary);
    const parentId = node.domParentId;
    if (!parentId) continue;
    const remaining = (remainingChildren.get(parentId) ?? 1) - 1;
    remainingChildren.set(parentId, remaining);
    if (remaining === 0) queue.push(parentId);
  }

  const candidates = new Set<SemanticNodeId>();
  for (const node of nodes) {
    const output = recovered.get(node.id) as VomNode;
    const role = output.role?.toLowerCase() ?? "";
    if (
      !node.dom ||
      node.dom.tag.toLowerCase() !== "div" ||
      !TRANSPARENT_ROLES.has(role) ||
      insideExplicitStructure.has(node.id) ||
      decisions.get(node.id)?.kind === "excluded" ||
      node.dom.attrs.hidden !== undefined ||
      (node.dom.attrs["aria-hidden"] ?? "").toLowerCase() === "true" ||
      node.dom.attrs.inert !== undefined
    ) {
      continue;
    }

    const branches = (domChildren.get(node.id) ?? []).map((id) => summaries.get(id));
    const blocked = branches.some((summary) => !summary || summary.blocked);
    const contributingBranches = branches.filter(
      (summary) => (summary?.interactions ?? 0) > 0,
    ).length;
    const interactions = branches.reduce(
      (count, summary) => Math.min(2, count + (summary?.interactions ?? 0)),
      0,
    );
    if (!blocked && contributingBranches >= 2 && interactions >= 2) {
      candidates.add(node.id);
    }
  }
  return candidates;
}

function leafCandidates(
  nodes: ResolvedSemanticNode[],
  candidates: ReadonlySet<SemanticNodeId>,
  domChildren: ReadonlyMap<SemanticNodeId, SemanticNodeId[]>,
): Set<SemanticNodeId> {
  const parentById = new Map(
    nodes.flatMap((node) => (node.domParentId ? ([[node.id, node.domParentId]] as const) : [])),
  );
  const childCount = new Map(nodes.map((node) => [node.id, domChildren.get(node.id)?.length ?? 0]));
  const containsCandidate = new Set<SemanticNodeId>();
  const queue = nodes.filter((node) => (childCount.get(node.id) ?? 0) === 0).map((node) => node.id);
  const selected = new Set<SemanticNodeId>();
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    if (candidates.has(nodeId) && !containsCandidate.has(nodeId)) selected.add(nodeId);
    const parentId = parentById.get(nodeId);
    if (!parentId) continue;
    if (candidates.has(nodeId) || containsCandidate.has(nodeId)) containsCandidate.add(parentId);
    const remaining = (childCount.get(parentId) ?? 1) - 1;
    childCount.set(parentId, remaining);
    if (remaining === 0) queue.push(parentId);
  }
  return selected;
}

function nearestKept(
  graph: ResolvedSemanticGraph,
  startId: SemanticNodeId | undefined,
  relation: "axParentId" | "domParentId",
  kept: ReadonlySet<SemanticNodeId>,
  memo: Map<SemanticNodeId, SemanticNodeId | undefined>,
): SemanticNodeId | undefined {
  let currentId = startId;
  const path: SemanticNodeId[] = [];
  const seen = new Set<SemanticNodeId>();
  let result: SemanticNodeId | undefined;
  while (currentId && !seen.has(currentId)) {
    if (kept.has(currentId)) {
      result = currentId;
      break;
    }
    if (memo.has(currentId)) {
      result = memo.get(currentId);
      break;
    }
    seen.add(currentId);
    path.push(currentId);
    currentId = graph.nodes.get(currentId)?.[relation];
  }
  for (const id of path) memo.set(id, result);
  return result;
}

function finalParentId(
  graph: ResolvedSemanticGraph,
  node: ResolvedSemanticNode,
  kept: ReadonlySet<SemanticNodeId>,
  decisions: ReadonlyMap<SemanticNodeId, StructureDecision>,
  axParentMemo: Map<SemanticNodeId, SemanticNodeId | undefined>,
  domParentMemo: Map<SemanticNodeId, SemanticNodeId | undefined>,
): SemanticNodeId | undefined {
  const axParent = nearestKept(graph, node.axParentId, "axParentId", kept, axParentMemo);
  const domParent = nearestKept(graph, node.domParentId, "domParentId", kept, domParentMemo);
  const axNode = axParent ? graph.nodes.get(axParent) : undefined;
  const domNode = domParent ? graph.nodes.get(domParent) : undefined;
  const axIsRoot = ROOT_ROLES.has(axNode?.vom.role?.toLowerCase() ?? "");
  const axIsExplicit = axNode ? explicitStructural(axNode) && !axIsRoot : false;
  const domIsStructural =
    domNode !== undefined &&
    (explicitStructural(domNode) || decisions.get(domNode.id)?.kind === "inferred-group");
  if (axIsExplicit) return axParent;
  if (domIsStructural) return domParent;
  if (axParent && !axIsRoot) return axParent;
  if (domParent) return domParent;
  if (axParent) return axParent;
  if (node.frameId === graph.rootFrameId) return undefined;
  return graph.frames.get(node.frameId)?.ownerNodeId;
}

function recoveredVom(node: VomNode, inferredGroup: boolean): ResolvedSemanticNode["vom"] {
  const {
    id: _id,
    parentId: _parentId,
    backendNodeId: _backendNodeId,
    frameId: _frameId,
    contextScopeId: _contextScopeId,
    referenceable: _referenceable,
    ...vom
  } = node;
  if (!inferredGroup) return vom;
  const { name: _name, text: _text, nearbyText: _nearbyText, ...groupVom } = vom;
  return { ...groupVom, role: "group" };
}

export function normalizeSemanticStructure(graph: ResolvedSemanticGraph): StructuredSemanticGraph {
  const nodes = orderedNodes(graph);
  const recovered = recoveredNodes(graph, nodes);
  const redundant = redundantSourceNodes(graph, nodes, recovered);
  const frameOwnerIds = new Set(
    [...graph.frames.values()].flatMap((frame) => frame.ownerNodeId ?? []),
  );
  const decisions = new Map<SemanticNodeId, StructureDecision>();
  for (const node of nodes) {
    decisions.set(
      node.id,
      baseDecision(graph, node, recovered.get(node.id) as VomNode, frameOwnerIds, redundant),
    );
  }

  const domChildren = buildChildren(nodes, "domParentId");
  const candidates = reliableGroupCandidates(graph, nodes, recovered, decisions, domChildren);
  for (const nodeId of leafCandidates(nodes, candidates, domChildren)) {
    decisions.set(nodeId, {
      kind: "inferred-group",
      reason: "independent-interaction-branches",
    });
  }

  const kept = new Set(
    nodes
      .filter((node) => {
        const kind = decisions.get(node.id)?.kind;
        return kind === "keep" || kind === "inferred-group";
      })
      .map((node) => node.id),
  );
  const axParentMemo = new Map<SemanticNodeId, SemanticNodeId | undefined>();
  const domParentMemo = new Map<SemanticNodeId, SemanticNodeId | undefined>();
  const structuredNodes = new Map<SemanticNodeId, StructuredSemanticNode>();
  for (const node of nodes) {
    const structure = decisions.get(node.id) as StructureDecision;
    const inferredGroup = structure.kind === "inferred-group";
    structuredNodes.set(node.id, {
      ...node,
      vom: recoveredVom(recovered.get(node.id) as VomNode, inferredGroup),
      structure,
      ...(kept.has(node.id)
        ? {
            semanticParentId: finalParentId(
              graph,
              node,
              kept,
              decisions,
              axParentMemo,
              domParentMemo,
            ),
          }
        : {}),
    });
  }
  return { ...graph, nodes: structuredNodes };
}
