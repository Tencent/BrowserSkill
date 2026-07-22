import { detectBlockingLayer } from "./layers";
import type { BlockingLayer, VomNode, VomOptions, VomResult, VomScene } from "./types";

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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function cleaned(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

function normalizedRole(node: VomNode): string {
  return node.role?.toLowerCase() ?? "";
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
  return INTERACTIVE_ROLES.has(normalizedRole(node));
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

function renderNodeLine(node: VomNode, depth: number, ref: string | undefined): string {
  let line = `${"  ".repeat(depth)}${ref ? `@${ref} ` : ""}${node.role}`;

  const name = cleaned(node.name);
  if (name) line += ` ${JSON.stringify(name)}`;

  // For link nodes with an external href, annotate so the agent can
  // distinguish external navigation from same-origin links.
  if (node.role === "link" && node.href) {
    line += ` [→ ${node.href}]`;
  }

  const value = node.sensitive ? SENSITIVE_MASK : cleaned(node.value)?.slice(0, MAX_VALUE_LENGTH);
  if (value !== undefined) line += ` =${JSON.stringify(value)}`;

  return line;
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
    const line = renderNodeLine(node, depth, ref);
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

    renderTree(children, node.id, depth + 1, state);
  }
}

function renderNodes(nodes: VomNode[], options: VomOptions, initialLines: string[]): RenderState {
  const state: RenderState = {
    lines: [...initialLines],
    refs: [],
    nextRef: 1,
    tokens: estimateTokens(initialLines.join("\n")),
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    truncated: false,
    stopped: false,
  };

  renderTree(buildChildren(nodes), null, 1, state);

  return state;
}

function renderPageOcclusionLine(hiddenNodeCount: number): string {
  return `L2 page … occluded by L1 (~${hiddenNodeCount} nodes, not actionable)`;
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
  const state = renderNodes(visibleNodes, options, header);
  state.lines.push(renderPageOcclusionLine(hiddenCount));

  return {
    text: state.lines.join("\n"),
    refs: state.refs,
    truncated: state.truncated,
  };
}

export function renderVom(scene: VomScene, options: VomOptions = {}): VomResult {
  const layer = detectBlockingLayer(scene.nodes, scene.viewport);
  if (layer) return renderDoubleLayer(scene, layer, options);

  const state = renderNodes(scene.nodes, options, [
    "@vom 1",
    `@view ${scene.viewport.width}x${scene.viewport.height}`,
    "@layers 1 focus=L1",
    "L1 page",
  ]);

  return {
    text: state.lines.join("\n"),
    refs: state.refs,
    truncated: state.truncated,
  };
}
