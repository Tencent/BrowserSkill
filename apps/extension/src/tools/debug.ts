import { DEBUG_ACTIONS, DEBUG_FIELDS, QUERY_LIMITS } from "@/debug/capabilities";
import { validateReplay, validateRule } from "@/debug/control-model";
import type { DebugManager } from "@/debug/manager";
import { budgetResult } from "@/debug/query";
import type { DebugParams, DebugResult } from "@/debug/types";
import { isAgentControlledTab, type SessionManager } from "@/session-manager/manager";
import type { RpcError } from "@/transport/types";
import {
  type ChromeTabsApi,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

const ACTIONS = new Set<string>(DEBUG_ACTIONS);
const PARTS = new Set(["metadata", "request", "response", "headers", "timing"]);

export function validateDebugParams(params: DebugParams): string | undefined {
  if (!params || typeof params.session_id !== "string" || !ACTIONS.has(params.action))
    return "a session_id and valid debug action are required";
  for (const [key, max, min] of [
    ["since", Number.MAX_SAFE_INTEGER, 0],
    ["offset", 64 * 1024, 0],
    ["limit", QUERY_LIMITS.limit.max, QUERY_LIMITS.limit.min],
    ["budget", QUERY_LIMITS.budget.max, QUERY_LIMITS.budget.min],
    ["status", 599, 100],
    ["max_chars", 16 * 1024, 1],
    ["tab_id", Number.MAX_SAFE_INTEGER, 0],
  ] as const) {
    const value = params[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min || value > max))
      return `${key} must be an integer between ${min} and ${max}`;
  }
  for (const key of [
    "id",
    "run_id",
    "name",
    "pointer",
    "url",
    "method",
    "resource_type",
  ] as const) {
    const value = params[key];
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > (key === "pointer" ? 1024 : 200))
    )
      return `${key} must be a bounded string`;
  }
  if (params.part !== undefined && !PARTS.has(params.part)) return "invalid request detail part";
  if ((params.action === "request" || params.action === "operation") && !params.id)
    return "id is required";
  if (params.pointer !== undefined && !["request", "response"].includes(params.part ?? ""))
    return "pointer requires request or response part";
  if (
    ["rule_enable", "rule_disable", "rule_remove", "replay"].includes(params.action) &&
    !params.id
  )
    return "id is required";
  if (["pin", "unpin"].includes(params.action) && !params.id) return "id is required";
  if (
    ["url", "method", "resource_type", "status", "state", "kind"].some(
      (key) => params[key as keyof DebugParams] !== undefined,
    ) &&
    params.action !== "requests"
  )
    return "filters require requests action";
  if (
    params.state !== undefined &&
    !["pending", "complete", "failed", "redirected", "interrupted"].includes(params.state)
  )
    return "invalid request state";
  if (
    params.kind !== undefined &&
    !["all", "business", "resource", "extension"].includes(params.kind)
  )
    return "invalid request kind";
  if (
    params.fields !== undefined &&
    (!Array.isArray(params.fields) ||
      params.fields.length > 32 ||
      !["request", "requests"].includes(params.action) ||
      params.fields.some(
        (field) =>
          ![
            ...DEBUG_FIELDS,
            "id",
            "run_id",
            "sequence",
            "started_at",
            "method",
            "url",
            "state",
            "request_body",
            "response_body",
            "truncated",
            "intervention",
            "replay_from",
            "replay_id",
            "pinned",
          ].includes(field),
      ))
  )
    return "invalid request fields";
  try {
    if (params.action === "rule_add") validateRule(params.rule);
    else if (params.rule !== undefined) return "rule is only accepted by rule_add";
    if (params.action === "replay") validateReplay(params.replay);
    else if (params.replay !== undefined) return "replay options are only accepted by replay";
  } catch (error) {
    return error instanceof Error ? error.message : "invalid network control options";
  }
  return undefined;
}

export async function handleDebug(
  sessions: SessionManager,
  params: DebugParams,
  debug: DebugManager,
  tabs: ChromeTabsApi = chromeTabsApi,
  signal?: AbortSignal,
): Promise<DebugResult | RpcError> {
  const invalid = validateDebugParams(params);
  if (invalid) return { code: "invalid_params", message: invalid };
  const context = lookupSession(sessions, params, "debug");
  if (isRpcError(context)) return context;
  if (signal?.aborted) return { code: "cancelled", message: "debug aborted" };
  try {
    if (params.action === "start") {
      const target = await resolveTargetTab(sessions, context, params.tab_id, tabs);
      if (isRpcError(target)) return target;
      const scope = enforceAgentWindow(context, target, "debug");
      if (scope) return scope;
      if (!isAgentControlledTab(context, target.tabId))
        return {
          code: "permission_denied",
          data: { reason: "agent_window_scope" },
          message: "debug requires a task-created or borrowed tab",
        };
      if (signal?.aborted) return { code: "cancelled", message: "debug aborted" };
      const run = await debug.start(context.sessionId, target.tabId, params.name);
      if (signal?.aborted) {
        debug.stopTab(target.tabId, "cancelled");
        return { code: "cancelled", message: "debug aborted" };
      }
      return budgetResult({ session_id: context.sessionId, run }, params);
    }
    return budgetResult(await debug.read(params, signal), params);
  } catch (error) {
    return {
      code: "invalid_params",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
