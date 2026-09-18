import type { DebugParams, DebugResult, DebugTask } from "./types";

async function request<T>(message: object): Promise<T> {
  const response = await chrome.runtime.sendMessage({ kind: "bsk_debug", ...message });
  if (!response?.ok) throw new Error(response?.error ?? "unavailable");
  return response.data as T;
}
export const debugRequest = (params: DebugParams): Promise<DebugResult> =>
  request({ action: "debug", params });
export const debugTasks = (): Promise<{ tasks: DebugTask[] }> => request({ action: "tasks" });
export function openDebugPage(sessionId: string, runId?: string): void {
  const url = new URL(chrome.runtime.getURL("debug.html"));
  url.searchParams.set("session", sessionId);
  if (runId) url.searchParams.set("run", runId);
  void chrome.tabs.create({ url: url.href });
}
