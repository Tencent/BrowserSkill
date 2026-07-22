import { coverage, detectBlockingLayer } from "./layers";
import type {
  ActiveScopeBlock,
  BlockingLayer,
  CondSurface,
  Rect,
  VomNode,
  VomOptions,
  VomResult,
  VomScene,
} from "./types";

const SKIP_ROLES = new Set(["generic", "none", "presentation", "inlinetextbox"]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "listbox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const STRUCTURAL_ROLES = new Set([
  "alert",
  "alertdialog",
  "article",
  "banner",
  "cell",
  "columnheader",
  "complementary",
  "contentinfo",
  "definition",
  "dialog",
  "directory",
  "document",
  "feed",
  "figure",
  "form",
  "grid",
  "group",
  "heading",
  "iframe",
  "img",
  "list",
  "listitem",
  "main",
  "navigation",
  "paragraph",
  "region",
  "rootwebarea",
  "row",
  "rowgroup",
  "rowheader",
  "search",
  "section",
  "status",
  "table",
  "term",
  "toolbar",
  "tree",
  "webarea",
]);

const SENSITIVE_MASK = "•••";
const DEFAULT_MAX_DEPTH = Number.POSITIVE_INFINITY;
const DEFAULT_MAX_TOKENS = Number.POSITIVE_INFINITY;
const MAX_VALUE_LENGTH = 200;
const MAX_CUSTOM_RECOVERY_AREA = 180_000;
const MAX_RECOVERABLE_SINGLE_INTENT_AREA = 360_000;
const MAX_HANDLE_CONTEXT_ITEMS = 3;
const MAX_SURFACE_ITEMS = 12;
const MAX_SCOPE_LINES = 40;
const MAX_SEMANTIC_COLLECTIONS = 3;
const MAX_SEMANTIC_ITEMS = 20;
const MAX_SEMANTIC_CONTROLS = 8;
const MAX_SEMANTIC_ACTIONS = 6;
const MAX_SEMANTIC_FIELD_CHARS = 120;

const RECOVERY_HANDLER_ATTRS = ["onclick", "onmousedown", "onkeydown", "onkeyup", "onkeypress"];
const NATIVE_TAGS = new Set(["button", "input", "select", "textarea"]);
const GRAPHIC_ONLY_TAGS = new Set(["svg", "use", "path", "g", "symbol"]);
const EXPLICIT_RECOVERY_ROLES = new Set([
  "button",
  "menuitem",
  "switch",
  "tab",
  "checkbox",
  "radio",
]);
const WEAK_ACTION_LABELS = new Set([
  "add",
  "apply",
  "cancel",
  "delete",
  "edit",
  "go",
  "more",
  "open",
  "remove",
  "reset",
  "save",
  "select",
  "submit",
  "suspend",
  "view",
  "close",
  "confirm",
  "continue",
]);

