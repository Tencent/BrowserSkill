import type { Viewport } from "@browser-skill/vom";
import type { CdpFrame, CdpTarget } from "@/browser-driver/frame-graph";
import { OVERLAY_HOST_MARKER_ATTR, OVERLAY_HOST_NAME } from "@/lib/overlay-bridge";
import type { GeometryProjection } from "../geometry";
import type { FrameProjectionIssue, SnapshotCoordinates } from "../geometry/coordinate-types";
import { createCaptureCheckpoint } from "./capture-abort";
import type { CapturedNode } from "./capture-types";
import type { FrameOwnedAxNode } from "./frame-document";

function isDecodedOverlayHost(item: DecodedNode): boolean {
  if (item.tag === OVERLAY_HOST_NAME || item.tag.toLowerCase() === OVERLAY_HOST_NAME) return true;
  const attrs = item.attrs;
  if (OVERLAY_HOST_MARKER_ATTR in attrs) return true;
  for (const key in attrs) {
    if (key.toLowerCase() === OVERLAY_HOST_MARKER_ATTR) return true;
  }
  return false;
}

const STEALTH_SKIP_SHELL_TAGS = new Set([
  "html",
  "body",
  "head",
  "meta",
  "link",
  "script",
  "style",
  "noscript",
  "template",
  "br",
  "hr",
  "wbr",
  "col",
  "colgroup",
  "svg",
  "path",
  "g",
  "defs",
  "use",
  "symbol",
  "clippath",
  "lineargradient",
  "radialgradient",
  "stop",
]);

const INTERACTIVE_OR_VISUAL_TAGS = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "option",
  "optgroup",
  "summary",
  "details",
  "iframe",
  "canvas",
  "video",
  "audio",
  "dialog",
]);

const INTERACTIVE_ARIA_ROLES = new Set([
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

const INLINE_OPACITY_RE = /(?:^|;)\s*opacity\s*:\s*([+-]?\d*\.?\d+)/i;
const INLINE_FONT_SIZE_RE = /(?:^|;)\s*font-size\s*:\s*([+-]?\d*\.?\d+)\s*px\b/i;
const INLINE_CLIP_OVERFLOW_RE = /(?:^|;)\s*overflow(?:-[xy])?\s*:\s*(?:hidden|clip)\b/i;
const MAX_SR_ONLY_LABEL_CHARS = 80;

interface ParsedRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseCssRgba(raw: string | undefined): ParsedRgba | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  if (!s || s === "none" || s === "auto" || s === "initial" || s === "inherit") return undefined;
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0] + hex[0], 16);
      const g = Number.parseInt(hex[1] + hex[1], 16);
      const b = Number.parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? Number.parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return Number.isNaN(r + g + b + a) ? undefined : { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = Number.parseInt(hex.slice(0, 2), 16);
      const g = Number.parseInt(hex.slice(2, 4), 16);
      const b = Number.parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return Number.isNaN(r + g + b + a) ? undefined : { r, g, b, a };
    }
    return undefined;
  }
  const rgbMatch =
    /^rgba?\(\s*([\d.]+)\s*(?:,\s*|\s+)([\d.]+)\s*(?:,\s*|\s+)([\d.]+)(?:\s*(?:,\s*|\/\s*)([\d.%]+))?\s*\)$/.exec(
      s,
    );
  if (rgbMatch) {
    const r = Math.round(Number.parseFloat(rgbMatch[1]));
    const g = Math.round(Number.parseFloat(rgbMatch[2]));
    const b = Math.round(Number.parseFloat(rgbMatch[3]));
    let a = 1;
    if (rgbMatch[4] !== undefined) {
      a = rgbMatch[4].endsWith("%")
        ? Number.parseFloat(rgbMatch[4]) / 100
        : Number.parseFloat(rgbMatch[4]);
    }
    return Number.isNaN(r + g + b + a) ? undefined : { r, g, b, a };
  }
  const srgbMatch =
    /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.%]+))?\s*\)$/.exec(s);
  if (srgbMatch) {
    const r = Math.round(Number.parseFloat(srgbMatch[1]) * 255);
    const g = Math.round(Number.parseFloat(srgbMatch[2]) * 255);
    const b = Math.round(Number.parseFloat(srgbMatch[3]) * 255);
    let a = 1;
    if (srgbMatch[4] !== undefined) {
      a = srgbMatch[4].endsWith("%")
        ? Number.parseFloat(srgbMatch[4]) / 100
        : Number.parseFloat(srgbMatch[4]);
    }
    return Number.isNaN(r + g + b + a) ? undefined : { r, g, b, a };
  }
  return undefined;
}

