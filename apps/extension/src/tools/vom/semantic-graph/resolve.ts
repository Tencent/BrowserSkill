import type { VomNode, VomSelectOption } from "@browser-skill/vom";
import { RECORD_PASSWORD_ATTRIBUTE, sensitiveAutocomplete } from "@/lib/sensitive-autocomplete";
import type { NodeFacts } from "../facts";
import {
  MAX_ROW_ANCHOR_CHARS,
  MAX_SEMANTIC_ROW_HOPS,
  MAX_SLOT_TEXT_SCAN_CHARS,
  MAX_VIRTUAL_DIV_ROW_HOPS,
  NON_ANCHOR_ROLES,
  NON_ANCHOR_TAGS,
  ROW_STOP_TAGS,
  VIRTUAL_POOL_EXCLUDED_TAGS,
  VOLATILE_ROW_TEXT_RE,
} from "../row-anchor-spec";
import { stableIdentifierName } from "./name-evidence";
import type {
  ResolvedSemanticGraph,
  ResolvedSemanticNode,
  SemanticAxNode,
  SemanticGraph,
  SemanticGraphNode,
  SemanticNodeId,
} from "./types";
import { frameBackendKey } from "./types";

const FORM_TAGS = new Set(["input", "textarea", "select"]);
const NATIVE_CONTROL_TAGS = new Set(["button", "input", "select", "textarea"]);
const TEXT_AX_ROLES = new Set(["statictext", "inlinetextbox", "labeltext", "text"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);
const SENSITIVE_INPUT_TYPES = new Set([
  "password",
  "credit-card",
  "one-time-code",
  "current-password",
  "new-password",
]);

function clean(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function axValue(field?: { value?: string | number | boolean }): string | undefined {
  return field?.value === undefined ? undefined : clean(String(field.value));
}

interface ExtractedAxProps {
  inputType?: string;
  checked?: string;
  hasPopup?: string;
  expanded?: string;
  focused?: string;
  modal?: string;
  disabled?: string;
  selected?: string;
  controls?: string;
}

const TRACKED_AX_PROPS = new Set<keyof ExtractedAxProps>([
  "inputType",
  "checked",
  "hasPopup",
  "expanded",
  "focused",
  "modal",
  "disabled",
  "selected",
  "controls",
]);

function extractAxProps(node: SemanticAxNode | undefined): ExtractedAxProps | undefined {
  const properties = node?.properties;
  if (!properties?.length) return undefined;
  let result: ExtractedAxProps | undefined;
  for (const property of properties) {
    const name = property.name as keyof ExtractedAxProps | undefined;
    if (!name || !TRACKED_AX_PROPS.has(name)) continue;
    if (result && name in result) continue;
    result ??= {};
    result[name] = axValue(property.value);
  }
  return result;
}

function normalizeRole(value: string | undefined): string | undefined {
  const role = clean(value)?.toLowerCase();
  return role || undefined;
}

function nativeRole(tag: string, attrs: Record<string, string>): string | undefined {
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return attrs.multiple === undefined ? "combobox" : "listbox";
  if (tag === "a" && attrs.href) return "link";
  if (tag === "iframe") return "Iframe";
  if (tag === "dialog") return "dialog";
  if (tag === "img") return "img";
  if (tag === "table") return "table";
  if (tag === "tr") return "row";
  if (tag === "th") return "columnheader";
  if (tag === "td") return "cell";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "li") return "listitem";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "form") return "form";
  if (tag === "input") {
    const type = (attrs.type ?? "text").toLowerCase();
    if (type === "hidden") return undefined;
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    return "textbox";
  }
  return undefined;
}

function domRole(tag: string, attrs: Record<string, string>): string | undefined {
  return normalizeRole(attrs.role) ?? nativeRole(tag, attrs);
}

function resolvedRole(node: SemanticGraphNode): {
  value?: string;
  source: ResolvedSemanticNode["roleSource"];
} {
  const rawAxRole = clean(axValue(node.ax?.role));
  const axRole = normalizeRole(rawAxRole);
  const attrs = node.dom?.attrs ?? {};
  const explicitDomRole = normalizeRole(attrs.role);
  const nativeDomRole = nativeRole(node.dom?.tag.toLowerCase() ?? "", attrs);
  const usableAxRole = node.ax?.ignored !== true;
  if (usableAxRole && axRole && !["generic", "none", "presentation"].includes(axRole)) {
    return { value: rawAxRole, source: "ax" };
  }
  if (explicitDomRole) return { value: explicitDomRole, source: "dom-explicit" };
  if (nativeDomRole) return { value: nativeDomRole, source: "dom-native" };
  if (rawAxRole) {
    return { value: rawAxRole, source: usableAxRole ? "ax" : "ax-ignored" };
  }
  return { source: "none" };
}

function sensitive(node: SemanticGraphNode, axProps: ExtractedAxProps | undefined): boolean {
  const attrs = node.dom?.attrs;
  if (attrs) {
    const type = (attrs.type ?? "").toLowerCase();
    if (
      type === "password" ||
      Object.prototype.hasOwnProperty.call(attrs, RECORD_PASSWORD_ATTRIBUTE) ||
      sensitiveAutocomplete(attrs.autocomplete)
    ) {
      return true;
    }
  }
  return SENSITIVE_INPUT_TYPES.has(axProps?.inputType ?? "");
}

