// Tab-tool handlers. M6 wired `tool.tab_list`; M8 adds the rest of
// the tab namespace: `tab_create`, `tab_close`, `tab_select`,
// `tab_borrow`, `tab_return`. The dispatcher routes each method to a
// single exported handler below.

import {
  OVERLAY_AGENT_OVERLAY_RESET,
  type OverlayAgentOverlayResetMessage,
} from "@/lib/overlay-bridge";
import type { SessionContext, SessionManager } from "@/session-manager/manager";
import type { RpcError } from "@/transport/types";
import { rpcError } from "./errors";
import { isRpcError, lookupSession } from "./shared";

export type TabScope = "user" | "agent" | "all";

/**
 * Mirror of bsk-protocol `TabInfo` (see
 * crates/bsk-protocol/src/tools/tabs.rs).
 */
export interface TabInfo {
  tab_id: number;
  title?: string;
  url?: string;
  window_id?: number;
  active?: boolean;
  /**
   * Where the tab sits relative to the requesting session: tabs in any
   * window other than an Agent Window are `user`; tabs in this
   * session's own Agent Window are `agent`. Tabs in *other* sessions'
   * Agent Windows are filtered out entirely (cross-session isolation,
   * design §6).
   */
  scope?: "user" | "agent";
}

export interface TabListParams {
  session_id: string;
  scope?: TabScope;
}

export interface TabListResult {
  tabs: TabInfo[];
}

// --- M8 payload mirrors (bsk-protocol/src/tools/tabs.rs) ---

export interface TabCreateParams {
  session_id: string;
  url?: string;
  active?: boolean;
  index?: number;
}

export interface TabCreateResult {
  tab_id: number;
  window_id: number;
  url: string;
}

export interface TabCloseParams {
  session_id: string;
  tab_id: number;
}

export interface TabCloseResult {
  tab_id: number;
}

export interface TabSelectParams {
  session_id: string;
  tab_id: number;
}

export interface TabSelectResult {
  tab_id: number;
  window_id: number;
}

export interface TabBorrowParams {
  session_id: string;
  tab_id: number;
  /** M10 will wire a real inline confirmation; in M8 this is forwarded
   *  to the stub approver but otherwise ignored. */
  confirm?: boolean;
}

export interface TabBorrowResult {
  tab_id: number;
  original_window_id: number;
  original_index: number;
  agent_window_id: number;
}

export interface TabReturnParams {
  session_id: string;
  tab_id: number;
}

export interface TabReturnResult {
  tab_id: number;
  returned_to_window_id: number;
  returned_to_index: number;
  fallback?: boolean;
}

const TAB_SCOPES = new Set<TabScope>(["user", "agent", "all"]);

/** Default URL used when `tool.tab_create` is called with no `url`. */
export const NEW_TAB_DEFAULT_URL = "chrome://newtab/";

type CreatedChromeTab = chrome.tabs.Tab & { id: number };

/**
 * Subset of `chrome.tabs` we depend on. Kept on a thin interface so
 * unit tests can inject a fake without monkey-patching the global
 * `chrome` object.
 */
