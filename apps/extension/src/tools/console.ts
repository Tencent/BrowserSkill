import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import type { ConsoleParams, ConsoleResult, RpcError } from "@/transport/types";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  isRpcError,
  lookupSession,
  parseBufferedReadBounds,
  resolveTargetTab,
} from "./shared";

export interface ConsoleDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
}

function defaultConsoleDeps(): ConsoleDeps {
  return {
    cdp: new ChromiumCdp(),
    tabsApi: chromeTabsApi,
  };
}

export async function handleConsole(
  manager: SessionManager,
  params: ConsoleParams,
  deps: ConsoleDeps = defaultConsoleDeps(),
): Promise<ConsoleResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "console");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const bounds = parseBufferedReadBounds(params);
  if (isRpcError(bounds)) return bounds;
  const target = await resolveTargetTab(manager, ctxOrErr, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  if (!deps.cdp.ensureConsoleCapture || !deps.cdp.consoleEntriesSince) {
    return { code: "cdp_failed", message: "console capture requires CDP console support" };
  }

  try {
    await deps.cdp.ensureConsoleCapture(target.tabId);
    deps.cdp.trackSessionTab?.(ctxOrErr.sessionId, target.tabId);
    return deps.cdp.consoleEntriesSince(
      target.tabId,
      bounds.since,
      bounds.limit,
      bounds.maxTextChars,
      params.include_stack === true,
    );
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
