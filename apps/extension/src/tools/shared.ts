// Shared helpers used by every `tool.*` handler — target-tab
// resolution, session lookup, RpcError detection, and the minimal
// CDP-runner shape every handler depends on.
//
// Lives in its own module so M7+ navigation / interaction code reuses
// exactly the same sandbox + visibility rules as the M6 observation
// handlers (review parity).

import type { DialogCursor } from "@/browser-driver/chromium-cdp";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import { normaliseRef } from "@/session-manager/ref-store";
import type { ConsoleResult, JavaScriptDialogInfo, RpcError } from "@/transport/types";
import { rpcError } from "./errors";

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
  trackSessionTab?(sessionId: string, tabId: number): void;
  onEvent?(handler: (source: chrome.debugger.Debuggee, method: string, params: unknown) => void): {
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
): Promise<{ tabId: number; windowId: number; active: boolean } | RpcError> {
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
    return { tabId: tab.id, windowId: tab.windowId, active: tab.active === true };
  }
  const tabs = await api.query({ active: true, windowId: ctx.agentWindowId });
  const first = tabs.find((t) => typeof t.id === "number");
  if (!first || typeof first.id !== "number") {
    return {
      code: "not_found",
      message: `no active tab in Agent Window ${ctx.agentWindowId}`,
    };
  }
  return { tabId: first.id, windowId: ctx.agentWindowId, active: first.active === true };
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
