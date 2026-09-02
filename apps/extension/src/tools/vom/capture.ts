// CDP capture adapter: DOMSnapshot.captureSnapshot + Page.getLayoutMetrics
// → CapturedNode[] + Viewport. This is the ONLY VOM module that touches
// raw CDP. The captureSnapshot reply is columnar (parallel arrays + a
// shared string table); requested computed styles are decoded through
// STYLE_COL so capture and visibility policy share one explicit contract.

import type { Rect, Viewport } from "@browser-skill/vom";
import { evaluateHoverTrigger } from "@/lib/hover-trigger-policy";
import { isOverlayHostNode, OVERLAY_HOST_SELECTOR } from "../../lib/overlay-bridge";
import { childFrameProjection, type GeometryProjection, projectRectToViewport } from "../geometry";
import type { CdpRunner } from "../shared";
import { clearHover, ProbeBudget, waitForHover } from "./hover-perception";

const REQUESTED_STYLES = ["position", "pointer-events", "cursor", "visibility", "opacity"] as const;
const STYLE_COL = Object.fromEntries(
  REQUESTED_STYLES.map((name, index) => [name, index]),
) as Record<(typeof REQUESTED_STYLES)[number], number>;

export interface CapturedNode {
  backendNodeId: number;
  parentBackendNodeId: number | null;
  frameId?: string;
  /** Owning iframe backend node id; `null` for the top-level document. */
  ownerFrameBackendNodeId?: number | null;
  tag: string;
  attrs: Record<string, string>;
  /** Top-level viewport-relative CSS px, clipped to the owning frame viewport. */
  rect: Rect | null;
  /** Frame-local viewport-relative CSS px before top-level projection. */
  localRect?: Rect | null;
  paintOrder: number;
  position: string;
  pointerEvents: string;
  /**
   * computed `cursor`. `cursor: pointer` is the strongest CDP-free signal
   * that a non-semantic element (a `<div>`/`<span>` with a click handler)
   * is actually an interactive control — used by the adapter to surface
   * custom buttons/checkboxes the AX tree drops as `generic`. Optional like
   * `textContent`: the live parser always sets it, hand-built fixtures may not.
   */
  cursor?: string;
  /**
   * Whether the live DOM snapshot provides a painted, non-hidden box for this
   * node. Semantic resolution uses this only for DOM fallback nodes; AX-backed
   * nodes remain authoritative even when they are outside the viewport.
   */
  rendered?: boolean;
  textContent?: string;
  formState?: "empty" | "filled" | "default";
  formValue?: string;
  formDefaultValue?: string;
  formPlaceholder?: string;
}

export type CapturedIframeNodes = Map<number, CapturedNode[]>;

export interface CapturedSurfaceProbe {
  triggerBackendNodeId: number;
  triggerPoint?: { x: number; y: number };
  triggerAction: "hover" | "focus" | string;
  subItems: string[];
  confidence?: "high" | "medium" | "low";
}

export interface CapturedViewModel {
  nodes: CapturedNode[];
  viewport: Viewport;
  iframeNodes: CapturedIframeNodes;
  frameNodes?: Map<string, CapturedNode[]>;
  frameOwnerBackendNodeIds?: Map<string, number>;
  /** Explicit DOMSnapshot frame ancestry; never inferred from backend node ids. */
  frameParentIds?: Map<string, string>;
  rootFrameId?: string;
  /** Backend node ids belonging to the agent overlay host + its shadow subtree. */
  excludedBackendNodeIds: Set<number>;
}

export interface CaptureViewModelOptions {
  signal?: AbortSignal;
}

