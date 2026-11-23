import type { Viewport } from "@browser-skill/vom";
import type { FrameDocumentHandle, FrameDocumentInfo } from "@/browser-driver/frame-handles";
import { INTERACTIVE_ARIA_ROLES } from "@/lib/dom-predicates";
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

const INLINE_OPACITY_RE = /(?:^|;)\s*opacity\s*:\s*([+-]?\d*\.?\d+)/i;
const INLINE_FONT_SIZE_RE = /(?:^|;)\s*font-size\s*:\s*([+-]?\d*\.?\d+)\s*px\b/i;
const INLINE_CLIP_OVERFLOW_RE = /(?:^|;)\s*overflow(?:-[xy])?\s*:\s*(?:hidden|clip)\b/i;
const INLINE_SCROLL_OVERFLOW_X_RE = /(?:^|;)\s*overflow(?:-x)?\s*:\s*(?:auto|scroll|overlay)\b/i;
const INLINE_SCROLL_OVERFLOW_Y_RE = /(?:^|;)\s*overflow(?:-y)?\s*:\s*(?:auto|scroll|overlay)\b/i;
const INLINE_BG_CLIP_TEXT_RE = /(?:^|;)\s*(?:-webkit-)?background-clip\s*:\s*text\b/i;
const INLINE_BG_IMAGE_RE =
  /(?:^|;)\s*background(?:-image)?\s*:[^;]*(?:gradient|url|image-set|cross-fade|paint)\(/i;
const CSS_PX_RE = /^([+-]?(?:\d+\.?\d*|\.\d+))px$/i;
const RGBA_RE =
  /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*([+-]?(?:\d+\.?\d*|\.\d+)%?))?\s*\)$/i;
const ZERO_ALPHA_SLASH_RE = /\/\s*0(?:\.0+)?%?\s*\)$/;
const MAX_SR_ONLY_LABEL_CHARS = 80;

