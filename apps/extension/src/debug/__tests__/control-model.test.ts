import { describe, expect, it } from "vitest";
import {
  editRequest,
  publicRule,
  replayRequest,
  urlMatcher,
  validateReplay,
  validateRule,
} from "../control-model";
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
  request_headers: {
    "content-type": "application/json",
    cookie: "[redacted]",
    authorization: "[redacted]",
  },
  request_body: { state: "available", text: '{"name":"张三"}' },
} as DebugRequest;
describe("bounded network rule inputs", () => {
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
