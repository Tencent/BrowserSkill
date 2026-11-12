import { selectionMarker, type VomNode, type VomScene } from "@browser-skill/vom";
import { playbackProgressMedia } from "./media-progress";

/** Reuse the observation's semantic nodes. Only normalized selection hints from
 * CSS/data attributes participate; cosmetic classes and pixel positions do not.
 * The interaction layer rechecks the live hit target. */
export interface ObservationEvidence {
  nodes: readonly VomNode[];
  rootFrameId?: string;
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

export interface EvidenceOptions {
  /**
   * Also tolerate positively identified media timelines in a comparison
   * without a target. Callers use this only for the whole-page part of an
   * action whose resolved target region is checked separately. Untargeted
   * actions keep the exact page.
   */
  incidentalMedia?: boolean;
}

/** The first difference between two observations, for diagnostics only. */
export interface ObservedChange {
  part: "target" | "scope" | "region" | "form_state" | "modal" | "media";
  change: "changed" | "added" | "removed";
  role?: string;
  name?: string;
  field?: string;
  /** Omitted for values and sensitive nodes. */
  before?: string;
  after?: string;
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
  "aria-controls",
  "aria-describedby",
  "aria-valuemin",
  "aria-valuemax",
  "min",
  "max",
  "maxlength",
  "step",
  "readonly",
  "required",
];
// Accessibility text nodes state their own text as their name. Other names may
// be derived from descendant text, so they are never learned directly.
const textRoles = new Set(["StaticText", "InlineTextBox", "ListMarker"]);
// Attributes that self-updating widgets rewrite alongside their text.
const contentAttributes = new Set(["aria-label", "title"]);
// Field names of facts(), in order, used to describe a difference.
const factFields = [
  "frame",
  "node",
  "role",
  "tag",
  "name",
  "text",
  "value",
  "in_form",
  "checked",
  "selection",
  "disabled",
  "inert",
  "modal",
  "visible",
  "pointer_events",
  "attributes",
  "src",
] as const;
// Stands in for learned text inside a derived name; HTML text never contains it.
const LEARNED = "\u0000";

export function observationEvidence(scene: VomScene): ObservationEvidence {
  return { nodes: scene.nodes, rootFrameId: scene.rootFrameId };
}

const isTarget = (node: VomNode, target: EvidenceTarget) =>
  node.backendNodeId === target.backendNodeId &&
  (target.frameId === undefined || node.frameId === target.frameId);

/** Whether the observation contains the target, so its region can be checked. */
export function observesTarget(evidence: ObservationEvidence, target: EvidenceTarget): boolean {
  return evidence.nodes.some((node) => isTarget(node, target));
}

/** Specific keyboard recipients visible to the browser's accessibility tree.
 * Document/iframe focus is not a reliable substitute for the actual recipient. */
export function observedKeyboardTargets(evidence: ObservationEvidence): EvidenceTarget[] {
  return evidence.nodes
    .filter(
      (node) =>
        node.focused &&
        node.backendNodeId !== undefined &&
        !["body", "html", "iframe", "frame"].includes(node.tag) &&
        node.role !== "RootWebArea",
    )
    .map((node) => ({ backendNodeId: node.backendNodeId!, frameId: node.frameId }));
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
function replaceWords(text: string, value: string, replacement = LEARNED): string {
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
    result += text.slice(from, at) + replacement;
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

const controlRoles = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "option",
  "tab",
  "menuitem",
]);

function within(tree: Tree, node: VomNode, root: VomNode): boolean {
  return (
    tree.within(node, root) ||
    (node.frameId === root.frameId && (node.domAncestorIds ?? []).includes(root.id))
  );
}

/** Remove only identified input decorations after native focus/hover. Callers
 * must keep explicit dependencies and actions without a DOM target unmodified.
 * A ratio alone is not evidence of a character counter: it must match a focused
 * field's value and maxlength, or an explicit aria-describedby association. */
function withoutPreparationDecorations(
  evidence: ObservationEvidence,
  other: ObservationEvidence,
  target: EvidenceTarget,
  preparation: { focus: boolean; hover: boolean },
): ObservationEvidence {
  const { nodes } = evidence;
  const tree = new Tree(nodes);
  const anchor = nodes.find((node) => isTarget(node, target));
  if (!anchor) return evidence;
  const present = new Set(other.nodes.map((node) => `${node.frameId ?? ""}:${node.backendNodeId}`));
  const dialogs = nodes.filter(
    (node) =>
      node.modal || node.tag === "dialog" || ["dialog", "alertdialog"].includes(node.role ?? ""),
  );
  const controls = (node: VomNode) =>
    protectedState(node) ||
    node.sensitive ||
    node.disabled ||
    node.inert ||
    node.focused ||
    node.clickable ||
    controlRoles.has(node.role ?? "") ||
    ["a", "button", "input", "textarea", "select", "video", "audio"].includes(node.tag) ||
    node.attrs?.tabindex !== undefined ||
    node.attrs?.contenteditable !== undefined ||
    node.attrs?.onclick !== undefined ||
    selectionMarker(node) !== undefined;
  const fields = preparation.focus
    ? nodes.filter(
        (node) =>
          node.focused &&
          !node.sensitive &&
          typeof node.value === "string" &&
          ["textbox", "searchbox"].includes(node.role ?? ""),
      )
    : [];
  const counter = (node: VomNode) => {
    const text = node.text ?? (textRoles.has(node.role ?? "") ? node.name : undefined);
    const match = text && /^(\d+)\s*\/\s*(\d+)$/.exec(clean(text));
    if (!match) return false;
    const used = Number(match[1]);
    const limit = Number(match[2]);
    return fields.some(
      (field) =>
        field.frameId === node.frameId &&
        used === field.value!.length &&
        limit > 0 &&
        ((field.attrs?.maxlength === String(limit) &&
          !!tree.parent(field) &&
          within(tree, node, tree.parent(field)!)) ||
          (!!node.attrs?.id &&
            (field.attrs?.["aria-describedby"] ?? "").split(/\s+/).includes(node.attrs.id))),
    );
  };
  const decorations = nodes.filter((node) => {
    // Persistent nodes remain exact, even if they used to be a decoration.
    if (
      node.backendNodeId === undefined ||
      present.has(`${node.frameId ?? ""}:${node.backendNodeId}`)
    )
      return false;
    if (!(preparation.hover && node.role === "tooltip") && !counter(node)) return false;
    if (within(tree, node, anchor) || dialogs.some((dialog) => within(tree, node, dialog)))
      return false;
    // A tooltip or counter containing a control is decision evidence too.
    return !nodes.some((child) => within(tree, child, node) && controls(child));
  });
  if (!decorations.length) return evidence;
  const omitted = new Set(
    nodes.filter((node) => decorations.some((root) => within(tree, node, root))),
  );
  const names = new Map<VomNode, Set<string>>();
  for (const node of omitted) {
    const content = ownContent(node).filter((value): value is string => !!value);
    for (const holder of tree.ancestors(node).slice(1)) {
      const fragments = names.get(holder) ?? new Set<string>();
      for (const value of content) fragments.add(clean(value));
      names.set(holder, fragments);
    }
  }
  return {
    ...evidence,
    nodes: nodes
      .filter((node) => !omitted.has(node))
      .map((node) => {
        if (!node.name || !names.has(node)) return node;
        let name = node.name;
        for (const text of [...names.get(node)!].sort((a, b) => b.length - a.length))
          if (text) name = replaceWords(name, text, "");
        return { ...node, name: clean(name) };
      }),
  };
}

/** Compare added/removed decorations symmetrically. Stable counter/tooltip
 * content and state still participate in the normal semantic comparison. */
export function preparationEvidence(
  before: ObservationEvidence,
  after: ObservationEvidence,
  target: EvidenceTarget,
  preparation: { focus: boolean; hover: boolean },
): readonly [ObservationEvidence, ObservationEvidence] {
  const previous = withoutPreparationDecorations(before, after, target, preparation);
  const current = withoutPreparationDecorations(after, before, target, preparation);
  if (previous === before) return [previous, current];
  const key = (node: VomNode) => `${node.frameId ?? ""}:${node.backendNodeId}`;
  const originals = new Map(before.nodes.map((node) => [key(node), node]));
  const normalized = new Map(previous.nodes.map((node) => [key(node), node]));
  return [
    previous,
    {
      ...current,
      nodes: current.nodes.map((node) => {
        const original = originals.get(key(node));
        const prior = normalized.get(key(node));
        // semantic-graph/resolve.ts caps DOM-derived names at 240 characters.
        // Removing a decoration can reveal a previously unobserved suffix.
        // Keep every known character exact; never shorten the old observation
        // when an added tooltip hides previously observed text instead.
        if (
          original?.name?.length === 240 &&
          original.name !== prior?.name &&
          prior?.name &&
          node.name?.startsWith(prior.name)
        )
          return { ...node, name: prior.name };
        return node;
      }),
    },
  ];
}

type Part = ObservedChange["part"];
interface Row {
  node: VomNode;
  facts: unknown[];
}
interface Signature {
  scope: unknown;
  parts: [Part, Row[]][];
}

function signature(
  evidence: ObservationEvidence,
  target?: EvidenceTarget,
  volatile?: ReadonlySet<string>,
  options: EvidenceOptions = {},
): Signature | undefined {
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
  // A semantic region may include both Pause and the timeline. Only a direct
  // dependency on the timeline, its player, or a containing element makes its
  // value exact; sharing the inferred region with a button does not.
  // Keep the original nodes intact: media controls cannot become learned text.
  // Without a target this applies only when the caller checks a resolved
  // action target separately; untargeted actions keep the exact page.
  const media = nodes.filter((node) => node.tag === "video" || node.tag === "audio");
  const modals = nodes.filter((node) => node.modal);
  const ignoredProgress = new Map<VomNode, VomNode>();
  const explicitlyObserved = (node: VomNode) =>
    !!anchor && (tree.within(node, anchor) || (node.domAncestorIds ?? []).includes(anchor.id));
  if (target || options.incidentalMedia)
    for (const node of nodes) {
      if (explicitlyObserved(node) || node.value === undefined) continue;
      const owner = playbackProgressMedia(
        {
          ...node,
          // Only native ownership or complete raw DOM evidence can establish
          // that a control is form-free. Pruned ancestors are not evidence.
          inForm: node.inForm !== false,
        },
        media
          .filter((item) => item.frameId === node.frameId)
          .map((item) => ({ id: item.attrs?.id, node: item })),
      );
      if (owner && !explicitlyObserved(owner.node)) ignoredProgress.set(node, owner.node);
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
        : (relax ? withoutLearned(node.name, learnedText.get(node)) : node.name) || undefined,
      tolerate ? undefined : node.text,
      ignoredProgress.has(node) ? undefined : node.value,
      node.inForm,
      node.checked,
      selectionMarker(node),
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
  const rows = (list: VomNode[], relax: boolean): Row[] =>
    list.map((node) => ({ node, facts: facts(node, relax) }));
  return {
    scope: scope && [scope.frameId, scope.backendNodeId],
    parts: [
      ["region", rows(nodes.filter(inside), true)],
      // Form state outside the action region can still determine its meaning.
      [
        "form_state",
        rows(
          nodes.filter((node) => node.value !== undefined || node.checked !== undefined),
          false,
        ),
      ],
      [
        "modal",
        rows(
          nodes.filter((node) => modals.some((root) => within(tree, node, root))),
          false,
        ),
      ],
      // Replacing the player or its source still invalidates the observation.
      [
        "media",
        [...new Set(ignoredProgress.values())].map((node) => ({
          node,
          facts: [...facts(node, false), node.attrs?.src],
        })),
      ],
    ],
  };
}

const serialize = (value?: Signature) =>
  value &&
  JSON.stringify([value.scope, value.parts.map(([, list]) => list.map((row) => row.facts))]);

const jsonPrimitiveEq = (x: unknown, y: unknown): boolean => {
  const nx = x === undefined || (typeof x === "number" && !Number.isFinite(x)) ? null : x;
  const ny = y === undefined || (typeof y === "number" && !Number.isFinite(y)) ? null : y;
  return nx === ny;
};

function sameUnrelaxedNodeFacts(a: VomNode, b: VomNode): boolean {
  if (
    !jsonPrimitiveEq(a.frameId, b.frameId) ||
    !jsonPrimitiveEq(a.backendNodeId, b.backendNodeId) ||
    !jsonPrimitiveEq(a.role, b.role) ||
    !jsonPrimitiveEq(a.tag, b.tag) ||
    !jsonPrimitiveEq(a.name || undefined, b.name || undefined) ||
    !jsonPrimitiveEq(a.text, b.text) ||
    (a.value !== undefined) !== (b.value !== undefined) ||
    !jsonPrimitiveEq(a.value, b.value) ||
    !jsonPrimitiveEq(a.inForm, b.inForm) ||
    (a.checked !== undefined) !== (b.checked !== undefined) ||
    !jsonPrimitiveEq(a.checked, b.checked) ||
    !jsonPrimitiveEq(a.disabled, b.disabled) ||
    !jsonPrimitiveEq(a.inert, b.inert) ||
    !jsonPrimitiveEq(a.modal, b.modal)
  ) {
    return false;
  }
  const aVisible = !!a.rect && a.rect.w > 0 && a.rect.h > 0;
  const bVisible = !!b.rect && b.rect.w > 0 && b.rect.h > 0;
  if (aVisible !== bVisible) return false;
  if ((a.pointerEvents === "none") !== (b.pointerEvents === "none")) return false;
  if (!jsonPrimitiveEq(selectionMarker(a), selectionMarker(b))) return false;
  const aAttrs = a.attrs;
  const bAttrs = b.attrs;
  if (aAttrs !== bAttrs) {
    for (let i = 0; i < semanticAttributes.length; i++) {
      const key = semanticAttributes[i];
      if (!jsonPrimitiveEq(aAttrs?.[key], bAttrs?.[key])) return false;
    }
  }
  return true;
}

/**
 * `volatile` lists the stable identities (backend nodes, owning any virtual
 * text beneath them) whose own text, aria-label and title may differ. Names
 * derived from descendant text are compared with that learned text removed
 * wherever it appears as whole words. Without a target this applies to the
 * whole page. With a target it never applies inside the target's own region,
 * as described in signature(). Form values, checked states and modal layers
 * stay exact everywhere except positively identified, non-submitted media
 * progress values outside the explicitly observed target subtree.
 */
export function sameObservationEvidence(
  before: ObservationEvidence,
  after: ObservationEvidence,
  target?: EvidenceTarget,
  volatile?: ReadonlySet<string>,
  options?: EvidenceOptions,
): boolean {
  if (
    !target &&
    !volatile?.size &&
    !options?.incidentalMedia &&
    !before.nodes.some((node) => node.modal) &&
    !after.nodes.some((node) => node.modal)
  ) {
    if (before.nodes.length !== after.nodes.length) return false;
    for (let i = 0; i < before.nodes.length; i++) {
      if (!sameUnrelaxedNodeFacts(before.nodes[i], after.nodes[i])) return false;
    }
    return true;
  }
  const a = serialize(signature(before, target, volatile, options));
  return a !== undefined && a === serialize(signature(after, target, volatile, options));
}

const MAX_REPORTED = 80;
const shown = (value: unknown) => {
  if (value === undefined || value === null) return undefined;
  const text = clean(typeof value === "string" ? value : JSON.stringify(value));
  return text.length > MAX_REPORTED ? `${text.slice(0, MAX_REPORTED - 1)}…` : text;
};

/** Describes the first fact that differs between two rows. */
function describeRow(part: Part, before?: Row, after?: Row): ObservedChange {
  const node = after?.node ?? before?.node;
  const change: ObservedChange = {
    part,
    change: !before ? "added" : !after ? "removed" : "changed",
    role: node?.role,
    // A sensitive control's accessible name can repeat its content.
    name: node?.sensitive ? undefined : shown(node?.name),
  };
  if (!before || !after) return change;
  const index = before.facts.findIndex(
    (fact, at) => JSON.stringify(fact) !== JSON.stringify(after.facts[at]),
  );
  let field: string = factFields[index] ?? "unknown";
  let was = before.facts[index];
  let now = after.facts[index];
  if (field === "attributes") {
    const at = semanticAttributes.findIndex(
      (_key, i) => (was as unknown[])?.[i] !== (now as unknown[])?.[i],
    );
    field = `attribute:${semanticAttributes[at]}`;
    was = (was as unknown[])?.[at];
    now = (now as unknown[])?.[at];
  }
  change.field = field;
  // Values may be private even when they are not marked sensitive.
  if (field !== "value" && !before.node.sensitive && !after.node.sensitive) {
    change.before = shown(was);
    change.after = shown(now);
  }
  return change;
}

/**
 * The first difference that makes sameObservationEvidence() false, with the
 * same arguments. Returns undefined when the observations match.
 */
export function observedChange(
  before: ObservationEvidence,
  after: ObservationEvidence,
  target?: EvidenceTarget,
  volatile?: ReadonlySet<string>,
  options?: EvidenceOptions,
): ObservedChange | undefined {
  const a = signature(before, target, volatile, options);
  const b = signature(after, target, volatile, options);
  if (!a || !b)
    return target && (a || b) ? { part: "target", change: a ? "removed" : "added" } : undefined;
  if (JSON.stringify(a.scope) !== JSON.stringify(b.scope))
    return { part: "scope", change: "changed" };
  for (let at = 0; at < a.parts.length; at++) {
    const [part, old] = a.parts[at];
    const next = b.parts[at][1];
    for (let row = 0; row < Math.max(old.length, next.length); row++) {
      const x = old[row];
      const y = next[row];
      if (x && y && JSON.stringify(x.facts) === JSON.stringify(y.facts)) continue;
      // An inserted or removed node shifts the rest of the list. Report the
      // node itself rather than its successor.
      if (x && y && x.node.backendNodeId !== y.node.backendNodeId) {
        const removed = !next.some((item) => item.node.backendNodeId === x.node.backendNodeId);
        return removed ? describeRow(part, x) : describeRow(part, undefined, y);
      }
      return describeRow(part, x, y);
    }
  }
}

/** How much differs between two observations, with a few examples. */
export interface ObservedChanges {
  changed: number;
  added: number;
  removed: number;
  examples: ObservedChange[];
}

const MAX_EXAMPLES = 5;
const NAME_FACT = factFields.indexOf("name");

/**
 * Every node that differs between two observations, with the same arguments
 * as sameObservationEvidence(). Only the caller knows what its action relies
 * on, so this states what changed and leaves relevance to the caller.
 *
 * Nodes are matched by backend identity, so an insertion is one addition and
 * not a shift of every later row. A container whose derived name changed only
 * because a descendant did is not counted again. Returns undefined when no
 * identified node differs, such as text that only wraps differently.
 */
export function observedChanges(
  before: ObservationEvidence,
  after: ObservationEvidence,
  target?: EvidenceTarget,
  volatile?: ReadonlySet<string>,
  options?: EvidenceOptions,
): ObservedChanges | undefined {
  const a = signature(before, target, volatile, options);
  const b = signature(after, target, volatile, options);
  if (!a || !b) return;
  const identity = (node: VomNode) =>
    node.backendNodeId === undefined ? undefined : `${node.frameId ?? ""}:${node.backendNodeId}`;
  const keyed = (rows: Row[]) => {
    const map = new Map<string, Row>();
    for (const row of rows) {
      const key = identity(row.node);
      if (key !== undefined && !map.has(key)) map.set(key, row);
    }
    return map;
  };
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const found = new Map<
    string,
    { node: VomNode; removed: boolean; nameOnly: boolean; change: ObservedChange }
  >();
  for (let at = 0; at < a.parts.length; at++) {
    const [part, old] = a.parts[at];
    const was = keyed(old);
    const now = keyed(b.parts[at][1]);
    for (const [key, row] of was) {
      const next = now.get(key);
      if (found.has(key) || (next && same(row.facts, next.facts))) continue;
      found.set(key, {
        node: next?.node ?? row.node,
        removed: !next,
        nameOnly:
          !!next &&
          !textRoles.has(row.node.role ?? "") &&
          row.facts.every((fact, i) => i === NAME_FACT || same(fact, next.facts[i])),
        change: describeRow(part, row, next),
      });
    }
    for (const [key, row] of now)
      if (!was.has(key) && !found.has(key))
        found.set(key, {
          node: row.node,
          removed: false,
          nameOnly: false,
          change: describeRow(part, undefined, row),
        });
  }
  // Ancestors of a differing node: their derived names repeat its change.
  const trees = { before: new Tree(before.nodes), after: new Tree(after.nodes) };
  const containers = new Set<string>();
  for (const { node, removed } of found.values())
    for (const ancestor of (removed ? trees.before : trees.after).ancestors(node).slice(1)) {
      const key = identity(ancestor);
      if (key !== undefined) containers.add(key);
    }
  const changes = [...found]
    .filter(([key, item]) => !(item.nameOnly && containers.has(key)))
    .map(([, item]) => item.change);
  if (!changes.length) return;
  const count = (kind: ObservedChange["change"]) =>
    changes.filter((change) => change.change === kind).length;
  return {
    changed: count("changed"),
    added: count("added"),
    removed: count("removed"),
    examples: changes.slice(0, MAX_EXAMPLES),
  };
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
