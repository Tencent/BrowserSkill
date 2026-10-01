import { isAgentControlledTab, type SessionManager } from "@/session-manager/manager";
import type { RequestFrame, RpcError } from "@/transport/types";
import { toolPolicy } from "./policy";
import {
  type CdpRunner,
  type ChromeTabsApi,
  cdpBlockedUrlReason,
  isRpcError,
  resolveCdpAccessibleTargetTab,
  resolveTargetTab,
} from "./shared";

/** Prepare only explicitly controlled targets, before page reads or readiness waits.
 * Resolve once and pin the request to that tab; UI activation is never targeting. */
export async function prepareBackgroundExecution(
  manager: SessionManager,
  request: RequestFrame,
  cdp: CdpRunner | undefined,
  tabs: ChromeTabsApi,
  signal: AbortSignal,
): Promise<RpcError | undefined> {
  const policy = toolPolicy(request.method);
  if (!cdp?.acquireBackgroundExecution || !policy || policy.background === "none") return;
  const params = request.params as { session_id?: string; tab_id?: number } | undefined;
  if (!params?.session_id) return;
  const ctx = manager.get(params.session_id);
  if (!ctx) return;
  const target = await (policy.background === "accessible"
    ? resolveCdpAccessibleTargetTab(manager, ctx, params.tab_id, tabs, request.method)
    : resolveTargetTab(manager, ctx, params.tab_id, tabs));
  if (isRpcError(target)) return target;
  request.params = { ...params, tab_id: target.tabId };
  // Navigation owns preparation: an inaccessible source document must still
  // be able to leave through browser navigation before CDP becomes available.
  if (policy.background === "navigation") return;
  if (!isAgentControlledTab(ctx, target.tabId) || target.windowId !== ctx.agentWindowId) return;
  // Other page tools cannot establish execution on browser-internal documents.
  if (cdpBlockedUrlReason(target.url)) return;
  if (signal.aborted) return { code: "cancelled", message: "Background execution setup cancelled" };
  try {
    await cdp.acquireBackgroundExecution(ctx.sessionId, target.tabId);
    if (manager.get(ctx.sessionId) !== ctx || !isAgentControlledTab(ctx, target.tabId)) {
      await cdp.releaseSessionTab?.(ctx.sessionId, target.tabId);
      return {
        code: "cancelled",
        message: "Target control ended during background execution setup",
      };
    }
    if (signal.aborted)
      return { code: "cancelled", message: "Background execution setup cancelled" };
  } catch (error) {
    return {
      code: "cdp_failed",
      message: `Could not establish background execution for tab ${target.tabId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
