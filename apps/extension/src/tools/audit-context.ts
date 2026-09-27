import {
  isAgentControlledTab,
  type SessionManager,
  sessionWindowId,
} from "@/session-manager/manager";
import type { RequestFrame } from "@/transport/types";
import { chromeTabsApi, isRpcError, resolveTargetTab } from "./shared";

/** Read cached element labels and tab metadata only; never stimulate the page. */
export async function auditContext(
  req: RequestFrame,
  sessions: SessionManager,
): Promise<Record<string, unknown> | null> {
  const params = req.params as Record<string, unknown> | undefined;
  if (typeof params?._audit_id !== "string" || typeof params.session_id !== "string") return null;
  const context = sessions.get(params.session_id);
  if (!context) return null;
  const ref = typeof params.ref === "string" ? context.refStore.resolveEntry(params.ref) : null;
  const requestedTab = typeof params.tab_id === "number" ? params.tab_id : null;
  let tabId: number | undefined;
  let tabUrl: string | undefined;
  if (context.container.mode === "in_window") {
    const target = await resolveTargetTab(
      sessions,
      context,
      requestedTab ?? undefined,
      chromeTabsApi,
    );
    if (isRpcError(target)) return null;
    tabId = target.tabId;
    tabUrl = target.url;
  } else {
    const tab =
      requestedTab !== null
        ? await chrome.tabs.get(requestedTab)
        : (await chrome.tabs.query({ windowId: sessionWindowId(context), active: true }))[0];
    tabId = tab?.id;
    tabUrl = tab?.url;
  }
  if (!tabId || !isAgentControlledTab(context, tabId)) return null;
  let url: string | undefined;
  try {
    const parsed = new URL(tabUrl ?? "");
    if (["http:", "https:"].includes(parsed.protocol)) url = parsed.origin;
  } catch {
    /* Restricted or empty URL. */
  }
  return {
    operation_id: params._audit_id,
    tab_id: tabId,
    ...(url ? { url } : {}),
    ...(ref?.kind === "dom" && ref.tabId === tabId && ref.name
      ? { target: ref.name.slice(0, 160) }
      : {}),
  };
}
