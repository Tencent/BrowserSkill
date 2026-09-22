import type { AuditEvent, AuditRun } from "./audit";

export interface AuditStep {
  id: string;
  at: number;
  kind: string;
  data: Record<string, unknown>;
  result?: Record<string, unknown>;
  interrupted?: boolean;
}

/** Fold append-only events into readable steps without losing repeated calls. */
export function auditTimeline(events: AuditEvent[]): AuditStep[] {
  const rows: AuditStep[] = [];
  const operations = new Map<string, AuditStep>();
  for (const [index, event] of events.entries()) {
    if (event.kind === "operation_started" && event.operation_id) {
      const step: AuditStep = {
        id: event.operation_id,
        at: event.at,
        kind: "operation",
        data: { ...event.data },
      };
      rows.push(step);
      operations.set(event.operation_id, step);
    } else if (event.kind === "context" && event.operation_id) {
      const step = operations.get(event.operation_id);
      if (step) step.data = { ...step.data, ...event.data };
    } else if (event.kind === "operation_finished" && event.operation_id) {
      const step = operations.get(event.operation_id);
      if (step) step.result = event.data;
    } else if (event.kind !== "named") {
      if (["paused", "ended"].includes(event.kind)) {
        for (const step of operations.values()) if (!step.result) step.interrupted = true;
      }
      rows.push({ id: `event-${index}`, at: event.at, kind: event.kind, data: event.data });
    }
  }
  return rows;
}

export function auditStepStatus(step: AuditStep, run: AuditRun, pending?: string[]): string {
  if (typeof step.result?.status === "string") return step.result.status;
  return run.status === "running" &&
    !step.interrupted &&
    (pending === undefined || pending.includes(step.id))
    ? "running"
    : "unknown";
}
