import { describe, expect, it } from "vitest";
import { completeFragmentLength } from "./encoder";
import { FrameClock, VideoTimeline, videoDimensions } from "./timeline";

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