function inputState(
  node: SemanticGraphNode,
  role: string | undefined,
  value: string | undefined,
  isSensitive: boolean,
): VomNode["inputState"] {
  if (node.dom?.formState) {
    return isSensitive && node.dom.formState === "default" ? "filled" : node.dom.formState;
  }
  const tag = node.dom?.tag.toLowerCase() ?? "";
  if (!FORM_TAGS.has(tag) && !["textbox", "searchbox"].includes(role ?? "")) return undefined;
  if (isSensitive) return value ? "filled" : "empty";
  if (node.dom?.formValue !== undefined) {
    if (node.dom.formValue === "") return "empty";
    return node.dom.formValue === (node.dom.formDefaultValue ?? "") ? "default" : "filled";
  }
  return value ? "filled" : "empty";
}

function checkedState(
  node: SemanticGraphNode,
  role: string | undefined,
  axProps: ExtractedAxProps | undefined,
): VomNode["checked"] {
  if (
    !["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(
      role?.toLowerCase() ?? "",
    )
  )
    return undefined;
  const axChecked = node.ax?.ignored === true ? undefined : axProps?.checked;
  if (axChecked === "true" || axChecked === "false") return axChecked === "true";
  if (axChecked === "mixed") return "mixed";
  // Native live state must not be inferred from the default HTML checked attribute.
  if (node.dom?.checked !== undefined) return node.dom.checked;
  const ariaChecked = node.dom?.attrs["aria-checked"];
  if (ariaChecked === "true" || ariaChecked === "false") return ariaChecked === "true";
  return ariaChecked === "mixed" ? "mixed" : undefined;
}

function externalHrefHost(
  href: string | undefined,
  pageUrl: string | undefined,
): string | undefined {
  if (!href || !pageUrl) return undefined;
  try {
    const page = new URL(pageUrl);
    const target = new URL(href, page);
    return target.origin === page.origin ? undefined : target.hostname;
  } catch {
    return undefined;
  }
}

interface ResolveIndexes {
  domChildren: Map<SemanticNodeId, SemanticNodeId[]>;
  axChildren: Map<SemanticNodeId, SemanticNodeId[]>;
  domSiblingIndex: Map<SemanticNodeId, number>;
  axSiblingIndex: Map<SemanticNodeId, number>;
  domIdIndex: Map<string, SemanticNodeId>;
  labelForIndex: Map<string, SemanticNodeId[]>;
  axRoleLower: Map<SemanticNodeId, string>;
  domText: (nodeId: SemanticNodeId) => string | undefined;
  axText: (nodeId: SemanticNodeId) => string | undefined;
  hasNativeDescendant: (nodeId: SemanticNodeId) => boolean;
  isOrInsideNative: (nodeId: SemanticNodeId) => boolean;
  selfOrEnclosingLabel: (nodeId: SemanticNodeId) => SemanticNodeId | undefined;
}

