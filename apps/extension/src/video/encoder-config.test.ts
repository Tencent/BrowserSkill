import { describe, expect, it } from "vitest";
import { videoEncoderConfig } from "./encoder-config";
import { VIDEO_PRESETS } from "./types";

describe("video encoder configuration", () => {
  it.each(
    Object.entries(VIDEO_PRESETS),
  )("keeps the %s preset's maximum square frame within level 5.0's frame-size limit", (_quality, preset) => {
    const macroblocks = Math.ceil(preset.maxDimension / 16) ** 2;
    expect(macroblocks).toBeLessThanOrEqual(22080);
  });

  it.each([
    [1920, 1080],
    [1920, 1128],
    [1920, 1152],
    [1152, 1920],
  ])("keeps level 4.2 for supported %ix%i frames", (width, height) => {
    expect(videoEncoderConfig(width, height, "clear")).toEqual({
      codec: "avc1.42002a",
      width,
      height,
      bitrate: 4_000_000,
      framerate: 30,
      latencyMode: "realtime",
      avc: { format: "avc" },
    });
  });

  it.each([
    [1920, 1154],
    [1154, 1920],
    [1920, 1200],
    [1920, 1440],
    [1920, 1920],
  ])("uses level 5.0 for %ix%i frames exceeding the padded area limit", (width, height) => {
    expect(videoEncoderConfig(width, height, "clear")).toMatchObject({
      codec: "avc1.420032",
      width,
      height,
    });
  });

  it("selects the level after scaling and even-dimension rounding", () => {
    expect(videoEncoderConfig(3840, 2160, "clear")).toMatchObject({
      codec: "avc1.42002a",
      width: 1920,
      height: 1080,
    });
    expect(videoEncoderConfig(1920, 1153, "clear")).toMatchObject({
      codec: "avc1.42002a",
      width: 1920,
      height: 1152,
    });
    expect(videoEncoderConfig(3840, 2400, "clear")).toMatchObject({
      codec: "avc1.420032",
      width: 1920,
      height: 1200,
    });
  });

  it("keeps the standard preset at level 4.2 even for square sources", () => {
    expect(videoEncoderConfig(3840, 3840, "standard")).toMatchObject({
      codec: "avc1.42002a",
      width: 1280,
      height: 1280,
      bitrate: 2_000_000,
      framerate: 15,
    });
  });
});
