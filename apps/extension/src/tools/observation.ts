// Observation handlers — `tool.snapshot`, `tool.get_html`, `tool.screenshot`,
// and semantic `tool.observe` (design §7). Each handler resolves the target
// tab (defaulting to the Agent Window's active tab when omitted) and
// returns a payload that mirrors the bsk-protocol Rust structs.

import {
  type ActiveScopeBlock,
  applyVomInteractionRecovery,
  type CondSurface,
  isVomReferenceNode,
  type Rect,
  type RenderedRef,
  renderVom,
  type VomNode,
  type VomOptions,
  type VomScene,
} from "@browser-skill/vom";
import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { CdpTarget } from "@/browser-driver/frame-graph";
import {
  type CaptureSuppressSendToTab,
  withOverlaysHiddenForCapture,
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
} from "./vom/capture";
import { type CapturedFrameDocument, captureFrameData } from "./vom/frame-capture";

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
    const captured = await withOverlaysHiddenForCapture(
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

  const captured = await withOverlaysHiddenForCapture(
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
export interface CdpAxNode {
  nodeId: string;
  frameId?: string;
  parentId?: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: { type: string; value?: string };
  name?: { type: string; value?: string };
  description?: { value?: string };
  value?: { value?: string | number | boolean };
  properties?: Array<{ name?: string; value?: { value?: string | number | boolean } }>;
  childIds?: string[];
}

function axValue(field?: { value?: string | number | boolean }): string | undefined {
  const value = field?.value;
  return value === undefined ? undefined : String(value);
}

function axString(field?: { value?: string | number | boolean }): string | undefined {
  const value = axValue(field)?.replace(/\s+/g, " ").trim();
  return value ? value : undefined;
}

function normalizeTag(tag: string | undefined): string {
  return tag?.toLowerCase() ?? "";
}

function isModalSignal(
  axNode: CdpAxNode | undefined,
  capturedNode: CapturedNode | undefined,
): boolean {
  const role = axString(axNode?.role)?.toLowerCase();
  if (role === "dialog" || role === "alertdialog") return true;
  if (normalizeTag(capturedNode?.tag) === "dialog") return true;

  const attrs = capturedNode?.attrs ?? {};
  return (attrs["aria-modal"] ?? "").toLowerCase() === "true" || attrs.role === "dialog";
}

function isSensitive(capturedNode: CapturedNode | undefined): boolean {
  const attrs = capturedNode?.attrs ?? {};
  const type = (attrs.type ?? "").toLowerCase();
  if (type === "password") return true;
  const autocomplete = (attrs.autocomplete ?? "").toLowerCase();
  return (
    autocomplete.startsWith("cc-") ||
    autocomplete === "one-time-code" ||
    autocomplete === "current-password" ||
    autocomplete === "new-password"
  );
}

interface AxNodeSignals {
  hasPopup: boolean;
  expanded: boolean;
  selected: boolean;
  controls: string;
  sensitive: boolean;
  aggregatedText?: string;
}

const AX_TEXT_AGGREGATE_ROLES = new Set([
  "paragraph",
  "listitem",
  "term",
  "definition",
  "cell",
  "gridcell",
  "caption",
  "figcaption",
  "blockquote",
  "note",
  "status",
  "log",
  "generic",
  "section",
]);
const AX_TEXT_LEAF_ROLES = new Set(["inlinetextbox", "statictext", "text"]);
const AX_TEXT_STOP_ROLES = new Set([
  "button",
  "link",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "checkbox",
  "textbox",
  "searchbox",
  "spinbutton",
  "slider",
  "switch",
  "tab",
  "treeitem",
  "columnheader",
  "rowheader",
]);
const SENSITIVE_AX_INPUT_TYPES = new Set([
  "password",
  "credit-card",
  "one-time-code",
  "current-password",
  "new-password",
]);

function axPropertyString(axNode: CdpAxNode, name: string): string | undefined {
  const prop = axNode.properties?.find((item) => item.name === name);
  return axString(prop?.value);
}

function axSiblingLabel(axNode: CdpAxNode, axById: Map<string, CdpAxNode>): string | undefined {
  const parent = axNode.parentId ? axById.get(axNode.parentId) : undefined;
  const siblings = parent?.childIds ?? [];
  const index = siblings.indexOf(axNode.nodeId);
  if (index <= 0) return undefined;

  for (let i = index - 1; i >= Math.max(0, index - 4); i -= 1) {
    const sibling = axById.get(siblings[i]);
    if (!sibling) continue;
    const role = axString(sibling.role)?.toLowerCase() ?? "";
    if (AX_TEXT_STOP_ROLES.has(role)) break;
    if (!["statictext", "labeltext", "text", "generic"].includes(role)) continue;
    const label = cleanAttr(axString(sibling.name) ?? axString(sibling.value))?.replace(
      /[：:]\s*$/,
      "",
    );
    if (label && label.length <= 40) return label;
  }
  return undefined;
}

function buildAxSignals(axNodes: CdpAxNode[]): Map<string, AxNodeSignals> {
  const axByNodeId = new Map(axNodes.map((node) => [node.nodeId, node]));
  const virtualText = new Map<string, string>();
  for (const node of axNodes) {
    if (typeof node.backendDOMNodeId === "number") continue;
    const role = axString(node.role)?.toLowerCase() ?? "";
    const name = axString(node.name);
    if (name && AX_TEXT_LEAF_ROLES.has(role)) virtualText.set(node.nodeId, name);
  }

  const collectLeafText = (nodeId: string, depth: number): string[] => {
    if (depth > 8) return [];
    const node = axByNodeId.get(nodeId);
    if (!node) return [];
    const parts: string[] = [];
    for (const childId of node.childIds ?? []) {
      const vtext = virtualText.get(childId);
      if (vtext) {
        parts.push(vtext);
        continue;
      }
      const child = axByNodeId.get(childId);
      if (!child) continue;
      const childRole = axString(child.role)?.toLowerCase() ?? "";
      if (AX_TEXT_LEAF_ROLES.has(childRole)) continue;
      if (AX_TEXT_STOP_ROLES.has(childRole)) continue;
      const childName = axString(child.name);
      if (childName && !AX_TEXT_AGGREGATE_ROLES.has(childRole)) {
        parts.push(childName);
      } else {
        parts.push(...collectLeafText(childId, depth + 1));
      }
    }
    return parts;
  };

  const signals = new Map<string, AxNodeSignals>();
  for (const node of axNodes) {
    const role = axString(node.role)?.toLowerCase() ?? "";
    const expanded = axPropertyString(node, "expanded") === "true";
    const selected = axPropertyString(node, "selected") === "true";
    const controls = axPropertyString(node, "controls") ?? "";
    const hasPopupValue = axPropertyString(node, "hasPopup") ?? "";
    const inputType = axPropertyString(node, "inputType") ?? "";
    let aggregatedText: string | undefined;
    if (AX_TEXT_AGGREGATE_ROLES.has(role) && !axString(node.name)) {
      aggregatedText = cleanAttr(collectLeafText(node.nodeId, 0).join(" "));
    }
    signals.set(node.nodeId, {
      hasPopup: hasPopupValue !== "" && hasPopupValue !== "false",
      expanded,
      selected,
      controls,
      sensitive: SENSITIVE_AX_INPUT_TYPES.has(inputType),
      aggregatedText,
    });
  }
  return signals;
}

function findAxAncestor<T>(
  axNode: CdpAxNode,
  axById: Map<string, CdpAxNode>,
  select: (node: CdpAxNode) => T | undefined,
): T | undefined {
  let parentId = axNode.parentId;
  while (parentId) {
    const parent = axById.get(parentId);
    if (!parent) break;
    const hit = select(parent);
    if (hit !== undefined) return hit;
    parentId = parent.parentId;
  }
  return undefined;
}

function nearestBackendParent(axNode: CdpAxNode, axById: Map<string, CdpAxNode>): number | null {
  return (
    findAxAncestor(axNode, axById, (parent) =>
      typeof parent.backendDOMNodeId === "number" ? parent.backendDOMNodeId : undefined,
    ) ?? null
  );
}

const IFRAME_RENDERABLE_TAGS = new Set(["input", "button", "a", "select", "textarea"]);

function iframeRoleFor(node: CapturedNode): string | undefined {
  const tag = normalizeTag(node.tag);
  if (tag === "input" || tag === "textarea") return "textbox";
  if (tag === "button") return "button";
  if (tag === "a") return "link";
  if (tag === "select") return "combobox";
  return undefined;
}

function iframeNameFor(node: CapturedNode): string | undefined {
  const tag = normalizeTag(node.tag);
  const ariaLabel = node.attrs["aria-label"]?.replace(/\s+/g, " ").trim();
  if (ariaLabel) return ariaLabel;

  const text = node.textContent?.replace(/\s+/g, " ").trim();
  if (text) return text;

  if (tag === "input" || tag === "textarea") {
    const placeholder = node.attrs.placeholder?.replace(/\s+/g, " ").trim();
    if (placeholder) return placeholder;
  }

  const id = node.attrs.id?.replace(/\s+/g, " ").trim();
  return id ? id : undefined;
}

function isRenderableIframeControl(node: CapturedNode): boolean {
  const tag = normalizeTag(node.tag);
  if (!IFRAME_RENDERABLE_TAGS.has(tag)) return false;
  if (!node.localRect && !node.rect) return false;
  if (node.pointerEvents === "none") return false;
  if ((node.attrs.type ?? "").toLowerCase() === "hidden") return false;

  const name = iframeNameFor(node);
  return tag !== "a" || name !== undefined;
}

function normalizedControlType(node: VomNode | CapturedNode): string {
  const attrs = node.attrs ?? {};
  const tag = normalizeTag(node.tag);
  if (tag === "input") return (attrs.type ?? "text").toLowerCase();
  if ("sensitive" in node && node.sensitive) return "password";
  return tag;
}

function sameLogicalIframeControl(existing: VomNode, candidate: CapturedNode, iframeId: number) {
  const role = iframeRoleFor(candidate);
  const name = cleanAttr(iframeNameFor(candidate));
  if (!role || !name) return false;
  if ((existing.role ?? "").toLowerCase() !== role) return false;
  if (cleanAttr(existing.name) !== name) return false;

  const candidateType = normalizedControlType(candidate);
  const existingType = normalizedControlType(existing);
  if (candidateType !== existingType) return false;

  return (
    existing.parentId === iframeId ||
    existing.domParentId === iframeId ||
    existing.domAncestorIds?.includes(iframeId) === true
  );
}

function hasEquivalentIframeControl(
  nodes: VomNode[],
  candidate: CapturedNode,
  iframeId: number,
): boolean {
  return nodes.some((node) => sameLogicalIframeControl(node, candidate, iframeId));
}

function capturedIframeNameFor(node: CapturedNode): string | undefined {
  const ariaLabel = node.attrs["aria-label"]?.replace(/\s+/g, " ").trim();
  if (ariaLabel) return ariaLabel;

  const title = node.attrs.title?.replace(/\s+/g, " ").trim();
  if (title) return title;

  const id = node.attrs.id?.replace(/\s+/g, " ").trim();
  return id ? id : undefined;
}

function cleanAttr(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

const FORM_CONTROL_TAGS = new Set(["input", "textarea", "select"]);

const NATIVE_CONTROL_TAGS = new Set(["button", "input", "select", "textarea"]);
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

function capturedDomAncestorIds(
  node: CapturedNode,
  capturedByBackendId: Map<number, CapturedNode>,
): number[] {
  const ancestors: number[] = [];
  let parentId = node.parentBackendNodeId;
  let guard = 0;
  while (parentId !== null && guard < capturedByBackendId.size) {
    ancestors.push(parentId);
    parentId = capturedByBackendId.get(parentId)?.parentBackendNodeId ?? null;
    guard += 1;
  }
  return ancestors;
}

function capturedHasNativeDescendant(
  node: CapturedNode,
  childrenByParentId: Map<number, CapturedNode[]>,
): boolean {
  const stack = [...(childrenByParentId.get(node.backendNodeId) ?? [])];
  while (stack.length > 0) {
    const child = stack.pop() as CapturedNode;
    if (NATIVE_CONTROL_TAGS.has(normalizeTag(child.tag))) return true;
    stack.push(...(childrenByParentId.get(child.backendNodeId) ?? []));
  }
  return false;
}

function capturedInsideNative(
  node: CapturedNode,
  capturedByBackendId: Map<number, CapturedNode>,
): boolean {
  let parentId = node.parentBackendNodeId;
  let guard = 0;
  while (parentId !== null && guard < capturedByBackendId.size) {
    const parent = capturedByBackendId.get(parentId);
    if (!parent) break;
    if (NATIVE_CONTROL_TAGS.has(normalizeTag(parent.tag))) return true;
    parentId = parent.parentBackendNodeId;
    guard += 1;
  }
  return false;
}

function nearbyTextFor(
  node: CapturedNode,
  childrenByParentId: Map<number, CapturedNode[]>,
): string | undefined {
  if (node.parentBackendNodeId === null) return undefined;
  const siblings = childrenByParentId.get(node.parentBackendNodeId) ?? [];
  const index = siblings.findIndex((sibling) => sibling.backendNodeId === node.backendNodeId);
  if (index < 0) return undefined;

  const labels: string[] = [];
  for (const sibling of siblings.slice(Math.max(0, index - 3), index)) {
    const text = cleanAttr(sibling.textContent);
    if (text) labels.push(text);
  }
  for (const sibling of siblings.slice(index + 1, index + 4)) {
    const text = cleanAttr(sibling.textContent);
    if (text) labels.push(text);
  }
  return labels.length > 0 ? labels.join(" ") : undefined;
}

function previousSiblingTextFor(
  node: CapturedNode,
  childrenByParentId: Map<number, CapturedNode[]>,
): string | undefined {
  if (node.parentBackendNodeId === null) return undefined;
  const siblings = childrenByParentId.get(node.parentBackendNodeId) ?? [];
  const index = siblings.findIndex((sibling) => sibling.backendNodeId === node.backendNodeId);
  if (index <= 0) return undefined;

  for (let i = index - 1; i >= Math.max(0, index - 4); i -= 1) {
    const sibling = siblings[i];
    if (["input", "textarea", "select", "button", "a"].includes(normalizeTag(sibling.tag))) break;
    const text = cleanAttr(sibling.textContent)?.replace(/[：:]\s*$/, "");
    if (text && text.length <= 40) return text;
  }
  return undefined;
}

interface VomNodeDomSignals {
  capturedByBackendId: Map<number, CapturedNode>;
  childrenByParentId: Map<number, CapturedNode[]>;
}

function applyCapturedSignals(
  node: VomNode,
  capturedNode: CapturedNode | undefined,
  signals: VomNodeDomSignals,
): VomNode {
  if (!capturedNode) return node;
  const attrs =
    node.sensitive && Object.prototype.hasOwnProperty.call(capturedNode.attrs, "value")
      ? Object.fromEntries(
          Object.entries(capturedNode.attrs).filter(([name]) => name.toLowerCase() !== "value"),
        )
      : capturedNode.attrs;
  const text = cleanAttr(capturedNode.textContent);
  const nearbyText = nearbyTextFor(capturedNode, signals.childrenByParentId);
  const placeholder = cleanAttr(capturedNode.formPlaceholder) ?? cleanAttr(attrs.placeholder);
  return {
    ...node,
    domParentId: capturedNode.parentBackendNodeId,
    domAncestorIds: capturedDomAncestorIds(capturedNode, signals.capturedByBackendId),
    cursor: capturedNode.cursor,
    attrs,
    ...(text ? { text } : {}),
    ...(nearbyText ? { nearbyText } : {}),
    ...(placeholder ? { placeholder } : {}),
    disabled:
      Object.prototype.hasOwnProperty.call(attrs, "disabled") ||
      (attrs["aria-disabled"] ?? "").toLowerCase() === "true",
    inert: Object.prototype.hasOwnProperty.call(attrs, "inert"),
    hasNativeDescendant: capturedHasNativeDescendant(capturedNode, signals.childrenByParentId),
    insideNative: capturedInsideNative(capturedNode, signals.capturedByBackendId),
  };
}

function inputStateFor(
  capturedNode: CapturedNode | undefined,
  value: string | undefined,
): VomNode["inputState"] {
  if (!capturedNode || !FORM_CONTROL_TAGS.has(normalizeTag(capturedNode.tag))) return undefined;
  if (capturedNode.formState) return capturedNode.formState;
  const formValue = capturedNode.formValue;
  if (formValue !== undefined) {
    if (formValue === "") return "empty";
    if (formValue === (capturedNode.formDefaultValue ?? "")) return "default";
    return "filled";
  }
  return value === undefined || value === "" ? "empty" : "filled";
}

/**
 * Name for a native form control. VOM models the *perceived* viewport
 * (spec §1): an empty field displays its placeholder, so when the field has
 * no value we prefer the placeholder over an accessible name that pages
 * frequently pollute by wrapping the `<input>` in a `<label>` that also
 * holds prefixes/buttons (e.g. xiaohongshu's "+86" / "获取验证码"). Filled
 * fields keep the accessible name and surface their value separately.
 */
function formControlName(
  captured: CapturedNode | undefined,
  axName: string | undefined,
  axSiblingName: string | undefined,
  signals: VomNodeDomSignals,
): string | undefined {
  const ariaLabel = cleanAttr(captured?.attrs["aria-label"]);
  const title = cleanAttr(captured?.attrs.title);
  const placeholder =
    cleanAttr(captured?.formPlaceholder) ?? cleanAttr(captured?.attrs.placeholder);
  const nearbyLabel = captured
    ? previousSiblingTextFor(captured, signals.childrenByParentId)
    : undefined;
  return ariaLabel ?? title ?? axName ?? axSiblingName ?? nearbyLabel ?? placeholder;
}

function vomNodeFromCaptured(
  capturedNode: CapturedNode,
  parentId: number | null,
  signals: VomNodeDomSignals,
): VomNode {
  const sensitive = isSensitive(capturedNode);
  const value = sensitive ? undefined : capturedNode.formValue;
  const tag = normalizeTag(capturedNode.tag);
  const node = applyCapturedSignals(
    {
      id: capturedNode.backendNodeId,
      parentId,
      tag,
      rect: capturedNode.rect,
      paintOrder: capturedNode.paintOrder,
      position: capturedNode.position || "static",
      pointerEvents: capturedNode.pointerEvents || "auto",
      modal: isModalSignal(undefined, capturedNode),
      sensitive,
      inputState: inputStateFor(capturedNode, value),
      ...(value !== undefined ? { value } : {}),
    },
    capturedNode,
    signals,
  );
  if (tag === "iframe") {
    node.role = "Iframe";
    const name = capturedIframeNameFor(capturedNode);
    if (name) node.name = name;
  }
  return node;
}

function axVomNode(
  axNode: CdpAxNode,
  capturedNode: CapturedNode | undefined,
  axById: Map<string, CdpAxNode>,
  signals: VomNodeDomSignals,
  axSignals: Map<string, AxNodeSignals>,
): VomNode {
  const role = axString(axNode.role);
  const capturedValue = capturedNode?.formValue;
  const sourceValue = capturedValue ?? axValue(axNode.value);
  const signalsForNode = axSignals.get(axNode.nodeId);
  const sensitive = isSensitive(capturedNode) || signalsForNode?.sensitive === true;
  const value = sensitive ? undefined : sourceValue;
  const inputState =
    inputStateFor(capturedNode, sourceValue) ??
    (sensitive && ["textbox", "searchbox"].includes(role?.toLowerCase() ?? "")
      ? sourceValue === undefined || sourceValue === ""
        ? "empty"
        : "filled"
      : undefined);
  let name = FORM_CONTROL_TAGS.has(normalizeTag(capturedNode?.tag))
    ? formControlName(capturedNode, axString(axNode.name), axSiblingLabel(axNode, axById), signals)
    : (axString(axNode.name) ?? signalsForNode?.aggregatedText);
  if (name && signalsForNode?.hasPopup) {
    name = signalsForNode.expanded ? `${name} [expanded]` : `${name} [has-submenu]`;
  }
  const node: VomNode = {
    id: axNode.backendDOMNodeId as number,
    parentId: nearestBackendParent(axNode, axById),
    tag: normalizeTag(capturedNode?.tag),
    rect: capturedNode?.rect ?? null,
    paintOrder: capturedNode?.paintOrder ?? 0,
    position: capturedNode?.position || "static",
    pointerEvents: capturedNode?.pointerEvents || "auto",
    modal: isModalSignal(axNode, capturedNode),
    sensitive,
    inputState,
  };
  if (role) node.role = role;
  if (name) node.name = name;
  if (value !== undefined) node.value = value;
  const enriched = applyCapturedSignals(node, capturedNode, signals);
  if (signalsForNode?.selected && !enriched.attrs?.["aria-selected"]) {
    enriched.attrs = { ...(enriched.attrs ?? {}), "aria-selected": "true" };
  }
  if (signalsForNode?.expanded && !enriched.attrs?.["aria-expanded"]) {
    enriched.attrs = { ...(enriched.attrs ?? {}), "aria-expanded": "true" };
  }
  if (signalsForNode?.controls && !enriched.attrs?.["aria-controls"]) {
    enriched.attrs = { ...(enriched.attrs ?? {}), "aria-controls": signalsForNode.controls };
  }
  return enriched;
}

function iframeSignals(iframeNodes: CapturedNode[]): VomNodeDomSignals {
  const capturedByBackendId = new Map<number, CapturedNode>();
  for (const node of iframeNodes) {
    capturedByBackendId.set(node.backendNodeId, node);
  }
  return {
    capturedByBackendId,
    childrenByParentId: buildCapturedChildren(iframeNodes),
  };
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

function buildConditionalSurfaces(nodes: VomNode[], captured: CapturedViewModel): CondSurface[] {
  const probes = captured.surfaceProbes ?? [];
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
  const exact = renderedById.get(triggerBackendNodeId);
  if (exact && isSurfaceAttachableNode(exact)) return exact;

  const domDescendant = nodes.find(
    (node) =>
      isSurfaceAttachableNode(node) &&
      (node.domParentId === triggerBackendNodeId ||
        node.domAncestorIds?.includes(triggerBackendNodeId) === true),
  );
  if (domDescendant) return domDescendant;

  const queue = [...(signals.childrenByParentId.get(triggerBackendNodeId) ?? [])];
  while (queue.length > 0) {
    const child = queue.shift() as CapturedNode;
    const rendered = renderedById.get(child.backendNodeId);
    if (rendered && isSurfaceAttachableNode(rendered)) return rendered;
    queue.push(...(signals.childrenByParentId.get(child.backendNodeId) ?? []));
  }

  let current = signals.capturedByBackendId.get(triggerBackendNodeId);
  while (current?.parentBackendNodeId !== null && current?.parentBackendNodeId !== undefined) {
    const parent = renderedById.get(current.parentBackendNodeId);
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
    const rect = node.rect ?? signals.capturedByBackendId.get(node.id)?.rect;
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

function axNodeInOverlaySubtree(
  axNode: CdpAxNode,
  axById: Map<string, CdpAxNode>,
  excludedBackendNodeIds: Set<number>,
): boolean {
  if (
    typeof axNode.backendDOMNodeId === "number" &&
    excludedBackendNodeIds.has(axNode.backendDOMNodeId)
  ) {
    return true;
  }
  return (
    findAxAncestor(axNode, axById, (parent) => {
      const parentBackendId = parent.backendDOMNodeId;
      return typeof parentBackendId === "number" && excludedBackendNodeIds.has(parentBackendId)
        ? true
        : undefined;
    }) === true
  );
}

export interface BuildVomSceneOptions {
  pageUrl?: string;
}

export type VomFrameDocument = CapturedFrameDocument<CdpAxNode>;

function externalHrefHost(
  href: string | undefined,
  pageUrl: string | undefined,
): string | undefined {
  if (!href || !pageUrl) return undefined;
  try {
    const page = new URL(pageUrl);
    const target = new URL(href, page);
    return target.origin !== page.origin ? target.hostname : undefined;
  } catch {
    return undefined;
  }
}

export function buildVomScene(
  axNodes: CdpAxNode[],
  captured: CapturedViewModel,
  options: BuildVomSceneOptions = {},
): VomScene {
  const signals = capturedOnlySignals(captured.nodes);
  const { capturedByBackendId } = signals;
  const axSignals = buildAxSignals(axNodes);

  const axById = new Map<string, CdpAxNode>();
  for (const node of axNodes) {
    axById.set(node.nodeId, node);
  }

  const excludedBackendNodeIds = captured.excludedBackendNodeIds;
  const seenBackendIds = new Set<number>();
  const nodes: VomNode[] = [];

  for (const axNode of axNodes) {
    if (axNode.ignored || typeof axNode.backendDOMNodeId !== "number") continue;
    if (axNodeInOverlaySubtree(axNode, axById, excludedBackendNodeIds)) continue;

    const capturedNode = capturedByBackendId.get(axNode.backendDOMNodeId);
    const role = axString(axNode.role);
    const vomNode = axVomNode(axNode, capturedNode, axById, signals, axSignals);

    // For link nodes, attach external hostname so the renderer can annotate it.
    // Relative hrefs and same-origin hrefs are omitted to avoid noise.
    if (role?.toLowerCase() === "link") {
      const hrefHost = externalHrefHost(capturedNode?.attrs.href, options.pageUrl);
      if (hrefHost) vomNode.href = hrefHost;
    }

    seenBackendIds.add(axNode.backendDOMNodeId);
    nodes.push(vomNode);
  }

  for (const capturedNode of captured.nodes) {
    if (seenBackendIds.has(capturedNode.backendNodeId)) continue;
    if (excludedBackendNodeIds.has(capturedNode.backendNodeId)) continue;
    seenBackendIds.add(capturedNode.backendNodeId);
    nodes.push(vomNodeFromCaptured(capturedNode, capturedNode.parentBackendNodeId, signals));
  }

  for (const [iframeBackendId, iframeNodes] of captured.iframeNodes) {
    const signals = iframeSignals(iframeNodes);
    for (const iframeNode of iframeNodes) {
      if (
        seenBackendIds.has(iframeNode.backendNodeId) ||
        excludedBackendNodeIds.has(iframeNode.backendNodeId) ||
        !isRenderableIframeControl(iframeNode) ||
        hasEquivalentIframeControl(nodes, iframeNode, iframeBackendId)
      ) {
        continue;
      }
      const role = iframeRoleFor(iframeNode);
      const name = iframeNameFor(iframeNode);
      if (!role || (!name && normalizeTag(iframeNode.tag) === "a")) continue;

      seenBackendIds.add(iframeNode.backendNodeId);
      const vomNode: VomNode = {
        ...vomNodeFromCaptured(iframeNode, iframeBackendId, signals),
        role,
      };
      if (name) vomNode.name = name;
      nodes.push(vomNode);
    }
  }

  const activeScopeBlocks = buildActiveScopeBlocks(nodes, signals);
  const surfaces = buildConditionalSurfaces(nodes, captured);
  return {
    viewport: captured.viewport,
    nodes,
    ...(surfaces.length > 0 ? { surfaces } : {}),
    ...(activeScopeBlocks.length > 0 ? { activeScopeBlocks } : {}),
  };
}

export function buildFrameVomScene(
  documents: VomFrameDocument[],
  captured: CapturedViewModel,
  options: BuildVomSceneOptions = {},
): VomScene {
  const documentByFrameId = new Map(documents.map((document) => [document.frameId, document]));
  const rootFrameId =
    captured.rootFrameId ?? documents.find((document) => !document.parentFrameId)?.frameId;
  const orderedFrameIds = [
    ...(rootFrameId ? [rootFrameId] : []),
    ...documents.map((document) => document.frameId),
  ].filter((frameId, index, all) => all.indexOf(frameId) === index);

  const localScenes = new Map<string, VomScene>();
  for (const frameId of orderedFrameIds) {
    const document = documentByFrameId.get(frameId);
    if (!document) continue;
    localScenes.set(
      frameId,
      buildVomScene(
        document.axNodes,
        {
          viewport: captured.viewport,
          nodes: document.domNodes,
          iframeNodes: new Map(),
          surfaceProbes: frameId === rootFrameId ? captured.surfaceProbes : [],
          excludedBackendNodeIds:
            frameId === rootFrameId ? captured.excludedBackendNodeIds : new Set(),
        },
        { pageUrl: document.url ?? options.pageUrl },
      ),
    );
  }

  const sceneIdByFrameAndBackend = new Map<string, number>();
  let nextSceneId = 1;
  for (const [frameId, scene] of localScenes) {
    for (const node of scene.nodes) {
      sceneIdByFrameAndBackend.set(`${frameId}:${node.id}`, nextSceneId);
      nextSceneId += 1;
    }
  }

  const nodes: VomNode[] = [];
  const surfaces: CondSurface[] = [];
  const activeScopeBlocks: ActiveScopeBlock[] = [];

  for (const [frameId, scene] of localScenes) {
    const document = documentByFrameId.get(frameId);
    const ownerBackendNodeId = document?.ownerBackendNodeId;
    const parentFrameId = document?.parentFrameId;
    const ownerSceneId =
      ownerBackendNodeId !== undefined && parentFrameId
        ? sceneIdByFrameAndBackend.get(`${parentFrameId}:${ownerBackendNodeId}`)
        : undefined;
    if (frameId !== rootFrameId && ownerSceneId === undefined) continue;

    const suppressedRoots = new Set(
      frameId === rootFrameId
        ? []
        : scene.nodes
            .filter(
              (node) =>
                node.parentId === null &&
                ["rootwebarea", "webarea"].includes(node.role?.toLowerCase() ?? ""),
            )
            .map((node) => node.id),
    );

    for (const node of scene.nodes) {
      if (suppressedRoots.has(node.id)) continue;
      const sceneNodeId = sceneIdByFrameAndBackend.get(`${frameId}:${node.id}`) as number;
      let parentId =
        node.parentId !== null
          ? sceneIdByFrameAndBackend.get(`${frameId}:${node.parentId}`)
          : ownerSceneId;
      if (node.parentId !== null && suppressedRoots.has(node.parentId)) parentId = ownerSceneId;
      const remapId = (id: number) => sceneIdByFrameAndBackend.get(`${frameId}:${id}`);
      nodes.push({
        ...node,
        id: sceneNodeId,
        backendNodeId: node.id,
        frameId,
        contextScopeId: document?.contextScopeId ?? frameId,
        parentId: parentId ?? null,
        ...(node.domParentId !== undefined
          ? { domParentId: node.domParentId === null ? null : (remapId(node.domParentId) ?? null) }
          : {}),
        ...(node.domAncestorIds
          ? { domAncestorIds: node.domAncestorIds.flatMap((id) => remapId(id) ?? []) }
          : {}),
      });
    }

    for (const surface of scene.surfaces ?? []) {
      const triggerId = sceneIdByFrameAndBackend.get(`${frameId}:${surface.triggerId}`);
      if (triggerId !== undefined) surfaces.push({ ...surface, triggerId });
    }
    for (const block of scene.activeScopeBlocks ?? []) {
      const triggerId = sceneIdByFrameAndBackend.get(`${frameId}:${block.triggerId}`);
      if (triggerId !== undefined) activeScopeBlocks.push({ ...block, triggerId });
    }
  }

  return {
    viewport: captured.viewport,
    nodes,
    ...(rootFrameId ? { rootFrameId } : {}),
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
    return await captureViewModel(cdp, tabId, {
      conditionalSurfaceProbe: options.conditionalSurfaceProbe ?? false,
      hoverProbeBypassOverlay: options.hoverProbeBypassOverlay,
      signal: options.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return fallbackCapturedViewModel(cdp, tabId, options.signal);
  }
}

export interface CaptureVomObservationOptions extends VomOptions {
  conditionalSurfaceProbe?: boolean;
  hoverProbeBypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
  signal?: AbortSignal;
}

/** Frame identity needed to click an `@eN` that lives in an iframe. */
export interface CaptureVomFrame {
  frameId: string;
  target: CdpTarget;
  parentFrameId?: string;
  ownerBackendNodeId?: number;
}

/** Geometry index for matching a recorded click to a captured node. */
export interface CaptureVomNode {
  frameId: string;
  backendNodeId: number;
  tag: string;
  rect: Rect | null;
}

/**
 * Record-safe observation: rendered VOM text plus the matching index.
 * Raw AX/DOM trees are not returned — they carry form values.
 */
export interface CaptureVomObservationResult {
  text: string;
  refs: RenderedRef[];
  truncated: boolean;
  rootFrameId: string;
  frames: CaptureVomFrame[];
  nodes: CaptureVomNode[];
  surfaceProbes?: CapturedSurfaceProbe[];
}

function recordSafeFrames(documents: CapturedFrameDocument<CdpAxNode>[]): CaptureVomFrame[] {
  return documents.map((document) => ({
    frameId: document.frameId,
    target: document.target,
    ...(document.parentFrameId ? { parentFrameId: document.parentFrameId } : {}),
    ...(document.ownerBackendNodeId !== undefined
      ? { ownerBackendNodeId: document.ownerBackendNodeId }
      : {}),
  }));
}

function recordSafeNodes(documents: CapturedFrameDocument<CdpAxNode>[]): CaptureVomNode[] {
  return documents.flatMap((document) =>
    document.domNodes.map((node) => ({
      frameId: document.frameId,
      backendNodeId: node.backendNodeId,
      tag: node.tag,
      rect: node.rect,
    })),
  );
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
  const scene =
    captured.rootFrameId && captured.frameNodes?.size
      ? buildFrameVomScene(documents, captured, { pageUrl: url })
      : buildVomScene(documents[0]?.axNodes ?? [], captured, { pageUrl: url });
  const rendered = renderVom(scene, {
    maxDepth: options.maxDepth,
    maxTokens: options.maxTokens,
    redactValues: options.redactValues,
    activeRegionPolicy: options.activeRegionPolicy,
  });
  throwIfAborted(options.signal, "observation");
  return {
    text: rendered.text,
    refs: rendered.refs,
    truncated: rendered.truncated,
    rootFrameId: captured.rootFrameId ?? documents[0]?.frameId ?? "root",
    frames: recordSafeFrames(documents),
    nodes: recordSafeNodes(documents),
    surfaceProbes: captured.surfaceProbes,
  };
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
  return handleVomObservation(manager, params, "observe", "transient_input", true, deps, signal);
}