function isInteractiveFactsNode(item: DecodedNode): boolean {
  const tag = item.tag.toLowerCase();
  if (tag.startsWith("#")) return false;
  if (tag === "input") return (item.attrs.type ?? "").toLowerCase() !== "hidden";
  if (tag === "a") return "href" in item.attrs || item.clickable === true;
  if (INTERACTIVE_OR_VISUAL_TAGS.has(tag)) return true;
  const role = (item.attrs.role ?? "").trim().toLowerCase();
  if (role && INTERACTIVE_ARIA_ROLES.has(role)) return true;
  if (item.clickable === true) return true;
  if ("contenteditable" in item.attrs) {
    const ce = (item.attrs.contenteditable ?? "").trim().toLowerCase();
    if (ce === "" || ce === "true" || ce === "plaintext-only") return true;
  }
  return false;
}

type StealthKind = "container" | "microbox" | "textstyle";

function applyStealthPromptInjectionExclusions<T extends DecodedNode>(
  input: readonly T[],
  nodes: ReadonlyMap<number, T>,
  excludedBackendNodeIds: Set<number>,
): void {
  const colorCache = new Map<string, ParsedRgba | null>();
  const parseCachedColor = (raw: string | undefined): ParsedRgba | null => {
    if (!raw) return null;
    const hit = colorCache.get(raw);
    if (hit !== undefined) return hit;
    const parsed = parseCssRgba(raw) ?? null;
    colorCache.set(raw, parsed);
    return parsed;
  };

  let hasAnyOpaqueBg = false;
  const ownBgByNode = new Map<number, ParsedRgba>();
  for (let i = 0; i < input.length; i++) {
    const rawBg = input[i].layout?.styles["background-color"];
    if (!rawBg || rawBg === "rgba(0, 0, 0, 0)" || rawBg === "transparent") continue;
    const parsed = parseCachedColor(rawBg);
    if (parsed && parsed.a >= 0.05) {
      ownBgByNode.set(input[i].backendNodeId, parsed);
      hasAnyOpaqueBg = true;
    }
  }

  const bgMemo = new Map<number, ParsedRgba | null>();
  const resolveEffectiveBg = (id: number): ParsedRgba | null => {
    if (!hasAnyOpaqueBg) return null;
    const directMemo = bgMemo.get(id);
    if (directMemo !== undefined) return directMemo;
    const node = nodes.get(id);
    if (!node) return null;
    const own = ownBgByNode.get(id);
    if (own) {
      bgMemo.set(id, own);
      return own;
    }
    const parentId = node.parentBackendNodeId;
    if (parentId === null) {
      bgMemo.set(id, null);
      return null;
    }
    const parentMemo = bgMemo.get(parentId);
    if (parentMemo !== undefined) {
      bgMemo.set(id, parentMemo);
      return parentMemo;
    }
    const chain: number[] = [id];
    let cur: T | undefined = nodes.get(parentId);
    let found: ParsedRgba | null = null;
    let guard = 0;
    while (cur && guard++ < 128) {
      const m = bgMemo.get(cur.backendNodeId);
      if (m !== undefined) {
        found = m;
        break;
      }
      const curOwn = ownBgByNode.get(cur.backendNodeId);
      if (curOwn) {
        found = curOwn;
        bgMemo.set(cur.backendNodeId, curOwn);
        break;
      }
      chain.push(cur.backendNodeId);
      cur = cur.parentBackendNodeId === null ? undefined : nodes.get(cur.parentBackendNodeId);
    }
    for (let i = 0; i < chain.length; i++) bgMemo.set(chain[i], found);
    return found;
  };

  const candidates: Array<{ node: T; kind: StealthKind }> = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (item.tag.charCodeAt(0) === 35) continue;
    if (excludedBackendNodeIds.has(item.backendNodeId)) continue;
    const styles = item.layout?.styles;
    const inlineStyle = item.attrs.style;
    if (!styles && !inlineStyle) continue;

    const tag = item.tag.toLowerCase();
    if (STEALTH_SKIP_SHELL_TAGS.has(tag)) continue;

    let kind: StealthKind | undefined;

    const rawOpacity =
      styles?.opacity || (inlineStyle ? INLINE_OPACITY_RE.exec(inlineStyle)?.[1] : undefined);
    if (rawOpacity && rawOpacity !== "1") {
      const op = Number.parseFloat(rawOpacity);
      if (Number.isFinite(op) && op < 0.05) kind = "container";
    }

    const bounds = item.layout?.bounds;
    if (
      !kind &&
      bounds &&
      bounds.length >= 4 &&
      Number.isFinite(bounds[0]) &&
      Number.isFinite(bounds[1]) &&
      Number.isFinite(bounds[2]) &&
      Number.isFinite(bounds[3])
    ) {
      if (bounds[0] + bounds[2] < -500 || bounds[1] + bounds[3] < -500) {
        kind = "container";
      } else if (bounds[2] > 0 && bounds[2] < 2 && bounds[3] > 0 && bounds[3] < 2) {
        const ox = styles?.["overflow-x"];
        const oy = styles?.["overflow-y"];
        if (ox !== undefined || oy !== undefined) {
          if (ox === "hidden" || ox === "clip" || oy === "hidden" || oy === "clip") {
            kind = "container";
          }
        } else if (inlineStyle && INLINE_CLIP_OVERFLOW_RE.test(inlineStyle)) {
          kind = "container";
        } else {
          kind = "microbox";
        }
      }
    }

    if (!kind) {
      const rawFontSize =
        styles?.["font-size"] ||
        (inlineStyle ? INLINE_FONT_SIZE_RE.exec(inlineStyle)?.[1] : undefined);
      if (
        rawFontSize &&
        rawFontSize !== "16px" &&
        rawFontSize !== "12px" &&
        rawFontSize !== "14px"
      ) {
        const fs = Number.parseFloat(rawFontSize);
        if (Number.isFinite(fs) && fs <= 1.5) kind = "textstyle";
      }
    }

    if (!kind && styles?.color) {
      const fg = parseCachedColor(styles.color);
      if (fg) {
        if (fg.a < 0.05) {
          kind = "textstyle";
        } else if (hasAnyOpaqueBg) {
          const bg = resolveEffectiveBg(item.backendNodeId);
          if (bg && fg.r === bg.r && fg.g === bg.g && fg.b === bg.b) {
            kind = "textstyle";
          }
        }
      }
    }

    if (kind) candidates.push({ node: item, kind });
  }

  if (candidates.length === 0) return;

  const childrenByParent = new Map<number, T[]>();
  const idToNode = new Map<string, T>();
  const ariaRefIds = new Set<string>();
  const interactiveIds = new Set<number>();

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (item.parentBackendNodeId !== null) {
      let list = childrenByParent.get(item.parentBackendNodeId);
      if (!list) {
        list = [];
        childrenByParent.set(item.parentBackendNodeId, list);
      }
      list.push(item);
    }
    const idAttr = item.attrs.id?.trim();
    if (idAttr) idToNode.set(idAttr, item);
    const labelledBy = item.attrs["aria-labelledby"];
    if (labelledBy) {
      for (const tok of labelledBy.split(/\s+/)) if (tok) ariaRefIds.add(tok);
    }
    const describedBy = item.attrs["aria-describedby"];
    if (describedBy) {
      for (const tok of describedBy.split(/\s+/)) if (tok) ariaRefIds.add(tok);
    }
    if (isInteractiveFactsNode(item)) {
      interactiveIds.add(item.backendNodeId);
    }
  }

  const hasInteractiveDescendant = new Set<number>();
  for (const intId of interactiveIds) {
    let cur = nodes.get(intId)?.parentBackendNodeId ?? null;
    let guard = 0;
    while (cur !== null && !hasInteractiveDescendant.has(cur) && guard++ < 512) {
      hasInteractiveDescendant.add(cur);
      cur = nodes.get(cur)?.parentBackendNodeId ?? null;
    }
  }

  const subtreeTextLenMemo = new Map<number, number>();
  const subtreeTextLen = (id: number, visiting: Set<number>): number => {
    const cached = subtreeTextLenMemo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    const n = nodes.get(id);
    if (!n) return 0;
    visiting.add(id);
    let total = n.textContent ? n.textContent.replace(/\s+/g, " ").trim().length : 0;
    for (const ch of childrenByParent.get(id) ?? []) {
      if (ch.tag.startsWith("#")) continue;
      total += subtreeTextLen(ch.backendNodeId, visiting);
      if (total > MAX_SR_ONLY_LABEL_CHARS + 1) break;
    }
    visiting.delete(id);
    subtreeTextLenMemo.set(id, total);
    return total;
  };

  const exemptSubtreeIds = new Set<number>();
  const markExemptSubtree = (rootId: number): void => {
    const queue = [rootId];
    while (queue.length > 0) {
      const curId = queue.pop()!;
      if (exemptSubtreeIds.has(curId)) continue;
      exemptSubtreeIds.add(curId);
      for (const ch of childrenByParent.get(curId) ?? []) {
        queue.push(ch.backendNodeId);
      }
    }
  };

  for (const refId of ariaRefIds) {
    const target = idToNode.get(refId);
    if (target) markExemptSubtree(target.backendNodeId);
  }

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (
      item.tag.toLowerCase() === "label" &&
      item.attrs.for?.trim() &&
      subtreeTextLen(item.backendNodeId, new Set()) <= MAX_SR_ONLY_LABEL_CHARS
    ) {
      markExemptSubtree(item.backendNodeId);
    }
  }

  const hasInteractiveAncestor = (id: number): boolean => {
    let cur = nodes.get(id)?.parentBackendNodeId ?? null;
    let guard = 0;
    while (cur !== null && guard++ < 64) {
      if (interactiveIds.has(cur)) return true;
      cur = nodes.get(cur)?.parentBackendNodeId ?? null;
    }
    return false;
  };

  const hasOverflowingVisibleChild = (id: number): boolean => {
    const stack = [...(childrenByParent.get(id) ?? [])];
    let guard = 0;
    while (stack.length > 0 && guard++ < 256) {
      const ch = stack.pop()!;
      if (ch.tag.startsWith("#")) continue;
      const b = ch.layout?.bounds;
      if (b && b.length >= 4 && b[2] >= 2 && b[3] >= 2) return true;
      for (const grand of childrenByParent.get(ch.backendNodeId) ?? []) stack.push(grand);
    }
    return false;
  };

  const candidateStyleIds = new Set<number>();
  for (const c of candidates) {
    if (c.kind === "textstyle") candidateStyleIds.add(c.node.backendNodeId);
  }

  const hasNonStealthElementDescendant = (id: number): boolean => {
    const stack = [...(childrenByParent.get(id) ?? [])];
    let guard = 0;
    while (stack.length > 0 && guard++ < 512) {
      const ch = stack.pop()!;
      if (ch.tag.startsWith("#") || STEALTH_SKIP_SHELL_TAGS.has(ch.tag.toLowerCase())) continue;
      if (!candidateStyleIds.has(ch.backendNodeId)) return true;
      for (const grand of childrenByParent.get(ch.backendNodeId) ?? []) stack.push(grand);
    }
    return false;
  };

  const excludeSubtree = (rootId: number): void => {
    const queue = [rootId];
    while (queue.length > 0) {
      const curId = queue.pop()!;
      if (
        excludedBackendNodeIds.has(curId) ||
        interactiveIds.has(curId) ||
        hasInteractiveDescendant.has(curId) ||
        exemptSubtreeIds.has(curId)
      ) {
        continue;
      }
      excludedBackendNodeIds.add(curId);
      for (const ch of childrenByParent.get(curId) ?? []) {
        queue.push(ch.backendNodeId);
      }
    }
  };

  for (const { node: cand, kind } of candidates) {
    const id = cand.backendNodeId;
    if (
      excludedBackendNodeIds.has(id) ||
      interactiveIds.has(id) ||
      hasInteractiveDescendant.has(id) ||
      exemptSubtreeIds.has(id)
    ) {
      continue;
    }
    if (hasInteractiveAncestor(id) && subtreeTextLen(id, new Set()) <= MAX_SR_ONLY_LABEL_CHARS) {
      markExemptSubtree(id);
      continue;
    }
    if (kind === "microbox" && hasOverflowingVisibleChild(id)) {
      continue;
    }
    if (kind === "textstyle" && hasNonStealthElementDescendant(id)) {
      for (const ch of childrenByParent.get(id) ?? []) {
        if (ch.tag.startsWith("#")) excludedBackendNodeIds.add(ch.backendNodeId);
      }
      continue;
    }
    excludeSubtree(id);
  }
}