const ACTIVE_REGION_POSITIONS = new Set(["fixed", "absolute", "sticky"]);

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function cleaned(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

function isNoisyText(value: string): boolean {
  const clean = value.trim();
  const key = clean.toLowerCase();
  if (!clean) return true;
  if (clean.includes("<![endif]") || clean.includes("<!--") || clean.includes("-->")) return true;
  if (/<\/?[a-z][^>]*>/i.test(clean)) return true;
  if (/\$\(function|document\.|window\.|\.onclick\s*=|function\s*\(|var\s+\w+\s*=/.test(clean)) {
    return true;
  }
  if (/(https?:\/\/|encodeURIComponent|site_code|target="_blank")/.test(clean)) return true;
  if (/^\[?if\s+[^\]]+\]?>?$/i.test(clean)) return true;
  if (/^<!\[endif\]?>$/i.test(clean)) return true;
  if (/^(top|header|footer|nav|bigpic|login|登录|开始|结束)[、,\s]*(开始|结束)?$/i.test(clean)) {
    return true;
  }
  if (/(^|[、,\s])(top|bigpic|登录)\s*(开始|结束)($|[、,\s])/.test(key)) return true;
  return false;
}

function cleanSemanticText(value: string | undefined): string | undefined {
  const clean = cleaned(value);
  if (!clean || isNoisyText(clean)) return undefined;
  return clean;
}

function normalizedRole(node: VomNode): string {
  return node.role?.toLowerCase() ?? "";
}

function normalizeContextKey(s: string): string {
  return s.split(/\s+/).join(" ").toLowerCase();
}

function isProbableNavigationTarget(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

function isUrlBearingStructuralAction(node: VomNode): boolean {
  const role = normalizedRole(node);
  if (!["row", "cell", "gridcell", "listitem", "rowheader"].includes(role)) return false;
  const name = cleaned(node.name);
  return name !== undefined && isProbableNavigationTarget(name);
}

function shouldRender(node: VomNode): boolean {
  if (!node.role) return false;

  const role = normalizedRole(node);
  if (SKIP_ROLES.has(role)) return false;
  if (INTERACTIVE_ROLES.has(role)) return true;
  if (STRUCTURAL_ROLES.has(role)) return true;

  return cleaned(node.name) !== undefined;
}

function shouldReference(node: VomNode): boolean {
  return INTERACTIVE_ROLES.has(normalizedRole(node)) || isUrlBearingStructuralAction(node);
}

function hasRecoveryHandler(node: VomNode): boolean {
  const attrs = node.attrs ?? {};
  return RECOVERY_HANDLER_ATTRS.some((key) => Object.prototype.hasOwnProperty.call(attrs, key));
}

function isFocusable(node: VomNode): boolean {
  const tabindex = node.attrs?.tabindex;
  if (tabindex === undefined) return false;
  const value = Number.parseInt(tabindex, 10);
  return Number.isFinite(value) && value >= 0;
}

function isContentEditable(node: VomNode): boolean {
  const contentEditable = node.attrs?.contenteditable?.toLowerCase();
  return contentEditable === "true" || contentEditable === "plaintext-only";
}

function iconKeyword(value: string | undefined): string | undefined {
  const cleanedValue = cleaned(value);
  if (!cleanedValue) return undefined;
  const last = cleanedValue
    .split(/[#/.\s:_-]+/)
    .filter(Boolean)
    .pop();
  return last && /^[a-z][a-z0-9_-]{1,32}$/i.test(last) ? last.toLowerCase() : undefined;
}

function iconHintFromSubtree(
  node: VomNode,
  children: Map<number | null, VomNode[]>,
  depth = 0,
): string | undefined {
  if (depth > 3) return undefined;
  for (const child of children.get(node.id) ?? []) {
    const attrs = child.attrs ?? {};
    const hint =
      iconKeyword(attrs["aria-label"]) ??
      iconKeyword(attrs.title) ??
      iconKeyword(attrs.href) ??
      iconKeyword(attrs["xlink:href"]) ??
      iconKeyword(attrs.class) ??
      iconKeyword(child.text);
    if (hint) return hint;
    const nested = iconHintFromSubtree(child, children, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function recoveryCandidateName(
  node: VomNode,
  children?: Map<number | null, VomNode[]>,
): string | undefined {
  return (
    cleaned(node.attrs?.["aria-label"]) ??
    cleaned(node.attrs?.title) ??
    cleaned(node.name) ??
    cleaned(node.text) ??
    cleaned(node.nearbyText) ??
    (children ? iconHintFromSubtree(node, children) : undefined)
  );
}

function recoveredRole(
  node: VomNode,
  children?: Map<number | null, VomNode[]>,
): string | undefined {
  const explicitRole = node.attrs?.role?.toLowerCase() ?? "";
  const hasHandler = hasRecoveryHandler(node);
  const focusable = isFocusable(node);
  const hasName = recoveryCandidateName(node, children) !== undefined;

  if (isContentEditable(node)) return "textbox";
  if (explicitRole === "combobox" && (hasHandler || focusable)) return "combobox";
  if (
    EXPLICIT_RECOVERY_ROLES.has(explicitRole) &&
    hasName &&
    (hasHandler || focusable || node.cursor === "pointer")
  ) {
    return explicitRole === "switch" ||
      explicitRole === "checkbox" ||
      explicitRole === "radio" ||
      explicitRole === "tab" ||
      explicitRole === "menuitem"
      ? explicitRole
      : "button";
  }
  if (hasHandler && hasName) return "button";
  if (node.cursor === "pointer" && hasName) return "button";
  return undefined;
}

function rectArea(node: VomNode): number {
  if (!node.rect) return 0;
  return Math.max(0, node.rect.w) * Math.max(0, node.rect.h);
}

function passesRecoveryGuards(node: VomNode, children: Map<number | null, VomNode[]>): boolean {
  const area = rectArea(node);
  const tag = node.tag.toLowerCase();

  if (node.pointerEvents === "none") return false;
  if (node.disabled || node.inert || node.insideNative) return false;
  if (node.hasNativeDescendant && !isContentEditable(node)) return false;

  const singleIntentLargeCandidate =
    area <= MAX_RECOVERABLE_SINGLE_INTENT_AREA &&
    recoveryCandidateName(node, children) !== undefined &&
    hasRecoveryHandler(node);
  if (area > MAX_CUSTOM_RECOVERY_AREA && !isContentEditable(node) && !singleIntentLargeCandidate) {
    return false;
  }
  if (NATIVE_TAGS.has(tag) || tag === "a") return false;
  if (GRAPHIC_ONLY_TAGS.has(tag)) return false;
  return recoveredRole(node, children) !== undefined;
}

function buildParentMap(nodes: VomNode[]): Map<number, number | null> {
  const ids = new Set(nodes.map((node) => node.id));
  const parentMap = new Map<number, number | null>();
  for (const node of nodes) {
    parentMap.set(node.id, node.parentId !== null && ids.has(node.parentId) ? node.parentId : null);
  }
  return parentMap;
}

function isAncestorOf(
  parentMap: Map<number, number | null>,
  ancestorId: number,
  nodeId: number,
): boolean {
  let current = parentMap.get(nodeId) ?? null;
  let guard = 0;
  while (current !== null && guard <= parentMap.size) {
    if (current === ancestorId) return true;
    current = parentMap.get(current) ?? null;
    guard += 1;
  }
  return false;
}

function applyRecovery(nodes: VomNode[]): VomNode[] {
  const parentMap = buildParentMap(nodes);
  const children = buildChildren(nodes);
  const recoveredIds = new Set<number>();
  const recoveredRoleById = new Map<number, string>();
  const recoveredNameById = new Map<number, string>();

  for (const node of nodes) {
    if (shouldReference(node)) continue;
    const role = recoveredRole(node, children);
    if (!role || !passesRecoveryGuards(node, children)) continue;
    recoveredIds.add(node.id);
    recoveredRoleById.set(node.id, role);
    const name = recoveryCandidateName(node, children);
    if (name) recoveredNameById.set(node.id, name);
  }

  for (const node of nodes) {
    if (!recoveredIds.has(node.id)) continue;
    let current = parentMap.get(node.id) ?? null;
    let guard = 0;
    while (current !== null && guard <= parentMap.size) {
      recoveredIds.delete(current);
      current = parentMap.get(current) ?? null;
      guard += 1;
    }
  }

  return nodes.map((node) => {
    if (!recoveredIds.has(node.id)) return node;
    return {
      ...node,
      role: recoveredRoleById.get(node.id),
      name: recoveredNameById.get(node.id) ?? node.name,
    };
  });
}

function buildChildren(nodes: VomNode[]): Map<number | null, VomNode[]> {
  const children = new Map<number | null, VomNode[]>();
  const ids = new Set(nodes.map((node) => node.id));

  for (const node of nodes) {
    const parentId = node.parentId !== null && ids.has(node.parentId) ? node.parentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(node);
    children.set(parentId, siblings);
  }

  return children;
}

function duplicateReferenceNames(nodes: VomNode[]): Set<string> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!shouldReference(node)) continue;
    const name = cleaned(node.name);
    if (!name) continue;
    const key = normalizeContextKey(name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

function needsHandleContext(nodeName: string, duplicateRefNames: Set<string>): boolean {
  const key = normalizeContextKey(nodeName);
  if (!key) return false;
  return duplicateRefNames.has(key);
}

function contextLabel(node: VomNode, targetName: string): string | undefined {
  if (
    !["heading", "article", "section", "group", "region", "row", "form"].includes(
      normalizedRole(node),
    )
  ) {
    return undefined;
  }
  return weakContextText(
    cleaned(node.name) ?? cleaned(node.text) ?? cleaned(node.nearbyText),
    targetName,
  );
}

function weakLabelContext(node: VomNode, targetName: string): string | undefined {
  if (shouldReference(node)) return undefined;
  return weakContextText(
    cleaned(node.name) ?? cleaned(node.text) ?? cleaned(node.nearbyText),
    targetName,
  );
}

function weakContextText(label: string | undefined, targetName: string): string | undefined {
  const clean = cleanSemanticText(label);
  if (!clean) return undefined;
  const key = normalizeContextKey(clean);
  if (
    !key ||
    key === normalizeContextKey(targetName) ||
    key.startsWith("ctx_") ||
    key === "section" ||
    WEAK_ACTION_LABELS.has(key)
  ) {
    return undefined;
  }
  return clean;
}

type ContextSource = "owned" | "same" | "dom";

interface ContextCandidate {
  text: string;
  source: ContextSource;
  order: number;
}

function contextSourceRank(source: ContextSource): number {
  return source === "owned" ? 0 : source === "same" ? 1 : 2;
}

function contextCategory(key: string): string {
  return key.match(/^[a-z\s]+/)?.[0].trim() ?? key;
}

function contextRank(key: string): number {
  if (key.startsWith("level ")) return 0;
  if (key.startsWith("group ")) return 1;
  return 2;
}

function dedupeContexts(contexts: ContextCandidate[]): string[] {
  const seen = new Set<string>();
  const seenCategories = new Set<string>();
  const sorted = [...contexts].sort(
    (a, b) =>
      contextSourceRank(a.source) - contextSourceRank(b.source) ||
      contextRank(normalizeContextKey(a.text)) - contextRank(normalizeContextKey(b.text)) ||
      a.order - b.order,
  );
  const unique: string[] = [];
  for (const ctx of sorted) {
    const clean = cleanSemanticText(ctx.text);
    if (!clean) continue;
    const key = normalizeContextKey(clean);
    const category = `${ctx.source}:${contextCategory(key)}`;
    if (!key || seen.has(key) || seenCategories.has(category)) continue;
    seen.add(key);
    seenCategories.add(category);
    unique.push(clean);
    if (unique.length >= MAX_HANDLE_CONTEXT_ITEMS) break;
  }
  return unique;
}

function isContextBoundary(node: VomNode): boolean {
  return ["region", "form", "section", "article", "row", "listitem", "group"].includes(
    normalizedRole(node),
  );
}

function collectWeakLabelsFromSubtree(
  node: VomNode,
  nodeName: string,
  state: RenderState,
  labels: string[],
): void {
  if (shouldReference(node)) return;
  const label = weakLabelContext(node, nodeName);
  if (label) {
    labels.push(label);
    return;
  }
  for (const child of state.children.get(node.id) ?? []) {
    collectWeakLabelsFromSubtree(child, nodeName, state, labels);
    if (labels.length >= MAX_HANDLE_CONTEXT_ITEMS) return;
  }
}

function collectOwnedContext(
  node: VomNode,
  nodeName: string,
  state: RenderState,
): ContextCandidate[] {
  const contexts: ContextCandidate[] = [];
  let current = state.parentMap.get(node.id) ?? null;
  let guard = 0;
  while (current !== null && guard <= state.parentMap.size) {
    const parent = state.nodesById.get(current);
    if (!parent) break;
    const label = contextLabel(parent, nodeName);
    if (label) contexts.push({ text: label, source: "owned", order: contexts.length });
    current = state.parentMap.get(current) ?? null;
    guard += 1;
  }
  return contexts;
}

function collectSameContainerContext(
  node: VomNode,
  nodeName: string,
  state: RenderState,
): ContextCandidate[] {
  const labels: string[] = [];
  let childId = node.id;
  let parentId = state.parentMap.get(node.id) ?? null;
  let guard = 0;
  while (parentId !== null && guard <= state.parentMap.size) {
    const siblings = state.children.get(parentId) ?? [];
    for (const sibling of siblings) {
      if (sibling.id === childId) break;
      collectWeakLabelsFromSubtree(sibling, nodeName, state, labels);
      while (labels.length > MAX_HANDLE_CONTEXT_ITEMS) labels.shift();
    }

    const parent = state.nodesById.get(parentId);
    if (!parent || isContextBoundary(parent)) break;
    childId = parentId;
    parentId = state.parentMap.get(parentId) ?? null;
    guard += 1;
  }
  return labels.map((text, index) => ({ text, source: "same", order: index }));
}

function collectDomContext(
  node: VomNode,
  nodeName: string,
  state: RenderState,
): ContextCandidate[] {
  const ancestorIds = node.domAncestorIds ?? [];
  if (ancestorIds.length === 0) return [];
  const ancestors = new Set(ancestorIds);
  const contexts: ContextCandidate[] = [];

  for (const candidate of state.nodesById.values()) {
    if (candidate.id === node.id) continue;
    if (isContextBoundary(candidate) && !ancestorIds.includes(candidate.id)) continue;
    const parentId = candidate.domParentId;
    if (parentId === undefined || parentId === null || !ancestors.has(parentId)) continue;
    const label = contextLabel(candidate, nodeName);
    if (!label) continue;
    const rank = ancestorIds.indexOf(parentId);
    contexts.push({ text: label, source: "dom", order: rank < 0 ? contexts.length : rank });
  }

  return contexts;
}

function handleContext(node: VomNode, state: RenderState): string[] {
  const name = cleaned(node.name);
  if (!name || !needsHandleContext(name, state.duplicateRefNames)) return [];
  return dedupeContexts([
    ...collectOwnedContext(node, name, state),
    ...collectSameContainerContext(node, name, state),
    ...collectDomContext(node, name, state),
  ]);
}

function renderNodeLine(
  node: VomNode,
  depth: number,
  ref: string | undefined,
  context: string[] = [],
  surface: CondSurface | undefined = undefined,
): string {
  let line = `${"  ".repeat(depth)}${ref ? `@${ref} ` : ""}${node.role}`;

  const name = cleaned(node.name);
  if (name) line += ` ${JSON.stringify(name)}`;
  if (context.length > 0) line += ` [ctx: ${context.join(" > ")}]`;

  // For link nodes with an external href, annotate so the agent can
  // distinguish external navigation from same-origin links.
  if (node.role === "link" && node.href) {
    line += ` [→ ${node.href}]`;
  }

  const rawValue = cleaned(node.value);
  const role = normalizedRole(node);
  if (["textbox", "searchbox"].includes(role)) {
    line += rawValue === undefined ? " [empty]" : " [filled]";
  }
  const value = node.sensitive
    ? rawValue !== undefined
      ? SENSITIVE_MASK
      : undefined
    : rawValue?.slice(0, MAX_VALUE_LENGTH);
  if (value !== undefined) line += ` =${JSON.stringify(value)}`;

  if (surface && surface.subItems.length > 0) {
    const items = surface.subItems.slice(0, MAX_SURFACE_ITEMS).join(" | ");
    const suffix = surface.subItems.length > MAX_SURFACE_ITEMS ? " | …" : "";
    line += ` [→ ${items}${suffix}]`;
  }

  return line;
}

function shouldSkipRedundantRefChildren(node: VomNode): boolean {
  const role = normalizedRole(node);
  if (
    ["textbox", "searchbox"].includes(role) &&
    ["input", "textarea"].includes((node.tag ?? "").toLowerCase())
  ) {
    return true;
  }
  if (!cleaned(node.name)) return false;
  return ["button", "link", "menuitem", "tab", "switch", "checkbox", "radio", "combobox"].includes(
    role,
  );
}

interface RenderState {
  lines: string[];
  refs: Array<{ ref: string; backendNodeId: number }>;
  nextRef: number;
  tokens: number;
  maxDepth: number;
  maxTokens: number;
  truncated: boolean;
  stopped: boolean;
  children: Map<number | null, VomNode[]>;
  parentMap: Map<number, number | null>;
  nodesById: Map<number, VomNode>;
  duplicateRefNames: Set<string>;
  surfaceMap: Map<number, CondSurface>;
  scopeMap: Map<number, ActiveScopeBlock>;
}

function emitActiveScopeBlock(scope: ActiveScopeBlock, depth: number, state: RenderState): void {
  if (state.stopped || scope.lines.length === 0) return;
  const indent = "  ".repeat(depth);
  const header = `${indent}[§ active: ${scope.label}]`;
  const headerTokens = estimateTokens(header);
  if (state.tokens + headerTokens > state.maxTokens) {
    state.truncated = true;
    state.stopped = true;
    return;
  }
  state.lines.push(header);
  state.tokens += headerTokens;

  for (const text of scope.lines.slice(0, MAX_SCOPE_LINES)) {
    if (state.stopped) return;
    const clean = cleaned(text);
    if (!clean) continue;
    const line = `${indent}  ${clean}`;
    const nextTokens = state.tokens + estimateTokens(line);
    if (nextTokens > state.maxTokens) {
      state.truncated = true;
      state.stopped = true;
      return;
    }
    state.lines.push(line);
    state.tokens = nextTokens;
  }
}

function renderTree(
  children: Map<number | null, VomNode[]>,
  parentId: number | null,
  depth: number,
  state: RenderState,
): void {
  if (state.stopped) return;

  const nodes = children.get(parentId) ?? [];
  for (const node of nodes) {
    if (state.stopped) return;

    if (!shouldRender(node)) {
      renderTree(children, node.id, depth, state);
      continue;
    }

    if (depth > state.maxDepth) {
      state.truncated = true;
      continue;
    }

    const ref = shouldReference(node) ? `e${state.nextRef}` : undefined;
    const context = ref ? handleContext(node, state) : [];
    const surface = state.surfaceMap.get(node.id);
    const line = renderNodeLine(node, depth, ref, context, surface);
    const nextTokens = state.tokens + estimateTokens(line);
    if (nextTokens > state.maxTokens) {
      state.truncated = true;
      state.stopped = true;
      return;
    }

    state.lines.push(line);
    state.tokens = nextTokens;
    if (ref) {
      state.refs.push({ ref, backendNodeId: node.id });
      state.nextRef += 1;
    }

    const scope = state.scopeMap.get(node.id);
    if (scope) emitActiveScopeBlock(scope, depth + 1, state);

    if (ref && shouldSkipRedundantRefChildren(node)) continue;
    renderTree(children, node.id, depth + 1, state);
  }
}

function renderNodes(
  nodes: VomNode[],
  options: VomOptions,
  initialLines: string[],
  surfaces: CondSurface[] = [],
  activeScopeBlocks: ActiveScopeBlock[] = [],
): RenderState {
  const children = buildChildren(nodes);
  const state: RenderState = {
    lines: [...initialLines],
    refs: [],
    nextRef: 1,
    tokens: estimateTokens(initialLines.join("\n")),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    truncated: false,
    stopped: false,
    children,
    parentMap: buildParentMap(nodes),
    nodesById: new Map(nodes.map((node) => [node.id, node])),
    duplicateRefNames: duplicateReferenceNames(nodes),
    surfaceMap: new Map(surfaces.map((surface) => [surface.triggerId, surface])),
    scopeMap: new Map(activeScopeBlocks.map((scope) => [scope.triggerId, scope])),
  };

  renderTree(children, null, 1, state);

  return state;
}

function renderPageOcclusionLine(hiddenNodeCount: number): string {
  return `L2 page … occluded by L1 (~${hiddenNodeCount} nodes, not actionable)`;
}

function isPositionedRegionCandidate(node: VomNode): boolean {
  return (
    node.pointerEvents !== "none" &&
    node.rect !== null &&
    ACTIVE_REGION_POSITIONS.has(node.position)
  );
}

function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function interactionPoints(rect: Rect): Array<[number, number]> {
  const epsX = Math.min(rect.w * 0.15, 8);
  const epsY = Math.min(rect.h * 0.15, 8);
  const midX = rect.x + rect.w / 2;
  const midY = rect.y + rect.h / 2;
  return [
    [midX, midY],
    [rect.x + epsX, rect.y + epsY],
    [rect.x + rect.w - epsX, rect.y + epsY],
    [rect.x + epsX, rect.y + rect.h - epsY],
    [rect.x + rect.w - epsX, rect.y + rect.h - epsY],
    [midX, rect.y + epsY],
    [midX, rect.y + rect.h - epsY],
    [rect.x + epsX, midY],
    [rect.x + rect.w - epsX, midY],
  ];
}

function isModalLike(node: VomNode): boolean {
  const role = normalizedRole(node);
  return (
    node.modal === true || node.tag === "dialog" || role === "dialog" || role === "alertdialog"
  );
}

function activeRegionCandidatePriority(node: VomNode, viewportCoverage: number): number {
  if (isModalLike(node)) return 4;
  if (viewportCoverage >= 0.9) return 3;
  if (viewportCoverage >= 0.15) return 2;
  return 1;
}

function isBlockedByRegion(
  target: VomNode,
  blocker: VomNode,
  parentMap: Map<number, number | null>,
  viewportCoverage: number,
): boolean {
  if (target.id === blocker.id) return false;
  if (isAncestorOf(parentMap, blocker.id, target.id)) return false;
  if (isAncestorOf(parentMap, target.id, blocker.id)) return false;
  if (!target.rect || !blocker.rect) return false;

  const points = interactionPoints(target.rect);

  if (
    viewportCoverage < 0.9 &&
    target.paintOrder >= blocker.paintOrder &&
    points.some(([x, y]) => rectContains(blocker.rect as Rect, x, y))
  ) {
    return false;
  }

  if (blocker.paintOrder < target.paintOrder) return false;
  if (blocker.paintOrder === target.paintOrder && blocker.id <= target.id) return false;
  if (viewportCoverage >= 0.9) return true;

  return points.some(([x, y]) => rectContains(blocker.rect as Rect, x, y));
}

function collectDescendantsOfIds(nodes: VomNode[], roots: Set<number>): Set<number> {
  const included = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (included.has(node.id)) continue;
      if (node.parentId !== null && included.has(node.parentId)) {
        included.add(node.id);
        changed = true;
      }
    }
  }
  return included;
}

function applyActiveRegionPolicy(nodes: VomNode[], scene: VomScene): VomNode[] {
  const parentMap = buildParentMap(nodes);
  const candidates = nodes
    .filter(isPositionedRegionCandidate)
    .map((node) => {
      const viewportCoverage = coverage(node.rect, scene.viewport);
      return {
        node,
        viewportCoverage,
        priority: activeRegionCandidatePriority(node, viewportCoverage),
      };
    })
    .filter((candidate) => candidate.priority > 1 || candidate.viewportCoverage > 0);

  const blockedRoots = new Set<number>();
  for (const target of nodes) {
    if (!shouldReference(target)) continue;
    const blocked = candidates.some((candidate) =>
      isBlockedByRegion(target, candidate.node, parentMap, candidate.viewportCoverage),
    );
    if (blocked) blockedRoots.add(target.id);
  }

  if (blockedRoots.size === 0) return nodes;
  const blocked = collectDescendantsOfIds(nodes, blockedRoots);
  return nodes.filter((node) => !blocked.has(node.id));
}

function collectDescendantsOfMembers(nodes: VomNode[], members: Set<number>): Set<number> {
  const included = new Set(members);
  let changed = true;

  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (included.has(node.id)) continue;
      if (node.parentId !== null && included.has(node.parentId)) {
        included.add(node.id);
        changed = true;
      }
    }
  }

  return included;
}

function countRenderable(nodes: VomNode[]): number {
  return nodes.filter(shouldRender).length;
}

interface SemanticControl {
  kind: string;
  handle?: string;
  label: string;
}

interface SemanticAction {
  handle: string;
  label: string;
}

interface SemanticItem {
  title?: string;
  titleHandle?: string;
  author?: string;
  time?: string;
  score?: string;
  comments?: string;
  commentsHandle?: string;
  actions: SemanticAction[];
}

interface SemanticCollection {
  role: string;
  itemRole: string;
  label?: string;
  controls: SemanticControl[];
  items: SemanticItem[];
}

function truncateField(value: string): string {
  if ([...value].length <= MAX_SEMANTIC_FIELD_CHARS) return value;
  return `${[...value].slice(0, MAX_SEMANTIC_FIELD_CHARS - 1).join("")}…`;
}

function quoteField(value: string): string {
  return JSON.stringify(truncateField(value));
}

function roleIsCollectionItem(role: string): boolean {
  return role === "article" || role === "row" || role === "listitem";
}

function roleIsCollectionContainer(role: string): boolean {
  return ["main", "feed", "list", "table", "grid", "rowgroup", "region", "section"].includes(role);
}

function textForSemantics(node: VomNode): string | undefined {
  return (
    cleanSemanticText(node.name) ??
    cleanSemanticText(node.value) ??
    cleanSemanticText(node.text) ??
    cleanSemanticText(node.nearbyText)
  );
}

function buildRefLookup(refs: Array<{ ref: string; backendNodeId: number }>): Map<number, string> {
  return new Map(
    refs.map((entry) => [
      entry.backendNodeId,
      entry.ref.startsWith("@") ? entry.ref : `@${entry.ref}`,
    ]),
  );
}

function collectDescendantNodes(
  children: Map<number | null, VomNode[]>,
  rootId: number,
  nodesById: Map<number, VomNode>,
): VomNode[] {
  const out: VomNode[] = [];
  const stack = [rootId];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const id = stack.pop() as number;
    if (!seen.add(id)) continue;
    const node = nodesById.get(id);
    if (node) out.push(node);
    for (const child of [...(children.get(id) ?? [])].reverse()) {
      stack.push(child.id);
    }
  }
  return out;
}

function collectDescendantIdSet(
  children: Map<number | null, VomNode[]>,
  rootId: number,
): Set<number> {
  const out = new Set<number>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as number;
    if (!out.add(id)) continue;
    for (const child of [...(children.get(id) ?? [])].reverse()) stack.push(child.id);
  }
  return out;
}

function collectionLabel(
  node: VomNode,
  children: Map<number | null, VomNode[]>,
  nodesById: Map<number, VomNode>,
): string | undefined {
  return (
    contextLabel(node, "") ??
    collectDescendantNodes(children, node.id, nodesById).find(
      (candidate) => normalizedRole(candidate) === "heading" && textForSemantics(candidate),
    )?.name
  );
}

function classifyControl(label: string, role: string): string | undefined {
  const key = label.toLowerCase();
  if (role === "searchbox" || key.includes("search")) return "search";
  if (key.includes("sort") || key.includes("order")) return "sort";
  if (key.includes("filter")) return "filter";
  if (role === "tab") return "tab";
  if (key === "next" || key.includes("next page")) return "pagination";
  if (key === "previous" || key.includes("previous page")) return "pagination";
  return undefined;
}

function collectCollectionControls(
  container: VomNode,
  items: VomNode[],
  children: Map<number | null, VomNode[]>,
  nodesById: Map<number, VomNode>,
  refLookup: Map<number, string>,
): SemanticControl[] {
  const itemIds = new Set(items.flatMap((item) => [...collectDescendantIdSet(children, item.id)]));
  const controls: SemanticControl[] = [];
  for (const node of collectDescendantNodes(children, container.id, nodesById)) {
    if (itemIds.has(node.id)) continue;
    const role = normalizedRole(node);
    if (!["button", "combobox", "searchbox", "tab", "link"].includes(role)) continue;
    const label = textForSemantics(node);
    if (!label) continue;
    const kind = classifyControl(label, role);
    if (!kind) continue;
    controls.push({ kind, handle: refLookup.get(node.id), label });
    if (controls.length >= MAX_SEMANTIC_CONTROLS) break;
  }
  return controls;
}

function isFormLikeCollection(
  container: VomNode,
  items: VomNode[],
  children: Map<number | null, VomNode[]>,
  nodesById: Map<number, VomNode>,
): boolean {
  const descendants = collectDescendantNodes(children, container.id, nodesById);
  const interactive = descendants.filter((node) => shouldReference(node));
  const textboxCount = interactive.filter((node) =>
    ["textbox", "searchbox"].includes(normalizedRole(node)),
  ).length;
  const sensitiveCount = descendants.filter((node) => node.sensitive).length;
  const labels = descendants
    .map((node) => textForSemantics(node))
    .filter((label): label is string => label !== undefined)
    .join(" ")
    .toLowerCase();
  const hasLoginSignals =
    /(用户登录|登录|验证码|密码|忘记密码|手机号|证书口令|captcha|password|sign in|log in)/i.test(
      labels,
    );

  return (
    (textboxCount >= 2 && hasLoginSignals) ||
    (sensitiveCount > 0 && hasLoginSignals) ||
    (items.length <= 8 && textboxCount > 0 && interactive.length >= 3 && hasLoginSignals)
  );
}

function isCommentLabel(label: string): boolean {
  const key = label.toLowerCase();
  return key.includes("comment") || key === "no comments";
}

function parseScoreBetweenVoteButtons(
  item: VomNode,
  children: Map<number | null, VomNode[]>,
): string | undefined {
  for (const descendantId of collectDescendantIdSet(children, item.id)) {
    const siblings = children.get(descendantId) ?? [];
    for (let index = 0; index + 2 < siblings.length; index += 1) {
      const prev = textForSemantics(siblings[index])?.toLowerCase() ?? "";
      const score = textForSemantics(siblings[index + 1]);
      const next = textForSemantics(siblings[index + 2])?.toLowerCase() ?? "";
      if (
        prev.includes("upvote") &&
        next.includes("downvote") &&
        score !== undefined &&
        /^-?\d+$/.test(score.replaceAll(",", ""))
      ) {
        return score;
      }
    }
  }
  return undefined;
}

function extractAuthor(descendants: VomNode[]): string | undefined {
  for (let index = 0; index < descendants.length; index += 1) {
    const label = textForSemantics(descendants[index]);
    if (!label) continue;
    const key = label.toLowerCase();
    if (key === "submitted by" || key === "by" || key.endsWith(" by")) {
      for (const candidate of descendants.slice(index + 1, index + 9)) {
        if (normalizedRole(candidate) === "link") return textForSemantics(candidate);
      }
    }
  }
  return undefined;
}

function extractSemanticItem(
  item: VomNode,
  children: Map<number | null, VomNode[]>,
  nodesById: Map<number, VomNode>,
  refLookup: Map<number, string>,
): SemanticItem {
  const descendants = collectDescendantNodes(children, item.id, nodesById);
  let title: string | undefined;
  let titleHandle: string | undefined;
  for (const role of ["heading", "link"]) {
    const node = descendants.find(
      (candidate) => normalizedRole(candidate) === role && textForSemantics(candidate),
    );
    if (!node) continue;
    title = textForSemantics(node);
    titleHandle = refLookup.get(node.id);
    if (!titleHandle && title) {
      const matchingLink = descendants.find(
        (candidate) =>
          normalizedRole(candidate) === "link" && textForSemantics(candidate) === title,
      );
      if (matchingLink) titleHandle = refLookup.get(matchingLink.id);
    }
    break;
  }
  if (!title) {
    title = textForSemantics(item);
    titleHandle = refLookup.get(item.id);
  }

  let time: string | undefined;
  let comments: string | undefined;
  let commentsHandle: string | undefined;
  const actions: SemanticAction[] = [];
  for (const node of descendants) {
    const role = normalizedRole(node);
    const label = textForSemantics(node);
    if (!time && role === "time") time = label;
    if (!comments && label && isCommentLabel(label)) {
      comments = label;
      commentsHandle = refLookup.get(node.id);
    }
    if (
      actions.length < MAX_SEMANTIC_ACTIONS &&
      shouldReference(node) &&
      !["link", "textbox", "searchbox"].includes(role)
    ) {
      const handle = refLookup.get(node.id);
      if (handle && label) actions.push({ handle, label });
    }
  }

  return {
    title,
    titleHandle,
    author: extractAuthor(descendants),
    time,
    score: parseScoreBetweenVoteButtons(item, children),
    comments,
    commentsHandle,
    actions,
  };
}

function detectSemanticCollections(
  nodes: VomNode[],
  refs: Array<{ ref: string; backendNodeId: number }>,
): SemanticCollection[] {
  const children = buildChildren(nodes);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const refLookup = buildRefLookup(refs);
  const collections: SemanticCollection[] = [];
  const coveredItems = new Set<number>();

  for (const container of nodes) {
    if (collections.length >= MAX_SEMANTIC_COLLECTIONS) break;
    const role = normalizedRole(container);
    if (!roleIsCollectionContainer(role)) continue;
    const childList = children.get(container.id) ?? [];
    const counts = new Map<string, number>();
    for (const child of childList) {
      const childRole = normalizedRole(child);
      if (roleIsCollectionItem(childRole)) counts.set(childRole, (counts.get(childRole) ?? 0) + 1);
    }
    const best = [...counts].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1])[0];
    if (!best) continue;
    const [itemRole] = best;
    const items = childList.filter(
      (child) => normalizedRole(child) === itemRole && !coveredItems.has(child.id),
    );
    if (items.length < 2) continue;
    if (isFormLikeCollection(container, items, children, nodesById)) continue;
    for (const item of items) coveredItems.add(item.id);
    collections.push({
      role,
      itemRole,
      label: collectionLabel(container, children, nodesById),
      controls: collectCollectionControls(container, items, children, nodesById, refLookup),
      items: items
        .slice(0, MAX_SEMANTIC_ITEMS)
        .map((item) => extractSemanticItem(item, children, nodesById, refLookup)),
    });
  }
  return collections;
}

