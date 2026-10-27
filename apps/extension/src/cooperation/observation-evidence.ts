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

/** A text change of one persistent node between two observations. */
export interface ContentChange {
  key: string;
  before: string;
  after: string;
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
// Accessibility text nodes state their own text as their name. Other names may
// be derived from descendant text, so they are never learned directly.
const textRoles = new Set(["StaticText", "InlineTextBox", "ListMarker"]);
// Attributes that self-updating widgets rewrite alongside their text.
const contentAttributes = new Set(["aria-label", "title"]);
// Stands in for learned text inside a derived name; HTML text never contains it.
const LEARNED = "\u0000";

export function observationEvidence(scene: VomScene): ObservationEvidence {
  return { nodes: scene.nodes };
}

const isTarget = (node: VomNode, target: EvidenceTarget) =>
  node.backendNodeId === target.backendNodeId &&
  (target.frameId === undefined || node.frameId === target.frameId);

/** Whether the observation contains the target, so its region can be checked. */
export function observesTarget(evidence: ObservationEvidence, target: EvidenceTarget): boolean {
  return evidence.nodes.some((node) => isTarget(node, target));
}

const positioned = (node: VomNode) => ["absolute", "fixed"].includes(node.position);
// Form state, value-bearing widgets and modal layers are never page activity.
const protectedState = (node: VomNode) =>
  node.value !== undefined || node.checked !== undefined || !!node.modal;
/** Text a node states itself, excluding names derived from its descendants. */
const ownContent = (node: VomNode) => [
  textRoles.has(node.role ?? "") ? node.name : undefined,
  node.text,
  node.attrs?.["aria-label"],
  node.attrs?.title,
];
const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const wordCharacter = /[\p{L}\p{N}]/u;

/** Parent/child view of one observation that tolerates malformed cycles. */
class Tree {
  private readonly byId: Map<number, VomNode>;
  private readonly kids = new Map<VomNode, VomNode[]>();
  private readonly keys = new Map<VomNode, string | undefined>();

  constructor(nodes: readonly VomNode[]) {
    this.byId = new Map(nodes.map((node) => [node.id, node]));
    for (const node of nodes) {
      const parent = this.parent(node);
      if (!parent) continue;
      const siblings = this.kids.get(parent);
      if (siblings) siblings.push(node);
      else this.kids.set(parent, [node]);
    }
  }

  parent(node: VomNode): VomNode | undefined {
    const parent = this.byId.get(node.domParentId ?? node.parentId ?? -1);
    return parent === node ? undefined : parent;
  }

  children(node: VomNode): readonly VomNode[] {
    return this.kids.get(node) ?? [];
  }

  /** The node followed by its ancestors, nearest first. */
  ancestors(node: VomNode): VomNode[] {
    const chain: VomNode[] = [];
    const seen = new Set<VomNode>();
    for (
      let current: VomNode | undefined = node;
      current && !seen.has(current);
      current = this.parent(current)
    ) {
      seen.add(current);
      chain.push(current);
    }
    return chain;
  }

  within(node: VomNode, container: VomNode): boolean {
    const seen = new Set<VomNode>();
    for (
      let current: VomNode | undefined = node;
      current && !seen.has(current);
      current = this.parent(current)
    ) {
      if (current === container) return true;
      seen.add(current);
    }
    return false;
  }

  /**
   * Stable identity for learning: the node's own backend node, or for virtual
   * accessibility text without one (such as an InlineTextBox) the nearest
   * ancestor that has one, which owns that text.
   */
  key(node: VomNode): string | undefined {
    if (this.keys.has(node)) return this.keys.get(node);
    const owner = this.ancestors(node).find((current) => current.backendNodeId !== undefined);
    const key = owner && `${owner.frameId ?? ""}:${owner.backendNodeId}`;
    this.keys.set(node, key);
    return key;
  }
}

/** Replaces each occurrence of `value` that is not part of a longer word. */
function replaceWords(text: string, value: string): string {
  let result = "";
  let from = 0;
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
    const end = at + value.length;
    if (
      at < from ||
      (at > 0 && wordCharacter.test(text[at - 1])) ||
      (end < text.length && wordCharacter.test(text[end]))
    )
      continue;
    result += text.slice(from, at) + LEARNED;
    from = end;
  }
  return result + text.slice(from);
}