/** Bounds retain their raw snapshot document layout units until normalization. */
export interface SnapshotLayout {
  readonly boundsSpace: "snapshot-document-layout";
  bounds?: number[];
  /** [clientLeft, clientTop, clientWidth, clientHeight], untransformed local CSS units. */
  clientRect?: number[];
  styles: Readonly<Record<string, string>>;
}

export interface DecodedNode extends Omit<CapturedNode, "rect" | "localRect" | "rendered"> {
  nodeType?: number;
  parentMissing?: boolean;
  layout?: SnapshotLayout;
}

export interface NodeFacts extends CapturedNode {
  nodeType?: number;
  parentMissing?: boolean;
  layout?: SnapshotLayout;
}

export interface DocumentIndex<T extends DecodedNode = NodeFacts> {
  readonly nodes: ReadonlyMap<number, T>;
  readonly ancestryComplete?: ReadonlyMap<number, boolean>;
  readonly excludedBackendNodeIds: ReadonlySet<number>;
}

export interface DecodedDocument {
  nodes: DecodedNode[];
}

/** All snapshot nodes participate, including document and shadow roots. This
 * preserves overlay propagation when the semantic adapter omits those nodes. */
export async function buildDocumentIndex<T extends DecodedNode>(
  input: readonly T[],
  signal?: AbortSignal,
  includeVisualFacts = false,
): Promise<DocumentIndex<T>> {
  const checkpoint = createCaptureCheckpoint(signal);
  const nodes = new Map<number, T>();
  const overlayByNode = new Map<number, boolean>();
  const ancestryComplete = includeVisualFacts ? new Map<number, boolean>() : undefined;
  const excludedBackendNodeIds = new Set<number>();
  for (let i = 0; i < input.length; i++) {
    if (i % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    const node = input[i];
    nodes.set(node.backendNodeId, node);
  }
  let work = 0;
  for (const node of input) {
    if (work++ % 256 === 0) {
      const pending = checkpoint();
      if (pending) await pending;
    }
    if (overlayByNode.has(node.backendNodeId)) continue;
    if (!ancestryComplete && !isDecodedOverlayHost(node)) {
      if (node.parentBackendNodeId === null) {
        overlayByNode.set(node.backendNodeId, false);
        continue;
      }
      const parentOverlay = overlayByNode.get(node.parentBackendNodeId);
      if (parentOverlay !== undefined) {
        overlayByNode.set(node.backendNodeId, parentOverlay);
        if (parentOverlay) excludedBackendNodeIds.add(node.backendNodeId);
        continue;
      }
    }
    const path: DecodedNode[] = [];
    const visiting = new Set<number>();
    let current: DecodedNode | undefined = node;
    let overlay = false;
    let complete = false;
    while (current && !overlayByNode.has(current.backendNodeId)) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      if (visiting.has(current.backendNodeId)) {
        // Only an overlay inside the cycle may mark the cycle and its descendants.
        overlay = path
          .slice(path.findIndex((item) => item.backendNodeId === current!.backendNodeId))
          .some((item) => isDecodedOverlayHost(item));
        break;
      }
      visiting.add(current.backendNodeId);
      path.push(current);
      if (current.parentBackendNodeId === null) {
        if (ancestryComplete) complete = !current.parentMissing && current.nodeType === 9;
        current = undefined;
        break;
      }
      current = nodes.get(current.parentBackendNodeId);
    }
    if (current && overlayByNode.has(current.backendNodeId)) {
      overlay = overlayByNode.get(current.backendNodeId)!;
      if (ancestryComplete) complete = ancestryComplete.get(current.backendNodeId) === true;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      if (work++ % 256 === 0) {
        const pending = checkpoint();
        if (pending) await pending;
      }
      const item = path[i];
      overlay = overlay || isDecodedOverlayHost(item);
      overlayByNode.set(item.backendNodeId, overlay);
      if (ancestryComplete) {
        complete = complete && !item.parentMissing;
        ancestryComplete.set(item.backendNodeId, complete);
      }
      if (overlay) excludedBackendNodeIds.add(item.backendNodeId);
    }
  }
  applyStealthPromptInjectionExclusions(input, nodes, excludedBackendNodeIds);
  return { nodes, ...(ancestryComplete ? { ancestryComplete } : {}), excludedBackendNodeIds };
}