export interface ChromeTabsApi {
  query(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
}

export const chromeTabsApi: ChromeTabsApi = {
  query: (q) => chrome.tabs.query(q),
};

/**
 * Subset of `chrome.tabs` we use for tab management. Kept separate
 * from the M6 `ChromeTabsApi` so tests for create/close/select can
 * inject just the surface they care about.
 */
export interface TabMutationApi {
  create(props: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
  remove(tabId: number): Promise<void>;
  update(tabId: number, props: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>;
  get(tabId: number): Promise<chrome.tabs.Tab>;
  move(
    tabId: number,
    moveProps: chrome.tabs.MoveProperties,
  ): Promise<chrome.tabs.Tab | chrome.tabs.Tab[]>;
}

export const chromeTabMutationApi: TabMutationApi = {
  create: (p) => chrome.tabs.create(p),
  remove: (id) => chrome.tabs.remove(id),
  update: (id, p) => chrome.tabs.update(id, p),
  get: (id) => chrome.tabs.get(id),
  move: (id, p) => chrome.tabs.move(id, p),
};

/**
 * Subset of `chrome.windows` we use for tab_return's fallback path
 * (original window has been closed; pick another normal window or
 * create one). Kept thin for testability.
 */
export interface ChromeWindowsApi {
  get(windowId: number): Promise<chrome.windows.Window>;
  getLastFocused(filters?: chrome.windows.QueryOptions): Promise<chrome.windows.Window>;
  create(props: chrome.windows.CreateData): Promise<chrome.windows.Window | undefined>;
}

export const chromeWindowsApi: ChromeWindowsApi = {
  get: (id) => chrome.windows.get(id),
  getLastFocused: (filters) =>
    filters ? chrome.windows.getLastFocused(filters) : chrome.windows.getLastFocused(),
  create: (p) => chrome.windows.create(p),
};

export interface AgentOverlayResetApi {
  resetAgentOverlays(tabId: number, sessionId: string): Promise<void>;
}

export const chromeAgentOverlayResetApi: AgentOverlayResetApi = {
  async resetAgentOverlays(tabId, sessionId) {
    const message: OverlayAgentOverlayResetMessage = {
      type: OVERLAY_AGENT_OVERLAY_RESET,
      sessionId,
    };
    await chrome.tabs.sendMessage(tabId, message);
  },
};

// ---------------------------------------------------------------------------
// Inline confirmation stub (M8.2)
// ---------------------------------------------------------------------------

export interface BorrowConfirmationContext {
  sessionId: string;
  tabId: number;
  confirm?: boolean;
  signal?: AbortSignal;
}

/**
 * Hook that asks the user to approve a `tool.tab_borrow`. Production
 * wiring uses `requestBorrowConfirmation` (overlay on every borrow).
 * `autoApproveBorrow` remains for unit tests only.
 *
 * Returning `false` causes `tab_borrow` to reply with `cancelled`.
 */
export type BorrowConfirmationApprover = (ctx: BorrowConfirmationContext) => Promise<boolean>;

/** Test-only stub; production must use overlay-driven approver. */
export const autoApproveBorrow: BorrowConfirmationApprover = async () => true;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handler for `tool.tab_list` (M6.1). Returns a scoped, sorted list of
 * tabs the requesting session is allowed to see.
 */
export async function handleTabList(
  manager: SessionManager,
  params: TabListParams,
  api: ChromeTabsApi = chromeTabsApi,
): Promise<TabListResult | RpcError> {
  if (!params || typeof params.session_id !== "string" || params.session_id.length === 0) {
    return {
      code: "invalid_params",
      message: "tab_list requires session_id",
    };
  }
  const ctx = manager.get(params.session_id);
  if (!ctx) {
    return {
      code: "not_found",
      message: `session ${params.session_id} unknown`,
    };
  }
  const scope = params.scope ?? "all";
  if (!TAB_SCOPES.has(scope)) {
    return {
      code: "invalid_params",
      message: "tab_list scope must be one of: user, agent, all",
    };
  }

  // Other sessions' Agent Windows must stay invisible to this session
  // (design §6: cross-session isolation). Build a set up-front so the
  // per-tab classification is O(1).
  const otherAgentWindowIds = new Set<number>();
  for (const s of manager.list()) {
    if (s.sessionId !== params.session_id) {
      otherAgentWindowIds.add(s.agentWindowId);
    }
  }
  const myAgentWindowId = ctx.agentWindowId;

  const allTabs = await api.query({});
  const tabs: TabInfo[] = [];
  for (const t of allTabs) {
    if (typeof t.id !== "number") continue;
    const winId = typeof t.windowId === "number" ? t.windowId : -1;
    if (otherAgentWindowIds.has(winId)) continue;
    const tabScope: "user" | "agent" = winId === myAgentWindowId ? "agent" : "user";
    if (scope === "user" && tabScope !== "user") continue;
    if (scope === "agent" && tabScope !== "agent") continue;
    tabs.push({
      tab_id: t.id,
      title: t.title,
      url: t.url,
      window_id: winId >= 0 ? winId : undefined,
      active: t.active,
      scope: tabScope,
    });
  }
  return { tabs };
}

// ---------------------------------------------------------------------------
// Shared deps shape for the management handlers
// ---------------------------------------------------------------------------

export interface TabManagementDeps {
  tabs?: TabMutationApi;
  windows?: ChromeWindowsApi;
  /** Abort hook (M10 will wire the full chain). */
  signal?: AbortSignal;
  /** Borrow approver — defaults to auto-approve (M8 stub). */
  approveBorrow?: BorrowConfirmationApprover;
  /** Clears Agent-scoped overlays after a borrowed tab is returned. */
  agentOverlayReset?: AgentOverlayResetApi;
  /**
   * Reports whether `windowId` is any live session's Agent Window.
   * `tab_return`'s fallback window picker uses this to avoid moving a
   * returned borrowed tab into *another* session's Agent Window (Agent
   * Windows are created with `type: "normal"`, so they otherwise match
   * the `getLastFocused({ windowTypes: ["normal"] })` query). Production
   * callers derive this from the `SessionManager`; the `() => false`
   * default only preserves legacy behaviour for direct/test callers.
   */
  isAgentWindowId?: (windowId: number) => boolean;
}

function getTabsApi(deps: TabManagementDeps): TabMutationApi {
  return deps.tabs ?? chromeTabMutationApi;
}

function getWindowsApi(deps: TabManagementDeps): ChromeWindowsApi {
  return deps.windows ?? chromeWindowsApi;
}

function getIsAgentWindowId(deps: TabManagementDeps): (windowId: number) => boolean {
  return deps.isAgentWindowId ?? (() => false);
}

function getAgentOverlayResetApi(deps: TabManagementDeps): AgentOverlayResetApi {
  return deps.agentOverlayReset ?? chromeAgentOverlayResetApi;
}

function aborted(signal: AbortSignal | undefined, tool: string): RpcError | null {
  return signal?.aborted ? { code: "cancelled", message: `${tool} aborted` } : null;
}

function validatePositiveInt(name: string, value: unknown): RpcError | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return { code: "invalid_params", message: `${name} must be a positive integer` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// tool.tab_create helpers (M8.1)
// ---------------------------------------------------------------------------

/** Validate `TabCreateParams`; returns an `RpcError` on failure, `null` on success. */
function validateTabCreateParams(params: TabCreateParams): RpcError | null {
  if (params.url !== undefined && typeof params.url !== "string") {
    return { code: "invalid_params", message: "tab_create url must be a string" };
  }
  if (params.active !== undefined && typeof params.active !== "boolean") {
    return { code: "invalid_params", message: "tab_create active must be a boolean" };
  }
  if (params.index !== undefined) {
    if (!Number.isInteger(params.index) || params.index < 0) {
      return { code: "invalid_params", message: "tab_create index must be a non-negative integer" };
    }
  }
  return null;
}

/**
 * Build `chrome.tabs.CreateProperties` from the session context and
 * validated params, ensuring the tab opens in the Agent Window.
 */
function buildCreateProps(
  ctx: SessionContext,
  params: TabCreateParams,
): chrome.tabs.CreateProperties {
  const createProps: chrome.tabs.CreateProperties = {
    windowId: ctx.agentWindowId,
    url: params.url ?? NEW_TAB_DEFAULT_URL,
    active: params.active ?? true,
  };
  if (params.index !== undefined) createProps.index = params.index;
  return createProps;
}

/**
 * Create a tab and handle post-creation abort cleanup.
 * On abort the opened tab is immediately removed so it doesn't leak.
 * Returns the created tab on success, or an `RpcError` on failure.
 */
async function createTabAndCleanup(
  deps: TabManagementDeps,
  createProps: chrome.tabs.CreateProperties,
): Promise<CreatedChromeTab | RpcError> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await getTabsApi(deps).create(createProps);
  } catch (err) {
    return {
      code: "protocol_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (aborted(deps.signal, "tab_create")) {
    // We already opened the tab; close it on abort so we don't leak.
    if (typeof tab.id === "number") {
      try {
        await getTabsApi(deps).remove(tab.id);
      } catch (cleanupErr) {
        console.debug("[bsk tab_create] cleanup after abort failed", cleanupErr);
      }
    }
    return { code: "cancelled", message: "tab_create aborted" };
  }
  if (typeof tab.id !== "number") {
    return { code: "protocol_error", message: "chrome.tabs.create returned no tab id" };
  }
  return { ...tab, id: tab.id };
}

// ---------------------------------------------------------------------------
// tool.tab_create (M8.1)
// ---------------------------------------------------------------------------

/**
 * Open a fresh tab *inside* the requesting session's Agent Window.
 * The Agent Window scope is enforced by always passing
 * `windowId: ctx.agentWindowId` to `chrome.tabs.create` (design §6).
 */
export async function handleTabCreate(
  manager: SessionManager,
  params: TabCreateParams,
  deps: TabManagementDeps = {},
): Promise<TabCreateResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "tab_create");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const ab = aborted(deps.signal, "tab_create");
  if (ab) return ab;