function renderSemanticCollections(collections: SemanticCollection[]): string[] {
  if (collections.length === 0) return [];
  const lines = ["@collections"];
  for (const [index, collection] of collections.entries()) {
    const label = collection.label ? ` label=${quoteField(collection.label)}` : "";
    lines.push(
      `collection c${index + 1} role=${collection.role} item_role=${collection.itemRole}${label} items=${collection.items.length}`,
    );
    if (collection.controls.length > 0) {
      const rendered = collection.controls
        .map(
          (control) =>
            `${control.kind}=${control.handle ? `${control.handle} ` : ""}${quoteField(control.label)}`,
        )
        .join("; ");
      lines.push(`  controls: ${rendered}`);
    }
    lines.push(
      "  columns: index title title_handle author time score comments comments_handle actions",
    );
    collection.items.forEach((item, itemIndex) => {
      const parts = [`${itemIndex + 1}. `];
      if (item.title) parts.push(`title=${quoteField(item.title)}`);
      if (item.titleHandle) parts.push(`title_handle=${item.titleHandle}`);
      if (item.author) parts.push(`author=${quoteField(item.author)}`);
      if (item.time) parts.push(`time=${quoteField(item.time)}`);
      if (item.score) parts.push(`score=${quoteField(item.score)}`);
      if (item.comments) parts.push(`comments=${quoteField(item.comments)}`);
      if (item.commentsHandle) parts.push(`comments_handle=${item.commentsHandle}`);
      if (item.actions.length > 0) {
        parts.push(
          `actions=[${item.actions.map((action) => `${action.handle} ${quoteField(action.label)}`).join(", ")}]`,
        );
      }
      lines.push(`  ${parts.join(" ")}`);
    });
  }
  return lines;
}

