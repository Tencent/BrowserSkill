import { describe, expect, it, vi } from "vitest";
import { mergeRequest } from "../journal";
import { DebugNetworkStore, MAX_INFLIGHT, MAX_REQUESTS } from "../network-store";
import type { DebugRequest } from "../types";

function fixture(send = vi.fn(async () => ({ body: '{"saved":false}' }))) {
  const saved = new Map<string, DebugRequest>();
  let sequence = 0;
  const store = new DebugNetworkStore(
    "d1",
    { send: send as never },
    () => ++sequence,
    Date.now,
    (entry) => saved.set(entry.id, structuredClone(mergeRequest(saved.get(entry.id), entry))),
  );
  const event = (method: string, data: object) =>
    store.onEvent({ tabId: 7 }, `Network.${method}`, data);
  const start = (id: string) =>
    event("requestWillBeSent", {
      requestId: id,
      timestamp: 1,
      type: "Fetch",
      request: { url: `https://site.test/${id}`, method: "GET" },
    });
  const finish = (id: string) => {
    event("responseReceived", {
      requestId: id,
      hasExtraInfo: false,
      response: { status: 503, mimeType: "application/json" },
    });
    event("loadingFinished", { requestId: id, timestamp: 20 });
  };
  return { store, saved, event, start, finish, send };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("in-flight evidence retention", () => {
  it("keeps a slow request's identity, status, timing and body beyond recent traffic and unmatched headers", async () => {
    const f = fixture();
    f.start("slow");
    for (let i = 0; i < MAX_REQUESTS; i++) f.start(`asset-${i}`);
    for (let i = 0; i < 800; i++)
      f.event("requestWillBeSentExtraInfo", { requestId: `unmatched-${i}`, headers: {} });
    f.finish("slow");
    await settle();
    f.store.stop("requested");
    expect(f.saved.get("d1:n1")).toMatchObject({
      state: "complete",
      status: 503,
      duration_ms: 19000,
      response_body: { state: "available", text: '{\n  "saved": false\n}' },
    });
    expect(f.send).toHaveBeenCalledWith(7, "Network.getResponseBody", { requestId: "slow" });
  });

  it("preserves an already running body job when its request leaves the recent cache", async () => {
    let resolve!: (value: { body: string }) => void;
    const f = fixture(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    f.start("body");
    f.finish("body");
    for (let i = 0; i < MAX_REQUESTS; i++) f.start(`asset-${i}`);
    resolve({ body: '{"saved":false}' });
    await settle();
    expect(f.saved.get("d1:n1")?.response_body.text).toContain('"saved": false');
    f.store.stop("requested");
  });

  it("bounds tracking and persists explicit gaps instead of forever-pending rows", () => {
    const f = fixture();
    for (let i = 0; i < MAX_REQUESTS + MAX_INFLIGHT + 5; i++) f.start(`pending-${i}`);
    expect(f.store.size).toBe(MAX_REQUESTS + MAX_INFLIGHT);
    expect(f.saved.get("d1:n1")).toMatchObject({
      state: "interrupted",
      error: "tracking_limit",
      truncated: true,
      response_body: { state: "unavailable", reason: "tracking_limit" },
    });
    f.store.stop("requested");
    expect(
      [...f.saved.values()].some(
        (entry) => entry.state === "pending" || entry.response_body.state === "pending",
      ),
    ).toBe(false);
    expect(f.store.size).toBeLessThanOrEqual(MAX_REQUESTS);
  });
});
