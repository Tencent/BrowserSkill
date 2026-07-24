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

function isLowValueContext(value: string): boolean {
  const clean = value.trim();
  const key = clean.toLowerCase();
  if (clean === "欢迎") return true;
  if (key.includes("icp") || key.includes("备案")) return true;
  if (clean.includes("联系方式") || clean.includes("政府网站标识")) return true;
  if (/^\d{5,}$/.test(clean)) return true;
  if (/北京市小客车指标调控管理信息系统|beijing municipal commission/i.test(clean)) return true;
  return false;
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
    isLowValueContext(clean) ||
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
  return source === "same" ? 0 : source === "owned" ? 1 : 2;
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
    if (unique.length >= 1) break;
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
  const fillable = ["textbox", "searchbox"].includes(role);
  if (fillable) {
    line += ` [${node.inputState ?? (rawValue === undefined ? "empty" : "filled")}]`;
  }
  const placeholder = cleaned(node.placeholder);
  if (placeholder) line += ` placeholder=${JSON.stringify(placeholder)}`;
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

function descendantTextCoveredByName(node: VomNode, state: RenderState): boolean {
  const name = cleaned(node.name);
  if (!name) return false;
  const stack = [...(state.children.get(node.id) ?? [])];
  const texts: string[] = [];
  while (stack.length > 0) {
    const child = stack.pop() as VomNode;
    if (shouldReference(child)) return false;
    const text = cleaned(child.name) ?? cleaned(child.text) ?? cleaned(child.value);
    if (text) texts.push(text);
    stack.push(...(state.children.get(child.id) ?? []));
  }
  return texts.length > 0 && texts.every((text) => name.includes(text));
}

function shouldSkipRedundantChildren(node: VomNode, state: RenderState): boolean {
  const role = normalizedRole(node);
  if (["cell", "gridcell", "columnheader", "rowheader"].includes(role)) {
    return descendantTextCoveredByName(node, state);
  }
  return false;
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

    if ((ref && shouldSkipRedundantRefChildren(node)) || shouldSkipRedundantChildren(node, state)) {
      continue;
    }
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

  return {
    text: state.lines.join("\n"),
    refs: state.refs,
    truncated: state.truncated,
  };
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

  return {
    text: state.lines.join("\n"),
    refs: state.refs,
    truncated: state.truncated,
  };
}