function captureAbortError(): Error {
  const error = new Error("observation aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "AbortError"
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw captureAbortError();
}

/** Sparse array format Chrome uses for infrequently-set per-node fields. */
interface SparseArray {
  index: number[];
  value: number[];
}

interface RareBooleanData {
  index: number[];
}

interface SnapshotDocument {
  frameId?: string | number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  nodes?: {
    parentIndex?: number[];
    nodeName?: number[];
    backendNodeId?: number[];
    attributes?: number[][];
    /**
     * Per-node text value (index into strings), set for `#text` / CDATA nodes.
     * Element nodes carry -1. Same length as `backendNodeId`.
     */
    nodeValue?: number[];
    /** Maps node array index → index into `documents[]` for frame content. */
    contentDocumentIndex?: SparseArray;
    inputValue?: SparseArray;
    textValue?: SparseArray;
    inputChecked?: RareBooleanData;
    optionSelected?: RareBooleanData;
  };
  layout?: {
    nodeIndex?: number[];
    styles?: number[][];
    bounds?: number[][];
    paintOrders?: number[];
  };
}

function snapshotFrameId(document: SnapshotDocument, strings: string[]): string | undefined {
  if (typeof document.frameId === "string") return document.frameId || undefined;
  if (typeof document.frameId === "number") return str(strings, document.frameId) || undefined;
  return undefined;
}

interface SnapshotReply {
  strings?: string[];
  documents?: SnapshotDocument[];
}

interface LayoutMetricsReply {
  cssLayoutViewport?: {
    clientWidth?: number;
    clientHeight?: number;
    pageX?: number;
    pageY?: number;
  };
  layoutViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number };
}

function isFormControlTag(tag: string): boolean {
  return tag === "input" || tag === "textarea" || tag === "select";
}

function isSensitiveFormControl(node: Pick<CapturedNode, "tag" | "attrs">): boolean {
  return node.tag === "input" && (node.attrs.type ?? "").toLowerCase() === "password";
}

function snapshotFormState(
  value: string | undefined,
  defaultValue: string,
  hasDefaultValue: boolean,
  sensitive: boolean,
): CapturedNode["formState"] {
  if (sensitive) {
    if (value === undefined && !hasDefaultValue) return undefined;
    return (value ?? defaultValue) === "" ? "empty" : "filled";
  }
  if (value === undefined) return undefined;
  if (value === "") return "empty";
  return value === defaultValue ? "default" : "filled";
}

const MAX_FORM_ENRICH_CONTROLS = 250;

interface CapturedFormState {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  state?: "empty" | "filled" | "default";
  sensitive?: boolean;
}

interface CapturedFrameFormState {
  controls: CapturedFormState[];
  childFrames: CapturedFrameFormState[];
}

function formStateBatchExpression(maxControls: number): string {
  return `(() => {
    const maxControls = ${JSON.stringify(maxControls)};
    let remaining = maxControls;
    const controlSelector = "input,textarea,select";
    const controlState = (el) => {
      const tag = el.tagName.toLowerCase();
      const type = tag === "input" ? String(el.type || "text").toLowerCase() : tag;
      const sensitive = type === "password" || type === "credit-card";
      const rawValue = typeof el.value === "string" ? el.value : "";
      const defaultValue = typeof el.defaultValue === "string" ? el.defaultValue : "";
      const placeholder = typeof el.placeholder === "string" ? el.placeholder : "";
      const state = rawValue === "" ? "empty" : rawValue === defaultValue ? "default" : "filled";
      return {
        state,
        sensitive,
        placeholder,
        ...(sensitive ? {} : { value: rawValue, defaultValue }),
      };
    };
    const collect = (doc) => {
      const controls = [];
      for (const el of Array.from(doc.querySelectorAll(controlSelector))) {
        if (remaining <= 0) break;
        controls.push(controlState(el));
        remaining -= 1;
      }
      const childFrames = [];
      for (const frame of Array.from(doc.querySelectorAll("iframe"))) {
        let childDoc = null;
        try { childDoc = frame.contentDocument; } catch { childDoc = null; }
        childFrames.push(childDoc && remaining > 0 ? collect(childDoc) : { controls: [], childFrames: [] });
      }
      return { controls, childFrames };
    };
    return collect(document);
  })()`;
}

function flattenFrameFormStates(
  frame: CapturedFrameFormState | undefined,
  out: CapturedFormState[][] = [],
): CapturedFormState[][] {
  if (!frame) return out;
  out.push(Array.isArray(frame.controls) ? frame.controls : []);
  for (const child of Array.isArray(frame.childFrames) ? frame.childFrames : []) {
    flattenFrameFormStates(child, out);
  }
  return out;
}

function applyFormStates(nodes: CapturedNode[], states: CapturedFormState[]): void {
  let index = 0;
  for (const node of nodes) {
    if (!isFormControlTag(node.tag)) continue;
    const state = states[index];
    index += 1;
    if (!state) continue;
    node.formState = state.state;
    node.formPlaceholder = state.placeholder ?? "";
    if (state.sensitive || isSensitiveFormControl(node)) {
      delete node.formValue;
      delete node.formDefaultValue;
      delete node.attrs.value;
    } else {
      node.formDefaultValue = state.defaultValue ?? "";
      if (state.value !== undefined) node.formValue = state.value;
    }
  }
}

