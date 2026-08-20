// Shared helpers used by every `tool.*` handler — target-tab
// resolution, session lookup, RpcError detection, and the minimal
// CDP-runner shape every handler depends on.
//
// Lives in its own module so M7+ navigation / interaction code reuses
// exactly the same sandbox + visibility rules as the M6 observation
// handlers (review parity).

import type { CdpDebuggee, DialogCursor } from "@/browser-driver/chromium-cdp";
import type { CdpFrameGraph, CdpTarget } from "@/browser-driver/frame-graph";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import { normaliseRef } from "@/session-manager/ref-store";
import type { ConsoleResult, JavaScriptDialogInfo, RpcError } from "@/transport/types";
import { rpcError } from "./errors";

const DEFAULT_BUFFERED_READ_LIMIT = 50;
const MAX_BUFFERED_READ_LIMIT = 200;
const DEFAULT_MAX_TEXT_CHARS = 1000;
const MAX_TEXT_CHARS = 4096;

/**
 * Subset of `chrome.tabs` we depend on across tool handlers. Kept on
 * a thin interface so vitest can inject a fake without monkey-patching
 * the global `chrome` object.
 */
export interface ChromeTabsApi {
  get(tabId: number): Promise<chrome.tabs.Tab>;
  query(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
}

export const chromeTabsApi: ChromeTabsApi = {
  get: (tabId) => chrome.tabs.get(tabId),
  query: (q) => chrome.tabs.query(q),
};

export interface ResolvedTargetTab {
  tabId: number;
  windowId: number;
  active: boolean;
  url?: string;
}

export type { DialogCursor };

/**
 * Minimal CDP surface every tool handler needs. Backed by
 * `ChromiumCdp` in production; tests inject a fake.
 *
 * `trackSessionTab` is optional so test doubles need not implement it
 * — production `ChromiumCdp` always supplies it for ref-aware session
 * teardown.
 */
export interface CdpRunner {
  send<T = unknown>(tabId: number, method: string, params?: object): Promise<T>;
  sendToTarget?<T = unknown>(target: CdpTarget, method: string, params?: object): Promise<T>;
  detach?(tabId: number): Promise<void>;
  getFrameGraph?(tabId: number): Promise<CdpFrameGraph>;
  ensureAttachedToUrl?(tabId: number, expectedUrl: string | undefined): Promise<void>;
  trackSessionTab?(sessionId: string, tabId: number): void;
  onEvent?(handler: (source: CdpDebuggee, method: string, params: unknown) => void): {
    dispose(): void;
  };
  dialogCursor?(tabId: number): DialogCursor;
  dialogsSince?(tabId: number, cursor: DialogCursor): JavaScriptDialogInfo[];
  ensureConsoleCapture?(tabId: number): Promise<void>;
  consoleEntriesSince?(
    tabId: number,
    since: number | undefined,
    limit: number,
    maxTextChars: number,
    includeStack: boolean,
  ): ConsoleResult;
}

export function sendToCdpTarget<T = unknown>(
  cdp: CdpRunner,
  target: CdpTarget,
  method: string,
  params?: object,
): Promise<T> {
  if (target.sessionId && cdp.sendToTarget) {
    return cdp.sendToTarget<T>(target, method, params);
  }
  return cdp.send<T>(target.tabId, method, params);
}

export function cdpRunnerForTarget(cdp: CdpRunner, target: CdpTarget): CdpRunner {
  return {
    send: <T = unknown>(_tabId: number, method: string, params?: object) =>
      sendToCdpTarget<T>(cdp, target, method, params),
  };
}

export interface BufferedReadBounds {
  since: number | undefined;
  limit: number;
  maxTextChars: number;
}

/** Parse the common cursor and output bounds used by buffered read tools. */
export function parseBufferedReadBounds(params: {
  since?: number;
  limit?: number;
  max_text_chars?: number;
}): BufferedReadBounds | RpcError {
  const since = params.since;
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
    return { code: "invalid_params", message: "since must be a non-negative integer" };
  }
  const limit = boundedOptionalInteger(
    params.limit,
    DEFAULT_BUFFERED_READ_LIMIT,
    MAX_BUFFERED_READ_LIMIT,
    "limit",
  );
  if (isRpcError(limit)) return limit;
  const maxTextChars = boundedOptionalInteger(
    params.max_text_chars,
    DEFAULT_MAX_TEXT_CHARS,
    MAX_TEXT_CHARS,
    "max_text_chars",
  );
  if (isRpcError(maxTextChars)) return maxTextChars;
  return { since, limit, maxTextChars };
}

function boundedOptionalInteger(
  value: number | undefined,
  defaultValue: number,
  maxValue: number,
  field: string,
): number | RpcError {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { code: "invalid_params", message: `${field} must be a positive integer` };
  }
  return Math.min(value, maxValue);
}

/**
 * Look up an active session by its `session_id` param, returning the
 * matching `SessionContext` or a structured `RpcError`. Tool handlers
 * call this first so every code path emits identical error messages.
 */
export function lookupSession(
  manager: SessionManager,
  params: { session_id?: string },
  toolName: string,
): SessionContext | RpcError {
  if (!params?.session_id || typeof params.session_id !== "string") {
    return {
      code: "invalid_params",
      message: `${toolName} requires session_id`,
    };
  }
  const ctx = manager.get(params.session_id);
  if (!ctx) {
    return {
      code: "not_found",
      message: `session ${params.session_id} unknown`,
    };
  }
  return ctx;
}

/**
 * Resolve the target tab for a tool call. Explicit `tabId` values are
 * checked against the session visibility rules: user tabs and the
 * current session's Agent Window are visible, other sessions' Agent
 * Windows are not.
 *
 * Returns the resolved `{tabId, windowId, active}` triple, or an
 * `RpcError` the caller propagates verbatim.
 */