  const paramErr = validateTabCreateParams(params);
  if (paramErr) return paramErr;

  const tab = await createTabAndCleanup(deps, buildCreateProps(ctx, params));
  if (isRpcError(tab)) return tab;

  return {
    tab_id: tab.id,
    window_id: ctx.agentWindowId,
    url: tab.url ?? tab.pendingUrl ?? "",
  };
}

// ---------------------------------------------------------------------------
// Shared sandbox guard for tab_close / tab_select (M8.1)
// ---------------------------------------------------------------------------

/**
 * Verify that `tabId` is either inside the session's own Agent Window
 * (the normal case) or is a tab the session has borrowed (sitting
 * inside the Agent Window after the move). Cross-session borrows from
 * other sessions are rejected. Other sessions' Agent Window tabs are
 * also rejected via `permission_denied`.
 *
 * Returns the resolved tab on success, otherwise an `RpcError` to
 * propagate verbatim.
 */
async function authoriseAgentTab(
  manager: SessionManager,
  ctx: SessionContext,
  tabId: number,
  api: TabMutationApi,
  toolName: string,
): Promise<chrome.tabs.Tab | RpcError> {
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
    return { code: "not_found", message: `tab ${tabId} not found` };
  }
  const otherBorrower = manager.findBorrowingSession(tabId, ctx.sessionId);
  if (otherBorrower) {
    return rpcError(
      "permission_denied",
      "borrow_conflict",
      `${toolName}: tab ${tabId} is borrowed by session ${otherBorrower}`,
    );
  }
  if (tab.windowId === ctx.agentWindowId) {
    return tab;
  }
  return rpcError(
    "permission_denied",
    "agent_window_scope",
    `${toolName}: tab ${tabId} is not in Agent Window ${ctx.agentWindowId}`,
  );
}

