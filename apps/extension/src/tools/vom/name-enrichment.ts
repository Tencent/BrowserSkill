import { isVomReferenceNode } from "@browser-skill/vom";
import { type CdpRunner, withRemoteObject } from "../shared";
import type { FrameDocument, FrameOwnedAxNode } from "./frame-document";
import { clearHover, ProbeBudget, waitForHover } from "./hover-perception";
import { stableIdentifierName } from "./semantic-graph/name-evidence";
import { frameBackendKey, type ResolvedSemanticGraph } from "./semantic-graph/types";

const MAX_TOOLTIP_CANDIDATES = 8;
const MAX_TOOLTIP_PROBE_MS = 2_400;
const TOOLTIP_SETTLE_MS = 250;
const CACHE_TTL_MS = 5 * 60_000;
/**
 * Misses expire sooner than hits: a control that gains a tooltip once the app
 * finishes booting should still be discoverable, but not at the cost of
 * re-probing every unlabelled control on every observation.
 */
const MISS_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
const FORM_CONTROL_TAGS = new Set(["input", "select", "textarea"]);

interface TooltipCacheEntry {
  tabId: number;
  frameId: string;
  loaderId: string;
  url: string;
  /** `null` records "probed, revealed no tooltip" so the miss is not re-paid. */
  name: string | null;
  expiresAt: number;
}

interface TooltipCandidate<T extends FrameOwnedAxNode> {
  document: FrameDocument<T>;
  backendNodeId: number;
  x: number;
  y: number;
  stableIdentifier: boolean;
}

export interface TooltipNameProbeOptions {
  signal?: AbortSignal;
}

const tooltipCache = new Map<string, TooltipCacheEntry>();

let attachedLifecycleCleanup: (() => void) | undefined;

function detachLifecycleListenersIfEmpty(): void {
  if (tooltipCache.size > 0 || !attachedLifecycleCleanup) return;
  const cleanup = attachedLifecycleCleanup;
  attachedLifecycleCleanup = undefined;
  cleanup();
}

function ensureLifecycleListeners(): void {
  if (attachedLifecycleCleanup || tooltipCache.size === 0) return;
  const tabsRemoved = globalThis.chrome?.tabs?.onRemoved;
  const tabsReplaced = globalThis.chrome?.tabs?.onReplaced;
  const navCommitted = globalThis.chrome?.webNavigation?.onCommitted;
  if (!tabsRemoved && !tabsReplaced && !navCommitted) return;

  const onTabRemoved = (tabId: number) => {
    evictTooltipCacheForTab(tabId);
  };
  const onTabReplaced = (_addedTabId: number, removedTabId: number) => {
    evictTooltipCacheForTab(removedTabId);
  };
  const onNavCommitted = (details: { tabId: number; frameId: number }) => {
    if (details.frameId === 0) {
      evictTooltipCacheForTab(details.tabId);
    }
  };

  tabsRemoved?.addListener(onTabRemoved);
  tabsReplaced?.addListener(onTabReplaced);
  navCommitted?.addListener(onNavCommitted);
  attachedLifecycleCleanup = () => {
    tabsRemoved?.removeListener(onTabRemoved);
    tabsReplaced?.removeListener(onTabReplaced);
    navCommitted?.removeListener(onNavCommitted);
  };
}

export function evictTooltipCacheForTab(tabId: number): void {
  for (const [key, entry] of tooltipCache) {
    if (entry.tabId === tabId) tooltipCache.delete(key);
  }
  detachLifecycleListenersIfEmpty();
}

export function clearTooltipCache(): void {
  tooltipCache.clear();
  detachLifecycleListenersIfEmpty();
}

function documentLoaderId<T extends FrameOwnedAxNode>(document: FrameDocument<T>): string {
  return document.loaderId || document.handle.loaderId || "";
}

function cacheKey<T extends FrameOwnedAxNode>(
  document: FrameDocument<T>,
  backendNodeId: number,
): string | undefined {
  const loaderId = documentLoaderId(document);
  if (!loaderId) return undefined;
  return `${document.handle.tabId}\u0000${document.frameId}\u0000${loaderId}\u0000${document.url ?? ""}\u0000${backendNodeId}`;
}

