import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@/session-manager/manager";
import type { CdpRunner } from "@/tools/shared";
import type { VideoHost, VideoHostCommand } from "./host-protocol";
import { VIDEO_NAVIGATION_TIMEOUT_MS, VideoManager } from "./manager";
import { VideoArtifactStore } from "./store";
import { completeStop, type StoredVideo } from "./types";

class MemoryStore extends VideoArtifactStore {
  values = new Map<string, StoredVideo>();
  override async list() {
    return [...this.values.values()];
  }
  override async get(id: string) {
    return this.values.get(id);
  }
  override async put(value: StoredVideo) {
    this.values.set(value.recording_id, structuredClone(value));
  }
  override async remove(id: string) {
    this.values.delete(id);
  }
  override async prepare() {}
  override async reserve() {}
  override async file() {
    return new File(["abc"], "video.mp4");
  }
}

async function setup() {
  const sessions = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: 10, initialTabIds: [7] }),
      ensureActiveTab: async () => 7,
      remove: async () => {},
    },
  });
  await sessions.start("task");
  const tab = {
    id: 7,
    windowId: 10,
    active: true,
    url: "https://example.test",
    title: "Test",
  } as chrome.tabs.Tab;
  const store = new MemoryStore();
  let owner = "local";
  let event: Parameters<NonNullable<CdpRunner["onEvent"]>>[0];
  const cdp = {
    getAttachmentId: () => "one",
    onEvent: (handler: typeof event) => {
      event = handler;
      return { dispose: vi.fn() };
    },
    send: vi.fn(
      async <T>(_tab: number, method: string): Promise<T> =>
        (method === "Page.captureScreenshot" ? { data: "image" } : {}) as T,
    ),
  };
  const request = vi.fn(async <T>(command: VideoHostCommand): Promise<T> => {
    if (command.action === "start") {
      const value: StoredVideo = {
        ...command.recording,
        state: "recording",
        started_at: Date.now(),
      };
      await store.put(value);
      return value as T;
    }
    if (command.action === "stop") {
      const previous = await store.get(command.recording_id);
      const value = {
        ...previous!,
        state: "ready",
        byte_size: 3,
        stop_reason: command.reason,
        completeness: completeStop(command.reason) ? "complete" : "partial",
      } as StoredVideo;
      await store.put(value);
      return value as T;
    }
    return undefined as T;
  });
  const overlay = vi.fn(async () => ({}));
  const changed = vi.fn();
  const video = new VideoManager({
    sessions,
    cdp: cdp as CdpRunner,
    store,
    owner: () => owner,
    tabs: { query: async () => [tab], get: async () => tab },
    host: { request: request as VideoHost["request"], closeWhenIdle: async () => {} },
    overlay,
    changed: () => changed(video.isRecording()),
  });
  const start = () => video.start({ session_id: "task", request_id: "start-request" });
  return {
    video,
    sessions,
    store,
    request,
    cdp,
    tab,
    overlay,
    changed,
    start,
    setOwner: (value: string) => {
      owner = value;
    },
    frame: (data: string, timestamp?: number) =>
      event({ tabId: 7 }, "Page.screencastFrame", { data, metadata: { timestamp }, sessionId: 1 }),
  };
}