async function enrichFormControlStates(
  cdp: CdpRunner,
  tabId: number,
  frameNodeGroups: CapturedNode[][],
  signal?: AbortSignal,
): Promise<void> {
  const hasControls = frameNodeGroups.some((nodes) =>
    nodes.some((node) => isFormControlTag(node.tag)),
  );
  if (!hasControls) return;
  try {
    throwIfAborted(signal);
    const result = await cdp.send<RuntimeEvaluateReply>(tabId, "Runtime.evaluate", {
      expression: formStateBatchExpression(MAX_FORM_ENRICH_CONTROLS),
      returnByValue: true,
    });
    throwIfAborted(signal);
    const frameStates = flattenFrameFormStates(runtimeValue<CapturedFrameFormState>(result));
    for (let i = 0; i < frameNodeGroups.length; i += 1) {
      applyFormStates(frameNodeGroups[i], frameStates[i] ?? []);
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    // Best-effort enrichment. DOMSnapshot/AX data still carries the nodes.
  }
}

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

interface ParseDocumentResult {
  nodes: CapturedNode[];
  excludedBackendNodeIds: Set<number>;
}

interface FrameContext {
  frameId?: string;
  ownerFrameBackendNodeId: number | null;
  projection: GeometryProjection | null;
  scrollX: number;
  scrollY: number;
}

function str(strings: string[], idx: number | undefined): string {
  if (idx === undefined || idx < 0) return "";
  return strings[idx] ?? "";
}

function devicePixelRatio(metrics: LayoutMetricsReply): number {
  const layoutW = metrics.layoutViewport?.clientWidth ?? 0;
  const cssW = metrics.cssLayoutViewport?.clientWidth ?? 0;
  if (!layoutW || !cssW) return 1;
  const dpr = layoutW / cssW;
  if (!Number.isFinite(dpr) || dpr <= 0) return 1;
  return dpr >= 1 ? dpr : 1;
}

function sparseIndexMap(sparse: SparseArray | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!sparse?.index || !sparse.value) return out;
  for (let i = 0; i < sparse.index.length; i++) {
    const nodeIndex = sparse.index[i];
    const docIndex = sparse.value[i];
    if (nodeIndex !== undefined && docIndex !== undefined) out.set(nodeIndex, docIndex);
  }
  return out;
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

/**
 * Parse one DOMSnapshot document into CapturedNode[].
 *
 * @param doc   - the raw DOMSnapshot document object
 * @param strings - the shared string table for the whole snapshot
 * @param dpr   - device-pixel-ratio from Page.getLayoutMetrics
 * @param context - frame coordinate context; output rects are top viewport-relative
 */
function parseDocumentNodes(
  doc: SnapshotDocument,
  strings: string[],
  dpr: number,
  context: FrameContext,
): ParseDocumentResult {
  const dn = doc.nodes;
  const dl = doc.layout;
  if (!dn?.backendNodeId) {
    return { nodes: [], excludedBackendNodeIds: new Set() };
  }

  const count = dn.backendNodeId.length;
  const layoutByNode = new Map<number, number>();
  (dl?.nodeIndex ?? []).forEach((nodeIdx, layoutIdx) => layoutByNode.set(nodeIdx, layoutIdx));

  // The agent's own overlay (WXT shadow host, marked with OVERLAY_HOST_MARKER_ATTR)
  // is injected into the page and its open shadow root
  // is inlined by DOMSnapshot as descendants of the host. Its fixed
  // full-viewport click-blocker would otherwise dominate occlusion detection
  // and hide the real page, so mark the host + its whole subtree excluded.
  // parentIndex always references an earlier node, so one forward pass suffices.
  const excluded = new Array<boolean>(count).fill(false);
  const excludedBackendNodeIds = new Set<number>();
  for (let n = 0; n < count; n++) {
    const parentIdx = dn.parentIndex?.[n] ?? -1;
    const inherited = parentIdx >= 0 && excluded[parentIdx];
    let isOverlayHost = inherited;
    if (!isOverlayHost) {
      const pairs = dn.attributes?.[n] ?? [];
      const attrNames: string[] = [];
      for (let a = 0; a + 1 < pairs.length; a += 2) {
        attrNames.push(str(strings, pairs[a]));
      }
      isOverlayHost = isOverlayHostNode(str(strings, dn.nodeName?.[n]), attrNames);
    }
    if (!isOverlayHost) continue;
    excluded[n] = true;
    const backendNodeId = dn.backendNodeId[n];
    if (backendNodeId !== undefined) {
      excludedBackendNodeIds.add(backendNodeId);
    }
  }

  const posCol = STYLE_COL.position;
  const peCol = STYLE_COL["pointer-events"];
  const cursorCol = STYLE_COL.cursor;
  const visibilityCol = STYLE_COL.visibility;
  const opacityCol = STYLE_COL.opacity;
  const inputValues = sparseIndexMap(dn.inputValue);
  const textValues = sparseIndexMap(dn.textValue);
  const checkedInputs = new Set(dn.inputChecked?.index ?? []);
  const selectedOptions = new Set(dn.optionSelected?.index ?? []);

  // Collect visible text from #text child nodes so element CapturedNodes
  // carry a textContent value usable as a button/link label fallback.
  // nodeValue is a parallel array: string index for text nodes, -1 otherwise.
  const nodeTextContent = new Map<number, string>();
  if (dn.nodeValue) {
    for (let n = 0; n < count; n++) {
      const nvIdx = dn.nodeValue[n] ?? -1;
      if (nvIdx < 0) continue;
      const text = str(strings, nvIdx).trim();
      if (!text) continue;
      const parentIdx = dn.parentIndex?.[n] ?? -1;
      if (parentIdx >= 0) {
        const existing = nodeTextContent.get(parentIdx);
        nodeTextContent.set(parentIdx, existing ? `${existing} ${text}` : text);
      }
    }
  }

  // Build CapturedNodes.
  const nodes: CapturedNode[] = [];
  for (let n = 0; n < count; n++) {
    if (excluded[n]) continue;
    const backendNodeId = dn.backendNodeId[n];
    const parentIdx = dn.parentIndex?.[n] ?? -1;
    const parentBackendNodeId = parentIdx >= 0 ? (dn.backendNodeId[parentIdx] ?? null) : null;
    const tag = str(strings, dn.nodeName?.[n]).toLowerCase();

    const attrs: Record<string, string> = {};
    const pairs = dn.attributes?.[n] ?? [];
    for (let a = 0; a + 1 < pairs.length; a += 2) {
      attrs[str(strings, pairs[a]).toLowerCase()] = str(strings, pairs[a + 1]);
    }

    let rect: Rect | null = null;
    let localRect: Rect | null = null;
    let paintOrder = 0;
    let position = "static";
    let pointerEvents = "auto";
    let cursor = "auto";
    let rendered = false;
    const li = layoutByNode.get(n);
    if (li !== undefined) {
      const b = dl?.bounds?.[li];
      if (b && b.length >= 4 && b[2] > 0 && b[3] > 0) {
        localRect = {
          x: b[0] / dpr - context.scrollX,
          y: b[1] / dpr - context.scrollY,
          w: b[2] / dpr,
          h: b[3] / dpr,
        };
        const bounds = context.projection
          ? projectRectToViewport(localRect, context.projection)
          : null;
        rect = bounds ? { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height } : null;
      }
      paintOrder = dl?.paintOrders?.[li] ?? 0;
      const styleRow = dl?.styles?.[li] ?? [];
      position = str(strings, styleRow[posCol]) || "static";
      pointerEvents = str(strings, styleRow[peCol]) || "auto";
      cursor = str(strings, styleRow[cursorCol]) || "auto";
      const visibility = str(strings, styleRow[visibilityCol]) || "visible";
      const opacity = str(strings, styleRow[opacityCol]) || "1";
      rendered =
        localRect !== null &&
        visibility !== "hidden" &&
        visibility !== "collapse" &&
        (Number.parseFloat(opacity) || 0) > 0;
    }

    // Skip non-element nodes (#text, #cdata-section, etc.) — they carry no
    // geometry and are never queried by callers.
    if (tag.startsWith("#")) continue;

    const textContent = nodeTextContent.get(n);

    const rawFormValueIndex = tag === "textarea" ? textValues.get(n) : inputValues.get(n);
    const rawFormValue =
      rawFormValueIndex !== undefined ? str(strings, rawFormValueIndex) : undefined;
    const sensitive = isSensitiveFormControl({ tag, attrs });
    const formDefaultValue = attrs.value ?? "";
    const formValue = sensitive ? undefined : rawFormValue;
    const formState = snapshotFormState(
      rawFormValue,
      formDefaultValue,
      Object.prototype.hasOwnProperty.call(attrs, "value"),
      sensitive,
    );
    if (sensitive) delete attrs.value;

    nodes.push({
      backendNodeId,
      parentBackendNodeId,
      ...(context.frameId ? { frameId: context.frameId } : {}),
      ownerFrameBackendNodeId: context.ownerFrameBackendNodeId,
      tag,
      attrs,
      rect,
      localRect,
      paintOrder,
      position,
      pointerEvents,
      cursor,
      rendered,
      textContent,
      ...(formValue !== undefined ? { formValue } : {}),
      ...(tag === "input" || tag === "textarea"
        ? {
            formPlaceholder: attrs.placeholder ?? "",
            ...(!sensitive ? { formDefaultValue } : {}),
            ...(formState ? { formState } : {}),
          }
        : {}),
      ...(checkedInputs.has(n) ? { formValue: "true", formState: "filled" } : {}),
      ...(selectedOptions.has(n) ? { formValue: attrs.value ?? textContent ?? "" } : {}),
    });
  }
  return { nodes, excludedBackendNodeIds };
}

interface ParseFrameDocumentsResult {
  iframeNodes: CapturedIframeNodes;
  frameOwnerBackendNodeIds: Map<string, number>;
  frameParentIds: Map<string, string>;
  excludedBackendNodeIds: Set<number>;
}

function parseChildFrameDocuments(
  documents: SnapshotDocument[],
  strings: string[],
  dpr: number,
  parentDocIndex: number,
  parentNodes: CapturedNode[],
  parentContext: FrameContext,
  visited = new Set<number>(),
): ParseFrameDocumentsResult {
  const iframeNodes: CapturedIframeNodes = new Map();
  const frameOwnerBackendNodeIds = new Map<string, number>();
  const frameParentIds = new Map<string, string>();
  const excludedBackendNodeIds = new Set<number>();
  const parentDoc = documents[parentDocIndex];
  const cdi = sparseIndexMap(parentDoc?.nodes?.contentDocumentIndex);
  if (cdi.size === 0) {
    return { iframeNodes, frameOwnerBackendNodeIds, frameParentIds, excludedBackendNodeIds };
  }

  const parentBackendIds = parentDoc?.nodes?.backendNodeId ?? [];
  const parentNodeByBackendId = new Map(parentNodes.map((node) => [node.backendNodeId, node]));

  for (const [nodeArrayIdx, childDocIndex] of cdi) {
    if (visited.has(childDocIndex)) continue;
    const childDoc = documents[childDocIndex];
    if (!childDoc) continue;
    const iframeBackendId = parentBackendIds[nodeArrayIdx];
    if (iframeBackendId === undefined) continue;
    const iframeNode = parentNodeByBackendId.get(iframeBackendId);
    const projection =
      parentContext.projection && iframeNode?.localRect
        ? childFrameProjection(parentContext.projection, iframeNode.localRect)
        : null;

    const childContext: FrameContext = {
      frameId: snapshotFrameId(childDoc, strings),
      ownerFrameBackendNodeId: iframeBackendId,
      projection,
      scrollX: childDoc.scrollOffsetX ?? 0,
      scrollY: childDoc.scrollOffsetY ?? 0,
    };
    const nextVisited = new Set(visited);
    nextVisited.add(childDocIndex);
    const parsed = parseDocumentNodes(childDoc, strings, dpr, childContext);
    iframeNodes.set(iframeBackendId, parsed.nodes);
    if (childContext.frameId) {
      frameOwnerBackendNodeIds.set(childContext.frameId, iframeBackendId);
      if (parentContext.frameId) frameParentIds.set(childContext.frameId, parentContext.frameId);
    }
    for (const id of parsed.excludedBackendNodeIds) excludedBackendNodeIds.add(id);

    const nested = parseChildFrameDocuments(
      documents,
      strings,
      dpr,
      childDocIndex,
      parsed.nodes,
      childContext,
      nextVisited,
    );
    for (const [nestedFrameId, nestedNodes] of nested.iframeNodes) {
      iframeNodes.set(nestedFrameId, nestedNodes);
    }
    for (const [frameId, ownerBackendNodeId] of nested.frameOwnerBackendNodeIds) {
      frameOwnerBackendNodeIds.set(frameId, ownerBackendNodeId);
    }
    for (const [frameId, parentFrameId] of nested.frameParentIds) {
      frameParentIds.set(frameId, parentFrameId);
    }
    for (const id of nested.excludedBackendNodeIds) excludedBackendNodeIds.add(id);
  }

  return { iframeNodes, frameOwnerBackendNodeIds, frameParentIds, excludedBackendNodeIds };
}

export async function captureViewModel(
  cdp: CdpRunner,
  tabId: number,
  options: CaptureViewModelOptions = {},
): Promise<CapturedViewModel> {
  throwIfAborted(options.signal);
  let metrics: LayoutMetricsReply = {};
  try {
    metrics = await cdp.send<LayoutMetricsReply>(tabId, "Page.getLayoutMetrics", {});
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.debug("[bsk capture] layout metrics unavailable", error);
  }
  throwIfAborted(options.signal);
  const dpr = devicePixelRatio(metrics);
  const vpSrc = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
  const viewport: Viewport = {
    width: vpSrc.clientWidth ?? 0,
    height: vpSrc.clientHeight ?? 0,
  };
  const scrollX = vpSrc.pageX ?? 0;
  const scrollY = vpSrc.pageY ?? 0;

  await cdp.send(tabId, "DOMSnapshot.enable", {});
  throwIfAborted(options.signal);
  const snap = await cdp.send<SnapshotReply>(tabId, "DOMSnapshot.captureSnapshot", {
    computedStyles: REQUESTED_STYLES,
    includePaintOrder: true,
    includeDOMRects: true,
  });
  throwIfAborted(options.signal);

  const strings = snap.strings ?? [];
  const documents = snap.documents ?? [];
  const doc0 = documents[0];
  if (!doc0?.nodes?.backendNodeId) {
    return {
      nodes: [],
      viewport,
      iframeNodes: new Map(),
      excludedBackendNodeIds: new Set(),
    };
  }

  const topContext: FrameContext = {
    frameId: snapshotFrameId(doc0, strings),
    ownerFrameBackendNodeId: null,
    projection: {
      sourceClips: [],
      edges: [],
      topViewport: viewport,
    },
    scrollX,
    scrollY,
  };
  const mainParsed = parseDocumentNodes(doc0, strings, dpr, topContext);
  const nodes = mainParsed.nodes;
  const excludedBackendNodeIds = new Set(mainParsed.excludedBackendNodeIds);

  const frameParsed = parseChildFrameDocuments(documents, strings, dpr, 0, nodes, topContext);
  const iframeNodes = frameParsed.iframeNodes;
  for (const id of frameParsed.excludedBackendNodeIds) {
    excludedBackendNodeIds.add(id);
  }

  await enrichFormControlStates(cdp, tabId, [nodes, ...iframeNodes.values()], options.signal);
  throwIfAborted(options.signal);

  const frameNodes = new Map<string, CapturedNode[]>();
  if (topContext.frameId) frameNodes.set(topContext.frameId, nodes);
  for (const iframeFrameNodes of iframeNodes.values()) {
    const frameId = iframeFrameNodes.find((node) => node.frameId)?.frameId;
    if (frameId) frameNodes.set(frameId, iframeFrameNodes);
  }
  for (const [frameId, ownerBackendNodeId] of frameParsed.frameOwnerBackendNodeIds) {
    if (!frameNodes.has(frameId)) {
      frameNodes.set(frameId, iframeNodes.get(ownerBackendNodeId) ?? []);
    }
  }

  return {
    nodes,
    viewport,
    iframeNodes,
    frameNodes,
    frameOwnerBackendNodeIds: frameParsed.frameOwnerBackendNodeIds,
    frameParentIds: frameParsed.frameParentIds,
    ...(topContext.frameId ? { rootFrameId: topContext.frameId } : {}),
    excludedBackendNodeIds,
  };
}