function evictStaleDocuments<T extends FrameOwnedAxNode>(documents: FrameDocument<T>[]): void {
  if (tooltipCache.size === 0) return;
  const now = Date.now();
  const activeByTabFrame = new Map<
    string,
    { tabId: number; loaderId: string; url: string; isRoot: boolean }
  >();
  for (const document of documents) {
    const loaderId = documentLoaderId(document);
    if (!loaderId) continue;
    activeByTabFrame.set(`${document.handle.tabId}\u0000${document.frameId}`, {
      tabId: document.handle.tabId,
      loaderId,
      url: document.url ?? "",
      isRoot: !document.parentFrameId,
    });
  }
  const navigatedTabs = new Set<number>();
  for (const [key, entry] of tooltipCache) {
    if (entry.expiresAt <= now) {
      tooltipCache.delete(key);
      continue;
    }
    const active = activeByTabFrame.get(`${entry.tabId}\u0000${entry.frameId}`);
    if (!active) continue;
    if (active.loaderId !== entry.loaderId || active.url !== entry.url) {
      tooltipCache.delete(key);
      if (active.isRoot && active.loaderId !== entry.loaderId) {
        navigatedTabs.add(active.tabId);
      }
    }
  }
  for (const tabId of navigatedTabs) {
    evictTooltipCacheForTab(tabId);
  }
  detachLifecycleListenersIfEmpty();
}

/** Returns the cache entry, or `undefined` when this control was never probed. */
function cachedEntry<T extends FrameOwnedAxNode>(
  document: FrameDocument<T>,
  backendNodeId: number,
): TooltipCacheEntry | undefined {
  const key = cacheKey(document, backendNodeId);
  if (!key) return undefined;
  const entry = tooltipCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    tooltipCache.delete(key);
    detachLifecycleListenersIfEmpty();
    return undefined;
  }
  return entry;
}

function storeName<T extends FrameOwnedAxNode>(
  document: FrameDocument<T>,
  backendNodeId: number,
  name: string | null,
): void {
  const key = cacheKey(document, backendNodeId);
  if (!key) return;
  if (tooltipCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = tooltipCache.keys().next().value;
    if (oldest !== undefined) tooltipCache.delete(oldest);
  }
  tooltipCache.set(key, {
    tabId: document.handle.tabId,
    frameId: document.frameId,
    loaderId: documentLoaderId(document),
    url: document.url ?? "",
    name,
    expiresAt: Date.now() + (name === null ? MISS_CACHE_TTL_MS : CACHE_TTL_MS),
  });
  ensureLifecycleListeners();
}

function tooltipCollectorFunction(): string {
  return `function() {
    const ownRoot = this && typeof this.getRootNode === "function" ? this.getRootNode() : null;
    const roots = ownRoot && ownRoot !== document ? [ownRoot, document] : [document];
    const items = [];
    const seen = new Set();
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll("[role='tooltip']"))) {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const text = String(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")
          .replace(/\\s+/g, " ")
          .trim();
        if (!text || text.length > 160 || seen.has(text)) continue;
        seen.add(text);
        items.push(text);
      }
    }
    return items.slice(0, 20);
  }`;
}

function cleanTooltipDiff(before: string[], after: string[]): string | undefined {
  const existing = new Set(before.map((value) => value.toLowerCase()));
  const added = [...new Set(after.map((value) => value.replace(/\s+/g, " ").trim()))].filter(
    (value) => value && !existing.has(value.toLowerCase()),
  );
  return added.length === 1 ? added[0] : undefined;
}

function candidates<T extends FrameOwnedAxNode>(
  documents: FrameDocument<T>[],
  graph: ResolvedSemanticGraph,
): TooltipCandidate<T>[] {
  const documentByFrame = new Map(documents.map((document) => [document.frameId, document]));
  const byFrame = new Map<string, TooltipCandidate<T>[]>();
  for (const node of graph.nodes.values()) {
    if (
      node.vom.name ||
      FORM_CONTROL_TAGS.has(node.dom?.tag.toLowerCase() ?? "") ||
      !node.referenceable ||
      node.backendNodeId === undefined ||
      !isVomReferenceNode({
        ...node.vom,
        id: 0,
        parentId: null,
        backendNodeId: node.backendNodeId,
        frameId: node.frameId,
        referenceable: true,
      })
    ) {
      continue;
    }
    const document = documentByFrame.get(node.frameId);
    const rect = node.dom?.rect;
    if (!document || !rect || rect.w <= 0 || rect.h <= 0) continue;
    if (
      rect.x + rect.w <= 0 ||
      rect.y + rect.h <= 0 ||
      rect.x >= graph.viewport.width ||
      rect.y >= graph.viewport.height
    ) {
      continue;
    }
    if (
      node.vom.disabled ||
      node.vom.inert ||
      node.vom.pointerEvents === "none" ||
      node.vom.sensitive
    ) {
      continue;
    }
    const frameCandidates = byFrame.get(node.frameId) ?? [];
    frameCandidates.push({
      document,
      backendNodeId: node.backendNodeId,
      x: (Math.max(0, rect.x) + Math.min(graph.viewport.width, rect.x + rect.w)) / 2,
      y: (Math.max(0, rect.y) + Math.min(graph.viewport.height, rect.y + rect.h)) / 2,
      stableIdentifier: stableIdentifierName(node.dom?.attrs ?? {}) !== undefined,
    });
    byFrame.set(node.frameId, frameCandidates);
  }

  const out: TooltipCandidate<T>[] = [];
  for (const stableIdentifier of [true, false]) {
    const queues = documents.map((document) =>
      (byFrame.get(document.frameId) ?? []).filter(
        (candidate) => candidate.stableIdentifier === stableIdentifier,
      ),
    );
    for (let index = 0; queues.some((queue) => index < queue.length); index += 1) {
      for (const queue of queues) {
        const candidate = queue[index];
        if (candidate) out.push(candidate);
      }
    }
  }
  return out;
}