/**
 * Removes learned text from a name derived from descendant text, such as a
 * container's joined content. Everything else in the name stays exact, so a
 * change hides only if other text changes in lockstep with learned text, as a
 * duplicate of the same value does.
 */
function withoutLearned(name: string | undefined, learned?: ReadonlySet<string>) {
  if (!name || !learned?.size) return name;
  let result = clean(name);
  for (const value of [...learned].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)))
    result = replaceWords(result, value);
  return result;
}

function signature(
  evidence: ObservationEvidence,
  target?: EvidenceTarget,
  volatile?: ReadonlySet<string>,
): string | undefined {
  const nodes = evidence.nodes;
  const tree = new Tree(nodes);
  const anchor = target && nodes.find((node) => isTarget(node, target));
  if (target && !anchor) return;
  const ancestors = anchor ? tree.ancestors(anchor) : [];
  // A whole list/table participates, so a changed competing option invalidates
  // a choice even when the selected row itself did not change.
  const scope =
    ancestors.find((node) => scopes.has(node.role ?? "") || scopes.has(node.tag)) ??
    ancestors.find((node) => node.modal) ??
    ancestors.find((node) => regions.has(node.role ?? "") || regions.has(node.tag)) ??
    ancestors.find((node) => positioned(node) && node !== anchor);
  const inside = (node: VomNode) => !scope || tree.within(node, scope);
  // Where learned text may differ. The whole-page check (no target) allows it
  // everywhere. A target inside a form, dialog, list, table, section, article,
  // positioned panel or other region keeps that region exact. Inside <main> or
  // a page without regions, the target's own branch stays exact: the child of
  // the first layout node that is not a single-child wrapper, never descending
  // into a positioned panel. This keeps cards, panels and other content
  // sharing a container with the target exact.
  let relaxable = (_node: VomNode) => true;
  if (anchor) {
    const broad = !scope || scope.role === "main" || scope.tag === "main";
    if (!broad) relaxable = () => false;
    else {
      let top = scope ?? ancestors[ancestors.length - 1];
      while (top !== anchor) {
        const [only, ...others] = tree.children(top);
        if (!only || others.length || positioned(only)) break;
        top = only;
      }
      const index = ancestors.indexOf(top);
      const branch = top === anchor ? anchor : index > 0 ? ancestors[index - 1] : undefined;
      // An unexpected tree keeps the whole region exact.
      relaxable = branch ? (node) => !tree.within(node, branch) : () => false;
    }
  }
  const tolerated = (node: VomNode) =>
    !!volatile?.size &&
    volatile.has(tree.key(node) ?? "") &&
    !protectedState(node) &&
    relaxable(node);
  // Names derived from descendants hide only the learned text they contain.
  const learnedText = new Map<VomNode, Set<string>>();
  for (const node of volatile?.size ? nodes : []) {
    if (!tolerated(node)) continue;
    const values = ownContent(node)
      .filter((value): value is string => !!value)
      .map(clean)
      .filter(Boolean);
    for (const holder of values.length ? tree.ancestors(node) : []) {
      const set = learnedText.get(holder) ?? new Set<string>();
      for (const value of values) set.add(value);
      learnedText.set(holder, set);
    }
  }
  // Identity, structure, state and visibility of learned nodes remain checked.
  const facts = (node: VomNode, relax: boolean) => {
    const tolerate = relax && tolerated(node);
    return [
      node.frameId,
      node.backendNodeId,
      node.role,
      node.tag,
      tolerate && textRoles.has(node.role ?? "")
        ? undefined
        : relax
          ? withoutLearned(node.name, learnedText.get(node))
          : node.name,
      tolerate ? undefined : node.text,
      node.value,
      node.checked,
      node.disabled,
      node.inert,
      node.modal,
      !!node.rect && node.rect.w > 0 && node.rect.h > 0,
      node.pointerEvents === "none",
      semanticAttributes.map((key) =>
        tolerate && contentAttributes.has(key) ? undefined : node.attrs?.[key],
      ),
    ];
  };
  return JSON.stringify([
    scope && [scope.frameId, scope.backendNodeId],
    nodes.filter(inside).map((node) => facts(node, true)),
    // Form state outside the action region can still determine its meaning.
    nodes
      .filter((node) => node.value !== undefined || node.checked !== undefined)
      .map((node) => facts(node, false)),
    nodes.filter((node) => node.modal).map((node) => facts(node, false)),
  ]);
}

