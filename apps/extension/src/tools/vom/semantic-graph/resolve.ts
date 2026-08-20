import type { VomNode } from "@browser-skill/vom";
import type {
  ResolvedSemanticGraph,
  ResolvedSemanticNode,
  SemanticAxNode,
  SemanticGraph,
  SemanticGraphNode,
  SemanticNodeId,
} from "./types";

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

function axProperty(node: SemanticAxNode | undefined, name: string): string | undefined {
  return axValue(node?.properties?.find((property) => property.name === name)?.value);
}

function normalizeRole(value: string | undefined): string | undefined {
  const role = clean(value)?.toLowerCase();
  return role || undefined;
}

function nativeRole(tag: string, attrs: Record<string, string>): string | undefined {
  const explicit = normalizeRole(attrs.role);
  if (explicit) return explicit;
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

function resolvedRole(node: SemanticGraphNode): string | undefined {
  const rawAxRole = clean(axValue(node.ax?.role));
  const axRole = normalizeRole(rawAxRole);
  const domRole = nativeRole(node.dom?.tag.toLowerCase() ?? "", node.dom?.attrs ?? {});
  if (!axRole || ["generic", "none", "presentation"].includes(axRole)) {
    return domRole ?? rawAxRole;
  }
  return rawAxRole;
}

function sensitive(node: SemanticGraphNode): boolean {
  const attrs = node.dom?.attrs ?? {};
  const type = (attrs.type ?? "").toLowerCase();
  const autocomplete = (attrs.autocomplete ?? "").toLowerCase();
  return (
    type === "password" ||
    autocomplete.startsWith("cc-") ||
    SENSITIVE_INPUT_TYPES.has(autocomplete) ||
    SENSITIVE_INPUT_TYPES.has(axProperty(node.ax, "inputType") ?? "")
  );
}

function inputState(
  node: SemanticGraphNode,
  role: string | undefined,
  value: string | undefined,
  isSensitive: boolean,
): VomNode["inputState"] {
  if (node.dom?.formState) return node.dom.formState;
  const tag = node.dom?.tag.toLowerCase() ?? "";
  if (!FORM_TAGS.has(tag) && !["textbox", "searchbox"].includes(role ?? "")) return undefined;
  if (isSensitive) return value ? "filled" : "empty";
  if (node.dom?.formValue !== undefined) {
    if (node.dom.formValue === "") return "empty";
    return node.dom.formValue === (node.dom.formDefaultValue ?? "") ? "default" : "filled";
  }
  return value ? "filled" : "empty";
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

function iconKeyword(value: string | undefined): string | undefined {
  const token = clean(value)
    ?.split(/[#/.\s:_-]+/)
    .filter(Boolean)
    .pop();
  return token && /^[a-z][a-z0-9_-]{1,32}$/i.test(token) ? token.toLowerCase() : undefined;
}

interface ResolveIndexes {
  domChildren: Map<SemanticNodeId, SemanticNodeId[]>;
  axChildren: Map<SemanticNodeId, SemanticNodeId[]>;
  domIdIndex: Map<string, SemanticNodeId>;
  labelForIndex: Map<string, SemanticNodeId[]>;
  domText: (nodeId: SemanticNodeId) => string | undefined;
  axText: (nodeId: SemanticNodeId) => string | undefined;
  hasNativeDescendant: (nodeId: SemanticNodeId) => boolean;
}

function buildIndexes(graph: SemanticGraph): ResolveIndexes {
  const domChildren = new Map<SemanticNodeId, SemanticNodeId[]>();
  const axChildren = new Map<SemanticNodeId, SemanticNodeId[]>();
  const domIdIndex = new Map<string, SemanticNodeId>();
  const labelForIndex = new Map<string, SemanticNodeId[]>();
  for (const node of graph.nodes.values()) {
    if (node.domParentId) {
      const children = domChildren.get(node.domParentId) ?? [];
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
    const order = graph.nodes.get(parentId)?.ax?.childIds ?? [];
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

  const textMemo = new Map<SemanticNodeId, string | undefined>();
  const resolvingText = new Set<SemanticNodeId>();
  const domText = (nodeId: SemanticNodeId): string | undefined => {
    if (textMemo.has(nodeId)) return textMemo.get(nodeId);
    if (resolvingText.has(nodeId)) return undefined;
    resolvingText.add(nodeId);
    const node = graph.nodes.get(nodeId);
    const parts: string[] = [];
    const own = clean(node?.dom?.textContent);
    if (own) parts.push(own);
    for (const childId of domChildren.get(nodeId) ?? []) {
      const child = graph.nodes.get(childId);
      const childRole = child
        ? nativeRole(child.dom?.tag.toLowerCase() ?? "", child.dom?.attrs ?? {})
        : undefined;
      if (childRole && INTERACTIVE_ROLES.has(childRole.toLowerCase())) continue;
      const childText = domText(childId);
      if (childText) parts.push(childText);
      if (parts.join(" ").length >= 240) break;
    }
    resolvingText.delete(nodeId);
    const result = clean(parts.join(" ").slice(0, 240));
    textMemo.set(nodeId, result);
    return result;
  };

  const axTextMemo = new Map<SemanticNodeId, string | undefined>();
  const resolvingAxText = new Set<SemanticNodeId>();
  const axText = (nodeId: SemanticNodeId): string | undefined => {
    if (axTextMemo.has(nodeId)) return axTextMemo.get(nodeId);
    if (resolvingAxText.has(nodeId)) return undefined;
    resolvingAxText.add(nodeId);
    const node = graph.nodes.get(nodeId);
    const role = normalizeRole(axValue(node?.ax?.role)) ?? "";
    const parts: string[] = [];
    if (TEXT_AX_ROLES.has(role)) {
      const own = clean(axValue(node?.ax?.name) ?? axValue(node?.ax?.value));
      if (own) parts.push(own);
    }
    for (const childId of axChildren.get(nodeId) ?? []) {
      const child = graph.nodes.get(childId);
      const childRole = normalizeRole(axValue(child?.ax?.role)) ?? "";
      if (INTERACTIVE_ROLES.has(childRole)) continue;
      const childText = axText(childId);
      if (childText) parts.push(childText);
      if (parts.join(" ").length >= 240) break;
    }
    resolvingAxText.delete(nodeId);
    const result = clean(parts.join(" ").slice(0, 240));
    axTextMemo.set(nodeId, result);
    return result;
  };

  const nativeMemo = new Map<SemanticNodeId, boolean>();
  const hasNativeDescendant = (nodeId: SemanticNodeId): boolean => {
    const cached = nativeMemo.get(nodeId);
    if (cached !== undefined) return cached;
    nativeMemo.set(nodeId, false);
    for (const childId of domChildren.get(nodeId) ?? []) {
      const child = graph.nodes.get(childId);
      const childRole =
        normalizeRole(axValue(child?.ax?.role)) ??
        (child
          ? nativeRole(child.dom?.tag.toLowerCase() ?? "", child.dom?.attrs ?? {})
          : undefined);
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

  return {
    domChildren,
    axChildren,
    domIdIndex,
    labelForIndex,
    domText,
    axText,
    hasNativeDescendant,
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

function nativeLabelText(
  node: SemanticGraphNode,
  graph: SemanticGraph,
  indexes: ResolveIndexes,
): string | undefined {
  const id = clean(node.dom?.attrs.id);
  if (id) {
    const labels = indexes.labelForIndex.get(`${node.frameId}\u0000${id}`) ?? [];
    const explicit = clean(
      labels
        .map((labelId) => indexes.domText(labelId))
        .filter(Boolean)
        .join(" "),
    );
    if (explicit) return explicit;
  }
  let parentId = node.domParentId;
  let guard = 0;
  while (parentId && guard <= graph.nodes.size) {
    const parent = graph.nodes.get(parentId);
    if (!parent) break;
    if (parent.dom?.tag.toLowerCase() === "label") return indexes.domText(parentId);
    parentId = parent.domParentId;
    guard += 1;
  }
  return undefined;
}

function precedingAxText(
  node: SemanticGraphNode,
  graph: SemanticGraph,
  indexes: ResolveIndexes,
): string | undefined {
  if (!node.axParentId) return undefined;
  const siblings = indexes.axChildren.get(node.axParentId) ?? [];
  const index = siblings.indexOf(node.id);
  for (let offset = 1; offset <= 4 && index - offset >= 0; offset += 1) {
    const sibling = graph.nodes.get(siblings[index - offset]);
    const role = normalizeRole(axValue(sibling?.ax?.role)) ?? "";
    if (INTERACTIVE_ROLES.has(role)) break;
    if (!TEXT_AX_ROLES.has(role) && role !== "generic") continue;
    const text = clean(axValue(sibling?.ax?.name) ?? axValue(sibling?.ax?.value))?.replace(
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
  const index = siblings.indexOf(node.id);
  for (let offset = 1; offset <= 4 && index - offset >= 0; offset += 1) {
    const sibling = graph.nodes.get(siblings[index - offset]);
    const siblingRole = sibling
      ? nativeRole(sibling.dom?.tag.toLowerCase() ?? "", sibling.dom?.attrs ?? {})
      : undefined;
    if (siblingRole && INTERACTIVE_ROLES.has(siblingRole.toLowerCase())) break;
    const text = indexes.domText(siblings[index - offset])?.replace(/[：:]\s*$/, "");
    if (text && text.length <= 80) return text;
  }
  return undefined;
}

function iconHint(
  nodeId: SemanticNodeId,
  graph: SemanticGraph,
  indexes: ResolveIndexes,
  depth = 0,
): string | undefined {
  if (depth > 3) return undefined;
  for (const childId of indexes.domChildren.get(nodeId) ?? []) {
    const child = graph.nodes.get(childId);
    const attrs = child?.dom?.attrs ?? {};
    const hint =
      iconKeyword(attrs["aria-label"]) ??
      iconKeyword(attrs.title) ??
      iconKeyword(attrs.href) ??
      iconKeyword(attrs["xlink:href"]) ??
      iconKeyword(axValue(child?.ax?.name)) ??
      iconKeyword(attrs.class) ??
      iconKeyword(child?.dom?.textContent);
    if (hint) return hint;
    const nested = iconHint(childId, graph, indexes, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function resolvedName(
  node: SemanticGraphNode,
  role: string | undefined,
  graph: SemanticGraph,
  indexes: ResolveIndexes,
): string | undefined {
  const attrs = node.dom?.attrs ?? {};
  const formControl = FORM_TAGS.has(node.dom?.tag.toLowerCase() ?? "");
  const descendantText = indexes.domText(node.id);
  const canUseIconHint =
    !indexes.hasNativeDescendant(node.id) &&
    (INTERACTIVE_ROLES.has(role?.toLowerCase() ?? "") ||
      node.dom?.cursor === "pointer" ||
      attrs.onclick !== undefined ||
      attrs.tabindex !== undefined);
  const candidates = [
    axValue(node.ax?.name),
    indexes.axText(node.id),
    ariaLabelledText(node, indexes),
    clean(attrs["aria-label"]),
    nativeLabelText(node, graph, indexes),
    clean(attrs.title),
    clean(attrs.alt),
    descendantText,
    formControl ? precedingAxText(node, graph, indexes) : undefined,
    formControl ? precedingDomText(node, graph, indexes) : undefined,
    formControl ? clean(node.dom?.formPlaceholder ?? attrs.placeholder) : undefined,
    canUseIconHint ? iconHint(node.id, graph, indexes) : undefined,
  ];
  let name = candidates.find((candidate) => candidate !== undefined);
  const hasPopup = axProperty(node.ax, "hasPopup");
  if (name && hasPopup && hasPopup !== "false") {
    name =
      axProperty(node.ax, "expanded") === "true" ? `${name} [expanded]` : `${name} [has-submenu]`;
  }
  if (!name && role?.toLowerCase() === "iframe") return clean(attrs.id);
  return name;
}

function insideNative(node: SemanticGraphNode, graph: SemanticGraph): boolean {
  let parentId = node.domParentId;
  let guard = 0;
  while (parentId && guard <= graph.nodes.size) {
    const parent = graph.nodes.get(parentId);
    if (!parent) break;
    if (parent.dom && NATIVE_CONTROL_TAGS.has(parent.dom.tag.toLowerCase())) return true;
    parentId = parent.domParentId;
    guard += 1;
  }
  return false;
}

function nearbyText(
  node: SemanticGraphNode,
  graph: SemanticGraph,
  indexes: ResolveIndexes,
): string | undefined {
  if (!node.domParentId) return undefined;
  const siblings = indexes.domChildren.get(node.domParentId) ?? [];
  const index = siblings.indexOf(node.id);
  if (index < 0) return undefined;
  const texts = siblings
    .slice(Math.max(0, index - 3), index + 4)
    .filter((id) => id !== node.id)
    .flatMap((id) => indexes.domText(id) ?? [])
    .slice(0, 3);
  return clean(texts.join(" "));
}

export function resolveSemanticGraph(graph: SemanticGraph): ResolvedSemanticGraph {
  const indexes = buildIndexes(graph);
  const nodes = new Map<SemanticNodeId, ResolvedSemanticNode>();
  for (const node of graph.nodes.values()) {
    const role = resolvedRole(node);
    const name = resolvedName(node, role, graph, indexes);
    const isSensitive = sensitive(node);
    const sourceValue = node.dom?.formValue ?? axValue(node.ax?.value);
    const value = isSensitive ? undefined : sourceValue;
    const attrs = { ...(node.dom?.attrs ?? {}) };
    if (isSensitive) delete attrs.value;
    const frame = graph.frames.get(node.frameId);
    const tag = node.dom?.tag.toLowerCase() ?? "";
    const vom: ResolvedSemanticNode["vom"] = {
      tag,
      rect: node.dom?.rect ?? null,
      paintOrder: node.dom?.paintOrder ?? 0,
      position: node.dom?.position || "static",
      pointerEvents: node.dom?.pointerEvents || "auto",
      ...(node.dom?.cursor ? { cursor: node.dom.cursor } : {}),
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(clean(node.dom?.formPlaceholder ?? attrs.placeholder)
        ? { placeholder: clean(node.dom?.formPlaceholder ?? attrs.placeholder) }
        : {}),
      attrs,
      ...(clean(node.dom?.textContent) ? { text: clean(node.dom?.textContent) } : {}),
      ...(nearbyText(node, graph, indexes) ? { nearbyText: nearbyText(node, graph, indexes) } : {}),
      inputState: inputState(node, role, sourceValue, isSensitive),
      sensitive: isSensitive,
      modal:
        ["dialog", "alertdialog"].includes(role?.toLowerCase() ?? "") ||
        tag === "dialog" ||
        (attrs["aria-modal"] ?? "").toLowerCase() === "true",
      disabled:
        Object.prototype.hasOwnProperty.call(attrs, "disabled") ||
        (attrs["aria-disabled"] ?? "").toLowerCase() === "true",
      inert: Object.prototype.hasOwnProperty.call(attrs, "inert"),
      hasNativeDescendant: indexes.hasNativeDescendant(node.id),
      insideNative: insideNative(node, graph),
      ...(role?.toLowerCase() === "link" ? { href: externalHrefHost(attrs.href, frame?.url) } : {}),
    };
    const selected = axProperty(node.ax, "selected");
    const expanded = axProperty(node.ax, "expanded");
    const controls = axProperty(node.ax, "controls");
    if (selected === "true" && !vom.attrs?.["aria-selected"]) {
      vom.attrs = { ...(vom.attrs ?? {}), "aria-selected": "true" };
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
    });
  }
  return { ...graph, nodes };
}
