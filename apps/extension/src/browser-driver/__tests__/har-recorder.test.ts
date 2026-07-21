import { describe, expect, it, vi } from "vitest";
import type { CdpDebuggerApi } from "../chromium-cdp";
import { HarRecorder } from "../har-recorder";

function fakeChromeEvent<TArgs extends unknown[]>() {
  return {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

function fakeApi(
  sendCommand: CdpDebuggerApi["sendCommand"] = vi.fn(async () => ({})),
): CdpDebuggerApi {
  return {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand,
    // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
    onEvent: fakeChromeEvent() as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal chrome.events.Event shim
    onDetach: fakeChromeEvent() as any,
  };
}

function entries(result: Awaited<ReturnType<HarRecorder["stop"]>>) {
  const log = result.har.log as Record<string, unknown>;
  return log.entries as Array<Record<string, unknown>>;
}

describe("HarRecorder", () => {
  it("builds HAR 1.2, captures content, and redacts credentials", async () => {
    const api = fakeApi(
      vi.fn(async (_target, method) => {
        if (method === "Network.getResponseBody") {
          return { body: '{"ok":true}', base64Encoded: false };
        }
        return {};
      }),
    );
    const recorder = new HarRecorder(api);
    recorder.start("aa11", 7, { session_id: "aa11" });
    recorder.handleEvent(7, "Network.requestWillBeSent", {
      requestId: "req-1",
      timestamp: 10,
      wallTime: 1_700_000_000,
      type: "Fetch",
      request: {
        method: "GET",
        url: "https://example.test/api?access_token=secret&view=full",
        headers: { Authorization: "Bearer secret", Accept: "application/json" },
      },
    });
    recorder.handleEvent(7, "Network.responseReceived", {
      requestId: "req-1",
      timestamp: 10.12,
      type: "Fetch",
      response: {
        status: 200,
        statusText: "OK",
        protocol: "h2",
        mimeType: "application/json",
        headers: { "Set-Cookie": "sid=secret", "Content-Type": "application/json" },
        timing: {
          dnsStart: 0,
          dnsEnd: 2,
          connectStart: 2,
          connectEnd: 8,
          sslStart: 3,
          sslEnd: 7,
          sendStart: 8,
          sendEnd: 9,
          receiveHeadersEnd: 120,
        },
        remoteIPAddress: "127.0.0.1",
        connectionId: 42,
      },
    });
    recorder.handleEvent(7, "Network.loadingFinished", {
      requestId: "req-1",
      timestamp: 10.15,
      encodedDataLength: 123,
    });

    const result = await recorder.stop("aa11", 100);
    const log = result.har.log as Record<string, unknown>;
    const entry = entries(result)[0];
    const request = entry.request as Record<string, unknown>;
    const response = entry.response as Record<string, unknown>;
    const content = response.content as Record<string, unknown>;

    expect(log.version).toBe("1.2");
    expect(result.entry_count).toBe(1);
    expect(request.url).toContain("access_token=%3Credacted%3E");
    expect(request.url).toContain("view=full");
    expect(request.headers).toContainEqual({ name: "Authorization", value: "<redacted>" });
    expect(response.headers).toContainEqual({ name: "Set-Cookie", value: "<redacted>" });
    expect(content).toMatchObject({ mimeType: "application/json", text: '{"ok":true}' });
    expect(entry).toMatchObject({
      serverIPAddress: "127.0.0.1",
      connection: "42",
      _resourceType: "Fetch",
    });
    expect(result.body_bytes).toBe(11);
    expect(result.truncated).toBe(false);
  });

  it("marks oversized bodies as omitted without writing partial content", async () => {
    const api = fakeApi(vi.fn(async () => ({ body: "too large", base64Encoded: false })));
    const recorder = new HarRecorder(api);
    recorder.start("aa11", 7, {
      session_id: "aa11",
      max_body_bytes: 3,
    });
    recorder.handleEvent(7, "Network.requestWillBeSent", {
      requestId: "large",
      timestamp: 1,
      request: { method: "GET", url: "https://example.test/large", headers: {} },
    });
    recorder.handleEvent(7, "Network.responseReceived", {
      requestId: "large",
      timestamp: 2,
      response: { status: 200, headers: {} },
    });
    recorder.handleEvent(7, "Network.loadingFinished", {
      requestId: "large",
      timestamp: 3,
    });

    const result = await recorder.stop("aa11", 100);
    const entry = entries(result)[0];
    const content = (entry.response as Record<string, unknown>).content as Record<string, unknown>;
    expect(entry._bodyOmitted).toContain("max_body_bytes");
    expect(content.text).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it("does not mark bodyless responses as truncated", async () => {
    const sendCommand = vi.fn(async () => {
      throw new Error("Network.getResponseBody should not be called");
    });
    const recorder = new HarRecorder(fakeApi(sendCommand));
    recorder.start("aa11", 7, { session_id: "aa11" });

    for (const [requestId, status, headers] of [
      ["no-content", 204, {}],
      ["empty", 200, { "content-length": "0" }],
    ] as const) {
      recorder.handleEvent(7, "Network.requestWillBeSent", {
        requestId,
        timestamp: 1,
        request: { method: "OPTIONS", url: `https://example.test/${requestId}`, headers: {} },
      });
      recorder.handleEvent(7, "Network.responseReceived", {
        requestId,
        timestamp: 2,
        response: { status, headers },
      });
      recorder.handleEvent(7, "Network.loadingFinished", { requestId, timestamp: 3 });
    }

    const result = await recorder.stop("aa11", 100);
    expect(result.entry_count).toBe(2);
    expect(result.truncated).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("finalizes an in-flight request when the settle timeout elapses", async () => {
    const recorder = new HarRecorder(fakeApi());
    recorder.start("aa11", 7, { session_id: "aa11" });
    recorder.handleEvent(7, "Network.requestWillBeSent", {
      requestId: "pending",
      timestamp: 1,
      request: { method: "GET", url: "https://example.test/pending", headers: {} },
    });

    const result = await recorder.stop("aa11", 0);
    expect(result.truncated).toBe(true);
    expect(entries(result)[0]._error).toBe("capture stopped before request completed");
  });
});
