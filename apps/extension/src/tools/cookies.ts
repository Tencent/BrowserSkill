// `tool.cookies` — export cookies (including httpOnly) for the site
// open in the target Agent Window tab, via CDP `Network.getCookies`.
//
// Red-line (design §6, same sandbox as `tool.evaluate`): the target tab
// resolves through `resolveTargetTab` + `enforceAgentWindow`, so only
// sites the human has explicitly handed to the agent can be exported —
// never arbitrary user tabs. The query is scoped to the tab's own URL,
// which keeps the export from widening into a browser-wide token-exfil
// window.
//
// Errors: RPC-level (`not_found / invalid_params / permission_denied /
// cdp_failed`) are returned as `RpcError`.

import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import type { CookieEntry, CookiesParams, CookiesResult, RpcError } from "@/transport/types";
import {
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

export interface CookiesDeps {
  send: (tabId: number, method: string, params?: object) => Promise<unknown>;
  tabsApi: ChromeTabsApi;
  signal?: AbortSignal;
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: number | string;
}

interface NetworkGetCookiesReply {
  cookies?: CdpCookie[];
}

const SAME_SITE: Record<number | string, string | undefined> = {
  0: undefined,
  1: "NoRestrictions",
  2: "Lax",
  3: "Strict",
};

let defaultDeps: CookiesDeps | null = null;

function getDefaultDeps(): CookiesDeps {
  if (!defaultDeps) {
    const cdp = new ChromiumCdp();
    defaultDeps = {
      send: (tabId, method, params) => cdp.send(tabId, method, params),
      tabsApi: chromeTabsApi,
    };
  }
  return defaultDeps;
}

function toWireCookie(c: CdpCookie): CookieEntry {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: typeof c.expires === "number" ? c.expires : undefined,
    http_only: c.httpOnly === true,
    secure: c.secure === true,
    same_site: SAME_SITE[c.sameSite ?? 0] ?? (typeof c.sameSite === "string" ? c.sameSite : undefined),
  };
}

export async function handleCookies(
  manager: SessionManager,
  params: CookiesParams,
  deps: CookiesDeps = getDefaultDeps(),
): Promise<CookiesResult | RpcError> {
  if (!params || typeof params.session_id !== "string" || params.session_id.length === 0) {
    return { code: "invalid_params", message: "cookies requires a session_id" };
  }
  const ctxOrErr = lookupSession(manager, params, "cookies");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  if (deps.signal?.aborted) {
    return { code: "cancelled", message: "cookies aborted" };
  }
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "cookies");
  if (denied) return denied;

  const url = target.url ?? "";
  if (!/^https?:/i.test(url)) {
    return { code: "invalid_params", message: `cookies requires an http(s) tab url, got ${url}` };
  }

  try {
    // Scoped to the tab's own URL — the export cannot be widened.
    const reply = (await deps.send(target.tabId, "Network.getCookies", {
      urls: [url],
    })) as NetworkGetCookiesReply | undefined;
    const cookies = (reply?.cookies ?? []).map(toWireCookie);
    return { tab_id: target.tabId, url, cookies };
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
