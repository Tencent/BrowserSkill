// CDP capture adapter: DOMSnapshot.captureSnapshot + Page.getLayoutMetrics
// → CapturedNode[] + Viewport. This is the ONLY VOM module that touches
// raw CDP. The captureSnapshot reply is columnar (parallel arrays + a
// shared string table); we request exactly three computed styles so the
// `styles` columns are [position, pointer-events, cursor] in that order.

import type { Rect, Viewport } from "@browser-skill/vom";
import { isOverlayHostNode, OVERLAY_HOST_SELECTOR } from "../../lib/overlay-bridge";
import type { CdpRunner } from "../shared";

const REQUESTED_STYLES = ["position", "pointer-events", "cursor"] as const;
const STYLE_COL = Object.fromEntries(
  REQUESTED_STYLES.map((name, index) => [name, index]),
) as Record<(typeof REQUESTED_STYLES)[number], number>;

export interface CapturedNode {
  backendNodeId: number;
  parentBackendNodeId: number | null;
  tag: string;
  attrs: Record<string, string>;
  rect: Rect | null;
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
  textContent?: string;
  formValue?: string;
  formDefaultValue?: string;
  formPlaceholder?: string;
}

export type CapturedIframeNodes = Map<number, CapturedNode[]>;

export interface CapturedSurfaceProbe {
  triggerLabel: string;
  triggerAction: "hover" | "focus" | string;
  subItems: string[];
}

export interface CapturedViewModel {
  nodes: CapturedNode[];
  viewport: Viewport;
  iframeNodes: CapturedIframeNodes;
  surfaceProbes?: CapturedSurfaceProbe[];
  /** Backend node ids belonging to the agent overlay host + its shadow subtree. */
  excludedBackendNodeIds: Set<number>;
}

/** Sparse array format Chrome uses for infrequently-set per-node fields. */
interface SparseArray {
  index: number[];
  value: number[];
}

interface SnapshotDocument {
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
  };
  layout?: {
    nodeIndex?: number[];
    styles?: number[][];
    bounds?: number[][];
    paintOrders?: number[];
  };
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

