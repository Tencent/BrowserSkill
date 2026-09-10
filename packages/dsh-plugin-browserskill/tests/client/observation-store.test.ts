// ObservationClientStore: ordered SSE snapshots/increments, thumbnail loading
// lifecycle, interrupt wire shape. All I/O faked.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type EventSourceLike, ObservationClientStore } from "../../src/client/observation-store";
import type { ObservationEvent, SessionObservation } from "../../src/observation";

const OBS_IDLE: SessionObservation = { sessionId: "s1", action: "idle", since: 1000 };
const OBS_BUSY: SessionObservation = { sessionId: "s1", action: "clicking", since: 2000 };
const stores: ObservationClientStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function harness(state: SessionObservation[] = []) {
  const fetches: {
    url: string;
    init?: { method?: string; body?: string; headers?: Record<string, string> };
  }[] = [];
  const esInstances: EventSourceLike[] = [];
  const eventUrls: string[] = [];
  const fetchFn = vi.fn(
    async (
      url: string,
      init?: { method?: string; body?: string; headers?: Record<string, string> },
    ) => {
      fetches.push({ url, init });
      if (url === "/bsk-observation/state") {
        return { ok: true, json: async () => ({ sessions: state }) };
      }
      return { ok: true, json: async () => ({ interrupted: true }) };
    },
  );
  const eventSourceFactory = (url: string) => {
    const es: EventSourceLike = { onmessage: null, close: vi.fn() };
    esInstances.push(es);
    eventUrls.push(url);
    queueMicrotask(() => emit(es, { type: "snapshot", sessions: state, available: true }));
    return es;
  };
  const loadImage = vi.fn(async (id: string) => `blob:url-${id}`);
  const store = new ObservationClientStore({ fetchFn, eventSourceFactory, loadImage });
  stores.push(store);
  return { store, fetches, esInstances, eventUrls, loadImage };
}

function emit(es: EventSourceLike, event: ObservationEvent): void {
  es.onmessage?.({ data: JSON.stringify(event) });
}

describe("ObservationClientStore", () => {
  it("loads the initial state and applies SSE increments", async () => {
    const { store, esInstances } = harness([OBS_IDLE]);
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().sessions.length));
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(1));
    expect(esInstances).toHaveLength(1);
    emit(esInstances[0], { type: "upsert", session: OBS_BUSY });
    expect(store.getSnapshot().sessions[0].action).toBe("clicking");
    emit(esInstances[0], {
      type: "upsert",
      session: { sessionId: "s2", action: "idle", since: 3 },
    });
    expect(store.getSnapshot().sessions).toHaveLength(2);
    emit(esInstances[0], {
      type: "remove",
      session: { sessionId: "s2", action: "idle", since: 0 },
    });
    expect(store.getSnapshot().sessions).toHaveLength(1);
    emit(esInstances[0], { type: "reset" });
    expect(store.getSnapshot().sessions).toHaveLength(0);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("ignores malformed SSE frames", () => {
    const { store, esInstances } = harness([]);
    store.start();
    esInstances[0].onmessage?.({ data: "not json" });
    expect(store.getSnapshot().sessions).toHaveLength(0);
  });

  it("loads each thumbnail once and reports ready", async () => {
    const { store, loadImage } = harness([{ ...OBS_IDLE, thumbnailAttachmentId: "att-1" }]);
    store.start();
    await Promise.resolve();
    store.ensureThumbnail("att-1");
    store.ensureThumbnail("att-1");
    expect(loadImage).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(store.getSnapshot().thumbnails["att-1"]).toEqual({
        status: "ready",
        url: "blob:url-att-1",
      }),
    );
  });

  it("marks failed thumbnail loads as error", async () => {
    const { store, loadImage } = harness([{ ...OBS_IDLE, thumbnailAttachmentId: "att-bad" }]);
    store.start();
    await Promise.resolve();
    loadImage.mockRejectedValueOnce(new Error("nope"));
    store.ensureThumbnail("att-bad");
    await vi.waitFor(() => expect(store.getSnapshot().thumbnails["att-bad"].status).toBe("error"));
  });

  it("posts interrupt with and without a session id", async () => {
    const { store, fetches } = harness();
    expect(await store.interrupt()).toBe(true);
    expect(await store.interrupt("s1")).toBe(true);
    const calls = fetches.filter((f) => f.url === "/bsk-observation/interrupt");
    expect(calls[0].init?.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init?.body ?? "")).toEqual({});
    expect(calls[1].init?.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[1].init?.body ?? "")).toEqual({ sessionId: "s1" });
  });

  it("returns false when interrupt fails", async () => {
    const failing = new ObservationClientStore({
      fetchFn: async () => ({ ok: false, json: async () => ({}) }),
      eventSourceFactory: () => ({ onmessage: null, close: () => {} }),
      loadImage: async () => "blob:x",
    });
    expect(await failing.interrupt("s1")).toBe(false);
  });

  it("stop closes the stream and clears state", async () => {
    const { store, esInstances } = harness([OBS_IDLE]);
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(1));
    store.stop();
    expect(esInstances[0].close).toHaveBeenCalled();
    expect(store.getSnapshot().sessions).toHaveLength(0);
  });
});

