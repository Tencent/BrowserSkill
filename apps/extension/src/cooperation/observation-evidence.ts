import type { VomNode, VomScene } from "@browser-skill/vom";

/** Reuse the observation's semantic nodes. CSS classes and pixel positions are
 * deliberately absent; the interaction layer rechecks the live hit target. */
export interface ObservationEvidence {
  nodes: readonly VomNode[];
}

export interface EvidenceTarget {
  backendNodeId: number;
  frameId?: string;
}

const scopes = new Set(["form", "dialog", "table", "list", "grid", "listbox", "menu"]);
const regions = new Set(["main", "region", "section", "article"]);
const semanticAttributes = [
  "href",
  "type",
  "name",
  "title",
  "alt",
  "aria-label",
  "aria-selected",
  "aria-expanded",
  "aria-checked",
  "aria-pressed",
  "aria-disabled",
  "aria-hidden",
  "readonly",
  "required",
];

export function observationEvidence(scene: VomScene): ObservationEvidence {
  return { nodes: scene.nodes };
}

function signature(evidence: ObservationEvidence, target?: EvidenceTarget): string | undefined {
  const nodes = evidence.nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parent = (node: VomNode) => byId.get(node.domParentId ?? node.parentId ?? -1);
  const anchor =
    target &&
    nodes.find(
      (node) =>
        node.backendNodeId === target.backendNodeId &&
        (target.frameId === undefined || node.frameId === target.frameId),
    );
  if (target && !anchor) return;
  const ancestors: VomNode[] = [];
  for (let node = anchor; node && !ancestors.includes(node); node = parent(node))
    ancestors.push(node);
  // A whole list/table participates, so a changed competing option invalidates
  // a choice even when the selected row itself did not change.
  const scope =
    ancestors.find((node) => scopes.has(node.role ?? "") || scopes.has(node.tag)) ??
    ancestors.find((node) => node.modal) ??
    ancestors.find((node) => regions.has(node.role ?? "") || regions.has(node.tag)) ??
    ancestors.find((node) => ["absolute", "fixed"].includes(node.position) && node !== anchor);
  const inside = (node: VomNode) => {
    if (!scope) return true;
    const seen = new Set<number>();
    for (
      let current: VomNode | undefined = node;
      current && !seen.has(current.id);
      current = parent(current)
    ) {
      if (current.id === scope.id) return true;
      seen.add(current.id);
    }
    return false;
  };
  const facts = (node: VomNode) => [
    node.frameId,
    node.backendNodeId,
    node.role,
    node.tag,
    node.name,
    node.text,
    node.value,
    node.checked,
    node.disabled,
    node.inert,
    node.modal,
    !!node.rect && node.rect.w > 0 && node.rect.h > 0,
    node.pointerEvents === "none",
    semanticAttributes.map((key) => node.attrs?.[key]),
  ];
  return JSON.stringify([
    scope && [scope.frameId, scope.backendNodeId],
    nodes.filter(inside).map(facts),
    // Form state outside the action region can still determine its meaning.
    nodes.filter((node) => node.value !== undefined || node.checked !== undefined).map(facts),
    nodes.filter((node) => node.modal).map(facts),
  ]);
}

export function sameObservationEvidence(
  before: ObservationEvidence,
  after: ObservationEvidence,
  target?: EvidenceTarget,
): boolean {
  const a = signature(before, target);
  return a !== undefined && a === signature(after, target);
}