async function enrichFormControlState(cdp: CdpRunner, tabId: number, nodes: CapturedNode[]) {
  for (const node of nodes) {
    if (!isFormControlTag(node.tag)) continue;
    let objectId: string | undefined;
    try {
      const resolved = await cdp.send<{ object?: { objectId?: string } }>(
        tabId,
        "DOM.resolveNode",
        {
          backendNodeId: node.backendNodeId,
        },
      );
      objectId = resolved.object?.objectId;
      if (!objectId) continue;
      const result = await cdp.send<{
        result?: { value?: { value?: string; defaultValue?: string; placeholder?: string } };
      }>(tabId, "Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        functionDeclaration: `function(){
          return {
            value: typeof this.value === "string" ? this.value : "",
            defaultValue: typeof this.defaultValue === "string" ? this.defaultValue : "",
            placeholder: typeof this.placeholder === "string" ? this.placeholder : ""
          };
        }`,
      });
      const value = result.result?.value;
      if (!value) continue;
      node.formValue = value.value ?? "";
      node.formDefaultValue = value.defaultValue ?? "";
      node.formPlaceholder = value.placeholder ?? "";
    } catch {
      // Best-effort enrichment. DOMSnapshot/AX data still carries the node.
    } finally {
      if (objectId) {
        await cdp.send(tabId, "Runtime.releaseObject", { objectId }).catch(() => {});
      }
    }
  }
}

interface RuntimeEvaluateReply {
  result?: {
    value?: unknown;
  };
}

interface HoverCandidate {
  triggerSel: string;
  affectedSub: string;
  label: string;
  x: number;
  y: number;
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

const MAX_HOVER_PROBE_MS = 2_000;
const MAX_HOVER_TRIGGERS = 8;
const HOVER_SETTLE_MS = 200;

function runtimeValue<T>(reply: RuntimeEvaluateReply): T | undefined {
  return reply.result?.value as T | undefined;
}

function hoverCssScanExpression(): string {
  return `(() => {
    const visibilityProps = ["display", "visibility", "opacity", "maxHeight", "height", "overflow"];
    const pairs = [];
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
          const affectedSub = part.slice(hoverIndex + 6).trim();
          if (!triggerSel) continue;
          const key = triggerSel + "||" + affectedSub;
          if (seenRules.has(key)) continue;
          seenRules.add(key);
          pairs.push({ triggerSel, affectedSub });
        }
      }
    }

    const candidates = [];
    const seenLabels = new Set();
    for (const pair of pairs) {
      let elements;
      try { elements = Array.from(document.querySelectorAll(pair.triggerSel)); } catch { continue; }
      for (const el of elements) {
        if (!(el instanceof Element)) continue;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") continue;
        const label = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (!label || seenLabels.has(label)) continue;
        seenLabels.add(label);
        candidates.push({
          triggerSel: pair.triggerSel,
          affectedSub: pair.affectedSub,
          label,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
        if (candidates.length >= ${MAX_HOVER_TRIGGERS}) return candidates;
      }
    }
    return candidates;
  })()`;
}

function hoverCollectExpression(candidate: HoverCandidate): string {
  return `(() => {
    const triggerSel = ${JSON.stringify(candidate.triggerSel)};
    const rawAffectedSub = ${JSON.stringify(candidate.affectedSub)};
    const x = ${JSON.stringify(candidate.x)};
    const y = ${JSON.stringify(candidate.y)};
    const hit = document.elementFromPoint(x, y);
    const trigger = hit instanceof Element ? hit.closest(triggerSel) : null;
    if (!trigger) return [];

    const affectedSub = rawAffectedSub.replace(/^[>+~]\\s*/, "").trim();
    let targets = [];
    if (!affectedSub) {
      targets = [trigger];
    } else {
      try { targets = Array.from(trigger.querySelectorAll(affectedSub)); } catch { targets = []; }
    }
    const items = [];
    const seen = new Set();
    const push = (value) => {
      const text = String(value || "").replace(/\\s+/g, " ").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      items.push(text);
    };
    for (const target of targets) {
      if (!(target instanceof Element)) continue;
      const style = getComputedStyle(target);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const clickable = target.querySelectorAll('a, button, [role="menuitem"], [role="option"]');
      if (clickable.length > 0) {
        for (const child of Array.from(clickable)) push(child.textContent);
      } else {
        push(target.textContent);
      }
    }
    return items.slice(0, 12);
  })()`;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeHoverSurfaces(cdp: CdpRunner, tabId: number): Promise<CapturedSurfaceProbe[]> {
  const started = Date.now();
  try {
    const scan = await cdp.send<RuntimeEvaluateReply>(tabId, "Runtime.evaluate", {
      expression: hoverCssScanExpression(),
      returnByValue: true,
    });
    const candidates = runtimeValue<HoverCandidate[]>(scan) ?? [];
    const results: CapturedSurfaceProbe[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates.slice(0, MAX_HOVER_TRIGGERS)) {
      if (Date.now() - started > MAX_HOVER_PROBE_MS) break;
      if (!candidate.label || seen.has(candidate.label)) continue;
      try {
        await cdp.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: candidate.x,
          y: candidate.y,
        });
        await wait(HOVER_SETTLE_MS);
        const collected = await cdp.send<RuntimeEvaluateReply>(tabId, "Runtime.evaluate", {
          expression: hoverCollectExpression(candidate),
          returnByValue: true,
        });
        await cdp.send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
        const subItems = (runtimeValue<string[]>(collected) ?? [])
          .map((item) => item.replace(/\s+/g, " ").trim())
          .filter(Boolean);
        if (subItems.length === 0) continue;
        seen.add(candidate.label);
        results.push({
          triggerLabel: candidate.label,
          triggerAction: "hover",
          subItems,
        });
      } catch {
        continue;
      }
    }
    return results;
  } catch (err) {
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
): Promise<Set<number>> {
  const excluded = new Set<number>();
  try {
    const doc = await cdp.send<{ root?: { nodeId?: number } }>(tabId, "DOM.getDocument", {
      depth: 0,
      pierce: true,
    });
    const rootNodeId = doc.root?.nodeId;
    if (typeof rootNodeId !== "number") return excluded;

    const found = await cdp.send<{ nodeId?: number }>(tabId, "DOM.querySelector", {
      nodeId: rootNodeId,
      selector: OVERLAY_HOST_SELECTOR,
    });
    if (typeof found.nodeId !== "number" || found.nodeId === 0) return excluded;

    const described = await cdp.send<{ node?: CdpDomNode }>(tabId, "DOM.describeNode", {
      nodeId: found.nodeId,
      depth: -1,
      pierce: true,
    });
    collectBackendIdsFromDomNode(described.node, excluded);
  } catch (err) {
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
 * @param scrollX - horizontal scroll offset to subtract (CSS px)
 * @param scrollY - vertical scroll offset to subtract (CSS px)
 */
function parseDocumentNodes(
  doc: SnapshotDocument,
  strings: string[],
  dpr: number,
  scrollX: number,
  scrollY: number,
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
    let paintOrder = 0;
    let position = "static";
    let pointerEvents = "auto";
    let cursor = "auto";
    const li = layoutByNode.get(n);
    if (li !== undefined) {
      const b = dl?.bounds?.[li];
      if (b && b.length >= 4 && b[2] > 0 && b[3] > 0) {
        rect = {
          x: b[0] / dpr - scrollX,
          y: b[1] / dpr - scrollY,
          w: b[2] / dpr,
          h: b[3] / dpr,
        };
      }
      paintOrder = dl?.paintOrders?.[li] ?? 0;
      const styleRow = dl?.styles?.[li] ?? [];
      position = str(strings, styleRow[posCol]) || "static";
      pointerEvents = str(strings, styleRow[peCol]) || "auto";
      cursor = str(strings, styleRow[cursorCol]) || "auto";
    }

    // Skip non-element nodes (#text, #cdata-section, etc.) — they carry no
    // geometry and are never queried by callers.
    if (tag.startsWith("#")) continue;

    const textContent = nodeTextContent.get(n);

    nodes.push({
      backendNodeId,
      parentBackendNodeId,
      tag,
      attrs,
      rect,
      paintOrder,
      position,
      pointerEvents,
      cursor,
      textContent,
    });
  }
  return { nodes, excludedBackendNodeIds };
}

export async function captureViewModel(cdp: CdpRunner, tabId: number): Promise<CapturedViewModel> {
  const metrics = await cdp.send<LayoutMetricsReply>(tabId, "Page.getLayoutMetrics", {});
  const dpr = devicePixelRatio(metrics);
  const vpSrc = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
  const viewport: Viewport = {
    width: vpSrc.clientWidth ?? 0,
    height: vpSrc.clientHeight ?? 0,
  };
  const scrollX = vpSrc.pageX ?? 0;
  const scrollY = vpSrc.pageY ?? 0;

  await cdp.send(tabId, "DOMSnapshot.enable", {});
  const snap = await cdp.send<SnapshotReply>(tabId, "DOMSnapshot.captureSnapshot", {
    computedStyles: REQUESTED_STYLES,
    includePaintOrder: true,
    includeDOMRects: true,
  });

  const strings = snap.strings ?? [];
  const documents = snap.documents ?? [];
  const doc0 = documents[0];
  if (!doc0?.nodes?.backendNodeId) {
    return {
      nodes: [],
      viewport,
      iframeNodes: new Map(),
      surfaceProbes: [],
      excludedBackendNodeIds: new Set(),
    };
  }

  const mainParsed = parseDocumentNodes(doc0, strings, dpr, scrollX, scrollY);
  const nodes = mainParsed.nodes;
  const excludedBackendNodeIds = new Set(mainParsed.excludedBackendNodeIds);

  // Build a map from node-array-index → sub-document-index using the sparse
  // contentDocumentIndex field. Chrome emits this only for <iframe> nodes.
  const iframeNodes: CapturedIframeNodes = new Map();
  if (documents.length > 1) {
    const cdi = doc0.nodes?.contentDocumentIndex;
    if (cdi?.index && cdi.value) {
      for (let k = 0; k < cdi.index.length; k++) {
        const nodeArrayIdx = cdi.index[k];
        const docIdx = cdi.value[k];
        const subDoc = documents[docIdx];
        if (!subDoc) continue;
        const iframeBid = doc0.nodes?.backendNodeId?.[nodeArrayIdx];
        if (iframeBid === undefined) continue;
        // Sub-documents have their own scroll offsets; bounds are relative
        // to the iframe's own coordinate space (not the main viewport).
        const subScrollX = subDoc.scrollOffsetX ?? 0;
        const subScrollY = subDoc.scrollOffsetY ?? 0;
        const subParsed = parseDocumentNodes(subDoc, strings, dpr, subScrollX, subScrollY);
        iframeNodes.set(iframeBid, subParsed.nodes);
        for (const id of subParsed.excludedBackendNodeIds) {
          excludedBackendNodeIds.add(id);
        }
      }
    }
  }

  await enrichFormControlState(cdp, tabId, nodes);
  for (const subNodes of iframeNodes.values()) {
    await enrichFormControlState(cdp, tabId, subNodes);
  }

  const surfaceProbes = await probeHoverSurfaces(cdp, tabId);

  return { nodes, viewport, iframeNodes, surfaceProbes, excludedBackendNodeIds };
}
