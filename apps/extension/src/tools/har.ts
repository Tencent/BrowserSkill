import type { SessionManager } from "@/session-manager/manager";
import type {
  HarStartParams,
  HarStartResult,
  HarStatusParams,
  HarStatusResult,
  HarStopParams,
  HarStopResult,
  RpcError,
} from "@/transport/types";
import {
  type ChromeTabsApi,
  chromeTabsApi,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

export interface HarCdpRunner {
  startHar(sessionId: string, tabId: number, params: HarStartParams): Promise<HarStartResult>;
  harStatus(sessionId: string): HarStatusResult;
  stopHar(sessionId: string, settleTimeoutMs?: number): Promise<HarStopResult>;
}

export interface HarDeps {
  cdp: HarCdpRunner;
  tabsApi: ChromeTabsApi;
}

export async function handleHarStart(
  manager: SessionManager,
  params: HarStartParams,
  deps: HarDeps,
): Promise<HarStartResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "har start");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  if (deps.cdp.harStatus(ctxOrErr.sessionId).active) {
    return {
      code: "invalid_params",
      message: `HAR recording already active for session ${ctxOrErr.sessionId}`,
    };
  }
  const target = await resolveTargetTab(manager, ctxOrErr, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  if (target.windowId !== ctxOrErr.agentWindowId || ctxOrErr.borrowedTabs.has(target.tabId)) {
    return {
      code: "permission_denied",
      message: "HAR recording is limited to dedicated Agent Window tabs",
      data: { reason: "agent_window_scope" },
    };
  }
  try {
    return await deps.cdp.startHar(ctxOrErr.sessionId, target.tabId, params);
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function handleHarStatus(
  manager: SessionManager,
  params: HarStatusParams,
  deps: Pick<HarDeps, "cdp">,
): HarStatusResult | RpcError {
  const ctxOrErr = lookupSession(manager, params, "har status");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  return deps.cdp.harStatus(ctxOrErr.sessionId);
}

export async function handleHarStop(
  manager: SessionManager,
  params: HarStopParams,
  deps: Pick<HarDeps, "cdp">,
): Promise<HarStopResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "har stop");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  if (!deps.cdp.harStatus(ctxOrErr.sessionId).active) {
    return {
      code: "not_found",
      message: `no active HAR recording for session ${ctxOrErr.sessionId}`,
    };
  }
  try {
    return await deps.cdp.stopHar(ctxOrErr.sessionId, params.settle_timeout_ms);
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export const defaultHarTabsApi = chromeTabsApi;
