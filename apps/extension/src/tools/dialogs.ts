import type { JavaScriptDialogInfo } from "@/transport/types";
import type { CdpRunner, DialogCursor } from "./shared";

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