interface SimpleRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseCssPx(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = CSS_PX_RE.exec(raw.trim());
  if (!m) return undefined;
  const v = Number.parseFloat(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

function parseSimpleRgba(raw: string | undefined): SimpleRgba | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const m = RGBA_RE.exec(s);
  if (!m) return undefined;
  const r = Number.parseFloat(m[1]);
  const g = Number.parseFloat(m[2]);
  const b = Number.parseFloat(m[3]);
  let a = 1;
  if (m[4] !== undefined) {
    const isPct = m[4].endsWith("%");
    const parsed = Number.parseFloat(isPct ? m[4].slice(0, -1) : m[4]);
    if (!Number.isFinite(parsed)) return undefined;
    a = isPct ? parsed / 100 : parsed;
  }
  return { r, g, b, a: Math.max(0, Math.min(1, a)) };
}

function isTransparentColor(raw: string | undefined): boolean {
  if (!raw) return false;
  const s = raw.trim().toLowerCase();
  if (s === "transparent") return true;
  const rgba = parseSimpleRgba(s);
  if (rgba) return rgba.a < 0.05;
  return ZERO_ALPHA_SLASH_RE.test(s);
}

function hasNonNoneBackgroundImage(raw: string | undefined): boolean {
  const s = raw?.trim().toLowerCase();
  return Boolean(s && s !== "none" && s !== "initial" && s !== "inherit" && s !== "unset");
}

function hasBackgroundClipTextOnNode(node: DecodedNode): boolean {
  const st = node.layout?.styles;
  const inlineStyle = node.attrs.style;
  const rawClip = st?.["background-clip"]?.toLowerCase() ?? "";
  const rawWebkit = st?.["-webkit-background-clip"]?.toLowerCase() ?? "";
  const clipIsText =
    rawClip.includes("text") ||
    rawWebkit.includes("text") ||
    Boolean(inlineStyle && INLINE_BG_CLIP_TEXT_RE.test(inlineStyle));
  if (!clipIsText) return false;
  return (
    hasNonNoneBackgroundImage(st?.["background-image"]) ||
    Boolean(st?.["background-color"] && !isTransparentColor(st["background-color"])) ||
    Boolean(inlineStyle && INLINE_BG_IMAGE_RE.test(inlineStyle))
  );
}

/**
 * Only matches explicit same-element opaque `color === background-color` with no
 * `background-image` layer. Never guesses against inherited ancestor backgrounds,
 * which falsely deletes legitimate white hero headlines over `<svg>`, `::before`/`::after`,
 * sibling overlays, or composited `<img>` backdrops.
 */
function hasSelfZeroContrast(styles: Readonly<Record<string, string>>): boolean {
  if (hasNonNoneBackgroundImage(styles["background-image"])) return false;
  if (
    styles["background-clip"]?.toLowerCase().includes("text") ||
    styles["-webkit-background-clip"]?.toLowerCase().includes("text")
  ) {
    return false;
  }
  const rawFg = styles.color?.trim().toLowerCase();
  const rawBg = styles["background-color"]?.trim().toLowerCase();
  if (!rawFg || !rawBg || isTransparentColor(rawFg) || isTransparentColor(rawBg)) return false;

  const fg = parseSimpleRgba(rawFg);
  const bg = parseSimpleRgba(rawBg);
  if (fg && bg) {
    return (
      fg.a >= 0.9 &&
      bg.a >= 0.9 &&
      Math.abs(fg.r - bg.r) <= 2 &&
      Math.abs(fg.g - bg.g) <= 2 &&
      Math.abs(fg.b - bg.b) <= 2
    );
  }
  return rawFg === rawBg && !rawFg.includes("/");
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

function inferLayoutScale<T extends DecodedNode>(
  input: readonly T[],
  explicitLayoutScale?: number,
): number {
  if (
    explicitLayoutScale !== undefined &&
    Number.isFinite(explicitLayoutScale) &&
    explicitLayoutScale > 0
  ) {
    return explicitLayoutScale;
  }
  let htmlFallback: number | undefined;
  let bodyScale: number | undefined;
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    const t = item.tag.toLowerCase();
    if (t !== "html" && t !== "body") continue;
    const b = item.layout?.bounds;
    const st = item.layout?.styles;
    if (!st || !b || b.length < 4 || b[2] < 100 || !Number.isFinite(b[2])) continue;
    const cssW = parseCssPx(st.width);
    if (cssW === undefined || cssW < 50) continue;
    const rx = b[2] / cssW;
    if (!Number.isFinite(rx) || rx < 0.25 || rx > 8) continue;
    const cssH = parseCssPx(st.height);
    const skewFree =
      cssH !== undefined &&
      cssH >= 50 &&
      Number.isFinite(b[3]) &&
      b[3] > 0 &&
      Math.abs(rx - b[3] / cssH) <= 0.05 * Math.max(rx, b[3] / cssH);
    if (t === "html") {
      if (skewFree) return rx;
      htmlFallback ??= rx;
    } else if (skewFree) {
      bodyScale ??= rx;
    } else {
      htmlFallback ??= rx;
    }
  }
  return htmlFallback ?? bodyScale ?? 1;
}

type HiddenKind = "container" | "microbox" | "textstyle";

export function applyHiddenTextExclusions<T extends DecodedNode>(
  input: readonly T[],
  nodes: ReadonlyMap<number, T>,
  excludedBackendNodeIds: Set<number>,
  explicitLayoutScale?: number,
): void {
  const scale = inferLayoutScale(input, explicitLayoutScale);

  const gradientTextMemo = new Map<number, boolean>();
  const hasGradientTextPaint = (id: number): boolean => {
    const cached = gradientTextMemo.get(id);
    if (cached !== undefined) return cached;
    let cur: T | undefined = nodes.get(id);
    let found = false;
    let guard = 0;
    while (cur && guard++ < 64) {
      const hit = gradientTextMemo.get(cur.backendNodeId);
      if (hit !== undefined) {
        found = hit;
        break;
      }
      if (hasBackgroundClipTextOnNode(cur)) {
        found = true;
        break;
      }
      const rawBg = cur.layout?.styles?.["background-color"];
      if (rawBg && !isTransparentColor(rawBg)) break;
      cur = cur.parentBackendNodeId === null ? undefined : nodes.get(cur.parentBackendNodeId);
    }
    gradientTextMemo.set(id, found);
    return found;
  };

  const isScrollOverflow = (v: string | undefined): boolean =>
    v === "auto" || v === "scroll" || v === "overlay";
  const scrollAxesOf = (n: T): { scrollX: boolean; scrollY: boolean } | null => {
    const t = n.tag.toLowerCase();
    if (t === "html" || t.startsWith("#")) return null;
    const st = n.layout?.styles;
    const ox = st?.["overflow-x"] || undefined;
    const oy = st?.["overflow-y"] || undefined;
    let scrollX = false;
    let scrollY = false;
    if (ox !== undefined || oy !== undefined) {
      scrollX = isScrollOverflow(ox);
      scrollY = isScrollOverflow(oy);
    } else if (n.attrs.style) {
      scrollX = INLINE_SCROLL_OVERFLOW_X_RE.test(n.attrs.style);
      scrollY = INLINE_SCROLL_OVERFLOW_Y_RE.test(n.attrs.style);
    }
    if (!scrollX && !scrollY) return null;
    if (t === "body") {
      const parent = n.parentBackendNodeId !== null ? nodes.get(n.parentBackendNodeId) : undefined;
      if (!parent || parent.tag.toLowerCase() !== "html") return null;
      const pst = parent.layout?.styles;
      if (
        (pst?.["overflow-x"] || "visible") === "visible" &&
        (pst?.["overflow-y"] || "visible") === "visible"
      ) {
        return null;
      }
    }
    return { scrollX, scrollY };
  };
  const isExplainedByInnerScroll = (
    item: T,
    bounds: number[],
    offX: boolean,
    offY: boolean,
  ): boolean => {
    if (item.parentBackendNodeId === null) return false;
    const pos = (item.layout?.styles?.position || item.position || "static").toLowerCase();
    if (pos === "fixed" || pos === "sticky") return false;
    let remX = offX;
    let remY = offY;
    let hasPositionedAncestor = false;
    let cur: T | undefined = nodes.get(item.parentBackendNodeId);
    let guard = 0;
    while (cur && guard++ < 128) {
      const curPos = (cur.layout?.styles?.position || cur.position || "static").toLowerCase();
      if (curPos !== "static") hasPositionedAncestor = true;
      const axes = scrollAxesOf(cur);
      if (axes && (pos !== "absolute" || hasPositionedAncestor)) {
        const sr = cur.layout?.scrollRect;
        const cb = cur.layout?.bounds;
        if (sr && sr.length >= 2) {
          if (
            remX &&
            axes.scrollX &&
            sr[0] > 0 &&
            bounds[0] + bounds[2] >= (cb?.[0] ?? 0) - sr[0] * scale - 500 * scale
          ) {
            remX = false;
          }
          if (
            remY &&
            axes.scrollY &&
            sr[1] > 0 &&
            bounds[1] + bounds[3] >= (cb?.[1] ?? 0) - sr[1] * scale - 500 * scale
          ) {
            remY = false;
          }
        } else if (pos === "static") {
          const extremeThreshold = -4000 * scale;
          if (remX && axes.scrollX && bounds[0] + bounds[2] > extremeThreshold) remX = false;
          if (remY && axes.scrollY && bounds[1] + bounds[3] > extremeThreshold) remY = false;
        }
        if (!remX && !remY) return true;
      }
      cur = cur.parentBackendNodeId === null ? undefined : nodes.get(cur.parentBackendNodeId);
    }
    return false;
  };

  const offscreenTextNodes: T[] = [];
  const candidates: Array<{ node: T; kind: HiddenKind; boxScale?: number }> = [];
  const offscreenThreshold = -500 * scale;

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (item.tag.charCodeAt(0) === 35) {
      const tb = item.layout?.bounds;
      if (
        tb &&
        tb.length >= 4 &&
        (item.tag === "#text" || item.tag === "#cdata-section") &&
        !excludedBackendNodeIds.has(item.backendNodeId)
      ) {
        const offX = tb[0] + tb[2] < offscreenThreshold;
        const offY = tb[1] + tb[3] < offscreenThreshold;
        if (offX || offY) {
          const parentEl =
            item.parentBackendNodeId !== null ? nodes.get(item.parentBackendNodeId) : undefined;
          if (!parentEl || !isExplainedByInnerScroll(parentEl, tb, offX, offY)) {
            offscreenTextNodes.push(item);
          }
        }
      }
      continue;
    }
    if (excludedBackendNodeIds.has(item.backendNodeId)) continue;
    const styles = item.layout?.styles;
    const inlineStyle = item.attrs.style;
    if (!styles && !inlineStyle) continue;

    const tag = item.tag.toLowerCase();
    if (STEALTH_SKIP_SHELL_TAGS.has(tag)) continue;

    let kind: HiddenKind | undefined;
    let boxScale: number | undefined;

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
      const offX = bounds[0] + bounds[2] < offscreenThreshold;
      const offY = bounds[1] + bounds[3] < offscreenThreshold;
      if (offX || offY) {
        if (!isExplainedByInnerScroll(item, bounds, offX, offY)) {
          kind = "container";
        }
      } else if (bounds[2] > 0 && bounds[3] > 0) {
        const cssW = parseCssPx(styles?.width);
        const cssH = parseCssPx(styles?.height);
        const isCssMicrobox =
          cssW !== undefined &&
          cssH !== undefined &&
          cssW > 0 &&
          cssW < 2 &&
          cssH > 0 &&
          cssH < 2 &&
          bounds[2] <= cssW * 4 &&
          bounds[3] <= cssH * 4;
        if ((bounds[2] < 2 * scale && bounds[3] < 2 * scale) || isCssMicrobox) {
          const ox = styles?.["overflow-x"] || undefined;
          const oy = styles?.["overflow-y"] || undefined;
          if (ox !== undefined || oy !== undefined) {
            if (ox === "hidden" || ox === "clip" || oy === "hidden" || oy === "clip") {
              kind = "container";
            } else {
              kind = "microbox";
              boxScale = isCssMicrobox && cssW ? Math.max(scale, bounds[2] / cssW) : scale;
            }
          } else if (inlineStyle && INLINE_CLIP_OVERFLOW_RE.test(inlineStyle)) {
            kind = "container";
          } else {
            kind = "microbox";
            boxScale = isCssMicrobox && cssW ? Math.max(scale, bounds[2] / cssW) : scale;
          }
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
      if (isTransparentColor(styles.color)) {
        if (!hasGradientTextPaint(item.backendNodeId)) kind = "textstyle";
      } else if (hasSelfZeroContrast(styles)) {
        kind = "textstyle";
      }
    }

    if (kind) {
      candidates.push({
        node: item,
        kind,
        ...(boxScale !== undefined ? { boxScale } : {}),
      });
    }
  }

  if (candidates.length === 0 && offscreenTextNodes.length === 0) return;

  const candidateKindById = new Map<number, { kind: HiddenKind; boxScale?: number }>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    candidateKindById.set(c.node.backendNodeId, { kind: c.kind, boxScale: c.boxScale });
  }

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
    if (isInteractiveFactsNode(item)) {
      interactiveIds.add(item.backendNodeId);
    }
    if (
      !excludedBackendNodeIds.has(item.backendNodeId) &&
      (interactiveIds.has(item.backendNodeId) || !candidateKindById.has(item.backendNodeId))
    ) {
      const labelledBy = item.attrs["aria-labelledby"];
      if (labelledBy) {
        for (const tok of labelledBy.split(/\s+/)) if (tok) ariaRefIds.add(tok);
      }
      const describedBy = item.attrs["aria-describedby"];
      if (describedBy) {
        for (const tok of describedBy.split(/\s+/)) if (tok) ariaRefIds.add(tok);
      }
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
    let own = n.textContent ? n.textContent.replace(/\s+/g, " ").trim().length : 0;
    const kids = childrenByParent.get(id);
    if (own === 0 && kids) {
      for (let i = 0; i < kids.length; i++) {
        const ch = kids[i];
        if ((ch.tag === "#text" || ch.tag === "#cdata-section") && ch.textContent) {
          own += ch.textContent.replace(/\s+/g, " ").trim().length;
        }
      }
    }
    let total = own;
    if (kids) {
      for (let i = 0; i < kids.length; i++) {
        const ch = kids[i];
        if (ch.tag.startsWith("#")) continue;
        total += subtreeTextLen(ch.backendNodeId, visiting);
        if (total > MAX_SR_ONLY_LABEL_CHARS + 1) break;
      }
    }
    visiting.delete(id);
    subtreeTextLenMemo.set(id, total);
    return total;
  };

  const subtreeLabelAttrMemo = new Map<number, boolean>();
  const subtreeHasLabelAttr = (id: number, visiting: Set<number>): boolean => {
    const cached = subtreeLabelAttrMemo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return false;
    const n = nodes.get(id);
    if (!n) return false;
    const a = n.attrs;
    if (
      a["aria-label"]?.trim() ||
      a["aria-description"]?.trim() ||
      a["aria-roledescription"]?.trim() ||
      a["aria-valuetext"]?.trim() ||
      a.alt?.trim() ||
      a.title?.trim() ||
      a.placeholder?.trim()
    ) {
      subtreeLabelAttrMemo.set(id, true);
      return true;
    }
    visiting.add(id);
    let found = false;
    for (const ch of childrenByParent.get(id) ?? []) {
      if (ch.tag.startsWith("#")) continue;
      if (subtreeHasLabelAttr(ch.backendNodeId, visiting)) {
        found = true;
        break;
      }
    }
    visiting.delete(id);
    subtreeLabelAttrMemo.set(id, found);
    return found;
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
    if (target && subtreeTextLen(target.backendNodeId, new Set()) <= MAX_SR_ONLY_LABEL_CHARS) {
      markExemptSubtree(target.backendNodeId);
    }
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

  const hasOverflowingVisibleChild = (id: number, minScale: number): boolean => {
    const minDim = 2 * minScale;
    const stack = [...(childrenByParent.get(id) ?? [])];
    let guard = 0;
    while (stack.length > 0 && guard++ < 256) {
      const ch = stack.pop()!;
      if (ch.tag.startsWith("#")) continue;
      const b = ch.layout?.bounds;
      if (b && b.length >= 4 && b[2] >= minDim && b[3] >= minDim) return true;
      for (const grand of childrenByParent.get(ch.backendNodeId) ?? []) stack.push(grand);
    }
    return false;
  };

  const hasNonStealthElementDescendant = (id: number): boolean => {
    const stack = [...(childrenByParent.get(id) ?? [])];
    let guard = 0;
    while (stack.length > 0 && guard++ < 512) {
      const ch = stack.pop()!;
      const chId = ch.backendNodeId;
      if (ch.tag.startsWith("#") || STEALTH_SKIP_SHELL_TAGS.has(ch.tag.toLowerCase())) continue;
      if (excludedBackendNodeIds.has(chId)) continue;
      if (!ch.layout || ch.layout.styles.display === "none") continue;
      const candInfo = candidateKindById.get(chId);
      if (candInfo?.kind === "container") continue;
      const vis = ch.layout.styles.visibility;
      const selfHidden =
        vis === "hidden" ||
        vis === "collapse" ||
        candInfo?.kind === "textstyle" ||
        (candInfo?.kind === "microbox" &&
          !hasOverflowingVisibleChild(chId, candInfo.boxScale ?? scale));
      if (!selfHidden) return true;
      for (const grand of childrenByParent.get(chId) ?? []) stack.push(grand);
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

  for (const { node: cand, kind, boxScale } of candidates) {
    const id = cand.backendNodeId;
    if (
      excludedBackendNodeIds.has(id) ||
      interactiveIds.has(id) ||
      hasInteractiveDescendant.has(id) ||
      exemptSubtreeIds.has(id)
    ) {
      continue;
    }
    const textLen = subtreeTextLen(id, new Set());
    if (textLen === 0 && !subtreeHasLabelAttr(id, new Set())) {
      continue;
    }
    if (hasInteractiveAncestor(id) && textLen <= MAX_SR_ONLY_LABEL_CHARS) {
      markExemptSubtree(id);
      continue;
    }
    if (kind === "microbox" && hasOverflowingVisibleChild(id, boxScale ?? scale)) {
      continue;
    }
    if (kind === "textstyle" && hasNonStealthElementDescendant(id)) {
      cand.textContent = undefined;
      for (const ch of childrenByParent.get(id) ?? []) {
        if (ch.tag === "#text" || ch.tag === "#cdata-section") {
          excludedBackendNodeIds.add(ch.backendNodeId);
        }
      }
      continue;
    }
    excludeSubtree(id);
  }

  if (offscreenTextNodes.length > 0) {
    const dirtyParents = new Set<number>();
    for (let i = 0; i < offscreenTextNodes.length; i++) {
      const txt = offscreenTextNodes[i];
      const tid = txt.backendNodeId;
      if (excludedBackendNodeIds.has(tid) || exemptSubtreeIds.has(tid)) continue;
      const tlen = txt.textContent ? txt.textContent.replace(/\s+/g, " ").trim().length : 0;
      if (tlen === 0) continue;
      if (hasInteractiveAncestor(tid) && tlen <= MAX_SR_ONLY_LABEL_CHARS) continue;
      excludedBackendNodeIds.add(tid);
      if (txt.parentBackendNodeId !== null) dirtyParents.add(txt.parentBackendNodeId);
    }
    for (const pid of dirtyParents) {
      const parent = nodes.get(pid);
      if (!parent || parent.textContent === undefined) continue;
      const kept: string[] = [];
      for (const ch of childrenByParent.get(pid) ?? []) {
        if (
          (ch.tag === "#text" || ch.tag === "#cdata-section") &&
          !excludedBackendNodeIds.has(ch.backendNodeId) &&
          ch.textContent
        ) {
          const trimmed = ch.textContent.trim();
          if (trimmed) kept.push(trimmed);
        }
      }
      parent.textContent = kept.length > 0 ? kept.join(" ") : undefined;
    }
  }
}

/** Bounds retain their raw snapshot document layout units until normalization. */
export interface SnapshotLayout {
  readonly boundsSpace: "snapshot-document-layout";
  bounds?: number[];
  /** [scrollLeft, scrollTop, scrollWidth, scrollHeight], local CSS units. */
  scrollRect?: number[];
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

export interface BuildDocumentIndexOptions {
  /** Skip hidden-text exclusions until real `layoutScale` is known from `Page.getLayoutMetrics`. */
  deferHiddenTextExclusions?: boolean;
}

/** All snapshot nodes participate, including document and shadow roots. This
 * preserves overlay propagation when the semantic adapter omits those nodes. */
export async function buildDocumentIndex<T extends DecodedNode>(
  input: readonly T[],
  signal?: AbortSignal,
  includeVisualFacts = false,
  layoutScale?: number,
  options?: BuildDocumentIndexOptions,
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
  if (!options?.deferHiddenTextExclusions) {
    applyHiddenTextExclusions(input, nodes, excludedBackendNodeIds, layoutScale);
  }
  return { nodes, ...(ancestryComplete ? { ancestryComplete } : {}), excludedBackendNodeIds };
}

export interface DocumentIdentity extends FrameDocumentHandle {
  attachmentId: string;
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
  tabId: number;
  processKey: string;
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
  readonly frame: FrameDocumentInfo;
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
  triggerFrameId?: string;
  triggerPoint?: { x: number; y: number };
  triggerAction: "hover" | "focus" | string;
  subItems: string[];
  confidence?: "high" | "medium" | "low";
}

export type { CapturedNode } from "./capture-types";
