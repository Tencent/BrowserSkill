import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditRun } from "../audit";
import { auditStepStatus, auditTimeline } from "../audit-timeline";

describe("audit timeline", () => {
  it("keeps retries separate and merges context and results into their own calls", () => {
    const events: AuditEvent[] = [
      {
        at: 1,
        kind: "operation_started",
        operation_id: "a",
        data: { method: "tool.click", target: "@e1" },
      },
      { at: 2, kind: "context", operation_id: "a", data: { target: "Submit" } },
      { at: 3, kind: "operation_finished", operation_id: "a", data: { status: "error" } },
      { at: 4, kind: "operation_started", operation_id: "b", data: { method: "tool.click" } },
      { at: 5, kind: "operation_finished", operation_id: "b", data: { status: "completed" } },
    ];
    const rows = auditTimeline(events);
    expect(rows).toHaveLength(2);
    expect(rows[0].data.target).toBe("Submit");
    expect(rows[0].result?.status).toBe("error");
    expect(rows[1].result?.status).toBe("completed");
  });
  it("keeps a result spanning a pause unknown even when the task resumes", () => {
    const rows = auditTimeline([
      { at: 1, kind: "operation_started", operation_id: "a", data: {} },
      { at: 2, kind: "paused", data: {} },
      { at: 3, kind: "resumed", data: {} },
      { at: 4, kind: "operation_started", operation_id: "b", data: {} },
    ]);
    const run = { status: "running" } as AuditRun;
    expect(auditStepStatus(rows[0], run)).toBe("unknown");
    expect(auditStepStatus(rows[3], run)).toBe("running");
    expect(auditStepStatus(rows[3], run, [])).toBe("unknown");
    expect(auditStepStatus(rows[3], run, ["b"])).toBe("running");
    expect(auditStepStatus(rows[3], { status: "interrupted" } as AuditRun)).toBe("unknown");
  });
});
