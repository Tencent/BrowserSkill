import { describe, expect, it } from "vitest";
import { debugCapabilities } from "../capabilities";
import { bodySlice } from "../network-store";
import { budgetResult, matchesRequest, projectFields } from "../query";
import { readRecording } from "../recording";
import type { DebugRecording, DebugRequest, DebugResult } from "../types";

const request = (sequence: number): DebugRequest => ({
  id: `d:n${sequence}`,
  run_id: "d",
  sequence,
  started_at: sequence,
  method: "POST",
  url: `https://site.test/api/${sequence}`,
  resource_type: "Fetch",
  status: 200,
  state: "complete",
  duration_ms: 200,
  request_body: { state: "empty" },
  response_body: { state: "available", chars: 3000 },
});
const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2)).length;
describe("agent debug query budget", () => {
  it("paginates whole requests without skipping evidence and keeps the source unchanged", () => {
    const entries = Array.from({ length: 100 }, (_, i) => request(i + 1));
    const original: DebugResult = { session_id: "s", requests: entries, next_since: 200 };
    const found: string[] = [];
    let since = 0;
    while (since < 100) {
      const result = budgetResult(
        { ...original, requests: entries.filter((entry) => entry.sequence > since) },
        { session_id: "s", action: "requests", budget: 4096 },
      );
      expect(size(result)).toBeLessThanOrEqual(4096);
      expect(result.requests?.length).toBeGreaterThan(0);
      found.push(...result.requests!.map((entry) => entry.id));
      since = result.next_since!;
    }
    expect(found).toEqual(entries.map((entry) => entry.id));
    expect(original.requests).toHaveLength(100);
  });
  it("compacts inline resources and filters by request attributes without changing identity", () => {
    const entry = request(1);
    expect(
      matchesRequest(entry, {
        session_id: "s",
        action: "requests",
        url: "/api",
        method: "POST",
        status: 200,
        resource_type: "Fetch",
        kind: "business",
      }),
    ).toBe(true);
    expect(matchesRequest(entry, { session_id: "s", action: "requests", status: 503 })).toBe(false);
    const selected = projectFields(entry, ["status"]);
    expect(selected.id).toBe(entry.id);
    expect(selected.status).toBe(200);
    expect(selected.duration_ms).toBeUndefined();
    const result = budgetResult(
      {
        session_id: "s",
        requests: [{ ...entry, url: `data:image/png;base64,${"x".repeat(2048)}` }],
      },
      { session_id: "s", action: "requests" },
    );
    expect(result.requests![0].url.length).toBeLessThan(100);
    expect(result.output?.omitted).toContain("inline_url_content");
  });
  it("returns exact UTF-16 body slices under a UTF-8 budget with a usable continuation", () => {
    const text = '你好🙂\\"'.repeat(3000);
    let offset = 0,
      collected = "";
    while (offset < text.length) {
      const result = budgetResult(
        {
          session_id: "s",
          request: {
            ...request(1),
            response_body: {
              state: "available",
              text: text.slice(offset),
              offset,
              chars: text.length,
            },
          },
        },
        { session_id: "s", action: "request", part: "response", budget: 4096 },
      );
      expect(size(result)).toBeLessThanOrEqual(4096);
      const body = result.request!.response_body;
      expect(body.text!.length).toBeGreaterThan(0);
      collected += body.text;
      offset = body.next_offset ?? text.length;
    }
    expect(collected).toBe(text);
  });
  it("marks projected omissions without rewriting stored operation evidence or exports", () => {
    const original: DebugResult = {
      session_id: "s",
      pages: Array.from({ length: 20 }, (_, i) => ({
        at: i,
        state: "available",
        text: "中".repeat(4000),
      })),
    };
    const result = budgetResult(original, { session_id: "s", action: "pages", budget: 4096 });
    expect(size(result)).toBeLessThanOrEqual(4096);
    expect(result.output?.truncated).toBe(true);
    expect(original.pages![0].text).toHaveLength(4000);
    expect(budgetResult(original, { session_id: "s", action: "export" })).toBe(original);
  });
  it("keeps every console row reachable after budget pagination and retains intervention provenance", () => {
    const console = Array.from({ length: 50 }, (_, i) => ({
      id: `c${i}`,
      at: i,
      text: "x".repeat(400),
      level: "error",
      count: 1,
    }));
    const recording = { run: { session_id: "s" }, console } as DebugRecording;
    let offset = 0;
    const seen: string[] = [];
    do {
      const params = { session_id: "s", action: "console", budget: 4096, offset } as const;
      const page = budgetResult(readRecording(recording, params), params);
      expect(size(page)).toBeLessThanOrEqual(4096);
      seen.push(...page.console!.map((entry) => entry.id));
      offset = page.next_offset ?? console.length;
    } while (offset < console.length);
    expect(seen).toEqual(console.map((entry) => entry.id));
    const entry = { ...request(1), replay_id: "r1", pinned: true };
    expect(projectFields(entry, [])).toMatchObject({ replay_id: "r1", pinned: true });
  });
  it("does not advance a body cursor with no text when metadata consumes the budget", () => {
    const result = budgetResult(
      {
        session_id: "s",
        request: {
          ...request(1),
          response_headers: { huge: "h".repeat(9000) },
          response_body: { state: "available", text: "v".repeat(10000), offset: 0 },
        },
      },
      { session_id: "s", action: "request", part: "response", budget: 4096 },
    );
    expect(result.request!.response_body.text!.length).toBeGreaterThan(0);
    expect(result.request!.response_body.next_offset).toBeGreaterThan(0);
    expect(size(result)).toBeLessThanOrEqual(4096);
    expect(result.output!.omitted).toContain("request.response_headers");
  });
  it("keeps Unicode body continuations valid for the Rust JSON transport", () => {
    const body = { state: "available", text: "a🙂b" } as const;
    expect(bodySlice(body, 0, 2)).toMatchObject({ text: "a", next_offset: 1 });
    expect(bodySlice(body, 1, 2)).toMatchObject({ text: "🙂", next_offset: 3 });
    expect(() => bodySlice(body, 2, 2)).toThrow("Unicode");
    expect(() => bodySlice(body, 1, 1)).toThrow("Unicode");
  });
  it("uses 64 KiB by default while preserving an explicit smaller budget", () => {
    const original: DebugResult = {
      session_id: "s",
      console: Array.from({ length: 60 }, (_, i) => ({
        id: `c${i}`,
        at: i,
        last_at: i,
        text: "x".repeat(700),
        level: "info",
        count: 1,
      })),
    };
    const wide = budgetResult(original, { session_id: "s", action: "console" });
    expect(wide.console).toHaveLength(60);
    expect(wide.output?.budget).toBe(65536);
    expect(size(wide)).toBeGreaterThan(32768);
    const narrow = budgetResult(original, { session_id: "s", action: "console", budget: 32768 });
    expect(narrow.console!.length).toBeLessThan(60);
    expect(narrow.next_offset).toBe(narrow.console!.length);
  });
  it("applies filters before pagination and advances past unmatched records", () => {
    const recording = {
      run: { session_id: "s", next_since: 10, dropped_requests: 0 },
      requests: [request(1), { ...request(2), status: 503 }, request(3)],
    } as DebugRecording;
    const result = readRecording(recording, {
      session_id: "s",
      action: "requests",
      status: 503,
      limit: 1,
    });
    expect(result.requests?.map((entry) => entry.id)).toEqual(["d:n2"]);
    expect(
      readRecording(recording, { session_id: "s", action: "requests", status: 404 }).next_since,
    ).toBe(10);
    expect(debugCapabilities().parameters).toMatchObject({
      budget: { min: 4096, max: 262144, default: 65536 },
      limit: { max: 100 },
    });
  });
});
