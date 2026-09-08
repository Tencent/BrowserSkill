// Browser-side hover probes and overlay exclusion fallback. Static collection
// lives in capture-coordinator; snapshot decoding has no browser dependency.
import { evaluateHoverTrigger } from "@/lib/hover-trigger-policy";
import { OVERLAY_HOST_SELECTOR } from "../../lib/overlay-bridge";
import type { CdpRunner } from "../shared";
import type { CapturedNode, CapturedSurfaceProbe } from "./facts";

export type {
  CapturedNode,
  CapturedSurfaceProbe,
} from "./facts";

import { isCaptureAbort as isAbortError, throwCaptureAborted as throwIfAborted } from "./facts";
import { clearHover, ProbeBudget, waitForHover } from "./hover-perception";

interface RuntimeEvaluateReply {
  result?: {
    value?: unknown;
  };
}

interface HoverCandidate {
  backendNodeId: number;
  label?: string;
  x: number;
  y: number;
  score: number;
  reasons: string[];
}

interface CdpDomNode {
  backendNodeId?: number;
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
}

function collectBackendIdsFromDomNode(node: CdpDomNode | undefined, out: Set<number>): void {
  if (!node) return;
  if (typeof node.backendNodeId === "number") {
    out.add(node.backendNodeId);
  }
  for (const child of node.children ?? []) {
    collectBackendIdsFromDomNode(child, out);
  }
  for (const shadow of node.shadowRoots ?? []) {
    collectBackendIdsFromDomNode(shadow, out);
  }
}

/**
 * Ceiling for the whole hover-surface phase.
 *
 * The previous 2000 was only a floor: the loop checked elapsed time at the top,
 * so a candidate could start with 1ms left and still run its two settle
 * windows, pushing real cost to ~2.6s. This is that true ceiling, now actually
 * enforced by an up-front affordability check, so the same number of candidates
 * get probed under a bound that no longer lies.
 */
const MAX_HOVER_PROBE_MS = 2_600;
const MAX_HOVER_TRIGGERS = 6;
const MAX_HOVER_SURFACES = 3;
const HOVER_SETTLE_MS = 300;
const MAX_HOVER_SUB_ITEMS = 12;

function runtimeValue<T>(reply: RuntimeEvaluateReply): T | undefined {
  return reply.result?.value as T | undefined;
}

function hoverCssTriggerScanExpression(): string {
  return `(() => {
    const visibilityProps = ["display", "visibility", "opacity", "maxHeight", "height", "overflow"];
    const centres = [];
    const seenRules = new Set();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (rule.type !== 1 || !rule.selectorText || !rule.style) continue;
        const selectorText = String(rule.selectorText);
        if (!selectorText.includes(":hover")) continue;
        if (!visibilityProps.some((prop) => rule.style[prop])) continue;
        for (const rawPart of selectorText.split(",")) {
          const part = rawPart.trim();
          const hoverIndex = part.indexOf(":hover");
          if (hoverIndex < 0) continue;
          const triggerSel = part.slice(0, hoverIndex).trim();
          if (!triggerSel) continue;
          if (seenRules.has(triggerSel)) continue;
          seenRules.add(triggerSel);
          let elements;
          try { elements = Array.from(document.querySelectorAll(triggerSel)); } catch { continue; }
          for (const el of elements) {
            if (!(el instanceof HTMLElement)) continue;
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none") continue;
            centres.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            if (centres.length >= 24) return centres;
          }
        }
      }
    }
    return centres;
  })()`;
}

interface HoverRuntimeItem {
  text: string;
  role: string;
  tag: string;
  x: number;
  y: number;
}

function hoverStateExpression(): string {
  return `(() => {
    const items = [];
    const seen = new Set();
    const selectors = [
      "a",
      "button",
      "[role='menuitem']",
      "[role='menuitemcheckbox']",
      "[role='menuitemradio']",
      "[role='option']",
      "[role='tab']",
      "[role='link']",
      "[role='button']"
    ].join(",");
    const push = (el) => {
      if (!(el instanceof HTMLElement)) return;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return;
      const text = String(
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.textContent ||
        ""
      ).replace(/\\s+/g, " ").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      items.push({
        text,
        role: (el.getAttribute("role") || "").toLowerCase(),
        tag: el.tagName.toLowerCase(),
        x: rect.left,
        y: rect.top,
      });
    };
    for (const el of Array.from(document.querySelectorAll(selectors))) push(el);
    return items.slice(0, 400);
  })()`;
}

function capturedText(node: CapturedNode): string | undefined {
  const value =
    node.attrs["aria-label"] ?? node.attrs.title ?? node.attrs.alt ?? node.textContent ?? "";
  const clean = value.replace(/\s+/g, " ").trim();
  return clean || undefined;
}