function insertAfterHeader(text: string, insertLines: string[]): string {
  if (insertLines.length === 0) return text;
  const lines = text.split("\n");
  const l1Index = lines.findIndex((line) => line.startsWith("L1 "));
  const insertAt = l1Index >= 0 ? l1Index + 1 : Math.min(lines.length, 3);
  lines.splice(insertAt, 0, ...insertLines);
  return lines.join("\n");
}

function augmentVomResult(result: VomResult, nodes: VomNode[], options: VomOptions): VomResult {
  if (!options.semanticCollections) return result;
  const semanticLines = renderSemanticCollections(detectSemanticCollections(nodes, result.refs));
  return semanticLines.length === 0
    ? result
    : { ...result, text: insertAfterHeader(result.text, semanticLines) };
}

function renderDoubleLayer(scene: VomScene, layer: BlockingLayer, options: VomOptions): VomResult {
  const included = collectDescendantsOfMembers(scene.nodes, layer.members);
  const visibleNodes = scene.nodes.filter((node) => included.has(node.id));
  const hiddenCount = countRenderable(scene.nodes.filter((node) => !included.has(node.id)));
  const header = [
    "@vom 1",
    `@view ${scene.viewport.width}x${scene.viewport.height}`,
    "@layers 2 focus=L1",
    `L1 ${layer.kind} cover=${Math.round(layer.coverage * 100)}%`,
  ];
  const state = renderNodes(visibleNodes, options, header, scene.surfaces, scene.activeScopeBlocks);
  state.lines.push(renderPageOcclusionLine(hiddenCount));

  return augmentVomResult(
    {
      text: state.lines.join("\n"),
      refs: state.refs,
      truncated: state.truncated,
    },
    visibleNodes,
    options,
  );
}

export function renderVom(scene: VomScene, options: VomOptions = {}): VomResult {
  const nodes = applyRecovery(scene.nodes);
  const renderScene = { ...scene, nodes };
  const layer = detectBlockingLayer(nodes, scene.viewport);
  if (layer) return renderDoubleLayer(renderScene, layer, options);
  const visibleNodes = options.activeRegionPolicy ? applyActiveRegionPolicy(nodes, scene) : nodes;

  const state = renderNodes(
    visibleNodes,
    options,
    [
      "@vom 1",
      `@view ${scene.viewport.width}x${scene.viewport.height}`,
      "@layers 1 focus=L1",
      "L1 page",
    ],
    scene.surfaces,
    scene.activeScopeBlocks,
  );

  return augmentVomResult(
    {
      text: state.lines.join("\n"),
      refs: state.refs,
      truncated: state.truncated,
    },
    visibleNodes,
    options,
  );
}
