import type { SessionManager } from "@/session-manager/manager";
import type { JavaScriptDialogInfo } from "@/transport/types";
import type { CdpRunner, DialogCursor } from "./shared";

export type DialogCleanupCdp = Partial<
  Pick<CdpRunner, "pendingDialogs" | "resolveDialog" | "onDialogChanged">
>;

/**
 * Dismiss pending JS dialogs owned by `sessionId` before running `work`, and
 * keep dismissing any chained or `beforeunload` dialogs that open during teardown.
 */
export function withSessionDialogCleanup<T>(
  sessions: Pick<SessionManager, "findControllingSession">,
  cdp: DialogCleanupCdp | undefined,
  sessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!cdp) return work();
  const owned = (tabId: number) => sessions.findControllingSession(tabId) === sessionId;
  const dismiss = (id: string) => cdp.resolveDialog?.(id, false).catch(() => {});
  const subscription = cdp.onDialogChanged?.((tabId, dialog) => {
    if (dialog && owned(tabId)) void dismiss(dialog.id);
  });
  const pending = (cdp.pendingDialogs?.() ?? []).filter((dialog) => owned(dialog.tab_id));
  if (!subscription && pending.length === 0) return work();
  return (async () => {
    try {
      await Promise.all(pending.map((dialog) => dismiss(dialog.id)));
      return await work();
    } finally {
      subscription?.dispose();
    }
  })();
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
