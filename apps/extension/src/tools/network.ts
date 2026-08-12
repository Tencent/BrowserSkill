import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import type { NetworkParams, NetworkResult, RpcError } from "@/transport/types";
import {
  type ChromeTabsApi,
  chromeTabsApi,
  isRpcError,
  lookupSession,
  parseBufferedReadBounds,
  resolveTargetTab,
} from "./shared";

export interface NetworkCdpRunner {
  trackSessionTab?(sessionId: string, tabId: number): void;
  ensureNetworkCapture(tabId: number): Promise<void>;
  networkEntriesSince(
    tabId: number,
    since: number | undefined,
    limit: number,
    maxTextChars: number,
  ): NetworkResult;
}

export interface NetworkDeps {
  cdp: NetworkCdpRunner;
  tabsApi: ChromeTabsApi;
}

function defaultNetworkDeps(): NetworkDeps {
  return {
    cdp: new ChromiumCdp(),
    tabsApi: chromeTabsApi,
  };
}

export async function handleNetwork(
  manager: SessionManager,
  params: NetworkParams,
  deps: NetworkDeps = defaultNetworkDeps(),
): Promise<NetworkResult | RpcError> {
  const ctxOrErr = lookupSession(manager, params, "network");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const bounds = parseBufferedReadBounds(params);
  if (isRpcError(bounds)) return bounds;
  const target = await resolveTargetTab(manager, ctxOrErr, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;

  try {
    deps.cdp.trackSessionTab?.(ctxOrErr.sessionId, target.tabId);
    await deps.cdp.ensureNetworkCapture(target.tabId);
    return deps.cdp.networkEntriesSince(
      target.tabId,
      bounds.since,
      bounds.limit,
      bounds.maxTextChars,
    );
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
