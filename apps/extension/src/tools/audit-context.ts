import { isAgentControlledTab, type SessionManager } from "@/session-manager/manager";
import type { RequestFrame } from "@/transport/types";

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
  const tab =
    requestedTab !== null
      ? await chrome.tabs.get(requestedTab)
      : (await chrome.tabs.query({ windowId: context.agentWindowId, active: true }))[0];
  if (!tab?.id || !isAgentControlledTab(context, tab.id)) return null;
  let url: string | undefined;
  try {
    const parsed = new URL(tab.url ?? "");
    if (["http:", "https:"].includes(parsed.protocol)) url = parsed.origin;
  } catch {
    /* Restricted or empty URL. */
  }
  return {
    operation_id: params._audit_id,
    tab_id: tab.id,
    ...(url ? { url } : {}),
    ...(ref?.tabId === tab.id && ref.name ? { target: ref.name.slice(0, 160) } : {}),
  };
}
