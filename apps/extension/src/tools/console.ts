import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import type { ConsoleParams, ConsoleResult, RpcError } from "@/transport/types";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

const DEFAULT_CONSOLE_LIMIT = 50;
const MAX_CONSOLE_LIMIT = 200;
const DEFAULT_MAX_TEXT_CHARS = 1000;
const MAX_TEXT_CHARS = 4096;

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
  const bounds = parseConsoleBounds(params);
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
      bounds.includeStack,
    );
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseConsoleBounds(params: ConsoleParams):
  | {
      since: number | undefined;
      limit: number;
      maxTextChars: number;
      includeStack: boolean;
    }
  | RpcError {
  const since = params.since;
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) {
    return { code: "invalid_params", message: "since must be a non-negative integer" };
  }
  const limit = boundedOptionalInteger(
    params.limit,
    DEFAULT_CONSOLE_LIMIT,
    MAX_CONSOLE_LIMIT,
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
  return {
    since,
    limit,
    maxTextChars,
    includeStack: params.include_stack === true,
  };
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
