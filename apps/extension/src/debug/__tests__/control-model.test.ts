import { describe, expect, it } from "vitest";
import {
  editRequest,
  publicRule,
  replayRequest,
  urlMatcher,
  validateReplay,
  validateRule,
} from "../control-model";
import { redactBody, redactRequestUrl } from "../redact";
import type { DebugRequest } from "../types";

const request = {
  url: "https://site.test/save",
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
  postData: '{"displayName":"张三","keep":1}',
};
const source = {
  run_id: "d",
  sequence: 1,
  started_at: 0,
  state: "complete",
  response_body: { state: "empty" },
  id: "d:n1",
  url: request.url,
  method: request.method,
  integrity: { url: "complete", metadata: "complete" },
  request_headers: {
    "content-type": "application/json",
    cookie: "[redacted]",
    authorization: "[redacted]",
  },
  request_body: { state: "available", replay_safe: true, text: '{"name":"张三"}' },
} as DebugRequest;
describe("bounded network rule inputs", () => {
  it("preserves untouched numeric tokens when editing or renaming other JSON fields", () => {
    const input = {
      ...request,
      postData:
        '{"id":9007199254740993,"nested":{"v":1.234567890123456789},"name":"Alice","zero":-0}',
    };
    const result = editRequest(input, {
      json: { rename: { id: "orderId" }, set: { name: "Bob" }, remove: ["zero"] },
    });
    expect(result.postData).toBe(
      '{"nested":{"v":1.234567890123456789},"name":"Bob","orderId":9007199254740993}',
    );
    expect(() =>
      editRequest({ ...request, postData: '{"id":1,"id":2}' }, { json: { set: { name: "Bob" } } }),
    ).toThrow("unique top-level keys");
    expect(() =>
      validateRule({
        match: { url: request.url },
        effect: { type: "modify", json: { set: { nested: { orderId: 9007199254740992 } } } },
      }),
    ).toThrow("exact text body replacement");
  });
  it("edits the live JSON without touching other fields or leaking prototype mutations", () => {
    const result = editRequest(request, {
      json: { rename: { displayName: "name" }, set: JSON.parse('{"__proto__":{"polluted":true}}') },
    });
    expect(JSON.parse(result.postData!)).toEqual(
      JSON.parse('{"keep":1,"name":"张三","__proto__":{"polluted":true}}'),
    );
    expect({}).not.toHaveProperty("polluted");
    expect(request.postData).toContain("displayName");
    expect(result.headers.authorization).toBe("Bearer secret");
    expect(() => editRequest(request, { json: { rename: { displayName: "keep" } } })).toThrow(
      "already exists",
    );
  });
  it("matches URLs literally except for explicit path wildcards", () => {
    const rule = validateRule({
      match: { url: "https://site.test/api/*?a=1" },
      effect: { type: "block" },
    });
    expect(urlMatcher(rule.match.url).test("https://site.test/api/save?a=1")).toBe(true);
    expect(urlMatcher(rule.match.url).test("https://siteXtest/api/saveXa=1")).toBe(false);
    for (const input of [
      { match: { url: "https://*.test/*" }, effect: { type: "block" } },
      {
        match: { url: "https://site.test/*" },
        effect: { type: "modify", url: "https://other.test/save" },
      },
      { match: { url: request.url }, effect: { type: "mock", status: 302, body: "" } },
      { match: { url: request.url }, effect: { type: "modify", headers: { "x-foo": "a\r\nb" } } },
      { match: { url: request.url }, effect: { type: "modify", body: "[redacted]" } },
      { match: { url: request.url }, effect: { type: "block" }, times: -1 },
      { match: { url: request.url }, effect: { type: "block" }, typo: true },
    ])
      expect(() => validateRule(input)).toThrow();
  });
  it("exports only redacted rule values while preserving the executable definition", () => {
    const rule = validateRule({
      match: { url: request.url },
      effect: {
        type: "modify",
        headers: { Authorization: "Bearer top-secret" },
        json: { set: { password: "private", name: "visible" } },
      },
    });
    const snapshot = JSON.stringify(publicRule(rule));
    expect(snapshot).not.toContain("top-secret");
    expect(snapshot).not.toContain("private");
    expect(snapshot).toContain("visible");
    expect(JSON.stringify(rule)).toContain("top-secret");
  });
});
describe("replay preparation", () => {
  const options = { key: "one", headers: { authorization: null } };
  it("replays the original 64-bit ID exactly and requires replacements for changed or legacy bodies", () => {
    const original = '{"orderId":9007199254740993,"action":"cancel"}';
    const retained = {
      ...source,
      request_body: { state: "available" as const, ...redactBody(original, "application/json") },
    };
    expect(replayRequest(retained, options, "https://site.test").postData).toBe(original);
    for (const body of [
      { state: "available" as const, text: '{"orderId":9007199254740992}' },
      {
        state: "available" as const,
        ...redactBody('{"id":1,"password":"hidden"}', "application/json"),
      },
      { state: "available" as const, text: "changed", redacted: true, replay_safe: true },
    ]) {
      const entry = { ...source, request_body: body };
      expect(() => replayRequest(entry, options, "https://site.test")).toThrow(
        "complete replacement body",
      );
      expect(
        replayRequest(entry, { ...options, body: original }, "https://site.test").postData,
      ).toBe(original);
    }
  });

  it("requires a full replacement URL after truncation and still rejects incomplete headers", () => {
    const original = `https://site.test/save?q=${"x".repeat(2200)}&mode=dry-run`;
    const url = redactRequestUrl(original);
    expect(url.state).toBe("truncated");
    expect(url.text).toHaveLength(2048);
    const entry: DebugRequest = {
      ...source,
      url: url.text,
      truncated: true,
      integrity: { url: url.state, metadata: "complete" },
    };
    expect(() => replayRequest(entry, options, "https://site.test")).toThrow("replacement URL");
    const replacement = validateReplay({ ...options, url: original });
    expect(replayRequest(entry, replacement, "https://site.test").url).toBe(original);
    expect(() =>
      replayRequest(
        { ...entry, integrity: { ...entry.integrity!, metadata: "truncated" } },
        replacement,
        "https://site.test",
      ),
    ).toThrow("source request is incomplete");
    expect(() =>
      replayRequest(
        { ...entry, integrity: undefined, truncated: false },
        options,
        "https://site.test",
      ),
    ).toThrow("replacement URL");
  });
  it("requires missing secrets to be supplied, but lets the browser supply cookies", () => {
    expect(() => replayRequest(source, { key: "one" }, "https://site.test")).toThrow(
      "redacted header",
    );
    const replay = replayRequest(
      source,
      { key: "one", headers: { authorization: null } },
      "https://site.test/#/profile",
    );
    expect(replay.headers).not.toHaveProperty("cookie");
    expect(replay.headers).not.toHaveProperty("authorization");
    expect(replay.postData).toContain("张三");
  });
  it("rejects incomplete bodies, foreign origins, unsafe headers and unknown options", () => {
    expect(() =>
      replayRequest(
        { ...source, request_body: { state: "truncated" } },
        { key: "one", headers: { authorization: null } },
        "https://site.test",
      ),
    ).toThrow("complete replacement");
    expect(() =>
      replayRequest(source, { key: "one", url: "https://other.test/save" }, "https://site.test"),
    ).toThrow("share an origin");
    expect(() => validateReplay({ key: "one", headers: { Host: "other.test" } })).toThrow(
      "unsupported header",
    );
    expect(() => validateReplay({ key: "one", json: { set: { name: "Bob" } } })).toThrow("unknown");
    expect(() => validateReplay({})).toThrow("key");
  });
});
