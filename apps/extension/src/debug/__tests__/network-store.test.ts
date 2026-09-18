import { describe, expect, it, vi } from "vitest";
import { bodySlice, DebugNetworkStore, MAX_REQUESTS, requestProjection } from "../network-store";
import { BODY_CHARS, redactBody, redactHeaders, redactText, redactUrl } from "../redact";

function fixture(
  send = vi.fn(async () => ({ body: '{"ok":false,"token":"secret","data":{"name":"Alice"}}' })),
) {
  let sequence = 0;
  let now = 1000;
  const store = new DebugNetworkStore(
    "d1",
    { send: send as never },
    () => ++sequence,
    () => now++,
  );
  const event = (method: string, data: object, sessionId?: string) =>
    store.onEvent({ tabId: 7, ...(sessionId ? { sessionId } : {}) }, `Network.${method}`, {
      requestId: "raw",
      timestamp: now / 1000,
      ...data,
    });
  const request = (data = {}, sessionId?: string) =>
    event(
      "requestWillBeSent",
      {
        type: "Fetch",
        request: {
          url: "https://site.test/api?token=private&item=1",
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
          postData: '{"password":"hidden","item":1}',
        },
        ...data,
      },
      sessionId,
    );
  const response = (data = {}, sessionId?: string) =>
    event(
      "responseReceived",
      {
        response: {
          status: 200,
          mimeType: "application/json",
          headers: { "Set-Cookie": "secret" },
        },
        ...data,
      },
      sessionId,
    );
  const finish = (sessionId?: string) =>
    event("loadingFinished", { encodedDataLength: 40 }, sessionId);
  return { store, event, request, response, finish, send };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("debug network evidence", () => {
  it("bounds long redirect chains and does not misassign late extra headers after eviction", () => {
    const f = fixture();
    f.request();
    for (let i = 0; i < 220; i++)
      f.request({ redirectResponse: { status: 302 }, redirectHasExtraInfo: true });
    f.event("requestWillBeSentExtraInfo", { headers: { "x-old-hop": "must-not-migrate" } });
    expect(f.store.list()).toHaveLength(MAX_REQUESTS);
    expect(f.store.list().some((entry) => entry.request_headers?.["x-old-hop"])).toBe(false);
    expect(f.store.list().at(-1)?.truncated).toBe(true);
  });

  it("retains HTTP 200 business failures and exposes bounded body projections with JSON pointers", async () => {
    const f = fixture();
    f.request();
    f.response();
    f.finish();
    await settle();
    const entry = f.store.list()[0];
    expect(entry.state).toBe("complete");
    expect(entry.status).toBe(200);
    expect(entry.url).not.toContain("private");
    expect(entry.request_headers?.authorization).toBe("[redacted]");
    expect(entry.request_body.text).not.toContain("hidden");
    expect(entry.response_body.text).toContain('"ok": false');
    expect(entry.response_body.text).not.toContain("secret");
    const summary = requestProjection(entry);
    expect(summary.response_body.text).toBeUndefined();
    expect(summary.request_headers).toBeUndefined();
    expect(requestProjection(entry, "response", 0, 100, "/data/name").response_body.text).toBe(
      '"Alice"',
    );
    expect(requestProjection(entry, "response", 0, 5).response_body.next_offset).toBe(5);
    expect(f.send).toHaveBeenCalledWith(7, "Network.getResponseBody", { requestId: "raw" });
  });

  it("correlates out-of-order ExtraInfo with redirect hops without mixing headers", () => {
    const f = fixture();
    f.event("requestWillBeSentExtraInfo", { headers: { "x-hop": "first" } });
    f.request();
    f.event("responseReceivedExtraInfo", {
      headers: { location: "/next", "Set-Cookie": "secret" },
    });
    f.request({ redirectResponse: { status: 302 }, redirectHasExtraInfo: true });
    f.event("requestWillBeSentExtraInfo", { headers: { "x-hop": "second" } });
    f.response({ hasExtraInfo: true });
    f.event("responseReceivedExtraInfo", { headers: { "x-result": "final" } });
    const [first, second] = f.store.list();
    expect(first.state).toBe("redirected");
    expect(first.request_headers?.["x-hop"]).toBe("first");
    expect(first.response_headers?.location).toBe("/next");
    expect(second.request_headers?.["x-hop"]).toBe("second");
    expect(second.response_headers?.["x-result"]).toBe("final");
    expect(second.redirect_from).toBe(first.id);
    expect(first.response_body).toMatchObject({ state: "unavailable", reason: "redirect" });
  });

  it("does not assign the next hop's extra headers to a redirect without ExtraInfo", () => {
    const f = fixture();
    f.request();
    f.event("requestWillBeSentExtraInfo", { headers: { "x-hop": "second" } });
    f.request({ redirectResponse: { status: 301 }, redirectHasExtraInfo: false });
    f.response({ hasExtraInfo: true });
    const [first, second] = f.store.list();
    expect(first.request_headers?.["x-hop"]).toBeUndefined();
    expect(second.request_headers?.["x-hop"]).toBe("second");
  });

  it("separates identical request IDs across root and child targets", () => {
    const f = fixture();
    f.request();
    f.request({}, "child");
    f.event("loadingFailed", { errorText: "net::ERR_FAILED" }, "child");
    expect(f.store.list().map((entry) => entry.state)).toEqual(["pending", "failed"]);
    expect(f.store.list()[1].response_body.reason).toBe("request_failed");
  });

  it("records cached/service-worker responses, skips binary and empty bodies", async () => {
    const f = fixture();
    f.request();
    f.response({
      response: {
        status: 200,
        mimeType: "image/png",
        fromDiskCache: true,
        fromServiceWorker: true,
      },
    });
    f.finish();
    await settle();
    expect(f.store.list()[0]).toMatchObject({
      from_cache: true,
      from_service_worker: true,
      response_body: { state: "omitted", reason: "non_text" },
    });
    f.request({ requestId: "empty", request: { url: "https://site.test", method: "HEAD" } });
    f.event("loadingFinished", { requestId: "empty" });
    expect(f.store.list()[1].response_body.state).toBe("empty");
    expect(f.send).not.toHaveBeenCalled();
  });

  it("marks unavailable browser buffers and does not pretend truncated structured bodies are complete", async () => {
    const failing = fixture(
      vi.fn(async () => {
        throw new Error("No resource");
      }),
    );
    failing.request();
    failing.response();
    failing.finish();
    await settle();
    expect(failing.store.list()[0].response_body).toMatchObject({ state: "unavailable" });
    const large = fixture(
      vi.fn(async () => ({ body: JSON.stringify({ token: "x".repeat(BODY_CHARS) }) })),
    );
    large.request();
    large.response();
    large.finish();
    await settle();
    expect(large.store.list()[0].response_body).toMatchObject({ state: "truncated", text: "" });
  });

  it("bounds concurrent body reads and ignores in-flight completions after stop", async () => {
    let resolve!: (value: { body: string }) => void;
    const promise = new Promise<{ body: string }>((done) => {
      resolve = done;
    });
    const f = fixture(vi.fn(() => promise));
    for (let i = 0; i < 50; i++) {
      f.request({ requestId: String(i) });
      f.response({ requestId: String(i) });
      f.event("loadingFinished", { requestId: String(i) });
    }
    expect(f.send).toHaveBeenCalledTimes(4);
    expect(f.store.list().some((entry) => entry.response_body.reason === "capture_busy")).toBe(
      true,
    );
    f.store.stop("requested");
    resolve({ body: "late secret" });
    await settle();
    expect(f.send).toHaveBeenCalledTimes(4);
    expect(f.store.list().every((entry) => entry.response_body.text === undefined)).toBe(true);
    f.request();
    expect(f.store.list()).toHaveLength(50);
  });

  it("evicts old records and bodies within a fixed memory budget", async () => {
    const f = fixture(vi.fn(async () => ({ body: "x".repeat(60000) })));
    for (let i = 0; i < 15; i++) {
      f.request({ requestId: String(i) });
      f.response({ requestId: String(i), response: { status: 200, mimeType: "text/plain" } });
      f.event("loadingFinished", { requestId: String(i) });
      await settle();
    }
    expect(f.store.list().some((entry) => entry.response_body.state === "evicted")).toBe(true);
    expect(
      f.store
        .list()
        .reduce(
          (sum, entry) =>
            sum + (entry.response_body.text?.length ?? 0) + (entry.request_body.text?.length ?? 0),
          0,
        ),
    ).toBeLessThanOrEqual(512 * 1024);
    for (let i = 15; i < 230; i++) f.request({ requestId: String(i) });
    expect(f.store.list()).toHaveLength(MAX_REQUESTS);
    expect(f.store.dropped).toBe(30);
    expect(f.store.get("d1:n1")).toBeUndefined();
  });

  it("decodes UTF-8 base64 bodies without corrupting text", async () => {
    const f = fixture(
      vi.fn(async () => ({
        body: btoa(String.fromCharCode(...new TextEncoder().encode('{"message":"保存失败"}'))),
        base64Encoded: true,
      })),
    );
    f.request();
    f.response();
    f.finish();
    await settle();
    expect(f.store.list()[0].response_body.text).toContain("保存失败");
  });
});

describe("redaction and projections", () => {
  it("redacts quoted secrets containing spaces and reports depth truncation", () => {
    expect(redactText('password="private words" token="more private words')).not.toMatch(
      /private|words/,
    );
    let value: unknown = { ok: true };
    for (let i = 0; i < 30; i++) value = { child: value };
    expect(redactBody(JSON.stringify(value), "application/json").truncated).toBe(true);
  });
  it("marks in-flight frame requests as interrupted without affecting the root", () => {
    const f = fixture();
    f.request();
    f.request({}, "child");
    f.store.detachTarget("child");
    expect(f.store.list().map((entry) => entry.state)).toEqual(["pending", "interrupted"]);
  });

  it("scrubs nested JSON, forms, URL credentials and malformed quoted assignments", () => {
    expect(redactHeaders({ AUTHORIZATION: "Bearer x", Cookie: "sid=abc" })).toEqual({
      authorization: "[redacted]",
      cookie: "[redacted]",
    });
    expect(redactUrl("https://user:password@example.com/a?access_token=hidden#secret")).not.toMatch(
      /user|password|hidden|secret/,
    );
    expect(
      redactBody('{"a":[{"password":"hidden"}],"ok":false}', "application/json").text,
    ).not.toContain("hidden");
    expect(
      redactBody("password=hidden&name=Alice", "application/x-www-form-urlencoded").text,
    ).not.toContain("hidden");
    expect(redactText('{"password": "hidden", "token":"private"')).not.toMatch(/hidden|private/);
  });
  it("refuses incomplete JSON pointers and inherited property access", () => {
    expect(() => bodySlice({ state: "truncated", text: "{}" }, 0, 30, "/x")).toThrow("complete");
    expect(() => bodySlice({ state: "available", text: "{}" }, 0, 30, "/constructor")).toThrow(
      "not found",
    );
    expect(
      bodySlice({ state: "available", text: '{"a/b":{"~":true}}' }, 0, 30, "/a~1b/~0").text,
    ).toBe("true");
  });
});