function buildIndexes(graph: SemanticGraph): ResolveIndexes {
  const domChildren = new Map<SemanticNodeId, SemanticNodeId[]>();
  const axChildren = new Map<SemanticNodeId, SemanticNodeId[]>();
  const domSiblingIndex = new Map<SemanticNodeId, number>();
  const axSiblingIndex = new Map<SemanticNodeId, number>();
  const domIdIndex = new Map<string, SemanticNodeId>();
  const labelForIndex = new Map<string, SemanticNodeId[]>();
  const axRoleLower = new Map<SemanticNodeId, string>();
  for (const node of graph.nodes.values()) {
    if (node.ax?.role?.value !== undefined) {
      const role = normalizeRole(String(node.ax.role.value));
      if (role) axRoleLower.set(node.id, role);
    }
    if (node.domParentId) {
      const children = domChildren.get(node.domParentId) ?? [];
      domSiblingIndex.set(node.id, children.length);
      children.push(node.id);
      domChildren.set(node.domParentId, children);
    }
    if (node.axParentId) {
      const children = axChildren.get(node.axParentId) ?? [];
      children.push(node.id);
      axChildren.set(node.axParentId, children);
    }
    const id = clean(node.dom?.attrs.id);
    if (id) domIdIndex.set(`${node.frameId}\u0000${id}`, node.id);
    const targetId = clean(node.dom?.attrs.for);
    if (node.dom?.tag.toLowerCase() === "label" && targetId) {
      const key = `${node.frameId}\u0000${targetId}`;
      const labels = labelForIndex.get(key) ?? [];
      labels.push(node.id);
      labelForIndex.set(key, labels);
    }
  }

  for (const [parentId, children] of axChildren) {
    if (children.length > 1) {
      const order = graph.nodes.get(parentId)?.ax?.childIds;
      if (order && order.length > 0) {
        let alreadyOrdered = true;
        let cursor = 0;
        for (let i = 0; i < children.length; i++) {
          const axId = graph.nodes.get(children[i])?.axNodeId;
          if (!axId) {
            alreadyOrdered = false;
            break;
          }
          while (cursor < order.length && order[cursor] !== axId) cursor++;
          if (cursor >= order.length) {
            alreadyOrdered = false;
            break;
          }
          cursor++;
        }
        if (!alreadyOrdered) {
          const orderByAxId = new Map(order.map((nodeId, index) => [nodeId, index]));
          children.sort((a, b) => {
            const aIndex = orderByAxId.get(graph.nodes.get(a)?.axNodeId ?? "") ?? -1;
            const bIndex = orderByAxId.get(graph.nodes.get(b)?.axNodeId ?? "") ?? -1;
            return (
              (aIndex < 0 ? Number.MAX_SAFE_INTEGER : aIndex) -
              (bIndex < 0 ? Number.MAX_SAFE_INTEGER : bIndex)
            );
          });
        }
      }
    }
    for (let index = 0; index < children.length; index += 1) {
      axSiblingIndex.set(children[index], index);
    }
  }

  const textMemo = new Map<SemanticNodeId, string | undefined>();
  const resolvingText = new Set<SemanticNodeId>();
  const domText = (nodeId: SemanticNodeId): string | undefined => {
    if (textMemo.has(nodeId)) return textMemo.get(nodeId);
    if (resolvingText.has(nodeId)) return undefined;
    const node = graph.nodes.get(nodeId);
    if (!node || node.excluded) {
      textMemo.set(nodeId, undefined);
      return undefined;
    }
    resolvingText.add(nodeId);
    const parts: string[] = [];
    let joinedLength = 0;
    const own = clean(node.dom?.textContent);
    if (own) {
      parts.push(own);
      joinedLength = own.length;
    }
    for (const childId of domChildren.get(nodeId) ?? []) {
      const child = graph.nodes.get(childId);
      if (!child || child.excluded) continue;
      const childRole = child.dom
        ? domRole(child.dom.tag.toLowerCase(), child.dom.attrs)
        : undefined;
      if (childRole && INTERACTIVE_ROLES.has(childRole)) continue;
      const childText = domText(childId);
      if (childText) {
        joinedLength += (parts.length > 0 ? 1 : 0) + childText.length;
        parts.push(childText);
      }
      if (joinedLength >= 240) break;
    }
    resolvingText.delete(nodeId);
    const result = parts.length === 0 ? undefined : clean(parts.join(" ").slice(0, 240));
    textMemo.set(nodeId, result);
    return result;
  };

  const axTextMemo = new Map<SemanticNodeId, string | undefined>();
  const resolvingAxText = new Set<SemanticNodeId>();
  const axText = (nodeId: SemanticNodeId): string | undefined => {
    if (axTextMemo.has(nodeId)) return axTextMemo.get(nodeId);
    if (resolvingAxText.has(nodeId)) return undefined;
    const node = graph.nodes.get(nodeId);
    if (!node || node.excluded) {
      axTextMemo.set(nodeId, undefined);
      return undefined;
    }
    resolvingAxText.add(nodeId);
    const complete = (value: string | undefined): string | undefined => {
      resolvingAxText.delete(nodeId);
      axTextMemo.set(nodeId, value);
      return value;
    };
    const role = axRoleLower.get(nodeId) ?? "";
    if (TEXT_AX_ROLES.has(role)) {
      const own = clean(axValue(node.ax?.name) ?? axValue(node.ax?.value));
      if (own) return complete(own);
    }
    const parts: string[] = [];
    let joinedLength = 0;
    for (const childId of axChildren.get(nodeId) ?? []) {
      const child = graph.nodes.get(childId);
      if (!child || child.excluded) continue;
      const childRole = axRoleLower.get(childId) ?? "";
      if (INTERACTIVE_ROLES.has(childRole)) continue;
      const childText = axText(childId);
      if (childText) {
        joinedLength += (parts.length > 0 ? 1 : 0) + childText.length;
        parts.push(childText);
      }
      if (joinedLength >= 240) break;
    }
    return complete(parts.length === 0 ? undefined : clean(parts.join(" ").slice(0, 240)));
  };

  const nativeMemo = new Map<SemanticNodeId, boolean>();
  const hasNativeDescendant = (nodeId: SemanticNodeId): boolean => {
    const cached = nativeMemo.get(nodeId);
    if (cached !== undefined) return cached;
    nativeMemo.set(nodeId, false);
    for (const childId of domChildren.get(nodeId) ?? []) {
      const child = graph.nodes.get(childId);
      const childRole =
        (child?.ax?.ignored === true ? undefined : axRoleLower.get(childId)) ??
        (child?.dom ? domRole(child.dom.tag.toLowerCase(), child.dom.attrs) : undefined);
      if (
        (child?.dom && NATIVE_CONTROL_TAGS.has(child.dom.tag.toLowerCase())) ||
        INTERACTIVE_ROLES.has(childRole ?? "") ||
        hasNativeDescendant(childId)
      ) {
        nativeMemo.set(nodeId, true);
        return true;
      }
    }
    return false;
  };

  const insideNativeMemo = new Map<SemanticNodeId, boolean>();
  const visitingInsideNative = new Set<SemanticNodeId>();
  const isOrInsideNative = (nodeId: SemanticNodeId): boolean => {
    const cached = insideNativeMemo.get(nodeId);
    if (cached !== undefined) return cached;
    if (visitingInsideNative.has(nodeId)) return false;
    visitingInsideNative.add(nodeId);
    const node = graph.nodes.get(nodeId);
    const value = !node
      ? false
      : Boolean(node.dom && NATIVE_CONTROL_TAGS.has(node.dom.tag.toLowerCase())) ||
        (node.domParentId ? isOrInsideNative(node.domParentId) : false);
    visitingInsideNative.delete(nodeId);
    insideNativeMemo.set(nodeId, value);
    return value;
  };

  const enclosingLabelMemo = new Map<SemanticNodeId, SemanticNodeId | undefined>();
  const visitingLabel = new Set<SemanticNodeId>();
  const selfOrEnclosingLabel = (nodeId: SemanticNodeId): SemanticNodeId | undefined => {
    if (enclosingLabelMemo.has(nodeId)) return enclosingLabelMemo.get(nodeId);
    if (visitingLabel.has(nodeId)) return undefined;
    visitingLabel.add(nodeId);
    const node = graph.nodes.get(nodeId);
    const value = !node
      ? undefined
      : node.dom?.tag.toLowerCase() === "label"
        ? nodeId
        : node.domParentId
          ? selfOrEnclosingLabel(node.domParentId)
          : undefined;
    visitingLabel.delete(nodeId);
    enclosingLabelMemo.set(nodeId, value);
    return value;
  };

  return {
    domChildren,
    axChildren,
    domSiblingIndex,
    axSiblingIndex,
    domIdIndex,
    labelForIndex,
    axRoleLower,
    domText,
    axText,
    hasNativeDescendant,
    isOrInsideNative,
    selfOrEnclosingLabel,
  };
}