function hasGraphicDescendant(
  node: CapturedNode,
  childrenByParentId: Map<number, CapturedNode[]>,
  depth = 0,
): boolean {
  if (depth > 3) return false;
  for (const child of childrenByParentId.get(node.backendNodeId) ?? []) {
    const tag = child.tag.toLowerCase();
    if (["img", "svg", "use", "path", "i"].includes(tag)) return true;
    if (hasGraphicDescendant(child, childrenByParentId, depth + 1)) return true;
  }
  return false;
}

function roleOf(node: CapturedNode): string {
  return (node.attrs.role ?? "").toLowerCase();
}

function scoreHoverCandidate(
  node: CapturedNode,
  childrenByParentId: Map<number, CapturedNode[]>,
  cssHoverPoints: Array<{ x: number; y: number }>,
): HoverCandidate | null {
  const rect = node.rect;
  if (!rect) return null;
  const label = capturedText(node);
  const cssHoverMatch = cssHoverPoints.some(
    (point) =>
      point.x >= rect.x &&
      point.x <= rect.x + rect.w &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.h,
  );
  const decision = evaluateHoverTrigger({
    tag: node.tag,
    role: roleOf(node),
    label,
    attrs: node.attrs,
    rect,
    cursor: node.cursor,
    pointerEvents: node.pointerEvents,
    hasGraphicDescendant: hasGraphicDescendant(node, childrenByParentId),
    cssHoverMatch,
  });

  if (!decision.eligible) return null;
  return {
    backendNodeId: node.backendNodeId,
    label,
    x: rect.x + rect.w / 2,
    y: rect.y + rect.h / 2,
    score: decision.score,
    reasons: decision.reasons,
  };
}

function buildHoverCandidates(
  nodes: CapturedNode[],
  cssHoverPoints: Array<{ x: number; y: number }>,
): HoverCandidate[] {
  const childrenByParentId = new Map<number, CapturedNode[]>();
  const parentByBackendId = new Map<number, number | null>();
  for (const node of nodes) {
    parentByBackendId.set(node.backendNodeId, node.parentBackendNodeId);
    if (node.parentBackendNodeId === null) continue;
    const children = childrenByParentId.get(node.parentBackendNodeId) ?? [];
    children.push(node);
    childrenByParentId.set(node.parentBackendNodeId, children);
  }

  const candidates = nodes
    .map((node) => scoreHoverCandidate(node, childrenByParentId, cssHoverPoints))
    .filter((candidate): candidate is HoverCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score);

  const deduped: HoverCandidate[] = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (seen.has(candidate.backendNodeId)) continue;
    if (deduped.some((existing) => sameHoverCluster(existing, candidate, parentByBackendId))) {
      continue;
    }
    seen.add(candidate.backendNodeId);
    deduped.push(candidate);
    if (deduped.length >= MAX_HOVER_TRIGGERS) break;
  }
  return deduped;
}

function sameHoverCluster(
  a: HoverCandidate,
  b: HoverCandidate,
  parentByBackendId: Map<number, number | null>,
): boolean {
  if (Math.hypot(a.x - b.x, a.y - b.y) <= 8) return true;
  return (
    isBackendAncestor(a.backendNodeId, b.backendNodeId, parentByBackendId) ||
    isBackendAncestor(b.backendNodeId, a.backendNodeId, parentByBackendId)
  );
}

function isBackendAncestor(
  ancestorId: number,
  nodeId: number,
  parentByBackendId: Map<number, number | null>,
): boolean {
  let parentId = parentByBackendId.get(nodeId);
  let guard = 0;
  while (parentId !== null && parentId !== undefined && guard < parentByBackendId.size) {
    if (parentId === ancestorId) return true;
    parentId = parentByBackendId.get(parentId);
    guard += 1;
  }
  return false;
}

function diffHoverItems(before: HoverRuntimeItem[], after: HoverRuntimeItem[]): string[] {
  const beforeKeys = new Set(before.map((item) => item.text.toLowerCase()));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of after) {
    const text = item.text.replace(/\s+/g, " ").trim();
    const key = text.toLowerCase();
    if (!text || beforeKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_HOVER_SUB_ITEMS) break;
  }
  return out;
}

function confidenceForHover(
  candidate: HoverCandidate,
  subItems: string[],
): "high" | "medium" | "low" {
  if (subItems.length >= 2 && candidate.score >= 80) return "high";
  if (subItems.length >= 2 || candidate.score >= 80) return "medium";
  return "low";
}

/**
 * One candidate costs two settle windows (baseline + post-hover) plus a few
 * CDP round trips. Used to decide whether the next candidate still fits the
 * budget before paying for it.
 */
const HOVER_CANDIDATE_COST_MS = HOVER_SETTLE_MS * 2;

