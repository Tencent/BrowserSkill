import type { DebugParams, DebugResult, DebugRun, DebugTask } from "./types";

async function request<T>(message: object): Promise<T> {
  const response = await chrome.runtime.sendMessage({ kind: "bsk_debug", ...message });
  if (!response?.ok) throw new Error(response?.error ?? "unavailable");
  return response.data as T;
}
export const debugRequest = (params: DebugParams): Promise<DebugResult> =>
  request({ action: "debug", params });
export const debugTasks = (): Promise<{ tasks: DebugTask[] }> => request({ action: "tasks" });
export const debugHistory = (): Promise<{ runs: DebugRun[]; error?: string }> =>
  request({ action: "history" });
export const recordingRequest = (params: DebugParams): Promise<DebugResult> =>
  request({ action: "record", params });
export const deleteRecording = (id: string): Promise<object> =>
  request({ action: "delete", run_id: id });
export function openDebugPage(sessionId?: string, runId?: string): void {
  const url = new URL(chrome.runtime.getURL("debug.html"));
  if (sessionId) url.searchParams.set("session", sessionId);
  if (runId) url.searchParams.set("run", runId);
  void chrome.tabs.create({ url: url.href });
}
