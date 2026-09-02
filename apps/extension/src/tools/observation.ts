// Observation handlers — `tool.snapshot`, `tool.get_html`, `tool.screenshot`,
// and semantic `tool.observe` (design §7). Each handler resolves the target
// tab (defaulting to the Agent Window's active tab when omitted) and
// returns a payload that mirrors the bsk-protocol Rust structs.

import {
  type ActiveScopeBlock,
  applyVomInteractionRecovery,
  type CondSurface,
  isVomReferenceNode,
  renderVom,
  type VomNode,
  type VomOptions,
  type VomScene,
} from "@browser-skill/vom";
import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import {
  type CaptureSuppressSendToTab,
  withExtensionOverlayHidden,
} from "@/lib/capture-suppress-bridge";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type {
  GetHtmlParams,
  GetHtmlResult,
  ObserveParams,
  ObserveResult,
  RpcError,
  ScreenshotParams,
  ScreenshotResult,
  SnapshotParams,
  SnapshotResult,
} from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { rpcError } from "./errors";
import { resolveNodeGeometry } from "./frame-geometry";
import {
  type ChromeTabsApi,
  enforceToolTargetScope,
  isRpcError,
  lookupSession,
  type ResolvedTargetTab,
  resolveCdpAccessibleTargetTab,
  type CdpRunner as SharedCdpRunner,
  sendToCdpTarget,
  normaliseRef as sharedNormaliseRef,
  type ToolEffect,
} from "./shared";
import { resolveSnapshotRef } from "./snapshot-ref";
import {
  type CapturedNode,
  type CapturedSurfaceProbe,
  type CapturedViewModel,
  captureViewModel,
  collectOverlayExcludedBackendIds,
  probeHoverSurfaces,
} from "./vom/capture";
import { type CapturedFrameDocument, captureFrameData } from "./vom/frame-capture";
import { withOverlayBypass } from "./vom/hover-perception";
import { probeTooltipNames } from "./vom/name-enrichment";
import {
  type CaptureVomObservationResult,
  projectRecordSafeObservation,
} from "./vom/record-safe-observation";
import {
  buildSemanticGraph,
  buildSemanticVomScene,
  normalizeSemanticStructure,
  projectSemanticGraph,
  resolveSemanticGraph,
  type SemanticAxNode,
} from "./vom/semantic-graph";

// ---------------------------------------------------------------------------
// Shared helpers (legacy aliases — observation.ts kept exporting these
// for M6 callers; the live implementations now live in `./shared`).
// ---------------------------------------------------------------------------

export interface ChromeTabsCaptureApi extends ChromeTabsApi {
  captureVisibleTab(windowId: number, opts: chrome.tabs.CaptureVisibleTabOptions): Promise<string>;
}

export const chromeTabsCaptureApi: ChromeTabsCaptureApi = {
  captureVisibleTab: (windowId, opts) => chrome.tabs.captureVisibleTab(windowId, opts),
  get: (tabId) => chrome.tabs.get(tabId),
  query: (q) => chrome.tabs.query(q),
};

/** Re-export so the M6 test suite keeps its import path. */
export const normaliseRef = sharedNormaliseRef;

// ---------------------------------------------------------------------------
// screenshot — `tool.screenshot`
// ---------------------------------------------------------------------------

/**
 * Strip the `data:image/...;base64,` prefix from a Chrome
 * `captureVisibleTab` dataURL and return the raw base64 payload.
 * Falls back to the input untouched when the prefix is missing
 * (defensive — Chrome has always included it but we don't want to
 * crash if a fork changes behaviour).
 */
export function stripDataUrlPrefix(dataUrl: string): string {
  const m = /^data:image\/[a-z+]+;base64,/i.exec(dataUrl);
  return m ? dataUrl.slice(m[0].length) : dataUrl;
}

/**
 * Parse a PNG's IHDR chunk and return `(width, height)`. Returns
 * `null` on any malformed input so callers fall back to `0/0` instead
 * of throwing.
 *
 * PNG layout: 8-byte signature, then a 4-byte length, 4-byte type
 * ("IHDR"), then the chunk data — width is bytes 16-19 BE, height is
 * 20-23 BE.
 */