/**
 * `volatile` lists the stable identities (backend nodes, owning any virtual
 * text beneath them) whose own text, aria-label and title may differ. Names
 * derived from descendant text are compared with that learned text removed
 * wherever it appears as whole words. Without a target this applies to the
 * whole page. With a target it never applies inside the target's own region,
 * as described in signature(). Form values, checked states and modal layers
 * stay exact everywhere.
 */
export function sameObservationEvidence(
  before: ObservationEvidence,
  after: ObservationEvidence,
  target?: EvidenceTarget,
  volatile?: ReadonlySet<string>,
): boolean {
  const a = signature(before, target, volatile);
  return a !== undefined && a === signature(after, target, volatile);
}

interface ContentGroup {
  content: (string | undefined)[][];
  protected: boolean;
}

function contentGroups(evidence: ObservationEvidence): Map<string, ContentGroup> {
  const tree = new Tree(evidence.nodes);
  const groups = new Map<string, ContentGroup>();
  for (const node of evidence.nodes) {
    const key = tree.key(node);
    if (!key) continue;
    const group = groups.get(key) ?? { content: [], protected: false };
    group.content.push(ownContent(node));
    group.protected ||= protectedState(node);
    groups.set(key, group);
  }
  return groups;
}

type Content = (string | undefined)[];
/** The first own-content field that differs, for reporting the change. */
function described(before: Content | undefined, after: Content | undefined): [string, string] {
  const fields = Math.max(before?.length ?? 0, after?.length ?? 0);
  for (let field = 0; field < fields; field++)
    if ((before?.[field] ?? "") !== (after?.[field] ?? ""))
      return [clean(before?.[field] ?? ""), clean(after?.[field] ?? "")];
  const first = (content?: Content) =>
    content?.map((value) => value && clean(value)).find(Boolean) ?? "";
  return [first(before), first(after)];
}

/**
 * Returns the persistent, unprotected nodes whose own text changed when that is
 * the only difference between two whole-page observations; otherwise undefined.
 * Added, removed, reordered or restyled nodes, any form or modal change, and
 * any derived name that the changed text does not explain keep requiring a new
 * decision.
 */
export function contentChanges(
  before: ObservationEvidence,
  after: ObservationEvidence,
  known: ReadonlySet<string> = new Set(),
): ContentChange[] | undefined {
  const previous = contentGroups(before);
  const changes: ContentChange[] = [];
  for (const [key, group] of contentGroups(after)) {
    const old = previous.get(key);
    if (!old || known.has(key) || old.protected || group.protected) continue;
    if (JSON.stringify(old.content) === JSON.stringify(group.content)) continue;
    const length = Math.max(old.content.length, group.content.length);
    let member = 0;
    while (
      member < length - 1 &&
      JSON.stringify(old.content[member]) === JSON.stringify(group.content[member])
    )
      member++;
    const [was, now] = described(old.content[member], group.content[member]);
    changes.push({ key, before: was, after: now });
  }
  const volatile = new Set([...known, ...changes.map((change) => change.key)]);
  return changes.length && sameObservationEvidence(before, after, undefined, volatile)
    ? changes
    : undefined;
}