describe("thumbnail blob URL lifecycle", () => {
  function withRevokeSpy() {
    return vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  }

  it("holds the last ready frame until the replacement decodes", async () => {
    const revoke = withRevokeSpy();
    const { store, esInstances } = harness([{ ...OBS_IDLE, thumbnailAttachmentId: "a1" }]);
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(1));
    store.ensureThumbnail("a1");
    await vi.waitFor(() =>
      expect(store.getSnapshot().thumbnails["a1"]).toEqual({ status: "ready", url: "blob:url-a1" }),
    );
    emit(esInstances[0], {
      type: "upsert",
      session: { ...OBS_IDLE, thumbnailAttachmentId: "a2" },
    });
    // Old blob stays painted so the overlay does not flash a placeholder.
    expect(store.getSnapshot().thumbnails["a1"]).toEqual({
      status: "ready",
      url: "blob:url-a1",
    });
    expect(store.getSnapshot().displayFrames.s1).toEqual({
      status: "ready",
      url: "blob:url-a1",
    });
    expect(revoke).not.toHaveBeenCalled();
    store.ensureThumbnail("a2");
    await vi.waitFor(() =>
      expect(store.getSnapshot().displayFrames.s1).toEqual({
        status: "ready",
        url: "blob:url-a2",
      }),
    );
    expect(store.getSnapshot().thumbnails["a1"]).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith("blob:url-a1");
    store.stop();
  });

  it("keeps the last good frame in displayFrames when the next load fails", async () => {
    const { store, esInstances, loadImage } = harness([
      { ...OBS_IDLE, thumbnailAttachmentId: "a1" },
    ]);
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(1));
    store.ensureThumbnail("a1");
    await vi.waitFor(() => expect(store.getSnapshot().thumbnails["a1"].status).toBe("ready"));
    loadImage.mockRejectedValueOnce(new Error("nope"));
    emit(esInstances[0], {
      type: "upsert",
      session: { ...OBS_IDLE, thumbnailAttachmentId: "a2" },
    });
    store.ensureThumbnail("a2");
    await vi.waitFor(() => expect(store.getSnapshot().thumbnails["a2"]?.status).toBe("error"));
    expect(store.getSnapshot().displayFrames.s1).toEqual({
      status: "error",
      url: "blob:url-a1",
    });
    store.stop();
  });

  it("remove and reset revoke the session's tracked frame", async () => {
    const revoke = withRevokeSpy();
    const { store, esInstances } = harness([{ ...OBS_IDLE, thumbnailAttachmentId: "a1" }]);
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(1));
    store.ensureThumbnail("a1");
    await vi.waitFor(() => expect(store.getSnapshot().thumbnails["a1"].status).toBe("ready"));
    emit(esInstances[0], {
      type: "remove",
      session: { sessionId: "s1", action: "idle", since: 0 },
    });
    expect(revoke).toHaveBeenCalledWith("blob:url-a1");
    expect(store.getSnapshot().thumbnails["a1"]).toBeUndefined();
    store.stop();
  });

  it("a load that finishes after replacement never resurrects the old frame", async () => {
    const revoke = withRevokeSpy();
    const { store, esInstances, loadImage } = harness([
      { ...OBS_IDLE, thumbnailAttachmentId: "a1" },
    ]);
    let resolveA1!: (url: string) => void;
    loadImage.mockImplementation((id: string) =>
      id === "a1"
        ? new Promise<string>((resolve) => {
            resolveA1 = resolve;
          })
        : Promise.resolve(`blob:url-${id}`),
    );
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(1));
    store.ensureThumbnail("a1");
    // the frame is replaced while a1 is still loading
    emit(esInstances[0], {
      type: "upsert",
      session: { ...OBS_IDLE, thumbnailAttachmentId: "a2" },
    });
    resolveA1("blob:url-a1-late");
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getSnapshot().thumbnails["a1"]).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith("blob:url-a1-late");
    store.stop();
  });
});