export function parsePngDimensions(base64: string): { width: number; height: number } | null {
  try {
    // atob is available in MV3 service workers.
    const head = base64.length > 64 ? base64.slice(0, 64) : base64;
    const bin = atob(head);
    if (bin.length < 24) return null;
    if (bin.charCodeAt(0) !== 0x89 || bin.charCodeAt(1) !== 0x50 || bin.charCodeAt(2) !== 0x4e) {
      return null;
    }
    const u32 = (off: number) =>
      (bin.charCodeAt(off) << 24) |
      (bin.charCodeAt(off + 1) << 16) |
      (bin.charCodeAt(off + 2) << 8) |
      bin.charCodeAt(off + 3);
    const width = u32(16) >>> 0;
    const height = u32(20) >>> 0;
    if (width === 0 || height === 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

export interface ScreenshotDeps {
  cdp?: SharedCdpRunner;
  tabsApi: ChromeTabsApi;
  captureApi: ChromeTabsCaptureApi;
  /**
   * Bridge used to hide the in-page overlay while a screenshot is taken,
   * so captured frames only contain page content. Defaults to
   * `chrome.tabs.sendMessage`; tests inject a fake.
   */
  sendToTab?: CaptureSuppressSendToTab;
}

function defaultScreenshotDeps(): ScreenshotDeps {
  return {
    cdp: new ChromiumCdp(),
    tabsApi: chromeTabsCaptureApi,
    captureApi: chromeTabsCaptureApi,
  };
}

function cancelled(tool: string): RpcError {
  return { code: "cancelled", message: `${tool} aborted` };
}

function abortError(tool: string): Error {
  const error = new Error(`${tool} aborted`);
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

function throwIfAborted(signal: AbortSignal | undefined, tool: string): void {
  if (signal?.aborted) throw abortError(tool);
}

async function captureElementScreenshot(
  cdp: SharedCdpRunner,
  tabId: number,
  target: CdpTarget,
  backendNodeId: number,
  frameId?: string,
  signal?: AbortSignal,
): Promise<{ image_base64: string; width: number; height: number } | RpcError> {
  if (signal?.aborted) return cancelled("screenshot");
  const geometry = await resolveNodeGeometry(
    cdp,
    tabId,
    { target, backendNodeId, ...(frameId ? { frameId } : {}) },
    { scrollIntoView: true },
  );
  if (isRpcError(geometry)) return geometry;
  if (signal?.aborted) return cancelled("screenshot");
  const rect = geometry.topBounds;

  try {
    const shot = await cdp.send<{ data?: string }>(tabId, "Page.captureScreenshot", {
      format: "png",
      clip: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scale: 1,
      },
    });
    if (signal?.aborted) return cancelled("screenshot");
    const image_base64 = shot.data ?? "";
    if (!image_base64) {
      return { code: "cdp_failed", message: "Page.captureScreenshot returned no data" };
    }
    const dims = parsePngDimensions(image_base64) ?? {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    return { image_base64, width: dims.width, height: dims.height };
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Full-tab PNG capture. The primary path is `chrome.tabs.captureVisibleTab`;
 * when it rejects, fall back to CDP `Page.captureScreenshot` with
 * `fromSurface: true`. `captureVisibleTab` reads back the window surface,
 * which fails outright on some Windows/Chrome combinations (Chromium's
 * FAILURE_REASON_READBACK_FAILED — "Failed to capture tab: image readback
 * failed"); the CDP path captures through the renderer's BeginFrame
 * pipeline instead, which does not depend on that readback.
 *
 * When both paths fail the returned error carries
 * `data.reason = "screenshot_capture_failed"` and both underlying messages
 * so the CLI can point the user at the browser-side cause.
 */
async function captureFullTabPng(
  deps: ScreenshotDeps,
  ctx: SessionContext,
  target: ResolvedTargetTab,
  signal?: AbortSignal,
): Promise<string | RpcError> {
  if (signal?.aborted) return cancelled("screenshot");
  try {
    const dataUrl = await deps.captureApi.captureVisibleTab(target.windowId, { format: "png" });
    if (signal?.aborted) return cancelled("screenshot");
    return stripDataUrlPrefix(dataUrl);
  } catch (primaryErr) {
    if (signal?.aborted) return cancelled("screenshot");
    const cdp = deps.cdp;
    if (!cdp) {
      return {
        code: "cdp_failed",
        message: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
      };
    }
    let fallbackMsg: string;
    try {
      if (signal?.aborted) return cancelled("screenshot");
      cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
      await cdp.ensureAttachedToUrl?.(target.tabId, target.url);
      if (signal?.aborted) return cancelled("screenshot");
      const shot = await cdp.send<{ data?: string }>(target.tabId, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      });
      if (signal?.aborted) return cancelled("screenshot");
      if (shot.data) return shot.data;
      fallbackMsg = "Page.captureScreenshot returned no data";
    } catch (fallbackErr) {
      fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    }
    const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    return rpcError(
      "cdp_failed",
      "screenshot_capture_failed",
      `captureVisibleTab failed: ${primaryMsg}; CDP Page.captureScreenshot fallback failed: ${fallbackMsg}`,
    );
  }
}

export async function handleScreenshot(
  manager: SessionManager,
  params: ScreenshotParams,
  deps: ScreenshotDeps = defaultScreenshotDeps(),
  signal?: AbortSignal,
): Promise<ScreenshotResult | RpcError> {
  if (signal?.aborted) return cancelled("screenshot");
  const ctxOrErr = lookupSession(manager, params, "screenshot");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const target = await resolveCdpAccessibleTargetTab(
    manager,
    ctx,
    params.tab_id,
    deps.tabsApi,
    "screenshot",
  );
  if (isRpcError(target)) return target;
  if (signal?.aborted) return cancelled("screenshot");
  const dialogCursor = deps.cdp ? markDialogCursor(deps.cdp, target.tabId) : 0;
  const withShotDialogs = <T extends object>(result: T) =>
    deps.cdp ? attachDialogs(deps.cdp, target.tabId, dialogCursor, result) : result;

  const ref = typeof params.ref === "string" && params.ref.length > 0 ? params.ref : null;
  if (ref) {
    if (!deps.cdp) {
      return { code: "cdp_failed", message: "screenshot ref capture requires CDP" };
    }
    const node = resolveSnapshotRef(ctx, ref, target.tabId);
    if (isRpcError(node)) return node;
    if (signal?.aborted) return cancelled("screenshot");
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    await deps.cdp.ensureAttachedToUrl?.(target.tabId, target.url);
    if (signal?.aborted) return cancelled("screenshot");
    const cdp = deps.cdp;
    const nodeTarget = {
      tabId: target.tabId,
      ...(node.cdpSessionId ? { sessionId: node.cdpSessionId } : {}),
    };
    const captured = await withExtensionOverlayHidden(
      target.tabId,
      () =>
        captureElementScreenshot(
          cdp,
          target.tabId,
          nodeTarget,
          node.backendNodeId,
          node.frameId,
          signal,
        ),
      deps.sendToTab,
    );
    if (isRpcError(captured)) return captured;
    if (signal?.aborted) return cancelled("screenshot");
    return withShotDialogs({
      image_base64: captured.image_base64,
      width: captured.width,
      height: captured.height,
      format: "png",
      tab_id: target.tabId,
    });
  }

  if (!target.active) {
    return rpcError(
      "invalid_params",
      "tab_not_active",
      `tab ${target.tabId} is not active; screenshot can only capture the visible tab`,
    );
  }

  const captured = await withExtensionOverlayHidden(
    target.tabId,
    () => captureFullTabPng(deps, ctx, target, signal),
    deps.sendToTab,
  );
  if (isRpcError(captured)) return captured;
  if (signal?.aborted) return cancelled("screenshot");
  const image_base64 = captured;
  const dims = parsePngDimensions(image_base64) ?? { width: 0, height: 0 };
  return withShotDialogs({
    image_base64,
    width: dims.width,
    height: dims.height,
    format: "png",
    tab_id: target.tabId,
  });
}

// ---------------------------------------------------------------------------
// snapshot — `tool.snapshot`
// ---------------------------------------------------------------------------

/**
 * Minimal CDP surface the snapshot algorithm depends on. Backed by
 * `ChromiumCdp` in production; tests inject a fake. Re-exported from
 * `./shared` so M6 callers see the same type.
 */
export type CdpRunner = SharedCdpRunner;

/** Subset of CDP `AXNode` we care about — see `Accessibility.AXNode`. */
export type CdpAxNode = SemanticAxNode;

function normalizeTag(tag: string | undefined): string {
  return tag?.toLowerCase() ?? "";
}

function cleanAttr(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

const ACTIVE_SCOPE_MAX_BLOCKS = 8;
const ACTIVE_SCOPE_MAX_LINES = 40;
const ACTIVE_SCOPE_MAX_LINE_LENGTH = 160;
const ACTIVE_SCOPE_MAX_TOTAL_CHARS = 8_000;
const ACTIVE_SCOPE_SKIP_TAGS = new Set(["script", "style", "noscript", "template"]);

function buildCapturedChildren(capturedNodes: CapturedNode[]): Map<number, CapturedNode[]> {
  const children = new Map<number, CapturedNode[]>();
  for (const node of capturedNodes) {
    if (node.parentBackendNodeId === null) continue;
    const siblings = children.get(node.parentBackendNodeId);
    if (siblings) siblings.push(node);
    else children.set(node.parentBackendNodeId, [node]);
  }
  return children;
}

interface VomNodeDomSignals {
  capturedByBackendId: Map<number, CapturedNode>;
  childrenByParentId: Map<number, CapturedNode[]>;
}

function capturedOnlySignals(capturedNodes: CapturedNode[]): VomNodeDomSignals {
  const capturedByBackendId = new Map<number, CapturedNode>();
  for (const node of capturedNodes) {
    capturedByBackendId.set(node.backendNodeId, node);
  }
  return {
    capturedByBackendId,
    childrenByParentId: buildCapturedChildren(capturedNodes),
  };
}

function normalizeProbeKey(value: string | undefined): string {
  return cleanAttr(value)?.toLowerCase() ?? "";
}

function controlledIds(attrs: Record<string, string>): string[] {
  return (attrs["aria-controls"] ?? "").split(/\s+/).filter(Boolean);
}

function isActiveScopeTrigger(node: VomNode): boolean {
  const attrs = node.attrs ?? {};
  if (controlledIds(attrs).length === 0) return false;
  const role = normalizeTag(attrs.role) || normalizedVomRole(node);
  return (
    (role === "tab" && (attrs["aria-selected"] ?? "").toLowerCase() === "true") ||
    (attrs["aria-expanded"] ?? "").toLowerCase() === "true"
  );
}

function normalizedVomRole(node: VomNode): string {
  return node.role?.toLowerCase() ?? "";
}

function collectScopeLines(
  root: CapturedNode,
  triggerLabel: string,
  childrenByParentId: Map<number, CapturedNode[]>,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const triggerKey = normalizeProbeKey(triggerLabel);
  const stack = [root];
  while (stack.length > 0 && lines.length < ACTIVE_SCOPE_MAX_LINES) {
    const node = stack.shift() as CapturedNode;
    const tag = normalizeTag(node.tag);
    if (ACTIVE_SCOPE_SKIP_TAGS.has(tag)) continue;
    if ((node.attrs.type ?? "").toLowerCase() === "password") continue;

    const text = cleanAttr(node.textContent);
    const key = normalizeProbeKey(text);
    if (text && key !== triggerKey && !seen.has(key)) {
      seen.add(key);
      lines.push(
        text.length > ACTIVE_SCOPE_MAX_LINE_LENGTH
          ? text.slice(0, ACTIVE_SCOPE_MAX_LINE_LENGTH)
          : text,
      );
    }
    stack.push(...(childrenByParentId.get(node.backendNodeId) ?? []));
  }
  return lines;
}

function buildActiveScopeBlocks(nodes: VomNode[], signals: VomNodeDomSignals): ActiveScopeBlock[] {
  const panelByDomId = new Map<string, CapturedNode>();
  for (const capturedNode of signals.capturedByBackendId.values()) {
    const domId = capturedNode.attrs.id;
    if (domId) panelByDomId.set(domId, capturedNode);
  }

  const blocks: ActiveScopeBlock[] = [];
  let totalChars = 0;
  for (const node of nodes) {
    if (blocks.length >= ACTIVE_SCOPE_MAX_BLOCKS) break;
    if (!isActiveScopeTrigger(node)) continue;
    const label =
      cleanAttr(node.name) ?? cleanAttr(node.text) ?? cleanAttr(node.attrs?.["aria-label"]);
    if (!label) continue;

    const lines: string[] = [];
    for (const controlId of controlledIds(node.attrs ?? {})) {
      const panel = panelByDomId.get(controlId);
      if (!panel) continue;
      lines.push(...collectScopeLines(panel, label, signals.childrenByParentId));
      if (lines.length >= ACTIVE_SCOPE_MAX_LINES) break;
    }

    const uniqueLines: string[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      const key = normalizeProbeKey(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      uniqueLines.push(line);
      totalChars += line.length;
      if (
        uniqueLines.length >= ACTIVE_SCOPE_MAX_LINES ||
        totalChars >= ACTIVE_SCOPE_MAX_TOTAL_CHARS
      ) {
        break;
      }
    }
    if (uniqueLines.length === 0) continue;
    blocks.push({ triggerId: node.id, label, lines: uniqueLines });
    if (totalChars >= ACTIVE_SCOPE_MAX_TOTAL_CHARS) break;
  }
  return blocks;
}

function buildConditionalSurfaces(
  nodes: VomNode[],
  captured: CapturedViewModel,
  probes: CapturedSurfaceProbe[],
): CondSurface[] {
  if (probes.length === 0) return [];

  const surfaces: CondSurface[] = [];
  const recoveredNodes = applyVomInteractionRecovery(nodes);
  const signals = capturedOnlySignals(captured.nodes);
  const used = new Set<number>();
  for (const probe of probes) {
    if (probe.subItems.length === 0 || used.has(probe.triggerBackendNodeId)) continue;
    const match = findSurfaceTriggerNode(
      probe.triggerBackendNodeId,
      recoveredNodes,
      signals,
      probe.triggerPoint,
    );
    if (!match) continue;
    if (used.has(match.id)) continue;
    used.add(probe.triggerBackendNodeId);
    used.add(match.id);
    surfaces.push({
      triggerId: match.id,
      triggerAction: probe.triggerAction,
      subItems: probe.subItems,
    });
  }
  return surfaces;
}

function findSurfaceTriggerNode(
  triggerBackendNodeId: number,
  nodes: VomNode[],
  signals: VomNodeDomSignals,
  triggerPoint?: { x: number; y: number },
): VomNode | undefined {
  const renderedById = new Map(nodes.map((node) => [node.id, node]));
  const renderedByBackendId = new Map(
    nodes.flatMap((node) =>
      node.backendNodeId === undefined ? [] : ([[node.backendNodeId, node]] as const),
    ),
  );
  const exact =
    renderedByBackendId.get(triggerBackendNodeId) ?? renderedById.get(triggerBackendNodeId);
  if (exact && isSurfaceAttachableNode(exact)) return exact;

  const isCapturedDescendant = (backendNodeId: number): boolean => {
    let current = signals.capturedByBackendId.get(backendNodeId);
    const seen = new Set<number>();
    while (current?.parentBackendNodeId !== null && current?.parentBackendNodeId !== undefined) {
      if (current.parentBackendNodeId === triggerBackendNodeId) return true;
      if (seen.has(current.parentBackendNodeId)) break;
      seen.add(current.parentBackendNodeId);
      current = signals.capturedByBackendId.get(current.parentBackendNodeId);
    }
    return false;
  };
  const domDescendant = nodes.find(
    (node) =>
      isSurfaceAttachableNode(node) &&
      node.backendNodeId !== undefined &&
      isCapturedDescendant(node.backendNodeId),
  );
  if (domDescendant) return domDescendant;

  const queue = [...(signals.childrenByParentId.get(triggerBackendNodeId) ?? [])];
  while (queue.length > 0) {
    const child = queue.shift() as CapturedNode;
    const rendered = renderedByBackendId.get(child.backendNodeId);
    if (rendered && isSurfaceAttachableNode(rendered)) return rendered;
    queue.push(...(signals.childrenByParentId.get(child.backendNodeId) ?? []));
  }

  let current = signals.capturedByBackendId.get(triggerBackendNodeId);
  while (current?.parentBackendNodeId !== null && current?.parentBackendNodeId !== undefined) {
    const parent = renderedByBackendId.get(current.parentBackendNodeId);
    if (parent && isSurfaceAttachableNode(parent)) return parent;
    current = signals.capturedByBackendId.get(current.parentBackendNodeId);
  }

  if (triggerPoint) {
    return findSurfaceNodeByPoint(triggerPoint, nodes, signals);
  }

  return undefined;
}

function isSurfaceAttachableNode(node: VomNode): boolean {
  return isVomReferenceNode(node);
}

function findSurfaceNodeByPoint(
  point: { x: number; y: number },
  nodes: VomNode[],
  signals: VomNodeDomSignals,
): VomNode | undefined {
  let best: { node: VomNode; score: number } | undefined;
  for (const node of nodes) {
    if (!isSurfaceAttachableNode(node)) continue;
    const rect =
      node.rect ??
      (node.backendNodeId === undefined
        ? undefined
        : signals.capturedByBackendId.get(node.backendNodeId)?.rect);
    if (!rect) continue;
    const contains =
      point.x >= rect.x &&
      point.x <= rect.x + rect.w &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.h;
    const centerX = rect.x + rect.w / 2;
    const centerY = rect.y + rect.h / 2;
    const distance = Math.hypot(point.x - centerX, point.y - centerY);
    if (!contains && distance > 40) continue;
    const score = contains ? distance : distance + 1_000;
    if (!best || score < best.score) {
      best = { node, score };
    }
  }
  return best?.node;
}

export interface BuildVomSceneOptions {
  pageUrl?: string;
  supplementalNames?: ReadonlyMap<string, string>;
  surfaceProbes?: CapturedSurfaceProbe[];
}

export type VomFrameDocument = CapturedFrameDocument<CdpAxNode>;

function legacyFrameDocuments(
  axNodes: CdpAxNode[],
  captured: CapturedViewModel,
  pageUrl?: string,
  rootTarget: VomFrameDocument["target"] = { tabId: 0 },
): VomFrameDocument[] {
  const rootFrameId = captured.rootFrameId ?? "root";
  const documents: VomFrameDocument[] = [
    {
      frameId: rootFrameId,
      contextScopeId: rootFrameId,
      target: rootTarget,
      ...(pageUrl ? { url: pageUrl } : {}),
      axNodes: [],
      domNodes: captured.nodes.map((node) => ({ ...node, frameId: node.frameId ?? rootFrameId })),
    },
  ];
  const pending = [...captured.iframeNodes.entries()];
  let progress = true;
  let nextSyntheticFrame = 1;
  while (pending.length > 0 && progress) {
    progress = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const [ownerBackendNodeId, domNodes] = pending[index];
      const parent = documents.find((document) =>
        document.domNodes.some((node) => node.backendNodeId === ownerBackendNodeId),
      );
      if (!parent) continue;
      const frameId =
        domNodes.find((node) => node.frameId)?.frameId ?? `legacy-frame-${nextSyntheticFrame++}`;
      documents.push({
        frameId,
        parentFrameId: parent.frameId,
        ownerBackendNodeId,
        contextScopeId: frameId,
        target: parent.target,
        axNodes: [],
        domNodes: domNodes.map((node) => ({ ...node, frameId: node.frameId ?? frameId })),
      });
      pending.splice(index, 1);
      progress = true;
    }
  }

  const documentByFrameId = new Map(documents.map((document) => [document.frameId, document]));
  const backendFrame = new Map<number, string>();
  const childFrameByOwner = new Map<number, string>();
  for (const document of documents) {
    if (document.ownerBackendNodeId !== undefined) {
      childFrameByOwner.set(document.ownerBackendNodeId, document.frameId);
    }
    for (const node of document.domNodes) backendFrame.set(node.backendNodeId, document.frameId);
  }
  const axById = new Map(axNodes.map((node) => [node.nodeId, node]));
  const ownership = new Map<string, string>();
  const resolving = new Set<string>();
  const frameForAx = (node: CdpAxNode): string => {
    const cached = ownership.get(node.nodeId);
    if (cached) return cached;
    let frameId: string | undefined;
    if (node.frameId && documentByFrameId.has(node.frameId)) frameId = node.frameId;
    if (!frameId && typeof node.backendDOMNodeId === "number") {
      frameId = backendFrame.get(node.backendDOMNodeId);
    }
    if (!frameId && node.parentId && !resolving.has(node.nodeId)) {
      const parent = axById.get(node.parentId);
      if (parent) {
        frameId =
          typeof parent.backendDOMNodeId === "number"
            ? childFrameByOwner.get(parent.backendDOMNodeId)
            : undefined;
        if (!frameId) {
          resolving.add(node.nodeId);
          frameId = frameForAx(parent);
          resolving.delete(node.nodeId);
        }
      }
    }
    frameId ??= rootFrameId;
    ownership.set(node.nodeId, frameId);
    return frameId;
  };
  for (const node of axNodes) frameForAx(node);
  for (const node of axNodes) {
    const frameId = ownership.get(node.nodeId) ?? rootFrameId;
    const document = documentByFrameId.get(frameId) ?? documents[0];
    document.axNodes.push({
      ...node,
      frameId,
      ...(node.parentId && ownership.get(node.parentId) === frameId
        ? { parentId: node.parentId }
        : { parentId: undefined }),
      ...(node.childIds
        ? { childIds: node.childIds.filter((childId) => ownership.get(childId) === frameId) }
        : {}),
    });
  }
  return documents;
}

function withLegacyBackendIds(scene: VomScene): VomScene {
  const used = new Set<number>();
  const idMap = new Map<number, number>();
  let nextVirtualId = -1;
  for (const node of scene.nodes) {
    const preferred = node.backendNodeId;
    const id = preferred !== undefined && !used.has(preferred) ? preferred : nextVirtualId--;
    used.add(id);
    idMap.set(node.id, id);
  }
  return {
    ...scene,
    nodes: scene.nodes.map((node) => ({
      ...node,
      id: idMap.get(node.id) as number,
      parentId: node.parentId === null ? null : (idMap.get(node.parentId) ?? null),
      ...(node.domParentId !== undefined
        ? { domParentId: node.domParentId === null ? null : (idMap.get(node.domParentId) ?? null) }
        : {}),
      ...(node.domAncestorIds
        ? { domAncestorIds: node.domAncestorIds.flatMap((id) => idMap.get(id) ?? []) }
        : {}),
    })),
    ...(scene.surfaces
      ? {
          surfaces: scene.surfaces.map((surface) => ({
            ...surface,
            triggerId: idMap.get(surface.triggerId) ?? surface.triggerId,
          })),
        }
      : {}),
    ...(scene.activeScopeBlocks
      ? {
          activeScopeBlocks: scene.activeScopeBlocks.map((block) => ({
            ...block,
            triggerId: idMap.get(block.triggerId) ?? block.triggerId,
          })),
        }
      : {}),
  };
}

export function buildVomScene(
  axNodes: CdpAxNode[],
  captured: CapturedViewModel,
  options: BuildVomSceneOptions = {},
): VomScene {
  return withLegacyBackendIds(
    buildFrameVomScene(legacyFrameDocuments(axNodes, captured, options.pageUrl), captured, options),
  );
}

export function buildFrameVomScene(
  documents: VomFrameDocument[],
  captured: CapturedViewModel,
  options: BuildVomSceneOptions = {},
): VomScene {
  const scene = buildSemanticVomScene({
    documents,
    viewport: captured.viewport,
    rootFrameId: captured.rootFrameId,
    excludedBackendNodeIds: captured.excludedBackendNodeIds,
    supplementalNames: options.supplementalNames,
  });
  return attachCapturedSceneAnnotations(scene, documents, captured, options.surfaceProbes ?? []);
}

function attachCapturedSceneAnnotations(
  scene: VomScene,
  documents: VomFrameDocument[],
  captured: CapturedViewModel,
  surfaceProbes: CapturedSurfaceProbe[],
): VomScene {
  const rootDocument = documents.find((document) => document.frameId === scene.rootFrameId);
  const signals = capturedOnlySignals(rootDocument?.domNodes ?? captured.nodes);
  const activeScopeBlocks = buildActiveScopeBlocks(scene.nodes, signals);
  const surfaces = buildConditionalSurfaces(scene.nodes, captured, surfaceProbes);
  return {
    ...scene,
    ...(surfaces.length > 0 ? { surfaces } : {}),
    ...(activeScopeBlocks.length > 0 ? { activeScopeBlocks } : {}),
  };
}

export interface SnapshotDeps {
  cdp: CdpRunner;
  tabsApi: {
    get(tabId: number): Promise<chrome.tabs.Tab>;
    query(q: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  };
  conditionalSurfaceProbe?: boolean;
  hoverProbeBypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
}

let defaultDeps: SnapshotDeps | null = null;
function getDefaultDeps(): SnapshotDeps {
  if (!defaultDeps) {
    defaultDeps = {
      cdp: new ChromiumCdp(),
      tabsApi: { get: (tabId) => chrome.tabs.get(tabId), query: (q) => chrome.tabs.query(q) },
    };
  }
  return defaultDeps;
}

// ---------------------------------------------------------------------------
// get_html — `tool.get_html`
// ---------------------------------------------------------------------------

/**
 * Default byte budget when callers don't pass `max_bytes`. Mirrors the
 * `524288` value documented in the bsk-protocol Rust struct so the
 * extension never differs from the spec without the caller asking.
 */
export const DEFAULT_GET_HTML_MAX_BYTES = 524_288;

/**
 * Compute the UTF-8 byte length of an HTML payload (TextEncoder is
 * available in MV3 service workers and happy-dom).
 */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Truncate `html` to at most `maxBytes` bytes without splitting a
 * multibyte UTF-8 sequence. Returns the truncated string + a flag.
 */
function truncateBytes(html: string, maxBytes: number): { out: string; truncated: boolean } {
  const enc = new TextEncoder();
  const bytes = enc.encode(html);
  if (bytes.length <= maxBytes) return { out: html, truncated: false };
  // Walk back to a UTF-8 boundary (bytes whose high bits aren't `10`).
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  const out = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, end));
  return { out, truncated: true };
}

export async function handleGetHtml(
  manager: SessionManager,
  params: GetHtmlParams,
  deps: SnapshotDeps = getDefaultDeps(),
  signal?: AbortSignal,
): Promise<GetHtmlResult | RpcError> {
  if (signal?.aborted) return cancelled("get_html");
  const ctxOrErr = lookupSession(manager, params, "get_html");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const target = await resolveCdpAccessibleTargetTab(
    manager,
    ctx,
    params.tab_id,
    deps.tabsApi,
    "get_html",
  );
  if (isRpcError(target)) return target;
  if (signal?.aborted) return cancelled("get_html");
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const maxBytes =
    params.max_bytes && params.max_bytes > 0 ? params.max_bytes : DEFAULT_GET_HTML_MAX_BYTES;

  try {
    throwIfAborted(signal, "get_html");
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    await deps.cdp.ensureAttachedToUrl?.(target.tabId, target.url);
    throwIfAborted(signal, "get_html");
    let html: string;
    if (params.ref) {
      const resolved = resolveSnapshotRef(ctx, params.ref, target.tabId);
      if (isRpcError(resolved)) return resolved;
      const resp = await sendToCdpTarget<{ outerHTML?: string }>(
        deps.cdp,
        {
          tabId: target.tabId,
          ...(resolved.cdpSessionId ? { sessionId: resolved.cdpSessionId } : {}),
        },
        "DOM.getOuterHTML",
        { backendNodeId: resolved.backendNodeId },
      );
      throwIfAborted(signal, "get_html");
      html = resp.outerHTML ?? "";
    } else {
      const doc = await deps.cdp.send<{ root?: { nodeId?: number } }>(
        target.tabId,
        "DOM.getDocument",
        { depth: 0 },
      );
      throwIfAborted(signal, "get_html");
      const nodeId = doc.root?.nodeId;
      if (typeof nodeId !== "number") {
        return {
          code: "cdp_failed",
          message: "DOM.getDocument returned no root nodeId",
        };
      }
      const resp = await deps.cdp.send<{ outerHTML?: string }>(target.tabId, "DOM.getOuterHTML", {
        nodeId,
      });
      throwIfAborted(signal, "get_html");
      html = resp.outerHTML ?? "";
    }
    const originalBytes = utf8ByteLength(html);
    const { out, truncated } = truncateBytes(html, maxBytes);
    return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
      html: out,
      truncated,
      byte_size: originalBytes,
      tab_id: target.tabId,
    });
  } catch (err) {
    if (isAbortError(err)) return cancelled("get_html");
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function emptyCapturedViewModel(viewport = { width: 0, height: 0 }): CapturedViewModel {
  return { viewport, nodes: [], iframeNodes: new Map(), excludedBackendNodeIds: new Set() };
}

interface LayoutMetricsViewportReply {
  cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
  layoutViewport?: { clientWidth?: number; clientHeight?: number };
}

async function fallbackCapturedViewModel(
  cdp: CdpRunner,
  tabId: number,
  signal?: AbortSignal,
): Promise<CapturedViewModel> {
  throwIfAborted(signal, "observation");
  let viewport = { width: 0, height: 0 };
  try {
    const metrics = await cdp.send<LayoutMetricsViewportReply>(tabId, "Page.getLayoutMetrics", {});
    throwIfAborted(signal, "observation");
    const source = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
    viewport = {
      width: source.clientWidth ?? 0,
      height: source.clientHeight ?? 0,
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
  }
  const excludedBackendNodeIds = await collectOverlayExcludedBackendIds(cdp, tabId, signal);
  throwIfAborted(signal, "observation");
  return { ...emptyCapturedViewModel(viewport), excludedBackendNodeIds };
}

async function captureForVom(
  cdp: CdpRunner,
  tabId: number,
  options: CaptureVomObservationOptions,
): Promise<CapturedViewModel> {
  try {
    return await captureViewModel(cdp, tabId, { signal: options.signal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return fallbackCapturedViewModel(cdp, tabId, options.signal);
  }
}

export interface HoverProbeOutcome {
  /** Whether any active hover was dispatched during this observation. */
  performed: boolean;
  /**
   * Whether hovering surfaced content absent from the static snapshot. Cached
   * tooltip names count, so this may over-report on repeat observations — it
   * errs towards telling the caller the snapshot is less fresh than it looks.
   */
  revealedContent: boolean;
  surfaceProbes: CapturedSurfaceProbe[];
  tooltipNames: Map<string, string>;
}

const NO_HOVER_PROBES: HoverProbeOutcome = {
  performed: false,
  revealedContent: false,
  surfaceProbes: [],
  tooltipNames: new Map(),
};

/**
 * Runs both active-hover chains back to back.
 *
 * Ordering matters: this happens after DOM *and* accessibility capture so a
 * hover that opens a menu cannot leave one half of the observation describing
 * the page before the change and the other half after it. Sharing one overlay
 * bypass span also means the agent overlay toggles once per observation
 * instead of once per chain.
 */
async function runHoverProbes(
  cdp: CdpRunner,
  tabId: number,
  captured: CapturedViewModel,
  documents: VomFrameDocument[],
  staticSemantics: ReturnType<typeof resolveSemanticGraph>,
  options: CaptureVomObservationOptions,
): Promise<HoverProbeOutcome> {
  if (!options.conditionalSurfaceProbe) return NO_HOVER_PROBES;

  return withOverlayBypass(options.hoverProbeBypassOverlay, tabId, async () => {
    const surfaceProbes = await probeHoverSurfaces(cdp, tabId, captured.nodes, {
      signal: options.signal,
    });
    throwIfAborted(options.signal, "observation");
    const tooltipNames = await probeTooltipNames(cdp, tabId, documents, staticSemantics, {
      signal: options.signal,
    });
    return {
      performed: true,
      revealedContent: surfaceProbes.length > 0 || tooltipNames.size > 0,
      surfaceProbes,
      tooltipNames,
    };
  });
}

export interface CaptureVomObservationOptions extends VomOptions {
  conditionalSurfaceProbe?: boolean;
  hoverProbeBypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
  signal?: AbortSignal;
}

export async function captureVomObservation(
  cdp: CdpRunner,
  tabId: number,
  url: string | undefined,
  options: CaptureVomObservationOptions = {},
): Promise<CaptureVomObservationResult> {
  throwIfAborted(options.signal, "observation");
  await cdp.ensureAttachedToUrl?.(tabId, url);
  throwIfAborted(options.signal, "observation");
  const captured = await captureForVom(cdp, tabId, options);
  throwIfAborted(options.signal, "observation");
  const documents = await captureFrameData<CdpAxNode>(cdp, tabId, captured, options.signal);
  throwIfAborted(options.signal, "observation");
  const normalizedDocuments =
    documents.length === 1 && captured.iframeNodes.size > 0
      ? legacyFrameDocuments(documents[0].axNodes, captured, url, documents[0].target)
      : documents;
  const semanticGraph = buildSemanticGraph({
    documents: normalizedDocuments,
    viewport: captured.viewport,
    rootFrameId: captured.rootFrameId,
    excludedBackendNodeIds: captured.excludedBackendNodeIds,
  });
  const staticSemantics = resolveSemanticGraph(semanticGraph, { identifierFallback: false });
  const hoverProbes = await runHoverProbes(
    cdp,
    tabId,
    captured,
    normalizedDocuments,
    staticSemantics,
    options,
  );
  throwIfAborted(options.signal, "observation");
  const scene = projectSemanticGraph(
    normalizeSemanticStructure(
      resolveSemanticGraph(semanticGraph, { supplementalNames: hoverProbes.tooltipNames }),
    ),
  );
  const decoratedScene = attachCapturedSceneAnnotations(
    scene,
    normalizedDocuments,
    captured,
    hoverProbes.surfaceProbes,
  );
  const rendered = renderVom(decoratedScene, {
    maxDepth: options.maxDepth,
    maxTokens: options.maxTokens,
    redactValues: options.redactValues,
    activeRegionPolicy: options.activeRegionPolicy,
  });
  throwIfAborted(options.signal, "observation");
  return projectRecordSafeObservation({
    rootFrameId: captured.rootFrameId ?? normalizedDocuments[0]?.frameId ?? "root",
    frameDocuments: normalizedDocuments,
    rendered,
    surfaceProbes: hoverProbes.surfaceProbes,
    hoverProbe: {
      performed: hoverProbes.performed,
      revealedContent: hoverProbes.revealedContent,
    },
  });
}

async function handleVomObservation(
  manager: SessionManager,
  params: SnapshotParams | ObserveParams,
  toolName: "snapshot" | "observe",
  effect: ToolEffect,
  conditionalSurfaceProbe: boolean,
  deps: SnapshotDeps = getDefaultDeps(),
  signal?: AbortSignal,
): Promise<SnapshotResult | ObserveResult | RpcError> {
  if (signal?.aborted) return cancelled(toolName);
  const ctxOrErr = lookupSession(manager, params, toolName);
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const target = await resolveCdpAccessibleTargetTab(
    manager,
    ctx,
    params.tab_id,
    deps.tabsApi,
    toolName,
  );
  if (isRpcError(target)) return target;
  if (signal?.aborted) return cancelled(toolName);
  const denied = enforceToolTargetScope(ctx, target, effect, toolName);
  if (denied) return denied;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  try {
    throwIfAborted(signal, toolName);
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    const effectiveConditionalSurfaceProbe =
      deps.conditionalSurfaceProbe ?? conditionalSurfaceProbe;
    const observation = await captureVomObservation(deps.cdp, target.tabId, target.url, {
      maxDepth: params.max_depth,
      maxTokens: params.max_tokens,
      activeRegionPolicy: true,
      conditionalSurfaceProbe: effectiveConditionalSurfaceProbe,
      hoverProbeBypassOverlay: deps.hoverProbeBypassOverlay,
      signal,
    });
    throwIfAborted(signal, toolName);
    const targetByFrameId = new Map(
      observation.frames.map((frame) => [frame.frameId, frame.target]),
    );
    ctx.refStore.replace(
      observation.refs.map((ref) => {
        const refTarget = ref.frameId ? targetByFrameId.get(ref.frameId) : undefined;
        return [
          ref.ref,
          {
            backendNodeId: ref.backendNodeId,
            tabId: target.tabId,
            ...(ref.frameId ? { frameId: ref.frameId } : {}),
            ...(refTarget?.sessionId ? { cdpSessionId: refTarget.sessionId } : {}),
          },
        ] as const;
      }),
    );
    return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
      text: observation.text,
      ref_count: observation.refs.length,
      tab_id: target.tabId,
      truncated: observation.truncated,
      ...(toolName === "observe" && observation.hoverProbe?.performed
        ? {
            hover_probe: {
              performed: true,
              revealed_content: observation.hoverProbe.revealedContent,
            },
          }
        : {}),
      ...(toolName === "observe" && (params as ObserveParams).debug_surfaces
        ? {
            debug: {
              surface_probes: (observation.surfaceProbes ?? []).map((probe) => ({
                trigger_backend_node_id: probe.triggerBackendNodeId,
                ...(probe.triggerPoint ? { trigger_point: probe.triggerPoint } : {}),
                trigger_action: probe.triggerAction,
                sub_items: probe.subItems,
                ...(probe.confidence ? { confidence: probe.confidence } : {}),
              })),
            },
          }
        : {}),
    });
  } catch (err) {
    if (isAbortError(err)) return cancelled(toolName);
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleSnapshot(
  manager: SessionManager,
  params: SnapshotParams,
  deps: SnapshotDeps = getDefaultDeps(),
  signal?: AbortSignal,
): Promise<SnapshotResult | RpcError> {
  return handleVomObservation(manager, params, "snapshot", "passive_read", false, deps, signal);
}

export async function handleObserve(
  manager: SessionManager,
  params: ObserveParams,
  deps: SnapshotDeps = getDefaultDeps(),
  signal?: AbortSignal,
): Promise<ObserveResult | RpcError> {
  return handleVomObservation(
    manager,
    params,
    "observe",
    "transient_input",
    params.probe_hover === true,
    deps,
    signal,
  );
}