function ariaLabelledText(node: SemanticGraphNode, indexes: ResolveIndexes): string | undefined {
  const ids = (node.dom?.attrs["aria-labelledby"] ?? "").split(/\s+/).filter(Boolean);
  const parts = ids.flatMap((id) => {
    const target = indexes.domIdIndex.get(`${node.frameId}\u0000${id}`);
    return target ? (indexes.domText(target) ?? []) : [];
  });
  return clean(parts.join(" "));
}

function nativeLabelText(node: SemanticGraphNode, indexes: ResolveIndexes): string | undefined {
  const id = clean(node.dom?.attrs.id);
  if (id) {
    const labels = indexes.labelForIndex.get(`${node.frameId}\u0000${id}`);
    if (labels?.length) {
      const explicit = clean(
        labels
          .map((labelId) => indexes.domText(labelId))
          .filter(Boolean)
          .join(" "),
      );
      if (explicit) return explicit;
    }
  }
  const labelId = node.domParentId ? indexes.selfOrEnclosingLabel(node.domParentId) : undefined;
  return labelId ? indexes.domText(labelId) : undefined;
}

function precedingAxText(
  node: SemanticGraphNode,
  graph: SemanticGraph,
  indexes: ResolveIndexes,
): string | undefined {
  if (!node.axParentId) return undefined;
  const siblings = indexes.axChildren.get(node.axParentId) ?? [];
  const index = indexes.axSiblingIndex.get(node.id) ?? -1;
  for (let offset = 1; offset <= 4 && index - offset >= 0; offset += 1) {
    const siblingId = siblings[index - offset];
    const sibling = graph.nodes.get(siblingId);
    if (!sibling || sibling.excluded) continue;
    const role = indexes.axRoleLower.get(siblingId) ?? "";
    if (INTERACTIVE_ROLES.has(role)) break;
    if (!TEXT_AX_ROLES.has(role) && role !== "generic") continue;
    const text = clean(axValue(sibling.ax?.name) ?? axValue(sibling.ax?.value))?.replace(
      /[：:]\s*$/,
      "",
    );
    if (text && text.length <= 80) return text;
  }
  return undefined;
}

function precedingDomText(
  node: SemanticGraphNode,
  graph: SemanticGraph,
  indexes: ResolveIndexes,
): string | undefined {
  if (!node.domParentId) return undefined;
  const siblings = indexes.domChildren.get(node.domParentId) ?? [];
  const index = indexes.domSiblingIndex.get(node.id) ?? -1;
  for (let offset = 1; offset <= 4 && index - offset >= 0; offset += 1) {
    const sibling = graph.nodes.get(siblings[index - offset]);
    if (!sibling || sibling.excluded) continue;
    const siblingRole = domRole(sibling.dom?.tag.toLowerCase() ?? "", sibling.dom?.attrs ?? {});
    if (siblingRole && INTERACTIVE_ROLES.has(siblingRole.toLowerCase())) break;
    const text = indexes.domText(siblings[index - offset])?.replace(/[：:]\s*$/, "");
    if (text && text.length <= 80) return text;
  }
  return undefined;
}

const EMPTY_ATTRS: Record<string, string> = {};