async function executionContextId<T extends FrameOwnedAxNode>(
  cdp: CdpRunner,
  document: FrameDocument<T>,
): Promise<number | undefined> {
  const result = await cdp.sendToFrame<{ executionContextId?: number }>(
    document.handle,
    "Page.createIsolatedWorld",
    {
      frameId: document.frameId,
      worldName: "bsk-vom-tooltip",
      grantUniveralAccess: false,
    },
  );
  return result.executionContextId;
}

async function resolvedObjectId<T extends FrameOwnedAxNode>(
  cdp: CdpRunner,
  document: FrameDocument<T>,
  contextId: number,
  backendNodeId: number,
): Promise<string | undefined> {
  const result = await cdp.sendToFrame<{
    object?: { objectId?: string };
  }>(document.handle, "DOM.resolveNode", {
    backendNodeId,
    executionContextId: contextId,
  });
  return result.object?.objectId;
}

async function tooltipTexts<T extends FrameOwnedAxNode>(
  cdp: CdpRunner,
  document: FrameDocument<T>,
  objectId: string,
): Promise<string[]> {
  const result = await cdp.sendToFrame<{
    result?: { value?: string[] };
  }>(document.handle, "Runtime.callFunctionOn", {
    functionDeclaration: tooltipCollectorFunction(),
    objectId,
    returnByValue: true,
  });
  return result.result?.value ?? [];
}

export async function probeTooltipNames<T extends FrameOwnedAxNode>(
  cdp: CdpRunner,
  tabId: number,
  documents: FrameDocument<T>[],
  graph: ResolvedSemanticGraph,
  options: TooltipNameProbeOptions = {},
): Promise<Map<string, string>> {
  evictStaleDocuments(documents);
  const names = new Map<string, string>();
  const pending: TooltipCandidate<T>[] = [];
  for (const candidate of candidates(documents, graph)) {
    const cached = cachedEntry(candidate.document, candidate.backendNodeId);
    if (cached) {
      // A cached miss is still a decision: skip the control instead of re-probing.
      if (cached.name !== null) {
        names.set(
          frameBackendKey(candidate.document.frameId, candidate.backendNodeId),
          cached.name,
        );
      }
    } else if (pending.length < MAX_TOOLTIP_CANDIDATES) {
      pending.push(candidate);
    }
  }
  if (pending.length === 0) return names;

  const budget = new ProbeBudget(MAX_TOOLTIP_PROBE_MS);
  const contexts = new Map<string, number>();
  try {
    for (const candidate of pending) {
      if (options.signal?.aborted) throw new DOMException("observation aborted", "AbortError");
      if (!budget.canAfford(TOOLTIP_SETTLE_MS)) break;
      try {
        let contextId = contexts.get(candidate.document.frameId);
        if (contextId === undefined) {
          contextId = await executionContextId(cdp, candidate.document);
          if (contextId === undefined) continue;
          contexts.set(candidate.document.frameId, contextId);
        }
        const objectId = await resolvedObjectId(
          cdp,
          candidate.document,
          contextId,
          candidate.backendNodeId,
        );
        if (!objectId) continue;
        await withRemoteObject(cdp, candidate.document.handle, objectId, async (id) => {
          await clearHover(cdp, tabId);
          const before = await tooltipTexts(cdp, candidate.document, id);
          await cdp.send(tabId, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: candidate.x,
            y: candidate.y,
          });
          await waitForHover(TOOLTIP_SETTLE_MS, options.signal);
          const after = await tooltipTexts(cdp, candidate.document, id);
          const name = cleanTooltipDiff(before, after);
          storeName(candidate.document, candidate.backendNodeId, name ?? null);
          if (name) {
            names.set(frameBackendKey(candidate.document.frameId, candidate.backendNodeId), name);
          }
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
      } finally {
        await clearHover(cdp, tabId);
      }
    }
  } finally {
    await clearHover(cdp, tabId);
  }
  return names;
}
