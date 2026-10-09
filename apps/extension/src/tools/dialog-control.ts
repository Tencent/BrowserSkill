import { isAgentControlledTab, type SessionManager } from "@/session-manager/manager";
import type { DialogHandleParams, DialogStatusParams, RpcError } from "@/transport/types";
import {
  type CdpRunner,
  chromeTabsApi,
  enforceAgentWindow,
  isRpcError,
  lookupSession,
} from "./shared";

/** Cached dialog state and browser metadata only; a modal can block all renderer reads. */
export async function handleDialog(
  manager: SessionManager,
  method: string,
  params: DialogStatusParams | DialogHandleParams,
  cdp: CdpRunner,
  signal?: AbortSignal,
): Promise<unknown | RpcError> {
  const ctx = lookupSession(manager, params, "dialog");
  if (isRpcError(ctx)) return ctx;
  if (!cdp.pendingDialogs || !cdp.resolveDialog)
    return { code: "unsupported", message: "Dialog control requires extension protocol 1.4" };
  const pending = cdp.pendingDialogs().filter((dialog) => isAgentControlledTab(ctx, dialog.tab_id));
  if (method === "tool.dialog_status") {
    const tabId = (params as DialogStatusParams).tab_id;
    if (tabId !== undefined && (!Number.isSafeInteger(tabId) || tabId < 0))
      return { code: "invalid_params", message: "tab_id must be a non-negative integer" };
    return {
      session_id: ctx.sessionId,
      dialogs: pending.filter((dialog) => tabId === undefined || dialog.tab_id === tabId),
    };
  }
  const p = params as DialogHandleParams;
  if (typeof p.dialog_id !== "string" || p.dialog_id.length === 0)
    return { code: "invalid_params", message: "dialog_id is required; get it from dialog status" };
  const dialog = pending.find((dialog) => dialog.id === p.dialog_id);
  if (!dialog) return { code: "not_found", message: "Dialog is not pending in this session" };
  const accept = method === "tool.dialog_accept";
  if (
    p.text !== undefined &&
    (typeof p.text !== "string" || p.text.length > 4096 || !accept || dialog.type !== "prompt")
  )
    return {
      code: "invalid_params",
      message: "text is only valid for prompt acceptance and must be at most 4096 characters",
    };
  try {
    const tab = await chromeTabsApi.get(dialog.tab_id);
    const denied = enforceAgentWindow(
      ctx,
      { tabId: dialog.tab_id, windowId: tab.windowId },
      "dialog",
    );
    if (denied) return denied;
    const handled = await cdp.resolveDialog(dialog.id, accept, p.text, signal);
    return { session_id: ctx.sessionId, dialog: handled };
  } catch (error) {
    return { code: "cdp_failed", message: error instanceof Error ? error.message : String(error) };
  }
}
