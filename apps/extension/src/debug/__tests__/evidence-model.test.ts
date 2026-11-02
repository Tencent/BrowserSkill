import { describe, expect, it } from "vitest";
import { consoleSource, operationContext, operationEvidence, requestKind } from "../evidence-model";
import { sanitizeFields } from "../observer";
import { redactBody } from "../redact";
import type { DebugOperation, DebugPage, DebugRecording, DebugRequest } from "../types";

const page = (at: number, value: string): DebugPage => ({
  at,
  state: "available",
  text: value,
  fields: [
    {
      key: "form|name:displayName",
      name: "displayName",
      label: "Nickname",
      state: "available",
      value,
    },
  ],
});
const input: DebugOperation = {
  id: "d:a1",
  run_id: "d",
  sequence: 1,
  method: "tool.fill",
  source: "human",
  started_at: 100,
  finished_at: 200,
  state: "completed",
  before: page(100, "Alice"),
  after: page(200, "Bob"),
  request_ids: [],
  console_ids: [],
  truncated: false,
};
const save: DebugOperation = {
  ...input,
  id: "d:a2",
  method: "tool.click",
  started_at: 300,
  finished_at: 310,
  window_end: 1810,
  observation_end: 15310,
  before: page(300, "Bob"),
  after: page(400, "Bob"),
};
const request: DebugRequest = {
  id: "d:n1",
  run_id: "d",
  sequence: 2,
  started_at: 320,
  finished_at: 9000,
  method: "POST",
  url: "https://app.test/save",
  resource_type: "Fetch",
  state: "complete",
  status: 200,
  request_body: { state: "available", text: '{"displayName":"Bob"}' },
  response_body: { state: "available", text: '{"success":false,"error":"name is required"}' },
};
const fixture = (): DebugRecording => ({
  version: 1,
  saved_at: 20000,
  run: {
    id: "d",
    session_id: "s",
    tab_id: 1,
    name: "Save",
    url: "https://app.test",
    started_at: 0,
    stopped_at: 20000,
    state: "stopped",
    requests: 1,
    operations: 2,
    errors: 0,
    dropped_requests: 0,
    dropped_operations: 0,
    dropped_console: 0,
    next_since: 2,
    coverage: [],
  },
  operations: [input, save],
  requests: [request],
  pages: [{ ...page(10000, "Alice"), navigation: "reload" }],
  console: [],
});

