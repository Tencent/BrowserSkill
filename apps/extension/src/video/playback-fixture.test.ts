import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readVideoPixels, type VideoFrameTarget, videoFrameTargets } from "./playback-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const target: VideoFrameTarget = { time: 1.5, timestamp: 1, duration: 1 };

function player() {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    duration: { configurable: true, value: 3 },
    readyState: { configurable: true, value: 2 },
    videoWidth: { value: 320 },
    videoHeight: { value: 180 },
  });
  let present!: VideoFrameRequestCallback;
  let sequence = 0;
  video.requestVideoFrameCallback = vi.fn((callback) => {
    present = callback;
    return ++sequence;
  });
  video.cancelVideoFrameCallback = vi.fn();
  const removeListener = vi.spyOn(video, "removeEventListener");
  vi.spyOn(video, "pause").mockImplementation(() => {});
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 255, 255]) }),
  } as unknown as CanvasRenderingContext2D);
  return {
    video,
    drawImage,
    removeListener,
    seeked: () => video.dispatchEvent(new Event("seeked")),
    present: (mediaTime = target.timestamp) =>
      present(0, { mediaTime } as VideoFrameCallbackMetadata),
  };
}

describe("video pixel sampling", () => {
  it.each([
    "seeked",
    "present",
  ] as const)("waits for both signals when %s arrives first", async (first) => {
    const fixture = player();
    const pixels = readVideoPixels(fixture.video, [target]);
    fixture[first]();
    await Promise.resolve();
    expect(fixture.drawImage).not.toHaveBeenCalled();
    fixture[first === "seeked" ? "present" : "seeked"]();
    await expect(pixels).resolves.toEqual([[0, 0, 255, 255]]);
    expect(fixture.drawImage).toHaveBeenCalledTimes(1);
    expect(fixture.video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    expect(fixture.removeListener).toHaveBeenCalledWith("seeked", expect.any(Function));
    expect(fixture.removeListener).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("ignores a previous frame's callback and accepts the target's PTS, not the seek time", async () => {
    const fixture = player();
    const pixels = readVideoPixels(fixture.video, [target]);
    fixture.seeked();
    fixture.present(0);
    await Promise.resolve();
    expect(fixture.drawImage).not.toHaveBeenCalled();
    expect(fixture.video.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
    fixture.present(1); // The frame covers [1, 2), including the requested 1.5s.
    await expect(pixels).resolves.toEqual([[0, 0, 255, 255]]);
  });

  it("moves a same-position seek within the target frame and reuses verified duplicate frames", async () => {
    const fixture = player();
    fixture.video.currentTime = target.time;
    const pixels = readVideoPixels(fixture.video, [target, target, { ...target, time: 1.9 }]);
    expect(fixture.video.currentTime).not.toBe(target.time);
    expect(fixture.video.currentTime).toBeGreaterThanOrEqual(1);
    expect(fixture.video.currentTime).toBeLessThan(2);
    fixture.seeked();
    fixture.present();
    await expect(pixels).resolves.toHaveLength(3);
    expect(fixture.video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
  });

  it.each([
    "seeked",
    "present",
  ] as const)("fails without sampling when only %s arrives", async (signal) => {
    vi.useFakeTimers();
    const fixture = player();
    const pixels = readVideoPixels(fixture.video, [target]);
    const rejected = expect(pixels).rejects.toThrow("did not become ready");
    fixture[signal]();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(fixture.drawImage).not.toHaveBeenCalled();
    expect(fixture.video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    expect(fixture.removeListener).toHaveBeenCalledWith("seeked", expect.any(Function));
    expect(fixture.removeListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports media errors and cleans up without waiting for the timeout", async () => {
    vi.useFakeTimers();
    const fixture = player();
    Object.defineProperty(fixture.video, "error", { value: { message: "decode failed" } });
    const pixels = readVideoPixels(fixture.video, [target]);
    fixture.video.dispatchEvent(new Event("error"));
    await expect(pixels).rejects.toThrow("MP4 playback failed: decode failed");
    expect(fixture.drawImage).not.toHaveBeenCalled();
    expect(fixture.video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-1, 3, NaN, Infinity])("rejects invalid time %s before seeking", async (time) => {
    const fixture = player();
    await expect(readVideoPixels(fixture.video, [{ ...target, time }])).rejects.toThrow("outside");
    expect(fixture.video.requestVideoFrameCallback).not.toHaveBeenCalled();
  });

  it("rejects unavailable duration before seeking", async () => {
    const fixture = player();
    Object.defineProperty(fixture.video, "duration", { value: NaN });
    await expect(readVideoPixels(fixture.video, [target])).rejects.toThrow("metadata is not ready");
    expect(fixture.video.requestVideoFrameCallback).not.toHaveBeenCalled();
  });
});

it("resolves times within sparse MP4 frames and rejects times outside the recording", async () => {
  const destination = new BufferTarget();
  const output = new Output({ target: destination, format: new Mp4OutputFormat() });
  const source = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(source);
  await output.start();
  // Demuxing only: sample payloads are never sent to a decoder in this test.
  const config = {
    codec: "avc1.42001e",
    codedWidth: 320,
    codedHeight: 180,
    description: new Uint8Array([1, 66, 0, 30, 255, 225, 0, 4, 103, 66, 0, 30, 1, 0, 2, 104, 0]),
  };
  await source.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 101]), "key", 0, 1), {
    decoderConfig: config,
  });
  await source.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 101]), "key", 1, 2));
  source.close();
  await output.finalize();
  const file = new Uint8Array(destination.buffer!);
  await expect(videoFrameTargets(file, [0.2, 1.2, 2.8])).resolves.toEqual([
    { time: 0.2, timestamp: 0, duration: 1 },
    { time: 1.2, timestamp: 1, duration: 2 },
    { time: 2.8, timestamp: 1, duration: 2 },
  ]);
  await expect(videoFrameTargets(file, [-0.3])).rejects.toThrow("outside");
  await expect(videoFrameTargets(file, [3])).rejects.toThrow("outside");
});