describe("SSE snapshot ordering", () => {
  it("ignores events from a stopped connection after a restart", async () => {
    const { store, esInstances } = harness([OBS_IDLE]);
    store.start();
    await Promise.resolve();
    const old = esInstances[0];
    store.stop();
    emit(old, { type: "upsert", session: OBS_BUSY });
    expect(store.getSnapshot().sessions).toEqual([]);
    store.start();
    await Promise.resolve();
    emit(esInstances[1], { type: "upsert", session: OBS_BUSY });
    emit(old, { type: "snapshot", sessions: [], available: false });
    emit(old, { type: "remove", session: OBS_BUSY });
    expect(store.getSnapshot()).toMatchObject({ sessions: [OBS_BUSY], available: true });
  });

  it("does not apply a queued initial snapshot after stop", async () => {
    const { store } = harness([OBS_BUSY]);
    store.start();
    store.stop();
    await Promise.resolve();
    expect(store.getSnapshot()).toMatchObject({ sessions: [], thumbnails: {}, subscribed: false });
  });

  it("replaces state on reconnect before applying subsequent events, without a competing fetch", async () => {
    const { store, fetches, esInstances } = harness([OBS_IDLE]);
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(1));
    emit(esInstances[0], { type: "snapshot", sessions: [], available: false });
    expect(store.getSnapshot()).toMatchObject({ sessions: [], available: false });
    emit(esInstances[0], { type: "upsert", session: OBS_BUSY });
    await Promise.resolve();
    expect(store.getSnapshot().sessions).toEqual([OBS_BUSY]);
    expect(fetches).toEqual([]);
    store.stop();
  });
});