describe("operation evidence", () => {
  it.each([
    JSON.stringify({
      displayName: "Bob",
      ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`f${i}`, i])),
      nested: { displayName: "Other" },
    }),
    JSON.stringify({
      displayName: "Bob",
      nested: { a: { b: { c: { d: { displayName: "Other" } } } } },
    }),
    JSON.stringify({ displayName: "Bob", rows: [{ displayName: "Other" }] }),
    `displayName=Bob&${Array.from({ length: 31 }, (_, i) => `f${i}=x`).join("&")}&displayName=Other`,
  ])("does not claim unique field matches after a partial payload scan: %s", (text) => {
    const record = fixture();
    record.requests = [
      {
        ...request,
        request_headers: { "content-type": "application/x-www-form-urlencoded" },
        request_body: { state: "available", text },
        response_body: { state: "available", text: text.startsWith("{") ? text : "{}" },
      },
    ];
    const evidence = operationEvidence(record, save);
    expect(evidence.gaps).toContain("payload_partial");
    expect(evidence.fields[0].submitted).toEqual([
      { state: "payload_partial", source: request.id },
    ]);
    if (text.startsWith("{"))
      expect(evidence.fields[0].response).toEqual([
        { state: "payload_partial", source: request.id },
      ]);
    expect(evidence.payloads).toContainEqual(
      expect.objectContaining({ part: "request", value: "Bob" }),
    );
  });

  it("accepts a unique match when the scan ends exactly at its field limit", () => {
    const record = fixture();
    record.requests = [
      {
        ...request,
        request_body: {
          state: "available",
          text: JSON.stringify({
            displayName: "Bob",
            ...Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, i])),
          }),
        },
      },
    ];
    const evidence = operationEvidence(record, save);
    expect(evidence.gaps).not.toContain("payload_partial");
    expect(evidence.fields[0].submitted).toEqual([
      expect.objectContaining({ state: "available", value: "Bob" }),
    ]);
  });

  it("uses one window for request and console links, including running and delayed evidence", () => {
    const record = fixture();
    record.requests.push(
      { ...request, id: "late", started_at: 2500 },
      { ...request, id: "next", started_at: 3000 },
    );
    record.console = [320, 2500, 3000].map((at, index) => ({
      id: `c${index}`,
      at,
      last_at: at,
      level: "log",
      text: "log",
      count: 1,
    }));
    record.operations.push({ ...save, id: "d:a3", started_at: 3000 });
    const context = operationContext(record, save);
    expect(context.operation.request_ids).toEqual([request.id, "late"]);
    expect(context.operation.console_ids).toEqual(["c0", "c1"]);
    expect(context.console.map((entry) => entry.relation)).toEqual(["window", "delayed"]);
    expect(context.operation.truncated).toBe(false);
    record.run.dropped_requests = 1;
    expect(operationContext(record, save).operation.truncated).toBe(true);
    record.operations = [{ ...input, state: "running", finished_at: undefined }];
    record.saved_at = 2000;
    expect(operationContext(record, record.operations[0]).operation.request_ids).toEqual([
      request.id,
    ]);
  });
  it("does not retain credentials embedded in server-rendered input values", () => {
    for (const html of [
      '<input type="password" value="private">',
      '<input value="priv>ate" name="token">',
      "<input value='private' autocomplete='current-password'>",
      "<input name=secret value=private>",
    ]) {
      expect(redactBody(html, "text/html").text).not.toContain("priv");
    }
    expect(redactBody('<input name="nickname" value="Alice">', "text/html").text).toContain(
      "Alice",
    );
  });
  it("traces actual values through a slow request and reload without inventing a response value", () => {
    const evidence = operationEvidence(fixture(), save);
    expect(evidence.fields[0]).toMatchObject({
      before: { value: "Alice" },
      input: { value: "Bob" },
      submitted: [{ value: "Bob", source: "d:n1 /displayName" }],
      response: [],
      later: { value: "Alice", source: "page:reload" },
    });
    expect(evidence.payloads).toContainEqual({
      request_id: "d:n1",
      part: "response",
      path: "/success",
      value: "false",
    });
    expect(evidence.links).toEqual([{ request_id: "d:n1", relation: "window" }]);
  });
  it("marks delayed requests as tentative and cuts association at the next operation", () => {
    const record = fixture();
    record.requests.push(
      { ...request, id: "late", started_at: 2500 },
      { ...request, id: "next", started_at: 3000 },
    );
    record.operations.push({ ...save, id: "d:a3", started_at: 3000 });
    expect(operationEvidence(record, save).links).toEqual([
      { request_id: "d:n1", relation: "window" },
      { request_id: "late", relation: "delayed" },
    ]);
  });
  it("keeps replayed and unapplied controls out of the original operation's field chain", () => {
    for (const control of [
      { replay_from: "earlier" },
      { intervention: { rule_id: "r1", type: "block", state: "applied" } },
      { intervention: { rule_id: "r1", type: "modify", state: "failed" } },
      { intervention: { rule_id: "r1", type: "mock", state: "pending" } },
    ] as Partial<DebugRequest>[]) {
      const record = fixture();
      record.requests = [{ ...request, ...control }];
      const evidence = operationEvidence(record, save);
      expect(evidence.fields[0].submitted).toEqual([]);
      expect(evidence.fields[0].response).toEqual([]);
      expect(evidence.links).toHaveLength(1);
      expect(evidence.gaps).toContain(
        control.replay_from ? "request_replayed" : `control_${control.intervention?.type}`,
      );
    }
    const record = fixture();
    record.requests = [
      { ...request, intervention: { rule_id: "r1", type: "mock", state: "applied" } },
    ];
    const evidence = operationEvidence(record, save);
    expect(evidence.fields[0].submitted).toHaveLength(1);
    expect(evidence.gaps).toContain("control_mock");
  });
  it("uses the observed settled reload value rather than an empty loading form", () => {
    const record = fixture();
    record.pages = [{ ...page(10000, ""), navigation: "reload" }];
    record.operations.push({
      ...save,
      id: "d:a3",
      method: "tool.reload",
      started_at: 9900,
      after: page(12000, "Alice"),
    });
    expect(operationEvidence(record, save).fields[0].later).toMatchObject({
      value: "Alice",
      at: 12000,
      source: "page:reload",
    });
  });
  it("keeps ambiguous, missing and truncated values explicit instead of joining by value", () => {
    const record = fixture();
    record.requests = [
      {
        ...request,
        request_body: { state: "available", text: '{"name":"Bob"}' },
        response_body: { state: "truncated", text: '{"displayName":"Bo' },
      },
    ];
    let evidence = operationEvidence(record, save);
    expect(evidence.fields[0].submitted).toEqual([]);
    expect(evidence.fields[0].response).toEqual([{ state: "body_truncated", source: "d:n1" }]);
    expect(evidence.gaps).toContain("body_truncated");
    record.requests[0].response_body = {
      state: "available",
      text: '{"a":{"displayName":"Bob"},"b":{"displayName":"Alice"}}',
    };
    evidence = operationEvidence(record, save);
    expect(evidence.fields[0].response).toEqual([]);
    expect(evidence.payloads.filter((item) => item.part === "response")).toHaveLength(2);
  });
  it("does not reconstruct fields absent from older history and reports interrupted evidence", () => {
    const record = fixture();
    record.operations = [{ ...save, state: "interrupted", before: undefined, after: undefined }];
    record.run.coverage = ["initial_load_not_recorded", "interrupted_checkpoint"];
    const evidence = operationEvidence(record, record.operations[0]);
    expect(evidence.fields).toEqual([]);
    expect(evidence.gaps).toEqual(
      expect.arrayContaining([
        "operation_interrupted",
        "initial_load_not_recorded",
        "fields_partial",
        "after_unavailable",
      ]),
    );
  });
  it("classifies evidence by source and preserves unknown sources", () => {
    expect(requestKind({ ...request, url: "chrome-extension://abc/file.js" })).toBe("extension");
    expect(requestKind({ ...request, method: "GET", resource_type: "Image" })).toBe("resource");
    expect(consoleSource("chrome-extension://abc/a.js")).toBe("extension");
    expect(consoleSource("https://app.test/app.js")).toBe("website");
    expect(consoleSource()).toBe("unknown");
  });
  it("redacts sensitive fields again at the storage boundary and bounds field values", () => {
    const result = sanitizeFields({
      fields: [
        { key: "password", label: "Password", value: "private", state: "available" },
        { key: "bio", label: "Bio", value: "x".repeat(1000), state: "available" },
      ],
    });
    expect(result.fields[0]).toMatchObject({ state: "redacted" });
    expect(result.fields[0].value).toBeUndefined();
    expect(result.fields[1].value).toHaveLength(256);
  });
});
