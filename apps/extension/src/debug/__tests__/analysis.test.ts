import { describe, expect, it } from "vitest";
import { analyzeRecording } from "../analysis";
import { budgetResult } from "../query";
import type { DebugParams, DebugRecording, DebugRequest } from "../types";

const request = (id: number, patch: Partial<DebugRequest> = {}): DebugRequest => ({
  id: `d:n${id}`,
  run_id: "d",
  sequence: id,
  started_at: id * 100,
  finished_at: id * 100 + 200,
  method: "GET",
  url: "https://site.test/api/name",
  resource_type: "Fetch",
  state: "complete",
  status: 200,
  duration_ms: 200,
  frame_id: "f1",
  loader_id: "l1",
  request_body: { state: "empty" },
  response_body: { state: "available", text: '{"ok":true}' },
  ...patch,
});
const recording = (requests: DebugRequest[]): DebugRecording =>
  ({
    version: 1,
    saved_at: 2000,
    run: { id: "d", session_id: "s", next_since: 100, dropped_requests: 0, coverage: [] },
    requests,
    operations: [],
    console: [],
    pages: [],
  }) as unknown as DebugRecording;
const read = (
  requests: DebugRequest[],
  action: "aggregate" | "duplicates",
  params: Partial<DebugParams> = {},
) => analyzeRecording(recording(requests), { session_id: "s", action, ...params });

describe("recording analysis", () => {
  it("groups exact method/origin/path and uses only captured timing and transfer samples", () => {
    const source = [
      request(1, { url: "https://site.test/api/name?q=1", duration_ms: 10, transfer_bytes: 40 }),
      request(2, { url: "https://site.test/api/name?q=2", duration_ms: 2000, status: 503 }),
      request(3, { duration_ms: undefined, state: "pending", status: undefined }),
      request(4, { method: "POST", state: "failed", duration_ms: 0 }),
      request(5, { url: "https://site.test/api/name/123" }),
      request(6, { url: "https://site.test/api/name/456" }),
      request(7, { url: "data:image/png,abc", resource_type: "Image" }),
      request(8, { url: "http://[invalid" }),
    ];
    const before = JSON.stringify(source);
    const result = read(source, "aggregate");
    expect(result.aggregates).toHaveLength(4);
    expect(result.aggregates![0]).toMatchObject({
      count: 3,
      http_errors: 1,
      pending: 1,
      failed: 0,
      timing_samples: 2,
      transfer_bytes: 40,
      transfer_samples: 1,
      slow: 1,
      duration_ms: { min: 10, mean: 1005, p50: 10, p95: 2000, max: 2000, total: 2010 },
      request_ids: ["d:n2", "d:n1", "d:n3"],
      statuses: { 200: 1, 503: 1 },
    });
    expect(JSON.stringify(source)).toBe(before);
    expect(result.analysis?.semantics).toContain("not business success");
  });
  it("filters before summarizing and excludes controlled/replayed experiments by default", () => {
    const source = [
      request(1),
      request(2, { replay_id: "replay" }),
      request(3, { status: 503 }),
      request(4, { resource_type: "Image", url: "https://site.test/a.png" }),
    ];
    expect(read(source, "aggregate").analysis).toMatchObject({
      retained: 4,
      matched: 3,
      included: 2,
      excluded_controlled: 1,
    });
    expect(read(source, "aggregate", { status: 503 }).aggregates![0].count).toBe(1);
    expect(read(source, "aggregate", { include_controlled: true }).aggregates![0]).toMatchObject({
      count: 3,
      replayed: 1,
    });
    expect(read(source, "aggregate", { kind: "all", slow_ms: 0 }).analysis?.included).toBe(3);
  });
  it("detects suspected duplicates only within a fixed window and same frame/document/body/URL", () => {
    const source = [
      request(1, { started_at: 0, finished_at: 150, status: 503 }),
      request(2, { started_at: 100, finished_at: 250 }),
      request(3, { started_at: 1000 }),
      request(4, { started_at: 1100 }),
      request(5, { started_at: 2000 }),
      request(6, { loader_id: "l2" }),
      request(7, { frame_id: "f2" }),
      request(8, { url: "https://site.test/api/name?q=1" }),
      request(9, { request_body: { state: "available", text: "different" } }),
    ];
    const groups = read(source, "duplicates").duplicates!;
    expect(groups.map((g) => g.request_ids)).toEqual([
      ["d:n1", "d:n2", "d:n3"],
      ["d:n4", "d:n5"],
    ]);
    expect(groups[0]).toMatchObject({ extra_requests: 2, possible_retry: true, overlap_count: 1 });
    expect(read(source, "duplicates").analysis?.suspected_extra_requests).toBe(3);
  });
  it("does not claim equality for redacted, truncated, missing or identity-less requests", () => {
    const source = [
      request(1, { request_body: { state: "truncated", text: "x" } }),
      request(2, { request_body: { state: "available", text: '{"token":"[redacted]"}' } }),
      request(3, { url: "https://site.test/api?token=%5Bredacted%5D" }),
      request(4, { loader_id: undefined }),
      request(5, { request_body: { state: "available" } }),
    ];
    const result = read(source, "duplicates");
    expect(result.duplicates).toEqual([]);
    expect(result.analysis).toMatchObject({
      uncomparable: 5,
      coverage: expect.arrayContaining(["missing_document_identity"]),
    });
  });
  it("links operation evidence and bounds reference lists without losing totals", () => {
    const record = recording(Array.from({ length: 60 }, (_, i) => request(i, { started_at: i })));
    record.operations = [
      { id: "d:o1", started_at: 0, window_end: 1000 },
    ] as DebugRecording["operations"];
    const result = analyzeRecording(record, { session_id: "s", action: "duplicates" });
    expect(result.duplicates![0]).toMatchObject({
      count: 60,
      extra_requests: 59,
      refs_truncated: true,
      operation_ids: ["d:o1"],
    });
    expect(result.duplicates![0].request_ids).toHaveLength(50);
    expect(read(record.requests, "aggregate").aggregates![0].request_ids).toHaveLength(50);
  });
  it("keeps every group reachable under output-budget pagination", () => {
    const record = recording(
      Array.from({ length: 70 }, (_, i) => request(i, { url: `https://site.test/api/${i}` })),
    );
    let offset = 0;
    const ids: string[] = [];
    do {
      const params = {
        session_id: "s",
        action: "aggregate",
        limit: 100,
        budget: 4096,
        offset,
      } as const;
      const page = budgetResult(analyzeRecording(record, params), params);
      expect(new TextEncoder().encode(JSON.stringify(page, null, 2)).length).toBeLessThanOrEqual(
        4096,
      );
      ids.push(...page.aggregates!.map((g) => g.id));
      offset = page.next_offset ?? 70;
    } while (offset < 70);
    expect(new Set(ids).size).toBe(70);
    expect(ids).toHaveLength(70);
  });
});