export async function resolveTargetTab(
  manager: SessionManager,
  ctx: SessionContext,
  tabId: number | undefined,
  api: ChromeTabsApi,
): Promise<ResolvedTargetTab | RpcError> {
  if (tabId !== undefined) {
    if (!Number.isSafeInteger(tabId) || tabId <= 0) {
      return {
        code: "invalid_params",
        message: "tab_id must be a positive integer",
      };
    }
    let tab: chrome.tabs.Tab;
    try {
      tab = await api.get(tabId);
    } catch (err) {
      return {
        code: "not_found",
        message: err instanceof Error ? err.message : `tab ${tabId} not found`,
      };
    }
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number") {
      return {
        code: "not_found",
        message: `tab ${tabId} not found`,
      };
    }
    const owner = manager.findByWindowId(tab.windowId);
    if (owner && owner.sessionId !== ctx.sessionId) {
      return {
        code: "not_found",
        message: `tab ${tabId} not found in session scope`,
      };
    }
    return { tabId: tab.id, windowId: tab.windowId, active: tab.active === true, url: tab.url };
  }
  const tabs = await api.query({ active: true, windowId: ctx.agentWindowId });
  const first = tabs.find((t) => typeof t.id === "number");
  if (!first || typeof first.id !== "number") {
    return {
      code: "not_found",
      message: `no active tab in Agent Window ${ctx.agentWindowId}`,
    };
  }
  return {
    tabId: first.id,
    windowId: ctx.agentWindowId,
    active: first.active === true,
    url: first.url,
  };
}

export function isRpcError(v: unknown): v is RpcError {
  return (
    typeof v === "object" &&
    v !== null &&
    "code" in v &&
    "message" in v &&
    typeof (v as RpcError).code === "string"
  );
}

/** Re-export so M6/M7 tools keep a stable import path. */
export { normaliseRef };

export type ToolEffect = "passive_read" | "transient_input" | "browser_mutation";

const CDP_BLOCKED_PROTOCOLS = new Set([
  "chrome:",
  "chrome-extension:",
  "devtools:",
  "edge:",
  "brave:",
  "vivaldi:",
  "opera:",
]);

export function cdpBlockedUrlReason(url: string | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (CDP_BLOCKED_PROTOCOLS.has(parsed.protocol)) return parsed.protocol;
  if (parsed.protocol === "about:" && parsed.pathname !== "blank") return "about:";
  return null;
}

/**
 * Page CDP tools cannot inspect browser/extension internal pages. Check this
 * at the tool boundary so Chrome's low-level "Cannot access..." errors do not
 * leak as ambiguous page-read failures.
 */
export function enforceCdpAccessibleTarget(
  target: ResolvedTargetTab,
  toolName: string,
): RpcError | null {
  const reason = cdpBlockedUrlReason(target.url);
  if (!reason) return null;
  return rpcError(
    "permission_denied",
    "restricted_tab_url",
    `${toolName} cannot access tab ${target.tabId} because its URL is ${target.url}; navigate the Agent Window to a web page first`,
  );
}

function resolvedTargetFromChromeTab(
  tab: chrome.tabs.Tab,
  fallbackWindowId: number,
): ResolvedTargetTab | null {
  if (typeof tab.id !== "number") return null;
  return {
    tabId: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : fallbackWindowId,
    active: tab.active === true,
    url: tab.url,
  };
}

/**
 * Resolve a target for page CDP reads. Explicit tab_ids stay exact and are
 * rejected when browser security blocks the URL. For default targeting, skip a
 * restricted Agent Window active tab if another CDP-accessible tab exists in
 * the same Agent Window.
 */
export async function resolveCdpAccessibleTargetTab(
  manager: SessionManager,
  ctx: SessionContext,
  tabId: number | undefined,
  api: ChromeTabsApi,
  toolName: string,
): Promise<ResolvedTargetTab | RpcError> {
  const target = await resolveTargetTab(manager, ctx, tabId, api);
  if (isRpcError(target)) return target;

  const restricted = enforceCdpAccessibleTarget(target, toolName);
  if (!restricted) return target;
  if (tabId !== undefined) return restricted;

  const tabs = await api.query({ windowId: ctx.agentWindowId });
  for (const tab of tabs) {
    const candidate = resolvedTargetFromChromeTab(tab, ctx.agentWindowId);
    if (!candidate) continue;
    if (!enforceCdpAccessibleTarget(candidate, toolName)) return candidate;
  }
  return restricted;
}

/**
 * Sandbox guard: M7 write tools (click / fill / press / navigate*)
 * MUST refuse to touch a tab outside the session's Agent Window
 * (§6 — borrowing brings the tab into the Agent Window first).
 *
 * Returns an `RpcError` when the resolved target sits in a user window;
 * `null` on success.
 */
export function enforceAgentWindow(
  ctx: SessionContext,
  target: { tabId: number; windowId: number },
  toolName: string,
): RpcError | null {
  if (target.windowId !== ctx.agentWindowId) {
    return rpcError(
      "permission_denied",
      "agent_window_scope",
      `${toolName} can only act on tabs inside the Agent Window (tab ${target.tabId} is in window ${target.windowId}; borrow it first)`,
    );
  }
  return null;
}

/**
 * Unified target-scope policy by tool effect. Passive reads may inspect user
 * tabs; any tool that dispatches page input must stay inside the Agent Window.
 */
export function enforceToolTargetScope(
  ctx: SessionContext,
  target: { tabId: number; windowId: number },
  effect: ToolEffect,
  toolName: string,
): RpcError | null {
  if (effect === "passive_read") return null;
  return enforceAgentWindow(ctx, target, toolName);
}
