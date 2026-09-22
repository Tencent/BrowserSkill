import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpDebuggee } from "@/browser-driver/chromium-cdp";
import type { DebugCdp } from "../manager";
import { DebugNetworkControl } from "../network-control";
import { DebugNetworkStore } from "../network-store";
import type { DebugRuleSpec } from "../types";

function fixture() {
  let owned = true,
    sequence = 0;
  const sendAttached = vi.fn(async (_target: CdpDebuggee, method: string) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    return {};
  });
  const cdp = { sendAttached, send: vi.fn(), ensureNetworkCapture: vi.fn() } as unknown as DebugCdp;
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
  const event = (id: string, body = '{"name":"Alice"}', target = { tabId: 7 }) => {
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
    sendAttached,
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
    await f.controls.target({ tabId: 7 });
    await f.controls.add({
      match: mock.match,
      effect: { type: "modify", headers: { "x-debug": "1" } },
    });
    f.event("large", "x".repeat(65537));
    await vi.waitFor(() => expect(f.controls.list()[0].state).toBe("exhausted"));
    await vi.waitFor(() =>
      expect(f.sendAttached).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.continueRequest", {
        requestId: "fetch-large",
        headers: [
          { name: "content-type", value: "application/json" },
          { name: "x-debug", value: "1" },
        ],
      }),
    );
    expect(f.sendAttached.mock.calls.some(([, method]) => method === "Fetch.failRequest")).toBe(
      false,
    );
    await f.controls.stop();
  });

  it("has no Fetch subscription until a rule exists and attaches rules to child targets", async () => {
    const f = fixture();
    await f.controls.target({ tabId: 7 });
    expect(f.sendAttached).not.toHaveBeenCalled();
    await f.controls.add({ ...mock, effect: { type: "block" }, times: 0 });
    await f.controls.target({ tabId: 7, sessionId: "child" });
    expect(f.sendAttached).toHaveBeenCalledWith(
      { tabId: 7, sessionId: "child" },
      "Fetch.enable",
      expect.anything(),
    );
    await f.controls.stop();
    expect(f.sendAttached).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.disable");
    expect(f.sendAttached).toHaveBeenCalledWith({ tabId: 7, sessionId: "child" }, "Fetch.disable");
  });
  it("does not widen default Fetch/XHR rules when another rule intercepts Documents", async () => {
    const f = fixture();
    await f.controls.target({ tabId: 7 });
    await f.controls.add({ ...mock, effect: { type: "mock", status: 200, body: "{}" }, times: 0 });
    await f.controls.add({
      match: { ...mock.match, resource_type: "Document" },
      effect: { type: "block" },
    });
    f.controls.onEvent({ tabId: 7 }, "Fetch.requestPaused", {
      requestId: "doc",
      networkId: "doc",
      resourceType: "Document",
      request: { url: mock.match.url, method: "POST", headers: {} },
    });
    await vi.waitFor(() =>
      expect(f.sendAttached).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.failRequest", {
        requestId: "doc",
        errorReason: "BlockedByClient",
      }),
    );
    expect(f.controls.list().map((rule) => rule.hits)).toEqual([0, 1]);
    await f.controls.stop();
  });
  it("reserves a one-shot rule synchronously so concurrent requests do not both consume it", async () => {
    const f = fixture();
    await f.controls.target({ tabId: 7 });
    await f.controls.add({ ...mock, effect: { type: "block" } });
    f.event("one");
    f.event("two");
    await vi.waitFor(() =>
      expect(f.sendAttached).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.failRequest", {
        requestId: "fetch-one",
        errorReason: "BlockedByClient",
      }),
    );
    expect(f.sendAttached).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.continueRequest", {
      requestId: "fetch-two",
    });
    expect(f.controls.list()[0]).toMatchObject({ state: "exhausted", hits: 1 });
    await f.controls.stop();
  });
  it("cancels a delayed mock on disable and does not fall through to the real server", async () => {
    const f = fixture();
    await f.controls.target({ tabId: 7 });
    await f.controls.add(mock);
    f.event("one");
    await Promise.resolve();
    await f.controls.update("d1:r1", "rule_disable");
    expect(f.sendAttached).not.toHaveBeenCalledWith(
      expect.anything(),
      "Fetch.fulfillRequest",
      expect.anything(),
    );
    expect(f.sendAttached).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.failRequest", {
      requestId: "fetch-one",
      errorReason: "Aborted",
    });
    expect(f.network.list()[0].intervention).toMatchObject({ type: "mock", state: "cancelled" });
    await f.controls.stop();
  });
  it("aborts on invalid JSON transformations instead of sending a partially edited request", async () => {
    const f = fixture();
    await f.controls.target({ tabId: 7 });
    await f.controls.add({
      match: mock.match,
      effect: { type: "modify", json: { rename: { missing: "name" } } },
    });
    f.event("one");
    await vi.waitFor(() => expect(f.controls.list()[0].failures).toBe(1));
    expect(f.sendAttached).not.toHaveBeenCalledWith(
      expect.anything(),
      "Fetch.continueRequest",
      expect.anything(),
    );
    expect(f.network.list()[0].intervention?.state).toBe("failed");
    await f.controls.stop();
  });
  it("disables partially enabled interception after a failed configuration", async () => {
    const f = fixture();
    await f.controls.target({ tabId: 7 });
    f.sendAttached.mockRejectedValueOnce(new Error("failed"));
    await expect(f.controls.add(mock)).rejects.toThrow("configuration failed");
    expect(f.controls.list()[0].state).toBe("disabled");
    expect(f.sendAttached).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.disable");
    await f.controls.stop();
  });
  it("rolls back a cancelled rule setup and rejects writes after task ownership is lost", async () => {
    const f = fixture();
    await f.controls.target({ tabId: 7 });
    const ac = new AbortController();
    let release: () => void = () => {};
    f.sendAttached.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({});
        }),
    );
    const adding = f.controls.add(mock, ac.signal);
    await vi.waitFor(() => expect(f.sendAttached).toHaveBeenCalled());
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
    await f.controls.target({ tabId: 7 });
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
    const command = f.sendAttached.mock.calls.find((call) => call[1] === "Fetch.continueRequest");
    expect(JSON.stringify(command)).toContain("private-value");
    await f.controls.stop();
  });
  it("rolls back re-enabling a rule if the agent action is cancelled during setup", async () => {
    const f = fixture();
    await f.controls.target({ tabId: 7 });
    await f.controls.add(mock);
    await f.controls.update("d1:r1", "rule_disable");
    f.sendAttached.mockClear();
    const ac = new AbortController();
    let release: () => void = () => {};
    f.sendAttached.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({});
        }),
    );
    const enabling = f.controls.update("d1:r1", "rule_enable", ac.signal);
    await vi.waitFor(() => expect(f.sendAttached).toHaveBeenCalled());
    ac.abort();
    release();
    await expect(enabling).rejects.toThrow("cancelled");
    expect(f.controls.list()[0].state).toBe("disabled");
    expect(f.sendAttached).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.disable");
    await f.controls.stop();
  });
});
