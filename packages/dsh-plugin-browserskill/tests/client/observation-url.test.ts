// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { ObservationClientStore } from "../../src/client/observation-store";
import { observationUrl } from "../../src/client/observation-url";

afterEach(() => {
  document.querySelector("base")?.remove();
});

describe("observationUrl", () => {
  it("keeps the normal root deployment path", () => {
    expect(observationUrl("events")).toBe("/bsk-observation/events");
  });

  it("resolves all observation routes under the document base", () => {
    const base = document.createElement("base");
    base.href = "/dsh/";
    document.head.append(base);
    expect(observationUrl("events")).toBe("/dsh/bsk-observation/events");
    expect(observationUrl("interrupt")).toBe("/dsh/bsk-observation/interrupt");
    expect(observationUrl("stop")).toBe("/dsh/bsk-observation/stop");
    expect(observationUrl("thumbnail/a%2Fb")).toBe("/dsh/bsk-observation/thumbnail/a%2Fb");
  });

  it("sends the live stream and commands through the mounted path", async () => {
    const base = document.createElement("base");
    base.href = "/dsh/";
    document.head.append(base);
    const urls: string[] = [];
    const store = new ObservationClientStore({
      fetchFn: async (url) => {
        urls.push(url);
        return { ok: true, json: async () => ({ interrupted: true, stopped: true }) };
      },
      eventSourceFactory: (url) => {
        urls.push(url);
        return { onmessage: null, close: () => {} };
      },
      loadImage: async () => "blob:test",
    });
    store.start();
    await store.interrupt("session-1");
    await store.stopSession("session-1");
    store.stop();
    expect(urls).toEqual([
      "/dsh/bsk-observation/events?thumbnails=0",
      "/dsh/bsk-observation/interrupt",
      "/dsh/bsk-observation/stop",
    ]);
  });
});