// ---------------------------------------------------------------------------
// tool.tab_close (M8.1)
// ---------------------------------------------------------------------------

export async function handleTabClose(
  manager: SessionManager,
  params: TabCloseParams,
  deps: TabManagementDeps = {},
): Promise<TabCloseResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "tab_close");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const bad = validatePositiveInt("tab_id", params.tab_id);
  if (bad) return bad;
  const ab = aborted(deps.signal, "tab_close");
  if (ab) return ab;

  // Borrowed tabs must be returned before being closed, otherwise the
  // user's original window loses the tab without warning.
  if (ctx.borrowedTabs.has(params.tab_id)) {
    return {
      code: "invalid_params",
      message: `tab_close: tab ${params.tab_id} is borrowed; call tab_return first`,
    };
  }

  const tabOrErr = await authoriseAgentTab(
    manager,
    ctx,
    params.tab_id,
    getTabsApi(deps),
    "tab_close",
  );
  if (isRpcError(tabOrErr)) return tabOrErr;
  if (aborted(deps.signal, "tab_close")) {
    return { code: "cancelled", message: "tab_close aborted" };
  }
  try {
    await getTabsApi(deps).remove(params.tab_id);
  } catch (err) {
    return {
      code: "protocol_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return { tab_id: params.tab_id };
}

// ---------------------------------------------------------------------------
// tool.tab_select (M8.1)
// ---------------------------------------------------------------------------

export async function handleTabSelect(
  manager: SessionManager,
  params: TabSelectParams,
  deps: TabManagementDeps = {},
): Promise<TabSelectResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "tab_select");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const bad = validatePositiveInt("tab_id", params.tab_id);
  if (bad) return bad;
  const ab = aborted(deps.signal, "tab_select");
  if (ab) return ab;

  const tabOrErr = await authoriseAgentTab(
    manager,
    ctx,
    params.tab_id,
    getTabsApi(deps),
    "tab_select",
  );
  if (isRpcError(tabOrErr)) return tabOrErr;
  if (aborted(deps.signal, "tab_select")) {
    return { code: "cancelled", message: "tab_select aborted" };
  }
  try {
    await getTabsApi(deps).update(params.tab_id, { active: true });
  } catch (err) {
    return {
      code: "protocol_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  // windowId stable across `update({active:true})`; reuse what
  // authoriseAgentTab already loaded so we don't issue a second `get`.
  const windowId = typeof tabOrErr.windowId === "number" ? tabOrErr.windowId : ctx.agentWindowId;
  return { tab_id: params.tab_id, window_id: windowId };
}

// ---------------------------------------------------------------------------
// tool.tab_borrow (M8.2)
// ---------------------------------------------------------------------------

/**
 * Payload for `executeBorrowCore`: everything the core borrow flow
 * needs that isn't derived from validation/reservation in the outer
 * handler.
 */
interface ExecuteBorrowCoreParams {
  manager: SessionManager;
  ctx: SessionContext;
  tabId: number;
  confirm: boolean | undefined;
  tabsApi: TabMutationApi;
  approveBorrow: BorrowConfirmationApprover;
  signal?: AbortSignal;
}

interface ExecuteBorrowCoreOk {
  originalWindowId: number;
  originalIndex: number;
}

/**
 * Fetch, validate, and check that a borrow target is eligible —
 * subsumes the fetch, existence-check, agent-window check, and
 * cross-session guard from `executeBorrowCore` so the orchestrator
 * stays at low cyclomatic complexity.
 *
 * Returns the verified tab on success, an `RpcError` on failure.
 */
async function validateBorrowTarget(
  tabsApi: TabMutationApi,
  manager: SessionManager,
  ctx: SessionContext,
  tabId: number,
): Promise<chrome.tabs.Tab | RpcError> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await tabsApi.get(tabId);
  } catch (err) {
    return {
      code: "not_found",
      message: err instanceof Error ? err.message : `tab ${tabId} not found`,
    };
  }
  if (typeof tab.id !== "number" || typeof tab.windowId !== "number") {
    return { code: "not_found", message: `tab ${tabId} not found` };
  }
  if (tab.windowId === ctx.agentWindowId) {
    return {
      code: "invalid_params",
      message: `tab_borrow: tab ${tabId} already lives in the Agent Window`,
    };
  }
  for (const s of manager.list()) {
    if (s.sessionId !== ctx.sessionId && s.agentWindowId === tab.windowId) {
      return rpcError(
        "permission_denied",
        "agent_window_scope",
        `tab_borrow: tab ${tabId} belongs to another session's Agent Window`,
      );
    }
  }
  return tab;
}