function resolvedName(
  node: SemanticGraphNode,
  role: string | undefined,
  tag: string,
  axProps: ExtractedAxProps | undefined,
  graph: SemanticGraph,
  indexes: ResolveIndexes,
  supplementalNames: ReadonlyMap<string, string>,
  identifierFallback: boolean,
): string | undefined {
  const attrs = node.dom?.attrs ?? EMPTY_ATTRS;
  const axIgnored = node.ax?.ignored === true;
  let name =
    (axIgnored ? undefined : axValue(node.ax?.name)) ??
    (attrs["aria-labelledby"] ? ariaLabelledText(node, indexes) : undefined) ??
    clean(attrs["aria-label"]) ??
    nativeLabelText(node, indexes) ??
    clean(attrs.title) ??
    clean(attrs.alt) ??
    (axIgnored ? undefined : indexes.axText(node.id)) ??
    indexes.domText(node.id);
  if (name === undefined) {
    const formControl = FORM_TAGS.has(tag);
    if (formControl) {
      name =
        precedingAxText(node, graph, indexes) ??
        precedingDomText(node, graph, indexes) ??
        clean(node.dom?.formPlaceholder ?? attrs.placeholder);
    }
    if (name === undefined) {
      const interactive =
        INTERACTIVE_ROLES.has(role?.toLowerCase() ?? "") || NATIVE_CONTROL_TAGS.has(tag);
      if (
        !formControl &&
        interactive &&
        node.backendNodeId !== undefined &&
        supplementalNames.size > 0
      ) {
        name = clean(supplementalNames.get(frameBackendKey(node.frameId, node.backendNodeId)));
      }
      if (name === undefined && identifierFallback && interactive) {
        name = stableIdentifierName(attrs);
      }
    }
  }
  const hasPopup = axProps?.hasPopup;
  if (name && hasPopup && hasPopup !== "false") {
    name = axProps?.expanded === "true" ? `${name} [expanded]` : `${name} [has-submenu]`;
  }
  if (!name && role?.toLowerCase() === "iframe") return clean(attrs.id);
  return name;
}

function nearbyText(node: SemanticGraphNode, indexes: ResolveIndexes): string | undefined {
  if (!node.domParentId) return undefined;
  const siblings = indexes.domChildren.get(node.domParentId);
  if (!siblings || siblings.length <= 1) return undefined;
  const index = indexes.domSiblingIndex.get(node.id) ?? -1;
  if (index < 0) return undefined;
  const start = Math.max(0, index - 3);
  const end = Math.min(siblings.length, index + 4);
  const texts: string[] = [];
  for (let i = start; i < end && texts.length < 3; i += 1) {
    const id = siblings[i];
    if (id === node.id) continue;
    const text = indexes.domText(id);
    if (text) texts.push(text);
  }
  return texts.length === 0 ? undefined : clean(texts.join(" "));
}

const MAX_INLINE_SELECT_OPTIONS = 10;

function extractSelectOptions(
  selectNode: SemanticGraphNode,
  sourceValue: string | undefined,
  graph: SemanticGraph,
  indexes: ResolveIndexes,
): { options: VomSelectOption[]; truncated: boolean } | undefined {
  const options: VomSelectOption[] = [];
  let truncated = false;
  const domKids = indexes.domChildren.get(selectNode.id);
  const useDom = Boolean(domKids && domKids.length > 0);
  const visit = (childIds: readonly SemanticNodeId[] | undefined): void => {
    if (!childIds || truncated) return;
    for (const childId of childIds) {
      const child = graph.nodes.get(childId);
      if (!child || child.excluded) continue;
      const cTag = child.dom?.tag.toLowerCase() ?? "";
      const cRole = indexes.axRoleLower.get(childId) ?? normalizeRole(child.dom?.attrs.role) ?? "";
      if (cTag === "optgroup" || cRole === "group" || cRole === "menulistpopup") {
        visit(useDom ? indexes.domChildren.get(childId) : indexes.axChildren.get(childId));
        if (truncated) return;
        continue;
      }
      if (cTag !== "option" && cRole !== "option" && cRole !== "menuitem") continue;
      const optAttrs = child.dom?.attrs ?? {};
      const optLabel =
        clean(optAttrs.label) ??
        clean(child.dom?.textContent) ??
        clean(axValue(child.ax?.name)) ??
        "";
      const hasValueAttr = Object.prototype.hasOwnProperty.call(optAttrs, "value");
      const optValue = hasValueAttr
        ? optAttrs.value
        : (clean(child.dom?.textContent) ?? axValue(child.ax?.value) ?? optLabel);
      if (!optValue && !optLabel) continue;
      if (options.length >= MAX_INLINE_SELECT_OPTIONS) {
        truncated = true;
        return;
      }
      const optAxProps = extractAxProps(child.ax);
      let optSelected = false;
      if (child.dom?.checked !== undefined) {
        optSelected = child.dom.checked === true;
      } else if (child.ax?.ignored !== true && optAxProps?.selected !== undefined) {
        optSelected = optAxProps.selected === "true";
      } else if (sourceValue !== undefined) {
        optSelected = optValue === sourceValue;
      } else {
        optSelected = Object.prototype.hasOwnProperty.call(optAttrs, "selected");
      }
      options.push({
        value: optValue,
        label: optLabel || optValue,
        ...(optSelected ? { selected: true } : {}),
      });
    }
  };
  visit(useDom ? domKids : indexes.axChildren.get(selectNode.id));
  return options.length > 0 ? { options, truncated } : undefined;
}

