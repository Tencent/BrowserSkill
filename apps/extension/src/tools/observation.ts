// Read-only observation handlers — `tool.screenshot`, `tool.snapshot`,
// and `tool.get_html` (design §7). Each handler resolves the target
// tab (defaulting to the Agent Window's active tab when omitted) and
// returns a payload that mirrors the bsk-protocol Rust structs.

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

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "textbox",
  "combobox",
  "listbox",
  "option",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "searchbox",
  "slider",
  "spinbutton",
  "scrollbar",
  "treeitem",
]);

const STRUCTURAL_ROLES = new Set([
  "heading",
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "form",
  "search",
  "region",
  "article",
  "list",
  "listitem",
  "table",
  "row",
  "cell",
  "rowheader",
  "columnheader",
  "dialog",
  "alertdialog",
  "img",
  "figure",
  "section",
  "RootWebArea",
  "WebArea",
]);

const SKIP_ROLES = new Set(["generic", "none", "presentation", "InlineTextBox"]);

/**
 * Decide whether an aria node should appear in the rendered tree.
 * Exported for unit tests.
 */
export function shouldRender(node: CdpAxNode): boolean {
  if (node.ignored) return false;
  const role = node.role?.value ?? "";
  if (!role) return false;
  if (SKIP_ROLES.has(role)) return false;
  const name = node.name?.value ?? "";
  if (INTERACTIVE_ROLES.has(role)) return true;
  if (STRUCTURAL_ROLES.has(role)) return true;
  return name.trim().length > 0;
}

/**
 * Approximate-token estimator (~4 chars / token, GPT-style). Good
 * enough for `max_tokens` budgets.
 */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

interface RenderedSnapshot {
  text: string;
  refs: Array<{ ref: string; backendNodeId: number }>;
  truncated: boolean;
}

/**
 * Convert an `Accessibility.getFullAXTree` result into the
 * `@e<N>`-tagged indented text plus the ref → backendNodeId map for
 * the session's RefStore. Exported for unit tests.
 */
export function renderAxTree(
  nodes: CdpAxNode[],
  opts: { maxDepth?: number; maxTokens?: number } = {},
): RenderedSnapshot {
  const byId = new Map<string, CdpAxNode>();
  const childParent = new Map<string, string>();
  for (const n of nodes) {
    byId.set(n.nodeId, n);
  }
  // Detect roots: nodes whose `parentId` is undefined OR not in the
  // returned set. CDP sometimes ships orphan branches.
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      childParent.set(n.nodeId, n.parentId);
    }
  }
  const roots = nodes.filter((n) => !childParent.has(n.nodeId));

  const lines: string[] = [];
  const refs: Array<{ ref: string; backendNodeId: number }> = [];
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const maxTokens = opts.maxTokens ?? Number.POSITIVE_INFINITY;
  let truncated = false;
  let tokenTruncated = false;
  let tokenBudget = 0;
  let nextRef = 1;

  const walk = (node: CdpAxNode, depth: number, ancestorRendered: boolean): void => {
    if (tokenTruncated) return;
    const renderThis = shouldRender(node) && depth <= maxDepth;
    if (renderThis) {
      const role = node.role?.value ?? "";
      const name = node.name?.value ?? "";
      let line = `${"  ".repeat(Math.min(depth, 32))}`;
      let ref: string | null = null;
      if (typeof node.backendDOMNodeId === "number") {
        ref = `e${nextRef}`;
        line += `@${ref} `;
      }
      line += role;
      if (name.length > 0) {
        const cleaned = name.replace(/\s+/g, " ").trim();
        line += ` ${JSON.stringify(cleaned)}`;
      }
      const value = node.value?.value;
      if (typeof value === "string" && value.length > 0 && value !== name) {
        line += ` =${JSON.stringify(value.slice(0, 200))}`;
      }
      const lineTokens = estimateTokens(line) + 1; // +1 for newline
      if (tokenBudget + lineTokens > maxTokens) {
        truncated = true;
        tokenTruncated = true;
        return;
      }
      tokenBudget += lineTokens;
      if (ref && typeof node.backendDOMNodeId === "number") {
        refs.push({ ref, backendNodeId: node.backendDOMNodeId });
        nextRef += 1;
      }
      lines.push(line);
    }
    const nextDepth = renderThis ? depth + 1 : ancestorRendered ? depth : depth;
    if (depth + 1 > maxDepth && renderThis && (node.childIds?.length ?? 0) > 0) {
      // Children would exceed depth cap — note truncation flag without
      // bailing on siblings elsewhere in the tree.
      truncated = true;
      return;
    }
    for (const cid of node.childIds ?? []) {
      const child = byId.get(cid);
      if (!child) continue;
      if (tokenTruncated) return;
      walk(child, nextDepth, ancestorRendered || renderThis);
    }
  };

  for (const r of roots) {
    walk(r, 0, false);
    if (tokenTruncated) break;
  }

  return {
    text: lines.join("\n"),
    refs,
    truncated,
  };
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
    const rendered = renderAxTree(result.nodes ?? [], {
      maxDepth: params.max_depth,
      maxTokens: params.max_tokens,
    });
    // Reset the session-scoped ref-store for this fresh snapshot.
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
