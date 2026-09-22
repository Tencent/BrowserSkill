import { describe, expect, it, vi } from "vitest";
import { replayRequest } from "../control-model";
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
  it.each([
    "response",
    "extra-first",
    "extra-last",
    "mock",
  ])("keeps response header loss separate from replay integrity: %s", (path) => {
    const f = fixture();
    const headers = { "content-security-policy": "x".repeat(3000) };
    if (path === "extra-first") f.event("responseReceivedExtraInfo", { headers });
    if (path === "mock")
      f.store.annotate({ tabId: 7 }, "raw", { mock: { status: 200, headers, body: "{}" } });
    f.request({
      request: { url: "https://site.test/save", method: "GET", headers: { mode: "dry-run" } },
    });
    f.response({
      response: { status: 200, headers: path === "response" ? headers : {} },
      hasExtraInfo: path.startsWith("extra"),
    });
    if (path === "extra-last") f.event("responseReceivedExtraInfo", { headers });
    const entry = f.store.list()[0];
    expect(entry).toMatchObject({
      truncated: true,
      integrity: { metadata: "complete", response_headers: "truncated" },
    });
    expect(replayRequest(entry, { key: "read" }, "https://site.test")).toMatchObject({
      url: entry.url,
      method: "GET",
      headers: { mode: "dry-run" },
    });
  });

  it.each([
    "request",
    "extra-first",
    "extra-last",
    "annotation",
  ])("retains actual header loss and rejects replay (%s)", (path) => {
    const f = fixture();
    const headers = {
      "x-a": "a".repeat(2040),
      "x-b": "b".repeat(2031),
      Cookie: "x",
      mode: "dry-run",
    };
    expect(
      Object.entries(headers).reduce((n, [key, value]) => n + key.length + value.length, 0),
    ).toBe(4095);
    if (path === "extra-first") f.event("requestWillBeSentExtraInfo", { headers });
    if (path === "annotation")
      f.store.annotate({ tabId: 7 }, "raw", {
        effective: { url: "https://site.test/save", method: "GET", headers },
      });
    f.request({
      request: {
        url: "https://site.test/save",
        method: "GET",
        headers: path === "request" ? headers : {},
      },
    });
    if (path === "extra-last") f.event("requestWillBeSentExtraInfo", { headers });
    f.response({ hasExtraInfo: path.startsWith("extra") });
    const entry = f.store.list()[0];
    expect(entry).toMatchObject({ truncated: true, integrity: { metadata: "truncated" } });
    expect(() => replayRequest(entry, { key: "try" }, "https://site.test")).toThrow(
      "source request is incomplete",
    );
  });

  it("retains URL integrity in request metadata, including annotations arriving before events", () => {
    const f = fixture();
    const url = `https://site.test/save?q=${"x".repeat(2200)}&mode=dry-run`;
    f.request({ request: { url, method: "GET" } });
    expect(requestProjection(f.store.list()[0])).toMatchObject({
      truncated: true,
      integrity: { url: "truncated", metadata: "complete" },
      request_body: { state: "empty", replay_safe: true },
    });
    const second = fixture();
    second.store.annotate({ tabId: 7 }, "raw", { effective: { url, method: "GET", headers: {} } });
    second.request();
    expect(second.store.list()[0]).toMatchObject({
      truncated: true,
      url: url.slice(0, 2048),
      integrity: { url: "truncated" },
    });
  });

  it("keeps nested form secrets out of retained evidence and preserves numeric IDs in detail slices", () => {
    const f = fixture();
    f.request({
      request: {
        url: "https://site.test",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        postData:
          "user[password]=private&credentials.password=private&password_confirmation=private&orderId=9007199254740993",
      },
    });
    const entry = f.store.list()[0];
    expect(entry.request_body).toMatchObject({
      state: "available",
      redacted: true,
      replay_safe: false,
    });
    expect(JSON.stringify(entry)).not.toContain("private");
    expect(entry.request_body.text).toContain("9007199254740993");
    expect(
      bodySlice({ state: "available", text: '{"id":9007199254740993}' }, 0, 100, "/id").text,
    ).toBe("9007199254740993");
  });
  it("preserves truncation and redaction when control annotations precede network events", () => {
    const f = fixture();
    const base = JSON.stringify({ password: "pwd", values: "" });
    const body = JSON.stringify({
      password: "pwd",
      values: "a".repeat(BODY_CHARS - base.length - 1),
    });
    expect(body.length).toBeLessThan(BODY_CHARS);
    f.store.annotate({ tabId: 7 }, "raw", {
      intervention: { rule_id: "r1", type: "mock", state: "applied" },
      effective: {
        url: "https://site.test/api",
        method: "POST",
        headers: { "content-type": "application/json", "x-large": "x".repeat(3000) },
        postData: body,
      },
      mock: { status: 200, headers: { "content-type": "application/json" }, body },
    });
    f.request();
    const entry = f.store.list()[0];
    for (const retained of [entry.request_body, entry.response_body]) {
      expect(retained.state).toBe("truncated");
      expect(retained.redacted).toBe(true);
      expect(retained.text).not.toContain('"password":"pwd"');
    }
    expect(entry.truncated).toBe(true);
  });

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
    expect(entry.response_body.text).toContain('"ok":false');
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
    expect(f.store.entries.size).toBe(MAX_REQUESTS);
    expect(f.store.list()).toHaveLength(215); // Pending requests keep their CDP identities.
    expect(f.store.dropped).toBe(15);
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