function createRowAnchorResolver(graph: SemanticGraph, indexes: ResolveIndexes) {
  const pureSlotMemo = new Map<SemanticNodeId, string>();
  const formAncestorMemo = new Map<SemanticNodeId, boolean>();
  const renderedDescendantMemo = new Map<SemanticNodeId, boolean>();
  const poolClassCounts = new Map<SemanticNodeId, Map<string, number>>();

  const domFacts = (node: SemanticGraphNode | undefined): Partial<NodeFacts> | undefined =>
    node?.dom as Partial<NodeFacts> | undefined;

  const lightDomParentId = (node: SemanticGraphNode | undefined): SemanticNodeId | undefined => {
    const pid = node?.domParentId;
    if (!pid) return undefined;
    const p = domFacts(graph.nodes.get(pid));
    if (!p || p.nodeType === 11 || p.tag?.startsWith("#")) return undefined;
    return pid;
  };

  const hasFormAncestor = (nodeId: SemanticNodeId): boolean => {
    const hit = formAncestorMemo.get(nodeId);
    if (hit !== undefined) return hit;
    const node = graph.nodes.get(nodeId);
    if (!node) {
      formAncestorMemo.set(nodeId, false);
      return false;
    }
    if (node.dom?.inForm === true || node.dom?.tag.toLowerCase() === "form") {
      formAncestorMemo.set(nodeId, true);
      return true;
    }
    const pid = lightDomParentId(node);
    const res = pid ? hasFormAncestor(pid) : false;
    formAncestorMemo.set(nodeId, res);
    return res;
  };

  const hasRenderedDescendant = (nodeId: SemanticNodeId): boolean => {
    const cached = renderedDescendantMemo.get(nodeId);
    if (cached !== undefined) return cached;
    for (const cid of indexes.domChildren.get(nodeId) ?? []) {
      const c = graph.nodes.get(cid);
      const cf = domFacts(c);
      if (!c || !cf || c.excluded || cf.nodeType === 11 || cf.tag?.startsWith("#")) continue;
      if (cf.rendered === true || hasRenderedDescendant(cid)) {
        renderedDescendantMemo.set(nodeId, true);
        return true;
      }
    }
    renderedDescendantMemo.set(nodeId, false);
    return false;
  };

  const countSameClassDivs = (poolId: SemanticNodeId, cls: string): number => {
    let byClass = poolClassCounts.get(poolId);
    if (!byClass) {
      byClass = new Map<string, number>();
      for (const cid of indexes.domChildren.get(poolId) ?? []) {
        const c = graph.nodes.get(cid);
        if (!c || c.excluded || c.dom?.tag.toLowerCase() !== "div") continue;
        const cCls = (c.dom.attrs.class ?? "").trim();
        if (!cCls) continue;
        byClass.set(cCls, (byClass.get(cCls) ?? 0) + 1);
      }
      poolClassCounts.set(poolId, byClass);
    }
    return byClass.get(cls) ?? 0;
  };

  const isSkippedSlotNode = (n: SemanticGraphNode): boolean => {
    const nf = domFacts(n);
    if (n.excluded || !n.dom || nf?.nodeType === 11 || n.dom.tag.startsWith("#")) return true;
    if (n.dom.rendered === false) {
      // `display: contents` wrappers carry no layout box (`layout === undefined`)
      // while their descendants render; `display: none` suppresses the whole subtree.
      const disp = nf?.layout?.styles.display;
      if (nf?.layout !== undefined || disp === "none" || !hasRenderedDescendant(n.id)) {
        return true;
      }
    }
    const st = nf?.layout?.styles;
    if (st) {
      if (st.visibility === "hidden" || st.visibility === "collapse") return true;
      if (st.opacity && st.opacity !== "1") {
        const op = Number.parseFloat(st.opacity);
        if (Number.isFinite(op) && op < 0.05) return true;
      }
      if (st["font-size"] && st["font-size"] !== "16px") {
        const fs = Number.parseFloat(st["font-size"]);
        if (Number.isFinite(fs) && fs <= 1.5) return true;
      }
    }
    const attrs = n.dom.attrs;
    if (
      Object.prototype.hasOwnProperty.call(attrs, "hidden") ||
      (attrs["aria-hidden"] ?? "").toLowerCase() === "true"
    ) {
      return true;
    }
    const tag = n.dom.tag.toLowerCase();
    if (NON_ANCHOR_TAGS.has(tag)) return true;
    const explicitRole = (attrs.role ?? "").trim().toLowerCase();
    if (NON_ANCHOR_ROLES.has(explicitRole)) return true;
    return sensitive(n, undefined);
  };

  const pureSlotText = (nodeId: SemanticNodeId): string => {
    const cached = pureSlotMemo.get(nodeId);
    if (cached !== undefined) return cached;
    const n = graph.nodes.get(nodeId);
    if (!n || isSkippedSlotNode(n)) {
      pureSlotMemo.set(nodeId, "");
      return "";
    }
    const parts: string[] = [];
    let len = 0;
    const own = clean(n.dom?.textContent);
    if (own) {
      parts.push(own);
      len += own.length;
    }
    for (const cid of indexes.domChildren.get(nodeId) ?? []) {
      const sub = pureSlotText(cid);
      if (sub) {
        parts.push(sub);
        len += sub.length + 1;
        if (len >= MAX_SLOT_TEXT_SCAN_CHARS) break;
      }
    }
    const out = parts.length === 0 ? "" : (clean(parts.join(" ")) ?? "");
    pureSlotMemo.set(nodeId, out);
    return out;
  };

  const slotTextExcluding = (
    nodeId: SemanticNodeId,
    targetId: SemanticNodeId,
    ancestorsOfTarget: ReadonlySet<SemanticNodeId>,
  ): string => {
    if (nodeId === targetId) return "";
    if (!ancestorsOfTarget.has(nodeId)) return pureSlotText(nodeId);
    const n = graph.nodes.get(nodeId);
    if (!n || isSkippedSlotNode(n)) return "";
    const parts: string[] = [];
    let len = 0;
    const own = clean(n.dom?.textContent);
    if (own) {
      parts.push(own);
      len += own.length;
    }
    for (const cid of indexes.domChildren.get(nodeId) ?? []) {
      const sub = slotTextExcluding(cid, targetId, ancestorsOfTarget);
      if (sub) {
        parts.push(sub);
        len += sub.length + 1;
        if (len >= MAX_SLOT_TEXT_SCAN_CHARS) break;
      }
    }
    return parts.length === 0 ? "" : (clean(parts.join(" ")) ?? "");
  };

  const findSemanticRow = (node: SemanticGraphNode): SemanticGraphNode | undefined => {
    let curId = lightDomParentId(node);
    for (let hop = 0; hop < MAX_SEMANTIC_ROW_HOPS && curId; hop++) {
      const cur = graph.nodes.get(curId);
      if (!cur?.dom) break;
      const curTag = cur.dom.tag.toLowerCase();
      if (curTag === "body" || curTag === "html") break;
      const curRole = (cur.dom.attrs.role ?? "").trim().toLowerCase();
      if (curTag === "tr" || curTag === "li" || curRole === "row" || curRole === "listitem") {
        return cur;
      }
      curId = lightDomParentId(cur);
    }
    return undefined;
  };

  const findRow = (node: SemanticGraphNode): SemanticGraphNode | undefined => {
    const semanticHit = findSemanticRow(node);
    if (semanticHit) return semanticHit;
    if (hasFormAncestor(node.id)) return undefined;
    let curId = lightDomParentId(node);
    for (let hop = 0; hop < MAX_VIRTUAL_DIV_ROW_HOPS && curId; hop++) {
      const cur = graph.nodes.get(curId);
      if (!cur?.dom) break;
      const curTag = cur.dom.tag.toLowerCase();
      if (ROW_STOP_TAGS.has(curTag)) break;
      if (curTag === "div") {
        const curRole = (cur.dom.attrs.role ?? "").trim().toLowerCase();
        const cls = (cur.dom.attrs.class ?? "").trim();
        const curKids = indexes.domChildren.get(cur.id) ?? [];
        const poolId = lightDomParentId(cur);
        const pool = poolId ? graph.nodes.get(poolId) : undefined;
        const poolTag = pool?.dom?.tag.toLowerCase() ?? "";
        if (
          cls &&
          (!curRole || curRole === "generic" || curRole === "none" || curRole === "presentation") &&
          curKids.length >= 1 &&
          curKids.length <= 12 &&
          poolId &&
          !VIRTUAL_POOL_EXCLUDED_TAGS.has(poolTag) &&
          countSameClassDivs(poolId, cls) >= 4
        ) {
          return cur;
        }
      }
      curId = lightDomParentId(cur);
    }
    return undefined;
  };

  return (node: SemanticGraphNode): string | undefined => {
    const startParentId = lightDomParentId(node);
    if (!node.dom || !startParentId) return undefined;
    const row = findRow(node);
    if (!row?.dom) return undefined;

    const ancestors = new Set<SemanticNodeId>();
    let walk: SemanticNodeId | undefined = startParentId;
    let guard = 0;
    while (walk && walk !== row.id && guard++ < 16) {
      ancestors.add(walk);
      walk = lightDomParentId(graph.nodes.get(walk));
    }

    const selfText = (indexes.domText(node.id) ?? clean(node.dom.textContent) ?? "").toLowerCase();
    const selfAria = (clean(node.dom.attrs["aria-label"]) ?? "").toLowerCase();
    const accept = (raw: string | undefined): string | undefined => {
      if (!raw) return undefined;
      if (VOLATILE_ROW_TEXT_RE.test(raw)) return undefined;
      const lower = raw.toLowerCase();
      if ((selfText && lower === selfText) || (selfAria && lower === selfAria)) return undefined;
      const cps = [...raw];
      return cps.length > MAX_ROW_ANCHOR_CHARS
        ? cps.slice(0, MAX_ROW_ANCHOR_CHARS).join("").trim()
        : raw;
    };

    const direct = accept(clean(row.dom.textContent));
    if (direct) return direct;
    for (const slotId of indexes.domChildren.get(row.id) ?? []) {
      const slotFacts = domFacts(graph.nodes.get(slotId));
      if (slotFacts?.nodeType === 11 || slotFacts?.tag?.startsWith("#")) continue;
      const text = slotTextExcluding(slotId, node.id, ancestors);
      const hit = accept(text);
      if (hit) return hit;
    }
    return undefined;
  };
}

