// `tool.evaluate` — runs an arbitrary JS expression in the target tab
// via CDP `Runtime.evaluate`. Design §4 / §7 + plan M9.1.
//
// Sandbox: the call resolves the target tab the same way write tools
// do (`resolveTargetTab` + `enforceAgentWindow`), so borrowed tabs
// already moved into the Agent Window are allowed but tabs in a user
// window are refused with `permission_denied`. The check matches the
// design-doc red-line that `evaluate` must not be useful as a
// token-exfil window against arbitrary user tabs (design §6).
//
// Errors:
// * RPC-level (`not_found / invalid_params / permission_denied /
//   cancelled / cdp_failed`) — returned as `RpcError`.
// * JS exceptions thrown by the evaluated expression — returned as
//   `EvaluateResult { ok: false, error: { text, line?, column? } }`
//   so the agent can read the throw text in-band (M9 review intent).

import { ChromiumCdp } from "@/browser-driver/chromium-cdp";
import type { SessionManager } from "@/session-manager/manager";
import type { EvaluateError, EvaluateParams, EvaluateResult, RpcError } from "@/transport/types";
import { attachDialogs, markDialogCursor } from "./dialogs";
import {
  type CdpRunner,
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

export interface EvaluateDeps {
  cdp: CdpRunner;
  tabsApi: ChromeTabsApi;
  /** Abort hook (full chain wired in M10.2). */
  signal?: AbortSignal;
}

interface CdpRemoteObject {
  type?: string;
  subtype?: string;
  className?: string;
  objectId?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface CdpExceptionDetails {
  text?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: CdpRemoteObject;
}

interface RuntimeEvaluateReply {
  result?: CdpRemoteObject;
  exceptionDetails?: CdpExceptionDetails;
}

let defaultDeps: { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } | null = null;
function getDefaultDeps(): { cdp: ChromiumCdp; tabsApi: ChromeTabsApi } {
  if (!defaultDeps) {
    defaultDeps = { cdp: new ChromiumCdp(), tabsApi: chromeTabsApi };
  }
  return defaultDeps;
}

function abortedError(signal: AbortSignal | undefined): RpcError | null {
  if (signal?.aborted) {
    return { code: "cancelled", message: "evaluate aborted" };
  }
  return null;
}

/**
 * Pull a human-readable error text out of CDP's exception payload.
 * Prefers `exception.description` (the full stack) and falls back to
 * `exceptionDetails.text` (the short header). Both are best-effort —
 * Chrome sometimes ships an empty string when the throw value is
 * `null` / `undefined` / a non-Error primitive.
 */
function extractErrorText(details: CdpExceptionDetails): string {
  const desc = details.exception?.description?.trim();
  if (desc) return desc;
  const text = details.text?.trim();
  if (text) return text;
  if (details.exception?.value !== undefined) {
    return `Uncaught ${String(details.exception.value)}`;
  }
  return "Uncaught (unknown error)";
}

function buildEvaluateError(details: CdpExceptionDetails): EvaluateError {
  return {
    text: extractErrorText(details),
    line: typeof details.lineNumber === "number" ? details.lineNumber + 1 : undefined,
    column: typeof details.columnNumber === "number" ? details.columnNumber : undefined,
  };
}

/**
 * Map a CDP `RemoteObject` to a JSON-safe value for the wire result.
 *
 * * `unserializableValue` — `Infinity`, `-Infinity`, `NaN`, BigInt
 *   literals — round-trips as a string so the JSON payload stays
 *   self-describing.
 * * `value` is whatever CDP put back when `returnByValue=true`.
 * * Plain `undefined` (e.g. `void 0`, statements) returns `null` so
 *   the wire shape stays "missing means missing".
 */
function extractValue(remote: CdpRemoteObject | undefined): unknown {
  if (!remote) return null;
  if (remote.unserializableValue !== undefined) {
    return remote.unserializableValue;
  }
  if ("value" in remote) {
    return remote.value;
  }
  const descriptor: Record<string, string> = {};
  for (const key of ["type", "subtype", "className", "objectId", "description"] as const) {
    const value = remote[key];
    if (typeof value === "string") {
      descriptor[key] = value;
    }
  }
  if (Object.keys(descriptor).length > 0 && (remote.objectId || remote.description)) {
    return descriptor;
  }
  return null;
}

export async function handleEvaluate(
  manager: SessionManager,
  params: EvaluateParams,
  deps: EvaluateDeps = getDefaultDeps(),
): Promise<EvaluateResult | RpcError> {
  if (!params || typeof params.expression !== "string" || params.expression.length === 0) {
    return { code: "invalid_params", message: "evaluate requires a non-empty expression" };
  }
  const ctxOrErr = lookupSession(manager, params, "evaluate");
  if (isRpcError(ctxOrErr)) return ctxOrErr;
  const ctx = ctxOrErr;
  const ab = abortedError(deps.signal);
  if (ab) return ab;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, deps.tabsApi);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "evaluate");
  if (denied) return denied;
  if (abortedError(deps.signal)) {
    return { code: "cancelled", message: "evaluate aborted" };
  }
  const dialogCursor = markDialogCursor(deps.cdp, target.tabId);
  deps.cdp.trackSessionTab?.(ctx.sessionId, target.tabId);
  try {
    const reply = await deps.cdp.send<RuntimeEvaluateReply>(target.tabId, "Runtime.evaluate", {
      expression: params.expression,
      awaitPromise: params.await_promise ?? true,
      returnByValue: params.return_by_value ?? true,
      throwOnSideEffect: false,
    });
    if (reply.exceptionDetails) {
      return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
        ok: false,
        tab_id: target.tabId,
        error: buildEvaluateError(reply.exceptionDetails),
      });
    }
    return attachDialogs(deps.cdp, target.tabId, dialogCursor, {
      ok: true,
      tab_id: target.tabId,
      value: extractValue(reply.result),
    });
  } catch (err) {
    return {
      code: "cdp_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
