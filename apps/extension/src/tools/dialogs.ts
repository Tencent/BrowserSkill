import type { SessionManager } from "@/session-manager/manager";
import type { DialogParams, DialogResult, JavaScriptDialogInfo, RpcError } from "@/transport/types";
import {
  type CdpRunner,
  type ChromeTabsApi,
  type DialogCursor,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
  resolveTargetTab,
} from "./shared";

export async function handleDialog(
  manager: SessionManager,
  params: DialogParams,
  cdp: CdpRunner,
  tabs: ChromeTabsApi,
  signal?: AbortSignal,
): Promise<DialogResult | RpcError> {
  if (!params || !["status", "accept", "dismiss"].includes(params.action)) {
    return { code: "invalid_params", message: "dialog requires status, accept or dismiss" };
  }
  if (
    (params.prompt_text !== undefined &&
      (typeof params.prompt_text !== "string" || params.action !== "accept")) ||
    (params.dialog_id !== undefined &&
      (typeof params.dialog_id !== "string" || !params.dialog_id || params.action === "status"))
  ) {
    return {
      code: "invalid_params",
      message: "prompt_text is only valid for accept; dialog_id requires accept or dismiss",
    };
  }
  const ctx = lookupSession(manager, params, "dialog");
  if (isRpcError(ctx)) return ctx;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, tabs);
  if (isRpcError(target)) return target;
  const denied = enforceAgentWindow(ctx, target, "dialog");
  if (denied) return denied;
  if (signal?.aborted) return { code: "cancelled", message: "dialog aborted" };
  if (!cdp.pendingDialog || !cdp.handleDialog)
    return { code: "unsupported", message: "JavaScript dialog control is unavailable" };
  const pending = cdp.pendingDialog(target.tabId);
  if (params.action === "status")
    return {
      tab_id: target.tabId,
      pending,
      execution_pending: cdp.dialogExecutionPending?.(target.tabId) ?? false,
    };
  if (!pending || (params.dialog_id !== undefined && params.dialog_id !== pending.id)) {
    return {
      code: "not_found",
      message: "No matching pending JavaScript dialog; query dialog status again",
    };
  }
  if (params.prompt_text !== undefined && pending.type !== "prompt") {
    return { code: "invalid_params", message: "Text can only be supplied for a prompt dialog" };
  }
  try {
    const handled = await cdp.handleDialog(
      target.tabId,
      pending.id,
      params.action === "accept",
      params.prompt_text,
    );
    return {
      tab_id: target.tabId,
      pending: cdp.pendingDialog(target.tabId),
      execution_pending: cdp.dialogExecutionPending?.(target.tabId) ?? false,
      handled,
    };
  } catch (error) {
    return { code: "cdp_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Scope the warning exactly like dialog control; never expose another task's dialog. */
export async function pendingDialogError(
  manager: SessionManager,
  params: { session_id?: string; tab_id?: number },
  cdp: CdpRunner,
  tabs: ChromeTabsApi,
): Promise<RpcError | null> {
  if (!cdp.pendingDialog || !params.session_id) return null;
  const ctx = manager.get(params.session_id);
  if (!ctx) return null;
  const target = await resolveTargetTab(manager, ctx, params.tab_id, tabs);
  if (isRpcError(target) || enforceAgentWindow(ctx, target, "dialog")) return null;
  const dialog = cdp.pendingDialog(target.tabId);
  if (dialog)
    return {
      code: "cdp_failed",
      message: `JavaScript ${dialog.type} dialog is pending: ${dialog.message}. Use bsk dialog accept or dismiss; do not repeat the original action.`,
      data: { reason: "dialog_pending", dialog, effect_state: "unknown" },
    };
  if (cdp.dialogExecutionPending?.(target.tabId))
    return {
      code: "cdp_failed",
      message:
        "The original browser command is still finishing after a dialog. Query bsk dialog status; do not repeat the action.",
      data: { reason: "dialog_execution_pending", tab_id: target.tabId, effect_state: "unknown" },
    };
  return null;
}

/** Capture the current per-tab dialog sequence before issuing CDP calls. */
export function markDialogCursor(cdp: CdpRunner, tabId: number): DialogCursor {
  return cdp.dialogCursor?.(tabId) ?? 0;
}

/** Collect dialogs observed on `tabId` after `cursor` was taken. */
export function collectDialogs(
  cdp: CdpRunner,
  tabId: number,
  cursor: DialogCursor,
): JavaScriptDialogInfo[] {
  return cdp.dialogsSince?.(tabId, cursor) ?? [];
}

/** Attach `dialogs` to a tool result when non-empty (wire omits empty arrays). */
export function withDialogs<T extends object>(
  result: T,
  dialogs: JavaScriptDialogInfo[],
): T & { dialogs?: JavaScriptDialogInfo[] } {
  if (dialogs.length === 0) return result;
  return { ...result, dialogs };
}

/** Convenience: collect dialogs since `cursor` and attach to `result`. */
export function attachDialogs<T extends object>(
  cdp: CdpRunner,
  tabId: number,
  cursor: DialogCursor,
  result: T,
): T & { dialogs?: JavaScriptDialogInfo[] } {
  return withDialogs(result, collectDialogs(cdp, tabId, cursor));
}