export function resolveSemanticGraph(
  graph: SemanticGraph,
  options: {
    supplementalNames?: ReadonlyMap<string, string>;
    identifierFallback?: boolean;
  } = {},
): ResolvedSemanticGraph {
  const indexes = buildIndexes(graph);
  const resolveRowAnchor = createRowAnchorResolver(graph, indexes);
  const supplementalNames = options.supplementalNames ?? new Map<string, string>();
  const identifierFallback = options.identifierFallback ?? true;
  const nodes = new Map<SemanticNodeId, ResolvedSemanticNode>();
  for (const node of graph.nodes.values()) {
    const axProps = extractAxProps(node.ax);
    const axIgnored = node.ax?.ignored === true;
    const roleResolution = resolvedRole(node);
    const role = roleResolution.value;
    const tag = node.dom?.tag.toLowerCase() ?? "";
    const name = resolvedName(
      node,
      role,
      tag,
      axProps,
      graph,
      indexes,
      supplementalNames,
      identifierFallback,
    );
    const isSensitive = sensitive(node, axProps);
    const sourceValue = node.dom?.formValue ?? axValue(node.ax?.value);
    const value = isSensitive ? undefined : sourceValue;
    const checked = checkedState(node, role, axProps);
    const rawAttrs = node.dom?.attrs;
    const attrs = rawAttrs ? { ...rawAttrs } : {};
    if (isSensitive && "value" in attrs) delete attrs.value;
    if (RECORD_PASSWORD_ATTRIBUTE in attrs) delete attrs[RECORD_PASSWORD_ATTRIBUTE];
    const frame = graph.frames.get(node.frameId);
    const inForm = node.dom?.inForm;
    const nearby = nearbyText(node, indexes);
    const placeholder = clean(node.dom?.formPlaceholder ?? attrs.placeholder);
    const textContent = clean(node.dom?.textContent);
    const selectInfo =
      tag === "select" && !isSensitive
        ? extractSelectOptions(node, sourceValue, graph, indexes)
        : undefined;
    const mayBeReferenced =
      node.backendNodeId !== undefined &&
      !node.excluded &&
      (INTERACTIVE_ROLES.has(role?.toLowerCase() ?? "") ||
        NATIVE_CONTROL_TAGS.has(tag) ||
        tag === "a" ||
        tag === "summary" ||
        node.dom?.clickable === true ||
        node.dom?.cursor === "pointer");
    const rowAnchor = mayBeReferenced ? resolveRowAnchor(node) : undefined;
    const vom: ResolvedSemanticNode["vom"] = {
      tag,
      rect: node.dom?.rect ?? null,
      paintOrder: node.dom?.paintOrder ?? 0,
      position: node.dom?.position || "static",
      pointerEvents: node.dom?.pointerEvents || "auto",
      ...(node.dom?.cursor ? { cursor: node.dom.cursor } : {}),
      ...(node.dom?.clickable ? { clickable: true } : {}),
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(inForm !== undefined ? { inForm } : {}),
      ...(checked !== undefined ? { checked } : {}),
      ...(!axIgnored && axProps?.focused === "true" ? { focused: true } : {}),
      ...(placeholder ? { placeholder } : {}),
      attrs,
      ...(textContent ? { text: textContent } : {}),
      ...(nearby ? { nearbyText: nearby } : {}),
      ...(selectInfo
        ? {
            selectOptions: selectInfo.options,
            ...(selectInfo.truncated ? { selectOptionsTruncated: true } : {}),
          }
        : {}),
      ...(rowAnchor ? { rowAnchor } : {}),
      inputState: inputState(node, role, sourceValue, isSensitive),
      sensitive: isSensitive,
      // An available AX result is authoritative, including ignored/nonmodal nodes.
      modal: node.ax
        ? !axIgnored && axProps?.modal === "true"
        : (attrs["aria-modal"] ?? "").toLowerCase() === "true",
      disabled:
        (!axIgnored && axProps?.disabled === "true") ||
        Object.prototype.hasOwnProperty.call(attrs, "disabled") ||
        (attrs["aria-disabled"] ?? "").toLowerCase() === "true",
      inert: Object.prototype.hasOwnProperty.call(attrs, "inert"),
      hasNativeDescendant: indexes.hasNativeDescendant(node.id),
      insideNative: node.domParentId ? indexes.isOrInsideNative(node.domParentId) : false,
      ...(role?.toLowerCase() === "link" ? { href: externalHrefHost(attrs.href, frame?.url) } : {}),
    };
    const selected = axIgnored ? undefined : axProps?.selected;
    const expanded = axIgnored ? undefined : axProps?.expanded;
    const controls = axIgnored ? undefined : axProps?.controls;
    if ((selected === "true" || selected === "false") && !vom.attrs?.["aria-selected"]) {
      vom.attrs = { ...(vom.attrs ?? {}), "aria-selected": selected };
    }
    if (expanded === "true" && !vom.attrs?.["aria-expanded"]) {
      vom.attrs = { ...(vom.attrs ?? {}), "aria-expanded": "true" };
    }
    if (controls && !vom.attrs?.["aria-controls"]) {
      vom.attrs = { ...(vom.attrs ?? {}), "aria-controls": controls };
    }
    nodes.set(node.id, {
      ...node,
      vom,
      referenceable: node.backendNodeId !== undefined,
      roleSource: roleResolution.source,
    });
  }
  return { ...graph, nodes };
}