describe("thumbnail recovery and stale loads", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  it("retries a transient failure without needing a different frame id", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, loadImage } = harness([{ ...OBS_IDLE, thumbnailAttachmentId: "a1" }]);
    store.start();
    await Promise.resolve();
    loadImage.mockRejectedValueOnce(new Error("temporary"));
    store.ensureThumbnail("a1");
    await Promise.resolve();
    expect(store.getSnapshot().thumbnails.a1.status).toBe("error");
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadImage).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().displayFrames.s1).toEqual({ status: "ready", url: "blob:url-a1" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds automatic retries and allows an explicit recovery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, loadImage } = harness([{ ...OBS_IDLE, thumbnailAttachmentId: "a1" }]);
    store.start();
    await Promise.resolve();
    loadImage.mockRejectedValue(new Error("offline"));
    store.ensureThumbnail("a1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadImage).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    store.ensureThumbnail("a1");
    expect(loadImage).toHaveBeenCalledTimes(3);
    loadImage.mockResolvedValue("blob:recovered");
    store.retryThumbnail("a1");
    await Promise.resolve();
    expect(store.getSnapshot().displayFrames.s1.url).toBe("blob:recovered");
  });

  it("cancels backoff when a reconnect retries the current frame", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = { ...OBS_IDLE, thumbnailAttachmentId: "a1" };
    const { store, esInstances, loadImage } = harness([session]);
    store.start();
    await Promise.resolve();
    loadImage.mockRejectedValueOnce(new Error("offline"));
    store.ensureThumbnail("a1");
    await Promise.resolve();
    emit(esInstances[0], { type: "snapshot", sessions: [session], available: true });
    await Promise.resolve();
    expect(store.getSnapshot().thumbnails.a1.status).toBe("ready");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadImage).toHaveBeenCalledTimes(2);
  });

  it.each([
    "remove",
    "reset",
    "stop",
    "missing-thumbnail",
    "snapshot-removal",
  ])("cleans frames and cancels retries on %s", async (action) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { store, esInstances, loadImage } = harness([
      { ...OBS_IDLE, thumbnailAttachmentId: "a1" },
    ]);
    store.start();
    await Promise.resolve();
    store.ensureThumbnail("a1");
    await Promise.resolve();
    emit(esInstances[0], { type: "upsert", session: { ...OBS_IDLE, thumbnailAttachmentId: "a2" } });
    loadImage.mockRejectedValueOnce(new Error("no frame"));
    store.ensureThumbnail("a2");
    await Promise.resolve();
    expect(store.getSnapshot().displayFrames.s1).toEqual({ status: "error", url: "blob:url-a1" });
    if (action === "stop") store.stop();
    else if (action === "remove") emit(esInstances[0], { type: "remove", session: OBS_IDLE });
    else if (action === "reset") emit(esInstances[0], { type: "reset" });
    else if (action === "missing-thumbnail")
      emit(esInstances[0], { type: "upsert", session: OBS_IDLE });
    else emit(esInstances[0], { type: "snapshot", sessions: [], available: true });
    expect(store.getSnapshot().thumbnails).toEqual({});
    expect(store.getSnapshot().displayFrames).toEqual({});
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:url-a1");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadImage).toHaveBeenCalledTimes(2);
  });

  it.each([
    "resolve",
    "reject",
  ])("ignores a stale load's %s even when the same id is loaded again", async (outcome) => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { store, esInstances, loadImage } = harness([
      { ...OBS_IDLE, thumbnailAttachmentId: "a1" },
    ]);
    const old = deferred<string>();
    loadImage.mockReturnValueOnce(old.promise);
    store.start();
    await Promise.resolve();
    store.ensureThumbnail("a1");
    emit(esInstances[0], { type: "upsert", session: { ...OBS_IDLE, thumbnailAttachmentId: "a2" } });
    emit(esInstances[0], { type: "upsert", session: { ...OBS_IDLE, thumbnailAttachmentId: "a1" } });
    store.ensureThumbnail("a1");
    await Promise.resolve();
    if (outcome === "resolve") old.resolve("blob:stale");
    else old.reject(new Error("stale error"));
    await Promise.resolve();
    expect(store.getSnapshot().displayFrames.s1).toEqual({ status: "ready", url: "blob:url-a1" });
    expect(revoke).not.toHaveBeenCalledWith("blob:url-a1");
    if (outcome === "resolve") expect(revoke).toHaveBeenCalledWith("blob:stale");
  });

  it.each(["resolve", "reject"])("ignores an in-flight load's %s after stop", async (outcome) => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { store, loadImage } = harness([{ ...OBS_IDLE, thumbnailAttachmentId: "a1" }]);
    const pending = deferred<string>();
    loadImage.mockReturnValueOnce(pending.promise);
    store.start();
    await Promise.resolve();
    store.ensureThumbnail("a1");
    store.stop();
    if (outcome === "resolve") pending.resolve("blob:late");
    else pending.reject(new Error("late error"));
    await Promise.resolve();
    expect(store.getSnapshot()).toMatchObject({ sessions: [], thumbnails: {}, displayFrames: {} });
    if (outcome === "resolve") expect(revoke).toHaveBeenCalledWith("blob:late");
  });
});

describe("thumbnail viewer leases", () => {
  it("keeps metadata subscribed while the last screenshot viewer leaves", async () => {
    const { store, eventUrls, esInstances } = harness([OBS_IDLE]);
    store.acquire();
    await Promise.resolve();
    expect(eventUrls).toEqual(["/bsk-observation/events?thumbnails=0"]);
    const first = store.watchThumbnails();
    expect(eventUrls.at(-1)).toBe("/bsk-observation/events?thumbnails=1");
    const second = store.watchThumbnails();
    expect(eventUrls).toHaveLength(2);
    first();
    first();
    expect(eventUrls).toHaveLength(2);
    second();
    expect(eventUrls.at(-1)).toBe("/bsk-observation/events?thumbnails=0");
    expect(store.getSnapshot().subscribed).toBe(true);
    store.release();
    expect(esInstances.at(-1)?.close).toHaveBeenCalledOnce();
    expect(store.getSnapshot().subscribed).toBe(false);
  });

  it("ignores delayed snapshots from a replaced stream without clearing the displayed state", async () => {
    const { store, esInstances } = harness([OBS_IDLE]);
    store.start();
    await Promise.resolve();
    emit(esInstances[0], { type: "upsert", session: OBS_BUSY });
    const release = store.watchThumbnails();
    expect(store.getSnapshot().sessions).toEqual([OBS_BUSY]);
    await Promise.resolve();
    emit(esInstances[1], { type: "upsert", session: OBS_BUSY });
    emit(esInstances[0], { type: "snapshot", sessions: [], available: false });
    expect(store.getSnapshot()).toMatchObject({ sessions: [OBS_BUSY], available: true });
    store.stop();
    release();
    expect(esInstances).toHaveLength(2);
  });
});
