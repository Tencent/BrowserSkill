import { coverage, detectBlockingLayer, spansViewport } from "./layers";
import { estimateLineTokens, estimateTokens } from "./tokens";
import type {
  ActiveScopeBlock,
  BlockingLayer,
  CondSurface,
  Rect,
  RenderedRef,
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
  "gridcell",
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

export function isVomStructuralRole(role: string | undefined): boolean {
  return STRUCTURAL_ROLES.has(role?.toLowerCase() ?? "");
}

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
const DATE_LIKE_INPUT_TYPES = new Set(["date", "time", "datetime-local", "month", "week"]);
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
const LABELABLE_INPUT_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const TABLE_CELL_ROLES = new Set(["cell", "gridcell", "columnheader", "rowheader"]);
const MAX_INLINE_SELECT_OPTIONS = 10;
const MAX_INLINE_OPTION_VALUE_CHARS = 36;
const MAX_INLINE_OPTION_LABEL_CHARS = 48;
const MIN_FOLDABLE_TABLE_ROWS = 3;

const NON_CAPTION_TOKEN_RE =
  /^(?:[\d\s\p{P}\p{S}]+|(?:kg|g|mg|lb|lbs|oz|km|m|cm|mm|px|pt|rem|em|vw|vh|ms|s|sec|secs|min|mins|hr|hrs|hz|khz|mhz|ghz|kb|mb|gb|tb|kbps|mbps|kcal|℃|°c|°f|元|万元|亿元|件|个|次|天|月|年|to|至|到))$/iu;
const NON_CAPTION_VALIDATION_RE =
  /(?:不正确|无效|不能为空|必填|格式错误|请输入|不匹配|已存在|至少\s*\d|不能超过|\binvalid\b|\brequired\b|\bmust be\b|\bcannot be\b|\btoo short\b|\btoo long\b)/i;
const NON_CAPTION_ATTR_CLASS_RE =
  /(?:^|[-_\s])(?:err|error|errors|invalid|warn|warning|alert|feedback|helper|hint|unit|suffix|addon)(?:$|[-_\s])/i;

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

function normalizedTag(node: VomNode): string {
  return node.tag.toLowerCase();
}

function isDateLikeInput(node: VomNode): boolean {
  const role = normalizedRole(node);
  return (
    normalizedTag(node) === "input" &&
    role !== "" &&
    !SKIP_ROLES.has(role) &&
    DATE_LIKE_INPUT_TYPES.has(node.attrs?.type?.toLowerCase() ?? "")
  );
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

/** Hints describe observed evidence, not a promise that a drop will be accepted. */
function dragHint(node: VomNode): string | undefined {
  if (
    node.disabled ||
    node.inert ||
    node.pointerEvents === "none" ||
    ["statictext", "inlinetextbox"].includes(normalizedRole(node))
  )
    return undefined;
  if (node.dragHint !== undefined) return node.dragHint || undefined;
  if (node.attrs?.draggable?.toLowerCase() === "true") return "draggable";
  if (node.attrs?.ondrop !== undefined || node.attrs?.ondragover !== undefined)
    return "drop-target";
  if (["grab", "grabbing", "move"].includes(node.cursor ?? "") || node.cursor?.endsWith("-resize"))
    return "drag-handle";
  return undefined;
}

/** Selection evidence shared by rendered hints and observation freshness checks. */
export function selectionMarker(node: VomNode): string | undefined {
  const attrs = node.attrs ?? {};
  const aria = attrs["aria-selected"]?.toLowerCase();
  if (aria === "true" || aria === "false") return aria === "true" ? "selected" : "unselected";
  // Custom styling is only a hint on controls, never semantic proof on wrappers.
  if (!isSemanticReferenceNode(node) && !hasRecoveryHandler(node)) return undefined;
  if (attrs["data-selected"] === "true" || attrs["data-state"] === "selected")
    return "selected:data";
  if (attrs["data-selected"] === "false" || attrs["data-state"] === "unselected")
    return "unselected:data";
  if (attrs.class?.split(/\s+/).some((token) => token === "selected" || token === "is-selected"))
    return "selected:class";
  return undefined;
}

function indexedItemName(node: VomNode): string | undefined {
  const index = node.attrs?.["data-index"];
  return hasRecoveryHandler(node) && index !== undefined && /^\d{1,9}$/.test(index)
    ? `item ${index}`
    : undefined;
}

function shouldRender(node: VomNode): boolean {
  if (dragHint(node) || isDateLikeInput(node)) return true;
  if (!node.role) return false;

  const role = normalizedRole(node);
  if (SKIP_ROLES.has(role)) return false;
  if (INTERACTIVE_ROLES.has(role)) return true;
  if (isVomStructuralRole(role)) return true;

  return cleaned(node.name) !== undefined;
}

function isSemanticReferenceNode(node: VomNode): boolean {
  return (
    node.referenceable !== false &&
    (INTERACTIVE_ROLES.has(normalizedRole(node)) ||
      isDateLikeInput(node) ||
      isUrlBearingStructuralAction(node))
  );
}

export function isVomReferenceNode(node: VomNode): boolean {
  return (
    isSemanticReferenceNode(node) || (node.referenceable !== false && dragHint(node) !== undefined)
  );
}

function hasRecoveryHandler(node: VomNode): boolean {
  if (node.clickable) return true;
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
  return (
    contentEditable === "" || contentEditable === "true" || contentEditable === "plaintext-only"
  );
}

const ICON_REFERENCE_MARKERS = new Set(["glyph", "icon", "icons", "symbol"]);
const ICON_REFERENCE_DECORATORS = new Set(["fill", "filled", "line", "outline", "outlined"]);

function iconReferenceName(value: string | undefined): string | undefined {
  const reference = cleaned(value);
  if (!reference) return undefined;
  const fragment = reference.includes("#") ? reference.slice(reference.lastIndexOf("#") + 1) : "";
  const tokens = (fragment || reference)
    ?.split(/[#/.\s:_-]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
  if (tokens.length === 0) return undefined;
  if (fragment) {
    const semanticTokens = tokens.filter(
      (token) => !ICON_REFERENCE_MARKERS.has(token) && !ICON_REFERENCE_DECORATORS.has(token),
    );
    return semanticTokens.length > 0 ? semanticTokens.join(" ") : undefined;
  }
  const marker = tokens.findLastIndex((token) => ICON_REFERENCE_MARKERS.has(token));
  if (marker < 0) return undefined;
  const semanticTokens = tokens
    .slice(marker + 1)
    .filter((token) => !ICON_REFERENCE_DECORATORS.has(token));
  return semanticTokens.length > 0 ? semanticTokens.join(" ") : undefined;
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
      cleaned(attrs["aria-label"]) ??
      cleaned(attrs.title) ??
      (normalizedRole(child) === "img" ? cleaned(child.name) : undefined) ??
      (["img", "svg", "use"].includes(normalizedTag(child))
        ? (iconReferenceName(attrs.href) ?? iconReferenceName(attrs["xlink:href"]))
        : undefined);
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
    (children ? iconHintFromSubtree(node, children) : undefined) ??
    indexedItemName(node)
  );
}

function recoveredRole(
  node: VomNode,
  children?: Map<number | null, VomNode[]>,
  getName?: () => string | undefined,
): string | undefined {
  if (isContentEditable(node)) return "textbox";
  const explicitRole = node.attrs?.role?.toLowerCase() ?? "";
  const hasHandler = hasRecoveryHandler(node);
  const focusable = isFocusable(node);
  if (explicitRole === "combobox" && (hasHandler || focusable)) return "combobox";

  const currentRole = normalizedRole(node);
  const explicitRecoverable =
    EXPLICIT_RECOVERY_ROLES.has(explicitRole) &&
    (hasHandler || focusable || node.cursor === "pointer");
  const pointerRecoverable =
    (!currentRole || SKIP_ROLES.has(currentRole)) && node.cursor === "pointer";
  if (!explicitRecoverable && !hasHandler && !pointerRecoverable) return undefined;

  const hasName = (getName ? getName() : recoveryCandidateName(node, children)) !== undefined;
  if (!hasName) return undefined;

  if (explicitRecoverable) {
    return explicitRole === "switch" ||
      explicitRole === "checkbox" ||
      explicitRole === "radio" ||
      explicitRole === "tab" ||
      explicitRole === "menuitem"
      ? explicitRole
      : "button";
  }
  if (hasHandler) return "button";
  if (pointerRecoverable) return "button";
  return undefined;
}

function rectArea(node: VomNode): number {
  if (!node.rect) return 0;
  return Math.max(0, node.rect.w) * Math.max(0, node.rect.h);
}

function passesStaticRecoveryGuards(node: VomNode): boolean {
  const tag = normalizedTag(node);
  if (node.pointerEvents === "none") return false;
  if (node.disabled || node.inert || node.insideNative) return false;
  if (node.hasNativeDescendant && !isContentEditable(node)) return false;
  if (NATIVE_TAGS.has(tag) || tag === "a") return false;
  if (GRAPHIC_ONLY_TAGS.has(tag)) return false;
  return true;
}

function passesAreaRecoveryGuard(node: VomNode, getName: () => string | undefined): boolean {
  const area = rectArea(node);
  if (area <= MAX_CUSTOM_RECOVERY_AREA || isContentEditable(node)) return true;
  return (
    area <= MAX_RECOVERABLE_SINGLE_INTENT_AREA &&
    hasRecoveryHandler(node) &&
    getName() !== undefined
  );
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

const DELEGATED_LIST_TAGS = new Set(["ul", "ol", "menu"]);
const DELEGATED_LIST_ROLES = new Set(["list", "listbox", "menu", "tree", "treegrid", "tablist"]);
const TEXT_NODE_TAGS = new Set(["#text", "#cdata-section"]);

/**
 * A delegated list/row container carries the click itself while its rows are
 * not individually clickable. Only propagate refs to rows for list-like
 * structures (list tags/roles, or homogeneous repeated rows), never for a
 * multi-child compound button.
 */
function isDelegatedRowContainer(node: VomNode, children: Map<number | null, VomNode[]>): boolean {
  if (!hasRecoveryHandler(node)) return false;
  const direct = (children.get(node.id) ?? []).filter((child) => !TEXT_NODE_TAGS.has(child.tag));
  if (direct.length === 0) return false;
  // Rows that are already individually addressable are handled by normal recovery.
  if (direct.some((child) => isSemanticReferenceNode(child))) return false;

  const tag = normalizedTag(node);
  const role = normalizedRole(node);
  if (DELEGATED_LIST_TAGS.has(tag) || DELEGATED_LIST_ROLES.has(role)) return true;

  // Homogeneous repeated rows (>=3): same tag, text-bearing, similarly sized and
  // vertically stacked. This avoids splitting a two-line card button.
  if (direct.length < 3) return false;
  const firstTag = direct[0].tag;
  if (!direct.every((child) => child.tag === firstTag)) return false;
  if (
    !direct.every((child) => cleaned(child.name) !== undefined || cleaned(child.text) !== undefined)
  )
    return false;
  const rects = direct.map((child) => child.rect);
  if (rects.some((rect) => !rect || rect.w <= 0 || rect.h <= 0)) return false;
  const heights = rects.map((rect) => rect!.h);
  const avg = heights.reduce((sum, h) => sum + h, 0) / heights.length;
  if (avg <= 0 || heights.some((h) => Math.abs(h - avg) / avg > 0.35)) return false;
  const ys = rects.map((rect) => rect!.y).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) if (ys[i] <= ys[i - 1]) return false;
  return true;
}

export function applyVomInteractionRecovery(nodes: VomNode[]): VomNode[] {
  // CSS cursors inherit. Expose the handle once instead of assigning refs to
  // every decorative span inside it; retain explicit nested draggable/drop cues.
  if (nodes.some((node) => dragHint(node) === "drag-handle")) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    nodes = nodes.map((node) => {
      const parent = node.parentId === null ? undefined : byId.get(node.parentId);
      return dragHint(node) === "drag-handle" &&
        parent &&
        dragHint(parent) &&
        parent.cursor === node.cursor &&
        parent.frameId === node.frameId
        ? { ...node, dragHint: false }
        : node;
    });
  }

  const children = buildChildren(nodes);
  const recoveredIds = new Set<number>();
  const recoveredRoleById = new Map<number, string>();
  const recoveredNameById = new Map<number, string>();

  // Delegated row lists keep the click on the container while their rows are
  // not individually clickable. Expose each text-bearing row instead of
  // collapsing the whole list into one button.
  const delegatedRowContainers = new Set<number>();
  for (const node of nodes) {
    if (!isDelegatedRowContainer(node, children)) continue;
    delegatedRowContainers.add(node.id);
    for (const row of children.get(node.id) ?? []) {
      if (TEXT_NODE_TAGS.has(row.tag)) continue;
      if (isSemanticReferenceNode(row) || !passesStaticRecoveryGuards(row)) continue;
      const rowName = recoveryCandidateName(row, children);
      if (!rowName) continue;
      if (!passesAreaRecoveryGuard(row, () => rowName)) continue;
      recoveredIds.add(row.id);
      recoveredRoleById.set(row.id, "button");
      recoveredNameById.set(row.id, rowName);
    }
  }

  const eligible: VomNode[] = [];
  for (const node of nodes) {
    if (delegatedRowContainers.has(node.id)) continue;
    // Drag evidence adds a capability; it must not suppress existing role/name recovery.
    if (!isSemanticReferenceNode(node) && passesStaticRecoveryGuards(node)) {
      eligible.push(node);
    }
  }
  if (eligible.length === 0 && recoveredIds.size === 0) return nodes;

  for (const node of eligible) {
    let computed = false;
    let cachedName: string | undefined;
    const getName = (): string | undefined => {
      if (!computed) {
        computed = true;
        cachedName = recoveryCandidateName(node, children);
      }
      return cachedName;
    };
    const role = recoveredRole(node, children, getName);
    if (!role) continue;
    if (!passesAreaRecoveryGuard(node, getName)) continue;
    recoveredIds.add(node.id);
    recoveredRoleById.set(node.id, role);
    const name = getName();
    if (name) recoveredNameById.set(node.id, name);
  }

  if (recoveredIds.size === 0) return nodes;

  const parentMap = buildParentMap(nodes);
  for (const nodeId of [...recoveredIds]) {
    let current = parentMap.get(nodeId) ?? null;
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

const CONTEXT_LABEL_ROLES = new Set([
  "heading",
  "article",
  "section",
  "group",
  "region",
  "row",
  "form",
]);

interface DomContextIndex {
  labelsByScopeParent: Map<string | undefined, Map<number, VomNode[]>>;
}

function buildDomContextIndex(nodes: VomNode[]): DomContextIndex {
  const labelsByScopeParent = new Map<string | undefined, Map<number, VomNode[]>>();
  for (const node of nodes) {
    if (isVomReferenceNode(node) || isContextBoundary(node)) continue;
    const parentId = node.domParentId;
    if (parentId === undefined || parentId === null) continue;
    let byParent = labelsByScopeParent.get(node.contextScopeId);
    if (!byParent) {
      byParent = new Map();
      labelsByScopeParent.set(node.contextScopeId, byParent);
    }
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(node);
    byParent.set(parentId, siblings);
  }
  return { labelsByScopeParent };
}

function duplicateReferenceNames(nodes: VomNode[]): Set<string> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!isVomReferenceNode(node)) continue;
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
  if (!CONTEXT_LABEL_ROLES.has(normalizedRole(node))) return undefined;
  return weakContextText(
    cleaned(node.name) ?? cleaned(node.text) ?? cleaned(node.nearbyText),
    targetName,
  );
}

function weakLabelContext(node: VomNode, targetName: string): string | undefined {
  if (isVomReferenceNode(node)) return undefined;
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

function sharesContextScope(node: VomNode, candidate: VomNode): boolean {
  return node.contextScopeId === candidate.contextScopeId;
}

function collectWeakLabelsFromSubtree(
  node: VomNode,
  target: VomNode,
  nodeName: string,
  state: RenderState,
  labels: string[],
): void {
  if (!sharesContextScope(target, node)) return;
  if (isVomReferenceNode(node)) return;
  const label = weakLabelContext(node, nodeName);
  if (label) {
    labels.push(label);
    return;
  }
  for (const child of state.children.get(node.id) ?? []) {
    collectWeakLabelsFromSubtree(child, target, nodeName, state, labels);
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
    if (!sharesContextScope(node, parent)) break;
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
    const end = state.siblingIndex.get(childId) ?? siblings.length;
    let cache = state.siblingContextCache.get(parentId);
    if (!cache) {
      cache = new Map();
      state.siblingContextCache.set(parentId, cache);
    }
    // The subtree collector depends on scope, target name and incoming labels.
    // Include all three so descendants arriving from different containers retain
    // the original context semantics. DFS visits sibling prefixes in order.
    const key = JSON.stringify([node.contextScopeId, nodeName, labels]);
    let prefix = cache.get(key);
    if (!prefix || prefix.nextIndex > end) prefix = { nextIndex: 0, labels: [...labels] };
    for (; prefix.nextIndex < end; prefix.nextIndex++) {
      collectWeakLabelsFromSubtree(
        siblings[prefix.nextIndex],
        node,
        nodeName,
        state,
        prefix.labels,
      );
      while (prefix.labels.length > MAX_HANDLE_CONTEXT_ITEMS) prefix.labels.shift();
    }
    labels.splice(0, labels.length, ...prefix.labels);
    // Bound retained variants on pages with many distinct action names.
    if (!cache.has(key) && cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, prefix);

    const parent = state.nodesById.get(parentId);
    if (!parent || !sharesContextScope(node, parent) || isContextBoundary(parent)) break;
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
  const byParent = state.domContextIndex.labelsByScopeParent.get(node.contextScopeId);
  for (const ancestorId of ancestorIds) {
    const ancestor = state.nodesById.get(ancestorId);
    // Body/document siblings describe other records, not this action. An
    // omitted generic wrapper still has an ID, so its direct text stays local.
    if (
      ancestor &&
      (["rootwebarea", "webarea", "document"].includes(normalizedRole(ancestor)) ||
        ["body", "html"].includes(ancestor.tag.toLowerCase()))
    )
      break;
    const owned =
      ancestor &&
      sharesContextScope(node, ancestor) &&
      !isVomReferenceNode(ancestor) &&
      weakContextText(cleaned(ancestor.text) ?? cleaned(ancestor.name), nodeName);
    if (owned) return [{ text: owned, source: "dom", order: 0 }];
    const contexts: ContextCandidate[] = [];
    for (const candidate of byParent?.get(ancestorId) ?? []) {
      if (candidate.id === node.id) continue;
      const label = weakLabelContext(candidate, nodeName);
      if (label) contexts.push({ text: label, source: "dom", order: contexts.length });
    }
    if (contexts.length) return contexts;
    if (ancestor && isContextBoundary(ancestor)) break;
  }
  return [];
}

function handleContext(node: VomNode, state: RenderState): string[] {
  const name = cleaned(node.name);
  if (!name || !needsHandleContext(name, state.duplicateRefNames)) return [];
  // Semantic/AX order can flatten a card and place its text after the CTA.
  // Prefer raw DOM containment in either order over preceding unrelated rows.
  if (node.domAncestorIds?.length) return dedupeContexts(collectDomContext(node, name, state));
  return dedupeContexts([
    ...collectOwnedContext(node, name, state),
    ...collectSameContainerContext(node, name, state),
  ]);
}

function capCodePoints(raw: string, maxChars: number): string {
  const cps = [...raw];
  return cps.length > maxChars ? `${cps.slice(0, maxChars).join("").trimEnd()}…` : raw;
}

function formatOptionToken(val: string, lbl: string, selected: boolean): string {
  const star = selected ? "*" : "";
  const cappedLbl = capCodePoints(lbl, MAX_INLINE_OPTION_LABEL_CHARS);
  if (val === lbl) return `${JSON.stringify(cappedLbl)}${star}`;
  const cappedVal = capCodePoints(val, MAX_INLINE_OPTION_VALUE_CHARS);
  const key = /^[A-Za-z0-9_.:/-]+$/.test(cappedVal) ? cappedVal : JSON.stringify(cappedVal);
  return `${key}=${JSON.stringify(cappedLbl)}${star}`;
}

function formatInlineSelectOptions(node: VomNode, state?: RenderState): string | undefined {
  if (node.selectOptions && node.selectOptions.length > 0) {
    const specs = node.selectOptions
      .slice(0, MAX_INLINE_SELECT_OPTIONS)
      .map((opt) => formatOptionToken(opt.value, cleaned(opt.label) ?? "", opt.selected === true));
    if (node.selectOptionsTruncated || node.selectOptions.length > MAX_INLINE_SELECT_OPTIONS) {
      specs.push("…");
    }
    return specs.join(" | ");
  }
  if (!state) return undefined;
  const specs: string[] = [];
  const selVal = cleaned(node.value);
  const stack = [...(state.children.get(node.id) ?? [])].reverse();
  while (stack.length > 0) {
    const child = stack.pop() as VomNode;
    const cTag = normalizedTag(child);
    const cRole = normalizedRole(child);
    if (cTag === "optgroup" || (cRole === "group" && cTag !== "option")) {
      const nested = state.children.get(child.id) ?? [];
      for (let i = nested.length - 1; i >= 0; i -= 1) stack.push(nested[i]);
      continue;
    }
    if (cTag !== "option" && cRole !== "option") continue;
    if (specs.length >= MAX_INLINE_SELECT_OPTIONS) {
      specs.push("…");
      break;
    }
    const lbl = cleaned(child.attrs?.label) ?? cleaned(child.name) ?? cleaned(child.text) ?? "";
    const val = child.attrs?.value ?? lbl;
    const selected =
      child.checked === true ||
      child.attrs?.["aria-selected"] === "true" ||
      Object.prototype.hasOwnProperty.call(child.attrs ?? {}, "selected") ||
      (selVal !== undefined && val === selVal);
    specs.push(formatOptionToken(val, lbl, selected));
  }
  return specs.length > 0 ? specs.join(" | ") : undefined;
}

function renderNodeLine(
  node: VomNode,
  depth: number,
  ref: string | undefined,
  context: string[] = [],
  surface: CondSurface | undefined = undefined,
  redactValues = false,
  state?: RenderState,
): string {
  const isNativeSelect = normalizedTag(node) === "select";
  let line = `${"  ".repeat(depth)}${ref ? `@${ref} ` : ""}${node.role ?? "generic"}`;

  const hint = dragHint(node);
  if (hint) line += ` [${hint}]`;
  const suppressRedundantTableName =
    normalizedRole(node) === "table" &&
    state?.foldedTableIds.has(node.id) === true &&
    !node.attrs?.["aria-label"]?.trim() &&
    !node.attrs?.["aria-labelledby"]?.trim() &&
    !node.attrs?.title?.trim() &&
    descendantTextCoveredByName(node, state);
  const name = suppressRedundantTableName ? undefined : cleaned(node.name);
  if (name) line += ` ${JSON.stringify(name)}`;
  const boundField = !name ? state?.boundFieldLabels.get(node.id) : undefined;
  if (boundField) line += ` [field: ${JSON.stringify(boundField)}]`;
  if (context.length > 0) line += ` [ctx: ${context.join(" > ")}]`;

  // For link nodes with an external href, annotate so the agent can
  // distinguish external navigation from same-origin links.
  if (normalizedRole(node) === "link" && node.href) {
    line += ` [→ ${node.href}]`;
  }

  const rawValue = cleaned(node.value);
  const role = normalizedRole(node);
  const fillable = ["textbox", "searchbox"].includes(role);
  if (node.disabled) line += " [disabled]";
  const selection = selectionMarker(node);
  if (selection) line += ` [${selection}]`;
  if (node.checked !== undefined) {
    line += ` [${node.checked === "mixed" ? "mixed" : node.checked ? "checked" : "unchecked"}]`;
  }
  if (fillable) {
    line += ` [${node.inputState ?? (rawValue === undefined ? "empty" : "filled")}]`;
  }
  const placeholder = cleaned(node.placeholder);
  if (placeholder) line += ` placeholder=${JSON.stringify(placeholder)}`;
  const hasValue =
    rawValue !== undefined || node.inputState === "filled" || node.inputState === "default";
  const value =
    node.sensitive || redactValues
      ? hasValue
        ? SENSITIVE_MASK
        : undefined
      : rawValue?.slice(0, MAX_VALUE_LENGTH);
  if (value !== undefined) line += ` =${JSON.stringify(value)}`;

  if (isNativeSelect && !node.sensitive && !redactValues) {
    const inlineOpts = formatInlineSelectOptions(node, state);
    if (inlineOpts) line += ` [options: ${inlineOpts}]`;
  } else if (role === "combobox" && !isNativeSelect && !isEditableCombobox(node)) {
    const expanded = node.attrs?.["aria-expanded"]?.toLowerCase() === "true";
    line += expanded ? " [custom-dropdown: expanded]" : " [custom-dropdown: click to open]";
  }

  if (surface && surface.subItems.length > 0) {
    const items = surface.subItems.slice(0, MAX_SURFACE_ITEMS).join(" | ");
    const suffix = surface.subItems.length > MAX_SURFACE_ITEMS ? " | …" : "";
    const action =
      surface.triggerAction === "hover" ? "hover first" : `${surface.triggerAction} first`;
    line += ` [${action}: ${items}${suffix}]`;
  }

  return line;
}

function isEditableCombobox(node: VomNode): boolean {
  const tag = normalizedTag(node);
  const attrs = node.attrs ?? {};
  const isReadonly =
    Object.prototype.hasOwnProperty.call(attrs, "readonly") ||
    attrs["aria-readonly"]?.trim().toLowerCase() === "true";
  if ((tag === "input" || tag === "textarea") && !isReadonly) return true;
  const ce = attrs.contenteditable?.trim().toLowerCase();
  if (ce === "" || ce === "true" || ce === "plaintext-only") return true;
  const auto = attrs["aria-autocomplete"]?.trim().toLowerCase();
  if (auto && auto !== "none") return true;
  return false;
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
    if (isVomReferenceNode(child)) return false;
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
  visualAncestors: Set<number>;
  lines: string[];
  refs: RenderedRef[];
  nextRef: number;
  allocateRef?: VomOptions["allocateRef"];
  tokens: number;
  maxDepth: number;
  maxTokens: number;
  redactValues: boolean;
  truncated: boolean;
  children: Map<number | null, VomNode[]>;
  siblingIndex: Map<number, number>;
  siblingContextCache: Map<number, Map<string, { nextIndex: number; labels: string[] }>>;
  parentMap: Map<number, number | null>;
  nodesById: Map<number, VomNode>;
  domContextIndex: DomContextIndex;
  duplicateRefNames: Set<string>;
  surfaceMap: Map<number, CondSurface>;
  scopeMap: Map<number, ActiveScopeBlock>;
  hasInteractiveDescendant: Set<number>;
  boundFieldLabels: Map<number, string>;
  consumedCaptionIds: Set<number>;
  foldedRowCells: Map<number, string>;
  foldedTableIds: Set<number>;
  transparentRowgroupIds: Set<number>;
}

export interface RenderRow {
  context?: string;
  frameId?: string;
  text: string;
  ref?: RenderedRef;
  /** Minimal complete visual entry when a long label cannot fit. */
  minimal?: string;
}

function pushRenderChildren(
  stack: Array<{ node: VomNode; depth: number }>,
  children: readonly VomNode[],
  depth: number,
): void {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    stack.push({ node: children[index], depth });
  }
}

function collectSubtreeText(node: VomNode, children: Map<number | null, VomNode[]>): string {
  const kids = children.get(node.id) ?? [];
  const ownName = cleaned(node.name);
  if (kids.length === 0) {
    return ownName ?? cleaned(node.text) ?? cleaned(node.value) ?? "";
  }
  const kidTexts = kids.map((child) => collectSubtreeText(child, children)).filter(Boolean);
  if (ownName && (kidTexts.length === 0 || kidTexts.every((text) => ownName.includes(text)))) {
    return ownName;
  }
  if (kidTexts.length > 0) return kidTexts.join(" ");
  return ownName ?? cleaned(node.text) ?? cleaned(node.value) ?? "";
}

function* renderTreeRows(
  children: Map<number | null, VomNode[]>,
  state: RenderState,
  observation = false,
  representedSources?: ReadonlySet<number>,
): Generator<RenderRow> {
  const stack: Array<{ node: VomNode; depth: number }> = [];
  pushRenderChildren(stack, children.get(null) ?? [], 1);

  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: VomNode; depth: number };

    if (state.consumedCaptionIds.has(node.id)) {
      continue;
    }

    if (
      state.transparentRowgroupIds.has(node.id) ||
      representedSources?.has(node.id) ||
      (node.visualKey === undefined && !shouldRender(node))
    ) {
      pushRenderChildren(stack, children.get(node.id) ?? [], depth);
      continue;
    }

    const rawParent = node.parentId === null ? undefined : state.nodesById.get(node.parentId);
    const rawParentLabel = rawParent ? cleaned(rawParent.name) : undefined;

    // CJK-safe exact parent-child echo deduplication: fold statictext only when verbatim equal (`===`).
    if (
      node.visualKey === undefined &&
      !isVomReferenceNode(node) &&
      !state.hasInteractiveDescendant.has(node.id) &&
      normalizedRole(node) === "statictext" &&
      rawParent &&
      shouldRender(rawParent) &&
      rawParentLabel !== undefined &&
      cleaned(node.name) === rawParentLabel
    ) {
      continue;
    }

    if (depth > state.maxDepth && node.visualKey === undefined) {
      state.truncated = true;
      if (observation && state.visualAncestors.has(node.id))
        pushRenderChildren(stack, children.get(node.id) ?? [], depth);
      continue;
    }

    const foldedCells = state.foldedRowCells.get(node.id);
    if (foldedCells !== undefined && node.visualKey === undefined) {
      const parent = observation ? rawParent : undefined;
      const parentLabel = parent ? rawParentLabel : undefined;
      const indent = "  ".repeat(Math.min(depth, state.maxDepth, 32));
      yield {
        ...(parent
          ? {
              context: `@context ${parent.role ?? parent.tag}${parentLabel ? ` ${JSON.stringify(Array.from(parentLabel).slice(0, 80).join(""))}` : ""}`,
            }
          : {}),
        frameId: node.frameId,
        text: `${indent}row ${JSON.stringify(foldedCells)}`,
      };
      continue;
    }

    const visual = node.visualKey !== undefined;
    const ref =
      visual || isVomReferenceNode(node)
        ? (state.allocateRef?.(node) ?? `e${state.nextRef++}`)
        : undefined;
    const context = ref && !visual ? handleContext(node, state) : [];
    const surface = state.surfaceMap.get(node.id);
    const indent = "  ".repeat(Math.min(depth, state.maxDepth, 32));
    const minimal = visual ? `${indent}@${ref} canvas [visual:screenshot]` : undefined;
    const label = cleaned(node.name);
    const effectiveRefName = label ?? (!visual ? state.boundFieldLabels.get(node.id) : undefined);
    const rowAnchor = ref && !visual ? node.rowAnchor : undefined;
    const text = visual
      ? label
        ? `${indent}@${ref} canvas ${JSON.stringify(Array.from(label).slice(0, 160).join(""))} [visual:screenshot]`
        : minimal!
      : renderNodeLine(node, depth, ref, context, surface, state.redactValues, state);
    const parent = observation ? rawParent : undefined;
    const parentLabel = parent ? rawParentLabel : undefined;
    yield {
      ...(parent
        ? {
            context: `@context ${parent.role ?? parent.tag}${parentLabel ? ` ${JSON.stringify(Array.from(parentLabel).slice(0, 80).join(""))}` : ""}`,
          }
        : {}),
      frameId: node.frameId,
      text,
      ...(minimal ? { minimal } : {}),
      ...(ref
        ? {
            ref: {
              ref,
              backendNodeId: node.backendNodeId ?? node.id,
              ...(visual ? { visualKey: node.visualKey } : {}),
              ...(node.frameId ? { frameId: node.frameId } : {}),
              ...(node.role ? { role: node.role } : {}),
              ...(effectiveRefName ? { name: effectiveRefName } : {}),
              ...(context.length > 0 ? { ctx: context.join(" > ") } : {}),
              ...(rowAnchor ? { rowAnchor } : {}),
              line: 0,
            },
          }
        : {}),
    };
    const scope = state.scopeMap.get(node.id);
    if (scope?.lines.length) {
      yield { text: `${"  ".repeat(depth + 1)}[§ active: ${scope.label}]` };
      for (const text of scope.lines.slice(0, MAX_SCOPE_LINES)) {
        const clean = cleaned(text);
        if (clean) yield { text: `${"  ".repeat(depth + 2)}${clean}` };
      }
    }

    if (
      (!observation || !state.visualAncestors.has(node.id)) &&
      ((ref && shouldSkipRedundantRefChildren(node)) || shouldSkipRedundantChildren(node, state))
    ) {
      continue;
    }
    pushRenderChildren(stack, children.get(node.id) ?? [], depth + 1);
  }
}

function pureStaticCaptionText(
  candidate: VomNode,
  children: Map<number | null, VomNode[]>,
  state: RenderState,
): string | undefined {
  if (
    candidate.visualKey !== undefined ||
    isVomReferenceNode(candidate) ||
    state.hasInteractiveDescendant.has(candidate.id) ||
    state.visualAncestors.has(candidate.id)
  ) {
    return undefined;
  }
  const role = normalizedRole(candidate);
  if (!["statictext", "labeltext", "text", ""].includes(role)) return undefined;
  const attrs = candidate.attrs;
  if (attrs) {
    const live = attrs["aria-live"]?.trim().toLowerCase();
    if (live && live !== "off") return undefined;
    const cls = attrs.class?.trim();
    if (cls && NON_CAPTION_ATTR_CLASS_RE.test(cls)) return undefined;
    const idAttr = attrs.id?.trim();
    if (idAttr && NON_CAPTION_ATTR_CLASS_RE.test(idAttr)) return undefined;
  }
  const kids = children.get(candidate.id) ?? [];
  let text: string | undefined;
  if (kids.length === 0) {
    text = cleaned(candidate.name) ?? cleaned(candidate.text);
  } else if (
    kids.length === 1 &&
    normalizedRole(kids[0]) === "statictext" &&
    (children.get(kids[0].id) ?? []).length === 0
  ) {
    text =
      cleaned(kids[0].name) ??
      cleaned(kids[0].text) ??
      cleaned(candidate.name) ??
      cleaned(candidate.text);
  } else {
    return undefined;
  }
  if (!text || text.length > 64 || isNoisyText(text)) return undefined;
  if (NON_CAPTION_TOKEN_RE.test(text) || NON_CAPTION_VALIDATION_RE.test(text)) return undefined;
  return text;
}

function isTrailingSuffixOfPreviousControl(
  prevControl: VomNode | undefined,
  captionNode: VomNode,
  curInput: VomNode,
  state: RenderState,
): boolean {
  if (!prevControl) return false;
  const isControl =
    isVomReferenceNode(prevControl) ||
    LABELABLE_INPUT_ROLES.has(normalizedRole(prevControl)) ||
    state.hasInteractiveDescendant.has(prevControl.id);
  if (!isControl) return false;
  // In `[input1] "text" [input2]`, if `input1` itself had no name or bound caption,
  // this is a compound/range group (`[min] "至" [max]`), not `[label, input]` pairs.
  if (
    LABELABLE_INPUT_ROLES.has(normalizedRole(prevControl)) &&
    !cleaned(prevControl.name) &&
    !state.boundFieldLabels.has(prevControl.id)
  ) {
    return true;
  }
  const pr = prevControl.rect;
  const cr = captionNode.rect;
  const nr = curInput.rect;
  if (pr && cr && nr && pr.h > 0 && cr.h > 0 && nr.h > 0) {
    const prevMidY = pr.y + pr.h / 2;
    const capMidY = cr.y + cr.h / 2;
    const sameRowAsPrev =
      cr.x >= pr.x + pr.w - 4 && Math.abs(capMidY - prevMidY) <= Math.max(pr.h, 16) * 0.65;
    const curBelowPrev = nr.y >= pr.y + pr.h * 0.7;
    if (sameRowAsPrev && curBelowPrev) return true;
  }
  return false;
}

function extractPureReadOnlyRowText(
  row: VomNode,
  children: Map<number | null, VomNode[]>,
  state: RenderState,
): string | undefined {
  if (
    row.visualKey !== undefined ||
    state.visualAncestors.has(row.id) ||
    normalizedRole(row) !== "row" ||
    isVomReferenceNode(row) ||
    state.hasInteractiveDescendant.has(row.id)
  ) {
    return undefined;
  }
  const kids = children.get(row.id) ?? [];
  if (kids.length === 0) return undefined;
  const cells: string[] = [];
  for (const kid of kids) {
    if (
      kid.visualKey !== undefined ||
      state.visualAncestors.has(kid.id) ||
      !TABLE_CELL_ROLES.has(normalizedRole(kid))
    ) {
      return undefined;
    }
    cells.push(collectSubtreeText(kid, children));
  }
  if (cells.every((cell) => !cell)) return undefined;
  return cells.join(" | ");
}

function recordFoldedRowRuns(
  seq: readonly VomNode[],
  children: Map<number | null, VomNode[]>,
  state: RenderState,
): void {
  let run: Array<{ id: number; text: string }> = [];
  const flush = () => {
    if (run.length >= MIN_FOLDABLE_TABLE_ROWS) {
      for (const item of run) state.foldedRowCells.set(item.id, item.text);
    }
    run = [];
  };
  for (const item of seq) {
    const rowText = extractPureReadOnlyRowText(item, children, state);
    if (rowText !== undefined) {
      run.push({ id: item.id, text: rowText });
    } else {
      flush();
    }
  }
  flush();
}

function createRenderState(
  nodes: VomNode[],
  options: VomOptions,
  initialLines: string[],
  surfaces: CondSurface[],
  activeScopeBlocks: ActiveScopeBlock[],
): RenderState {
  const children = buildChildren(nodes);
  const siblingIndex = new Map<number, number>();
  for (const siblings of children.values()) {
    for (let index = 0; index < siblings.length; index++)
      siblingIndex.set(siblings[index].id, index);
  }
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const duplicateRefNames = duplicateReferenceNames(nodes);
  const state: RenderState = {
    visualAncestors: new Set(),
    siblingIndex,
    siblingContextCache: new Map(),
    lines: [...initialLines],
    refs: [],
    nextRef: 1,
    allocateRef: options.allocateRef,
    tokens: Number.isFinite(maxTokens) ? estimateTokens(initialLines.join("\n")) : 0,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxTokens,
    redactValues: options.redactValues ?? false,
    truncated: false,
    children,
    parentMap: buildParentMap(nodes),
    nodesById: new Map(nodes.map((node) => [node.id, node])),
    domContextIndex:
      duplicateRefNames.size > 0 ? buildDomContextIndex(nodes) : { labelsByScopeParent: new Map() },
    duplicateRefNames,
    surfaceMap: new Map(surfaces.map((surface) => [surface.triggerId, surface])),
    scopeMap: new Map(activeScopeBlocks.map((scope) => [scope.triggerId, scope])),
    hasInteractiveDescendant: new Set(),
    boundFieldLabels: new Map(),
    consumedCaptionIds: new Set(),
    foldedRowCells: new Map(),
    foldedTableIds: new Set(),
    transparentRowgroupIds: new Set(),
  };

  for (const node of nodes) {
    if (node.visualKey !== undefined) {
      let id = node.parentId;
      while (id !== null && !state.visualAncestors.has(id)) {
        state.visualAncestors.add(id);
        id = state.parentMap.get(id) ?? null;
      }
    }
    if (node.visualKey !== undefined || isVomReferenceNode(node)) {
      let pid = state.parentMap.get(node.id) ?? null;
      let guard = 0;
      while (pid !== null && guard++ <= state.parentMap.size) {
        if (state.hasInteractiveDescendant.has(pid)) break;
        state.hasInteractiveDescendant.add(pid);
        pid = state.parentMap.get(pid) ?? null;
      }
    }
  }

  for (const siblings of children.values()) {
    for (let i = 0; i < siblings.length; i++) {
      const cur = siblings[i];
      if (!LABELABLE_INPUT_ROLES.has(normalizedRole(cur)) || cleaned(cur.name)) continue;
      let bound = false;
      if (i > 0) {
        const prev = siblings[i - 1];
        const prevBefore = i >= 2 ? siblings[i - 2] : undefined;
        if (
          prev.visualKey === undefined &&
          !isVomReferenceNode(prev) &&
          !state.hasInteractiveDescendant.has(prev.id) &&
          !state.consumedCaptionIds.has(prev.id) &&
          !isTrailingSuffixOfPreviousControl(prevBefore, prev, cur, state)
        ) {
          const caption = pureStaticCaptionText(prev, children, state);
          if (caption) {
            state.boundFieldLabels.set(cur.id, caption);
            state.consumedCaptionIds.add(prev.id);
            bound = true;
          }
        }
      }
      if (!bound && cur.nearbyText) {
        const near = cleanSemanticText(cur.nearbyText);
        if (
          near &&
          near.length <= 48 &&
          !NON_CAPTION_TOKEN_RE.test(near) &&
          !NON_CAPTION_VALIDATION_RE.test(near)
        ) {
          state.boundFieldLabels.set(cur.id, near);
        }
      }
    }
  }

  for (const container of nodes) {
    const cRole = normalizedRole(container);
    if (cRole === "table" || cRole === "grid") {
      const seq: VomNode[] = [];
      const inlineRowgroups: VomNode[] = [];
      for (const ch of children.get(container.id) ?? []) {
        const hasExplicitRgLabel = Boolean(
          ch.attrs?.["aria-label"]?.trim() ||
            ch.attrs?.["aria-labelledby"]?.trim() ||
            ch.attrs?.title?.trim(),
        );
        const chRole = normalizedRole(ch);
        const chTag = normalizedTag(ch);
        const isPureRg =
          ch.visualKey === undefined &&
          !isVomReferenceNode(ch) &&
          !hasExplicitRgLabel &&
          (chRole === "rowgroup" ||
            chTag === "thead" ||
            chTag === "tbody" ||
            chTag === "tfoot" ||
            !shouldRender(ch)) &&
          (!cleaned(ch.name) || descendantTextCoveredByName(ch, state));
        if (isPureRg) {
          inlineRowgroups.push(ch);
          seq.push(...(children.get(ch.id) ?? []));
        } else {
          seq.push(ch);
        }
      }
      const prevFoldedCount = state.foldedRowCells.size;
      recordFoldedRowRuns(seq, children, state);
      if (state.foldedRowCells.size > prevFoldedCount) {
        state.foldedTableIds.add(container.id);
      }
      for (const rg of inlineRowgroups) {
        const rgKids = children.get(rg.id) ?? [];
        if (rgKids.length > 0 && rgKids.every((rk) => state.foldedRowCells.has(rk.id))) {
          state.transparentRowgroupIds.add(rg.id);
        }
      }
    } else if (cRole === "rowgroup") {
      const parentId = state.parentMap.get(container.id) ?? null;
      const parentRole = parentId === null ? "" : normalizedRole(state.nodesById.get(parentId)!);
      if (parentRole !== "table" && parentRole !== "grid") {
        recordFoldedRowRuns(children.get(container.id) ?? [], children, state);
      }
    }
  }

  return state;
}

function renderNodes(
  nodes: VomNode[],
  options: VomOptions,
  initialLines: string[],
  surfaces: CondSurface[] = [],
  activeScopeBlocks: ActiveScopeBlock[] = [],
): RenderState {
  const state = createRenderState(nodes, options, initialLines, surfaces, activeScopeBlocks);
  const children = state.children;
  const budgetFinite = Number.isFinite(state.maxTokens);
  for (const row of renderTreeRows(children, state)) {
    if (budgetFinite) {
      const cost = estimateLineTokens(row.text);
      if (state.tokens + cost > state.maxTokens) {
        state.truncated = true;
        break;
      }
      state.tokens += cost;
    }
    if (row.ref) state.refs.push({ ...row.ref, line: state.lines.length });
    state.lines.push(row.text);
  }

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

function paintLineageByFrame(
  node: VomNode,
  parentMap: Map<number, number | null>,
  nodesById: Map<number, VomNode>,
): Map<string | undefined, VomNode> {
  const lineage = new Map<string | undefined, VomNode>();
  let current: VomNode | undefined = node;
  let guard = 0;
  while (current && guard <= parentMap.size) {
    if (!lineage.has(current.frameId)) lineage.set(current.frameId, current);
    const parentId: number | null = parentMap.get(current.id) ?? null;
    current = parentId === null ? undefined : nodesById.get(parentId);
    guard += 1;
  }
  return lineage;
}

function cachedPaintLineageByFrame(
  node: VomNode,
  parentMap: Map<number, number | null>,
  nodesById: Map<number, VomNode>,
  cache: Map<number, Map<string | undefined, VomNode>>,
): Map<string | undefined, VomNode> {
  const cached = cache.get(node.id);
  if (cached) return cached;
  const lineage = paintLineageByFrame(node, parentMap, nodesById);
  cache.set(node.id, lineage);
  return lineage;
}

/** Resolve both nodes to the nearest document where their paint order is comparable. */
function comparablePaintNodes(
  target: VomNode,
  blocker: VomNode,
  parentMap: Map<number, number | null>,
  nodesById: Map<number, VomNode>,
  lineageCache: Map<number, Map<string | undefined, VomNode>>,
): { target: VomNode; blocker: VomNode } | null {
  if (target.frameId === blocker.frameId) return { target, blocker };
  const targetLineage = cachedPaintLineageByFrame(target, parentMap, nodesById, lineageCache);
  const blockerLineage = cachedPaintLineageByFrame(blocker, parentMap, nodesById, lineageCache);
  for (const [frameId, blockerInFrame] of blockerLineage) {
    const targetInFrame = targetLineage.get(frameId);
    if (targetInFrame) return { target: targetInFrame, blocker: blockerInFrame };
  }
  return null;
}

function isBlockedByRegion(
  target: VomNode,
  blocker: VomNode,
  parentMap: Map<number, number | null>,
  nodesById: Map<number, VomNode>,
  fullCover: boolean,
  lineageCache: Map<number, Map<string | undefined, VomNode>>,
): boolean {
  if (target.id === blocker.id) return false;
  if (isAncestorOf(parentMap, blocker.id, target.id)) return false;
  if (isAncestorOf(parentMap, target.id, blocker.id)) return false;
  if (!target.rect || !blocker.rect) return false;
  const paintNodes = comparablePaintNodes(target, blocker, parentMap, nodesById, lineageCache);
  if (!paintNodes) return false;

  const points = interactionPoints(target.rect);

  if (
    !fullCover &&
    paintNodes.target.paintOrder >= paintNodes.blocker.paintOrder &&
    points.some(([x, y]) => rectContains(blocker.rect as Rect, x, y))
  ) {
    return false;
  }

  if (paintNodes.blocker.paintOrder < paintNodes.target.paintOrder) return false;
  if (
    paintNodes.blocker.paintOrder === paintNodes.target.paintOrder &&
    paintNodes.blocker.id <= paintNodes.target.id
  ) {
    return false;
  }
  // Even a near-full region must overlap the target to occlude it.
  return points.some(([x, y]) => rectContains(blocker.rect as Rect, x, y));
}

function collectDescendants(nodes: VomNode[], roots: Set<number>): Set<number> {
  const children = new Map<number, number[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node.id);
    children.set(node.parentId, siblings);
  }

  const included = new Set(roots);
  const queue = [...roots];
  for (let index = 0; index < queue.length; index += 1) {
    for (const childId of children.get(queue[index]) ?? []) {
      if (included.has(childId)) continue;
      included.add(childId);
      queue.push(childId);
    }
  }
  return included;
}

function applyActiveRegionPolicy(
  nodes: VomNode[],
  scene: VomScene,
  visualSources?: ReadonlyMap<number, VomNode>,
): VomNode[] {
  const candidates = nodes
    .filter(isPositionedRegionCandidate)
    .map((node) => ({
      node,
      viewportCoverage: coverage(node.rect, scene.viewport),
      fullCover: spansViewport(node.rect, scene.viewport),
    }))
    .filter((candidate) => candidate.viewportCoverage > 0 || candidate.node.modal === true);
  if (candidates.length === 0) return nodes;

  const parentMap = buildParentMap(nodes);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const lineageCache = new Map<number, Map<string | undefined, VomNode>>();

  const blockedRoots = new Set<number>();
  for (const target of nodes) {
    if (target.visualKey === undefined && !isVomReferenceNode(target)) continue;
    const blocked = candidates.some((candidate) =>
      isBlockedByRegion(
        visualSources?.get(target.id) ?? target,
        candidate.node,
        parentMap,
        nodesById,
        candidate.fullCover,
        lineageCache,
      ),
    );
    if (blocked) blockedRoots.add(target.id);
  }

  if (blockedRoots.size === 0) return nodes;
  const blocked = collectDescendants(nodes, blockedRoots);
  return nodes.filter((node) => !blocked.has(node.id));
}

function countRenderable(nodes: VomNode[]): number {
  return nodes.filter(shouldRender).length;
}

function renderDoubleLayer(scene: VomScene, layer: BlockingLayer, options: VomOptions): VomResult {
  const included = collectDescendants(scene.nodes, layer.members);
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
  const nodes = applyVomInteractionRecovery(scene.nodes);
  const renderScene = { ...scene, nodes };
  const layer = detectBlockingLayer(nodes, scene.viewport, scene.rootFrameId);
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

/** Prepare semantics once; the iterator retains traversal position, never raw capture facts. */
export function prepareObservationRender(
  scene: VomScene,
  options: VomOptions = {},
): {
  headers: string[];
  rows: Iterator<RenderRow>;
  truncated: () => boolean;
} {
  const recovered = applyVomInteractionRecovery(scene.nodes);
  const layer = detectBlockingLayer(recovered, scene.viewport, scene.rootFrameId);
  const recoveredById = new Map(recovered.map((n) => [n.id, n]));
  let nextId = recovered.reduce((max, n) => Math.max(max, n.id), 0) + 1;
  // Scope targets participate in existing filtering, never in blocker detection.
  // Keep the exact source as parent so an excluded source cannot reappear via fallback.
  const visualTargets: VomNode[] = (scene.visuals ?? []).map((v) => ({
    id: nextId++,
    parentId: v.sourceId ?? v.parentId,
    frameId: v.frameId,
    visualKey: v.key,
    tag: "canvas",
    rect: v.rect ?? (v.sourceId === undefined ? null : recoveredById.get(v.sourceId)?.rect) ?? null,
    paintOrder:
      v.paintOrder ??
      (v.sourceId === undefined ? undefined : recoveredById.get(v.sourceId)?.paintOrder) ??
      0,
    position: "static",
    pointerEvents: "none",
    referenceable: false,
  }));
  const visualSources = new Map<number, VomNode>();
  for (let i = 0; i < visualTargets.length; i++) {
    const sourceId = scene.visuals![i].sourceId;
    const source = sourceId === undefined ? undefined : recoveredById.get(sourceId);
    if (source) visualSources.set(visualTargets[i].id, { ...source, rect: visualTargets[i].rect });
  }
  const scopeNodes = [...recovered, ...visualTargets];
  const members = layer ? new Set(layer.members) : undefined;
  if (members && layer) {
    const blocker = recoveredById.get(layer.rootId)!;
    for (let i = 0; i < visualTargets.length; i++) {
      const target = visualTargets[i];
      const v = scene.visuals![i];
      if (
        v.sourceId === undefined &&
        v.paintOrder !== undefined &&
        target.frameId === blocker.frameId &&
        target.paintOrder >= blocker.paintOrder
      )
        members.add(target.id);
    }
  }
  const included = members ? collectDescendants(scopeNodes, members) : undefined;
  const scoped = included
    ? scopeNodes.filter((n) => included.has(n.id))
    : options.activeRegionPolicy
      ? applyActiveRegionPolicy(scopeNodes, scene, visualSources)
      : scopeNodes;
  const allowedVisuals = new Set(
    scoped.filter((n) => n.visualKey !== undefined).map((n) => n.visualKey),
  );
  const visible = scoped.filter((n) => n.visualKey === undefined);
  const byId = new Map(visible.map((n) => [n.id, n]));
  const ids = new Set(byId.keys());
  const before = new Map<number, VomNode[]>();
  const tail: VomNode[] = [];
  const fallbackGroups = new Map<string, number>();
  const representedSources = new Set<number>();
  for (const v of scene.visuals ?? []) {
    if (!allowedVisuals.has(v.key)) continue;
    const source = v.sourceId === undefined ? undefined : byId.get(v.sourceId);
    // Only suppress an exact passive Canvas description already carried by the visual line.
    // Action refs and distinct semantic content remain separate.
    if (
      source &&
      normalizedTag(source) === "canvas" &&
      normalizedRole(source) === "canvas" &&
      !isVomReferenceNode(source) &&
      !source.value &&
      !source.text &&
      (!cleaned(source.name) || cleaned(source.name) === cleaned(v.label))
    ) {
      representedSources.add(source.id);
    }

    const node: VomNode = {
      id: nextId++,
      parentId: v.parentId !== null && ids.has(v.parentId) ? v.parentId : null,
      tag: "canvas",
      role: "canvas",
      name: v.label,
      frameId: v.frameId,
      visualKey: v.key,
      rect: null,
      paintOrder: 0,
      position: "static",
      pointerEvents: "none",
      referenceable: false,
    };
    if (node.parentId === null) {
      const label = v.fallbackContext ?? "Unplaced Canvas regions";
      let groupId = fallbackGroups.get(label);
      if (groupId === undefined) {
        groupId = nextId++;
        fallbackGroups.set(label, groupId);
        tail.push({
          id: groupId,
          parentId: null,
          tag: "section",
          role: "group",
          name: label,
          rect: null,
          paintOrder: 0,
          position: "static",
          pointerEvents: "none",
          referenceable: false,
        });
      }
      node.parentId = groupId;
    }
    if (
      v.beforeId !== undefined &&
      ids.has(v.beforeId) &&
      byId.get(v.beforeId)?.parentId === node.parentId
    ) {
      const list = before.get(v.beforeId) ?? [];
      list.push(node);
      before.set(v.beforeId, list);
    } else tail.push(node);
  }
  const nodes = visible.flatMap((n) => [...(before.get(n.id) ?? []), n]).concat(tail);
  const headers = [
    "@vom 1",
    `@view ${scene.viewport.width}x${scene.viewport.height}`,
    `@layers ${layer ? 2 : 1} focus=L1`,
    layer ? `L1 ${layer.kind} cover=${Math.round(layer.coverage * 100)}%` : "L1 page",
  ];
  const state = createRenderState(
    nodes,
    options,
    [],
    scene.surfaces ?? [],
    scene.activeScopeBlocks ?? [],
  );
  function* rows(): Generator<RenderRow> {
    yield* renderTreeRows(state.children, state, true, representedSources);
    if (layer)
      yield {
        text: renderPageOcclusionLine(
          countRenderable(recovered.filter((n) => !included!.has(n.id))),
        ),
      };
  }
  return { headers, rows: rows(), truncated: () => state.truncated };
}
