import { describe, expect, it } from "vitest";
import { buildTraceV2, shouldRecordPress } from "@/lib/trace-reducer-v2";
import type { DraftTraceStep } from "@/transport/types";

describe("trace-reducer-v2", () => {
  it("drops scroll and bare character press steps", () => {
    const steps: DraftTraceStep[] = [
      {
        op: "scroll",
        page_url: "https://example.com/",
      },
      {
        op: "press",
        key: "a",
        page_url: "https://example.com/",
      },
    ];
    const trace = buildTraceV2({
      steps,
      startedAt: "2026-01-01T00:00:00.000Z",
      startUrl: "https://example.com/",
    });
    expect(trace.steps).toHaveLength(0);
    expect(trace.pages).toHaveLength(1);
  });

  it("preserves hover steps supported by protocol v2", () => {
    const trace = buildTraceV2({
      steps: [
        {
          op: "hover",
          target: { unmatched: true },
          captureTarget: { tag: "button", role: "button", name: "结束" },
          page_url: "https://example.com/",
        },
      ],
      startedAt: "2026-01-01T00:00:00.000Z",
      startUrl: "https://example.com/",
    });

    expect(trace.steps).toEqual([
      expect.objectContaining({
        op: "hover",
        target: expect.objectContaining({ tag: "button", name: "结束" }),
      }),
    ]);
  });

  it("maps captureTarget to v2 target with required tag", () => {
    const steps: DraftTraceStep[] = [
      {
        op: "click",
        target: { unmatched: true },
        captureTarget: { tag: "button", role: "button", name: "Submit" },
        page_url: "https://example.com/",
      },
    ];
    const trace = buildTraceV2({
      steps,
      startedAt: "2026-01-01T00:00:00.000Z",
      startUrl: "https://example.com/",
    });
    expect(trace.steps).toHaveLength(1);
    expect(trace.steps[0]?.op).toBe("click");
    if (trace.steps[0]?.op === "click") {
      expect(trace.steps[0].target.tag).toBe("button");
      expect(trace.steps[0].target.name).toBe("Submit");
    }
    expect("version" in trace).toBe(false);
  });

  it("records Enter presses", () => {
    expect(shouldRecordPress("Enter")).toBe(true);
  });
});
