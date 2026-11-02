import { defaultStorage } from "./instance-id";

export const AUDIT_ENABLED_KEY = "bsk_audit_enabled";
export const AUDIT_MESSAGE = "bsk_audit";

export async function getAuditEnabled(): Promise<boolean> {
  const items = await defaultStorage().get(AUDIT_ENABLED_KEY);
  return items[AUDIT_ENABLED_KEY] === true;
}

export interface AuditRun {
  id: string;
  browser_id: string;
  session_id: string;
  started_at: number;
  recorded_at: number;
  updated_at: number;
  status: "running" | "ended" | "interrupted";
  name: string | null;
  site: string | null;
  operations: number;
  errors: number;
  partial: boolean;
}

export interface AuditEvent {
  at: number;
  kind: string;
  operation_id?: string;
  data: Record<string, unknown>;
}

export interface AuditList {
  runs: AuditRun[];
  total: number;
  enabled: boolean;
  directory: string;
  retention_days: number;
  error?: string | null;
}

export interface AuditDetail {
  run: AuditRun;
  events: AuditEvent[];
  total: number;
  pending_operations?: string[];
  error?: string | null;
}

export type AuditAction = "state" | "configure" | "list" | "get" | "delete" | "open_directory";

export async function auditRequest<T>(
  action: AuditAction,
  params: Record<string, unknown> = {},
): Promise<T> {
  const response = await chrome.runtime.sendMessage({ kind: AUDIT_MESSAGE, action, ...params });
  if (!response || !response.ok) throw new Error(response?.error ?? "unavailable");
  return response.data as T;
}

export function openAuditPage(id?: string): void {
  const url = new URL(chrome.runtime.getURL("audit.html"));
  if (id) url.searchParams.set("id", id);
  void chrome.tabs.create({ url: url.href });
}
