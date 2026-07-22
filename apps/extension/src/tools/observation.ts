// Read-only observation handlers — `tool.screenshot`, `tool.snapshot`,
// and `tool.get_html` (design §7). Each handler resolves the target
// tab (defaulting to the Agent Window's active tab when omitted) and
// returns a payload that mirrors the bsk-protocol Rust structs.

import { renderVom, type VomNode, type VomScene } from "@browser-skill/vom";
import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import type {
  GetHtmlParams,
  GetHtmlResult,
  RpcError,
  ScreenshotParams,
  ScreenshotResult,
  SnapshotParams,
  SnapshotResult,
} from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import { nodeBoundingRect, scrollNodeIntoView } from "./element-geometry";
import { rpcError } from "./errors";
import {
  type ChromeTabsApi,
  isRpcError,
  lookupSession,
  resolveTargetTab,
  type CdpRunner as SharedCdpRunner,
  normaliseRef as sharedNormaliseRef,
} from "./shared";
import { resolveSnapshotRef } from "./snapshot-ref";
import {
  type CapturedNode,
  type CapturedViewModel,
  captureViewModel,
  collectOverlayExcludedBackendIds,
} from "./vom/capture";

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
}

function defaultScreenshotDeps(): ScreenshotDeps {
  return {
    cdp: new ChromiumCdp(),
    tabsApi: chromeTabsCaptureApi,
    captureApi: chromeTabsCaptureApi,
  };
}

