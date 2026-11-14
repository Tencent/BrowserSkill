import { afterEach, describe, expect, it, vi } from "vitest";
import { attachVideoBridge } from "./bridge";
import { captureReply } from "./capture-deadline";
import { completeFragmentLength } from "./encoder";
import type { VideoHost } from "./host-protocol";
import type { VideoManager } from "./manager";
import { VIDEO_OVERLAY } from "./overlay";
import { FrameClock, VideoTimeline, videoDimensions } from "./timeline";

vi.mock("./downloads", () => ({
  VideoDownloads: class {
    attach() {}
  },
}));

describe("video capture deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("bounds a stalled capture and consumes a late Chrome failure", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const chrome = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const result = captureReply(chrome, new AbortController().signal);
    const expired = expect(result).rejects.toThrow("within 10s");
    await vi.advanceTimersByTimeAsync(10_000);
    await expired;
    reject(new Error("late browser reply"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("video wall clock and recovery journal", () => {
  it("preserves static gaps, drops excess samples and ends exactly at the cap", () => {
    const clock = new VideoTimeline(15, 60_000);
    expect(clock.advance(100)).toMatchObject({ timestamp: 0, duration: 100_000 });
    expect(clock.advance(101)).toBeNull();
    expect(clock.advance(40_000)).toMatchObject({ timestamp: 100_000, duration: 39_900_000 });
    expect(clock.advance(70_000, true)).toMatchObject({
      timestamp: 40_000_000,
      duration: 20_000_000,
    });
    expect(clock.durationMs).toBe(60_000);
    expect(clock.advance(70_000, true)).toBeNull();
  });

  it("normalizes source timestamps and rejects wall-clock jumps", () => {
    const clock = new FrameClock();
    expect(clock.elapsed(1_700_000_000, 0)).toBe(0);
    expect(clock.elapsed(1_700_000_001, 1000)).toBe(1000);
    expect(clock.elapsed(1_700_010_000, 2000)).toBe(2000);
    expect(clock.elapsed(undefined, 1500)).toBe(2000);
    expect(videoDimensions(4001, 2001, 1280)).toEqual({ width: 1280, height: 640 });
  });

  it("salvages only complete initialized fragments and rejects truncated box sizes", async () => {
    const box = (type: string, size = 8) => {
      const bytes = new Uint8Array(size);
      new DataView(bytes.buffer).setUint32(0, size);
      bytes.set(
        [...type].map((letter) => letter.charCodeAt(0)),
        4,
      );
      return bytes;
    };
    const complete = [box("ftyp"), box("moov"), box("moof"), box("mdat", 32)];
    expect(await completeFragmentLength(new Blob(complete))).toBe(56);
    expect(
      await completeFragmentLength(
        new Blob([...complete, box("moof"), box("mdat", 64).slice(0, 9)]),
      ),
    ).toBe(56);
    expect(await completeFragmentLength(new Blob([box("moof"), box("mdat")]))).toBe(0);
    expect(await completeFragmentLength(new Blob([box("moov"), box("mdat")]))).toBe(0);
  });
});

describe("attachVideoBridge", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fixture(frame: object) {
    const addListener = vi.fn();
    const getFrame = vi.fn(async () => frame);
    vi.stubGlobal("chrome", {
      runtime: { id: "extension", onMessage: { addListener } },
      webNavigation: { getFrame },
    });
    const queryOverlay = vi.fn(async () => null);
    const suspend = vi.fn(async () => "video");
    attachVideoBridge(
      { queryOverlay, suspend } as unknown as VideoManager,
      {} as VideoHost,
      vi.fn(),
    );
    const receive = addListener.mock.calls[0][0];
    const request = (action = "query", sender = {}) =>
      new Promise((resolve) => {
        receive(
          { type: VIDEO_OVERLAY, action },
          {
            id: "extension",
            tab: { id: 7 },
            frameId: 8,
            documentId: "document",
            ...sender,
          },
          resolve,
        );
      });
    return { request, queryOverlay, suspend, getFrame };
  }

  it("resolves an activated outermost document by documentId, even with a nonzero sender frameId", async () => {
    const f = fixture({
      frameType: "outermost_frame",
      documentLifecycle: "active",
      documentId: "document",
    });
    await expect(f.request()).resolves.toEqual({ recording_id: null });
    expect(f.getFrame).toHaveBeenCalledWith({ tabId: 7, documentId: "document" });
    expect(f.queryOverlay).toHaveBeenCalledWith(7, "document");
    await expect(f.request("clean")).resolves.toEqual({ recording_id: "video" });
    expect(f.suspend).toHaveBeenCalledWith(7, "clean", "document");
  });

  it.each([
    { frameType: "outermost_frame", documentLifecycle: "prerender", documentId: "document" },
    { frameType: "outermost_frame", documentLifecycle: "cached", documentId: "document" },
    { frameType: "sub_frame", documentLifecycle: "active", documentId: "document" },
    { frameType: "outermost_frame", documentLifecycle: "active", documentId: "replaced" },
  ])("does not let an inactive, nested or replaced document affect capture: %j", async (frame) => {
    const f = fixture(frame);
    for (const action of ["query", "clean", "interactive"])
      await expect(f.request(action)).resolves.toEqual({ error: "Video overlay handshake failed" });
    expect(f.queryOverlay).not.toHaveBeenCalled();
    expect(f.suspend).not.toHaveBeenCalled();
  });
});