export interface DocumentIdentity {
  attachmentId: string;
  target: CdpTarget;
  frameId: string;
  documentElementBackendNodeId: number;
}

/** Narrow input shared by the existing semantic scene/hover consumers. */
export interface CapturedSceneInput {
  nodes: CapturedNode[];
  viewport: Viewport;
  rootFrameId?: string;
  excludedBackendNodeIds: ReadonlySet<number>;
}

export interface CaptureIssue {
  /** Owner failure or inherited blockage; absent for other geometry failures. */
  projectionIssue?: FrameProjectionIssue;
  target: CdpTarget;
  frameId?: string;
  stage: "dom" | "ax" | "identity" | "ownership" | "geometry" | "forms";
  reason:
    | "document-changed"
    | "identity-unavailable"
    | "identity-unverified"
    | "capture-unavailable"
    | "frame-ownership-unresolved"
    | "geometry-unavailable";
}

/** Shared per document; never retain the live GeometryContext in published facts. */
export interface DocumentGeometry {
  readonly projections: readonly GeometryProjection[];
  readonly coordinates: SnapshotCoordinates;
  /** Visual viewport scale (pinch), distinct from browser UI zoom. */
  readonly pageScale?: number;
}

export interface DocumentFacts<T extends FrameOwnedAxNode> {
  readonly geometry?: DocumentGeometry;
  readonly frame: CdpFrame;
  readonly identity?: DocumentIdentity;
  readonly index: DocumentIndex;
  readonly domNodes: CapturedNode[];
  readonly axNodes: T[];
}

export interface ObservationFacts<T extends FrameOwnedAxNode> {
  /** Whether visual collection was enabled; partial capture failures remain in issues. */
  readonly visualFactsCollected: boolean;
  readonly rootFrameId: string;
  readonly viewport: Viewport;
  readonly documents: readonly DocumentFacts<T>[];
  readonly issues: readonly CaptureIssue[];
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface CapturedSurfaceProbe {
  triggerBackendNodeId: number;
  triggerPoint?: { x: number; y: number };
  triggerAction: "hover" | "focus" | string;
  subItems: string[];
  confidence?: "high" | "medium" | "low";
}

export type { CapturedNode } from "./capture-types";
