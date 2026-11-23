import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rootEventSource,
  type TabEventSource,
  targetEventSource,
} from "@/browser-driver/frame-handles";
import type { DebugCdp } from "../manager";
import { DebugNetworkControl } from "../network-control";
import { DebugNetworkStore } from "../network-store";
import type { DebugRuleSpec } from "../types";

const ROOT = rootEventSource(7);
const CHILD = targetEventSource(7, "oopif:child");

function fixture() {
  let owned = true,
    sequence = 0;
  const sendToEventSource = vi.fn(async (_target: TabEventSource, method: string) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    return {};
  });
  const cdp = {
    sendToEventSource: sendToEventSource,
    ensureNetworkCapture: vi.fn(),
  } as unknown as DebugCdp;
  const network = new DebugNetworkStore("d1", cdp, () => ++sequence);
  const controls = new DebugNetworkControl(
    "d1",
    7,
    cdp,
    network,
    () => {
      sequence++;
    },
    () => owned,
  );
  const event = (id: string, body = '{"name":"Alice"}', target: TabEventSource = ROOT) => {
    network.onEvent(target, "Network.requestWillBeSent", {
      requestId: id,
      type: "Fetch",
      request: {
        url: "https://site.test/save",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: body,
      },
    });
    controls.onEvent(target, "Fetch.requestPaused", {
      requestId: `fetch-${id}`,
      networkId: id,
      resourceType: "Fetch",
      request: {
        url: "https://site.test/save",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: body,
      },
    });
  };
  return {
    controls,
    network,
    sendToEventSource,
    event,
    release: () => {
      owned = false;
    },
  };
}
const mock: DebugRuleSpec = {
  match: { url: "https://site.test/save", method: "POST" },
  effect: { type: "mock", status: 200, body: '{"name":"Mock"}', delay_ms: 10000 },
};
afterEach(() => vi.useRealTimers());
describe("local request control lifecycle", () => {
  it("continues a large request unchanged when only adding a header", async () => {
    const f = fixture();
    await f.controls.target(ROOT);
    await f.controls.add({
      match: mock.match,
      effect: { type: "modify", headers: { "x-debug": "1" } },
    });
    f.event("large", "x".repeat(65537));
    await vi.waitFor(() => expect(f.controls.list()[0].state).toBe("exhausted"));
    await vi.waitFor(() =>
      expect(f.sendToEventSource).toHaveBeenCalledWith(ROOT, "Fetch.continueRequest", {
        requestId: "fetch-large",
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "x-debug", value: "1" },
        ],
      }),
    );
    expect(
      f.sendToEventSource.mock.calls.some(([, method]) => method === "Fetch.failRequest"),
    ).toBe(false);
    await f.controls.stop();
  });

  it("has no Fetch subscription until a rule exists and attaches rules to child targets", async () => {
    const f = fixture();
    await f.controls.target(ROOT);
    expect(f.sendToEventSource).not.toHaveBeenCalled();
    await f.controls.add({ ...mock, effect: { type: "block" }, times: 0 });
    await f.controls.target(CHILD);
    expect(f.sendToEventSource).toHaveBeenCalledWith(CHILD, "Fetch.enable", expect.anything());
    await f.controls.stop();
    expect(f.sendToEventSource).toHaveBeenCalledWith(ROOT, "Fetch.disable");
    expect(f.sendToEventSource).toHaveBeenCalledWith(CHILD, "Fetch.disable");
  });
  it("does not widen default Fetch/XHR rules when another rule intercepts Documents", async () => {
    const f = fixture();
    await f.controls.target(ROOT);
    await f.controls.add({ ...mock, effect: { type: "mock", status: 200, body: "{}" }, times: 0 });
    await f.controls.add({
      match: { ...mock.match, resource_type: "Document" },
      effect: { type: "block" },
    });
    f.controls.onEvent(ROOT, "Fetch.requestPaused", {
      requestId: "doc",
      networkId: "doc",
      resourceType: "Document",
      request: { url: mock.match.url, method: "POST", headers: {} },
    });
    await vi.waitFor(() =>
      expect(f.sendToEventSource).toHaveBeenCalledWith(ROOT, "Fetch.failRequest", {
        requestId: "doc",
        errorReason: "BlockedByClient",
      }),
    );
    expect(f.controls.list().map((rule) => rule.hits)).toEqual([0, 1]);
    await f.controls.stop();
  });
  it("reserves a one-shot rule synchronously so concurrent requests do not both consume it", async () => {
    const f = fixture();
    await f.controls.target(ROOT);
    await f.controls.add({ ...mock, effect: { type: "block" } });
    f.event("one");
    f.event("two");
    await vi.waitFor(() =>
      expect(f.sendToEventSource).toHaveBeenCalledWith(ROOT, "Fetch.failRequest", {
        requestId: "fetch-one",
        errorReason: "BlockedByClient",
      }),
    );
    expect(f.sendToEventSource).toHaveBeenCalledWith(ROOT, "Fetch.continueRequest", {
      requestId: "fetch-two",
    });
    expect(f.controls.list()[0]).toMatchObject({ state: "exhausted", hits: 1 });
    await f.controls.stop();
  });
  it("cancels a delayed mock on disable and does not fall through to the real server", async () => {
    const f = fixture();
    await f.controls.target(ROOT);
    await f.controls.add(mock);
    f.event("one");
    await Promise.resolve();
    await f.controls.update("d1:r1", "rule_disable");
    expect(f.sendToEventSource).not.toHaveBeenCalledWith(
      expect.anything(),
      "Fetch.fulfillRequest",
      expect.anything(),
    );
    expect(f.sendToEventSource).toHaveBeenCalledWith(ROOT, "Fetch.failRequest", {
      requestId: "fetch-one",
      errorReason: "Aborted",
    });
    expect(f.network.list()[0].intervention).toMatchObject({ type: "mock", state: "cancelled" });
    await f.controls.stop();
  });
  it("aborts on invalid JSON transformations instead of sending a partially edited request", async () => {
    const f = fixture();
    await f.controls.target(ROOT);
    await f.controls.add({
      match: mock.match,
      effect: { type: "modify", json: { rename: { missing: "name" } } },
    });
    f.event("one");
    await vi.waitFor(() => expect(f.controls.list()[0].failures).toBe(1));
    expect(f.sendToEventSource).not.toHaveBeenCalledWith(
      expect.anything(),
      "Fetch.continueRequest",
      expect.anything(),
    );
    expect(f.network.list()[0].intervention?.state).toBe("failed");
    await f.controls.stop();
  });
  it("disables partially enabled interception after a failed configuration", async () => {
    const f = fixture();
    await f.controls.target(ROOT);
    f.sendToEventSource.mockRejectedValueOnce(new Error("failed"));
    await expect(f.controls.add(mock)).rejects.toThrow("configuration failed");
    expect(f.controls.list()[0].state).toBe("disabled");
    expect(f.sendToEventSource).toHaveBeenCalledWith(ROOT, "Fetch.disable");
    await f.controls.stop();
  });
  it("rolls back a cancelled rule setup and rejects writes after task ownership is lost", async () => {
    const f = fixture();
    await f.controls.target(ROOT);
    const ac = new AbortController();
    let release: () => void = () => {};
    f.sendToEventSource.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({});
        }),
    );
    const adding = f.controls.add(mock, ac.signal);
    await vi.waitFor(() => expect(f.sendToEventSource).toHaveBeenCalled());
    ac.abort();
    release();
    await expect(adding).rejects.toThrow("cancelled");
    expect(f.controls.list()[0].state).toBe("disabled");
    f.release();
    await expect(f.controls.add(mock)).rejects.toThrow("task-owned");
    await f.controls.stop();
  });
  it("keeps executable secrets out of request annotations and saved rule definitions", async () => {
    const f = fixture();
    await f.controls.target(ROOT);
    await f.controls.add({
      match: mock.match,
      effect: {
        type: "modify",
        headers: { Authorization: "Bearer private-value" },
        json: { set: { password: "hidden-value", name: "Bob" } },
      },
    });
    f.event("one");
    await vi.waitFor(() => expect(f.network.list()[0].intervention?.state).toBe("applied"));
    const saved = JSON.stringify({ rules: f.controls.list(), requests: f.network.list() });
    expect(saved).not.toContain("private-value");
    expect(saved).not.toContain("hidden-value");
    const command = f.sendToEventSource.mock.calls.find(
      (call) => call[1] === "Fetch.continueRequest",
    );
    expect(JSON.stringify(command)).toContain("private-value");
    await f.controls.stop();
  });
  it("rolls back re-enabling a rule if the agent action is cancelled during setup", async () => {
    const f = fixture();
    await f.controls.target(ROOT);
    await f.controls.add(mock);
    await f.controls.update("d1:r1", "rule_disable");
    f.sendToEventSource.mockClear();
    const ac = new AbortController();
    let release: () => void = () => {};
    f.sendToEventSource.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({});
        }),
    );
    const enabling = f.controls.update("d1:r1", "rule_enable", ac.signal);
    await vi.waitFor(() => expect(f.sendToEventSource).toHaveBeenCalled());
    ac.abort();
    release();
    await expect(enabling).rejects.toThrow("cancelled");
    expect(f.controls.list()[0].state).toBe("disabled");
    expect(f.sendToEventSource).toHaveBeenCalledWith(ROOT, "Fetch.disable");
    await f.controls.stop();
  });

  it("preserves pending mock and modify annotations when Fetch.requestPaused settles before Network.requestWillBeSent", async () => {
    const f = fixture();
    await f.controls.target(ROOT);
    await f.controls.add({
      match: { url: "https://site.test/mocked", method: "GET" },
      effect: {
        type: "mock",
        status: 201,
        headers: { "content-type": "application/json", "x-mock": "yes" },
        body: '{"mocked":true}',
      },
    });
    await f.controls.add({
      match: { url: "https://site.test/modified", method: "POST" },
      effect: {
        type: "modify",
        headers: { "x-edited": "1" },
        json: { set: { role: "admin" } },
      },
    });

    // Emit Fetch.requestPaused BEFORE Network.requestWillBeSent for both rules and wait for apply()'s finally().
    f.controls.onEvent(ROOT, "Fetch.requestPaused", {
      requestId: "fetch-mock-first",
      networkId: "net-mock-first",
      resourceType: "Fetch",
      request: { url: "https://site.test/mocked", method: "GET", headers: {} },
    });
    f.controls.onEvent(ROOT, "Fetch.requestPaused", {
      requestId: "fetch-mod-first",
      networkId: "net-mod-first",
      resourceType: "Fetch",
      request: {
        url: "https://site.test/modified",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: '{"role":"user"}',
      },
    });
    await vi.waitFor(() => {
      expect(f.sendToEventSource).toHaveBeenCalledWith(
        ROOT,
        "Fetch.fulfillRequest",
        expect.objectContaining({ requestId: "fetch-mock-first" }),
      );
      expect(f.sendToEventSource).toHaveBeenCalledWith(
        ROOT,
        "Fetch.continueRequest",
        expect.objectContaining({ requestId: "fetch-mod-first" }),
      );
    });
    // Allow apply()'s finally block annotate() call to finish before requestWillBeSent arrives.
    await Promise.resolve();
    await Promise.resolve();

    f.network.onEvent(ROOT, "Network.requestWillBeSent", {
      requestId: "net-mock-first",
      type: "Fetch",
      request: { url: "https://site.test/mocked", method: "GET", headers: {} },
    });
    f.network.onEvent(ROOT, "Network.requestWillBeSent", {
      requestId: "net-mod-first",
      type: "Fetch",
      request: {
        url: "https://site.test/modified",
        method: "POST",
        headers: { "content-type": "application/json" },
        postData: '{"role":"user"}',
      },
    });

    const entries = f.network.list();
    const mocked = entries.find((entry) => entry.url === "https://site.test/mocked");
    expect(mocked).toMatchObject({
      status: 201,
      mime_type: "application/json",
      response_headers: { "content-type": "application/json", "x-mock": "yes" },
      response_body: { state: "available", text: '{"mocked":true}' },
      intervention: { type: "mock", state: "applied" },
    });

    const modified = entries.find((entry) => entry.url === "https://site.test/modified");
    expect(modified).toMatchObject({
      request_headers: expect.objectContaining({ "x-edited": "1" }),
      request_body: { state: "available", text: '{"role":"admin"}' },
      intervention: { type: "modify", state: "applied" },
    });

    await f.controls.stop();
  });
});
