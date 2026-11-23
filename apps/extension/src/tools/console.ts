import { readTimeoutDetails } from "@/browser-driver/command-deadline";
import type { SessionManager } from "@/session-manager/manager";
import type { ConsoleParams, ConsoleResult, RpcError } from "@/transport/types";
import {
  type CdpRunner,
  type ChromeTabsApi,
  isRpcError,
  lookupSession,
  parseBufferedReadBounds,
  resolveTargetTab,
} from "./shared";

export interface ConsoleDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
}

export async function handleConsole(
  manager: SessionManager,
  params: ConsoleParams,
  deps: ConsoleDeps,
  signal?: AbortSignal,
): Promise<ConsoleResult | RpcError> {
  if (signal?.aborted) return { code: "cancelled", message: "console aborted" };
  const ctxOrErr = lookupSession(manager, params, "console");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const bounds = parseBufferedReadBounds(params);
  if (isRpcError(bounds)) return bounds;
  const target = await resolveTargetTab(manager, ctxOrErr, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  if (signal?.aborted) return { code: "cancelled", message: "console aborted" };
  if (!deps.cdp.ensureConsoleCapture || !deps.cdp.consoleEntriesSince) {
    return { code: "cdp_failed", message: "console capture requires CDP console support" };
  }

  try {
    deps.cdp.trackSessionTab?.(ctxOrErr.sessionId, target.tabId);
    await deps.cdp.ensureConsoleCapture(target.tabId, signal);
    if (signal?.aborted) return { code: "cancelled", message: "console aborted" };
    return deps.cdp.consoleEntriesSince(
      target.tabId,
      bounds.since,
      bounds.limit,
      bounds.maxTextChars,
      params.include_stack === true,
    );
  } catch (err) {
    if (signal?.aborted) return { code: "cancelled", message: "console aborted" };
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
      ...readTimeoutDetails(err),
    };
  }
}
