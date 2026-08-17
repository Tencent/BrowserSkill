// ObservationClientStore: initial fetch + SSE application, thumbnail loading
// lifecycle, interrupt wire shape. All I/O faked.

import { describe, expect, it, vi } from "vitest";
import { type EventSourceLike, ObservationClientStore } from "../../src/client/observation-store";
import type { ObservationEvent, SessionObservation } from "../../src/observation";

const OBS_IDLE: SessionObservation = { sessionId: "s1", action: "idle", since: 1000 };
const OBS_BUSY: SessionObservation = { sessionId: "s1", action: "clicking", since: 2000 };

function harness(state: SessionObservation[] = []) {
  const fetches: { url: string; init?: { method?: string; body?: string } }[] = [];
  const esInstances: EventSourceLike[] = [];
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    fetches.push({ url, init });
    if (url === "/bsk-observation/state") {
      return { ok: true, json: async () => ({ sessions: state }) };
    }
    return { ok: true, json: async () => ({ interrupted: true }) };
  });
  const eventSourceFactory = (url: string) => {
    const es: EventSourceLike = { onmessage: null, close: vi.fn() };
    esInstances.push(es);
    return es;
  };
  const loadImage = vi.fn(async (id: string) => `blob:url-${id}`);
  const store = new ObservationClientStore({ fetchFn, eventSourceFactory, loadImage });
  return { store, fetches, esInstances, loadImage };
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
    const { store, loadImage } = harness();
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
    const { store, loadImage } = harness();
    loadImage.mockRejectedValueOnce(new Error("nope"));
    store.ensureThumbnail("att-bad");
    await vi.waitFor(() => expect(store.getSnapshot().thumbnails["att-bad"].status).toBe("error"));
  });

  it("posts interrupt with and without a session id", async () => {
    const { store, fetches } = harness();
    expect(await store.interrupt()).toBe(true);
    expect(await store.interrupt("s1")).toBe(true);
    const calls = fetches.filter((f) => f.url === "/bsk-observation/interrupt");
    expect(JSON.parse(calls[0].init?.body ?? "")).toEqual({});
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
    const revoke = vi.fn();
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revoke;
    return revoke;
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

describe("SSE (re)open resync", () => {
  it("refetches the full state when the stream (re)opens", async () => {
    const { store, fetches, esInstances } = harness([OBS_IDLE]);
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(1));
    const before = fetches.filter((f) => f.url === "/bsk-observation/state").length;
    esInstances[0].onopen?.();
    await vi.waitFor(() =>
      expect(fetches.filter((f) => f.url === "/bsk-observation/state").length).toBe(before + 1),
    );
    store.stop();
  });
});