async function captureElementScreenshot(
  cdp: SharedCdpRunner,
  tabId: number,
  backendNodeId: number,
): Promise<{ image_base64: string; width: number; height: number } | RpcError> {
  const scrollErr = await scrollNodeIntoView(cdp, tabId, backendNodeId);
  if (scrollErr) return scrollErr;

  const rectOrErr = await nodeBoundingRect(cdp, tabId, backendNodeId);
  if (isRpcError(rectOrErr)) return rectOrErr;

  try {
    const shot = await cdp.send<{ data?: string }>(tabId, "Page.captureScreenshot", {
      format: "png",
      clip: {
        x: rectOrErr.x,
        y: rectOrErr.y,
        width: rectOrErr.width,
        height: rectOrErr.height,
        scale: 1,
      },
    });
    const image_base64 = shot.data ?? "";
    if (!image_base64) {
      return { code: "cdp_failed", message: "Page.captureScreenshot returned no data" };
    }
    const dims = parsePngDimensions(image_base64) ?? {
      width: Math.round(rectOrErr.width),
      height: Math.round(rectOrErr.height),
    };
    return { image_base64, width: dims.width, height: dims.height };
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleScreenshot(
  manager: SessionManager,
  params: ScreenshotParams,
  deps: ScreenshotDeps = defaultScreenshotDeps(),
): Promise<ScreenshotResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "screenshot");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
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
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    const captured = await captureElementScreenshot(deps.cdp, target.tabId, node.backendNodeId);
    if (isRpcError(captured)) return captured;
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

  try {
    const dataUrl = await deps.captureApi.captureVisibleTab(target.windowId, { format: "png" });
    const image_base64 = stripDataUrlPrefix(dataUrl);
    const dims = parsePngDimensions(image_base64) ?? { width: 0, height: 0 };
    return withShotDialogs({
      image_base64,
      width: dims.width,
      height: dims.height,
      format: "png",
      tab_id: target.tabId,
    });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
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
  parentId?: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: { type: string; value?: string };
  name?: { type: string; value?: string };
  description?: { value?: string };
  value?: { value?: string | number | boolean };
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
  return (attrs.type ?? "").toLowerCase() === "password";
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
  if (!node.rect) return false;
  if (node.pointerEvents === "none") return false;
  if ((node.attrs.type ?? "").toLowerCase() === "hidden") return false;

  const name = iframeNameFor(node);
  return tag !== "a" || name !== undefined;
}

function capturedIframeNameFor(node: CapturedNode): string | undefined {
  const ariaLabel = node.attrs["aria-label"]?.replace(/\s+/g, " ").trim();
  if (ariaLabel) return ariaLabel;

  const title = node.attrs.title?.replace(/\s+/g, " ").trim();
  if (title) return title;

  const id = node.attrs.id?.replace(/\s+/g, " ").trim();
  return id ? id : undefined;
}

const FORM_CONTROL_TAGS = new Set(["input", "textarea", "select"]);

/** AX roles we treat as non-semantic wrappers eligible for clickable promotion. */
const PROMOTABLE_ROLES = new Set(["", "generic", "none", "presentation"]);

/**
 * Interactive AX roles. Mirrors `packages/vom`'s INTERACTIVE_ROLES — kept
 * local so the package stays a pure projection (design §2). Used to tell an
 * atomic custom control (icon button / toggle) apart from a clickable
 * *container* (card/row) that wraps real controls we must not collapse.
 */
const INTERACTIVE_ROLES_LC = new Set([
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

function cleanAttr(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
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
  axValue: string | undefined,
): string | undefined {
  const placeholder = cleanAttr(captured?.attrs.placeholder);
  const ariaLabel = cleanAttr(captured?.attrs["aria-label"]);
  const title = cleanAttr(captured?.attrs.title);
  const hasValue = axValue !== undefined && axValue !== "";
  if (!hasValue && placeholder) return placeholder;
  return axName ?? ariaLabel ?? placeholder ?? title;
}

/** Strip a sprite/file reference like `#close` or `icon-close.svg` to `close`. */
function iconKeyword(href: string | undefined): string | undefined {
  if (!href) return undefined;
  let s = href.trim();
  const hash = s.lastIndexOf("#");
  if (hash >= 0) s = s.slice(hash + 1);
  s = s.split("/").pop() ?? s;
  s = s.replace(/\.(svg|png|webp|gif|jpe?g)$/i, "");
  s = s.replace(/^(icons?[-_]?|ic[-_]|svg[-_])/i, "");
  s = s.replace(/[-_]+/g, " ").trim();
  return s ? s : undefined;
}

/** First icon-derived label found in a clickable element's captured subtree. */
function iconHint(
  root: CapturedNode,
  capChildren: Map<number, CapturedNode[]>,
): string | undefined {
  const queue: Array<{ node: CapturedNode; depth: number }> = (
    capChildren.get(root.backendNodeId) ?? []
  ).map((node) => ({ node, depth: 1 }));
  while (queue.length > 0) {
    const { node, depth } = queue.shift() as { node: CapturedNode; depth: number };
    const labelled =
      cleanAttr(node.attrs["aria-label"]) ??
      cleanAttr(node.attrs.title) ??
      cleanAttr(node.attrs.alt);
    if (labelled) return labelled;
    if (node.tag === "use") {
      const kw = iconKeyword(node.attrs["xlink:href"] ?? node.attrs.href);
      if (kw) return kw;
    }
    if (depth < 4) {
      for (const child of capChildren.get(node.backendNodeId) ?? []) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return undefined;
}

/** Best-effort name for a promoted clickable: own labels → text → icon. */
function clickableName(
  captured: CapturedNode,
  capChildren: Map<number, CapturedNode[]>,
): string | undefined {
  return (
    cleanAttr(captured.attrs["aria-label"]) ??
    cleanAttr(captured.attrs.title) ??
    cleanAttr(captured.textContent) ??
    iconHint(captured, capChildren)
  );
}

function rectCoverage(
  rect: { x: number; y: number; w: number; h: number } | null,
  vw: number,
  vh: number,
): number {
  if (!rect || vw <= 0 || vh <= 0) return 0;
  const ix = Math.max(0, Math.min(rect.x + rect.w, vw) - Math.max(rect.x, 0));
  const iy = Math.max(0, Math.min(rect.y + rect.h, vh) - Math.max(rect.y, 0));
  const overlap = ix * iy;
  return overlap <= 0 ? 0 : Math.min(1, overlap / (vw * vh));
}

/**
 * Promote custom clickable controls the AX tree drops as `generic`/unnamed
 * (icon buttons, CSS checkboxes, "send code" spans …) to a referenceable
 * `button` so the snapshot can act on them. Guards keep noise out: must be
 * `cursor: pointer`, have a box, not be a viewport-scale overlay, and not
 * wrap any real interactive descendant (so clickable cards or rows stay
 * containers and their inner controls keep their own refs).
 */
function promoteClickableControls(
  nodes: VomNode[],
  capturedById: Map<number, CapturedNode>,
  capturedNodes: CapturedNode[],
  vw: number,
  vh: number,
): void {
  // Snapshot original roles + parent/child links before any mutation so the
  // guards below are immune to roles we flip to "button" mid-pass.
  const originalRoleLc = new Map<number, string>(
    nodes.map((node) => [node.id, (node.role ?? "").toLowerCase()]),
  );
  const parentOf = new Map<number, number | null>(nodes.map((node) => [node.id, node.parentId]));
  const semChildren = new Map<number, VomNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = semChildren.get(node.parentId);
    if (siblings) siblings.push(node);
    else semChildren.set(node.parentId, [node]);
  }

  const capChildren = new Map<number, CapturedNode[]>();
  for (const cap of capturedNodes) {
    if (cap.parentBackendNodeId === null) continue;
    const siblings = capChildren.get(cap.parentBackendNodeId);
    if (siblings) siblings.push(cap);
    else capChildren.set(cap.parentBackendNodeId, [cap]);
  }

  // A custom clickable: a non-semantic, pointer-cursor box small enough to be
  // a control rather than a viewport-scale overlay.
  const candidates = new Set<number>();
  for (const node of nodes) {
    if (!PROMOTABLE_ROLES.has(originalRoleLc.get(node.id) ?? "")) continue;
    const cap = capturedById.get(node.id);
    if (!cap || cap.cursor !== "pointer" || !node.rect) continue;
    if (rectCoverage(node.rect, vw, vh) > 0.5) continue;
    candidates.add(node.id);
  }

  // wraps a *real* interactive control → it's a clickable container, leave it
  // (and its inner refs) alone.
  const wrapsInteractive = (id: number): boolean => {
    const stack = [...(semChildren.get(id) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop() as VomNode;
      if (INTERACTIVE_ROLES_LC.has(originalRoleLc.get(node.id) ?? "")) return true;
      const kids = semChildren.get(node.id);
      if (kids) stack.push(...kids);
    }
    return false;
  };

  // only the outermost clickable in a nested chain becomes the control, so an
  // icon inside a custom button doesn't render as a button-in-a-button.
  const hasCandidateAncestor = (id: number): boolean => {
    let parent = parentOf.get(id) ?? null;
    while (parent !== null) {
      if (candidates.has(parent)) return true;
      parent = parentOf.get(parent) ?? null;
    }
    return false;
  };

  for (const node of nodes) {
    if (!candidates.has(node.id)) continue;
    if (wrapsInteractive(node.id) || hasCandidateAncestor(node.id)) continue;
    const cap = capturedById.get(node.id);
    if (!cap) continue;

    node.role = "button";
    if (!cleanAttr(node.name)) {
      const derived = clickableName(cap, capChildren);
      if (derived) node.name = derived;
    }
  }
}

function vomNodeFromCaptured(capturedNode: CapturedNode, parentId: number | null): VomNode {
  const sensitive = isSensitive(capturedNode);
  const value = sensitive ? (capturedNode.attrs.value ?? "") : undefined;
  const tag = normalizeTag(capturedNode.tag);
  const node: VomNode = {
    id: capturedNode.backendNodeId,
    parentId,
    tag,
    rect: capturedNode.rect,
    paintOrder: capturedNode.paintOrder,
    position: capturedNode.position || "static",
    pointerEvents: capturedNode.pointerEvents || "auto",
    modal: isModalSignal(undefined, capturedNode),
    sensitive,
    ...(value !== undefined ? { value } : {}),
  };
  if (tag === "iframe") {
    node.role = "Iframe";
    const name = capturedIframeNameFor(capturedNode);
    if (name) node.name = name;
  }
  return node;
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

export function buildVomScene(axNodes: CdpAxNode[], captured: CapturedViewModel): VomScene {
  const capturedByBackendId = new Map<number, CapturedNode>();
  for (const node of captured.nodes) {
    capturedByBackendId.set(node.backendNodeId, node);
  }

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
    const value = axValue(axNode.value);
    const name = FORM_CONTROL_TAGS.has(normalizeTag(capturedNode?.tag))
      ? formControlName(capturedNode, axString(axNode.name), value)
      : axString(axNode.name);
    const vomNode: VomNode = {
      id: axNode.backendDOMNodeId,
      parentId: nearestBackendParent(axNode, axById),
      tag: normalizeTag(capturedNode?.tag),
      rect: capturedNode?.rect ?? null,
      paintOrder: capturedNode?.paintOrder ?? 0,
      position: capturedNode?.position || "static",
      pointerEvents: capturedNode?.pointerEvents || "auto",
      modal: isModalSignal(axNode, capturedNode),
      sensitive: isSensitive(capturedNode),
    };
    if (role) vomNode.role = role;
    if (name) vomNode.name = name;
    if (value !== undefined) vomNode.value = value;

    // For link nodes, attach external hostname so the renderer can annotate it.
    // Relative hrefs and same-origin hrefs are omitted to avoid noise.
    if (role === "link" && capturedNode?.attrs.href) {
      try {
        const target = new URL(capturedNode.attrs.href, window.location.href);
        if (target.origin !== window.location.origin) {
          vomNode.href = target.hostname;
        }
      } catch {
        // Relative or non-URL href (e.g. javascript:) — skip
      }
    }

    seenBackendIds.add(axNode.backendDOMNodeId);
    nodes.push(vomNode);
  }

  for (const capturedNode of captured.nodes) {
    if (seenBackendIds.has(capturedNode.backendNodeId)) continue;
    if (excludedBackendNodeIds.has(capturedNode.backendNodeId)) continue;
    seenBackendIds.add(capturedNode.backendNodeId);
    nodes.push(vomNodeFromCaptured(capturedNode, capturedNode.parentBackendNodeId));
  }

  for (const [iframeBackendId, iframeNodes] of captured.iframeNodes) {
    for (const iframeNode of iframeNodes) {
      if (
        seenBackendIds.has(iframeNode.backendNodeId) ||
        excludedBackendNodeIds.has(iframeNode.backendNodeId) ||
        !isRenderableIframeControl(iframeNode)
      ) {
        continue;
      }
      const role = iframeRoleFor(iframeNode);
      const name = iframeNameFor(iframeNode);
      if (!role || (!name && normalizeTag(iframeNode.tag) === "a")) continue;

      seenBackendIds.add(iframeNode.backendNodeId);
      const vomNode: VomNode = {
        ...vomNodeFromCaptured(iframeNode, iframeBackendId),
        role,
      };
      if (name) vomNode.name = name;
      nodes.push(vomNode);
    }
  }

  promoteClickableControls(
    nodes,
    capturedByBackendId,
    captured.nodes,
    captured.viewport.width,
    captured.viewport.height,
  );

  return { viewport: captured.viewport, nodes };
}

export interface SnapshotDeps {
  cdp: CdpRunner;
  tabsApi: {
    get(tabId: number): Promise<chrome.tabs.Tab>;
    query(q: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  };
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
): Promise<GetHtmlResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "get_html");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  const maxBytes =
    params.max_bytes && params.max_bytes > 0 ? params.max_bytes : DEFAULT_GET_HTML_MAX_BYTES;

  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    let html: string;
    if (params.ref) {
      const resolved = resolveSnapshotRef(ctx, params.ref, target.tabId);
      if (isRpcError(resolved)) return resolved;
      const resp = await deps.cdp.send<{ outerHTML?: string }>(target.tabId, "DOM.getOuterHTML", {
        backendNodeId: resolved.backendNodeId,
      });
      html = resp.outerHTML ?? "";
    } else {
      const doc = await deps.cdp.send<{ root?: { nodeId?: number } }>(
        target.tabId,
        "DOM.getDocument",
        { depth: 0 },
      );
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
): Promise<CapturedViewModel> {
  let viewport = { width: 0, height: 0 };
  try {
    const metrics = await cdp.send<LayoutMetricsViewportReply>(tabId, "Page.getLayoutMetrics", {});
    const vpSrc = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
    viewport = {
      width: vpSrc.clientWidth ?? 0,
      height: vpSrc.clientHeight ?? 0,
    };
  } catch {
    // viewport stays zero-sized
  }
  const excludedBackendNodeIds = await collectOverlayExcludedBackendIds(cdp, tabId);
  return { ...emptyCapturedViewModel(viewport), excludedBackendNodeIds };
}

async function captureForVom(cdp: CdpRunner, tabId: number): Promise<CapturedViewModel> {
  try {
    return await captureViewModel(cdp, tabId);
  } catch {
    return fallbackCapturedViewModel(cdp, tabId);
  }
}

export async function handleSnapshot(
  manager: SessionManager,
  params: SnapshotParams,
  deps: SnapshotDeps = getDefaultDeps(),
): Promise<SnapshotResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "snapshot");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);

  try {
    deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
    await deps.cdp.send<unknown>(target.tabId, "Accessibility.enable", {});
    const result = await deps.cdp.send<{ nodes: CdpAxNode[] }>(
      target.tabId,
      "Accessibility.getFullAXTree",
      {},
    );
    const axNodes = result.nodes ?? [];
    const captured = await captureForVom(deps.cdp, target.tabId);
    const scene = buildVomScene(axNodes, captured);
    const rendered = renderVom(scene, { maxDepth: params.max_depth, maxTokens: params.max_tokens });
    ctx.refStore.replace(
      rendered.refs.map(
        (r) => [r.ref, { backendNodeId: r.backendNodeId, tabId: target.tabId }] as const,
      ),
    );
    return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
      text: rendered.text,
      ref_count: rendered.refs.length,
      tab_id: target.tabId,
      truncated: rendered.truncated,
    });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