/**
 * Request user approval for a tab borrow. Returns `null` on success,
 * an `RpcError` when denied, errored, or aborted.
 */
async function requestBorrowApproval(
  approveBorrow: BorrowConfirmationApprover,
  ctx: SessionContext,
  tabId: number,
  confirm?: boolean,
  signal?: AbortSignal,
): Promise<RpcError | null> {
  let approved: boolean;
  try {
    approved = await approveBorrow({
      sessionId: ctx.sessionId,
      tabId,
      confirm,
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (err) {
    return {
      code: "cancelled",
      message: `tab_borrow confirmation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!approved) {
    return { code: "cancelled", message: "tab_borrow cancelled by user" };
  }
  if (aborted(signal, "tab_borrow")) {
    return { code: "cancelled", message: "tab_borrow aborted" };
  }
  return null;
}

/**
 * Move a tab into the Agent Window, with abort-aware rollback.
 * Returns `null` on success, an `RpcError` on failure.
 */
async function moveTabForBorrow(
  tabsApi: TabMutationApi,
  tabId: number,
  agentWindowId: number,
  originalWindowId: number,
  originalIndex: number,
  signal?: AbortSignal,
): Promise<RpcError | null> {
  try {
    await tabsApi.move(tabId, { windowId: agentWindowId, index: -1 });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: `tab_borrow: chrome.tabs.move failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (aborted(signal, "tab_borrow")) {
    try {
      await tabsApi.move(tabId, { windowId: originalWindowId, index: originalIndex });
    } catch (rollbackErr) {
      console.debug("[bsk tab_borrow] rollback move failed", rollbackErr);
    }
    return { code: "cancelled", message: "tab_borrow aborted" };
  }
  return null;
}

/**
 * Borrow happy path: validate target, request approval, move tab.
 * Returns the original position data so the caller can commit the
 * reservation, or an `RpcError` to propagate verbatim.
 */
async function executeBorrowCore(
  p: ExecuteBorrowCoreParams,
): Promise<ExecuteBorrowCoreOk | RpcError> {
  const tab = await validateBorrowTarget(p.tabsApi, p.manager, p.ctx, p.tabId);
  if (isRpcError(tab)) return tab;

  const originalWindowId = tab.windowId;
  const originalIndex = typeof tab.index === "number" ? tab.index : 0;

  const approvalErr = await requestBorrowApproval(
    p.approveBorrow,
    p.ctx,
    p.tabId,
    p.confirm,
    p.signal,
  );
  if (approvalErr) return approvalErr;

  const moveErr = await moveTabForBorrow(
    p.tabsApi,
    p.tabId,
    p.ctx.agentWindowId,
    originalWindowId,
    originalIndex,
    p.signal,
  );
  if (moveErr) return moveErr;

  // Best-effort activation — failure is non-fatal.
  try {
    await p.tabsApi.update(p.tabId, { active: true });
  } catch (err) {
    console.debug("[bsk tab_borrow] activate after move failed", err);
  }

  return { originalWindowId, originalIndex };
}

export async function handleTabBorrow(
  manager: SessionManager,
  params: TabBorrowParams,
  deps: TabManagementDeps = {},
): Promise<TabBorrowResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "tab_borrow");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const bad = validatePositiveInt("tab_id", params.tab_id);
  if (bad) return bad;
  if (aborted(deps.signal, "tab_borrow")) {
    return { code: "cancelled", message: "tab_borrow aborted" };
  }
  if (ctx.borrowedTabs.has(params.tab_id)) {
    return {
      code: "invalid_params",
      message: `tab_borrow: tab ${params.tab_id} is already borrowed by this session`,
    };
  }
  if (params.confirm !== undefined && typeof params.confirm !== "boolean") {
    return { code: "invalid_params", message: "tab_borrow confirm must be a boolean" };
  }

  const reservation = manager.tryReserveBorrow(params.tab_id, ctx.sessionId);
  if ("borrowedBy" in reservation) {
    return rpcError(
      "permission_denied",
      "borrow_conflict",
      `tab_borrow: tab ${params.tab_id} is already borrowed by session ${reservation.borrowedBy}`,
    );
  }

  const tabsApi = getTabsApi(deps);
  const approve = deps.approveBorrow ?? autoApproveBorrow;
  let committed = false;
  try {
    const coreResult = await executeBorrowCore({
      manager,
      ctx,
      tabId: params.tab_id,
      confirm: params.confirm,
      tabsApi,
      approveBorrow: approve,
      signal: deps.signal,
    });
    if (isRpcError(coreResult)) return coreResult;

    try {
      reservation.commit({
        tabId: params.tab_id,
        originalWindowId: coreResult.originalWindowId,
        originalIndex: coreResult.originalIndex,
      });
      committed = true;
    } catch (err) {
      return {
        code: "protocol_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      tab_id: params.tab_id,
      original_window_id: coreResult.originalWindowId,
      original_index: coreResult.originalIndex,
      agent_window_id: ctx.agentWindowId,
    };
  } finally {
    if (!committed) reservation.release();
  }
}

// ---------------------------------------------------------------------------
// tool.tab_return (M8.3)
// ---------------------------------------------------------------------------

export interface ReturnOutcome {
  tabId: number;
  toWindowId: number;
  toIndex: number;
  fallback: boolean;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function chooseFallbackWindow(
  ctx: SessionContext,
  windowsApi: ChromeWindowsApi,
  isAgentWindowId: (windowId: number) => boolean,
): Promise<{ windowId: number; index: number } | RpcError> {
  let lastFocusedError: unknown;
  try {
    const last = await windowsApi.getLastFocused({ windowTypes: ["normal"] });
    const lastId = typeof last?.id === "number" ? last.id : null;
    // Never relocate a user tab into *any* session's Agent Window: this
    // session's is excluded explicitly, and other sessions' are excluded
    // via `isAgentWindowId` (Agent Windows are `type: "normal"`, so they
    // otherwise survive the `windowTypes: ["normal"]` filter). Parking a
    // returned tab in another session's Agent Window would let that
    // session write to it and, worse, see it destroyed when that session
    // stops and closes its window.
    if (lastId !== null && lastId !== ctx.agentWindowId && !isAgentWindowId(lastId)) {
      return { windowId: lastId, index: -1 };
    }
  } catch (err) {
    lastFocusedError = err;
  }

  try {
    const created = await windowsApi.create({
      url: NEW_TAB_DEFAULT_URL,
      focused: false,
    });
    if (typeof created?.id !== "number") {
      return {
        code: "protocol_error",
        message: "tab_return: failed to create fallback window",
      };
    }
    return { windowId: created.id, index: 0 };
  } catch (err) {
    const suffix = lastFocusedError
      ? ` (after getLastFocused failed: ${describeError(lastFocusedError)})`
      : "";
    return {
      code: "protocol_error",
      message: `tab_return: fallback window creation failed: ${describeError(err)}${suffix}`,
    };
  }
}

function resetAgentOverlaysInReturnedTab(
  ctx: SessionContext,
  tabId: number,
  deps: TabManagementDeps,
): void {
  void getAgentOverlayResetApi(deps)
    .resetAgentOverlays(tabId, ctx.sessionId)
    .catch((err) => {
      console.debug("[bsk tab_return] agent overlay reset failed", err);
    });
}

/**
 * Move a single borrowed tab back to its original window (or a
 * fallback normal window when the original is gone). Used both by
 * `tool.tab_return` and by `tool.session_stop`'s auto-cleanup path.
 *
 * The caller is responsible for `ctx.borrowedTabs.delete(tabId)` on
 * success — that way `session_stop` can choose between deleting the
 * entry vs leaving it for retry.
 */
export async function returnBorrowedTab(
  ctx: SessionContext,
  tabId: number,
  deps: TabManagementDeps,
): Promise<ReturnOutcome | RpcError> {
  const entry = ctx.borrowedTabs.get(tabId);
  if (!entry) {
    return {
      code: "not_found",
      message: `tab ${tabId} is not borrowed by session ${ctx.sessionId}`,
    };
  }
  const tabsApi = getTabsApi(deps);
  const windowsApi = getWindowsApi(deps);
  const isAgentWindowId = getIsAgentWindowId(deps);

  let targetWindowId = entry.originalWindowId;
  let targetIndex = entry.originalIndex;
  let fallback = false;

  // Check the original window is still around.
  let originalAlive = true;
  try {
    await windowsApi.get(entry.originalWindowId);
  } catch (err) {
    console.debug("[bsk tab_return] original window gone, falling back", err);
    originalAlive = false;
  }
  if (!originalAlive) {
    fallback = true;
    const target = await chooseFallbackWindow(ctx, windowsApi, isAgentWindowId);
    if ("code" in target) return target;
    targetWindowId = target.windowId;
    targetIndex = target.index;
  }

  try {
    const moved = await tabsApi.move(tabId, {
      windowId: targetWindowId,
      index: targetIndex,
    });
    const movedTab = Array.isArray(moved) ? moved[0] : moved;
    const finalIndex = typeof movedTab?.index === "number" ? movedTab.index : targetIndex;
    resetAgentOverlaysInReturnedTab(ctx, tabId, deps);
    return {
      tabId,
      toWindowId: targetWindowId,
      toIndex: finalIndex,
      fallback,
    };
  } catch (err) {
    if (!fallback) {
      const target = await chooseFallbackWindow(ctx, windowsApi, isAgentWindowId);
      if ("code" in target) {
        return {
          code: "cdp_failed",
          message: `tab_return: chrome.tabs.move failed: ${describeError(err)}; fallback failed: ${target.message}`,
        };
      }
      try {
        const moved = await tabsApi.move(tabId, {
          windowId: target.windowId,
          index: target.index,
        });
        const movedTab = Array.isArray(moved) ? moved[0] : moved;
        const finalIndex = typeof movedTab?.index === "number" ? movedTab.index : target.index;
        resetAgentOverlaysInReturnedTab(ctx, tabId, deps);
        return {
          tabId,
          toWindowId: target.windowId,
          toIndex: finalIndex,
          fallback: true,
        };
      } catch (fallbackErr) {
        return {
          code: "cdp_failed",
          message: `tab_return: chrome.tabs.move failed: ${describeError(err)}; fallback move failed: ${describeError(fallbackErr)}`,
        };
      }
    }
    return {
      code: "cdp_failed",
      message: `tab_return: chrome.tabs.move failed: ${describeError(err)}`,
    };
  }
}

export async function handleTabReturn(
  manager: SessionManager,
  params: TabReturnParams,
  deps: TabManagementDeps = {},
): Promise<TabReturnResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "tab_return");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const bad = validatePositiveInt("tab_id", params.tab_id);
  if (bad) return bad;
  if (aborted(deps.signal, "tab_return")) {
    return { code: "cancelled", message: "tab_return aborted" };
  }
  if (!ctx.borrowedTabs.has(params.tab_id)) {
    return {
      code: "not_found",
      message: `tab_return: tab ${params.tab_id} is not borrowed by this session`,
    };
  }
  const outcome = await returnBorrowedTab(ctx, params.tab_id, {
    ...deps,
    isAgentWindowId:
      deps.isAgentWindowId ?? ((windowId) => manager.findByWindowId(windowId) !== null),
  });
  if (isRpcError(outcome)) return outcome;
  ctx.borrowedTabs.delete(params.tab_id);
  const result: TabReturnResult = {
    tab_id: outcome.tabId,
    returned_to_window_id: outcome.toWindowId,
    returned_to_index: outcome.toIndex,
  };
  if (outcome.fallback) result.fallback = true;
  return result;
}
