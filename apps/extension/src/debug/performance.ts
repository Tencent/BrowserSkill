import { redactUrl } from "./redact";
import type { DebugMetric, DebugPerformance } from "./types";

export const PERFORMANCE_LIMIT = 20;
export const PERFORMANCE_METRICS = [
  "ttfb_ms",
  "dom_content_loaded_ms",
  "load_ms",
  "fcp_ms",
  "lcp_ms",
  "cls",
  "long_task_count",
  "long_task_total_ms",
  "long_task_max_ms",
] as const;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((s): s is string => typeof s === "string")
        .slice(0, 16)
        .map((s) => s.slice(0, 80))
    : [];

/** Bindings are isolated, but still validate lengths/types before persistent storage. */
export function performanceSnapshot(
  value: unknown,
): Omit<DebugPerformance, "id" | "sequence"> | undefined {
  if (!value || typeof value !== "object") return;
  const data = value as DebugPerformance;
  if (
    typeof data.document_key !== "string" ||
    !/^\d+(?:\.\d+)?:\d+$/.test(data.document_key) ||
    data.document_key.length > 64 ||
    !finite(data.started_at) ||
    !finite(data.time_origin) ||
    !finite(data.observed_at) ||
    typeof data.url !== "string" ||
    !/^https?:/.test(data.url)
  )
    return;
  const metrics: Record<string, DebugMetric> = {};
  for (const key of PERFORMANCE_METRICS) {
    const entry = data.metrics?.[key];
    if (
      !entry ||
      !["available", "provisional", "partial", "unavailable", "unsupported"].includes(entry.state)
    )
      continue;
    metrics[key] = {
      ...(finite(entry.value) ? { value: entry.value } : {}),
      state: entry.state,
      reasons: strings(entry.reasons),
    };
  }
  return {
    document_key: data.document_key,
    time_origin: data.time_origin,
    started_at: data.started_at,
    observed_at: data.observed_at,
    url: redactUrl(data.url),
    navigation: typeof data.navigation === "string" ? data.navigation.slice(0, 40) : "unknown",
    state: data.state === "completed" ? "completed" : "capturing",
    early: data.early === true,
    scope: "main_frame",
    metrics,
    visibility: Array.isArray(data.visibility)
      ? data.visibility
          .slice(0, 64)
          .filter((v) => v && finite(v.at) && ["hidden", "visible"].includes(v.state))
          .map((v) => ({ at: v.at, state: v.state }))
      : [],
    visibility_truncated: !!data.visibility_truncated,
    long_tasks: Array.isArray(data.long_tasks)
      ? data.long_tasks
          .slice(0, 50)
          .filter((t) => t && finite(t.at) && finite(t.duration_ms))
          .map((t) => ({ at: t.at, duration_ms: t.duration_ms }))
      : [],
    long_tasks_truncated: !!data.long_tasks_truncated,
    coverage: strings(data.coverage),
  };
}
export function interruptPerformance(entry: DebugPerformance, reason: string): void {
  if (entry.state !== "capturing") return;
  entry.state = "interrupted";
  entry.coverage = [...new Set([...entry.coverage, reason])];
  for (const metric of Object.values(entry.metrics))
    if (metric.state === "provisional") {
      metric.state = "partial";
      metric.reasons = [...new Set([...metric.reasons, reason])];
    }
}