export interface HoverSurfaceProbeOptions {
  signal?: AbortSignal;
}

/**
 * Hovers a bounded set of likely menu triggers and reports the sub-items each
 * one reveals.
 *
 * Runs after DOM *and* accessibility capture. Hovering can open menus and
 * change layout, so probing between the two captures would leave the DOM half
 * of an observation describing the page before the change and the AX half
 * describing it after.
 *
 * The caller owns the overlay bypass span (see `withOverlayBypass`).
 */
export async function probeHoverSurfaces(
  cdp: CdpRunner,
  tabId: number,
  nodes: CapturedNode[],
  options: HoverSurfaceProbeOptions = {},
): Promise<CapturedSurfaceProbe[]> {
  const budget = new ProbeBudget(MAX_HOVER_PROBE_MS);
  try {
    throwIfAborted(options.signal);
    const cssScan = await cdp.send<RuntimeEvaluateReply>(tabId, "Runtime.evaluate", {
      expression: hoverCssTriggerScanExpression(),
      returnByValue: true,
    });
    throwIfAborted(options.signal);
    const cssHoverPoints = runtimeValue<Array<{ x: number; y: number }>>(cssScan) ?? [];
    const candidates = buildHoverCandidates(nodes, cssHoverPoints);
    if (candidates.length === 0) return [];

    const results: CapturedSurfaceProbe[] = [];
    const seen = new Set<number>();
    throwIfAborted(options.signal);
    for (const candidate of candidates.slice(0, MAX_HOVER_TRIGGERS)) {
      throwIfAborted(options.signal);
      if (!budget.canAfford(HOVER_CANDIDATE_COST_MS)) break;
      if (results.length >= MAX_HOVER_SURFACES) break;
      if (seen.has(candidate.backendNodeId)) continue;
      try {
        await clearHover(cdp, tabId);
        throwIfAborted(options.signal);
        await waitForHover(HOVER_SETTLE_MS, options.signal);
        const baselineReply = await cdp.send<RuntimeEvaluateReply>(tabId, "Runtime.evaluate", {
          expression: hoverStateExpression(),
          returnByValue: true,
        });
        throwIfAborted(options.signal);
        const baselineItems = runtimeValue<HoverRuntimeItem[]>(baselineReply) ?? [];

        throwIfAborted(options.signal);
        await cdp.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: candidate.x,
          y: candidate.y,
        });
        throwIfAborted(options.signal);
        await waitForHover(HOVER_SETTLE_MS, options.signal);
        const collected = await cdp.send<RuntimeEvaluateReply>(tabId, "Runtime.evaluate", {
          expression: hoverStateExpression(),
          returnByValue: true,
        });
        throwIfAborted(options.signal);
        const subItems = diffHoverItems(
          baselineItems,
          runtimeValue<HoverRuntimeItem[]>(collected) ?? [],
        );
        if (subItems.length === 0) continue;
        seen.add(candidate.backendNodeId);
        results.push({
          triggerBackendNodeId: candidate.backendNodeId,
          triggerPoint: { x: candidate.x, y: candidate.y },
          triggerAction: "hover",
          subItems,
          confidence: confidenceForHover(candidate, subItems),
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        continue;
      } finally {
        await clearHover(cdp, tabId);
      }
    }
    return results;
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.debug("[bsk capture] hover surface probe failed", err);
    return [];
  }
}

/**
 * When DOMSnapshot is unavailable, locate the marked overlay host via CDP and
 * collect every backendNodeId in its pierced subtree (open shadow included).
 */
export async function collectOverlayExcludedBackendIds(
  cdp: CdpRunner,
  tabId: number,
  signal?: AbortSignal,
): Promise<Set<number>> {
  const excluded = new Set<number>();
  try {
    throwIfAborted(signal);
    const doc = await cdp.send<{ root?: { nodeId?: number } }>(tabId, "DOM.getDocument", {
      depth: 0,
      pierce: true,
    });
    throwIfAborted(signal);
    const rootNodeId = doc.root?.nodeId;
    if (typeof rootNodeId !== "number") return excluded;

    const found = await cdp.send<{ nodeId?: number }>(tabId, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector: OVERLAY_HOST_SELECTOR,
    });
    throwIfAborted(signal);
    if (typeof found.nodeId !== "number" || found.nodeId === 0) return excluded;

    const described = await cdp.send<{ node?: CdpDomNode }>(tabId, "DOM.describeNode", {
      nodeId: found.nodeId,
      depth: -1,
      pierce: true,
    });
    throwIfAborted(signal);
    collectBackendIdsFromDomNode(described.node, excluded);
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.debug("[bsk capture] overlay exclusion fallback failed", err);
  }
  return excluded;
}