describe("video lifetime and access", () => {
  afterEach(() => vi.useRealTimers());
  it("reserves against action recording during asynchronous startup", async () => {
    const { video, start } = await setup();
    const release = video.reserveActionRecording("task")!;
    await expect(start()).rejects.toThrow("Stop action recording");
    release();
    const grant = await start();
    expect(video.reserveActionRecording("task")).toBeUndefined();
    await video.stop(grant.recording.recording_id);
  });
  it("pins its tab, returns after encoder startup, and makes retry/stop idempotent", async () => {
    const { video, start, request, tab } = await setup();
    const grant = await start();
    tab.id = 8;
    expect((await start()).recording.recording_id).toBe(grant.recording.recording_id);
    expect(grant.recording.tab_id).toBe(7);
    expect(request.mock.calls.filter(([command]) => command.action === "start")).toHaveLength(1);
    const first = await video.stop(grant.recording.recording_id);
    expect(await video.stop(grant.recording.recording_id)).toEqual(first);
    expect(request.mock.calls.filter(([command]) => command.action === "stop")).toHaveLength(1);
  });

  it("retains a partial artifact after task deletion and requires owner plus capability", async () => {
    const { video, start, sessions, setOwner } = await setup();
    const grant = await start();
    await video.stopSession("task");
    await sessions.stop("task", { dropOnly: true });
    const params = {
      action: "read" as const,
      recording_id: grant.recording.recording_id,
      capability: grant.capability,
    };
    expect(await video.rpc(params)).toMatchObject({ data_base64: "YWJj", byte_size: 3 });
    expect((await video.get(params.recording_id)).completeness).toBe("partial");
    await expect(video.rpc({ ...params, capability: "wrong" })).rejects.toThrow("access denied");
    setOwner("different-remote-device");
    await expect(video.rpc(params)).rejects.toThrow("access denied");
    expect(await video.rpc({ action: "list" })).toEqual({ recordings: [] });
  });

  it("rejects unrelated tabs and concurrent capture before starting an encoder", async () => {
    const { video, start, sessions, request } = await setup();
    sessions.get("task")!.agentCreatedTabs.clear();
    await expect(start()).rejects.toThrow("task-created or borrowed");
    expect(request).not.toHaveBeenCalled();
    sessions.get("task")!.agentCreatedTabs.add(7);
    const grant = await start();
    await expect(video.start({ session_id: "task", request_id: "second-request" })).rejects.toThrow(
      "already",
    );
    await video.stop(grant.recording.recording_id);
  });

  it("closes frame intake before acknowledging interactive overlays", async () => {
    const { video, start, request, frame } = await setup();
    const grant = await start();
    const paused = video.suspend(7, "interactive", "document");
    frame("must-not-enter-encoder", Date.now() / 1000);
    await paused;
    expect(request.mock.calls.some(([command]) => command.action === "frame")).toBe(false);
    await video.suspend(7, "clean", "old-document");
    expect(request.mock.calls.some(([command]) => command.action === "frame")).toBe(false);
    await video.suspend(7, "clean", "document");
    frame("stale-overlay-frame", 0);
    expect(request.mock.calls.filter(([command]) => command.action === "frame")).toHaveLength(1);
    await video.stop(grant.recording.recording_id);
  });

  it("does not allow an interactive overlay to paint into the first frame", async () => {
    const { video, start, request } = await setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = request.getMockImplementation()!;
    request.mockImplementation(async (command) => {
      if (command.action === "start") await blocked;
      return execute(command);
    });
    const starting = start();
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([command]) => command.action === "start")).toBe(true),
    );
    let acknowledged = false;
    const showing = video.suspend(7, "interactive", "document").then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    release();
    await expect(starting).rejects.toThrow("cancelled");
    await showing;
    expect(video.isRecording()).toBe(false);
    expect(request.mock.calls.some(([command]) => command.action === "stop")).toBe(true);
  });

  it("bounds frame backpressure to one in flight plus the latest frame", async () => {
    const { video, start, request, frame } = await setup();
    const grant = await start();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    request.mockImplementationOnce(async () => {
      await blocked;
    });
    frame("first");
    for (let n = 0; n < 100; n++) frame(String(n));
    expect(request.mock.calls.filter(([command]) => command.action === "frame")).toHaveLength(1);
    release();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([command]) => command.action === "frame")).toHaveLength(2),
    );
    expect(
      request.mock.calls.filter(([command]) => command.action === "frame").at(-1)?.[0],
    ).toMatchObject({ image: "99" });
    await video.stop(grant.recording.recording_id);
  });

  it("holds the clean frame during navigation and recovers without a content script", async () => {
    const { video, start, request, frame, overlay } = await setup();
    const grant = await start();
    await video.navigationStarted(7);
    frame("during-navigation");
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
      action: "suspend",
      mode: "navigation",
      label: "",
    });
    expect(request.mock.calls.some(([command]) => command.action === "frame")).toBe(false);
    await video.navigationSettled(7);
    expect(overlay).toHaveBeenLastCalledWith(7, grant.recording.recording_id);
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ action: "frame", image: "image" });
    expect((await video.stop(grant.recording.recording_id)).completeness).toBe("complete");
  });

  it("cannot mark an unresolved navigation complete on manual stop or timeout", async () => {
    vi.useFakeTimers();
    const { video, start } = await setup();
    const first = await start();
    await video.navigationStarted(7);
    expect((await video.stop(first.recording.recording_id)).stop_reason).toBe("capture_failed");
    const next = await video.start({ session_id: "task", request_id: "next-request" });
    await video.navigationStarted(7);
    await vi.advanceTimersByTimeAsync(VIDEO_NAVIGATION_TIMEOUT_MS);
    expect(await video.get(next.recording.recording_id)).toMatchObject({
      state: "ready",
      completeness: "partial",
      stop_reason: "capture_failed",
    });
    expect(video.isRecording()).toBe(false);
  });

  it("allows slow navigation to recover after 15 seconds and cancels its fallback", async () => {
    vi.useFakeTimers();
    const { video, start, frame, request } = await setup();
    const grant = await start();
    await video.navigationStarted(7);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(video.isRecording()).toBe(true);
    frame("still-loading");
    expect(request.mock.calls.some(([command]) => command.action === "frame")).toBe(false);
    await video.navigationSettled(7);
    await vi.advanceTimersByTimeAsync(VIDEO_NAVIGATION_TIMEOUT_MS);
    expect(video.isRecording()).toBe(true);
    expect((await video.stop(grant.recording.recording_id)).completeness).toBe("complete");
  });

  it("marks a duration reply partial when it races the navigation message", async () => {
    const { video, start, store } = await setup();
    const grant = await start();
    await video.navigationStarted(7);
    const value = (await store.get(grant.recording.recording_id))!;
    await store.put({
      ...value,
      state: "ready",
      stop_reason: "duration_limit",
      completeness: "complete",
    });
    await video.finished(grant.recording.recording_id);
    expect(await video.get(grant.recording.recording_id)).toMatchObject({
      completeness: "partial",
      stop_reason: "capture_failed",
    });
  });

  it("does not turn repeated discovery for the current document into navigation", async () => {
    const { video, start, request } = await setup();
    const grant = await start();
    await video.queryOverlay(7, "document");
    await video.suspend(7, "clean", "document");
    request.mockClear();
    expect(await video.queryOverlay(7, "document")).toBe(grant.recording.recording_id);
    expect(request).not.toHaveBeenCalled();
    await video.suspend(7, "clean", "document");
    expect((await video.stop(grant.recording.recording_id)).completeness).toBe("complete");
  });

  it("rejects late navigation recovery and old document acknowledgements", async () => {
    const { video, start, request, overlay } = await setup();
    const grant = await start();
    await video.suspend(7, "clean", "old-document");
    await video.navigationStarted(7, 100);
    await video.suspend(7, "clean", "old-document");
    let resolve!: (value: object) => void;
    overlay.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const recovering = video.navigationSettled(7, 101);
    await video.navigationStarted(7, 200);
    const count = request.mock.calls.length;
    resolve({});
    await recovering;
    await video.navigationSettled(7, 199);
    expect(request.mock.calls).toHaveLength(count);
    await video.suspend(7, "navigation", "new-document");
    await video.suspend(7, "clean", "new-document");
    expect((await video.stop(grant.recording.recording_id)).completeness).toBe("complete");
  });

  it("keeps confirmation pixels out of cancelled-navigation recovery", async () => {
    const { video, start, request, overlay } = await setup();
    const grant = await start();
    await video.navigationStarted(7);
    overlay.mockResolvedValueOnce({ interactive: true });
    await video.navigationSettled(7);
    expect(request.mock.calls.at(-1)?.[0]).toMatchObject({
      action: "suspend",
      mode: "interactive",
    });
    expect(request.mock.calls.some(([command]) => command.action === "frame")).toBe(false);
    await video.suspend(7, "clean");
    expect((await video.stop(grant.recording.recording_id)).completeness).toBe("complete");
  });

  it("preserves session, authorization and parameter error codes", async () => {
    const { video } = await setup();
    await expect(
      video.start({ session_id: "missing", request_id: "test-request" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(video.start({ session_id: "task", request_id: "bad" })).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(
      video.get("missing", { owner: "local", capability: "missing" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("cleans up suppression and leaves actionable metadata after startup failure", async () => {
    const { start, request, overlay, video, changed } = await setup();
    request.mockRejectedValueOnce(new Error("H.264 unsupported"));
    await expect(start()).rejects.toThrow("H.264 unsupported");
    expect(overlay).toHaveBeenLastCalledWith(7, null);
    expect(video.isRecording()).toBe(false);
    expect(changed).toHaveBeenLastCalledWith(false);
  });

  it("releases capture even when startup metadata cannot be written", async () => {
    const { start, store, overlay, video } = await setup();
    vi.spyOn(store, "put").mockRejectedValue(new Error("storage unavailable"));
    await expect(start()).rejects.toThrow("storage unavailable");
    expect(overlay).toHaveBeenLastCalledWith(7, null);
    expect(video.isRecording()).toBe(false);
  });

  it("releases a late screencast lease when the duration cap finishes during startup", async () => {
    const { start, cdp, video, store } = await setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    cdp.send.mockImplementation(async (_tab, method) => {
      if (method === "Page.startScreencast") await blocked;
      return (method === "Page.captureScreenshot" ? { data: "image" } : {}) as never;
    });
    const starting = start();
    await vi.waitFor(() =>
      expect(cdp.send.mock.calls.some(([, method]) => method === "Page.startScreencast")).toBe(
        true,
      ),
    );
    const [value] = await store.list();
    await store.put({ ...value, state: "ready", stop_reason: "duration_limit" });
    await video.finished(value.recording_id);
    release();
    await expect(starting).rejects.toThrow(/cancelled|stopped during capture startup/);
    expect(video.isRecording()).toBe(false);
    expect(
      cdp.send.mock.calls.filter(([, method]) => method === "Page.stopScreencast"),
    ).toHaveLength(1);
  });

  it("can stop a task while its first screenshot is not responding", async () => {
    const { start, cdp, video, request } = await setup();
    let entered!: () => void;
    const capturing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    cdp.send.mockImplementation(async (_tab, method) => {
      if (method === "Page.captureScreenshot") {
        entered();
        return new Promise<never>(() => {});
      }
      return {} as never;
    });
    const starting = start();
    const cancelled = expect(starting).rejects.toThrow("cancelled");
    await capturing;
    await video.stopSession("task");
    await cancelled;
    expect(video.isRecording()).toBe(false);
    expect(request.mock.calls.some(([command]) => command.action === "start")).toBe(false);
  });
});
